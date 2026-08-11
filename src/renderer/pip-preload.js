'use strict';
/**
 * 画中画控制浮窗的 preload。
 * 暴露的 API 尽可能小，只包含拖动、控制命令和状态推送。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronPip', {
  moveBy: (dx, dy) => ipcRenderer.send('pip:move-by', { dx, dy }),
  resize: (w, h) => ipcRenderer.send('pip:resize', { w, h }),
  dragStart: () => ipcRenderer.send('pip:drag-start'),
  dragEnd: () => ipcRenderer.send('pip:drag-end'),
  command: (action) => ipcRenderer.send('pip:command', action),
  onUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('pip:update', handler);
    return () => ipcRenderer.removeListener('pip:update', handler);
  },
});
