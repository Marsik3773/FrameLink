const { once } = require('node:events');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const size = 640 * 360;
const sample = Buffer.alloc(size * 3 / 2, 128);
sample.fill(190, 0, size);
const helper = join(process.env.ProgramFiles, 'FrameLink', 'resources', 'framelink-virtualcam.exe');
const producer = spawn(helper, ['640', '360', '30'], { stdio: ['pipe','pipe','inherit'], windowsHide: true });
producer.stdin.on('error', () => {});
let capture;
let feeding;
const timer = setTimeout(() => {
  producer.kill();
  capture?.kill();
  console.error('DirectShow test timed out');
  process.exitCode = 1;
}, 35000);

(async () => {
  const [ready] = await once(producer.stdout, 'data');
  assert.match(ready.toString(), /READY/);
  const feed = () => { if (!producer.stdin.writableNeedDrain) producer.stdin.write(sample); };
  feed();
  feeding = setInterval(feed, 35);
  capture = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-video_size', '640x360',
    '-framerate', '30', '-pixel_format', 'nv12', '-i', 'video=FrameLink Camera (DirectShow)',
    '-frames:v', '1', '-pix_fmt', 'nv12', '-threads', '1', '-f', 'rawvideo', 'pipe:1'
  ], { stdio: ['ignore','pipe','inherit'], windowsHide: true });
  const data = [];
  capture.stdout.on('data', buffer => data.push(buffer));
  const [status] = await once(capture, 'close');
  assert.equal(status, 0);
  assert.deepEqual(Buffer.concat(data), sample);
  console.log('FrameLink Camera delivered the expected NV12 pixels to DirectShow.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  clearInterval(feeding);
  clearTimeout(timer);
  producer.stdin.end();
});
