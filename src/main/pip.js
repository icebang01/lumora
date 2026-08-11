/**
 * 画中画 PiP(自包含模块,ctx 注入模式)。
 * 从 index.js 拆出(2026-08):togglePip/createPipControlWin/updatePipControlState/exitPipMode。
 * pip 状态(pipMode 与 pipPrev 系列/pipControlWin)模块内自持,对外暴露 getPipMode()。
 * 用法:pip.setCtx({ getWin, getVideoWin, sendToRenderer, getUseMpv, getCurrentDar });(bootstrap 开头注入)
 */
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { syncWindows: doSyncWindows, resyncNow: doResyncNow, setFullscreen: doSetFullscreen } = require('./windows');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function win() { return CTX.getWin ? CTX.getWin() : null; }
function videoWin() { return CTX.getVideoWin ? CTX.getVideoWin() : null; }
function sendToRenderer(...a) { return CTX.sendToRenderer ? CTX.sendToRenderer(...a) : null; }
function useMpv() { return CTX.getUseMpv ? CTX.getUseMpv() : true; }
function currentDar() { return CTX.getCurrentDar ? CTX.getCurrentDar() : null; }

let pipMode = false;  // 画中画状态
let pipPrevOnTop = false;     // 进入 PiP 前主窗口是否置顶
let pipPrevFullscreen = false; // 进入 PiP 前主窗口是否全屏
let pipPrevBounds = null;     // 进入 PiP 前主窗口 bounds，退出时还原
let pipControlWin = null;     // PiP 控制浮窗（拖动条 + 关闭/还原按钮）
function getPipMode() { return pipMode; }

function togglePip() {
  if (!win() || !videoWin() || win().isDestroyed() || videoWin().isDestroyed()) {
    return { ok: false, active: pipMode };
  }
  // ffmpeg/WebGL 引擎的画面在 win 的 WebGL 画布上，videoWin 只是黑底，
  // 不支持画中画；mpv 引擎才走 videoWin 的 HWND 渲染。
  if (pipMode === false && !useMpv()) {
    sendToRenderer('osd', { text: '画中画仅在 mpv 引擎下可用', value: '' });
    return { ok: false, active: false };
  }

  pipMode = !pipMode;

  if (pipMode) {
    pipPrevOnTop = videoWin().isAlwaysOnTop();
    pipPrevFullscreen = videoWin().isFullScreen();
    pipPrevBounds = videoWin().getBounds();

    const dar = currentDar();
    const work = screen.getPrimaryDisplay().workAreaSize;
    const pipW = Math.min(420, Math.round(work.width * 0.3));
    const pipH = Math.max(180, Math.round(pipW / dar));
    const margin = 24;
    const x = work.width - pipW - margin;
    const y = work.height - pipH - margin;

    if (!videoWin().isVisible()) videoWin().showInactive();
    videoWin().setFullScreen(false);
    videoWin().setAlwaysOnTop(true, 'pop-up-menu');
    // videoWin 只出画面，不接收鼠标；所有交互由上面的 pipControlWin 处理
    videoWin().setIgnoreMouseEvents(true);
    videoWin().setBounds({ x, y, width: pipW, height: pipH });

    // PiP 模式：win 隐藏，videoWin 独立浮动
    // （不再使用 setParentWindow，直接隐藏 win 即可）

    // 隐藏主 UI 窗口（隐藏而非最小化，避免任务栏多一个条目）
    win().hide();

    // 创建控制浮窗：标题栏、拖动、关闭、还原
    createPipControlWin(x, y, pipW, pipH);

    // 全局 T 也退出 PiP（win 隐藏后渲染进程收不到键盘）
    try {
      if (globalShortcut && !globalShortcut.isRegistered('T')) {
        globalShortcut.register('T', () => { try { togglePip(); } catch { /* 忽略 */ } });
      }
    } catch { /* 注册失败不影响 PiP 本身 */ }

    sendToRenderer('window:pip', { active: true });
  } else {
    exitPipMode();
  }
  return { ok: true, active: pipMode };
}

