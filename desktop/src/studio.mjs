import { Compositor } from './compositor.mjs';
import { Background } from './background.mjs';
import { Monitor } from './audio.mjs';
import { LayerStack } from './layers.mjs';

const el = id => document.getElementById(id);
const api = window.frameLink;
const show = (id, visible) => { el(id).hidden = !visible; };
const text = (id, value) => { el(id).textContent = value; };
const value = id => Number(el(id).value);
const errorText = (id, error) => { text(id, error || ''); show(id, Boolean(error)); };
const cameraKeys = ['zoom', 'ev', 'shutter', 'iso', 'focus'];
const whiteBalances = ['', 'Авто', 'Лампа накаливания', 'Люминесцентный', 'Тёплый люминесцентный',
  'Дневной свет', 'Облачность', 'Сумерки', 'Тень'];
const visualDefaults = { effect: 0, keyColor: '#00b140', tolerance: 16, maskThreshold: 50,
  blur: 31, brightness: 0, contrast: 100, saturation: 100 };
const canvas = el('canvas');
let compositor;
try {
  compositor = new Compositor(canvas);
} catch (error) {
  text('emptyHint', error.message);
  show('emptyHint', true);
}
let connection = 'idle';
let decoder;
let config;
let receivedFrame = false;
let preferHardware = true;
let waitingForKey = true;
let lastVideoTime = 0;
let worker;
let workerBusy = false;
let maskEpoch = 0;
let lastMask = 0;
let maskStatus = '';
let renderScheduled = false;
let sceneVersion = 0;
let virtual;
let outputChange = Promise.resolve();
let scanPending = false;
let devices = [];
let cameraState;
let queuedSettings = {};
let settingsTimer;
let audioChange = 0;
let captureFps = 0;
let frameCounter = 0;

const background = new Background((image, width, height) => {
  compositor?.loadBackground(image, width, height);
  redraw();
}, message => {
  if (compositor) compositor.backgroundRatio = 0;
  text('backgroundName', message);
  redraw();
});

const monitor = new Monitor(peak => { el('audioLevel').value = peak; });
const layers = new LayerStack(compositor, api, redraw);

function setConnection(state, message = '') {
  connection = state;
  el('connectionStatus').dataset.state = state;
  text('statusText', { idle: 'Не подключено', connecting: 'Подключение…', live: 'Телефон подключён' }[state]);
  text('connectButton', { idle: 'Подключить', connecting: 'Отменить', live: 'Отключить' }[state]);
  for (const input of el('connection').querySelectorAll('input')) input.disabled = state !== 'idle';
  el('cameraFields').disabled = state !== 'live';
  renderDevices();
  errorText('connectionError', message);
  if (state === 'idle') {
    clearTimeout(settingsTimer);
    settingsTimer = null;
    queuedSettings = {};
    cameraState = null;
    endVideo();
    setAudioState(false);
    show('cameraHint', true);
    show('cameraFields', false);
    scanDevices();
  }
}

function setTransport() {
  const usb = el('connection').elements.transport.value === 'usb';
  show('hostField', !usb);
  if (usb) el('manualAddress').open = true;
  el('manualAddress').querySelector('summary').textContent = usb ? 'Порт USB' : 'По IP-адресу';
  renderDevices();
  if (!usb) scanDevices();
  el('host').required = !usb;
}

el('connection').addEventListener('change', setTransport);
try {
  const remembered = JSON.parse(localStorage.getItem('framelink-address') || '{}');
  el('host').value = typeof remembered.host === 'string' ? remembered.host : '';
  if (Number.isInteger(remembered.port)) el('port').value = remembered.port;
  if (remembered.transport === 'usb') el('connection').elements.transport.value = 'usb';
} catch {}
setTransport();
el('connection').addEventListener('submit', async event => {
  event.preventDefault();
  if (connection !== 'idle') {
    setConnection('idle');
    await api.disconnect();
    return;
  }
  const transport = el('connection').elements.transport.value;
  const address = el('host').value.trim();
  const embedded = transport === 'ip' && address.match(/^(\d+(?:\.\d+){3}|\[[0-9a-f:]+\]):(\d{1,5})$/i);
  const endpoint = { host: embedded ? embedded[1] : address, port: embedded ? Number(embedded[2]) : value('port'), transport };
  if (embedded) {
    el('host').value = endpoint.host;
    el('port').value = endpoint.port;
  }
  await connectTo(endpoint);
});

