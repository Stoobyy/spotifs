'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  importFont: () => ipcRenderer.invoke('settings:importFont'),
  removeFont: (family) => ipcRenderer.invoke('settings:removeFont', family),
  close: () => ipcRenderer.send('settings:close'),
});