/** 创建 PiP 控制浮窗：带拖动条、关闭/还原按钮，覆盖在 videoWin 上方 */
function createPipControlWin(x, y, w, h) {
  if (pipControlWin && !pipControlWin.isDestroyed()) {
    try { pipControlWin.destroy(); } catch {}
  }
  pipControlWin = new BrowserWindow({
    x, y, width: w, height: h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    type: 'toolbar', // 在 Windows 上更容易保持置顶且不影响任务栏焦点
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'pip-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  pipControlWin.setMenu(null);
  pipControlWin.setIgnoreMouseEvents(false);
  pipControlWin.loadFile(path.join(__dirname, '..', 'renderer', 'pip.html'));

  pipControlWin.on('closed', () => { pipControlWin = null; });

  // 等页面加载完再推初始状态，否则 preload 尚未注入会丢消息
  pipControlWin.webContents.once('did-finish-load', () => {
    updatePipControlState();
  });
}

/** 向 PiP 控制浮窗推送标题与播放状态 */
async function updatePipControlState() {
  if (!pipControlWin || pipControlWin.isDestroyed()) return;
  const title = currentInfo ? (currentInfo.title || path.basename(currentInfo.path)) : 'Lumora 画中画';
  let paused = false;
  if (useMpv && mpvBackend && mpvBackend.ready) {
    try { paused = await mpvBackend.getProperty('pause'); } catch {}
  }
  try {
    pipControlWin.webContents.send('pip:update', { title, paused });
  } catch {}
}

/** 同步控制浮窗位置/大小到 videoWin（拖动、resize 时用） */
function syncPipControlWin() {
  if (!pipControlWin || pipControlWin.isDestroyed() || !videoWin() || videoWin().isDestroyed()) return;
  const b = videoWin().getBounds();
  try {
    pipControlWin.setBounds(b);
  } catch {}
}

/** 退出 PiP：恢复主窗口、销毁控制浮窗 */
function exitPipMode() {
  pipMode = false;
  try { if (globalShortcut) globalShortcut.unregister('T'); } catch { /* 忽略 */ }
  if (pipControlWin && !pipControlWin.isDestroyed()) {
    try { pipControlWin.destroy(); } catch {}
    pipControlWin = null;
  }
  if (videoWin() && !videoWin().isDestroyed()) {
    videoWin().setIgnoreMouseEvents(true);
    videoWin().setAlwaysOnTop(pipPrevOnTop, pipPrevOnTop ? 'pop-up-menu' : undefined);
  }
  if (win() && !win().isDestroyed()) {
    // 退出 PiP：显示 win 并暴力同步到 videoWin
    win().show();
    doSyncWindows();
    win().moveTop();
  }
  // 全屏/边界恢复：用 doSetFullscreen() 统一处理（会正确脱离/恢复父子关系）
  if (pipPrevFullscreen && videoWin() && !videoWin().isDestroyed()) {
    doSetFullscreen(true);
  } else if (pipPrevBounds && videoWin && !videoWin().isDestroyed()) {
    videoWin().setBounds(pipPrevBounds);
  }
  doResyncNow();
  sendToRenderer('window:pip', { active: false });
}

/** 剔除不需要跨进程传的字段，保持 IPC 载荷精简 */
function sanitizeInfo(info) {
  return {
    path: info.path,
    container: info.container,
    duration: info.duration,
    size: info.size,
    bitrate: info.bitrate,
    title: info.title,
    artist: info.artist,
    album: info.album,
    albumArtist: info.albumArtist,
    date: info.date,
    genre: info.genre,
    composer: info.composer,
    lyricist: info.lyricist,
    arranger: info.arranger,
    chapters: info.chapters,
    audioOnly: info.audioOnly,
    hasVideo: info.hasVideo,
    hasAudio: info.hasAudio,
    video: info.video,
    audio: info.audio,
    subtitle: info.subtitle,
  };
}

module.exports = { setCtx, togglePip, createPipControlWin, updatePipControlState, syncPipControlWin, exitPipMode, sanitizeInfo, getPipMode };
