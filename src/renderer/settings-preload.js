'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  importFont: () => ipcRenderer.invoke('settings:importFont'),
  removeFont: (family) => ipcRenderer.invoke('settings:removeFont', family),
  importImage: () => ipcRenderer.invoke('settings:importImage'),
  clearImage: () => ipcRenderer.invoke('settings:clearImage'),
  close: () => ipcRenderer.send('settings:close'),

  spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifyConnect: () => ipcRenderer.invoke('spotify:connect'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),
  onSpotifyStatus: (callback) => {
    ipcRenderer.on('spotify:status', (_event, status) => callback(status));
  },
});
