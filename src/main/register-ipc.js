/**
 * IPC 注册（编排器，自包含模块）。
 * 2026-08 按领域拆分：ipc-player / ipc-media / ipc-window / ipc-app。
 * 用法：setCtx({...}) 注入宿主状态（见各 ipc-*.js 的访问器），再 registerIpc()。
 */
const playerIpc = require('./ipc-player');
const mediaIpc = require('./ipc-media');
const windowIpc = require('./ipc-window');
const appIpc = require('./ipc-app');
const castIpc = require('./ipc-cast');
const updaterIpc = require('./ipc-updater');
const desktopLyricsIpc = require('./desktop-lyrics');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }

function registerIpc() {
  playerIpc.register(CTX);
  mediaIpc.register(CTX);
  windowIpc.register(CTX);
  appIpc.register(CTX);
  castIpc.register(CTX);
  updaterIpc.register(CTX);
  desktopLyricsIpc.register(CTX);
}

module.exports = { setCtx, registerIpc };
