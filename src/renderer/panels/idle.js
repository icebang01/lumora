/**
 * idle 落地页 / 加载遮罩 / 继续观看卡片 / 最近播放(自包含模块)。
 * 从 app.js 拆出(2026-08):setIdleMode/showLoadingScreen/续播卡片/最近播放/首页按钮绑定。
 * 用法:setupIdlePanel({ player, osd });(boot 时注入)
 */
import { closePlaylistPanel, togglePlaylistPanel, requestThumbnail } from './playlist.js';

const $ = (id) => document.getElementById(id);

let CTX = {};
export function setupIdlePanel(ctx) { CTX = ctx || {}; }
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a), clearCenter: (...a) => CTX.osd && CTX.osd.clearCenter(...a) };

// 媒体库海报墙的数据访问（由 app.js 经 setupIdlePanel 注入，引用语义保持同步）。
// 经 getPlaylist() 动态取「当前模式」列表（视频 / 音乐 各自独立，随模式切换跟随）。
const _playlist = new Proxy([], {
  get(_, k) {
    const arr = CTX.getPlaylist ? CTX.getPlaylist() : null;
    if (!arr) return undefined;
    const v = arr[k];
    return typeof v === 'function' ? v.bind(arr) : v;
  },
});
function getPlaylistIndex() { return CTX.getPlaylistIndex ? CTX.getPlaylistIndex() : -1; }
function playlistGoto(i) { if (CTX.playlistGoto) CTX.playlistGoto(i); }
function baseName(p) { return String(p).split(/[\\/]/).pop(); }

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|wma|ogg|opus|ac3|dts|eac3|mka|ape|tta|tak|alac|wv)$/i;
function isAudioPath(p) { return AUDIO_EXT.test(String(p || '')); }

// 从文件名粗略提取分辨率标签（免费、即时，覆盖绝大多数命名规范），供海报 badge
const RES_4K = /\b(4k|2160p|uhd)\b/i;
const RES_P = /\b(\d{3,4})[pP]\b/;
function parseResolution(name) {
  if (RES_4K.test(name)) return '4K';
  const m = name.match(RES_P);
  if (m) return m[1] + 'P';
  return null;
}

// 秒数 → m:ss / h:mm:ss（海报时长 badge 用）
function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 海报时长 badge 懒加载：仅探测进入视口的视频/音频，内存缓存由主进程负责
let _metaObserver = null;
function _ensureMetaObserver() {
  if (_metaObserver || !('IntersectionObserver' in window)) return _metaObserver;
  _metaObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const el = entry.target;
        _metaObserver.unobserve(el);
        _fetchMediaMeta(el._metaPath, el._metaDurEl);
      }
    }
  }, { root: null, rootMargin: '200px 0px' });
  return _metaObserver;
}
function _fetchMediaMeta(p, durEl) {
  if (!p || !durEl || durEl.dataset.loaded === '1') return;
  durEl.dataset.loaded = '1';
  const done = (txt) => { durEl.textContent = txt || ''; };
  if (!window.lumen || !window.lumen.getMediaMeta) { done(''); return; }
  window.lumen.getMediaMeta({ path: p }).then((r) => {
    done(r && r.ok && r.duration ? fmtDuration(r.duration) : '');
  }).catch(() => done(''));
}

// —— B4: 海报墙长列表滚动条稳定 ——
// content-visibility:auto 让离屏海报用 CSS 占位高度（contain-intrinsic-size 估计值 ~150px），
// 而真实海报因「统一列宽 + 16:9 缩略图 + 绝对定位的 meta/badge」高度完全确定（≈列宽×9/16）。
// 占位与真实不一致 → 滚动时「估算高度 ↔ 真实高度」切换 → 滚动条跳动。
// 解法：首屏海报真实渲染后量出统一高度，回填到所有海报/添加卡的 contain-intrinsic-size，
// 未在视口的海报也用真实高度占位 → 滚动条全程稳定；窗口缩放导致列宽变化时防抖重测。
let _posterResizeBound = false;
let _posterResizeTimer = null;
function _syncPosterIntrinsicHeight() {
  const grid = $('library-grid');
  if (!grid) return;
  // 取任意一张可见海报/添加卡作为参考（统一列宽 → 高度一致）
  const ref = grid.querySelector('.poster:not(.hidden), .poster-add');
  if (!ref) return;
  const h = Math.round(ref.getBoundingClientRect().height);
  if (h <= 0) return;
  grid.querySelectorAll('.poster, .poster-add').forEach((el) => {
    if (el.classList.contains('hidden')) return; // 被 tab/搜索过滤隐藏的无需回填
    el.style.containIntrinsicSize = `auto ${h}px`;
  });
}
function _schedulePosterHeightSync() {
  // 双 rAF：等布局稳定（高度由 aspect-ratio 决定，无需等缩略图加载）
  requestAnimationFrame(() => requestAnimationFrame(_syncPosterIntrinsicHeight));
}
function _bindPosterResizeSync() {
  if (_posterResizeBound || typeof window === 'undefined') return;
  _posterResizeBound = true;
  window.addEventListener('resize', () => {
    if (_posterResizeTimer) clearTimeout(_posterResizeTimer);
    _posterResizeTimer = setTimeout(_syncPosterIntrinsicHeight, 120);
  });
}

