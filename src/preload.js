'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokenbar', {
  getUsage: () => ipcRenderer.invoke('usage:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  close: () => ipcRenderer.invoke('panel:close'),
  onUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('usage:update', handler);
    return () => ipcRenderer.removeListener('usage:update', handler);
  },
});
