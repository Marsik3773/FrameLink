// End-to-end on Windows, with the installed camera and a real browser permission grant.
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

const page = `<video autoplay muted playsinline></video><script>
(async () => {
  console.log('Checking webcam permission');
  const initial = await navigator.mediaDevices.getUserMedia({video:true});
  initial.getTracks().forEach(t => t.stop());
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const cameras = devices.filter(d => d.label.includes('FrameLink Camera'));
  if (!cameras.length) throw Error('FrameLink missing: ' + devices.map(d => d.label));
  const readings = [];
  for (const device of cameras) {
    const stream = await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:device.deviceId}}});
    try {
      const video = document.querySelector('video');
      video.srcObject = stream;
      await video.play();
      const ctx = document.createElement('canvas').getContext('2d', {willReadFrequently:true});
      for (let i = 0; i < 80; i++) {
        ctx.drawImage(video,0,0,1,1);
        const pixel = ctx.getImageData(0,0,1,1).data[0];
        if (pixel > 150 && pixel < 235) { readings.push([device.label,pixel]); break; }
        await new Promise(r => setTimeout(r,100));
      }
    } finally { stream.getTracks().forEach(t => t.stop()); }
  }
  if (readings.length !== cameras.length) throw Error('Missing live pixels for ' + cameras.map(d=>d.label) + ': ' + JSON.stringify(readings));
  return readings;
})().then(result => fetch('/result',{method:'POST',body:JSON.stringify({result})}),
  error => fetch('/result',{method:'POST',body:JSON.stringify({error:String(error)})}));</script>`;

async function run() {
  let producer, browser, feed, watchdog;
  const server = createServer();
  try {
    const result = new Promise((resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('Browser capture timed out')), 65000);
      server.on('request', (req, res) => {
        if (req.url !== '/result') { res.setHeader('Content-Type','text/html'); res.end(page); return; }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => { res.end(); resolve(JSON.parse(body)); });
      });
    });
    server.listen(0,'127.0.0.1');
    await once(server, 'listening');
    const size = 640 * 360;
    const frame = Buffer.alloc(size * 3 / 2, 128);
    frame.fill(190, 0, size);
    producer = spawn(join(process.env.ProgramFiles, 'FrameLink/resources/framelink-virtualcam.exe'), ['640','360','30']);
    const [ready] = await once(producer.stdout,'data');
    assert.match(ready.toString(), /READY/);
    producer.stdin.on('error', () => {});
    feed = setInterval(() => { if (!producer.stdin.writableNeedDrain) producer.stdin.write(frame); }, 33);
    const exe = [process.env['ProgramFiles(x86)'],process.env.ProgramFiles]
      .map(dir => join(dir,'Microsoft/Edge/Application/msedge.exe')).find(existsSync);
    browser = spawn(exe, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream','--user-data-dir=' + join(tmpdir(),'fl-browser-' + process.pid),
      'http://127.0.0.1:' + server.address().port], { stdio:'ignore' });
    const report = await result;
    assert.ok(!report.error, report.error);
    console.log('Browser captured real camera frames', report.result);
  } finally {
    clearTimeout(watchdog); clearInterval(feed); producer?.kill(); browser?.kill(); server.closeAllConnections(); server.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
