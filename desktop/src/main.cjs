const { app, BrowserWindow, ipcMain, protocol, net, session, shell, Tray, Menu, MessageChannelMain } = require('electron');
const { join, resolve, extname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Link, parseConnection } = require('./link.cjs');
const { VirtualCamera } = require('./virtual.cjs');
const { discover } = require('./discovery.cjs');
const { BrowserLayers } = require('./browser-layer.cjs');

const run = promisify(execFile);
const origin = 'app://framelink';
const root = resolve(__dirname, '..');
const urls = {
  privacy: 'ms-settings:privacy-webcam',
  adb: 'https://developer.android.com/tools/releases/platform-tools'
};

protocol.registerSchemesAsPrivileged([{
  scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
}]);

function resource(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'framelink') return null;
  const path = decodeURIComponent(parsed.pathname);
  if (!/^\/(?:src|assets|node_modules\/@mediapipe\/tasks-vision)\/[a-zA-Z0-9_./-]+$/.test(path)
      || path.split('/').includes('..')) return null;
  return join(root, path);
}

let window;
let tray;
let search;
let streamPort;
let link;
let generation = 0;
let retryTimer;
let forwardPort;
let closing = false;
const virtual = new VirtualCamera(publish);
const browsers = new BrowserLayers(publish);

function publish(event) {
  streamPort?.postMessage(event);
}

function closeLink() {
  generation++;
  clearTimeout(retryTimer);
  link?.close();
  link = null;
}

async function releaseForward() {
  if (!forwardPort) return;
  const port = forwardPort;
  forwardPort = null;
  try { await adb(['forward', '--remove', 'tcp:' + port]); } catch {}
}

function adb(args) {
  const { ANDROID_HOME, ANDROID_SDK_ROOT, LOCALAPPDATA } = process.env;
  const defaultSdk = LOCALAPPDATA && join(LOCALAPPDATA, 'Android', 'Sdk');
  const name = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const installations = [ANDROID_HOME, ANDROID_SDK_ROOT, defaultSdk].filter(Boolean);
  const command = installations.map(sdk => join(sdk, 'platform-tools', name)).find(existsSync) || name;
  return run(command, args, { windowsHide: true, timeout: 5500, maxBuffer: 32 * 1024 });
}

async function connect({ host, port, transport }) {
  closeLink();
  const attempt = generation;
  await releaseForward();
  if (attempt !== generation) return false;
  const usb = transport === 'usb';
  const requested = parseConnection(usb ? '127.0.0.1' : host, port);
  if (usb) {
    try {
      const { stdout } = await adb(['forward', 'tcp:0', 'tcp:' + requested.port]);
      const forwarded = Number(stdout.trim());
      if (!Number.isInteger(forwarded) || forwarded < 1 || forwarded > 65535) {
        throw new Error('ADB не вернул локальный порт');
      }
      if (attempt !== generation) {
        await adb(['forward', '--remove', 'tcp:' + forwarded]).catch(() => {});
        return false;
      }
      forwardPort = forwarded;
      requested.port = forwarded;
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('ADB не найден. Добавьте Android Platform Tools в PATH или включите USB-модем и подключитесь по IP.');
      throw new Error('ADB не видит один разрешённый телефон. Проверьте USB-отладку, кабель и подтверждение на телефоне.');
    }
  }
  let fingerprint;
  let retries = 0;
  const start = () => {
    if (attempt !== generation) return;
    const next = new Link({ ...requested, fingerprint }, event => {
      if (attempt !== generation) return;
      if (event.type === 'ready') {
        fingerprint = next.fingerprint;
        retries = 0;
      }
      if (event.type === 'disconnected') {
        link = null;
        if (!usb && fingerprint && !event.final && retries < 4) {
          publish({ type: 'retrying' });
          retryTimer = setTimeout(start, 1000 * 2 ** retries++);
          return;
        }
        releaseForward();
      }
      publish(event);
    });
    link = next;
  };
  start();
  return true;
}