// 海报墙筛选状态（tab + 搜索）
let libFilter = 'all';
let libQuery = '';

let idleFadeTimer = null;      // 避免快速进出 idle 时旧定时器把 idle 屏重新隐藏

// —— 加载遮罩/首帧等待状态(与 app.js 共享,经导出函数访问) ——
let loadingFirstFramePending = false; // 加载遮罩是否在等首帧（true 时遮罩不撤）
let firstFrameWaitStart = 0;    // beginFirstFrameWait 时刻，用于保证遮罩最短展示时长
let loadingScreenShownAt = 0;   // showLoadingScreen 时刻（绝对锚点：遮罩至少展示这么久）
let loadingSafetyTimer = null;  // 首帧迟迟不来时的兜底撤遮罩定时器（长超时）
let firstFrameDelayTimer = null; // 闸门齐备后排定的撤遮罩定时器
const FIRST_FRAME_MIN_MS = 900;  // beginFirstFrameWait 后最短等待（覆盖 VO 预热 + 首帧解码）
const FIRST_FRAME_GRACE_MS = 350; // 闸门齐备后再留的余量（DWM 合成延迟）
const LOADING_ANCHOR_MS = 1200;  // 从 showLoadingScreen 起的绝对最短展示时长（信号再快也不提前撤）

// —— mpv VO 重配置（vo-reconfig）跟踪，用于彻底消除“首帧前闪一下黑” ——
// 根因：视频窗口在 loadFile 前已被 applyAspectRatio 同步 resize（nudge），
//   但 Windows DWM 的缩放动画会持续 ~200-500ms，期间 mpv 内嵌子窗口反复收到
//   WM_SIZE → 多次 vo-reconfig，最后一次收敛到最终尺寸往往晚于“首帧呈现”。
//   若遮罩在最后一次 vo-reconfig 之前就淡出，用户就会看到那一帧延迟黑。
// 解法：遮罩撤下必须等到“末次 vo-reconfig 之后再静默 VO_RECONFIG_QUIET_MS”，
//   这期间若有新的 reconfig（动画拖尾）会重置静默计时，确保盖住整段动画。
// ffmpeg 引擎不经过 mpv，永远不会收到 vo-reconfig，用 frameWatchdog 兜底直接撤。
let voReconfigSeen = false;     // 本次加载是否已收到过 vo-reconfig
let voReconfigSettled = false;  // 末次 vo-reconfig 后已静默足够久（可撤遮罩）
let voReconfigQuietTimer = null;   // 末次 vo-reconfig 后的静默期定时器
const VO_RECONFIG_QUIET_MS = 1100; // 末次重配置后静默时长（覆盖 DWM 动画拖尾 + GPU 合成）

// —— 真实“帧画到 VO”信号（video-out-params 配置完成）——
// vo-reconfig 只表明窗口/输出尺寸变了，并不直接等于“首帧已呈现”；而 video-out-params
// 在 mpv 真正把一帧输出到 VO 时下发，是确定性的“帧已上屏”信号。双引擎引入后，
// 仅靠 vo-reconfig 计时 + time-pos 的撤遮罩时机被扰动、会早于真实首帧，故改为：
// 遮罩撤下必须同时满足“播放时钟已走（time-pos>0）”+“帧已输出（videoFrameReady）”
// +“（若有）VO 尺寸已稳定（voReconfigSettled）”。frameWatchdog 是最后兜底，
// 防止任一信号漏接导致遮罩卡死。
let videoFrameReady = false;    // 本次加载 mpv 是否已真正输出过一帧
let frameWatchdog = null;       // time-pos>0 后若迟迟无 vo-reconfig/帧信号，超时兜底撤遮罩
let frameWatchdogFired = false; // 兜底已触发（允许在缺信号时撤遮罩）
let _lastTimePos = 0;           // 最近一次 time-pos（供静默期到点后补撤）
const FRAME_WATCHDOG_MS = 2800; // time-pos>0 后等待 vo-reconfig/帧信号的最长时限（冷启动 GPU 更慢）