async function connectTo(endpoint) {
  if (connection !== 'idle') return;
  setConnection('connecting');
  try {
    localStorage.setItem('framelink-address', JSON.stringify(endpoint));
    await api.connect(endpoint);
  } catch (error) {
    if (connection === 'connecting') setConnection('idle', error.message);
  }
}

function renderDevices() {
  const usb = el('connection').elements.transport.value === 'usb';
  const visible = !usb && connection === 'idle';
  show('discoveryResults', visible);
  show('manualAddress', connection === 'idle');
  el('scanDevices').disabled = !visible || scanPending;
  show('connectButton', !visible || el('manualAddress').open);
  if (!visible) return;
  el('devices').replaceChildren(...devices.map(device => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const icon = document.createElement('i');
    const name = document.createElement('span');
    const address = document.createElement('span');
    button.type = 'button';
    button.disabled = device.busy;
    icon.className = 'bi bi-phone';
    icon.setAttribute('aria-hidden', 'true');
    name.textContent = device.name;
    address.className = 'device-ip';
    address.textContent = device.busy ? 'Занят' : device.host + ':' + device.port;
    button.append(icon, name, address);
    button.addEventListener('click', () => {
      el('host').value = device.host;
      el('port').value = device.port;
      connectTo({ host: device.host, port: device.port, transport: 'ip' });
    });
    item.append(button);
    return item;
  }));
}

async function scanDevices(showProgress = false) {
  if (scanPending || connection !== 'idle' || el('connection').elements.transport.value === 'usb') return;
  scanPending = true;
  if (showProgress) errorText('discoveryHint', 'Поиск…');
  renderDevices();
  try { devices = await api.discover(); }
  catch { devices = []; }
  finally {
    scanPending = false;
    errorText('discoveryHint', devices.length ? '' : 'Откройте доступ на телефоне в той же сети Wi-Fi');
    renderDevices();
  }
}

el('manualAddress').addEventListener('toggle', renderDevices);
el('scanDevices').addEventListener('click', () => scanDevices(true));
setInterval(() => scanDevices(), 5500);

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window || event.data !== 'framelink-port') return;
  const [port] = event.ports;
  if (!port) return;
  port.onmessage = ({ data }) => receive(data, port);
});

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array();
}

function receive(event, port) {
  if (event.type === 'virtualStopped') {
    if (event.message) {
      stopVirtual(false);
      errorText('virtualError', event.message);
    }
    return;
  }
  if (event.type === 'browserFrame') {
    port.postMessage({ browserAck: event.id });
    layers.browserFrame(event, bytesOf(event.pixels));
    return;
  }
  if (event.type === 'browserError') {
    layers.browserError(event);
    return;
  }
  if (event.type === 'frame') port.postMessage('frame-ack');
  if (connection === 'idle') return;
  switch (event.type) {
    case 'ready':
      preferHardware = true;
      setConnection('live');
      setEmpty('Ожидание видео');
      break;
    case 'retrying':
      endVideo();
      setAudioState(false);
      setConnection('connecting');
      text('statusText', 'Восстанавливаем связь…');
      break;
    case 'disconnected': setConnection('idle', event.message); break;
    case 'settings': synchronizeCamera(event); break;
    case 'video': configureVideo(event); break;
    case 'frame': decodeFrame(event); break;
    case 'audio': setAudioState(Boolean(event.active)); break;
    case 'pcm': monitor.push(bytesOf(event.bytes)); break;
    case 'cameraError':
      endVideo();
      setEmpty('Камера недоступна', String(event.message));
      break;
  }
}

function setEmpty(title, hint = '') {
  text('emptyTitle', title);
  text('emptyHint', hint);
  show('emptyHint', Boolean(hint));
  redraw();
}

function discardDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  waitingForKey = true;
}

function endVideo() {
  discardDecoder();
  config = null;
  receivedFrame = false;
  lastVideoTime = 0;
  frameCounter = 0;
  captureFps = 0;
  invalidateMask();
  if (compositor) compositor.hasFrame = false;
  el('mirror').disabled = true;
  text('videoStats', '');
  text('effectStatus', '');
  setEmpty('Нет видео');
}

