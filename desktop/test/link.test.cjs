const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PacketReader, parseConnection } = require('../src/link.cjs');

function packet(type, timestamp, bytes) {
  const header = Buffer.alloc(13);
  header[0] = type;
  header.writeUInt32BE(bytes.length, 1);
  header.writeBigInt64BE(BigInt(timestamp), 5);
  return Buffer.concat([header, bytes]);
}

test('receives consecutive video and audio packets across arbitrary socket reads', () => {
  const expected = [
    [2, 6000, Buffer.from([0, 0, 0, 1, 0x65, 0xf2])],
    [4, 8000, Buffer.from([0x42, 0xf3])]
  ];
  const wire = Buffer.concat(expected.map(args => packet(...args)));
  for (let step = 1; step <= wire.length; step++) {
    const actual = [];
    const reader = new PacketReader((...args) => actual.push(args));
    for (let offset = 0; offset < wire.length; offset += step) reader.push(wire.subarray(offset, offset + step));
    assert.deepEqual(actual, expected);
  }
});

test('rejects invalid sizes, timestamp and packet types before delivering a packet', () => {
  const reader = () => new PacketReader(() => assert.fail('Invalid packet delivered'));
  const oversized = packet(4, 0, Buffer.alloc(4098));
  assert.throws(() => reader().push(oversized.subarray(0, 13)), /некорректный пакет/);
  assert.throws(() => reader().push(packet(4, 0, Buffer.from([1]))), /некорректный пакет/);
  assert.throws(() => reader().push(packet(9, 0, Buffer.from([1]))), /некорректный пакет/);
  assert.throws(() => reader().push(packet(2, -4, Buffer.from([1]))), /время/);
});

test('parses the displayed code and validates connection parameters', () => {
  const code = '01234567-89ABCDEF-112233-445566';
  assert.deepEqual(parseConnection('[::1]', '4747', code), {
    host: '::1', port: 4747, fingerprint: '0123456789abcdef', secret: '112233445566'
  });
  assert.throws(() => parseConnection('localhost', 4747, code), /IP/);
  assert.throws(() => parseConnection('127.0.0.1', 0, code), /порт/);
  assert.throws(() => parseConnection('127.0.0.1', 4747, '11223344'), /код/);
});
