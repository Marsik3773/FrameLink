const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addresses, readReply } = require('../src/discovery.cjs');

test('finds broadcast addresses with each local IPv4 subnet mask', () => {
  assert.deepEqual([...addresses({ Ethernet: [
    { address: '192.168.4.100', netmask: '255.255.254.0', family: 'IPv4' },
    { address: '::1', family: 'IPv6', internal: true }
  ] })], ['255.255.255.255', '192.168.5.255']);
});

test('matches replies to the current scan and uses their source IP', () => {
  const body = { type: 'phone', nonce: 'scan-id', name: ' Pixel ', port: 4750, host: 'spoof', busy: true };
  const encode = object => Buffer.from(JSON.stringify(object));
  assert.deepEqual(readReply(encode(body), '127.0.0.1', 'scan-id'), {
    name: 'Pixel', host: '127.0.0.1', port: 4750, busy: true
  });
  assert.equal(readReply(encode(body), '127.0.0.1', 'old'), null);
  assert.equal(readReply(encode({ ...body, port: 99 }), '127.0.0.1', 'scan-id'), null);
});
