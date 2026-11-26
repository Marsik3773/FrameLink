const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const { value, error } = await ipcRenderer.invoke(channel, ...args);
  if (error) throw new Error(error);
  return value;
}

contextBridge.exposeInMainWorld('frameLink', {
  connect: data => invoke('link:connect', data),
  discover: () => invoke('link:discover'),
  browserOpen: (...args) => invoke('browser:open', ...args),
  browserClose: id => invoke('browser:close', id),
  browserVisibility: (id, visible) => invoke('browser:visibility', id, visible),
  disconnect: () => invoke('link:disconnect'),
  settings: values => invoke('link:settings', values),
  keyframe: () => invoke('link:keyframe'),
  updateCheck: () => invoke('updates:check'),
  updateInstall: version => invoke('updates:install', version),
  virtualRepair: () => invoke('virtual:repair'),
  modernCamera: () => invoke('virtual:modern'),
  virtualStatus: () => invoke('virtual:status'),
  virtualStart: (width, height, fps) => invoke('virtual:start', width, height, fps),
  virtualStop: () => invoke('virtual:stop'),
  virtualFrame: bytes => invoke('virtual:frame', bytes),
  open: name => invoke('help:open', name)
});

ipcRenderer.on('link:stream', event => {
  window.postMessage('framelink-port', window.location.origin, event.ports);
});