function configureVideo(meta) {
  discardDecoder();
  if (!compositor || typeof VideoDecoder !== 'function') {
    setEmpty('Видео недоступно', 'H.264 и WebGL 2 необходимы для предпросмотра.');
    return;
  }
  if (!/^avc1\.[\da-f]{6}$/i.test(meta.codec) || ![0, 90, 180, 270].includes(meta.rotation)
      || !Number.isInteger(meta.width) || !Number.isInteger(meta.height)
      || meta.width < 16 || meta.width > 1920 || meta.height < 16 || meta.height > 1080) {
    setEmpty('Видео недоступно', 'Телефон прислал некорректный формат видео.');
    return;
  }
  if (config && config.front !== meta.front) el('mirror').setAttribute('aria-pressed', 'false');
  config = meta;
  invalidateMask();
  let active;
  const failed = error => {
    if (active !== decoder) return;
    discardDecoder();
    if (preferHardware) {
      preferHardware = false;
      configureVideo(meta);
      api.keyframe();
    } else {
      receivedFrame = false;
      compositor.hasFrame = false;
      setEmpty('Ошибка декодера H.264', error.message);
    }
  };
  active = new VideoDecoder({
    output: frame => {
      if (active !== decoder) { frame.close(); return; }
      try {
        compositor.loadFrame(frame);
        requestMask(frame);
        lastVideoTime = performance.now();
        frameCounter++;
        if (!receivedFrame) {
          receivedFrame = true;
          el('mirror').disabled = false;
          stats();
        }
        redraw();
      } catch (error) {
        receivedFrame = false;
        compositor.hasFrame = false;
        setEmpty('Кадр не отобразился', error.message);
      } finally { frame.close(); }
    },
    error: failed
  });
  decoder = active;
  try {
    active.configure({
      codec: meta.codec, codedWidth: meta.width, codedHeight: meta.height,
      hardwareAcceleration: preferHardware ? 'prefer-hardware' : 'prefer-software', optimizeForLatency: true
    });
  } catch (error) { failed(error); }
}

function decodeFrame(event) {
  if (!decoder || decoder.state !== 'configured') return;
  if (decoder.decodeQueueSize > 6) {
    if (!waitingForKey) {
      configureVideo(config);
      api.keyframe();
    }
    return;
  }
  if (waitingForKey && !event.key) return;
  try {
    decoder.decode(new EncodedVideoChunk({
      type: event.key ? 'key' : 'delta', timestamp: event.timestamp, data: bytesOf(event.bytes)
    }));
    waitingForKey = false;
  } catch {
    configureVideo(config);
    api.keyframe();
  }
}

function stats() {
  if (!config || !receivedFrame) return;
  const sideways = config.rotation % 180 !== 0;
  const size = sideways ? [config.height, config.width] : [config.width, config.height];
  text('videoStats', size.join(' × ') + '  ·  ' + (captureFps || config.fps) + ' FPS  ·  H.264');
}
setInterval(() => {
  if (connection !== 'live') return;
  captureFps = frameCounter;
  frameCounter = 0;
  if (receivedFrame && performance.now() - lastVideoTime > 2400) {
    text('videoStats', 'Ожидание кадров…');
  } else stats();
}, 1000);

function toggleTab(tab) {
  for (const button of document.querySelectorAll('[role="tab"]')) {
    const active = button === tab;
    button.setAttribute('aria-selected', active);
    button.tabIndex = active ? 0 : -1;
    show(button.getAttribute('aria-controls'), active);
  }
}

const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
for (const tab of tabs) {
  tab.addEventListener('click', () => toggleTab(tab));
  tab.addEventListener('keydown', event => {
    const i = tabs.indexOf(tab);
    const index = { ArrowLeft: (i + tabs.length - 1) % tabs.length, ArrowRight: (i + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (index === undefined) return;
    event.preventDefault();
    toggleTab(tabs[index]);
    tabs[index].focus();
  });
}

function sendSettings(key, next) {
  if (connection !== 'live') return;
  queuedSettings[key] = next;
  if (settingsTimer) return;
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    const values = queuedSettings;
    queuedSettings = {};
    api.settings(values).catch(error => errorText('connectionError', error.message));
  }, 65);
}

