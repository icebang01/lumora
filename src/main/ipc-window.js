/**
 * IPC 注册·window（自包含模块）。
 * 从 register-ipc.js 拆出（2026-08）：窗口域：ui:set-idle-state + window:command + pip:*（拖动/缩放/按钮）。
 * 用法：register(ctx)——ctx 与 register-ipc.js 的 setCtx 同构（getConfig/getCurrentInfo/...），
 * 由 register-ipc.js 编排器统一注入。
 */
const { ipcMain, screen, nativeTheme, app } = require('electron');
const pip = require('./pip');
const { togglePip, syncPipControlWin, updatePipControlState, getPipMode, exitPipMode } = pip;
const { setFullscreen, resyncNow, ensureVideoWindow, computeWindowSize } = require('./windows');

// 首页（idle）窗口尺寸与首次打开/音乐模块保持一致，
// 使用 computeWindowSize() 统一计算，使"播放器返回的主页"、"首次打开的主页"
// 与"音乐模块"三者窗口大小相同。
const IDLE_HOME_MIN_MARGIN = 40;
let CTX = {};
function register(ipcCtx) { CTX = ipcCtx || {};
function setIdleState(v) { if (CTX.setIdleState) CTX.setIdleState(v); }
function getWin() { return CTX.getWin ? CTX.getWin() : null; }
function getVideoWin() { return CTX.getVideoWin ? CTX.getVideoWin() : null; }
function getCurrentInfo() { return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null; }
function getUseMpv() { return CTX.getUseMpv ? CTX.getUseMpv() : true; }
function getMpvBackend() { return CTX.getMpvBackend ? CTX.getMpvBackend() : null; }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getIdleState() { return CTX.getIdleState ? CTX.getIdleState() : false; }
function sendToRenderer(channel, payload) { if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload); }

/** idle 模式下窗口四角保持透明，不再填充 #idle-screen 主题色。
 *  原因：CSS border-radius 裁掉四角后露出的纯色背景（#0b0c12 / #f4f5f8）
 *  与 #idle-screen 的渐变背景有色差，会形成显眼的深/黑色三角。改为透明后
 *  四角透出桌面/后层，消除"黑底"，同时不影响 #idle-screen 自身内容。 */
function getIdleBackgroundColor() {
  return '#00000000';
}


  // ---- UI 状态 ----

  ipcMain.handle('ui:set-idle-state', (_e, idle) => {
    setIdleState(!!idle);
    const win = getWin();
    const videoWin = getVideoWin();
    if (idle && win && videoWin && !win.isDestroyed() && !videoWin.isDestroyed()) {
      if (returningFromMusic) {
        // 从音乐模式返回主页：保留当前（播放样式）窗口位置，不重置为居中首页尺寸。
        // 仍退出 PiP、保持四角透明，并与 videoWin 重同步（幂等）。
        try {
          if (getPipMode()) exitPipMode();
          try { win.setBackgroundColor(getIdleBackgroundColor()); } catch (_) {}
          resyncNow();
        } catch (err) {
          console.error('[ipc-window] 音乐返回主页保持位置失败:', err);
        }
      } else {
        // 从播放态（视频）回到主页：退出 PiP / 全屏 / 最大化，再重置为固定首页尺寸并居中
        try {
          if (getPipMode()) exitPipMode();
          if (videoWin.isFullScreen()) videoWin.setFullScreen(false);
          if (win.isFullScreen()) win.setFullScreen(false);
          if (videoWin.isMaximized()) videoWin.unmaximize();
          if (win.isMaximized()) win.unmaximize();
          const disp = screen.getDisplayNearestPoint(videoWin.getBounds());
          const { width: sw, height: sh } = disp.workAreaSize;
          const ox = disp.workArea ? disp.workArea.x : disp.bounds.x;
          const oy = disp.workArea ? disp.workArea.y : disp.bounds.y;
          const base = computeWindowSize();
          const w = Math.min(base.width, sw - IDLE_HOME_MIN_MARGIN);
          const h = Math.min(base.height, sh - IDLE_HOME_MIN_MARGIN);
          const x = Math.round(ox + (sw - w) / 2);
          const y = Math.round(oy + (sh - h) / 2);
          videoWin.setBounds({ x, y, width: w, height: h });
          resyncNow();
          // idle 落地页：窗口四角恢复透明。
          // #idle-screen 的 CSS border-radius + overflow:hidden 会裁掉四角内容，露出窗口
          // 背景；若填充纯色（#0b0c12/#f4f5f8），会与 #idle-screen 渐变背景形成色差，
          // 看起来像"圆角下面有黑底/白底"。保持透明即可消除该色块，四角透出桌面。
          try { win.setBackgroundColor(getIdleBackgroundColor()); } catch (_) {}
        } catch (err) {
          console.error('[ipc-window] 重置首页尺寸失败:', err);
        }
      }
    } else if (win && !win.isDestroyed()) {
      // 离开 idle（进入播放）：恢复极淡黑底，防止 Windows 把完全透明像素
      // 点击穿透到下层窗口（videoWin/WorkBuddy），确保视频画面能被本窗口接收交互。
      try { win.setBackgroundColor('#00000009'); } catch (_) {}
    }
    // 完成一次 idle 切换后复位「来自音乐」标记，避免影响随后的普通视频→主页过渡。
    returningFromMusic = false;
    // videoWin 保持可见，UI 层置顶，避免 show/hide 闪烁。
    // 返回主页（idle=true）继续走重同步（前面已 resyncNow 过，幂等）；
    // 进入音乐/播放（idle=false）时窗口本就对齐，传 false 跳过 setContentBounds，
    // 避免 frameless 窗口经 DWM 取整后重设触发几像素跳动。
    ensureVideoWindow(idle);
    return { ok: true };
  });