/** time-pos 推进回调：首帧缓冲逻辑（mpv 在 file-loaded 后会先报一次 time-pos=0，
 *  必须等 v>0 且遮罩展示足 FIRST_FRAME_MIN_MS 才撤，避免露出纯黑底） */
export function notifyFirstFrame(v) {
  if (loadingFirstFramePending && typeof v === 'number' && isFinite(v) && v > 0) {
    _lastTimePos = v;
    // 尚无任何“帧已输出 / VO 已稳定”信号：可能是 ffmpeg 引擎（无 vo-reconfig、
    // 也无 video-out-params），或 mpv 首帧尚未配置输出。启动兜底看门狗，超时后
    // 直接允许撤遮罩，避免遮罩永久卡住。注意：vo-reconfig 到达时【不】清此看门狗
    // （见 markVoReconfig）——否则 mpv 收到 reconfig 但 video-out-params 迟迟不来时，
    // 看门狗被清、又没有帧信号，遮罩会卡到 8s 长超时。
    if (!voReconfigSeen && !videoFrameReady && !frameWatchdog) {
      frameWatchdog = setTimeout(() => {
        frameWatchdog = null;
        frameWatchdogFired = true;
        tryScheduleFade();
      }, FRAME_WATCHDOG_MS);
    }
    // 帧已输出：立即尝试排定撤遮罩（vo-reconfig 静默与最短时长由 tryScheduleFade 把关）
    if (videoFrameReady) tryScheduleFade();
  }
}

/** mpv VO 重配置事件（窗口缩放 / 载入新文件都会触发一次或多次） */
export function markVoReconfig() {
  voReconfigSeen = true;
  if (voReconfigQuietTimer) clearTimeout(voReconfigQuietTimer);
  // 末次重配置后静默 VO_RECONFIG_QUIET_MS：期间若还有 reconfig（动画拖尾）会重置本定时器，
  // 确保遮罩等到“最后一次 reconfig 真正稳定”之后再撤。
  // 注意：此处【不】清 frameWatchdog——它作为“帧信号漏接”的最终兜底，避免遮罩卡死。
  voReconfigQuietTimer = setTimeout(() => {
    voReconfigQuietTimer = null;
    voReconfigSettled = true;
    tryScheduleFade();
  }, VO_RECONFIG_QUIET_MS);
}

/** mpv 真正把一帧输出到 VO（video-out-params 配置完成）：确定性“帧已上屏”信号。 */
export function markVideoFrame() {
  videoFrameReady = true;
  // 若 vo-reconfig 尚未收敛（DWM 缩放动画拖尾），tryScheduleFade 会等其静默后再撤；
  // 若从未收到 vo-reconfig（同尺寸重载 / ffmpeg），则无需等，直接按帧信号撤。
  tryScheduleFade();
}

/** 实际排定撤遮罩（三重闸门 + 绝对锚点）。
 *  闸门：①播放时钟已走（_lastTimePos>0）；②帧已输出(videoFrameReady)或兜底已触发(frameWatchdogFired)；
 *       ③若有 vo-reconfig，必须已收敛静默。
 *  锚点：从 showLoadingScreen 起至少 LOADING_ANCHOR_MS（1200ms），信号再快也不提前撤。
 *  三者齐备 + 锚点满足 → 排定撤遮罩（再留 FIRST_FRAME_GRACE_MS 余量）。 */
function tryScheduleFade() {
  if (loadingFirstFramePending && _lastTimePos > 0 &&
      (videoFrameReady || frameWatchdogFired) &&
      (!voReconfigSeen || voReconfigSettled)) {
    if (firstFrameDelayTimer) return; // 已在排程中，不重复排
    const elapsed = Date.now() - firstFrameWaitStart;
    const anchorElapsed = loadingScreenShownAt ? (Date.now() - loadingScreenShownAt) : 99999;
    // 取"最短等待"和"绝对锚点剩余"的较大值，再加余量
    const delay = Math.max(
      0, FIRST_FRAME_MIN_MS - elapsed,
      LOADING_ANCHOR_MS - anchorElapsed
    ) + FIRST_FRAME_GRACE_MS;
    firstFrameDelayTimer = setTimeout(() => {
      firstFrameDelayTimer = null;
      endFirstFrameWait();
    }, delay);
  }
}

