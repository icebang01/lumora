/**
 * 双窗口管理（自包含模块）。
 * 从 index.js 拆出（2026-08）：computeWindowSize / createWindow / syncWindows /
 * resyncNow / setFullscreen / ensureVideoWindow / attachRendererDiagnostics + 窗口同步事件链。
 *
 * 用法：setCtx({ getWin, setWin, getVideoWin, setVideoWin, getConfig, getUseMpv,
 *   getCurrentInfo, getIsDev, getIsSmoke, sendToRenderer, startMpv })（bootstrap 时注入）。
 * win/videoWin 是 index.js 的顶层变量（sendToRenderer/registerIpc/mpv 代码都在用），
 * 这里读写一律走 getter/setter，保持单一事实源。
 */
const { BrowserWindow, screen, shell } = require('electron');
const path = require('path');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }

function getWin() { return CTX.getWin ? CTX.getWin() : null; }
function setWin(v) { if (CTX.setWin) CTX.setWin(v); }
function getVideoWin() { return CTX.getVideoWin ? CTX.getVideoWin() : null; }
function setVideoWin(v) { if (CTX.setVideoWin) CTX.setVideoWin(v); }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getUseMpv() { return CTX.getUseMpv ? CTX.getUseMpv() : true; }
function getCurrentInfo() { return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null; }
function getIsDev() { return CTX.getIsDev ? CTX.getIsDev() : false; }
function getIsSmoke() { return CTX.getIsSmoke ? CTX.getIsSmoke() : false; }
function sendToRenderer(channel, payload) { if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload); }
function startMpv(videoWin) { return CTX.startMpv ? CTX.startMpv(videoWin) : Promise.resolve(); }

function computeWindowSize() {
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const autofit = String(getConfig().get('autofit') || '70%');
  let ratio = 0.7;
  const m = autofit.match(/^(\d+(?:\.\d+)?)%$/);
  if (m) ratio = Math.min(Math.max(parseFloat(m[1]) / 100, 0.2), 1);
  // 默认按 16:9 起手，载入媒体后会按真实宽高比修正
  let w = Math.round(sw * ratio);
  let h = Math.round(w * 9 / 16);
  if (h > sh * ratio) { h = Math.round(sh * ratio); w = Math.round(h * 16 / 9); }
  return { width: Math.max(w, 480), height: Math.max(h, 270) };
}