el('lens').addEventListener('change', event => sendSettings('front', event.target.value === 'front'));
for (const [id, key] of [['resolution', 'height'], ['fps', 'fps'], ['wb', 'wb']]) {
  el(id).addEventListener('change', () => sendSettings(key, value(id)));
}
for (const id of ['manualExposure', 'manualFocus']) {
  el(id).addEventListener('change', event => sendSettings(id, event.target.checked));
}
for (const id of cameraKeys) {
  el(id).addEventListener('input', () => {
    cameraLabels();
    sendSettings(id, value(id));
  });
}

function cameraLabels() {
  text('zoomValue', (value('zoom') / 100).toFixed(2) + '×');
  const ev = value('ev') * (cameraState?.evStep || 0);
  text('evValue', (ev > 0 ? '+' : '') + ev.toFixed(1) + ' EV');
  text('shutterValue', (value('shutter') / 1000).toFixed(2) + ' мс');
  text('isoValue', value('iso'));
  text('focusValue', value('focus') + '%');
}

function synchronizeCamera(settings) {
  cameraState = settings;
  show('cameraHint', false);
  show('cameraFields', true);
  el('lens').options[0].disabled = !settings.hasRear;
  el('lens').options[1].disabled = !settings.hasFront;
  el('lens').value = settings.front ? 'front' : 'rear';
  el('resolution').value = settings.height;
  el('fps').value = settings.fps;
  const modes = Array.isArray(settings.whiteBalances) ? settings.whiteBalances.filter(mode => whiteBalances[mode]) : [1];
  const listed = Array.from(el('wb').options).map(option => Number(option.value));
  if (modes.join() !== listed.join()) el('wb').replaceChildren(...modes.map(mode => new Option(whiteBalances[mode], mode)));
  el('wb').value = settings.wb;
  for (const [id, min, max] of [
    ['zoom', 100, settings.zoomMax], ['ev', settings.evMin, settings.evMax],
    ['shutter', settings.shutterMin, settings.shutterMax], ['iso', settings.isoMin, settings.isoMax],
    ['focus', 0, 100]
  ]) {
    const input = el(id);
    if (input.matches(':active')) continue;
    input.min = min;
    input.max = max;
    input.value = settings[id];
    input.disabled = max <= min;
  }
  el('manualExposure').checked = settings.manualExposure;
  el('manualFocus').checked = settings.manualFocus;
  show('manualExposureRow', settings.hasManualExposure);
  show('manualFocusRow', settings.hasManualFocus);
  show('evRow', !settings.manualExposure);
  show('shutterRow', settings.manualExposure);
  show('isoRow', settings.manualExposure);
  show('focusRow', settings.manualFocus);
  cameraLabels();
}

function readVisuals() {
  const key = el('keyColor').value.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
  return {
    rotation: config?.rotation || 0, effect: value('effect'), mirror: el('mirror').getAttribute('aria-pressed') === 'true',
    key, tolerance: value('tolerance') / 100, maskThreshold: value('maskThreshold') / 100,
    blur: value('blur') * (config?.width || 1280) / 1280,
    adjustments: [value('brightness') / 100, value('contrast') / 100, value('saturation') / 100], mono: el('mono').checked
  };
}

function redraw() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    const visible = layers.hasPicture(receivedFrame);
    el('snapshot').disabled = !visible;
    show('empty', !visible);
    show('canvas', visible);
    layers.canvasEditor.sync();
    if (compositor) {
      try {
        compositor.draw(readVisuals(), layers.drawables());
        sceneVersion++;
      } catch (error) {
        text('emptyHint', error.message);
        show('emptyHint', true);
        show('empty', true);
        show('canvas', false);
      }
    }
  });
}

function invalidateMask() {
  maskEpoch++;
  lastMask = 0;
  maskStatus = '';
  if (compositor) compositor.hasMask = false;
}

