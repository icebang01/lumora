'use strict';
/**
 * IPC·更新域（自包含模块）。
 * 从 register-ipc.js 拆出：updater:get-state / updater:check / updater:install。
 * 用法：register(ctx)——ctx 与 register-ipc.js 的 setCtx 同构；由编排器统一注入。
 */
const { ipcMain } = require('electron');
const updater = require('./updater');

let CTX = {};
function register(ipcCtx) {
  CTX = ipcCtx || {};
  ipcMain.handle('updater:get-state', () => updater.getState());
  ipcMain.handle('updater:check', async () => updater.checkForUpdates());
  ipcMain.handle('updater:install', async () => {
    updater.installUpdate();
    return { ok: true };
  });
}

module.exports = { register };
