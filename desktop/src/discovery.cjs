const { createSocket } = require('node:dgram');
const { randomBytes } = require('node:crypto');
const { networkInterfaces } = require('node:os');
const { isIPv4 } = require('node:net');

const PORT = 47470;

function addresses(interfaces = networkInterfaces()) {
  const broadcasts = new Set(['255.255.255.255']);
  for (const entries of Object.values(interfaces)) {
    for (const { address, family, netmask, internal } of entries) {
      if (family !== 'IPv4' || internal || !isIPv4(address) || !isIPv4(netmask)) continue;
      const ip = address.split('.').map(Number);
      const mask = netmask.split('.').map(Number);
      broadcasts.add(ip.map((part, i) => part | (255 ^ mask[i])).join('.'));
    }
  }
  return broadcasts;
}

function readReply(bytes, host, nonce) {
  if (bytes.length > 1024 || !isIPv4(host)) return null;
  try {
    const reply = JSON.parse(bytes.toString());
    if (reply.type !== 'phone' || reply.nonce !== nonce || typeof reply.name !== 'string'
        || !Number.isInteger(reply.port) || reply.port < 1024 || reply.port > 65535) return null;
    const name = reply.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Android';
    return { name, host, port: reply.port, busy: reply.busy === true };
  } catch {
    return null;
  }
}

function discover() {
  return new Promise(resolve => {
    const nonce = randomBytes(12).toString('hex');
    const query = Buffer.from('FrameLink/2 ' + nonce, 'ascii');
    const found = new Map();
    const socket = createSocket('udp4');
    let repeat;
    let closed = false;
    function done() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      clearTimeout(repeat);
      try { socket.close(); } catch {}
      resolve(Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name)));
    }
    const timeout = setTimeout(done, 1250);
    socket.on('error', done);
    socket.on('message', (bytes, { address }) => {
      const phone = readReply(bytes, address, nonce);
      if (phone && found.size < 64) found.set(phone.host + ':' + phone.port, phone);
    });
    socket.bind(0, () => {
      if (closed) return;
      socket.setBroadcast(true);
      const broadcast = () => {
        for (const destination of addresses()) socket.send(query, PORT, destination, () => {});
      };
      broadcast();
      repeat = setTimeout(broadcast, 470);
    });
  });
}

module.exports = { discover, readReply, addresses };
