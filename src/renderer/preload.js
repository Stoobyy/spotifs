'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('player', {
  ready: () => ipcRenderer.send('player:ready'),
  close: () => ipcRenderer.send('player:close'),
  command: (name, value) => ipcRenderer.send('player:command', name, value),

  onState: (callback) => {
    ipcRenderer.on('player:state', (_event, state) => callback(state));
  },
  onVisibility: (callback) => {
    ipcRenderer.on('player:visible', (_event, visible) => callback(visible));
  },
  onAppearance: (callback) => {
    ipcRenderer.on('player:appearance', (_event, appearance) => callback(appearance));
  },
});
