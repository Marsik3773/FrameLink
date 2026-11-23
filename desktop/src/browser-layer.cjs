const { BrowserWindow, session } = require('electron');

function webAddress(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

class BrowserLayers {
  constructor(publish) {
    this.items = new Map();
    this.publish = publish;
  }

  init() {
    this.session = session.fromPartition('framelink-browser-overlays');
    this.session.setPermissionRequestHandler((_contents, _name, complete) => complete(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.on('will-download', event => event.preventDefault());
    this.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: !['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:'].includes(url.protocol) });
    });
  }

  async open(id, address, width, height) {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/.test(id)) throw new Error('Некорректный слой');
    const url = webAddress(address);
    if (!url) throw new Error('Введите URL, начинающийся с https:// или http://');
    if (!Number.isInteger(width) || width < 100 || width > 1280 ||
        !Number.isInteger(height) || height < 100 || height > 720) throw new Error('Некорректный размер страницы');
    this.close(id);
    const window = new BrowserWindow({
      width, height, useContentSize: true, show: false, frame: false, transparent: true,
      webPreferences: {
        session: this.session, offscreen: true, sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
      }
    });
    const item = { window, pending: false, paintedAt: 0 };
    this.items.set(id, item);
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setFrameRate(15);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const validate = (event, destination) => { if (!webAddress(destination)) event.preventDefault(); };
    contents.on('will-navigate', validate);
    contents.on('will-redirect', validate);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('paint', (_event, _dirty, image) => {
      const now = performance.now();
      if (item.pending || now - item.paintedAt < 60 || this.items.get(id) !== item) return;
      const size = image.getSize();
      if (!size.width || !size.height || size.width > 2560 || size.height > 1440) return;
      item.pending = true;
      item.paintedAt = now;
      this.publish({ type: 'browserFrame', id, ...size, pixels: image.toBitmap() });
    });
    contents.on('render-process-gone', () => {
      if (this.items.get(id) !== item) return;
      this.close(id);
      this.publish({ type: 'browserError', id, message: 'Страница завершила работу' });
    });
    try {
      await window.loadURL(url);
    } catch (error) {
      if (this.items.get(id) !== item) return;
      this.close(id);
      throw new Error('Страница недоступна');
    }
  }

  acknowledge(id) {
    const item = this.items.get(id);
    if (item) item.pending = false;
  }

  visibility(id, visible) {
    const contents = this.items.get(id)?.window.webContents;
    if (contents) {
      if (visible) { contents.startPainting(); contents.invalidate(); }
      else contents.stopPainting();
    }
  }

  close(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    if (!item.window.isDestroyed()) item.window.destroy();
  }

  clear() {
    for (const id of this.items.keys()) this.close(id);
  }
}

module.exports = { BrowserLayers, webAddress };
