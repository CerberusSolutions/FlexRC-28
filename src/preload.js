'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // RC-28
  rc28: {
    open:        () => ipcRenderer.invoke('rc28:open'),
    close:       () => ipcRenderer.invoke('rc28:close'),
    isConnected: () => ipcRenderer.invoke('rc28:isConnected'),
    on: (event, cb) => ipcRenderer.on(`rc28:${event}`, (_, data) => cb(data)),
  },

  // Flex
  flex: {
    connect:        (ip, stationName) => ipcRenderer.invoke('flex:connect', { ip, stationName }),
    disconnect:     ()               => ipcRenderer.invoke('flex:disconnect'),
    isConnected:    ()               => ipcRenderer.invoke('flex:isConnected'),
    getSlices:      ()               => ipcRenderer.invoke('flex:getSlices'),
    setActiveSlice: (id)             => ipcRenderer.invoke('flex:setActiveSlice', id),
    on: (event, cb) => ipcRenderer.on(`flex:${event}`, (_, data) => cb(data)),
  },

  // Settings
  settings: {
    load: ()   => ipcRenderer.invoke('settings:load'),
    save: (s)  => ipcRenderer.invoke('settings:save', s),
  },

  // Controller
  ctrl: {
    getActions:          () => ipcRenderer.invoke('ctrl:getActions'),
    getAvailableActions: () => ipcRenderer.invoke('ctrl:getAvailableActions'),
    on: (event, cb) => ipcRenderer.on(`ctrl:${event}`, (_, data) => cb(data)),
  },
});