function createWindow() {
  const { width, height } = computeWindowSize();
  const frameless = !getConfig().get('border');
  const useMpv = getUseMpv();

  /* ---- 视频窗口（底层）----
   * 透明、无边框的窗口，唯一作用是给 mpv 提供 --wid 的 HWND。
   * 设为透明是为了让上层 UI 窗口（CSS 圆角裁剪）圆角外的三角区能透出桌面，
   * 否则圆角处会露出不透明黑方块。mpv 在这个窗口内创建的不透明子窗口渲染视频，
   * 浮于透明底色之上，不受窗口透明影响。
   * UI 窗口在它上面，透明区域露出这个窗口里的 mpv 画面。
   */
  const videoWin = new BrowserWindow({
    width, height,
    frame: false,
    // 透明：圆角裁剪（CSS）外的三角区需透出桌面，故底层 videoWin 也必须透明，
    // 否则圆角处会露出不透明黑方块。mpv 经 --wid 渲染的不透明视频浮于其上，不受影响。
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: true, // 与 win 同步圆角（Windows 11 / macOS DWM，与本层透明互补）
    show: false,
    focusable: false,   // 永远不接收键盘焦点，避免全屏时抢走 HTML 层的按键事件
    skipTaskbar: true,  // 不在任务栏显示，只有 UI 窗口在任务栏
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  setVideoWin(videoWin);

  // 视频窗口透明：无媒体/纯音频时透出桌面（配合 UI 层圆角），mpv 渲染时视频浮于其上
  videoWin.loadURL('data:text/html,<html><body style="background:transparent;margin:0"></body></html>');
  videoWin.setMenu(null);
  // 视频窗口只承载 mpv 的 --wid 子窗口，不接收任何鼠标/滚轮事件。
  // 否则 mpv 子窗口区域会截走滚轮、双击等事件，导致：
  //  - 滚轮变成音量加减（mpv 默认绑定）而非 seek；
  //  - 双击全屏/暂停失效。
  // 所有输入统一由上层透明 UI 窗口处理。
  videoWin.setIgnoreMouseEvents(true);

  /* ---- UI 窗口（顶层）----
   * 透明、无边框，加载播放器界面。覆盖在视频窗口上方，
   * 透明区域（body 背景）让底下的 mpv 画面透过来。
   * 所有鼠标事件由这个窗口处理。
   */
  const win = new BrowserWindow({
    width, height,
    minWidth: 320, minHeight: 200,
    frame: !!getConfig().get('border'),
    // 始终透明：圆角裁剪（CSS）外的三角区需透出桌面，故 win 必须透明。
    // 即使 ffmpeg 引擎（useMpv=false）也保持透明，圆角才能生效。
    transparent: true,
    // idle 首页由 #idle-screen 这层不透明背景铺满窗口，可以完全透明；
    // 进入视频播放后由 ipc-window.js 动态设为 #00000009（极淡黑底），
    // 防止 Windows 把完全透明像素点击穿透到下层窗口（videoWin/WorkBuddy）。
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: true, // 与 videoWin 同步圆角，避免透明层露出尖角
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      webgl: true,
      // 主窗口承载 WebAudio/AudioWorklet 音频输出，必须显式声明自动播放
      // 策略。仅靠 index.js 的 commandLine switch 在某些 Electron 版本/
      // 环境下对 AudioContext 不生效；webPreferences 级设置是给该
      // WebContents 的最强声明，确保 AudioContext.resume() 无需手势。
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  setWin(win);

  win.setMenu(null);
  const indexUrl = 'file://' + path.join(__dirname, '..', 'renderer', 'index.html') + '?v=' + Date.now();
  win.loadURL(indexUrl, { extraHeaders: 'pragma: no-cache\ncache-control: no-cache\n' });

  attachRendererDiagnostics(win.webContents);

  // ════════════════════════════════════════════════════════════════
  //   窗口对齐策略：暴力同步（第 9 次尝试，最终方案）
  // ════════════════════════════════════════════════════════════════
  //
  // 历史教训（8 次失败）：
  //   轮询 / 防抖 / 安全网轮询 / 过扫描 /
  //   videoWin⊂win 父子 / win⊂videoWin 父子（show前）/
  //   win⊂videoWin 父子（show后）→ 全部失败。
  //
  // 根因总结：setParentWindow 在 Electron + Windows DWM 下不可靠，
  //   无论什么时机调用都会静默失效。放弃 OS 级父子关系。
  //
  // 最终方案：暴力同步 —— 让 win 的 bounds 始终 = videoWin 的 bounds。
  //
  //   videoWin（不透明黑底，mpv 渲染目标）
  //   win（透明 UI 层，始终覆盖在 videoWin 正上方）
  //
  // 实现手段：
  //   ① 事件驱动：videoWin 每次移动/缩放/最大化 → 立即同步 win
  //   ② 高频轮询：33ms 安全网兜底（~30fps），捕获所有遗漏事件
  //   ③ 绝对坐标：win.setBounds(videoWin.getBounds())，不用相对坐标
  //   ④ Z-order：focus/mouse-down 时两窗一起 moveTop
  //
  // 特殊场景：
  //   - 全屏：两窗独立铺满显示器
  //   - PiP：win 隐藏，videoWin 独立浮动
  // ════════════════════════════════════════════════════════════════

  // 显示窗口并启动同步
  win.once('ready-to-show', () => {
    if (useMpv) videoWin.show();
    win.show();
    // 首次对齐
    syncWindows();
    // 启动高频安全网
    startAlignSafetyNet();
    if (getConfig().get('fullscreen')) setFullscreen(true);
    if (getConfig().get('ontop')) {
      videoWin.setAlwaysOnTop(true);
      win.setAlwaysOnTop(true);
    }

    // mpv 不再随应用启动预拉起——音乐模式走 ffmpeg 管线（见 play-control.loadFile），
    // 仅首个视频文件载入时才在 loadFile 内懒启动 mpv（startMpv）。videoWin 仍在此
    // 创建并常驻（作为不透明黑底 + mpv 嵌入目标），只是里面暂时没有 mpv 进程。
  });

  win.on('closed', () => {
    setWin(null);
    if (videoWin && !videoWin.isDestroyed()) videoWin.destroy();
  });
  videoWin.on('closed', () => { setVideoWin(null); });

  // ---- 窗口同步架构（第 11 次尝试：原子拖动 + 单向 resize + 安全网）----
  //
  // 核心约束：
  //   · 用户只能抓到顶层 win（标题栏 -webkit-app-region:drag）
  //   · videoWin 永远被 win 盖住，用户无法直接操作它
  //   · 任何"win 移 → videoWin 跟 → videoWin.move 事件 → win 再移回来"的链路
  //     都会因为异步事件时序形成反馈循环，导致拖动时画面抖动/错位
  //
  // 同步策略历经 will-move / mousedown / move-storm / 纯几何判别（window-sync.js），
  // 均因该环境事件时序不可靠而弃用；最终采用下方「第三十轮·核选项：事件中只改位置」方案。

  // 窗口同步（第三十一轮——安全 setBounds：事件中写 videoWin 尺寸）：
  //   第三十轮发现：事件中只调 setPosition → 拖动时 DWM/Electron 内部篡改 videoWin 尺寸
  //   → 要等松手后 300ms settleAfterDrag 才修复 → 用户看到"拖动时慢慢放大、松手恢复"。
  //
  //   关键洞察：之前的振荡回环全因"写 win 尺寸→触发 win.on('resize')→再写"形成反馈。
  //   但 videoWin 零监听器 → 写 videoWin.setBounds() 是死路 → 零反馈 → 完全安全！
  //
  //   故策略升级：resize/move handler 中每次都 videoWin.setBounds({x,y,width,height})，
  //   同时同步位置+尺寸。任何帧内漂移都在同帧修正 → 肉眼不可见。
  //   settleAfterDrag 仍保留作松手后最终精修（覆盖极端 DWM 延迟场景）。

  let _dragSettleTimer = null;

  // 最小化恢复状态在模块级声明（_savedWinBounds/_savedVideoBounds 等），
  // 供 createWindow（minimize 时保存）与 _scheduleRestoreRefresh（恢复时纠正）
  // 共享。注意：绝不能在这里重复声明同名变量，否则会遮蔽模块级变量
  // 导致恢复逻辑读到 undefined（第 5 轮已踩坑，被 try/catch 静默吞掉）。

  function settleAfterDrag() {
    _dragSettleTimer = null;
    if (!videoWin || videoWin.isDestroyed() || !win || win.isDestroyed()) return;
    if (videoWin.isFullScreen()) return;
    try {
      const wcb = win.getContentBounds();
      // 仅在非拖动状态下才对齐尺寸（避免伪 resize 干扰）
      videoWin.setBounds({
        x: wcb.x + 1,
        y: wcb.y + 1,
        width: Math.max(320, wcb.width - 2),
        height: Math.max(200, wcb.height - 2),
      });
    } catch {}
  }

  // resize：跟随位置 + 立即校准尺寸。
  //   只写 videoWin（从窗），绝不写 win（主窗）→ 零回环可能（videoWin 无任何事件监听器）。
  win.on('resize', () => {
    if (_savedWinBounds) return; // 恢复纠正期跳过
    if (!videoWin || videoWin.isDestroyed()) return;
    if (videoWin.isFullScreen()) return;
    try {
      const wcb = win.getContentBounds();
      const vw = Math.max(320, wcb.width - 2);
      const vh = Math.max(200, wcb.height - 2);
      videoWin.setBounds({ x: wcb.x + 1, y: wcb.y + 1, width: vw, height: vh });
    } catch {}
  });

  // move：跟随位置 + 立即校准尺寸（同上，只写 videoWin）。
  //   settleAfterDrag 仍保留作为松手后的最终精修（覆盖极端 DWM 延迟场景）。
  win.on('move', () => {
    if (_savedWinBounds) return; // 恢复纠正期跳过
    if (!videoWin || videoWin.isDestroyed() || !win || win.isDestroyed()) return;
    if (videoWin.isFullScreen()) return;
    try {
      const wcb = win.getContentBounds();
      const vw = Math.max(320, wcb.width - 2);
      const vh = Math.max(200, wcb.height - 2);
      videoWin.setBounds({ x: wcb.x + 1, y: wcb.y + 1, width: vw, height: vh });
    } catch {}
    // 松手后最终精修（300ms 无 move = 拖动结束）
    if (_dragSettleTimer) clearTimeout(_dragSettleTimer);
    _dragSettleTimer = setTimeout(settleAfterDrag, 300);
  });

  // 全屏由 setFullscreen() 集中处理（见下方），不监听 win 的 enter/leave-full-screen。

  // Z-order：点击/focus 时把两窗一起拉到最前并激活
  // （Electron/Windows 对透明 WS_EX_LAYERED 窗口的已知行为：
  //   moveTop() 只改 z-order 不激活窗口，必须额外 focus() 才能浮到最前）
  win.on('focus', () => {
    if (videoWin && !videoWin.isDestroyed() && videoWin.isVisible()) {
      videoWin.moveTop();
      win.moveTop();
    }
  });
  win.webContents.on('mouse-down', () => {
    // 无论 videoWin 是否可见，UI 窗口都应置顶：透明窗口点击穿透场景下，
    // 这是渲染端 bindClickToFront 之外的主进程侧兜底（纯音频/idle 态也生效）。
    if (videoWin && !videoWin.isDestroyed() && videoWin.isVisible()) {
      try { videoWin.moveTop(); } catch {}
    }
    try { win.moveTop(); win.focus(); } catch {}
  });

  // 最小化/恢复：联动 videoWin + 保存位置 + 恢复纠正 + 强制重绘
  //
  // 第十轮根因（最关键的一轮）：
  //   用户反馈"只有拖动标题栏画面才出现"——拖动标题栏 → win.on('move')
  //   → videoWin.setBounds() —— 几何一变，内部 mpv 子窗口收到 WM_SIZE 才会
  //   重新 Present 画面。而恢复逻辑在 bounds 已匹配保存值时**跳过了 setBounds**，
  //   于是 mpv 永远拿不到重绘信号 → 画面不显示。Z-order（第九轮 moveTop）治标不治本。
  //
  //   修复 = 恢复时**主动对 videoWin 做一次 1px 来回 jiggle**，强制触发 WM_SIZE →
  //   mpv 重绘，复刻"拖动标题栏救活画面"的效果，无需用户手动拖拽。
  //
  //   另外：底层 videoWin 改用 hide()/showInactive() 而非 minimize()/restore()，
  //   避免 DWM 最小化动画在恢复时从任务栏缩略图位置（左上角）闪一下再消失。
  //
  // 其余修复（第七轮，带重试的保存/恢复方案）：
  //   ① GPU 不重绘 → invalidate()（黑屏）
  //   ② 渲染端状态冻住 → window:restored（idle 残留）
  //   ③ 恢复后位置错乱（跳到左上角/最小尺寸）→ 保存/恢复 bounds + 重试断言
  //
  win.on('minimize', () => {
    // 最小化生效前立即保存位置（此刻 getBounds() 一定正确）
    try {
      if (win && !win.isDestroyed()) _savedWinBounds = win.getBounds();
      if (videoWin && !videoWin.isDestroyed()) _savedVideoBounds = videoWin.getBounds();
      console.log('[lumen][restore] 最小化，已保存位置', JSON.stringify(_savedWinBounds));
    } catch {}
    // 隐藏底层 videoWin（不用 minimize）：规避 DWM 最小化恢复动画从左上角闪现。
    if (videoWin && !videoWin.isDestroyed()) {
      try { videoWin.hide(); } catch {}
    }
  });
  win.on('restore', () => {
    if (videoWin && !videoWin.isDestroyed() && !videoWin.isVisible()) {
      try { videoWin.showInactive(); } catch {}
    }
    _scheduleRestoreRefresh();
  });
  win.on('show', () => {
    if (videoWin && !videoWin.isDestroyed() && !videoWin.isVisible()) {
      try { videoWin.showInactive(); } catch {}
    }
    _scheduleRestoreRefresh();
  });

  // 拦截外链
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 启动高频安全网轮询
  startAlignSafetyNet();
}

/**
 * 建立/恢复 win ⊂ videoWin 父子关系。
 *
 * 前置条件：两个窗口都必须已 show()（HWND 存在）。
 * 在以下场景调用：
 *   - 首次启动（ready-to-show 中）
 *   - 退出全屏后
 *   - 退出 PiP 后
 */
// （已废弃：setParentWindow 不可靠，改用暴力同步。保留此注释作为历史记录）

/**
 * 暴力同步：让 win 的内容区完全覆盖 videoWin。
 *
 * 关键细节（这是前 9 次失败的真正根因）：
 *   - videoWin: frame:false → getBounds() == 内容区（无标题栏）
 *   - win:       frame:!!border → getBounds() 包含标题栏！
 *   如果用 setBounds() 同步，win 的内容区会比 videoWin 小一个标题栏高度。
 *
 * 解决：对 win 使用 setContentBounds()，让它的内容区 = videoWin 的外部边界。
 */
function syncWindows() {
  if (!getVideoWin() || !getWin() || getVideoWin().isDestroyed() || getWin().isDestroyed()) return;
  const videoWin = getVideoWin();
  const win = getWin();
  const fs = videoWin.isFullScreen();
  if (fs) {
    // 全屏：两窗都铺满显示器
    const disp = screen.getDisplayNearestPoint(videoWin.getBounds());
    // 全屏时 win 也应铺满显示器；用 setBounds 因为全屏时无标题栏差异
    try { win.setBounds(disp.bounds); } catch {}
    return;
  }
  // 非全屏：win 的内容区 = videoWin 的外部边界 + 1px 过扫描（应对 DWM 子像素舍入）
  const vb = videoWin.getBounds();
  const target = { x: vb.x - 1, y: vb.y - 1, width: vb.width + 2, height: vb.height + 2 };
  // 容差守卫：若 UI 窗口已与 videoWin 对齐（容差 2px，覆盖 DWM 子像素取整），
  // 跳过 setContentBounds。否则 frameless 窗口重复重设会触发几像素跳动——在
  // "进入音乐/返回主页"等窗口本就对齐、只是冗余重同步的过渡中尤为明显。
  const cur = win.getContentBounds();
  const aligned =
    Math.abs(cur.x - target.x) <= 2 && Math.abs(cur.y - target.y) <= 2 &&
    Math.abs(cur.width - target.width) <= 2 && Math.abs(cur.height - target.height) <= 2;
  if (aligned) return;
  try {
    win.setContentBounds(target);
  } catch (e) {
    console.warn('[lumen] syncWindows setContentBounds 失败:', e.message);
    try { win.setBounds(vb); } catch {}
  }
}

/**
 * 反向同步：videoWin 跟随 win。
 *
 * 用户拖动的是顶层 win（标题栏 -webkit-app-region:drag），拖动 win 后必须让底层
 * videoWin 跟上，否则 OSC/标题栏会与画面脱节，看起来像 OSC 被"独立拖动"。
 *
 * 关系：win 的内容区 = videoWin + 1px 过扫描，故 videoWin = win 内容区 − 过扫描。
 * 用 _syncing 守卫避免与 syncWindows 互相触发形成回环。
 */
let _syncing = false; // 已废弃
function followVideoToWin() { /* 已废弃 */ }

/**
 * 窗口同步（第二十四轮——彻底简化）：
 *   ① 原生 -webkit-app-region:drag 拖动 win（Windows DWM 直接处理）
 *   ② win.on('resize') → 单向移动 videoWin（无回环）
 *   ③ win.on('move') + 防抖 → 拖动结束后一次性对齐
 *   ④ 安全网 2000ms 轮询（仅修正 DPI/多显示器等极端漂移）
 */

/**
 * 安全网——已禁用（第二十五轮）。
 *
 * 历史上 33ms/2000ms 轮询调用 syncWindows() 都是振荡源头：
 *   syncWindows 改 win 尺寸 → 触发 win.on('resize') → 改 videoWin
 *   → move handler / 下一轮 poll 又调 syncWindows() → 无限循环
 *
 * 正确做法：事件处理器严格单向（只改 videoWin），不需要任何轮询修正。
 * DPI 切换/多显示器等极端场景由用户手动拖一下窗口即可恢复。
 */
let _alignSafetyNet = null;
function startAlignSafetyNet() {
  // 已禁用：不再启动任何轮询。保留函数签名避免调用方报错。
}
function stopAlignSafetyNet() { /* no-op */ }

// ── 最小化恢复状态（模块级，createWindow 与 _scheduleRestoreRefresh 共享）──
// 第 5 轮失败教训：变量曾声明在 createWindow 函数内部，模块级函数引用时
// ReferenceError 被 try/catch 静默吞掉 → 恢复逻辑从未真正执行 → "完全没变化"。
let _savedWinBounds = null;    // 最小化前保存的 win 位置（恢复纠正用）
let _savedVideoBounds = null;  // 最小化前保存的 videoWin 位置
let _restoreRetries = 0;       // bounds 纠正重试计数
let _restoreRefreshTimer = null; // 恢复刷新防抖定时器
let _restoreRepaintDone = false; // 恢复后是否已强制 videoWin 重绘（mpv 必需）
let _restorePostNudgeTimer = null; // 延迟兜底 nudge 定时器

// 版本标记：启动时打印，确认最小化恢复修复已生效（第 13 轮：nudge 去 jiggle 消闪）
console.log('[lumen][restore] windows.js 恢复逻辑 v13（move-handler nudge + focus，无 jiggle 不闪）已加载');

/**
 * 最小化恢复后刷新（第 7 轮——带重试的保存/恢复方案）。
 *
 * 修复的三个问题：
 *   ① GPU 不重绘 → invalidate()（黑屏）
 *   ② 渲染端状态冻住 → window:restored（idle 残留）
 *   ③ 恢复后位置错乱（左上角/最小尺寸）→ 保存/恢复 bounds + 重试断言
 *
 * 为什么需要重试：
 *   DWM 的窗口恢复动画持续 ~200-500ms。只 setBounds 一次会被动画覆盖
 *   （第 5 轮已踩坑）。本轮每 200ms 对比实际位置与保存值，不一致就
 *   再 setBounds，直到位置稳定（最多 6 次 ≈ 1.2s，覆盖动画全程）。
 *
 * 期间 _savedWinBounds 非空 → resize/move handler 跳过（避免写入动画中间值）。
 */
function _scheduleRestoreRefresh() {
  if (_restoreRefreshTimer) return; // 防抖
  _restoreRefreshTimer = setTimeout(_restoreAttempt, 80);
}

function _restoreAttempt() {
  _restoreRefreshTimer = null;
  try {
    const w = getWin();
    const vw = getVideoWin();
    if (!w || w.isDestroyed()) { _clearSavedBounds(); return; }

    // ① GPU 重绘 + ② 渲染端状态刷新（每次尝试都做，幂等无害）
    if (w.webContents) {
      try { w.webContents.invalidate(); } catch {}
    }
    try { sendToRenderer('window:restored', {}); } catch {}

    // 确保底层 videoWin 可见
    if (vw && !vw.isDestroyed()) {
      if (vw.isMinimized()) { try { vw.restore(); } catch {} }
      else if (!vw.isVisible()) { try { vw.showInactive(); } catch {} }
    }

    // ③ 独立检查并纠正两窗位置
    const winOk = _fixWinBounds(w, _savedWinBounds || _savedVideoBounds);
    const vwOk = _fixVideoBounds(vw, _savedVideoBounds || _savedWinBounds);

    // ④ Z-order 提升
    if (vw && !vw.isDestroyed() && vw.isVisible()) {
      try { vw.moveTop(); } catch {}
    }
    if (w && !w.isDestroyed()) {
      try { w.moveTop(); } catch {}
    }

    // ⑤ （第十三轮移除 jiggle）重绘改由下方 nudge 的几何变化触发，避免 jiggle
    //    的"放大→延迟还原"与 nudge 在 60ms 处冲突导致 videoWin 坐标跳变闪烁。

    // 重试条件：仅看 bounds 是否稳定
    const needRetry = (!winOk || !vwOk) && _restoreRetries < 8;
    if (needRetry) {
      _restoreRetries++;
      console.log(`[lumen][restore] 纠正 #${_restoreRetries}：win=${winOk ? 'OK' : '修复'} videoWin=${vwOk ? 'OK' : '修复'}`);
      _restoreRefreshTimer = setTimeout(_restoreAttempt, 200);
      return;
    }

    // ════════════════════════════════════════════════════════════════
    // ⑥ 第十二轮关键修复：复刻"拖动标题栏救活画面"的完整效果
    // ════════════════════════════════════════════════════════════════
    //
    // 前 11 轮全部失败的根本原因：
    //   我们一直用"保存的旧 bounds"写 videoWin，数值上正确但无法激活画面。
    //   用户拖动标题栏时，move handler 用的是另一套公式：
    //     videoWin.setBounds({ x: win.getContentBounds().x + 1,
    //                         y: win.getContentBounds().y + 1,
    //                         width: contentWidth - 2,
    //                         height: contentHeight - 2 })
    //   这套公式（getContentBounds + 偏移）才是真正让 DWM/mpv 恢复正常的钥匙。
    //   可能原因：getContentBounds 返回的是"含标题栏的内容区坐标"，与 getBounds()
    //   （外部边界）相差一个标题栏高度；这个差异导致的 setBounds 恰好触发了
    //   DWM 对 skipTaskbar 子窗口的重新合成，或 mpv 对父 HWND 变化的响应。
    //
    //   同时调用 win.focus() 激活窗口（= 用户点击标题栏的效果），触发 focus handler
    //   中的二次 moveTop。最后再延迟一次确保 DWM 动画彻底结束后仍有效。
    //
    //   第十三轮补充：本 nudge 的 setBounds 本身就是一次真实几何变化，已足以触发
    //   mpv WM_SIZE 重绘；因此移除了原先独立的 +2px jiggle（其"放大→延迟还原"会与
    //   本 nudge 在 60ms 处冲突，导致 videoWin 在 保存坐标↔getContentBounds坐标
    //   间跳变，即用户报告的"闪一下"）。单次 nudge 既修画面又不闪。
    // ════════════════════════════════════════════════════════════════
    _clearSavedBounds(); // 先释放守卫（让后续逻辑不受 _savedWinBounds 拦截）

    // 用 move handler 的完全相同公式写 videoWin（这是拖动能救活的本质）
    _nudgeVideoWinLikeMoveHandler();
    _restoreRepaintDone = true; // nudge 已提供几何变化 → 标记重绘完成

    // 激活窗口（= 用户点击标题栏的效果，触发 focus→moveTop 链路）
    try { w.focus(); } catch {}

    // 延迟再推一次：DWM 恢复动画可能持续 >1.6s，最后一次兜底
    if (_restorePostNudgeTimer) clearTimeout(_restorePostNudgeTimer);
    _restorePostNudgeTimer = setTimeout(() => {
      _restorePostNudgeTimer = null;
      _nudgeVideoWinLikeMoveHandler();
      const w2 = getWin();
      if (w2 && !w2.isDestroyed()) try { w2.focus(); } catch {}
      console.log('[lumen][restore] 延迟兜底 nudge 已执行');
    }, 500);
  } catch {
    _clearSavedBounds();
  }
}

/** 用与 win.on('move') handler 完全相同的公式写 videoWin bounds */
function _nudgeVideoWinLikeMoveHandler() {
  const w = getWin();
  const vw = getVideoWin();
  if (!w || w.isDestroyed() || !vw || vw.isDestroyed() || !vw.isVisible() || vw.isMinimized()) return;
  if (vw.isFullScreen()) return;
  try {
    const wcb = w.getContentBounds();
    const fvw = Math.max(320, wcb.width - 2);
    const fvh = Math.max(200, wcb.height - 2);
    vw.setBounds({ x: wcb.x + 1, y: wcb.y + 1, width: fvw, height: fvh });
  } catch {}
}

/** 检查并纠正 win 的位置；返回 true 表示已符合保存值 */
function _fixWinBounds(w, saved) {
  if (!w || w.isDestroyed() || w.isMinimized() || w.isFullScreen() || !saved) return true;
  try {
    const b = w.getBounds();
    if (b.x === saved.x && b.y === saved.y && b.width === saved.width && b.height === saved.height) return true;
    w.setBounds({ x: saved.x, y: saved.y, width: saved.width, height: saved.height });
  } catch {}
  return false;
}

/** 检查并纠正 videoWin 的位置；返回 true 表示已符合保存值 */
function _fixVideoBounds(vw, saved) {
  if (!vw || vw.isDestroyed() || vw.isFullScreen() || !saved) return true;
  // videoWin 仍处于最小化 → 先恢复（skipTaskbar 窗口的 restore 可能不自动发生）
  if (vw.isMinimized()) {
    try { vw.restore(); } catch {}
    return false; // 等下一轮再检查实际位置
  }
  try {
    const b = vw.getBounds();
    if (b.x === saved.x && b.y === saved.y && b.width === saved.width && b.height === saved.height) return true;
    vw.setBounds({ x: saved.x, y: saved.y, width: saved.width, height: saved.height });
  } catch {}
  return false;
}

function _clearSavedBounds() {
  _savedWinBounds = null;
  _savedVideoBounds = null;
  _restoreRetries = 0;
  _restoreRepaintDone = false;
  if (_restorePostNudgeTimer) { clearTimeout(_restorePostNudgeTimer); _restorePostNudgeTimer = null; }
}

/**
 * 立即同步一次（仅用于程序化操作：全屏/PiP/初始定位等）。
 * 不再启动安全网。
 */
function resyncNow() {
  syncWindows();
}

/**
 * 切换全屏。
 *
 * 进入全屏：videoWin 走 OS 全屏（mpv 独占），win 铺满同一显示器覆盖其上。
 * 退出全屏：videoWin 退出 OS 全屏，win 回到暴力同步模式跟随 videoWin。
 */
function setFullscreen(fs) {
  const videoWin = getVideoWin();
  const win = getWin();
  if (!videoWin || videoWin.isDestroyed() || !win || win.isDestroyed()) return;
  if (fs) {
    videoWin.setFullScreen(true);
    const disp = screen.getDisplayNearestPoint(videoWin.getBounds());
    win.setBounds(disp.bounds);
    resyncNow();
    sendToRenderer('window:state', { fullscreen: true });
  } else {
    videoWin.setFullScreen(false);
    // 退出全屏后回到暴力同步模式
    syncWindows();
    resyncNow();
    sendToRenderer('window:state', { fullscreen: false });
  }
  if (win && !win.isDestroyed()) win.focus();
}

/**
 * 保持底层视频窗口可见并与 UI 窗口对齐。
 * 之前 idle 时隐藏 videoWin，但 Windows 上每次 show/hide 都会扰动 z-order，
 * 导致开始播放时 UI 窗口被底层黑窗盖住、出现"界面消失一下"的闪烁。
 * 现在 videoWin 启动后一直保持可见：idle 落地页本身不透明，不会露出黑底；
 * 播放时直接让 mpv 在上面渲染，无需再 show。
 */
/**
 * 保持底层视频窗口可见并置顶 UI 窗口。
 * @param {boolean} [resync=true] 是否重同步两窗几何。进入 music/playback（idle=false）
 *   时窗口本就与 videoWin 对齐，无需再 setContentBounds 一次——frameless 窗口经 DWM
 *   子像素取整后重设会触发几像素跳动，故此处传 false 跳过。返回主页（idle=true）时
 *   前面已显式 resyncNow() 过，也走 false；其他需要强制对齐的场景用默认 true。
 */
function ensureVideoWindow(resync = true) {
  const videoWin = getVideoWin();
  const win = getWin();
  if (!videoWin || videoWin.isDestroyed() || !win || win.isDestroyed()) return;
  if (resync) resyncNow();
  if (!videoWin.isVisible()) {
    // showInactive 不抢焦点，且减少 z-order 扰动
    videoWin.showInactive();
  }
  // UI 窗口必须始终在最上层，否则标题栏 / OSC 会被底层视频窗口盖住
  win.moveTop();
}

/**
 * 把渲染进程的日志和异常状况转发到主进程 stdout。
 *
 * 没有 DevTools 的时候渲染端是个黑盒 —— 白屏了也不知道是着色器编译失败
 * 还是 preload 没起来。转发之后命令行就能直接看到原因。
 * 常规模式只放行 warn/error，避免刷屏；--dev 下全量。
 */
function attachRendererDiagnostics(wc) {
  wc.on('console-message', (...a) => {
    let level, message, line, source;
    if (a[0] && typeof a[0] === 'object' && 'message' in a[0]) {
      // Electron 35+ 改成了事件对象，level 是字符串
      ({ level, message, lineNumber: line, sourceId: source } = a[0]);
    } else {
      [, level, message, line, source] = a; // 旧签名：level 是 0..3
    }
    const name = typeof level === 'string' ? level : ['debug', 'log', 'warning', 'error'][level] || 'log';
    const severe = name === 'error' || name === 'warning';
    if (!getIsDev() && !getIsSmoke() && !severe) return;
    const where = source ? ` (${String(source).split(/[\\/]/).pop()}:${line})` : '';
    try {
      console.log(`[renderer:${name}] ${message}${where}`);
    } catch (err) {
      // 父进程 pipe 已关闭时忽略 EPIPE，其他错误也不要因此崩主进程
      if (err && err.code !== 'EPIPE') {
        try { process.stderr.write('[main] renderer console log failed: ' + (err && err.message) + '\n'); } catch {}
      }
    }
  });

  wc.on('preload-error', (_e, file, err) => {
    console.error('[preload] 加载失败:', file, err && err.message);
  });

  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] 页面加载失败 ${code} ${desc} ${url}`);
  });

  wc.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 进程消失:', details.reason, details.exitCode);
  });

  wc.on('unresponsive', () => console.error('[renderer] 无响应'));
}

module.exports = {
  setCtx,
  createWindow,
  computeWindowSize,
  syncWindows,
  resyncNow,
  setFullscreen,
  ensureVideoWindow,
  attachRendererDiagnostics,
};