/** 重置首帧等待的所有跟踪状态（每次进入加载/等待首帧时调用）。 */
function _resetVoReconfigState() {
  voReconfigSeen = false;
  voReconfigSettled = false;
  videoFrameReady = false;
  frameWatchdogFired = false;
  if (voReconfigQuietTimer) { clearTimeout(voReconfigQuietTimer); voReconfigQuietTimer = null; }
  if (frameWatchdog) { clearTimeout(frameWatchdog); frameWatchdog = null; }
}

/** seeking 回调：仅当处于首帧等待中（载入/续播阶段）才重新进入等待，遮罩继续盖住黑底 */
export function notifySeeking() {
  if (!loadingFirstFramePending) return;
  beginFirstFrameWait('正在缓冲…');
}

/** load/stop 时清理遮罩状态与定时器，避免残留导致下次播放异常 */
export function clearLoadingState() {
  loadingFirstFramePending = false;
  if (loadingSafetyTimer) { clearTimeout(loadingSafetyTimer); loadingSafetyTimer = null; }
  if (firstFrameDelayTimer) { clearTimeout(firstFrameDelayTimer); firstFrameDelayTimer = null; }
  if (voReconfigQuietTimer) { clearTimeout(voReconfigQuietTimer); voReconfigQuietTimer = null; }
  if (frameWatchdog) { clearTimeout(frameWatchdog); frameWatchdog = null; }
  // 安全兜底：强制清加载态（出错/中止/未走 endFirstFrameWait 路径）时，
  // 若仍被加载期静音，必须恢复，否则会卡在静音状态。
  _releaseLoadMute();
  const ls = $('loading-screen');
  if (ls) { ls.classList.remove('fading'); ls.style.opacity = ''; ls.classList.add('hidden'); }
}

export function setIdleMode(active, instant = false) {
  const idle = $('idle-screen');
  const isIdle = document.body.classList.contains('idle-mode');
  // 幂等：已在目标状态且 idle 屏可见性一致时，不再重复执行进出动画，
  // 避免换片/加载新文件时把已隐藏的 idle 屏重新拉出来闪一下。
  if (active && isIdle) return;
  if (!active && !isIdle && idle.classList.contains('hidden')) return;

  if (active) {
    // 先清掉尚未触发的旧淡出定时器，否则它会在 400ms 后把 idle 屏重新隐藏
    if (idleFadeTimer) { clearTimeout(idleFadeTimer); idleFadeTimer = null; }
    document.body.classList.add('idle-mode');
    // 回到首页：隐藏视频空态背景层（不透明黑层仅用于视频模式空态）
    const vib = $('video-idle-bg');
    if (vib) vib.classList.remove('visible');
    // 立即恢复光标：观影中可能处于 cursor-hidden（光标自动隐藏），
    // 返回主页必须马上恢复可见，不能等鼠标移动才恢复
    document.body.classList.remove('cursor-hidden');
    // 进入 idle：清掉残留的中央图标脉冲（暂停/快进）与 OSC 播放态，
    // 避免从播放器退回落地页后仍有播放器状态（如中央暂停图标）泄露出来
    if (osd && osd.clearCenter) osd.clearCenter();
    if (osc && osc.hideNow) osc.hideNow();
    // 离开播放（回到落地页）：重置播放器状态，避免残留
    // 各播放器模块自行清理残留（质量徽章等），避免 idle ↔ player 循环依赖
    document.dispatchEvent(new CustomEvent('lumen:idle-enter'));
    const qb = $('quality-badges');
    if (qb) qb.classList.add('hidden');
    idle.classList.remove('hidden', 'fading');
    // 强制重置内联 opacity，避免 transition 停在 0
    idle.style.opacity = '1';
    // 进入 idle：刷新"继续观看"卡片与"媒体库"海报墙
    showResumeCard();
    renderLibrary();
  } else {
    document.body.classList.remove('idle-mode');
    if (idleFadeTimer) { clearTimeout(idleFadeTimer); idleFadeTimer = null; }
    if (instant) {
      // 从 idle 开始播放：立即移除 idle 屏，不要 400ms 淡出，
      // 避免视频已就绪后仍被深色落地页盖住「消失一秒」。
      idle.classList.add('hidden');
      idle.classList.remove('fading');
      idle.style.opacity = '';
    } else {
      idle.classList.remove('hidden');
      // 强制 reflow，确保下一帧 transition 能从 opacity:1 重新开始
      // （快速进出 idle 时浏览器会合并 class 变更，动画会失效）
      void idle.offsetWidth;
      idle.classList.add('fading');
      idle.style.opacity = ''; // 移除内联覆盖，让 CSS transition 接管
      idleFadeTimer = setTimeout(() => idle.classList.add('hidden'), 400);
    }
    // 离开 idle（开始播放）：隐藏续播卡片
    hideResumeCard();
  }
  // 同步通知主进程控制底层视频窗口：idle 时隐藏，避免露出 mpv 的黑色背景。
  try {
    if (window.lumen && window.lumen.setIdleState) {
      window.lumen.setIdleState(active);
    }
  } catch (e) {
    // 主进程 handler 未就绪时忽略
  }
}

