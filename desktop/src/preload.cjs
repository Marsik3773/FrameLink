const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const { value, error } = await ipcRenderer.invoke(channel, ...args);
  if (error) throw new Error(error);
  return value;
}

contextBridge.exposeInMainWorld('frameLink', {
  connect: data => invoke('link:connect', data),
  disconnect: () => invoke('link:disconnect'),
  settings: values => invoke('link:settings', values),
  keyframe: () => invoke('link:keyframe'),
  virtualStatus: () => invoke('virtual:status'),
  virtualStart: (width, height, fps) => invoke('virtual:start', width, height, fps),
  virtualStop: () => invoke('virtual:stop'),
  virtualFrame: bytes => invoke('virtual:frame', bytes),
  open: name => invoke('help:open', name)
});

ipcRenderer.on('link:stream', event => {
  window.postMessage('framelink-port', window.location.origin, event.ports);
});