function requestMask(frame) {
  if (![2, 3].includes(value('effect')) || workerBusy || performance.now() - lastMask < 72 || maskStatus === 'error') return;
  if (!worker) {
    worker = new Worker('./segment-worker.js');
    worker.onmessage = ({ data }) => {
      workerBusy = false;
      if (data.epoch !== maskEpoch) return;
      if (data.error) {
        maskStatus = 'error';
        text('effectStatus', 'Сегментация недоступна: ' + data.error);
        return;
      }
      compositor.loadMask(data);
      if (maskStatus !== 'ready') text('effectStatus', '');
      maskStatus = 'ready';
      redraw();
    };
    worker.onerror = event => {
      workerBusy = false;
      maskStatus = 'error';
      text('effectStatus', 'Сегментация недоступна: ' + event.message);
      worker.terminate();
      worker = null;
    };
  }
  if (!maskStatus) {
    maskStatus = 'loading';
    text('effectStatus', 'Загрузка эффекта…');
  }
  workerBusy = true;
  lastMask = performance.now();
  const epoch = maskEpoch;
  const { rotation, mirror } = readVisuals();
  createImageBitmap(frame).then(bitmap => {
    if (epoch !== maskEpoch) {
      bitmap.close();
      workerBusy = false;
      return;
    }
    worker.postMessage({ frame: bitmap, rotation, mirror, epoch, timestamp: performance.now() }, [bitmap]);
  }).catch(() => { workerBusy = false; });
}

function showEffectOptions() {
  const effect = value('effect');
  show('chromaSettings', effect === 1);
  show('maskSettings', effect === 2 || effect === 3);
  show('blurSettings', effect === 3);
  show('backgroundSettings', effect === 1 || effect === 2);
  invalidateMask();
  text('effectStatus', '');
  redraw();
}

el('effect').addEventListener('change', showEffectOptions);
for (const id of Object.keys(visualDefaults).filter(id => id !== 'effect').concat('mono')) {
  el(id).addEventListener('input', redraw);
}
el('mirror').addEventListener('click', () => {
  el('mirror').setAttribute('aria-pressed', el('mirror').getAttribute('aria-pressed') !== 'true');
  invalidateMask();
  redraw();
});
el('snapshot').addEventListener('click', () => {
  if (!layers.hasPicture(receivedFrame)) return;
  compositor.draw(readVisuals(), layers.drawables());
  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'FrameLink-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
});
el('pickBackground').addEventListener('click', () => el('background').click());
el('background').addEventListener('change', async () => {
  const [file] = el('background').files;
  if (!file) return;
  const previous = background.asset;
  if (compositor) compositor.backgroundRatio = 0;
  try {
    await background.load(file);
    if (background.asset && background.asset !== previous) {
      text('backgroundName', file.name);
      show('clearBackground', true);
    }
  } catch (error) {
    text('backgroundName', error.message);
    show('clearBackground', false);
    redraw();
  } finally { el('background').value = ''; }
});
function clearBackground() {
  background.clear();
  if (compositor) compositor.backgroundRatio = 0;
  show('clearBackground', false);
  text('backgroundName', 'Прозрачный фон');
  redraw();
}
el('clearBackground').addEventListener('click', clearBackground);
el('resetEffects').addEventListener('click', () => {
  for (const [key, setting] of Object.entries(visualDefaults)) el(key).value = setting;
  el('mono').checked = false;
  clearBackground();
  showEffectOptions();
});

function configureOutput() {
  const [width, height] = el('outputSize').value.split('x').map(Number);
  const fps = value('outputFps');
  compositor?.setSize(width, height);
  redraw();
  outputChange = outputChange.then(async () => {
    if (!compositor) return;
    await stopVirtual();
    const installed = await api.virtualStatus();
    const modern = await api.modernCamera();
    text('driverState', modern ? 'FrameLink Camera · Media Foundation' : installed ? 'FrameLink Camera · DirectShow' : 'Камера недоступна');
    if (!installed) return;
    await api.virtualStart(width, height, fps);
    const output = { width, height, writing: false, version: -1, sentAt: 0 };
    virtual = output;
    output.timer = setInterval(() => pumpVirtual(output), 1000 / fps);
    el('virtualState').dataset.live = 'true';
    errorText('virtualError', '');
  }).catch(error => errorText('virtualError', error.message));
}

