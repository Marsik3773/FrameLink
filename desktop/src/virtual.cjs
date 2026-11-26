const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { join } = require('node:path');
const { app } = require('electron');

const run = promisify(execFile);
const VALID_SIZES = new Set(['640x360', '960x540', '1280x720', '1920x1080']);
const helper = () => join(app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'native'), 'framelink-virtualcam.exe');

class VirtualCamera {
  constructor(notify) {
    this.notify = notify;
    this.current = null;
  }

  start(width, height, fps) {
    if (process.platform !== 'win32') throw new Error('Виртуальная камера доступна в Windows');
    if (this.current) throw new Error('Виртуальная камера уже активна');
    if (!VALID_SIZES.has(width + 'x' + height) || ![24, 30, 60].includes(fps)) throw new Error('Недопустимый формат камеры');
    return new Promise((resolve, reject) => {
      const processHandle = spawn(helper(), [String(width), String(height), String(fps)], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
      const current = { processHandle, size: width * height * 1.5, started: false };
      this.current = current;
      let diagnostic = '';
      let stdout = '';
      let settled = false;
      const fail = error => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(new Error('Время запуска виртуальной камеры истекло'));
        processHandle.kill();
      }, 4000);
      processHandle.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-1024); });
      processHandle.stdin.on('error', () => {});
      processHandle.stdout.on('data', data => {
        if (settled) return;
        stdout += data.toString('utf8');
        if (!/(?:^|\n)READY\r?\n/.test(stdout)) return;
        clearTimeout(timeout);
        settled = true;
        current.started = true;
        resolve(true);
      });
      processHandle.once('error', error => fail(error));
      processHandle.once('close', code => {
        if (this.current === current) this.current = null;
        const message = diagnostic.includes('BUSY') ?
          'FrameLink Camera занята' :
          diagnostic.includes('MISSING') ? 'FrameLink Camera не зарегистрирована. Переустановите FrameLink.' :
          'Виртуальная камера остановлена' + (code ? ' (код ' + code + ')' : '');
        if (current.started) this.notify({ type: 'virtualStopped', message: current.stopping ? '' : message });
        fail(new Error(message));
      });
    });
  }

  async stop() {
    const current = this.current;
    if (!current) return;
    current.stopping = true;
    current.processHandle.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => current.processHandle.kill(), 1500);
      current.processHandle.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  frame(array) {
    const current = this.current;
    if (!current?.started || current.stopping || !(array instanceof ArrayBuffer) || array.byteLength !== current.size) return false;
    const input = current.processHandle.stdin;
    if (input.destroyed || !input.writable || input.writableNeedDrain) return false;
    return new Promise(resolve => {
      input.write(Buffer.from(array), error => resolve(!error));
    });
  }

  async status() {
    if (process.platform !== 'win32') return false;
    try {
      await run(helper(), ['--probe'], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { VirtualCamera };