/* ================================================================== */
/* 加载遮罩：等到 mpv 真正画出首帧再撤，消除“播放器消失一秒”           */
/* ================================================================== */

// —— 加载期声画对齐：遮罩盖住黑底期间程序化静音，消除“先有声音再有画面” ——
// 遮罩只是视觉层、不会自动静音；若不干预，mpv 一开始播放（time-pos>0）音频就出声，
// 而视频首帧经 --wid→videoWin 的 VO 重配置 / DWM 缩放往往晚到 → 黑屏期听到声音。
// 加载期间静音、遮罩撤下（首帧已上屏）时恢复原静音状态，声画同步起点一致。
let _loadMuted = false;
function _holdLoadMute() {
  try {
    if (!player || typeof player.setProperty !== 'function') return;
    const cur = player.props && player.props.mute;
    if (cur) return;            // 用户本就静音，不打扰既有状态
    _loadMuted = true;
    player.setProperty('mute', true, true);
  } catch (e) { /* 引擎未就绪时忽略 */ }
}
function _releaseLoadMute() {
  if (!_loadMuted) return;
  _loadMuted = false;
  try {
    if (player && typeof player.setProperty === 'function') {
      player.setProperty('mute', false, true);
    }
  } catch (e) { /* noop */ }
}

/**
 * 显示加载遮罩并进入等待状态（用于载入发起阶段，ffprobe 解析期间）。
 * 兜底超时较长（8s），避免大文件解析慢时提前撤遮罩、把 mpv loadfile 前的
 * 黑屏空隙露出来。等待首帧的短超时由 beginFirstFrameWait() 接管。
 * @param {string} [text] 遮罩中央文案
 */
export function showLoadingScreen(text) {
  loadingFirstFramePending = true;
  firstFrameWaitStart = Date.now();
  loadingScreenShownAt = Date.now(); // 绝对锚点：遮罩至少展示 LOADING_ANCHOR_MS
  _resetVoReconfigState();
  _holdLoadMute(); // 加载期静音，避免黑屏期先出声（首帧上屏后恢复）
  const ls = $('loading-screen');
  const txt = $('loading-text');
  if (txt && text) txt.textContent = text;
  // 显示时取消任何进行中的淡出（rapid reload 场景），瞬间露出遮罩以盖住黑底
  if (ls) { ls.classList.remove('hidden', 'fading'); ls.style.opacity = ''; }
  if (loadingSafetyTimer) clearTimeout(loadingSafetyTimer);
  loadingSafetyTimer = setTimeout(endFirstFrameWait, 8000);
}

/**
 * 进入“等待首帧”状态（用于元数据已就绪、loaded 事件之后，或载入阶段发生跳转时重新进入）。
 * 确保遮罩可见、文案切到“正在缓冲…”，并把兜底超时切到较短的 2.5s——
 * 首帧迟迟不来就直接撤，绝不卡死。真正的撤遮罩由 time-pos 推进 / 帧输出(frame-ready) /
 * vo-reconfig 收敛 共同触发（三者经 tryScheduleFade 三重闸门把关）。
 * @param {string} [text] 遮罩中央文案
 */