async function pumpVirtual(output) {
  if (!compositor.scene.width || output.writing || compositor.gl.isContextLost()) return;
  const now = performance.now();
  if (output.version === sceneVersion && now - output.sentAt < 450) return;
  output.writing = true;
  try {
    const version = sceneVersion;
    if (await api.virtualFrame(compositor.nv12(output.width, output.height))) {
      output.version = version;
      output.sentAt = now;
    }
  } catch (error) {
    await stopVirtual();
    errorText('virtualError', error.message);
  } finally { output.writing = false; }
}

async function stopVirtual(useBridge = true) {
  const output = virtual;
  if (!output) return;
  clearInterval(output.timer);
  virtual = null;
  el('virtualState').dataset.live = 'false';
  if (useBridge) await api.virtualStop();
}

el('outputSize').addEventListener('change', configureOutput);
el('outputFps').addEventListener('change', configureOutput);
el('adbLink').addEventListener('click', () => api.open('adb'));
configureOutput();

function setAudioState(active) {
  monitor.active = active;
  text('audioState', active ? 'Телефон передаёт звук' : 'Микрофон выключен');
  if (!active) el('audioLevel').value = 0;
}

async function audioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const selected = el('audioDevice').value;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audiooutput' &&
    device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');
  el('audioDevice').replaceChildren(new Option('Системное устройство', ''),
    ...devices.map((device, index) => new Option(device.label || 'Устройство ' + (index + 1), device.deviceId)));
  if (devices.some(device => device.deviceId === selected)) el('audioDevice').value = selected;
}
navigator.mediaDevices?.addEventListener('devicechange', () => audioDevices().catch(() => {}));
audioDevices().catch(() => {});
el('audioEnabled').addEventListener('change', async () => {
  const change = ++audioChange;
  el('audioEnabled').disabled = true;
  errorText('audioError');
  try {
    if (el('audioEnabled').checked) {
      await monitor.enable(el('audioDevice').value, value('volume') / 100);
      await audioDevices();
    } else await monitor.disable();
  } catch (error) {
    if (audioChange === change) {
      el('audioEnabled').checked = false;
      errorText('audioError', 'Вывод звука недоступен: ' + error.message);
    }
  } finally { el('audioEnabled').disabled = false; }
});
el('audioDevice').addEventListener('change', () => monitor.setSinkId(el('audioDevice').value)
  .then(() => errorText('audioError')).catch(error => errorText('audioError', error.message)));
el('volume').addEventListener('input', () => monitor.setVolume(value('volume') / 100));
el('audioDelay').addEventListener('input', () => {
  text('delayValue', value('audioDelay') + ' мс');
  monitor.setDelay(value('audioDelay') / 1000);
});

let updateVersion;
const checkUpdates = async (manual = false) => {
  el('checkUpdates').disabled = true;
  try {
    const result = await api.updateCheck();
    updateVersion = result.version;
    const offer = result.state === 'new' && (manual || localStorage.getItem('skipped-version') !== result.version);
    show('updateBar', offer);
    show('loginUpdates', result.state === 'account');
    if (offer) text('updateVersion', 'Доступна версия ' + result.version);
    errorText('updateStatus', result.state === 'account' ? 'Для доступа к приватным релизам войдите в GitHub' :
      manual && result.state === 'current' ? 'Установлена последняя версия' : '');
  } catch (error) { if (manual) errorText('updateStatus', error.message); }
  finally { el('checkUpdates').disabled = false; }
};
el('checkUpdates').onclick = () => checkUpdates(true);
el('loginUpdates').onclick = async () => { await api.updateLogin(); await checkUpdates(true); };
el('updateSkip').onclick = () => { localStorage.setItem('skipped-version', updateVersion); show('updateBar', false); };
el('updateInstall').onclick = async () => {
  el('updateInstall').disabled = el('updateSkip').disabled = true;
  text('updateVersion', 'Загрузка обновления…');
  try { await api.updateInstall(updateVersion); }
  catch (error) { text('updateVersion', error.message); }
  finally { el('updateInstall').disabled = el('updateSkip').disabled = false; }
};
el('repairCamera').onclick = async () => {
  el('repairCamera').disabled = true;
  try { await api.virtualRepair(); configureOutput(); }
  catch { errorText('virtualError', 'Восстановление не завершено. Проверьте разрешение администратора и доступ Windows к камере'); }
  finally { el('repairCamera').disabled = false; }
};
checkUpdates();