function registerHandlers() {
  function handler(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('FrameLink IPC origin mismatch');
      }
      try { return { value: await fn(...args) }; }
      catch (error) { return { error: error.message }; }
    });
  }
  handler('link:connect', connect);
  handler('link:discover', () => {
    if (!search) search = discover().finally(() => { search = null; });
    return search;
  });
  handler('browser:open', (...args) => browsers.open(...args));
  handler('browser:close', id => browsers.close(id));
  handler('browser:visibility', (id, visible) => browsers.visibility(id, visible));
  handler('link:disconnect', async () => { closeLink(); await releaseForward(); });
  handler('link:settings', values => {
    if (!values || typeof values !== 'object') return;
    const allowed = ['front', 'height', 'fps', 'zoom', 'ev', 'wb', 'manualExposure', 'shutter', 'iso', 'manualFocus', 'focus'];
    const settings = Object.fromEntries(allowed.filter(key =>
      typeof values[key] === 'boolean' || Number.isSafeInteger(values[key])
    ).map(key => [key, values[key]]));
    link?.send({ type: 'settings', ...settings });
  });
  handler('link:keyframe', () => link?.send({ type: 'keyframe' }));
  const updates = require('./updates.cjs');
  handler('updates:check', updates.check);
  handler('updates:login', () => updates.signIn(window));
  handler('updates:install', updates.install);
  handler('virtual:repair', async () => {
    if (process.platform !== 'win32' || !app.isPackaged) throw new Error('Требуется установленная версия Windows');
    // The administrator runs only the repair script in the fixed machine installation.
    const command = `$p = Start-Process "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $env:ProgramFiles + '\\FrameLink\\resources\\repair-camera.ps1"') -Wait -PassThru; exit $p.ExitCode`;
    await run(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 120000 });
  });
  handler('virtual:modern', async () => {
    if (process.platform !== 'win32' || !app.isPackaged) return false;
    return run(join(process.resourcesPath, 'framelink-camera-register.exe'), ['--probe'],
      { windowsHide: true, timeout: 5000 }).then(() => true, () => false);
  });
  handler('virtual:status', () => virtual.status());
  handler('virtual:start', (width, height, fps) => virtual.start(width, height, fps));
  handler('virtual:stop', () => virtual.stop());
  handler('virtual:frame', data => virtual.frame(data));
  handler('help:open', name => {
    const url = Object.hasOwn(urls, name) ? urls[name] : null;
    if (url) return shell.openExternal(url);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(createWindow);
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow() {
  browsers.init();
  protocol.handle('app', async request => {
    const filename = resource(request.url);
    if (!filename) return new Response('Not found', { status: 404 });
    if (extname(filename) === '.cjs' && filename.endsWith('vision_bundle.cjs')) {
      // This upstream CommonJS bundle exposes its worker API through exports.
      const source = await readFile(filename, 'utf8');
      return new Response('var exports = {};\n' + source + '\nself.FrameLinkVision = exports;', {
        headers: { 'Content-Type': 'text/javascript' }
      });
    }
    return net.fetch(pathToFileURL(filename).href);
  });
  session.defaultSession.setPermissionCheckHandler((_contents, name, url) => {
    return (url === origin || url === origin + '/') && name === 'speaker-selection';
  });
  session.defaultSession.setPermissionRequestHandler((_contents, name, callback, details) => {
    callback(details.requestingUrl?.startsWith(origin + '/') && name === 'speaker-selection');
  });
  window = new BrowserWindow({
    width: 1260, height: 820, minWidth: 900, minHeight: 655,
    title: 'FrameLink', autoHideMenuBar: true, icon: join(root, 'assets', 'icon.png'), backgroundColor: '#101315',
    show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, backgroundThrottling: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  registerHandlers();
  window.webContents.on('did-finish-load', () => {
    streamPort?.close();
    const port = new MessageChannelMain();
    streamPort = port.port1;
    streamPort.on('message', event => {
      if (event.data === 'frame-ack') link?.acknowledge();
      if (event.data?.browserAck) browsers.acknowledge(event.data.browserAck);
    });
    streamPort.start();
    window.webContents.postMessage('link:stream', null, [port.port2]);
  });
  window.once('ready-to-show', () => window.show());
  tray = new Tray(join(root, 'assets', 'icon.png'));
  tray.setToolTip('FrameLink');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: showWindow },
    { label: 'Выйти', click: () => app.quit() }
  ]));
  tray.on('double-click', showWindow);
  window.on('close', event => {
    if (closing) return;
    event.preventDefault();
    window.hide();
  });
  window.loadURL(origin + '/src/index.html');
}

app.on('before-quit', event => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  closeLink();
  browsers.clear();
  tray?.destroy();
  Promise.allSettled([virtual.stop(), releaseForward()]).then(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