export function beginFirstFrameWait(text) {
  loadingFirstFramePending = true;
  firstFrameWaitStart = Date.now();
  // 注意：此处【不再】重置 vo-reconfig / 帧 跟踪状态（原 _resetVoReconfigState 会清零
  // voReconfigSeen / videoFrameReady）。原因：首次启动冷加载时，mpv 进程挂载 VO 到
  // --wid 窗口会先发一次 vo-reconfig（早于 file-loaded），这条"早到的有效信号"若被
  // beginFirstFrameWait 抹掉，本轮又不再触发 reconfig → 退化到 frameWatchdog 兜底 →
  // 遮罩提前撤下露出黑底（首帧黑闪）。真正的重置只在载入起点 showLoadingScreen 做一次；
  // 本函数只清"撤遮罩"排程定时器。清掉可能由之前排定的"撤遮罩"定时器，避免旧计时提前触发
  if (firstFrameDelayTimer) { clearTimeout(firstFrameDelayTimer); firstFrameDelayTimer = null; }
  const txt = $('loading-text');
  if (txt && text) txt.textContent = text;
  // 重新进入等待：取消可能进行中的淡出，确保遮罩重新完全盖住黑底
  const ls = $('loading-screen');
  if (ls) { ls.classList.remove('fading'); ls.style.opacity = ''; ls.classList.remove('hidden'); }
  if (loadingSafetyTimer) clearTimeout(loadingSafetyTimer);
  loadingSafetyTimer = setTimeout(endFirstFrameWait, 2500);
}

/**
 * 撤下加载遮罩并清理首帧等待状态。幂等，可安全在 error/degraded/失败分支重复调用。
 *
 * 瞬切策略（不渐隐）：加载遮罩背景是纯黑 #000，与 videoWin 背景完全同色。
 * 直接 display:none 切走 → 若首帧已就位用户直接看到视频；若帧稍晚一帧才到，
 * 用户看到的是"纯黑→纯黑→视频"——中间那帧纯黑差异为零，肉眼完全无感知。
 * 这彻底消灭了 opacity 渐隐期间"逐渐露出底层黑底/半成品帧"的闪动窗口。
 */
export function endFirstFrameWait() {
  loadingFirstFramePending = false;
  if (loadingSafetyTimer) { clearTimeout(loadingSafetyTimer); loadingSafetyTimer = null; }
  if (firstFrameDelayTimer) { clearTimeout(firstFrameDelayTimer); firstFrameDelayTimer = null; }
  if (voReconfigQuietTimer) { clearTimeout(voReconfigQuietTimer); voReconfigQuietTimer = null; }
  if (frameWatchdog) { clearTimeout(frameWatchdog); frameWatchdog = null; }
  const ls = $('loading-screen');
  if (!ls || ls.classList.contains('hidden')) return;
  // 遮罩撤下 = 首帧已上屏：恢复音频，使声画从同一时刻开始（消除"先有声音再有画面"）。
  _releaseLoadMute();
  // 瞬切：不渐隐，直接隐藏。纯黑遮罩 → 纯黑 videoWin = 零感知。
  // （不再使用 opacity transition / transitionend，彻底消灭渐隐窗口）
  ls.classList.add('hidden');
  ls.classList.remove('fading');
  ls.style.opacity = '';
}

/* ================================================================== */
/* 继续观看卡片                                                        */
/* ================================================================== */

let resumeEntry = null;

/** 读取续播快照并刷新 idle 屏的"继续观看"卡片 */
export async function showResumeCard() {
  const card = $('resume-card');
  if (!card) return;
  // 正在播放某文件时不显示续播卡片；但用户主动返回 idle 首页时（body.idle-mode），
  // player.info 可能因 stop 事件异步而仍未清空，这时仍应显示。
  if (player && player.info && !document.body.classList.contains('idle-mode')) { hideResumeCard(); return; }
  try {
    const entry = await window.lumen.getResume();
    if (!entry || !entry.path) { hideResumeCard(); return; }
    resumeEntry = entry;
    card.querySelector('.resume-title').textContent = entry.title || baseName(entry.path);
    const t = Math.max(0, Math.floor(entry.time || 0));
    const pos = formatResumeTime(t);
    const total = entry.duration ? ` / ${formatResumeTime(Math.floor(entry.duration))}` : '';
    card.querySelector('.resume-meta').textContent = `上次看到 ${pos}${total}`;
    card.classList.remove('hidden');
  } catch {
    hideResumeCard();
  }
}

export function hideResumeCard() {
  const card = $('resume-card');
  if (card) card.classList.add('hidden');
  resumeEntry = null;
}

/* ================================================================== */
/* 最近播放列表                                                        */
/* ================================================================== */

