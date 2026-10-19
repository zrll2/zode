// The only bridge into the pairing window. Every channel is an explicit zode:* channel;
// contextIsolation is on, nodeIntegration off, sandbox on.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zode', {
  getPairing: () => ipcRenderer.invoke('zode:getPairing'),
  newCode: () => ipcRenderer.invoke('zode:newCode'),
  copy: (text) => ipcRenderer.invoke('zode:copy', text),
  listDevices: () => ipcRenderer.invoke('zode:listDevices'),
  revoke: (id) => ipcRenderer.invoke('zode:revoke', id),
  onStatus: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('zode:status', fn);
    return () => ipcRenderer.removeListener('zode:status', fn);
  },
});