// 系统/应用主题切换时：若正处在 idle 模式，同步将窗口四角重置为透明
nativeTheme.on('updated', () => {
  const win = getWin();
  if (win && !win.isDestroyed() && getIdleState()) {
    try { win.setBackgroundColor(getIdleBackgroundColor()); } catch (_) {}
  }
});


  // ---- 窗口控制 ----
  // 原子化拖动：渲染端 titlebar 自定义 mousedown/mousemove/mouseup → 发送累积偏移 →
  // 主进程同时移动 videoWin + win（无反馈循环、无错位）
  // （已废弃：第二十四轮恢复原生 -webkit-app-region:drag，不再需要自定义拖拽 IPC）
  // ipcMain.on('window:drag-delta', ...);
  // ipcMain.on('window:drag-start', ...);
  // ipcMain.on('window:drag-end', ...);


  ipcMain.handle('window:command', (_e, { action, value }) => {
    if (!getWin() || !getVideoWin()) return { ok: false };
    switch (action) {
      case 'fullscreen':
        // 全屏针对父窗口 videoWin；集中到 setFullscreen() 处理脱离/恢复父子关系
        setFullscreen(value === undefined ? !getVideoWin().isFullScreen() : !!value);
        return { ok: true, fullscreen: getVideoWin().isFullScreen() };
      case 'ontop':
        const onTop = value === undefined ? !getVideoWin().isAlwaysOnTop() : !!value;
        getVideoWin().setAlwaysOnTop(onTop);
        getWin().setAlwaysOnTop(onTop);
        return { ok: true, ontop: getVideoWin().isAlwaysOnTop() };
      case 'focus':
        // 透明分层窗口被其他窗口遮挡时，点击可能不自动激活置顶
        //（Electron/Windows 对 WS_EX_LAYERED 窗口的已知行为）。
        // 渲染端在失焦状态收到 mousedown 时显式调用本动作。
        getVideoWin().moveTop();
        getWin().moveTop();
        getWin().focus();
        resyncNow();
        return { ok: true };
      case 'minimize': getWin().minimize(); return { ok: true };
      case 'maximize':
        if (getVideoWin().isMaximized()) getVideoWin().unmaximize(); else getVideoWin().maximize();
        resyncNow();
        return { ok: true };
      case 'close': getWin().close(); return { ok: true };
      case 'scale': {
        // 按视频原始尺寸的倍数设置窗口（操作父窗口）
        const v = getCurrentInfo() && getCurrentInfo().video[0];
        if (!v) return { ok: false };
        const s = Number(value) || 1;
        getVideoWin().setSize(Math.round(v.width * (v.sar || 1) * s), Math.round(v.height * s), true);
        resyncNow();
        return { ok: true };
      }
      default: return { ok: false, error: '未知窗口指令' };
    }
  });


  // ---- 音乐播放样式窗口位置记忆 ----
  // 每个播放样式（大封面/写真歌词/经典黑胶/简约方形/透明彩胶/简约歌词）
  // 记住自己的窗口位置（x,y,width,height），切换样式或「返回主页再进入」时恢复，
  // 避免返回主页被 ui:set-idle-state 居中后，重新进入音乐时窗口跑位。
  let currentMusicStyle = null;
  let audioActive = false;
  let returningFromMusic = false;
  let _musicSaveTimer = null;
  const MUSIC_BOUNDS_PREFIX = 'music-style-bounds-';
  function _musicBoundsKey(style) { return MUSIC_BOUNDS_PREFIX + style; }
  function _saveMusicBounds() {
    if (!audioActive || !currentMusicStyle) return;
    const vw = getVideoWin();
    if (!vw || vw.isDestroyed()) return;
    const b = vw.getBounds();
    const key = _musicBoundsKey(currentMusicStyle);
    const val = `${b.x},${b.y},${b.width},${b.height}`;
    const cfg = getConfig();
    if (cfg && cfg.set) cfg.set(key, val);
    if (CTX.writePlayerConfKey) CTX.writePlayerConfKey(key, val);
  }
  function _scheduleSaveMusicBounds() {
    if (_musicSaveTimer) clearTimeout(_musicSaveTimer);
    _musicSaveTimer = setTimeout(_saveMusicBounds, 400);
  }

  ipcMain.on('music:audio', (_e, v) => { audioActive = !!v; });

  // 从音乐模式返回主页：立即把当前位置刷进当前样式（防 400ms 防抖未触发），
  // 并标记「来自音乐」——ui:set-idle-state(idle) 据此保留窗口位置、不重置为居中首页。
  ipcMain.on('music:return-home', () => {
    _saveMusicBounds();
    // 仅当确实处于音乐播放态（audioActive && currentMusicStyle）才标记「来自音乐」：
    // 普通视频→主页时 exitAudioMode 也会触发本信号，但此时不应跳过首页居中。
    if (audioActive && currentMusicStyle) returningFromMusic = true;
  });

  ipcMain.on('music:style', (_e, style) => {
    // 切换样式：新样式直接沿用当前窗口位置（与上一个样式统一），不跳到各自记忆位置。
    // 先更新 currentMusicStyle 为「新样式」，再 _saveMusicBounds 即可把当前（上一个样式所在）位置记进新样式。
    currentMusicStyle = style || null;
    if (style) _saveMusicBounds();
  });

  // 音乐模式下拖动/缩放窗口：防抖保存当前位置到当前样式
  const _mw = getWin();
  if (_mw && !_mw.isDestroyed()) {
    _mw.on('move', _scheduleSaveMusicBounds);
    _mw.on('resize', _scheduleSaveMusicBounds);
  }

  // 软件关闭：清除各播放样式的窗口位置记忆（player.conf + 内存）。
  // 这样下次启动「首次从主页进入音乐模式」时窗口落在主页标准位置（而非上次会话的样式位置）；
  // 会话内「返回主页再进入」仍按样式位置记忆（由本模块其余逻辑处理）。
  app.on('will-quit', () => {
    if (_musicSaveTimer) { clearTimeout(_musicSaveTimer); _musicSaveTimer = null; }
    const cfg = getConfig();
    if (!cfg || !cfg.values) return;
    Object.keys(cfg.values).forEach((k) => {
      if (k.startsWith(MUSIC_BOUNDS_PREFIX)) {
        try { delete cfg.values[k]; } catch { /* ignore */ }
        if (CTX.deletePlayerConfKey) {
          try { CTX.deletePlayerConfKey(k); } catch { /* ignore */ }
        }
      }
    });
  });


  // ---- 画中画 ----

  ipcMain.handle('window:pip-toggle', () => togglePip());


  // PiP 控制浮窗：拖动
  // 用“起始 bounds + 累计偏移”而不是“当前 bounds + 增量”，
  // 避免 Windows 下反复 getBounds/setBounds 因 DPI/边框舍入导致窗口一点点变大。
  let pipDragBase = null;

  ipcMain.on('pip:drag-start', () => {
    if (!getVideoWin() || getVideoWin().isDestroyed() || !pip.getPipMode()) return;
    pipDragBase = getVideoWin().getBounds();
  });

  ipcMain.on('pip:move-by', (_e, { dx, dy }) => {
    if (!getVideoWin() || getVideoWin().isDestroyed() || !pip.getPipMode() || !pipDragBase) return;
    const x = pipDragBase.x + (dx || 0);
    const y = pipDragBase.y + (dy || 0);
    getVideoWin().setBounds({ ...pipDragBase, x, y });
    syncPipControlWin();
  });

  ipcMain.on('pip:drag-end', () => {
    pipDragBase = null;
  });


  // PiP 控制浮窗：拖拽缩放（保持宽高比）

  ipcMain.on('pip:resize', (_e, { w, h }) => {
    if (!getVideoWin() || getVideoWin().isDestroyed() || !pip.getPipMode()) return;
    const b = getVideoWin().getBounds();
    getVideoWin().setBounds({ ...b, width: w, height: h });
    syncPipControlWin();
  });


  // PiP 控制浮窗：按钮命令

  ipcMain.on('pip:command', (_e, action) => {
    if (action === 'pause') {
      if (getUseMpv() && getMpvBackend() && getMpvBackend().ready) {
        getMpvBackend().command('cycle', 'pause').catch(() => {});
      } else {
        // ffmpeg/WebGL 引擎：把命令转发给主渲染进程
        sendToRenderer('pip:command', { action: 'pause' });
      }
      // 乐观更新按钮图标
      setTimeout(() => updatePipControlState(), 80);
      return;
    }
    if (action === 'restore' || action === 'close') {
      if (pip.getPipMode()) togglePip();
      return;
    }
  });
}

module.exports = { register };
