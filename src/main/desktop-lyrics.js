'use strict';
/**
 * 桌面歌词窗口（独立辅助窗口，自包含模块）。
 *
 * 与主 UI 窗 / 视频窗的「暴力同步」体系完全解耦 —— 它是一个独立的、
 * 永远置顶（alwaysOnTop）、透明、无边框的小窗口，浮在桌面（及其他应用）之上，
 * 专门显示当前播放歌词的当前行 + 下一行。
 *
 * 数据流：
 *   主渲染进程（music-stage.js 歌词同步循环，仅行切换时）→
 *     ipcRenderer.send('desktop-lyrics:update', { line, next, trans }) →
 *     本模块收到后转发给歌词窗口 webContents.send('desktop-lyrics:data', ...)
 *
 * 设计取舍（v1）：
 *   - 窗口默认可交互（拖拽条移动 + 字号 +/- + 关闭），不参与点击穿透。
 *   - 未做「锁定/点击穿透」：Electron 的 setIgnoreMouseEvents(true) 会让窗口
 *     完全收不到鼠标事件，导致无法再从窗口内解锁（死锁），且点击穿透与窗口内
 *     拖拽天然互斥。点击穿透留作后续增强（需配合独立的拖拽手柄或全局快捷键）。
 *
 * 用法：setCtx({ getConfigDir }) 注入配置目录（持久化位置/字号），
 * 由 register-ipc.js 编排器在 registerIpc() 中调用 register() 注册 IPC。
 */
const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');

let CTX = {};
let dlWin = null;          // 桌面歌词 BrowserWindow
let dlVisible = false;
let dlFontSize = 30;       // 当前字号（px）
let dlBounds = null;       // 记忆位置 { x, y, width, height }
let settingsPath = '';
let _saveTimer = null;
let _lastPayload = null;   // 最近一次歌词载荷（首开窗口就绪前可能丢失，ready 时重发）

function setCtx(ctx) { CTX = ctx || {}; }

// 通知主 UI 渲染进程当前可见状态（供其同步开关按钮 aria），可选
function _emitState() {
  if (CTX.notify && typeof CTX.notify === 'function') {
    try { CTX.notify('desktop-lyrics:state', { visible: dlVisible }); } catch {}
  }
}
function getConfigDir() {
  if (CTX.getConfigDir) {
    const d = CTX.getConfigDir();
    if (d) return d;
  }
  try { return app.getPath('userData'); } catch { return ''; }
}

function _settingsFile() {
  if (!settingsPath) settingsPath = path.join(getConfigDir() || '', 'desktop-lyrics.json');
  return settingsPath;
}

function _loadSettings() {
  try {
    const f = _settingsFile();
    if (fs.existsSync(f)) {
      const s = JSON.parse(fs.readFileSync(f, 'utf8') || '{}');
      if (typeof s.fontSize === 'number') dlFontSize = s.fontSize;
      if (s.bounds && typeof s.bounds.x === 'number') dlBounds = s.bounds;
    }
  } catch { /* 损坏配置忽略，用默认 */ }
}

function _saveSettings() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const f = _settingsFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ fontSize: dlFontSize, bounds: dlBounds || null }));
    } catch { /* 无权限则忽略 */ }
  }, 400);
}

const DL_DEFAULT_WIDTH = 760;
const DL_DEFAULT_HEIGHT = 168;
const DL_MIN_WIDTH = 280;
const DL_MIN_HEIGHT = 96;

