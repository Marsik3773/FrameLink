const { createHash } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const url = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';
const expected = '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b';
const directory = join(__dirname, '..', 'assets');
const target = join(directory, 'selfie_segmenter.tflite');
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

async function main() {
  try { if (sha256(await readFile(target)) === expected) return; } catch {}
  const response = await fetch(url);
  if (!response.ok) throw new Error('Model HTTP ' + response.status);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256(data) !== expected) throw new Error('MediaPipe model checksum mismatch');
  await mkdir(directory, { recursive: true });
  await writeFile(target, data);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
