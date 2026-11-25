const { app, BrowserWindow, session, shell } = require('electron');
const { mkdtemp, rm } = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { join } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createHash } = require('node:crypto');

const repo = 'https://github.com/Marsik3773/FrameLink';
const installer = 'FrameLink-Windows-x64-Setup.exe';
const account = () => session.fromPartition('persist:framelink-updates');
const get = (path, timeout = 15000) => account().fetch(repo + path, {
  credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(timeout)
});
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
function newer(candidate, current) {
  if (![candidate, current].every(v => versionPattern.test(v))) return false;
  const base = current.split('.').map(Number);
  const delta = candidate.split('.').map((n, i) => Number(n) - base[i]).find(n => n !== 0);
  return delta > 0;
}
let available;
let downloading = false;
let login;
async function check() {
  if (process.platform !== 'win32') return { state: 'unsupported' };
  const response = await get('/releases/latest');
  await response.body?.cancel();
  if ([401, 403, 404].includes(response.status) || new URL(response.url).pathname.startsWith('/login')) return { state: 'account' };
  if (!response.ok) throw new Error('Не удалось проверить GitHub');
  const version = response.url.startsWith(repo + '/releases/tag/v') ? response.url.slice((repo + '/releases/tag/v').length) : '';
  if (!versionPattern.test(version)) throw new Error('Не удалось прочитать версию релиза');
  available = newer(version, app.getVersion()) ? version : null;
  return available ? { state: 'new', version } : { state: 'current' };
}
function signIn(parent) {
  if (login) { login.focus(); return; }
  login = new BrowserWindow({ width: 840, height: 720, parent, title: 'GitHub', autoHideMenuBar: true,
    webPreferences: { session: account(), sandbox: true, nodeIntegration: false, contextIsolation: true } });
  account().setPermissionRequestHandler((_web, _permission, cb) => cb(false));
  login.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  login.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== 'https://github.com') event.preventDefault();
  });
  return new Promise(resolve => {
    login.once('closed', () => { login = null; resolve(); });
    login.webContents.on('did-navigate', (_event, url) => {
      if (url.startsWith(repo + '/releases/tag/')) login?.close();
    });
    login.loadURL('https://github.com/login?return_to=' + encodeURIComponent(repo + '/releases/latest')).catch(() => login?.close());
  });
}

async function install(version) {
  if (!versionPattern.test(version) || version !== available || downloading) throw new Error('Сначала проверьте обновления');
  downloading = true;
  let directory;
  try {
    const path = '/releases/download/v' + version + '/' + installer;
    const checksum = await get(path + '.sha256');
    if (!checksum.ok) throw new Error('Контрольная сумма недоступна');
    const expected = (await checksum.text()).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Некорректная контрольная сумма');
    const response = await get(path, 300000);
    if (!response.ok || !response.body) throw new Error('Не удалось скачать установщик');
    directory = await mkdtemp(join(app.getPath('temp'), 'FrameLink-'));
    const file = join(directory, installer);
    const digest = createHash('sha256');
    await pipeline(response.body, new Transform({
      transform(chunk, _encoding, done) { digest.update(chunk); done(null, chunk); }
    }), createWriteStream(file, { flags: 'wx' }));
    if (digest.digest('hex') !== expected.toLowerCase()) throw new Error('Контрольная сумма установщика не совпадает');
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    app.quit();
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally { downloading = false; }
}
module.exports = { check, signIn, install, newer };