/** 读取播放历史并渲染 idle 屏的"媒体库"海报墙。
 *  数据源优先级：当前播放列表(playlist) > 最近播放历史(history)。
 *  列表非空时展示全部已导入媒体（海报墙）；为空时退化为历史，避免首页空荡。 */
export async function renderLibrary() {
  const section = $('library');
  const grid = $('library-grid');
  const empty = $('library-empty');
  if (!section || !grid) return;
  // 正在播放且不在 idle 态时不显示媒体库
  if (player && player.info && !document.body.classList.contains('idle-mode')) { section.classList.add('hidden'); return; }

  let items = [];
  let fromHistory = false;
  if (_playlist.length) {
    items = _playlist.map((p, i) => ({ path: p, index: i, title: baseName(p), audio: isAudioPath(p) }));
  } else {
    try {
      const hist = await window.lumen.getHistory();
      if (hist && hist.length) {
        fromHistory = true;
        items = hist.map((it) => ({
          path: it.path,
          index: -1,
          title: it.title || baseName(it.path),
          audio: isAudioPath(it.path),
          duration: it.duration || 0,
        }));
      }
    } catch { /* 读取历史失败则按空处理 */ }
  }

  if (!items.length) {
    grid.innerHTML = '';
    appendAddMediaCard(grid);
    section.classList.remove('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  grid.innerHTML = '';

  const activeIdx = getPlaylistIndex();
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'poster' + (it.index === activeIdx && !fromHistory ? ' active' : '');
    btn.dataset.type = it.audio ? 'audio' : 'video';
    btn.dataset.search = (it.title || '').toLowerCase();
    btn.title = it.path;
    btn.setAttribute('aria-label', it.title + (it.audio ? '（音乐）' : '（视频）'));

    const img = document.createElement('img');
    img.className = 'poster-img';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';            // 异步解码，避免滚动时主线程被大图解码卡住
    img.loading = 'lazy';              // 离屏海报暂不加载/解码
    btn.appendChild(img);
    requestThumbnail(it.path, img);   // 复用现有真实缩略图管线

    // 分辨率 badge（从文件名免费解析，仅视频）
    if (!it.audio) {
      const res = parseResolution(it.title || baseName(it.path));
      if (res) {
        const resEl = document.createElement('div');
        resEl.className = 'poster-badge poster-res';
        resEl.textContent = res;
        btn.appendChild(resEl);
      }
    }

    // 时长 badge：历史项直接有 duration；其余（播放列表项）懒探测填充
    const durEl = document.createElement('div');
    durEl.className = 'poster-badge poster-dur';
    btn.appendChild(durEl);
    if (it.duration) {
      durEl.textContent = fmtDuration(it.duration);
    } else {
      btn._metaPath = it.path;
      btn._metaDurEl = durEl;
      const obs = _ensureMetaObserver();
      if (obs) obs.observe(btn);
      else _fetchMediaMeta(it.path, durEl); // 无 IO 支持时降级直接取
    }

    const meta = document.createElement('div');
    meta.className = 'poster-meta';
    const name = document.createElement('div');
    name.className = 'poster-title';
    name.textContent = it.title;
    meta.appendChild(name);
    btn.appendChild(meta);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.index >= 0) playlistGoto(it.index);
      else { window.__test_libHistPlay = it.path; if (CTX.load) CTX.load(it.path); }
    });
    grid.appendChild(btn);
  }
  appendAddMediaCard(grid);
  section.classList.remove('hidden');
  _applyLibraryFilter();
  // B4: 首屏海报真实渲染后，量出统一高度回填所有海报的 contain-intrinsic-size，
  // 让离屏海报也用真实高度占位 → 长列表滚动条不再跳动；并绑定窗口缩放重测
  _schedulePosterHeightSync();
  _bindPosterResizeSync();
}

