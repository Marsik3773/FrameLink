const tls = require('node:tls');
const { isIP } = require('node:net');
const { createHash, timingSafeEqual } = require('node:crypto');

const HEADER_SIZE = 13;
const LIMIT = { 1: 3 * 1024 * 1024, 2: 3 * 1024 * 1024, 3: 32 * 1024, 4: 4096 };

class PacketReader {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.header = Buffer.alloc(HEADER_SIZE);
    this.headerOffset = 0;
    this.packet = null;
  }

  push(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.packet) {
        const count = Math.min(HEADER_SIZE - this.headerOffset, bytes.length - offset);
        bytes.copy(this.header, this.headerOffset, offset, offset + count);
        this.headerOffset += count;
        offset += count;
        if (this.headerOffset < HEADER_SIZE) continue;
        const type = this.header[0];
        const size = this.header.readUInt32BE(1);
        if (!LIMIT[type] || size === 0 || size > LIMIT[type] || (type === 4 && size % 2)) {
          throw new Error('Получен некорректный пакет FrameLink');
        }
        const timestamp = Number(this.header.readBigInt64BE(5));
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Некорректное время пакета');
        this.packet = { type, timestamp, bytes: Buffer.allocUnsafe(size), offset: 0 };
        this.headerOffset = 0;
      }
      const packet = this.packet;
      const count = Math.min(packet.bytes.length - packet.offset, bytes.length - offset);
      bytes.copy(packet.bytes, packet.offset, offset, offset + count);
      packet.offset += count;
      offset += count;
      if (packet.offset === packet.bytes.length) {
        this.packet = null;
        this.onPacket(packet.type, packet.timestamp, packet.bytes);
      }
    }
  }
}

function parseConnection(host, port, code) {
  const normalized = (typeof code === 'string' ? code : '').toLowerCase().replace(/[\s-]/g, '');
  if (!/^[0-9a-f]{28}$/.test(normalized)) throw new Error('Введите код с экрана FrameLink на телефоне');
  const address = typeof host === 'string' ? host.trim().replace(/^\[|\]$/g, '') : '';
  if (!isIP(address)) throw new Error('Введите IP-адрес телефона');
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error('Укажите порт от 1024 до 65535');
  return { host: address, port: number, fingerprint: normalized.slice(0, 16), secret: normalized.slice(16) };
}

class Link {
  constructor(connection, onEvent) {
    this.onEvent = onEvent;
    this.ready = false;
    this.pendingVideo = 0;
    this.awaitKey = true;
    this.stopped = false;
    this.reader = new PacketReader((...args) => this.packet(...args));
    this.socket = tls.connect({
      host: connection.host,
      port: connection.port,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false
    });
    this.socket.setNoDelay(true);
    this.connectTimer = setTimeout(() => this.fail('Телефон не ответил. Проверьте IP, порт и сеть.'), 8000);
    this.socket.once('secureConnect', () => {
      const certificate = this.socket.getPeerCertificate()?.raw;
      const expected = Buffer.from(connection.fingerprint, 'hex');
      const actual = certificate && createHash('sha256').update(certificate).digest().subarray(0, 8);
      if (!actual || !timingSafeEqual(actual, expected)) {
        this.fail('Код принадлежит другому телефону. Сверьте адрес и код.');
        return;
      }
      this.send({ type: 'hello', version: 1, secret: connection.secret });
    });
    this.socket.on('data', bytes => {
      if (this.stopped) return;
      this.lastData = Date.now();
      try { this.reader.push(bytes); } catch (error) { this.fail(error.message); }
    });
    this.socket.on('error', error => {
      this.fail(error.code === 'ECONNREFUSED'
        ? 'Телефон отклонил подключение. Запустите подключение в Android-приложении.'
        : 'Соединение разорвано: ' + (error.code || error.message));
    });
    this.socket.once('close', () => this.fail('Телефон отключился'));
  }

  packet(type, timestamp, bytes) {
    if (this.stopped) return;
    if (type === 3) {
      const event = JSON.parse(bytes.toString('utf8'));
      if (!event || typeof event.type !== 'string') throw new Error('Телефон прислал неизвестное сообщение');
      if (!this.ready) {
        if (event.type === 'busy') return this.fail('Телефон уже подключён к другому компьютеру');
        if (event.type === 'denied') return this.fail('Код подключения устарел или введён неверно');
        if (event.type !== 'ready') throw new Error('Ответ телефона не соответствует протоколу FrameLink');
        clearTimeout(this.connectTimer);
        this.ready = true;
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastData > 11000) return this.fail('Связь с телефоном потеряна');
          this.send({ type: 'ping' });
        }, 3000);
      }
      if (event.type === 'video') this.awaitKey = true;
      if (event.type !== 'pong') this.onEvent(event);
      return;
    }
    if (!this.ready) return;
    if (type === 4) {
      this.onEvent({ type: 'pcm', bytes, timestamp });
      return;
    }
    if (this.pendingVideo >= 10) {
      if (!this.awaitKey) this.send({ type: 'keyframe' });
      this.awaitKey = true;
      return;
    }
    const key = type === 2;
    if (this.awaitKey && !key) return;
    this.awaitKey = false;
    this.pendingVideo++;
    this.onEvent({ type: 'frame', key, timestamp, bytes });
  }

  acknowledge() {
    this.pendingVideo = Math.max(0, this.pendingVideo - 1);
  }

  send(value) {
    if (!this.stopped && this.socket.writable && this.socket.writableLength < 32768) {
      this.socket.write(JSON.stringify(value) + '\n');
    }
  }

  fail(message) {
    if (this.stopped) return;
    this.close();
    this.onEvent({ type: 'disconnected', message });
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeat);
    this.socket.destroy();
  }
}

module.exports = { Link, PacketReader, parseConnection };
