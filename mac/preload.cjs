// The only bridge into the windows. Every channel is an explicit zode:* channel; contextIsolation is
// on, nodeIntegration off, sandbox on. The setup wizard uses the zode:setup* channels; there is no
// generic bridge.
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
  // Setup wizard.
  setupState: () => ipcRenderer.invoke('zode:setupState'),
  setupStartBuild: () => ipcRenderer.invoke('zode:setupStartBuild'),
  setupQuitBlocking: () => ipcRenderer.invoke('zode:setupQuitBlocking'),
  setupOpenEngine: () => ipcRenderer.invoke('zode:setupOpenEngine'),
  setupOpenDownload: () => ipcRenderer.invoke('zode:setupOpenDownload'),
  setupDone: () => ipcRenderer.invoke('zode:setupDone'),
  setupTrashOldApp: () => ipcRenderer.invoke('zode:setupTrashOldApp'),
  onSetupEvent: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('zode:setupEvent', fn);
    return () => ipcRenderer.removeListener('zode:setupEvent', fn);
  },
});