function _createWindow() {
  if (dlWin && !dlWin.isDestroyed()) return dlWin;
  const win = new BrowserWindow({
    width: DL_DEFAULT_WIDTH,
    height: DL_DEFAULT_HEIGHT,
    minWidth: DL_MIN_WIDTH,
    minHeight: DL_MIN_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,        // 不抢焦点（媒体键/主窗口焦点不受影响）
    resizable: true,         // 允许用户手动拉高，避免内容被截断
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  const q = `?fs=${encodeURIComponent(dlFontSize)}`;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'desktop-lyrics.html'), { search: q });
  win.setMenu(null);
  // 恢复上次位置，但高度不能低于当前默认高度（避免旧版保存的 96/132 覆盖新版 168）
  if (dlBounds) {
    try {
      const b = {
        x: dlBounds.x,
        y: dlBounds.y,
        width: Math.max(DL_MIN_WIDTH, Math.min(1920, dlBounds.width || DL_DEFAULT_WIDTH)),
        height: Math.max(DL_DEFAULT_HEIGHT, dlBounds.height || DL_DEFAULT_HEIGHT),
      };
      win.setBounds(b);
    } catch { /* 越界则忽略 */ }
  }
  win.once('ready-to-show', () => {
    if (dlVisible && !win.isDestroyed()) win.show();
    // 首开时渲染端可能已先于本窗口脚本就绪而发来歌词，缓存重发避免丢首帧
    if (_lastPayload && dlVisible && win.webContents && !win.isDestroyed()) {
      try { win.webContents.send('desktop-lyrics:data', _lastPayload); } catch {}
    }
  });
  win.on('closed', () => { dlWin = null; });
  win.on('moved', () => { if (dlWin && !dlWin.isDestroyed()) { try { dlBounds = dlWin.getBounds(); } catch {} _saveSettings(); } });
  win.on('resized', () => { if (dlWin && !dlWin.isDestroyed()) { try { dlBounds = dlWin.getBounds(); } catch {} _saveSettings(); } });
  dlWin = win;
  return win;
}

function show() {
  _loadSettings();
  const w = _createWindow();
  if (!w.isVisible() && !w.isDestroyed()) w.show();
  dlVisible = true;
  _emitState();
}

function hide() {
  dlVisible = false;
  _saveSettings();
  if (dlWin && !dlWin.isDestroyed()) { try { dlWin.hide(); } catch {} }
  _emitState();
}

function toggle() {
  if (dlVisible) hide(); else show();
  return { visible: dlVisible };
}

// 主 UI 渲染进程转发来的歌词数据 → 推给歌词窗口（仅在窗口存在且可见时投递）
function update(payload) {
  // 合并进缓存：逐字进度(prog)等增量消息不得覆盖 line/chars/meta（窗口首开重发需完整数据）
  if (payload && typeof payload === 'object') {
    _lastPayload = Object.assign({}, _lastPayload, payload);
  }
  if (dlWin && !dlWin.isDestroyed() && dlWin.webContents && dlVisible) {
    try { dlWin.webContents.send('desktop-lyrics:data', payload || {}); } catch {}
  }
}

function moveBy(dx, dy) {
  if (!dlWin || dlWin.isDestroyed()) return;
  try {
    const b = dlWin.getBounds();
    dlWin.setBounds({ x: b.x + (dx || 0), y: b.y + (dy || 0), width: b.width, height: b.height });
  } catch {}
}

function setFontSize(delta) {
  dlFontSize = Math.max(16, Math.min(72, (dlFontSize || 30) + (delta || 0)));
  _saveSettings();
}

/** 应用退出时销毁歌词窗口，避免孤儿窗口 */
function teardownWindow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (dlWin && !dlWin.isDestroyed()) { try { dlWin.destroy(); } catch {} }
  dlWin = null;
}

function register() {
  const { ipcMain } = require('electron');
  ipcMain.on('desktop-lyrics:update', (_e, payload) => update(payload));
  ipcMain.handle('desktop-lyrics:toggle', () => toggle());
  ipcMain.handle('desktop-lyrics:show', () => { show(); return { visible: dlVisible }; });
  ipcMain.handle('desktop-lyrics:hide', () => { hide(); return { visible: dlVisible }; });
  ipcMain.on('desktop-lyrics:move', (_e, { dx, dy } = {}) => moveBy(dx, dy));
  ipcMain.on('desktop-lyrics:fontsize', (_e, { delta } = {}) => setFontSize(delta));
  ipcMain.on('desktop-lyrics:close', () => hide());
}

module.exports = { setCtx, register, teardownWindow };
