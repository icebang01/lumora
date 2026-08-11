'use strict';
/**
 * 自动更新（electron-updater）。
 *
 * 更新源：GitHub Releases（build.publish 中配置 provider: github，
 * 由 electron-builder 打包时写入 app-update.yml，electron-updater 据此拉取）。
 *
 * dev 模式（app.isPackaged === false）下 electron-updater 无法定位更新配置，
 * 直接禁用并通知渲染端显示「开发模式，更新不可用」。
 *
 * 行为（按用户选择）：发现新版本后后台自动下载（autoDownload），
 * 下载完成后不静默安装，由用户在设置面板点击「重启并安装」确认。
 *
 * 主进程 → 渲染端事件：
 *   updater:status   { status, version, info?, error? }
 *   updater:progress { percent, transferred, total, bytesPerSecond }
 */
const { app } = require('electron');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function sendToRenderer(channel, payload) {
  if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload);
}

let autoUpdater = null;
let enabled = false;
// 防御性：app 在某些 electron 初始化异常（require('electron') 退化返回非 API 对象）时
// 可能为 undefined，顶层直接 app.getVersion() 会让主进程在启动第一秒崩溃（窗口闪一下即消失）。
// 改为惰性安全取值，避免自动更新模块拖垮整个应用启动。
function _safeVersion() {
  try {
    return (app && typeof app.getVersion === 'function') ? app.getVersion() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const state = { status: 'idle', version: _safeVersion(), info: null, error: null };

function emitStatus(status, extra) {
  state.status = status;
  if (extra) Object.assign(state, extra);
  sendToRenderer('updater:status', Object.assign({}, state));
}
function emitProgress(p) {
  sendToRenderer('updater:progress', {
    percent: (p && p.percent) || 0,
    transferred: (p && p.transferred) || 0,
    total: (p && p.total) || 0,
    bytesPerSecond: (p && p.bytesPerSecond) || 0,
  });
}

function setup() {
  if (!app.isPackaged) {
    enabled = false;
    emitStatus('disabled');
    return;
  }
  let mod;
  try {
    mod = require('electron-updater');
  } catch (e) {
    console.warn('[updater] electron-updater 未安装，更新功能不可用：', e.message);
    enabled = false;
    emitStatus('disabled');
    return;
  }
  autoUpdater = mod.autoUpdater;

  autoUpdater.autoDownload = true;          // 发现即后台自动下载
  autoUpdater.autoInstallOnAppQuit = false; // 退出时不静默安装，等用户确认
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => emitStatus('checking'));
  autoUpdater.on('update-available', (info) => emitStatus('available', { info }));
  autoUpdater.on('update-not-available', (info) => emitStatus('not-available', { info }));
  autoUpdater.on('download-progress', (p) => emitProgress(p));
  autoUpdater.on('update-downloaded', (info) => emitStatus('downloaded', { info }));
  autoUpdater.on('error', (err) => emitStatus('error', { error: (err && err.message) ? err.message : String(err) }));

  enabled = true;
  emitStatus('idle');

  // 启动后静默检查一次（发现则自动下载，就绪后弹窗提示）
  setTimeout(() => {
    if (!enabled || !autoUpdater) return;
    autoUpdater.checkForUpdates().catch((e) => console.warn('[updater] 启动检查失败：', (e && e.message) || e));
  }, 3000).unref();
}

async function checkForUpdates() {
  if (!enabled || !autoUpdater) {
    emitStatus('disabled');
    return { ok: false, disabled: true };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    emitStatus('error', { error: msg });
    return { ok: false, error: msg };
  }
}

function installUpdate() {
  if (!enabled || !autoUpdater) return;
  // isSilent=false：交给 NSIS 向导；isForceRunAfter=true：装完重启 Lumora
  autoUpdater.quitAndInstall(false, true);
}

function getState() {
  return Object.assign({}, state, { enabled, version: app.getVersion() });
}

module.exports = { setCtx, setup, checkForUpdates, installUpdate, getState };