/** 按当前 tab 筛选 + 搜索关键词过滤海报墙 */
function _applyLibraryFilter() {
  const grid = $('library-grid');
  const empty = $('library-empty');
  if (!grid) return;
  const q = libQuery.trim().toLowerCase();
  let visible = 0;
  grid.querySelectorAll('.poster').forEach((el) => {
    const typeOk = libFilter === 'all' || el.dataset.type === libFilter;
    const qOk = !q || (el.dataset.search || '').includes(q);
    const show = typeOk && qOk;
    el.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  if (empty) empty.classList.toggle('hidden', visible > 0);
  // B4: 过滤（tab/搜索）改变可见集合后，重测并回填统一海报高度，保持滚动条稳定
  _schedulePosterHeightSync();
}

/** 在海报墙末尾追加一个常驻的「添加媒体」入口卡片（不受 tab/搜索过滤影响）。
 *  点击调用注入的 openDialog() 打开文件选择框，将所选媒体追加进播放列表。 */
function appendAddMediaCard(grid) {
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'poster-add';
  add.setAttribute('aria-label', '添加媒体');
  add.innerHTML =
    '<span class="poster-add-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="32" height="32"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
    '</span>' +
    '<span class="poster-add-label">添加媒体</span>';
  add.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (CTX.openDialog) {
      await CTX.openDialog(true); // 追加到现有播放列表，而非整体替换
      renderLibrary();            // 刷新海报墙，展示新加入的媒体
    }
  });
  grid.appendChild(add);
}

/** 绑定媒体库 tab 切换与搜索框（只需调用一次） */
export function bindLibrary() {
  const tabs = document.querySelectorAll('#library .lib-tab');
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
    t.classList.add('active');
    t.setAttribute('aria-selected', 'true');
    libFilter = t.dataset.filter || 'all';
    _applyLibraryFilter();
  }));
  const search = $('library-search');
  if (search) search.addEventListener('input', () => { libQuery = search.value || ''; _applyLibraryFilter(); });
}

export function formatResumeTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function bindResumeCard() {
  const btn = $('resume-play');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!resumeEntry || !resumeEntry.path) return;
    window.__test_resumeClicked = resumeEntry.path;
    const r = await (CTX.load ? CTX.load(resumeEntry.path) : null);
    if (!r || !r.ok) {
      // 续播文件已失效，清掉卡片和快照，避免下次再报错
      try { await window.lumen.clearResume(); } catch { /* noop */ }
      hideResumeCard();
    }
  });
}

/** 绑定播放列表面板的关闭按钮与背景遮罩 */
export function bindPlaylistPanel() {
  const btn = $('btn-playlist');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); togglePlaylistPanel(); });
  const close = $('playlist-close');
  if (close) close.addEventListener('click', closePlaylistPanel);
  const backdrop = $('playlist-backdrop');
  if (backdrop) backdrop.addEventListener('click', closePlaylistPanel);
}

/** 绑定"返回主界面"按钮（播放界面 OSC 上的房子图标）：手动回到 logo 落地页 */
export function bindHomeButton() {
  const btn = $('btn-home');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); if (CTX.returnHome) CTX.returnHome(); });
}

/** 绑定 idle 落地页右上角 hover 关闭/最小化按钮 */
export function bindIdleCloseButton() {
  const closeBtn = $('idle-close');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    try { if (window.lumen && window.lumen.windowCommand) window.lumen.windowCommand('close'); } catch { /* noop */ }
  });
  const minBtn = $('idle-minimize');
  if (minBtn) minBtn.addEventListener('click', () => {
    try { if (window.lumen && window.lumen.windowCommand) window.lumen.windowCommand('minimize'); } catch { /* noop */ }
  });
}

/** 绑定 idle 落地页主操作按钮（打开文件 / 网络串流 / 设置 / 左右模式入口） */
export function bindIdleActions() {
  const open = $('idle-open');
  if (open) open.addEventListener('click', (e) => {
    e.stopPropagation();
    if (CTX.openDialog) CTX.openDialog(true); // 追加到媒体库，首页不自动播放
  });
  const stream = $('idle-stream');
  if (stream) stream.addEventListener('click', (e) => {
    e.stopPropagation();
    if (CTX.openNetworkStream) CTX.openNetworkStream();
  });
  const settings = $('idle-settings');
  if (settings) settings.addEventListener('click', (e) => {
    e.stopPropagation();
    if (CTX.toggleSettings) CTX.toggleSettings();
  });
  // 左右大入口：点击直接进入对应播放器（跳过文件选择框）。
  // 音乐入口进入音乐模式空态（拖入/打开文件后接管）；视频入口进入视频播放视图。
  const sideMusic = $('idle-side-music');
  if (sideMusic) sideMusic.addEventListener('click', (e) => {
    e.stopPropagation();
    if (CTX.enterAudioMode) CTX.enterAudioMode(); // 无文件空态进入音乐模式
  });
  const sideVideo = $('idle-side-video');
  if (sideVideo) sideVideo.addEventListener('click', (e) => {
    e.stopPropagation();
    if (CTX.enterVideoMode) CTX.enterVideoMode(); // 进入视频模式（空态）
  });
}

