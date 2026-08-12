/**
 * 音乐播放舞台（Now-Playing）+ 音频模式专属控制条。
 *
 * 当载入纯音频（info.audioOnly）时，展示沉浸式封面 / 唱片 / 曲目信息 / 可视化，
 * 并在底部提供「音乐播放器」风格的控制条（#music-controls）—— 彻底替代视频 OSC，
 * 让音频模式下整个 UI 都是音乐播放器的样子，而非「视频播放器藏了几个按钮 + 唱片」。
 *
 * 控制条内的 [data-cmd] 按钮（播放/暂停/上一首/下一首/停止/静音/全屏）由 osc.js 的
 * _bindButtons() 自动绑定，复用同一套 input.conf 命令逻辑；本模块只额外接管
 * 进度条 / 音量条（需要自定义指针交互）以及播放列表 / 设置入口。
 *
 * 依赖：
 *   - player 代理对象（command / setProperty / observeProperty / props），由 app-events 注入。
 *   - window.lumen.getCoverArt(path) → { ok, dataUrl }（base64 data URL，CSP 安全）。
 * 事件：监听 document 'lumen:playstate'（osc.js 在 pause 变化时派发）与 'lumen:idle-enter'。
 */

import { fmtTime } from '../core/player.js';
import { isLiked, toggleLiked, onLikeChange } from '../core/likes.js';
import { toggleEqPanel, closeEqPanel } from '../panels/eq.js';
import { setIdleMode } from '../panels/idle.js';
import { togglePlaylistPanel } from '../panels/playlist.js';
import { toggleSettings } from '../panels/settings.js';

const $ = (id) => document.getElementById(id);

let stage = null;
let backdrop = null;
let cover = null;
let elTitle = null;
let elArtist = null;
let elAlbum = null;
let mTrackTitle = null;     // #m-track-title 底部通栏左侧曲目名
let mTrackArtist = null;    // #m-track-artist 底部通栏左侧艺人
let _coverToken = 0; // 防止慢速封面回调覆盖新曲目
let _currentLikePath = ''; // 当前曲目路径（驱动红心按钮状态）
let _currentInfo = null;   // 当前曲目元信息（供桌面歌词/MediaSession 复用）

// 睡眠定时
let _sleepBtn = null;
let _sleepMenu = null;
let _sleepTimer = null;     // 倒计时 interval（每秒刷新剩余）
let _sleepFadeTimer = null; // 到点后渐隐 interval
let _sleepEnd = 0;          // 结束时间戳(ms)
const SLEEP_FADE_MS = 15000; // 到点后渐隐到静音的时长

// 音乐模式顶部窗口控制按钮
let mTitlebar = null;
let mBackBtn = null;
let mMinimize = null;
let mClose = null;
let mLikeBtn = null;        // #m-btn-like 收藏红心
let mEqBtn = null;          // #m-btn-eq 均衡器
let mBtnShuffle = null;     // #m-btn-shuffle 随机
let mBtnRepeat = null;      // #m-btn-repeat 循环
let mBtnSpeed = null;       // #m-btn-speed 倍速
let mBtnQuality = null;     // #m-btn-quality 音频质量
let mBtnQualityLabel = null; // #m-btn-quality 内的 .mq-label 动态文字
let mIconRepeat = null;     // #m-icon-repeat 列表循环
let mIconRepeatOne = null;  // #m-icon-repeat-one 单曲循环

// 控制条元素
let player = null;
let mSeek = null, mSeekBuffered = null, mSeekProgress = null, mSeekHandle = null;
let mTimeCur = null, mTimeTotal = null;
let mVol = null, mVolFill = null, mVolHandle = null, mVolGroup = null, mVolValue = null;
let mIconPlay = null, mIconPause = null, mIconVol = null, mIconMute = null;
let mcEl = null;       // #music-controls 容器（拖拽时加 .dragging 维持手柄可见）
let _seeking = false; // 拖拽进度条中

// 音频频谱（Canvas，真实 FFT 驱动）
let mSpectrum = null, mSpectrumCtx = null;
let mSpectrumLyrics = null, mSpectrumLyricsCtx = null;
let mSpectrumLyricsWrap = null; // 歌词底部频谱 wrapper（ResizeObserver 用）
let _spectrumResizeObserver = null; // 监听歌词频谱 wrapper 尺寸/显示变化
let _spectrumRAF = 0;
let _freq = null;      // Uint8Array：analyser.frequencyBinCount 长度
let _peaks = null;     // Float32Array：峰值保持，让条子有"弹起再落"手感
let _reducedMotion = undefined; // undefined=未探测
const SPECTRUM_BARS = 72;

// 歌词视图（Apple Music 风格逐字高亮 + 点击跳播）
let mLyrics = null;         // #m-lyrics 歌词容器
let mLyricsWrap = null;     // #m-lyrics-wrap 歌词视图包装
let mLyricsOffset = null;   // #m-lyrics-offset 偏移值显示
let _lyricLines = [];       // [{ el, time, text }]
let _lyricActiveIdx = -1;
let _lastLyricTime = 0;     // 最近一次 _syncLyrics 的时间（驱动 credits 块「已读」上色）
let _currentRawLines = [];  // 当前歌曲原始歌词 lines（未注入 credits），用于异步查询到 credits 后重建
let _lyricsBound = false;   // _bindLyrics 只绑一次，避免重复监听
let _lyricsResizeObserver = null; // 监听歌词视图尺寸，动态维持上下空距为可视区一半
let _lyricOffset = 0;       // 当前歌曲歌词时间偏移（秒），正数=歌词延后
let _lyricOffsetPath = '';  // 当前偏移对应的媒体路径（用于持久化键）
let _accentRGB = [124, 140, 255]; // 封面主色（驱动进度/音量/频谱/光晕），默认主题色
// 歌词扫光 rAF 插值：记录最近一次 time-pos 采样值与时刻，在两次采样之间
// 按墙钟时间线性推进当前句 --prog，消除逐字跳变带来的「不丝滑」感。
let _lyricRAF = 0;
let _lastTimePos = 0;
let _lastSampleAt = 0;

// 歌词滚动 scrub：用户手动滚轮/拖拽歌词控制播放进度，并显示时间轴提示
let _lyricScrubbing = false;   // 用户正在手动滚动/拖拽歌词（暂停自动跟随）
let _lyricScrubTimer = null;   // 提交 seek 的防抖定时器
let _lyricScrubResume = null;  // 恢复自动跟随的空闲定时器
let _lyricScrubLineEl = null;  // 当前对准的目标行（预览高亮）
let _lyricAxisEl = null;       // #m-lyrics-axis 时间轴轴
let _lyricAxisTimeEl = null;   // #m-lyrics-axis-time 时间文本
let _lyricScrubBound = false;  // 滚轮/拖拽绑定只做一次
let _lyricDragY = null;        // pointer 拖拽起点 Y（null=未在拖）
let _lyricDragMoved = false;   // 本次拖拽是否超过阈值（区分点按与拖拽）

// 歌词翻译（外语歌词逐行译为中文；懒加载 + 按路径缓存于 localStorage）
let mLyricsTransBtn = null; // #m-btn-translate 翻译开关
let _translateOn = false;   // 是否显示翻译（持久化偏好）
let _currentLyricPath = ''; // 当前歌词对应的媒体路径（翻译缓存键）
const LYRIC_TRANSLATE_ON_KEY = 'lumora.lyric.translateOn';
const LYRIC_TRANS_CACHE_PREFIX = 'lumora.lyric.trans.';
function _lyricTransCacheKey(path) {
  try { return LYRIC_TRANS_CACHE_PREFIX + btoa(unescape(encodeURIComponent(path || ''))); }
  catch { return LYRIC_TRANS_CACHE_PREFIX + 'default'; }
}

// 桌面歌词（独立置顶透明窗口）：开关偏好持久化 + 当前行转发
let mBtnDesktopLyrics = null; // #m-btn-desktop-lyrics 开关
let _desktopLyricsOn = false; // 是否开启桌面歌词（持久化偏好）
const DESKTOP_LYRICS_ON_KEY = 'lumora.desktopLyrics.on';

// 播放器样式（QQ 音乐「播放器样式」同款：切换音乐舞台布局）
let mStyleBtn = null;       // #m-btn-style
let mStyleMenu = null;      // #m-style-menu
let _playerStyle = 'square'; // 当前布局样式（默认简约方形）
const PLAYER_STYLE_KEY = 'lumora.music.playerStyle';
const PLAYER_STYLES = ['cover', 'lyrics', 'vinyl', 'square', 'glass', 'lyrics-min'];

// 艺人写真照（歌词优先等样式用）
let _artistPhotoUrl = '';     // 当前曲目的艺人写真 data URL
let _coverDataUrl = '';       // 当前曲目的专辑封面 data URL（用于样式切换时回退）
let _artistPhotoPending = false; // 写真是否仍在异步获取中
let _artistPhotoTimeout = null;    // 写真获取超时降级句柄

function ensureRefs() {
  if (stage) return;
  stage = $('music-stage');
  if (!stage) return;
  backdrop = stage.querySelector('.ms-backdrop');
  cover = stage.querySelector('.ms-cover');
  elTitle = stage.querySelector('.ms-title');
  elArtist = stage.querySelector('.ms-artist');
  elAlbum = stage.querySelector('.ms-album');
  mTrackTitle = $('m-track-title');
  mTrackArtist = $('m-track-artist');

  mSeek = $('m-seek');
  mSeekBuffered = $('m-seek-buffered');
  mSeekProgress = $('m-seek-progress');
  mSeekHandle = $('m-seek-handle');
  mTimeCur = $('m-time-cur');
  mTimeTotal = $('m-time-total');
  mVol = $('m-volume');
  mVolFill = $('m-volume-fill');
  mVolHandle = $('m-volume-handle');
  mVolGroup = $('m-volume-group');
  mVolValue = $('m-volume-value');
  mIconPlay = $('m-icon-play');
  mIconPause = $('m-icon-pause');
  mIconVol = $('m-icon-vol');
  mIconMute = $('m-icon-mute');
  mSpectrum = $('m-spectrum');
  mSpectrumLyrics = $('m-spectrum-lyrics');
  mSpectrumLyricsWrap = $('m-spectrum-lyrics-wrap');
  mBtnDesktopLyrics = $('m-btn-lyrics');  // 「词」按钮即桌面歌词开关（重构后歌词常显，原歌词开关联动取消）
  mLyrics = $('m-lyrics');
  mLyricsWrap = $('m-lyrics-wrap');
  mLyricsOffset = $('m-lyrics-offset');
  mLyricsTransBtn = $('m-btn-translate');
  _lyricAxisEl = $('m-lyrics-axis');
  _lyricAxisTimeEl = $('m-lyrics-axis-time');
  mcEl = $('music-controls');

  mTitlebar = $('m-titlebar');
  mBackBtn = $('m-btn-back');
  mMinimize = $('m-minimize');
  mClose = $('m-close');
  mLikeBtn = $('m-btn-like');
  mEqBtn = $('m-btn-eq');
  mBtnShuffle = $('m-btn-shuffle');
  mBtnRepeat = $('m-btn-repeat');
  mBtnSpeed = $('m-btn-speed');
  mBtnQuality = $('m-btn-quality');
  mBtnQualityLabel = mBtnQuality ? mBtnQuality.querySelector('.mq-label') : null;
  mIconRepeat = $('m-icon-repeat');
  mIconRepeatOne = $('m-icon-repeat-one');
  mStyleBtn = $('m-btn-style');
  mStyleMenu = $('m-style-menu');

  _setupLyricsResize();
}

export function initMusicStage(p) {
  player = p || null;
  ensureRefs();
  if (!stage) return;

  // 还原歌词翻译偏好：默认开启（仅显式存 '0' 时关闭），与参考图「原文+翻译同屏」一致
  let _tStored = null;
  try { _tStored = localStorage.getItem(LYRIC_TRANSLATE_ON_KEY); } catch { /* ignore */ }
  _translateOn = _tStored !== '0';
  stage.classList.add('translate-on');
  if (mLyricsTransBtn) mLyricsTransBtn.setAttribute('aria-pressed', _translateOn ? 'true' : 'false');

  // 还原桌面歌词开关偏好（仅 UI 态同步；实际窗口由用户点开/关时经 IPC 控制）
  try { _desktopLyricsOn = localStorage.getItem(DESKTOP_LYRICS_ON_KEY) === '1'; } catch { /* ignore */ }
  if (mBtnDesktopLyrics) mBtnDesktopLyrics.setAttribute('aria-pressed', _desktopLyricsOn ? 'true' : 'false');

  // 还原播放器样式偏好并立即应用：自动进入「退出前」的播放样式。
  // 仅当存值合法时采用，避免老缓存残留的已废弃布局；首次进入或未识别时默认简约方形。
  try {
    const savedStyle = localStorage.getItem(PLAYER_STYLE_KEY);
    if (savedStyle && PLAYER_STYLES.includes(savedStyle)) {
      _playerStyle = savedStyle;
    } else {
      _playerStyle = 'square';
      try { localStorage.setItem(PLAYER_STYLE_KEY, _playerStyle); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  _applyPlayerStyle(_playerStyle);

  // 监听主进程广播的桌面歌词可见状态（如用户在悬浮窗内点关闭），同步开关按钮
  try {
    if (window.lumen && window.lumen.on) {
      window.lumen.on('desktop-lyrics:state', (p) => {
        if (!p) return;
        _desktopLyricsOn = !!p.visible;
        if (mBtnDesktopLyrics) mBtnDesktopLyrics.setAttribute('aria-pressed', _desktopLyricsOn ? 'true' : 'false');
        try { localStorage.setItem(DESKTOP_LYRICS_ON_KEY, _desktopLyricsOn ? '1' : '0'); } catch {}
      });
    }
  } catch { /* noop */ }

  document.addEventListener('lumen:playstate', (e) => {
    setPlaying(!(e.detail && e.detail.paused));
  });
  // 退回落地页（setIdleMode(true) 会派发）：若正在音乐模式则显式暂停播放并保留进度，
  // 下次再进入音乐模式时由 enterAudioMode 续播；同时退出音频模式 UI。
  document.addEventListener('lumen:idle-enter', () => {
    if (document.body.classList.contains('audio-mode') && player && player.setProperty) {
      try { player.setProperty('pause', true); } catch { /* noop */ }
    }
    exitAudioMode();
  });
  // 收藏状态从其他入口（如播放列表）变化时，刷新当前曲目红心
  onLikeChange(({ path }) => { if (path === _currentLikePath) _refreshLikeButton(); });

  _bindMusicControls();
  _bindTitlebar();
  _bindLyrics();
  _bindLyricScrub();
  _bindDesktopLyrics();
  _bindLyricsOffset();
  _bindPlayerStyle();
  _observePlayer();
  _initMediaSession();
  _bindLike();
  _bindSleep();
  _bindSpeed();
  _bindLoopButtons();

  // 窗口尺寸变化时同步频谱画布分辨率（避免条子被拉伸糊掉）
  window.addEventListener('resize', () => { if (mSpectrum) _resizeSpectrum(); });
}

/* ================= 顶部窗口控制按钮绑定 ================= */

function _bindTitlebar() {
  if (mBackBtn) {
    mBackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setIdleMode(true);
    });
  }
  if (mMinimize) {
    mMinimize.addEventListener('click', (e) => {
      e.stopPropagation();
      try { if (window.lumen && window.lumen.windowCommand) window.lumen.windowCommand('minimize'); } catch { /* noop */ }
    });
  }
  if (mClose) {
    mClose.addEventListener('click', (e) => {
      e.stopPropagation();
      try { if (window.lumen && window.lumen.windowCommand) window.lumen.windowCommand('close'); } catch { /* noop */ }
    });
  }
}

/* ================= 收藏红心 ================= */

function _bindLike() {
  if (!mLikeBtn) return;
  mLikeBtn.addEventListener('click', () => {
    if (!_currentLikePath) return;
    const liked = toggleLiked(_currentLikePath); // 经 likes.js 持久化并广播
    _refreshLikeButton();
    if (liked) {
      mLikeBtn.classList.remove('pop');
      // 强制回流以重启动画
      void mLikeBtn.offsetWidth;
      mLikeBtn.classList.add('pop');
    }
  });
}

function _refreshLikeButton() {
  if (!mLikeBtn) return;
  const liked = isLiked(_currentLikePath);
  mLikeBtn.classList.toggle('liked', liked);
  mLikeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  mLikeBtn.title = liked ? '取消喜欢' : '喜欢';
}

/* ================= 倍速选择 ================= */

function _bindSpeed() {
  const btn = mBtnSpeed || $('m-btn-speed');
  const menu = $('m-speed-menu');
  if (!btn || !menu) return;

  const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const _sync = () => {
    const s = player && player.props ? (player.props.speed || 1) : 1;
    const fixed = Number(s.toFixed(2));
    btn.textContent = `${fixed}×`;
    btn.title = `播放速度（当前 ${fixed}×）`;
    menu.querySelectorAll('.mc-speed-opt').forEach((b) => {
      const val = Number(b.getAttribute('data-speed')) || 1;
      b.classList.toggle('current', Math.abs(val - fixed) < 1e-6);
    });
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.hasAttribute('hidden');
    menu.toggleAttribute('hidden', !willOpen);
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) _sync();
  });
  menu.querySelectorAll('.mc-speed-opt').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!player) return;
      const val = Number(b.getAttribute('data-speed')) || 1;
      player.setProperty('speed', val);
      _sync();
      menu.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', 'false');
      if (window.__lumen?.run) {
        try { window.__lumen.run(['show_text', `速度 ${val.toFixed(2)}×`, 1200]); } catch { /* OSD 非必需 */ }
      }
    });
  });
  // 点击空白处关闭菜单
  document.addEventListener('click', (e) => {
    if (menu.hasAttribute('hidden')) return;
    if (menu.contains(e.target) || e.target === btn) return;
    menu.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', 'false');
  });

  _sync();
  mBtnSpeed = btn;
}

/* ================= 睡眠定时 ================= */

function _bindSleep() {
  _sleepBtn = $('m-btn-sleep');
  _sleepMenu = $('m-sleep-menu');
  if (!_sleepBtn || !_sleepMenu) return;
  _sleepBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = _sleepMenu.hasAttribute('hidden');
    _sleepMenu.toggleAttribute('hidden', !willOpen);
    _sleepBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  _sleepMenu.querySelectorAll('.mc-sleep-opt').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();          // 阻止冒泡到 document 空白关闭处理器，避免竞态
      const min = Number(b.getAttribute('data-min')) || 0;
      _startSleep(min);
      _sleepMenu.setAttribute('hidden', '');
      _sleepBtn.setAttribute('aria-expanded', 'false');
    });
  });
  // 点击空白处关闭菜单
  document.addEventListener('click', (e) => {
    if (_sleepMenu.hasAttribute('hidden')) return;
    if (_sleepMenu.contains(e.target) || e.target === _sleepBtn) return;
    _sleepMenu.setAttribute('hidden', '');
    _sleepBtn.setAttribute('aria-expanded', 'false');
  });
}

function _startSleep(min) {
  _cancelSleep();
  if (min <= 0) return;
  _sleepEnd = Date.now() + min * 60000;
  if (_sleepBtn) _sleepBtn.classList.add('sleeping');
  _sleepTimer = setInterval(_sleepTick, 1000);
  _sleepTick();
}

function _sleepTick() {
  const remain = _sleepEnd - Date.now();
  if (remain <= 0) { _fireSleep(); return; }
  const total = Math.ceil(remain / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  const label = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const cnt = $('m-sleep-count');
  if (cnt) { cnt.hidden = false; cnt.textContent = label; }
  if (_sleepBtn) _sleepBtn.title = `睡眠定时：剩余 ${label}`;
}

function _fireSleep() {
  if (_sleepTimer) { clearInterval(_sleepTimer); _sleepTimer = null; }
  const startVol = (player && player.props) ? (player.props.mute ? 0 : (player.props.volume || 0)) : 0;
  const t0 = Date.now();
  _sleepFadeTimer = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / SLEEP_FADE_MS);
    const v = Math.round(startVol * (1 - k));
    if (player && player.setProperty) { try { player.setProperty('volume', v); } catch { /* noop */ } }
    if (k >= 1) {
      if (player && player.setProperty) { try { player.setProperty('pause', true); } catch { /* noop */ } }
      // 暂停后恢复音量，避免下次播放静音
      if (player && player.setProperty) { try { player.setProperty('volume', startVol); } catch { /* noop */ } }
      _cancelSleep();
    }
  }, 200);
}

function _cancelSleep() {
  if (_sleepTimer) { clearInterval(_sleepTimer); _sleepTimer = null; }
  if (_sleepFadeTimer) { clearInterval(_sleepFadeTimer); _sleepFadeTimer = null; }
  _sleepEnd = 0;
  if (_sleepBtn) {
    _sleepBtn.classList.remove('sleeping');
    _sleepBtn.title = '睡眠定时';
  }
  const cnt = $('m-sleep-count');
  if (cnt) { cnt.hidden = true; cnt.textContent = ''; }
}

/* ================= 播放器样式切换 ================= */

function _bindPlayerStyle() {
  if (!mStyleBtn || !mStyleMenu) return;
  mStyleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = mStyleMenu.hasAttribute('hidden');
    mStyleMenu.toggleAttribute('hidden', !willOpen);
    mStyleBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  mStyleMenu.querySelectorAll('.mc-style-opt').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const style = b.getAttribute('data-style') || 'square';
      _applyPlayerStyle(style);
      try { localStorage.setItem(PLAYER_STYLE_KEY, style); } catch { /* ignore */ }
      mStyleMenu.setAttribute('hidden', '');
      mStyleBtn.setAttribute('aria-expanded', 'false');
      // 切换到歌词相关布局后，歌词容器尺寸可能突变，触发 ResizeObserver 重新居中
      if (mLyricsWrap && _lyricActiveIdx >= 0) {
        requestAnimationFrame(() => _syncLyrics(player && player.props ? (player.props['time-pos'] || 0) : 0, true));
      }
    });
  });
  // 点击空白处关闭菜单
  document.addEventListener('click', (e) => {
    if (mStyleMenu.hasAttribute('hidden')) return;
    if (mStyleMenu.contains(e.target) || e.target === mStyleBtn) return;
    mStyleMenu.setAttribute('hidden', '');
    mStyleBtn.setAttribute('aria-expanded', 'false');
  });
}

function _applyPlayerStyle(style) {
  if (!PLAYER_STYLES.includes(style)) style = 'square';
  _playerStyle = style;
  if (!stage) return;
  // 先清理所有已废弃或残留的旧样式类，避免 multiple style-* / music-style-* 同时存在导致 CSS 互相覆盖
  Array.from(stage.classList).forEach((cls) => {
    if (cls.startsWith('style-')) stage.classList.remove(cls);
  });
  Array.from(document.body.classList).forEach((cls) => {
    if (cls.startsWith('music-style-')) document.body.classList.remove(cls);
  });
  stage.classList.add(`style-${style}`);
  // 同步给底部控制条打主题标记，方便 CSS 为浅色主题（透明彩胶）切换控制条配色
  const controls = document.getElementById('music-controls');
  if (controls) {
    controls.classList.toggle('mc-theme-light', style === 'glass');
  }
  // 给 body 也打标记，使 #music-stage 外的元素（标题栏、底部控制条等）能跟随当前音乐样式
  document.body.classList.add(`music-style-${style}`);
  // 歌词底部频谱 wrapper 是 #music-stage 外的 body 子节点，JS 直接控制显示/隐藏作为 CSS 兄弟选择器的双重保险
  if (mSpectrumLyricsWrap) {
    const showSpectrum = style === 'lyrics-min' || style === 'lyrics';
    mSpectrumLyricsWrap.style.display = showSpectrum ? 'block' : '';
    if (showSpectrum) {
      requestAnimationFrame(() => { _resizeSpectrum(); _drawSpectrum(); });
    }
  }
  if (mStyleMenu) {
    mStyleMenu.querySelectorAll('.mc-style-opt').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-style') === style);
    });
  }
  // 样式切换会改变 .ms-spectrum-lyrics-wrap 的显示状态；
  // 用 ResizeObserver 已在 _setupSpectrum 中挂好，这里额外延迟一帧确保首次布局完成
  requestAnimationFrame(() => { _resizeSpectrum(); _drawSpectrum(); });
  setTimeout(() => { _resizeSpectrum(); _drawSpectrum(); }, 60);
  // 样式切换后刷新背景：歌词优先优先用艺人写真，其他样式用专辑封面
  if (backdrop) backdrop.style.backgroundImage = `url("${_currentBackdropUrl()}")`;
}

/* ================= 随机 / 循环 按钮状态同步 ================= */

function _reflectLoopMode(mode) {
  const shuffleOn = mode === 'random';
  if (mBtnShuffle) {
    mBtnShuffle.classList.toggle('active', shuffleOn);
    mBtnShuffle.setAttribute('aria-pressed', String(shuffleOn));
  }
  if (mBtnRepeat) {
    const repeatOn = mode === 'list' || mode === 'file';
    mBtnRepeat.classList.toggle('active', repeatOn);
    mBtnRepeat.setAttribute('aria-pressed', String(repeatOn));
    if (mIconRepeat && mIconRepeatOne) {
      mIconRepeat.classList.toggle('hidden', mode === 'file');
      mIconRepeatOne.classList.toggle('hidden', mode !== 'file');
    }
  }
}

function _bindLoopButtons() {
  _reflectLoopMode((window.__lumen && window.__lumen.loopMode) ? window.__lumen.loopMode() : 'off');
  document.addEventListener('lumen:loopmode', (e) => _reflectLoopMode(e.detail && e.detail.mode));
}

/* ================= 控制条绑定 ================= */

function _bindMusicControls() {
  if (!mSeek) return;

  // 进度条：拖拽本地预览、松手才真正 seek（避免拖动中反复重启解码管线）。
  const ratioAt = (clientX) => {
    const r = mSeek.getBoundingClientRect();
    return Math.max(0, Math.min((clientX - r.left) / Math.max(r.width, 1), 1));
  };

  mSeek.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !player || !player.info) return;
    _seeking = true;
    if (mcEl) mcEl.classList.add('dragging');
    mSeek.setPointerCapture(e.pointerId);
    _previewSeek(ratioAt(e.clientX));
    e.preventDefault();
  });
  mSeek.addEventListener('pointermove', (e) => {
    if (!_seeking) return;
    _previewSeek(ratioAt(e.clientX));
  });
  const finishSeek = (e) => {
    if (!_seeking) return;
    _seeking = false;
    if (mcEl) mcEl.classList.remove('dragging');
    try { mSeek.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    const r = ratioAt(e.clientX);
    if (player) player.command(['seek', r * 100, 'absolute-percent']);
  };
  mSeek.addEventListener('pointerup', finishSeek);
  mSeek.addEventListener('pointercancel', () => { _seeking = false; });
  mSeek.addEventListener('wheel', (e) => {
    if (!player || !player.info) return;
    e.preventDefault();
    player.command(['seek', e.deltaY < 0 ? 5 : -5]);
  }, { passive: false });

  // 进度条键盘可达性（role=slider）
  mSeek.addEventListener('keydown', (e) => {
    if (!player || !player.info) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { player.command(['seek', 5]); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { player.command(['seek', -5]); e.preventDefault(); }
    else if (e.key === ' ' || e.key === 'Enter') { player.command(['cycle', 'pause']); e.preventDefault(); }
  });

  // 进度条悬停时间气泡：鼠标悬停/移动时显示光标对应的时间点，便于快速定位跳转
  const seekTip = $('m-seek-tip');
  const _paintSeekTip = (clientX) => {
    if (!seekTip || !player || !player.info) return;
    const d = player.props.duration || 0;
    const ratio = ratioAt(clientX);
    seekTip.textContent = fmtTime(d * ratio, d >= 3600);
    seekTip.style.left = `${ratio * 100}%`;
    seekTip.classList.add('show');
    seekTip.setAttribute('aria-hidden', 'false');
  };
  const _hideSeekTip = () => {
    if (!seekTip) return;
    seekTip.classList.remove('show');
    seekTip.setAttribute('aria-hidden', 'true');
  };
  mSeek.addEventListener('mouseenter', (e) => _paintSeekTip(e.clientX));
  mSeek.addEventListener('mousemove', (e) => _paintSeekTip(e.clientX));
  mSeek.addEventListener('mouseleave', _hideSeekTip);

  // 音量条
  const volRatioAt = (clientY) => {
    const r = mVol.getBoundingClientRect();
    return Math.max(0, Math.min((r.bottom - clientY) / Math.max(r.height, 1), 1));
  };
  let draggingVol = false;
  mVol.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !player) return;
    draggingVol = true;
    if (mVolGroup) mVolGroup.classList.add('dragging');
    mVol.setPointerCapture(e.pointerId);
    player.setProperty('volume', Math.round(volRatioAt(e.clientY) * 100));
    e.preventDefault();
  });
  mVol.addEventListener('pointermove', (e) => {
    if (!draggingVol || !player) return;
    player.setProperty('volume', Math.round(volRatioAt(e.clientY) * 100));
  });
  const endVol = (e) => {
    if (!draggingVol) return;
    draggingVol = false;
    if (mVolGroup) mVolGroup.classList.remove('dragging');
    try { mVol.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
  };
  mVol.addEventListener('pointerup', endVol);
  mVol.addEventListener('pointercancel', endVol);
  mVol.addEventListener('keydown', (e) => {
    if (!player) return;
    const cur = Math.min(player.props.volume || 0, 100);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { player.setProperty('volume', Math.min(cur + 5, 100)); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { player.setProperty('volume', Math.max(cur - 5, 0)); e.preventDefault(); }
  });

  // 静音按钮：命令总线切换 mute 后，强制下一帧重绘音量条与图标，
  // 避免某些情况下属性通知链未能及时同步到音乐引擎的 observer。
  const mMuteBtn = mVolGroup ? mVolGroup.querySelector('button[data-cmd="cycle mute"]') : null;
  if (mMuteBtn) {
    mMuteBtn.addEventListener('click', () => {
      requestAnimationFrame(() => _paintVolume());
    });
  }

  // 播放列表 / 设置（复用既有面板逻辑）
  const btnPlaylist = $('m-btn-playlist');
  if (btnPlaylist) btnPlaylist.addEventListener('click', () => togglePlaylistPanel());
  const btnSettings = $('m-btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', () => toggleSettings());
  // 均衡器面板（仅音频模式可用，切换时关闭其它右侧面板）
  if (mEqBtn) mEqBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleEqPanel(); });
  // 投屏（复用全局 toggleCast，DLNA/Chromecast 统一入口）
  const btnCast = $('m-btn-cast');
  if (btnCast) btnCast.addEventListener('click', (e) => {
    e.stopPropagation();
    try { if (window.toggleCast) window.toggleCast(); } catch { /* 投屏不可用则忽略 */ }
  });
  // 倍速按钮引用由 _bindSpeed() 统一接管下拉菜单
  mBtnSpeed = $('m-btn-speed');
}

/* ================= 属性订阅 ================= */

function _observePlayer() {
  if (!player || typeof player.observeProperty !== 'function') return;
  player.observeProperty('pause', (v) => {
    const paused = v === true;
    setPlaying(!paused);
    _syncPlayIcons(paused);
  });
  player.observeProperty('time-pos', () => {
    const t = player && player.props ? (player.props['time-pos'] || 0) : 0;
    // 记录采样时刻，供歌词 rAF 在两次 time-pos 之间插值，保证扫光丝滑
    _lastTimePos = t;
    _lastSampleAt = performance.now();
    _paintProgress();
    _syncLyrics(t);
  });
  player.observeProperty('duration', () => _paintProgress());
  player.observeProperty('volume', () => _paintVolume());
  player.observeProperty('mute', (v) => {
    _paintVolume();
    const muted = v === true;
    if (mIconVol) mIconVol.classList.toggle('hidden', muted);
    if (mIconMute) mIconMute.classList.toggle('hidden', !muted);
  });
  player.observeProperty('speed', () => {
    if (!mBtnSpeed || !player) return;
    const s = player.props.speed || 1;
    const fixed = Number(s.toFixed(2));
    mBtnSpeed.textContent = `${fixed}×`;
    mBtnSpeed.title = `播放速度（当前 ${fixed}×）`;
    const menu = $('m-speed-menu');
    if (menu) {
      menu.querySelectorAll('.mc-speed-opt').forEach((b) => {
        const val = Number(b.getAttribute('data-speed')) || 1;
        b.classList.toggle('current', Math.abs(val - fixed) < 1e-6);
      });
    }
  });
  player.observeProperty('aid', () => _paintQuality());
}

/* ================= 绘制 ================= */

function _previewSeek(ratio) {
  const d = player && player.props.duration;
  const t = d ? d * ratio : 0;
  if (mSeekProgress) mSeekProgress.style.setProperty('--mc-progress', String(ratio));
  if (mSeekHandle) mSeekHandle.style.left = `${ratio * 100}%`;
  if (mTimeCur) mTimeCur.textContent = fmtTime(t, d >= 3600);
  if (mSeek) mSeek.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
}

function _paintProgress() {
  if (!player) return;
  const d = player.props.duration;
  const t = player.props['time-pos'];
  const pct = d > 0 ? Math.max(0, Math.min((t || 0) / d, 1)) : 0;
  if (mSeekProgress) mSeekProgress.style.setProperty('--mc-progress', String(pct));
  if (mSeekHandle) mSeekHandle.style.left = `${pct * 100}%`;
  if (mTimeCur) mTimeCur.textContent = fmtTime(t || 0, d >= 3600);
  if (mTimeTotal) mTimeTotal.textContent = fmtTime(d || 0, d >= 3600);
  if (mSeek) mSeek.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
  _updatePositionState();
}

function _paintVolume() {
  if (!player) return;
  const v = player.props.mute ? 0 : Math.min(player.props.volume || 0, 100);
  if (mVolFill) mVolFill.style.height = `${v}%`;
  if (mVolHandle) mVolHandle.style.bottom = `${v}%`;
  if (mVolValue) mVolValue.textContent = `${Math.round(v)}%`;
  if (mVol) mVol.setAttribute('aria-valuenow', String(Math.round(v)));
  if (mIconVol && mIconMute) {
    mIconVol.classList.toggle('hidden', v === 0);
    mIconMute.classList.toggle('hidden', v !== 0);
  }
}

/* ================= 音频质量标签 ================= */

const LOSSLESS_CODECS = new Set([
  'flac', 'alac', 'wav', 'aiff', 'tta', 'tak', 'ape', 'wv',
  'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le',
  'pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm', 'pcm_u8',
]);

/** 根据音频轨元数据给出质量标签（与常见音乐 App 对齐） */
function _classifyAudioQuality(a) {
  if (!a) return '标准';
  const codec = String(a.codec || '').toLowerCase();
  const sampleRate = Number(a.sampleRate) || 48000;
  const bitrate = Number(a.bitrate) || 0;
  if (a.atmos || (a.dolbyLabel && /atmos/i.test(String(a.dolbyLabel)))) return '杜比全景声';
  if (sampleRate >= 96000) return 'Hi-Res';
  if (LOSSLESS_CODECS.has(codec) || LOSSLESS_CODECS.has(codec.replace(/_\w+$/, ''))) return '无损';
  if (bitrate >= 320000) return '320k';
  if (bitrate >= 256000) return '256k';
  if (bitrate >= 192000) return '192k';
  if (bitrate >= 128000) return '128k';
  return '标准';
}

/** 同步「标准」按钮为当前音频质量，title 显示详细参数 */
function _paintQuality() {
  if (!mBtnQuality) return;
  const info = (player && player.info) || _currentInfo || {};
  const audioTracks = info.audio;
  const aid = (player && player.props && player.props.aid) ?? info.aid ?? 0;
  const a = audioTracks && audioTracks[aid];
  const label = _classifyAudioQuality(a);
  const parts = [];
  if (a) {
    parts.push(a.codec.toUpperCase());
    parts.push(`${(a.sampleRate / 1000).toFixed(1)}kHz`);
    parts.push(`${a.channels}ch`);
    if (a.bitrate) parts.push(`${Math.round(a.bitrate / 1000)}kbps`);
  }
  if (mBtnQualityLabel) mBtnQualityLabel.textContent = label;
  else mBtnQuality.textContent = label;
  mBtnQuality.title = parts.length ? `音频质量：${label}（${parts.join(' / ')}）` : '音频质量';
}

/* ================= 频谱（真实 FFT） ================= */

function _setupSpectrum() {
  if (mSpectrum) mSpectrumCtx = mSpectrum.getContext('2d');
  if (mSpectrumLyrics) mSpectrumLyricsCtx = mSpectrumLyrics.getContext('2d');
  _reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // 监听歌词底部频谱包装器尺寸/显示变化，确保切到歌词样式时 canvas 能立刻拿到正确尺寸
  if (mSpectrumLyricsWrap && !_spectrumResizeObserver && typeof ResizeObserver !== 'undefined') {
    _spectrumResizeObserver = new ResizeObserver(() => {
      _resizeSpectrum();
      _drawSpectrum();
    });
    _spectrumResizeObserver.observe(mSpectrumLyricsWrap);
  }

  // 兜底：监听 wrapper 的 display 属性变化（例如从 none 切到 block），强制重设尺寸并重绘
  if (mSpectrumLyricsWrap && typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => {
      if (mSpectrumLyricsWrap && mSpectrumLyricsWrap.clientWidth > 0) {
        _resizeSpectrum();
        _drawSpectrum();
      }
    });
    obs.observe(mSpectrumLyricsWrap, { attributes: true, attributeFilter: ['style', 'class'] });
  }
}

function _resizeOneSpectrum(canvas, ctx) {
  if (!canvas || !ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 0;
  const h = canvas.clientHeight || 0;
  // 元素仍隐藏或布局未计算时，不要把它压成 1×1，避免后续被拉伸成单点
  if (w < 1 || h < 1) return;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _resizeSpectrum() {
  _resizeOneSpectrum(mSpectrum, mSpectrumCtx);
  _resizeOneSpectrum(mSpectrumLyrics, mSpectrumLyricsCtx);
}

function _roundRect(ctx, x, y, w, h, r) {
  // 注意：不调用 beginPath()！由调用方在循环外统一 beginPath 一次，
  // 循环内只追加子路径，最后一次性 fill() —— 否则每根柱都 beginPath
  // 会清掉之前的路径，fill() 只画最后一根柱（频谱"只有一条"的根因）。
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}

function _hslToRgb(h, s, l) {
  h = ((((h % 360) + 360) % 360) / 360);
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * 为单根频柱生成渐变：纵向做暗→亮景深，横向根据柱子索引做色相偏移，
 * 让整段频谱不再是单一颜色。
 */
function _getStyleAccentRGB() {
  // 读取当前播放样式在 CSS 里定义的 --style-accent（与播放/暂停按钮同色），
  // 返回 [r,g,b]；读取失败则回退到专辑强调色，保证永远不会黑屏。
  try {
    const raw = getComputedStyle(document.body).getPropertyValue('--style-accent');
    const hex = (raw || '').trim();
    if (!hex) return _accentRGB;
    // 支持 #rgb / #rrggbb / #rgba / #rrggbbaa，以及 rgb()/rgba()/hsl() 等 CSS 颜色
    const s = document.createElement('span');
    s.style.color = hex;
    document.body.appendChild(s);
    const computed = getComputedStyle(s).color;
    document.body.removeChild(s);
    const m = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  } catch { /* noop */ }
  return _accentRGB;
}

/**
 * 为单根频柱生成渐变：以当前播放样式主题色（--style-accent，和播放/暂停按钮同色）为锚，
 * 纵向做暗→亮景深，横向按柱子索引做轻微色相偏移，让频谱既跟随样式又不过于单调。
 */
function _spectrumBarGradient(ctx, x, bw, bh, h, i, total, isLyrics) {
  const [baseR, baseG, baseB] = (() => {
    const [r, g, b] = _getStyleAccentRGB();
    const [hue, sat, lig] = _rgbToHsl(r, g, b);
    const p = i / (total - 1);
    // 左右做 ±25° 色相偏移，保留一点流动的彩虹感，但整体仍以主题色为中心
    const shift = -25 + 50 * p;
    return _hslToRgb(hue + shift, sat, lig);
  })();
  const yTop = Math.max(0, h - bh);
  const grad = ctx.createLinearGradient(x + bw / 2, h, x + bw / 2, yTop);
  const dark = `rgba(${Math.round(baseR * 0.45)}, ${Math.round(baseG * 0.45)}, ${Math.round(baseB * 0.45)}, 0.92)`;
  const mid = `rgba(${Math.round(baseR)}, ${Math.round(baseG)}, ${Math.round(baseB)}, 0.98)`;
  const light = `rgba(${Math.min(255, Math.round(baseR + (255 - baseR) * 0.55))}, ${Math.min(255, Math.round(baseG + (255 - baseG) * 0.55))}, ${Math.min(255, Math.round(baseB + (255 - baseB) * 0.55))}, 0.99)`;
  grad.addColorStop(0, dark);
  grad.addColorStop(0.5, mid);
  grad.addColorStop(1, light);
  return grad;
}

function _ensureSpectrumSize(canvas, ctx) {
  if (!canvas || !ctx) return false;
  const isLyrics = canvas.id === 'm-spectrum-lyrics';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let cw = canvas.clientWidth || 0;
  let ch = canvas.clientHeight || 0;
  // 歌词底部频谱：canvas 自身还没拿到布局尺寸时，用 wrapper 兜底；
  // wrapper 也没就绪时，用固定默认值 700x150，避免被压成 1×1 后拉伸成单点。
  if (isLyrics && cw < 1) {
    cw = (mSpectrumLyricsWrap && mSpectrumLyricsWrap.clientWidth) || 700;
  }
  if (isLyrics && ch < 1) {
    ch = (mSpectrumLyricsWrap && mSpectrumLyricsWrap.clientHeight) || 150;
  }
  // 布局未就绪时跳过绘制
  if (cw < 1 || ch < 1) return false;
  const wantW = Math.max(1, Math.round(cw * dpr));
  const wantH = Math.max(1, Math.round(ch * dpr));
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return true;
}

function _drawSpectrumBars(ctx, w, h, barHeights, isLyrics) {
  const gap = 1;                        // 更窄间隙，让柱子更密更细
  const pad = Math.min(w * 0.04, 20);   // 左右留白，让频柱整体居中不贴边
  const availW = Math.max(1, w - pad * 2);
  const bw = (availW - gap * (SPECTRUM_BARS - 1)) / SPECTRUM_BARS;
  ctx.save();
  // 统一阴影：使用当前播放样式主题色（和播放/暂停按钮同色），让频谱光晕也随样式同步
  const [sr, sg, sb] = _getStyleAccentRGB();
  ctx.shadowBlur = isLyrics ? 16 : 10;
  ctx.shadowColor = `rgba(${sr}, ${sg}, ${sb}, ${isLyrics ? 0.55 : 0.45})`;
  const minVisibleH = Math.max(3, h * 0.035); // 没有起伏的小能量柱直接不画
  for (let i = 0; i < SPECTRUM_BARS; i++) {
    // 真实频谱：不再叠加对称山形包络，柱高直接反映该频带能量（低频在左、高频在右）。
    const env = 1;
    const bh = Math.max(2, barHeights[i] * h * env);
    // 能量过低（静音/底噪/高频自然衰减到几乎没有）时不显示该柱，避免“没有起伏也有条”。
    if (bh < minVisibleH) continue;
    const x = pad + i * (bw + gap);
    const yTop = h - bh;
    // 每根柱子独立渐变：纵向暗→亮 + 横向按频率索引做色相偏移
    ctx.fillStyle = _spectrumBarGradient(ctx, x, bw, bh, h, i, SPECTRUM_BARS, isLyrics);
    ctx.beginPath();
    if (isLyrics) {
      // 歌词底部频谱：下粗上细的梯形柱，底部宽 bw，顶部宽约为 0.45*bw，
      // 让每根音柱看起来更有层次，不会像矩形那么呆板。
      const tw = bw * 0.45;             // top width
      const inset = Math.max(0, (bw - tw) / 2);
      ctx.moveTo(x, h);
      ctx.lineTo(x + bw, h);
      ctx.lineTo(x + bw - inset, yTop);
      ctx.lineTo(x + inset, yTop);
      ctx.closePath();
    } else {
      const r = Math.min(bw / 2, 1.5);  // 更尖锐的柱顶，视觉上更细
      _roundRect(ctx, x, yTop, bw, bh, r);
    }
    ctx.fill();
  }
  ctx.restore();
}

function _simulateSpectrumTarget() {
  // 无真实 FFT 时给一个舒缓的模拟波形，保证用户始终能看到频谱在动
  const t = performance.now() / 1000;
  const out = new Array(SPECTRUM_BARS);
  for (let i = 0; i < SPECTRUM_BARS; i++) {
    const p = i * 0.38 + t * 2.4;
    const v = 0.22
      + 0.28 * Math.sin(p)
      + 0.18 * Math.sin(p * 1.7 + 1.3)
      + 0.12 * Math.sin(p * 3.1 + 2.1);
    out[i] = Math.max(0.08, Math.min(0.85, v));
  }
  return out;
}

function _drawSpectrum() {
  const analyser = player && player.audio && player.audio.analyser;
  const playing = stage && stage.classList.contains('playing');
  let targets = null;
  let hasRealData = false;

  if (analyser && playing) {
    const bins = analyser.frequencyBinCount;
    if (!_freq || _freq.length !== bins) _freq = new Uint8Array(bins);
    analyser.getByteFrequencyData(_freq);

    targets = new Array(SPECTRUM_BARS);
    // 对数频率映射：每个柱代表（近似）一个倍频程带，比原二次映射更接近真实频谱观感——
    // 低频(左)天然偏高、高频(右)自然衰减，且不会把右侧压成全空。
    const logMin = 0;                  // log(1)
    const logMax = Math.log(bins);     // 最高有效 bin
    for (let i = 0; i < SPECTRUM_BARS; i++) {
      const f0 = Math.exp(logMin + (i / SPECTRUM_BARS) * (logMax - logMin));
      const f1 = Math.exp(logMin + ((i + 1) / SPECTRUM_BARS) * (logMax - logMin));
      const lo = Math.max(1, Math.floor(f0));
      const hi = Math.max(lo + 1, Math.floor(f1));
      let sum = 0, n = 0;
      for (let j = lo; j < hi && j < bins; j++) { sum += _freq[j]; n++; }
      const raw = n ? (sum / n) / 255 : 0;
      // 仅做轻度加压，保留真实频谱的“低频高、高频低”自然衰减，不做对称整形。
      // 不保留底噪（+0.02 已去掉）：静音时目标值真正归零，频谱才会“没有起伏就不显示”。
      targets[i] = Math.min(1, Math.pow(raw, 0.85) * 1.15);
    }
    // 轻量空间平滑（一遍 3-tap），避免相邻柱跳变过硬，但不再做对称弓形整形。
    {
      const prev = targets.slice();
      for (let i = 0; i < SPECTRUM_BARS; i++) {
        const l = i > 0 ? prev[i - 1] : prev[0];
        const r = i < SPECTRUM_BARS - 1 ? prev[i + 1] : prev[SPECTRUM_BARS - 1];
        targets[i] = (l + 2 * prev[i] + r) / 4;
      }
    }
    hasRealData = true;
  } else if (!analyser) {
    // 引擎没提供 analyser（极少见）：给一段模拟动画，避免完全空白
    targets = _simulateSpectrumTarget();
  } else {
    // 有 analyser 但暂停/无起伏：目标归零，峰值自然回落，频谱完全不显示
    targets = new Array(SPECTRUM_BARS).fill(0);
  }

  if (!_peaks || _peaks.length !== SPECTRUM_BARS) _peaks = new Float32Array(SPECTRUM_BARS);

  for (let i = 0; i < SPECTRUM_BARS; i++) {
    // 峰值缓动：上升更快(attack 0.30)让鼓点立刻砸出来，回落(decay 0.035)也更快，
    // 整体更跟拍、更贴近真实频谱的瞬态，不再"慢半拍"。
    const attack = hasRealData ? 0.30 : 0.10;
    const decay = hasRealData ? 0.035 : 0.014;
    if (targets[i] > _peaks[i]) {
      _peaks[i] += (targets[i] - _peaks[i]) * attack;
    } else {
      _peaks[i] -= decay;
    }
    // 去掉 0.04 的最低可见高度：静音/暂停时峰值可以真正衰减到 0，实现“没有起伏就不显示”。
    if (_peaks[i] < 0) _peaks[i] = 0;
  }

  _renderSpectrum(mSpectrumCtx, mSpectrum, false);
  _renderSpectrum(mSpectrumLyricsCtx, mSpectrumLyrics, true);
}

function _renderSpectrum(ctx, canvas, isLyrics) {
  if (!canvas || !ctx) return;
  // 该 canvas 当前未显示（display:none 或任意祖先隐藏）则跳过绘制，
  // 避免给隐藏画布做无意义的 FFT/Canvas 工作，减轻主线程压力。
  if (canvas.offsetParent === null) return;
  if (!_ensureSpectrumSize(canvas, ctx)) return;
  // 若 canvas 仍没拿到 CSS 布局尺寸（例如 wrapper 刚显示但一帧内还未回流），
  // 用 canvas 内部像素 / DPR 反推绘制尺寸，避免在 0×N 画布上作画导致音柱消失。
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = canvas.clientWidth || Math.round(canvas.width / dpr);
  let h = canvas.clientHeight || Math.round(canvas.height / dpr);
  if (w < 1 || h < 1) return;
  ctx.clearRect(0, 0, w, h);
  // 真实频谱：直接按“低频在左、高频在右”的原始顺序绘制，不做镜像/对称整形
  //（歌词底部频谱与主频谱一致，均反映真实频域能量分布）。
  const heights = _peaks;
  _drawSpectrumBars(ctx, w, h, heights, isLyrics);
}

function _startSpectrum() {
  if (!mSpectrum) { console.warn('[lumen][spec] _startSpectrum: mSpectrum 不存在'); return; }
  _setupSpectrum();
  if (!mSpectrumCtx) { console.warn('[lumen][spec] _startSpectrum: mSpectrumCtx 获取失败'); return; }
  _resizeSpectrum();
  if (_reducedMotion) { _drawSpectrum(); return; } // 静态画一次，不进 rAF
  if (_spectrumRAF) { console.warn('[lumen][spec] _startSpectrum: raf 已存在(' + _spectrumRAF + ')，跳过启动'); return; }
  const loop = () => { _drawSpectrum(); _spectrumRAF = requestAnimationFrame(loop); };
  _spectrumRAF = requestAnimationFrame(loop);
  console.log('[lumen][spec] _startSpectrum 已启动 raf=' + _spectrumRAF + ' ctx=' + !!mSpectrumCtx + ' lyricsCtx=' + !!mSpectrumLyricsCtx);
}

function _stopSpectrum() {
  if (_spectrumRAF) { cancelAnimationFrame(_spectrumRAF); _spectrumRAF = 0; }
}

/* ================= 封面取色（Apple Music 主色驱动） ================= */

/** 从封面 dataUrl 提取「鲜亮主色」：偏好中亮度 + 高饱和像素，避免被黑/白边角拉低。
 *  返回 [r,g,b] 或 null（跨域/解析失败）。data URL 同源，getImageData 不会被污染。 */
function extractAccent(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const sw = 36, sh = 36;
        const c = document.createElement('canvas');
        c.width = sw; c.height = sh;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, sw, sh);
        const data = cx.getImageData(0, 0, sw, sh).data;
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let i = 0; i < data.length; i += 4) {
          const R = data[i], G = data[i + 1], B = data[i + 2], A = data[i + 3];
          if (A < 16) continue;
          const lum = 0.299 * R + 0.587 * G + 0.114 * B;
          const maxc = Math.max(R, G, B), minc = Math.min(R, G, B);
          const sat = maxc === 0 ? 0 : (maxc - minc) / maxc;
          // 亮度越接近中值、饱和越高 → 权重越大（Apple Music 风格鲜亮主色）
          const w = (sat * sat) * (1 - Math.abs(lum - 140) / 255);
          r += R * w; g += G * w; b += B * w; wsum += w;
        }
        if (wsum <= 0) { resolve(null); return; }
        resolve([Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)]);
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/* ================= 歌词（Apple Music 风格） ================= */

function _prefersReducedMotion() {
  if (_reducedMotion === undefined) {
    _reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  return _reducedMotion;
}

/** 监听歌词视图包装器尺寸，把 .ms-lyrics 的上下内边距动态设为可视区高度的一半。
 *  这样 scrollIntoView({ block: 'center' }) 时，首句/末句也能真正居中，不会被 clamp 到顶/底。
 *  观察包装器而非 .ms-lyrics 本身，避免「改 padding → 触发 resize → 再改 padding」的循环。 */
function _setupLyricsResize() {
  if (!mLyrics || !mLyricsWrap || _lyricsResizeObserver) return;
  if (typeof ResizeObserver === 'undefined') return;
  try {
    _lyricsResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.round(entry.contentRect.height);
        // 最小保留 60px，避免隐藏态高度为 0 时 padding 塌成 0
        mLyrics.style.setProperty('--lyrics-pad', `${Math.max(60, Math.round(h / 2))}px`);
      }
      // 尺寸稳定后，若歌词视图展开且有高亮句，重新居中（歌词常显，无需 lyrics-on 条件）
      if (_lyricActiveIdx >= 0) {
        _syncLyrics(player && player.props ? (player.props['time-pos'] || 0) : 0, true);
      }
    });
    _lyricsResizeObserver.observe(mLyricsWrap);
  } catch { /* 降级：保留 CSS fallback */ }
}

function _loadLyrics(path, info) {
  if (!mLyrics) return;
  _clearLyrics();
  _currentLyricPath = path || '';
  _restoreLyricOffset(path);
  // 切换歌曲先清掉上一首的 credits，等本曲歌词（含 meta）加载完再填充
  _updateLyricsCredits(null, info);
  if (!path || !window.lumen || !window.lumen.getLyrics) return;
  Promise.resolve(window.lumen.getLyrics(path))
    .then((r) => {
      if (r && r.ok && Array.isArray(r.lines) && r.lines.length) {
        _buildLyricsWithCredits(r.lines, r.meta, info);
        if (!_lyricCreditsActive) _queryCredits(info); // 本地无词曲则在线补
        return;
      }
      // 本地无歌词：按配置自动从网络下载
      _tryDownloadLyrics(path, info);
    })
    .catch(() => _tryDownloadLyrics(path, info));
}

function _tryDownloadLyrics(path, info) {
  if (!window.lumen || !window.lumen.downloadLyrics) {
    _renderLyricsEmpty();
    return;
  }
  Promise.resolve(window.lumen.downloadLyrics(path, {
    title: info && info.title,
    artist: info && (info.artist || info.albumArtist),
    album: info && info.album,
    duration: info && info.duration,
  }))
    .then((r) => {
      if (r && r.ok && Array.isArray(r.lines) && r.lines.length) {
        _buildLyricsWithCredits(r.lines, r.meta, info);
        if (!_lyricCreditsActive) _queryCredits(info); // 本地无词曲则在线补
        _maybeAutoCalibrateLyricOffset(path); // 首加载自动校准歌词偏移（按曲目缓存）
      } else {
        _renderLyricsEmpty();
      }
    })
    .catch(() => _renderLyricsEmpty());
}

/** 无逐字时间戳时，按行跨度在字间均匀估算每个字的着色时刻（取字中心），
 *  让普通 LRC 也呈现「逐字点亮」而非整行平滑扫光。
 *  关键：着色跨度限制在「实际演唱时长」估算内（约 0.30s/字，下限 0.8s），
 *  避免被下一句前的大段静音间隙拖慢——否则 gold 扫光会一直拖到行末/下一句才完成，
 *  看起来像「唱完了才着色」。有逐字时间戳（Musixmatch）时此函数不生效。 */
function _estimateCharTimes(text, start, end) {
  const chars = Array.from(text);
  const n = chars.length;
  if (!n) return [];
  const rawSpan = Math.max(0.05, end - start);
  const sungSpan = Math.min(rawSpan, Math.max(0.8, n * 0.30));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = start + ((i + 0.5) / n) * sungSpan;
  return out;
}

function _buildLyrics(lines) {
  if (!mLyrics) return;
  // 仅移除上一轮渲染的歌词 DOM 行；credits 块已独立在滚动区外， unaffected。
  mLyrics.querySelectorAll('.ms-lyric-line, .ms-lyrics-empty').forEach((el) => el.remove());
  _lyricLines = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const t = Number(lines[i].time) || 0;
    // 每行结束时间 = 下一行开始时间（末行用 +10s 兜底，用于卡拉OK逐字进度计算）
    const end = (i + 1 < lines.length) ? (Number(lines[i + 1].time) || 0) : (t + 10);
    const text = lines[i].text || '♪';
    const el = document.createElement('div');
    el.className = 'ms-lyric-line';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    // 原歌词包进 .ms-lyric-text，使逐字高亮/放大只作用于原句，不被翻译子元素继承
    const textEl = document.createElement('div');
    textEl.className = 'ms-lyric-text';
    // 逐字高亮：每个字符包一层 span，播放进度推进时按时间比例点亮
    const chars = [];
    for (const ch of Array.from(text)) {
      const sp = document.createElement('span');
      sp.className = 'ms-lyric-char';
      sp.textContent = ch;
      textEl.appendChild(sp);
      chars.push(sp);
    }
    el.appendChild(textEl);
    // 翻译占位（默认隐藏，开启翻译后填充外语→中文）
    const transEl = document.createElement('div');
    transEl.className = 'ms-lyric-trans';
    el.appendChild(transEl);
    el.addEventListener('click', () => _seekToLyric(t));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { _seekToLyric(t); e.preventDefault(); }
    });
    frag.appendChild(el);
    // 逐字时间戳：优先用歌词源提供的精确 charTimes（逐字 LRC），否则按行跨度均匀估算。
    const charTimes = (Array.isArray(lines[i].charTimes) && lines[i].charTimes.length === chars.length)
      ? lines[i].charTimes
      : _estimateCharTimes(text, t, end);
    _lyricLines.push({ el, time: t, end, text, transEl, chars, charTimes, _sung: -1 });
  }
  mLyrics.appendChild(frag);
  // 标记歌词已就绪：让偏移/翻译工具条仅在「有歌词」时显示（空态不显示）。
  const wrap = document.getElementById('m-lyrics-wrap');
  if (wrap && lines.length) wrap.classList.add('has-lyrics');
  _setupLyricsResize();
  _maybeTranslateCurrent();
}

// 检查 lines 前部是否已经包含 credits 行（避免 LRC 自带 credits 时重复显示 credits 块）
function _hasCreditLines(lines) {
  return lines.slice(0, 6).some((l) => /^(作词|作曲|词|曲|编曲|制作人|和声|混音)[:：]/.test(String(l.text || '')));
}

// 渲染 credits 块并决定是否显示；若 LRC 已自带 credits 行则隐藏块，避免重复。
function _updateLyricsCredits(meta, info) {
  const creditsEl = document.getElementById('m-lyrics-credits');
  if (!creditsEl) return;
  meta = meta || {};
  const lrc = meta.credits || {};
  const tags = meta.tags || {};
  info = info || {};
  const map = [
    ['作词', lrc['词'] || tags.au || info.lyricist || info.writer],
    ['作曲', lrc['曲'] || tags.music || tags.co || info.composer],
    ['编曲', lrc['编曲'] || info.arranger],
    ['制作人', lrc['制作人']],
    ['和声', lrc['和声']],
    ['混音', lrc['混音']],
  ];
  const rows = map.filter(([, val]) => val);
  _lyricCreditsRows = [];
  // LRC 前部已自带 credits 行时，用歌词行展示即可，不再重复显示 credits 块
  if (rows.length && _hasCreditLines(_currentRawLines)) {
    creditsEl.hidden = true;
    creditsEl.classList.remove('faded');
    creditsEl.innerHTML = '';
    _lyricCreditsActive = false;
    return;
  }
  if (!rows.length) {
    creditsEl.hidden = true;
    creditsEl.classList.remove('faded');
    creditsEl.innerHTML = '';
    _lyricCreditsActive = false;
    return;
  }
  creditsEl.innerHTML = '';
  creditsEl.classList.remove('faded');
  for (const [label, val] of rows) {
    const row = document.createElement('div');
    row.className = 'ms-credit-row';
    row.dataset.role = { 作词: 'lyricist', 作曲: 'composer', 编曲: 'arranger', 制作人: 'producer', 和声: 'backing', 混音: 'mixing' }[label];
    const labelEl = document.createElement('span');
    labelEl.className = 'ms-credit-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'ms-credit-value';
    valueEl.textContent = String(val);
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    creditsEl.appendChild(row);
    _lyricCreditsRows.push({ el: row });
  }
  creditsEl.hidden = false;
  _lyricCreditsActive = true;
}

// 在 build 歌词前先渲染 credits 块，再渲染原始歌词行；保留原始 lines 供异步查询后重建。
function _buildLyricsWithCredits(lines, meta, info) {
  _currentRawLines = Array.isArray(lines) ? lines.slice() : [];
  _updateLyricsCredits(meta, info);
  _buildLyrics(_currentRawLines);
}

// 异步查询到 credits 后，仅刷新 credits 块内容（歌词行 unaffected）。
function _rebuildLyricsWithCredits(creditsMap, info) {
  _updateLyricsCredits({ credits: creditsMap || {} }, info);
}

// credits 块逐行跟随时间轴上色：把每个 .ms-credit-row 视为虚拟歌词行，
// 在 [0, 第一句歌词时间]（或 6 秒兜底）之间均匀分布，逐行绽放为已唱歌词同款渐变。
// seek 回开头时自动重置为暗色。
function _syncCredits(time) {
  const el = document.getElementById('m-lyrics-credits');
  if (!el) return;
  const count = _lyricCreditsRows.length;
  if (!_lyricCreditsActive || count === 0) {
    el.classList.remove('lit');
    _lyricCreditsRows.forEach(({ el: row }) => {
      row.classList.remove('lit');
      row.style.setProperty('--prog', '0');
    });
    return;
  }
  const firstTime = _lyricLines.length ? (_lyricLines[0].time + _lyricOffset) : 0;
  const windowSec = Math.min(Math.max(firstTime > 0 ? firstTime : 6, 3), 10);
  const step = windowSec / count;
  _lyricCreditsRows.forEach(({ el: row }, i) => {
    const start = i * step;
    const end = start + step;
    const prog = Math.max(0, Math.min((time - start) / (end - start), 1));
    row.style.setProperty('--prog', String(prog));
    row.classList.toggle('lit', prog > 0);
  });
  // 容器保留 .lit 作为「已开始绽放」的整体标记，便于 CSS 做额外兜底
  const started = time > 0;
  el.classList.toggle('lit', started);
}

function _clearLyrics() {
  if (mLyrics) {
    mLyrics.querySelectorAll('.ms-lyric-line, .ms-lyrics-empty').forEach((el) => el.remove());
  }
  _lyricLines = [];
  _lyricActiveIdx = -1;
  _currentRawLines = [];
  _lyricCreditsRows = [];
  // 清空歌词（含切歌瞬间/空态）时移除 has-lyrics，隐藏偏移工具条
  const wrap = document.getElementById('m-lyrics-wrap');
  if (wrap) wrap.classList.remove('has-lyrics');
  if (_lyricsResizeObserver) {
    try { _lyricsResizeObserver.disconnect(); } catch { /* noop */ }
    _lyricsResizeObserver = null;
  }
}

function _renderLyricsEmpty() {
  if (!mLyrics) return;
  _clearLyrics();
  _updateLyricsCredits(null, null);
  const el = document.createElement('div');
  el.className = 'ms-lyrics-empty';
  el.textContent = '暂无歌词';
  mLyrics.appendChild(el);
}

// 当前歌曲是否已有任何可显示的 credits（本地 LRC/ID3 或在线查询填充后更新）
let _lyricCreditsActive = false;
let _lyricCreditsRows = []; // { el } credits DOM 行，供 _syncCredits 逐行按时序点亮

/**
 * 本地 LRC/ID3 无词曲信息时，按 歌名 + 歌手 在线查询 MusicBrainz 补充词/曲/编曲。
 * 结果写入 localStorage 缓存（按 歌名|歌手），避免重复请求；任意失败静默降级。
 * @param {Object} info 当前曲目元信息
 */
const CREDITS_CACHE_KEY = 'lumen:credits:';
function _creditsCacheKey(title, artist) {
  const k = `${title || ''}|${artist || ''}`;
  try { return CREDITS_CACHE_KEY + btoa(unescape(encodeURIComponent(k))); } catch { return CREDITS_CACHE_KEY + 'default'; }
}
async function _queryCredits(info) {
  if (!info) return;
  const title = info.title || baseName(info.path);
  const artist = info.artist || info.albumArtist || '';
  if (!title && !artist) return;
  const pathNow = info.path; // 切歌竞态防护：查询返回时若已切歌则丢弃
  // 命中缓存则直接填充（按歌名|歌手）
  try {
    const cached = JSON.parse(localStorage.getItem(_creditsCacheKey(title, artist)) || 'null');
    if (cached && (cached.lyricist || cached.composer || cached.arranger || cached.producer || cached.backing || cached.mixing)) {
      if (pathNow && pathNow !== _currentLyricPath) return;
      _updateLyricsCredits({ credits: _creditsToMap(cached) }, info);
      _rebuildLyricsWithCredits(_creditsToMap(cached), info);
      return;
    }
  } catch { /* ignore */ }
  if (!window.lumen || !window.lumen.getCredits) return;
  try {
    const r = await window.lumen.getCredits(title, artist);
    if (r && r.ok && (r.lyricist || r.composer || r.arranger || r.producer || r.backing || r.mixing)) {
      if (pathNow && pathNow !== _currentLyricPath) return; // 已切歌，丢弃旧结果
      try { localStorage.setItem(_creditsCacheKey(title, artist), JSON.stringify(r)); } catch { /* ignore */ }
      _updateLyricsCredits({ credits: _creditsToMap(r) }, info);
      _rebuildLyricsWithCredits(_creditsToMap(r), info);
    }
  } catch { /* 任意失败静默降级，不影响歌词主流程 */ }
}

function _creditsToMap(r) {
  return {
    '词': r.lyricist || '',
    '曲': r.composer || '',
    '编曲': r.arranger || '',
    '制作人': r.producer || '',
    '和声': r.backing || '',
    '混音': r.mixing || '',
  };
}

function _seekToLyric(t) {
  if (player && player.command) player.command(['seek', t + _lyricOffset, 'absolute']);
}

/* ============ 歌词滚动 scrub：手动滚动/拖拽歌词控制播放进度 ============
   设计：歌词区默认由 _syncLyrics 自动跟随播放位置滚动。当用户主动滚轮/拖拽
   歌词时进入 scrub 态（暂停自动跟随），原生浏览歌词，实时把「对准中心的那句」
   高亮并展示时间轴轴；停手防抖提交 seek，空闲后恢复自动跟随。 */

// 找到滚动区垂直中心最贴近的那句歌词下标
function _lyricLineAtCenter() {
  if (!mLyrics || !_lyricLines.length) return -1;
  const cr = mLyrics.getBoundingClientRect();
  const center = cr.top + cr.height / 2;
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < _lyricLines.length; i++) {
    const r = _lyricLines[i].el.getBoundingClientRect();
    const c = r.top + r.height / 2;
    const d = Math.abs(c - center);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function _lyricScrubStart() {
  _lyricScrubbing = true;
  if (mLyricsWrap) mLyricsWrap.classList.add('scrubbing');
  if (_lyricScrubResume) { clearTimeout(_lyricScrubResume); _lyricScrubResume = null; }
}

// 实时更新对准行高亮 + 时间轴轴文本（滚动/拖拽过程中每个事件调用）
function _lyricScrubUpdate() {
  const idx = _lyricLineAtCenter();
  if (idx < 0) return;
  if (_lyricScrubLineEl && _lyricScrubLineEl !== _lyricLines[idx].el) {
    _lyricScrubLineEl.classList.remove('scrub-target');
  }
  _lyricScrubLineEl = _lyricLines[idx].el;
  _lyricScrubLineEl.classList.add('scrub-target');
  if (_lyricAxisTimeEl) {
    const tt = _lyricLines[idx].time + _lyricOffset;
    _lyricAxisTimeEl.textContent = fmtTime(tt, tt >= 3600);
  }
  // 防抖提交：停手 180ms 后才真正 seek，避免滚动过程中高频重启解码管线
  if (_lyricScrubTimer) clearTimeout(_lyricScrubTimer);
  _lyricScrubTimer = setTimeout(_lyricScrubCommit, 180);
}

// 提交 seek：跳到当前对准句的时间点，随后结束 scrub（空闲后恢复自动跟随）
function _lyricScrubCommit() {
  if (!_lyricScrubbing) return;
  const idx = _lyricLineAtCenter();
  if (idx >= 0 && player && player.command) {
    player.command(['seek', _lyricLines[idx].time + _lyricOffset, 'absolute']);
  }
  _lyricScrubEnd();
}

function _lyricScrubEnd() {
  if (_lyricScrubTimer) { clearTimeout(_lyricScrubTimer); _lyricScrubTimer = null; }
  if (_lyricScrubResume) clearTimeout(_lyricScrubResume);
  // 提交 seek 后播放位置已接近目标，留 2.6s 宽限：期间用户可继续滚动；超时再恢复自动跟随
  _lyricScrubResume = setTimeout(() => {
    _lyricScrubbing = false;
    if (mLyricsWrap) mLyricsWrap.classList.remove('scrubbing');
    if (_lyricScrubLineEl) { _lyricScrubLineEl.classList.remove('scrub-target'); _lyricScrubLineEl = null; }
  }, 2600);
}

function _bindLyricScrub() {
  if (_lyricScrubBound || !mLyrics) return;
  _lyricScrubBound = true;

  // 滚轮：歌词区独占滚轮（stopPropagation 阻止 input.js 全局滚轮命令），
  // 不 preventDefault → 容器原生滚动浏览歌词；scroll 事件驱动轴更新。
  mLyrics.addEventListener('wheel', (e) => {
    if (!player || !player.info || !_lyricLines.length) return;
    e.stopPropagation();
    _lyricScrubStart();
    _lyricScrubUpdate();
  }, { passive: true });

  // 容器滚动（滚轮/拖拽/原生）时，若处于 scrub 态则刷新对准行与时间轴
  mLyrics.addEventListener('scroll', () => {
    if (_lyricScrubbing) _lyricScrubUpdate();
  }, { passive: true });

  // 指针拖拽：在歌词区按下并移动即拖动歌词（手动滚动），松手提交 seek
  mLyrics.addEventListener('pointerdown', (e) => {
    if (!player || !player.info || !_lyricLines.length) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    _lyricDragY = e.clientY;
    _lyricDragMoved = false;
  });
  const onDragMove = (e) => {
    if (_lyricDragY == null || !mLyrics) return;
    const dy = e.clientY - _lyricDragY;
    if (!_lyricDragMoved && Math.abs(dy) < 5) return; // 未超阈值视为点按，不触发拖拽
    _lyricDragMoved = true;
    _lyricScrubStart();
    mLyrics.scrollTop -= dy;          // 手动滚动歌词
    _lyricDragY = e.clientY;
    _lyricScrubUpdate();
  };
  const onDragEnd = () => {
    if (_lyricDragY == null) return;
    const wasDrag = _lyricDragMoved;
    _lyricDragY = null;
    if (wasDrag) _lyricScrubCommit();
  };
  window.addEventListener('pointermove', onDragMove, { passive: true });
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

/* ================= 歌词翻译（外语歌词逐行译为中文） ================= */

// 若已开启翻译，则按当前歌曲路径懒加载翻译（命中 localStorage 缓存则直接用）
function _maybeTranslateCurrent() {
  if (!_translateOn || !_lyricLines.length) return;
  _fetchTranslations(_currentLyricPath);
}

async function _fetchTranslations(path) {
  if (!window.lumen || !window.lumen.translateLyrics) return;
  const originals = _lyricLines.map((l) => l.text);
  // 优先命中缓存（按路径 + 行数校验），避免重复请求
  const cacheKey = _lyricTransCacheKey(path);
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { /* ignore */ }
  // 仅当缓存含真实译文（至少一行非空）时才命中；否则「曾失败写入的空数组」会永久屏蔽翻译
  if (cached && Array.isArray(cached) && cached.length === originals.length && cached.some((t) => t)) {
    _applyTranslations(cached);
    return;
  }
  let res = null;
  try { res = await window.lumen.translateLyrics(originals, 'zh-CN'); } catch { return; }
  if (!res || !res.ok || !Array.isArray(res.translations)) return;
  if (res.failed) _showTranslateUnavailable();
  // 仅缓存含真实译文的批次；全空（失败或歌曲本就是中文）不缓存，便于网络恢复后重试
  if (res.translations.some((t) => t)) {
    try { localStorage.setItem(cacheKey, JSON.stringify(res.translations)); } catch { /* ignore */ }
  }
  _applyTranslations(res.translations);
}

// 翻译源全部不可达时的轻提示（网络受限兜底失败）。避免重复弹，4s 后自动复位
let _translateToastShown = false;
function _showTranslateUnavailable() {
  if (_translateToastShown || !stage) return;
  _translateToastShown = true;
  const el = document.createElement('div');
  el.className = 'ms-trans-toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = '翻译服务暂不可用（网络受限），外语歌词将无法显示译文';
  stage.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.remove(); _translateToastShown = false; }, 400);
  }, 4200);
}

function _applyTranslations(trans) {
  for (let i = 0; i < _lyricLines.length; i++) {
    const ln = _lyricLines[i];
    const t = (trans && trans[i]) || '';
    if (ln.transEl) {
      ln.transEl.textContent = t;
      ln.el.classList.toggle('has-trans', !!t);
    }
  }
}

function _toggleTranslation() {
  _translateOn = !_translateOn;
  try { localStorage.setItem(LYRIC_TRANSLATE_ON_KEY, _translateOn ? '1' : '0'); } catch { /* ignore */ }
  if (stage) stage.classList.toggle('translate-on', _translateOn);
  if (mLyricsTransBtn) mLyricsTransBtn.setAttribute('aria-pressed', _translateOn ? 'true' : 'false');
  if (_translateOn) _fetchTranslations(_currentLyricPath);
}

/** 依据播放时间逐行/逐字高亮并居中滚动（仅歌词视图展开时滚动，避免隐藏态布局抖动）。
 *  - 已唱过的行：整行点亮（.lit，纯白），不再缩放。
 *  - 当前行：整行 .lit，并按 charTimes 驱动 --prog 连续渐变扫光（金色），并放大。
 *  - 未到的行：暗色待唱（无 .lit）。
 *  支持 _lyricOffset 整体偏移：歌词文件时间戳 + offset = 实际生效时间。
 *  @param {number} time
 *  @param {boolean} [forceScroll] 为 true 时用于歌词视图刚打开时强制把当前句滚到中间。 */
function _syncLyrics(time, forceScroll = false) {
  _lastLyricTime = time;
  _syncCredits(time);
  if (!_lyricLines.length || !stage) return;
  let idx = -1;
  for (let i = 0; i < _lyricLines.length; i++) {
    if (_lyricLines[i].time + _lyricOffset <= time) idx = i; else break;
  }
  const changed = idx !== _lyricActiveIdx;
  _lyricActiveIdx = idx;
  // 逐行刷新高亮状态（过去=全亮，当前=逐字，未来=暗）
  for (let i = 0; i < _lyricLines.length; i++) {
    const ln = _lyricLines[i];
    if (i < idx) _applyLineState(ln, 'sung', time);
    else if (i === idx) _applyLineState(ln, 'active', time);
    else _applyLineState(ln, 'future', time);
  }
  // 仅行切换时转发到桌面歌词窗口（低频，避免每帧 IPC）
  if (changed) _forwardDesktopLyrics(idx);
  // credits 块独立于滚动歌词区；第一句歌词激活后淡出折叠，避免上下间距跳动。
  const creditsEl = document.getElementById('m-lyrics-credits');
  if (creditsEl) creditsEl.classList.toggle('faded', idx >= 0);
  // scrub 期间（用户手动滚动/拖拽歌词）不自动跟随，避免与用户操作打架。
  if (!mLyrics || !_lyricLines.length || _lyricScrubbing) return;
  // 统一把「当前句」或「第一句」居中。
  // 注意：这里必须用「只滚动 .ms-lyrics 自身」的受控滚动，绝不能用 el.scrollIntoView()。
  // scrollIntoView(block:'center') 在歌词靠后、容器内部无法完全居中时会沿祖先链继续滚动，
  // 把整个窗口（含巨幅彩胶盘）往上顶几像素，造成周期性的纵向上抖。
  const targetIdx = idx < 0 ? 0 : idx;
  const el = _lyricLines[targetIdx].el;
  const instant = forceScroll || _prefersReducedMotion();
  _scrollLyricsTo(el, instant ? 'auto' : (changed ? 'smooth' : 'auto'));
}

/** 仅滚动歌词容器自身，绝不牵连任何祖先（修复 scrollIntoView 把整窗顶起导致的纵向上抖）。
 *  用 getBoundingClientRect 计算相对位移再 scrollTo，确保只动 #m-lyrics 内部。 */
function _scrollLyricsTo(el, behavior) {
  const container = mLyrics;
  if (!container || !el || !el.isConnected) return;
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const delta = (eRect.top + eRect.height / 2) - (cRect.top + cRect.height / 2);
  if (Math.abs(delta) < 0.5) return;
  container.scrollTo({ top: container.scrollTop + delta, behavior });
}

/** 解析当前曲目元信息：优先模块缓存，缓存丢失时向主进程兜底查询并恢复缓存。 */
async function _resolveCurrentInfo() {
  if (_currentInfo) return _currentInfo;
  try {
    if (window.lumen && window.lumen.getCurrentInfo) {
      const info = await window.lumen.getCurrentInfo();
      if (info) _currentInfo = info;
      return info;
    }
  } catch { /* noop */ }
  return null;
}

function _buildDesktopMeta(info) {
  return info ? {
    title: info.title || baseName(info.path) || '',
    artist: info.artist || info.albumArtist || '',
    album: info.album || '',
  } : {};
}

/** 仅向桌面歌词窗口推送顶部元信息（无歌词行时，或打开窗口时立即刷新用）。 */
function _pushDesktopLyricsMeta() {
  if (!_desktopLyricsOn) return;
  _resolveCurrentInfo().then((info) => {
    if (!info) return;
    try {
      if (window.lumen && window.lumen.desktopLyricsUpdate) {
        window.lumen.desktopLyricsUpdate({
          line: '', next: '', trans: '',
          ..._buildDesktopMeta(info),
        });
      }
    } catch { /* noop */ }
  });
}

/** 把当前歌词行（含下一句与翻译）转发到桌面歌词独立窗口。仅在行切换时调用（低频）。
 *  若桌面歌词未开启则直接跳过；转发翻译文本（若有）由歌词窗口自行决定是否展示。
 *  元信息随歌词一并推送，并在缓存丢失时向主进程兜底查询。 */
async function _forwardDesktopLyrics(idx) {
  if (!_desktopLyricsOn) return;
  const ln = _lyricLines[idx];
  const info = await _resolveCurrentInfo();
  const meta = _buildDesktopMeta(info);
  if (!ln) {
    // 没有歌词行，仅推送元信息
    try {
      if (window.lumen && window.lumen.desktopLyricsUpdate) {
        window.lumen.desktopLyricsUpdate({ line: '', next: '', trans: '', ...meta });
      }
    } catch { /* noop */ }
    return;
  }
  const next = idx + 1 < _lyricLines.length ? (_lyricLines[idx + 1].text || '') : '';
  const trans = (ln.transEl && ln.transEl.textContent) || '';
  // 当前样式播放键色（--style-accent），供桌面歌词窗口逐字着色跟随
  let accent = '';
  try {
    accent = (getComputedStyle(document.body).getPropertyValue('--style-accent') || '').trim();
  } catch { /* noop */ }
  // 逐字数据：chars（每字文本）供桌面歌词窗口拆 span；lit（当前已唱字数）初始点亮
  let chars = null, lit = 0;
  if (ln.chars && ln.chars.length) {
    chars = ln.chars.map((c) => c.textContent || '');
    lit = ln.chars.filter((c) => c.classList.contains('lit')).length;
    _lastDesktopLit = lit; // 行切换重置去重值，下一字点亮时才会推送
  }
  try {
    if (window.lumen && window.lumen.desktopLyricsUpdate) {
      window.lumen.desktopLyricsUpdate({
        line: ln.text || '',
        next,
        trans,
        chars,
        lit,
        accent,
        ...meta,
      });
    }
  } catch { /* noop */ }
}

/** 桌面歌词逐字进度：当前行已唱字数变化时低频推送（字级 ~3Hz，非每帧） */
let _lastDesktopLit = -1; // 上次推送给桌面歌词的已唱字数（用于去重）
function _forwardDesktopProg(lit) {
  if (!_desktopLyricsOn) return;
  try {
    if (window.lumen && window.lumen.desktopLyricsUpdate) {
      window.lumen.desktopLyricsUpdate({ prog: lit });
    }
  } catch { /* noop */ }
}

/** 把 time 映射到当前行的 0~1 进度，基于 charTimes（字中心时刻）。
 *  连续插值，使渐变扫光可以「一点点着色」而非逐字跳变。 */
function _charTimesToProg(time, ct) {
  const n = (ct && ct.length) || 0;
  if (!n) return 0;
  if (time >= ct[n - 1]) return 1;
  if (time <= ct[0]) return 0;
  for (let i = 0; i < n - 1; i++) {
    if (time < ct[i + 1]) {
      const denom = ct[i + 1] - ct[i];
      const frac = denom > 0 ? (time - ct[i]) / denom : 0;
      return (i + frac) / n;
    }
  }
  return 1;
}

/** 按状态刷新单行高亮。仅在需要变更时写 DOM，避免每帧重排。
 *  - future：整行不点亮，清空扫光 --prog 与逐字 .lit 残留。
 *  - 已唱行（sung）：整行 .lit（由 CSS 渲染为纯白）。
 *  - 当前行（active）：整行 .lit，并由 charTimes 驱动 --prog 连续扫光（蓝色渐变），
 *    做到「一点点着色」而非逐字跳变。 */
function _applyLineState(ln, state, time) {
  if (!ln || !ln.el) return;
  const el = ln.el;
  const wantActive = state === 'active';
  if (el.classList.contains('active') !== wantActive) el.classList.toggle('active', wantActive);

  if (state === 'future') {
    if (el.classList.contains('lit')) el.classList.remove('lit');
    if (ln.chars) for (const ch of ln.chars) if (ch.classList.contains('lit')) ch.classList.remove('lit');
    if (ln.chars) for (const ch of ln.chars) if (ch.classList.contains('cur')) ch.classList.remove('cur');
    el.style.removeProperty('--prog');
    ln._sung = -1;
    return;
  }
  if (!el.classList.contains('lit')) el.classList.add('lit');
  if (!wantActive) {
    // 已唱过的行：整行纯白（CSS .lit:not(.active) 处理）。
    if (ln.chars) for (const ch of ln.chars) if (ch.classList.contains('lit')) ch.classList.remove('lit');
    if (ln.chars) for (const ch of ln.chars) if (ch.classList.contains('cur')) ch.classList.remove('cur');
    el.style.removeProperty('--prog');
    ln._sung = 1;
    return;
  }
  // 当前行：由 charTimes 连续驱动 --prog（平滑渐变扫光）+ 逐字点亮（跟唱）。
  const ct = ln.charTimes;
  const off = _lyricOffset;
  let prog = 1;
  const lt = time - off;
  if (ct && ct.length) {
    prog = _charTimesToProg(lt, ct);
  } else {
    const span = Math.min(Math.max(0.05, ln.end - ln.time), Math.max(0.8, (ln.chars ? ln.chars.length : 1) * 0.30));
    prog = Math.max(0, Math.min(1, (lt - ln.time) / span));
  }
  // 逐字点亮：唱到哪个字，哪个字亮（普通 LRC 无真实逐字时间时按估算 charTimes 推进）；
  // 最后亮起的字 = 当前正在唱的字（.cur 强调，制造「跟唱」焦点）
  let curIdx = -1;
  if (ln.chars && ln.chars.length) {
    for (let ci = 0; ci < ln.chars.length; ci++) {
      const chT = (ct && ct.length > ci) ? ct[ci] : null;
      const lit = chT != null ? lt >= chT : (ci / ln.chars.length) <= prog;
      if (ln.chars[ci].classList.contains('lit') !== lit) ln.chars[ci].classList.toggle('lit', lit);
      if (lit) curIdx = ci;
    }
    for (let ci = 0; ci < ln.chars.length; ci++) {
      const isCur = ci === curIdx;
      if (ln.chars[ci].classList.contains('cur') !== isCur) ln.chars[ci].classList.toggle('cur', isCur);
    }
  }
  const p = Math.round(prog * 1000) / 1000;
  if (p !== ln._sung) {
    el.style.setProperty('--prog', String(p));
    ln._sung = p;
  }
}

/** 歌词渐变扫光 rAF：在两次 time-pos 采样之间按墙钟时间插值推进当前句 --prog，
 *  使扫光连续无跳变；--prog 由 charTimes 驱动，贴合真实字时间。 */
function _startLyricRAF() {
  if (_lyricRAF) return;
  const tick = () => {
    _lyricRAF = requestAnimationFrame(tick);
    if (!player || !player.props) return;
    const paused = player.props.pause === true;
    const now = performance.now();
    if (paused) { _lastSampleAt = now; return; } // 暂停时冻结并重置基准，避免恢复后跳变
    if (_lyricActiveIdx < 0) return;
    const ln = _lyricLines[_lyricActiveIdx];
    if (!ln || !ln.el) return;
    const speed = player.props.speed || 1;
    // 优先用 worklet 消费时钟（真实播放位置、逐帧平滑），退化用 time-pos + 墙钟插值
    // ——time-pos 推送约 1Hz，插值逐字（0.3s/字）会累积误差造成「卡顿感」
    const mt = (player.audio && typeof player.audio.mediaTime === 'number') ? player.audio.mediaTime : NaN;
    const t = Number.isFinite(mt) ? mt : (_lastTimePos + ((now - _lastSampleAt) / 1000) * speed);
    const ct = ln.charTimes;
    const off = _lyricOffset;
    let prog = 1;
    const lt = t - off;
    if (ct && ct.length) {
      prog = _charTimesToProg(lt, ct);
    } else {
      const span = Math.min(Math.max(0.05, ln.end - ln.time), Math.max(0.8, (ln.chars ? ln.chars.length : 1) * 0.30));
      prog = Math.max(0, Math.min(1, (lt - ln.time) / span));
    }
    // 逐字点亮（与 _applyLineState 同步，rAF 插值期间持续推进）+ 当前字焦点
    let curIdx = -1, litCount = 0;
    if (ln.chars && ln.chars.length) {
      for (let ci = 0; ci < ln.chars.length; ci++) {
        const chT = (ct && ct.length > ci) ? ct[ci] : null;
        const lit = chT != null ? lt >= chT : (ci / ln.chars.length) <= prog;
        if (ln.chars[ci].classList.contains('lit') !== lit) ln.chars[ci].classList.toggle('lit', lit);
        if (lit) { curIdx = ci; litCount = ci + 1; }
      }
      for (let ci = 0; ci < ln.chars.length; ci++) {
        const isCur = ci === curIdx;
        if (ln.chars[ci].classList.contains('cur') !== isCur) ln.chars[ci].classList.toggle('cur', isCur);
      }
      // 桌面歌词逐字进度：已唱字数变化时低频推送（字级 ~3Hz）
      if (litCount !== _lastDesktopLit) {
        _lastDesktopLit = litCount;
        _forwardDesktopProg(litCount);
      }
    }
    const p = Math.round(prog * 1000) / 1000;
    if (p !== ln._sung && ln.el) {
      ln.el.style.setProperty('--prog', String(p));
      ln._sung = p;
    }
  };
  _lyricRAF = requestAnimationFrame(tick);
}

function _stopLyricRAF() {
  if (_lyricRAF) { cancelAnimationFrame(_lyricRAF); _lyricRAF = 0; }
}

/* ================= 歌词时间偏移（修正下载歌词与音频不同步） ================= */

const LYRIC_OFFSET_KEY = 'lumen:lyric-offset:';
const LYRIC_AUTO_KEY = 'lumen:lyric-auto:'; // 自动校准结果缓存（'skip' = 已手动接管/检测失败，不再跑 ffmpeg）

function _lyricAutoKey(path) {
  try { return LYRIC_AUTO_KEY + btoa(unescape(encodeURIComponent(path || ''))); } catch { return LYRIC_AUTO_KEY + 'default'; }
}

function _lyricOffsetKey(path) {
  try { return LYRIC_OFFSET_KEY + btoa(unescape(encodeURIComponent(path || ''))); } catch { return LYRIC_OFFSET_KEY + 'default'; }
}

function _restoreLyricOffset(path) {
  _lyricOffsetPath = path || '';
  _lyricOffset = 0;
  try {
    const raw = localStorage.getItem(_lyricOffsetKey(path));
    if (raw) _lyricOffset = Number(raw) || 0;
  } catch { /* localStorage 可能不可用 */ }
  _updateLyricOffsetDisplay();
}

function _saveLyricOffset() {
  try { localStorage.setItem(_lyricOffsetKey(_lyricOffsetPath), String(_lyricOffset)); } catch { /* ignore */ }
}

function _updateLyricOffsetDisplay() {
  if (!mLyricsOffset) return;
  const s = _lyricOffset.toFixed(1);
  mLyricsOffset.textContent = `${_lyricOffset >= 0 ? '+' : ''}${s}s`;
}

function _adjustLyricOffset(delta) {
  _lyricOffset = Math.round((_lyricOffset + delta) * 10) / 10;
  _saveLyricOffset();
  _updateLyricOffsetDisplay();
  // 用户手动修正后，标记自动校准为「已接管」，避免下次加载被自动值覆盖
  try { localStorage.setItem(_lyricAutoKey(_lyricOffsetPath), 'skip'); } catch { /* ignore */ }
  // 立即按新偏移重同步一次
  _syncLyrics(player && player.props ? (player.props['time-pos'] || 0) : 0);
}

/** 应用自动校准得到的偏移（覆盖当前偏移并持久化） */
function _applyLyricAutoOffset(off) {
  _lyricOffset = off;
  _saveLyricOffset();
  _updateLyricOffsetDisplay();
  _syncLyrics(player && player.props ? (player.props['time-pos'] || 0) : 0);
}

/** 若本曲目尚未自动校准过，则调用主进程 ffmpeg 检测首句起音并应用偏移。
 *  结果按曲目缓存；失败/无 ffmpeg 标记 'skip' 以免重复跑。 */
function _maybeAutoCalibrateLyricOffset(path) {
  try { if (localStorage.getItem(_lyricAutoKey(path)) != null) return; } catch { return; }
  if (!window.lumen || !window.lumen.lyricAutoOffset || !_lyricLines.length) return;
  const flt = _lyricLines[0].time || 0;
  Promise.resolve(window.lumen.lyricAutoOffset(path, flt))
    .then((r) => {
      const off = r && r.ok ? r.offset : null;
      try {
        if (off == null) { localStorage.setItem(_lyricAutoKey(path), 'skip'); return; }
        localStorage.setItem(_lyricAutoKey(path), String(off));
        _applyLyricAutoOffset(off);
      } catch { /* ignore */ }
    })
    .catch(() => { try { localStorage.setItem(_lyricAutoKey(path), 'skip'); } catch { /* ignore */ } });
}

/** 重新自动校准：清掉缓存后重跑（歌词区「自动」按钮触发） */
function _recalibrateLyricOffset(path) {
  try { localStorage.removeItem(_lyricAutoKey(path)); } catch { /* ignore */ }
  _maybeAutoCalibrateLyricOffset(path);
}

function _bindLyricsOffset() {
  if (!mLyricsWrap) return;
  mLyricsWrap.querySelectorAll('.mlo-btn[data-offset]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const delta = Number(btn.getAttribute('data-offset')) || 0;
      if (delta !== 0) _adjustLyricOffset(delta);
    });
  });
  const autoBtn = document.getElementById('m-btn-lyric-autosync');
  if (autoBtn) autoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _recalibrateLyricOffset(_lyricOffsetPath);
  });
}

function _bindLyrics() {
  if (_lyricsBound) return;
  _lyricsBound = true;
  // 歌词现已与封面同屏常显，不再需要「歌词开关」按钮；仅保留翻译开关绑定。
  if (mLyricsTransBtn) mLyricsTransBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleTranslation();
  });
}

/** 桌面歌词开关：持久化偏好 + 经 IPC 控制独立窗口，并立即把当前行推过去一次 */
function _toggleDesktopLyrics() {
  _desktopLyricsOn = !_desktopLyricsOn;
  try { localStorage.setItem(DESKTOP_LYRICS_ON_KEY, _desktopLyricsOn ? '1' : '0'); } catch { /* ignore */ }
  if (mBtnDesktopLyrics) mBtnDesktopLyrics.setAttribute('aria-pressed', _desktopLyricsOn ? 'true' : 'false');
  try {
    if (window.lumen && window.lumen.desktopLyricsToggle) {
      const p = window.lumen.desktopLyricsToggle();
      const after = () => {
        if (!_desktopLyricsOn) return;
        // 窗口刚打开时立即刷新一次：有歌词行则带歌词推送，否则仅推送元信息
        if (_lyricActiveIdx >= 0) _forwardDesktopLyrics(_lyricActiveIdx);
        else _pushDesktopLyricsMeta();
      };
      if (p && typeof p.then === 'function') p.then(after).catch(() => {}); else after();
    }
  } catch { /* noop */ }
}

/** 桌面歌词按钮 + 快捷键（d）绑定（一次性） */
function _bindDesktopLyrics() {
  if (mBtnDesktopLyrics) mBtnDesktopLyrics.addEventListener('click', () => _toggleDesktopLyrics());
  document.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('audio-mode')) return;
    if (e.key !== 'd' && e.key !== 'D') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    _toggleDesktopLyrics();
    e.preventDefault();
  });
}

/* ================= 系统媒体控制（MediaSession） ================= */
// 让系统媒体控制（锁屏 / 任务栏缩略图 / 键盘媒体键）认得 Lumora。
// 纯渲染端 Web API，不动音频管线；控制经共享 player 代理路由到活跃引擎。

let _msReady = false;

function _initMediaSession() {
  if (_msReady || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  _msReady = true;
  const ms = navigator.mediaSession;
  const setPause = (v) => { if (player && player.setProperty) { try { player.setProperty('pause', v); } catch { /* noop */ } } };
  const cmd = (args) => { if (player && player.command) { try { player.command(args); } catch { /* noop */ } } };
  try {
    ms.setActionHandler('play', () => setPause(false));
    ms.setActionHandler('pause', () => setPause(true));
    ms.setActionHandler('previoustrack', () => cmd(['playlist-prev']));
    ms.setActionHandler('nexttrack', () => cmd(['playlist-next']));
    ms.setActionHandler('seekbackward', (d) => cmd(['seek', -(d && d.seekOffset || 10)]));
    ms.setActionHandler('seekforward', (d) => cmd(['seek', (d && d.seekOffset || 10)]));
    ms.setActionHandler('seekto', (d) => { if (d && d.seekTime != null) cmd(['seek', d.seekTime, 'absolute']); });
  } catch { /* 个别浏览器不支持某些 action，忽略即可 */ }
}

function _updateMediaSessionMeta(info, artworkDataUrl) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    const artwork = [];
    if (artworkDataUrl) {
      const mime = (artworkDataUrl.split(';')[0].split(':')[1]) || 'image/png';
      artwork.push({ src: artworkDataUrl, sizes: '512x512', type: mime });
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: (info && info.title) || baseName(info && info.path) || '未知曲目',
      artist: (info && (info.artist || info.albumArtist)) || '',
      album: (info && info.album) || '',
      artwork,
    });
  } catch { /* ignore */ }
}

function _updatePositionState() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
  if (!player || !player.props) return;
  const d = player.props.duration || 0;
  const t = player.props['time-pos'] || 0;
  if (d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      position: Math.max(0, Math.min(t, d)),
      playbackRate: player.props.speed || 1,
    });
  } catch { /* ignore */ }
}

/* ================= 模式切换 ================= */

/** 进入音频模式：展示音乐舞台并填充曲目信息 + 异步拉取封面 */
export function enterAudioMode(info) {
  ensureRefs();
  // 进入音乐模式时（重新）应用上一次退出时保存的播放样式，保证「退出前样式」自动还原；
  // 此处兜底重应用，避免 initMusicStage 在 DOM 未就绪时提前返回导致样式类从未挂载。
  _applyPlayerStyle(_playerStyle);
  if (!stage) return;
  // 进入音乐模式：隐藏视频空态背景层（不透明黑层仅用于视频模式空态）
  const vib = document.getElementById('video-idle-bg');
  if (vib) vib.classList.remove('visible');
  // 允许 info 为空：首页「音乐」入口点击直接进入音乐模式空态（无文件），
  // 后续拖入/加载文件时 player:loaded 会再次以真实 info 调用，覆盖本空态。
  info = info || {};
  // 从首页返回后再进入音乐模式：若调用方没传 info 但播放器里仍挂着曲目（暂停保留），
  // 回退到 player.info，恢复封面/歌词/标题等，避免音乐在播但舞台一片空白。
  if (!info.path && !info.title && player && player.info) info = player.info;
  // 重置专辑主色与歌词状态（无封面时回落到主题默认色）
  if (stage) stage.style.removeProperty('--album-accent');
  _accentRGB = [124, 140, 255];
  _clearLyrics();
  // 隐藏 idle/媒体库屏：音乐舞台 z-index(20) 低于 idle(30)，不隐藏会被盖住
  setIdleMode(false, true);
  document.body.classList.add('audio-mode');

  const title = info.title || (info.path ? baseName(info.path) : '');
  const artist = info.artist || info.albumArtist || '';
  const album = info.album || '';
  if (elTitle) elTitle.textContent = title;
  if (elArtist) { elArtist.textContent = artist; elArtist.classList.toggle('empty', !artist); }
  if (elAlbum) { elAlbum.textContent = album; elAlbum.classList.toggle('empty', !album); }
  // 底部通栏左侧同步显示曲目信息（参考图：全宽通栏左侧 = 标题 + 艺人）
  if (mTrackTitle) mTrackTitle.textContent = title;
  if (mTrackArtist) { mTrackArtist.textContent = artist; mTrackArtist.classList.toggle('empty', !artist); }
  // 缓存当前元信息，供桌面歌词/MediaSession 复用
  _currentInfo = info;
  // 若桌面歌词已开启，立即把元信息推过去（避免页面重载后缓存丢失导致顶部空白）
  if (_desktopLyricsOn) _pushDesktopLyricsMeta();
  // 系统媒体控制元数据（封面稍后异步补）
  _updateMediaSessionMeta(info, null);
  // 当前曲目红心状态
  _currentLikePath = info.path || '';
  _refreshLikeButton();

  // 封面：异步拉取，token 防竞态（慢速解码不覆盖已切走的曲目）
  const token = ++_coverToken;
  if (_artistPhotoTimeout) { clearTimeout(_artistPhotoTimeout); _artistPhotoTimeout = null; }
  _artistPhotoPending = false;
  _artistPhotoUrl = '';          // 新曲目先清空旧写真
  // 保留 _coverDataUrl：返回首页再进入音乐模式时，用它「即时」恢复封面，
  // 避免先清掉封面再异步拉取期间露出深色兜底背景（#music-stage:not(.has-cover) 的暗渐变）
  // 与 .ms-cover 的暗色占位，出现"深色底 + 方角封面"的回退观感。
  if (_coverDataUrl) {
    applyCover(_coverDataUrl);   // 立即恢复上一首封面（has-cover + 背景图），异步刷新成功后会被覆盖
  } else {
    if (cover) cover.style.backgroundImage = '';
    if (backdrop) backdrop.style.backgroundImage = '';
    stage.classList.remove('has-cover');
  }
  try {
    if (window.lumen && window.lumen.getCoverArt) {
      Promise.resolve(window.lumen.getCoverArt(info.path))
        .then((r) => {
          if (token !== _coverToken) { _fallbackArtistPhotoBackdrop(); return; }
          // 新曲目确实无封面：清除旧封面，回落深色兜底（避免上一首封面残留）
          if (!r || !r.ok || !r.dataUrl) {
            _coverDataUrl = '';
            if (cover) cover.style.backgroundImage = '';
            if (backdrop) backdrop.style.backgroundImage = '';
            stage.classList.remove('has-cover');
            _fallbackArtistPhotoBackdrop();
            return;
          }
          applyCover(r.dataUrl);
          // 封面到位后补上 MediaSession 专辑图（锁屏/任务栏缩略图）
          _updateMediaSessionMeta(info, r.dataUrl);
          // 取封面主色驱动 --album-accent（进度/音量/频谱/光晕），同样受 token 保护
          extractAccent(r.dataUrl).then((rgb) => {
            if (token !== _coverToken || !rgb || !stage) return;
            const [cr, cg, cb] = rgb;
            stage.style.setProperty('--album-accent', `rgb(${cr}, ${cg}, ${cb})`);
            _accentRGB = [cr, cg, cb];
          });
        })
        .catch(() => { /* 无封面则保留兜底渐变 */ });
    }
  } catch { /* ignore */ }

  // 艺人写真：异步拉取，仅用于歌词优先等需要写真背景的样式；失败/超时回退专辑封面
  _artistPhotoPending = true;
  try {
    if (window.lumen && window.lumen.getArtistPhoto) {
      Promise.resolve(window.lumen.getArtistPhoto(info.artist || info.albumArtist || ''))
        .then((r) => {
          if (token !== _coverToken) { _fallbackArtistPhotoBackdrop(); return; }
          if (!r || !r.ok || !r.dataUrl) { _fallbackArtistPhotoBackdrop(); return; }
          applyArtistPhoto(r.dataUrl);
        })
        .catch(() => { _fallbackArtistPhotoBackdrop(); });
      // 网络卡顿或取不到时，不要一直黑底，2.5s 后降级到专辑封面
      _artistPhotoTimeout = setTimeout(() => {
        if (_artistPhotoPending) _fallbackArtistPhotoBackdrop();
      }, 2500);
    } else {
      _artistPhotoPending = false;
    }
  } catch { _artistPhotoPending = false; }

  // 歌词：异步载入（默认隐藏，点歌词按钮或按 L 展开）；本地无歌词时自动联网下载
  _loadLyrics(info.path, info);

  // 载入即自动播放，默认视为播放中；pause 事件到来会校正
  let paused = player && player.props && player.props.pause === true;
  // 进入音乐模式：若此前因返回首页而暂停（playlist 仍有曲目、位置已保留），
  // 则自动续播，而不是停在暂停态。新加载的曲目通常 pause=false，不会误触。
  if (paused && player && player.setProperty) {
    try { player.setProperty('pause', false); paused = false; } catch { /* noop */ }
  }
  setPlaying(!paused);
  _syncPlayIcons(paused);
  // 进入时立即同步一次进度/音量/音频质量（属性可能已经变化）
  _paintProgress();
  _paintVolume();
  _paintQuality();

  stage.classList.remove('hidden');
  stage.setAttribute('aria-hidden', 'false');

  // 启动频谱可视化（rAF 循环；暂停/无 analyser 时自动画基线）
  _startSpectrum();
  // 舞台刚从 hidden 切出，布局可能尚未稳定；延迟再强制重设一次尺寸
  setTimeout(() => { _resizeSpectrum(); _drawSpectrum(); }, 120);
  // 启动歌词扫光插值（保证卡拉OK渐变擦除丝滑）
  _startLyricRAF();
}

function applyCover(dataUrl) {
  ensureRefs();
  _coverDataUrl = dataUrl || '';
  if (cover) cover.style.backgroundImage = `url("${dataUrl}")`;
  // 歌词优先样式优先使用艺人写真；写真仍在获取时先保持暗色占位，
  // 避免出现"先专辑封面 → 再跳换写真"的闪烁；其他样式/无写真时回退专辑封面
  if (backdrop && !(_playerStyle === 'lyrics' && _artistPhotoPending)) {
    backdrop.style.backgroundImage = `url("${_currentBackdropUrl()}")`;
  }
  if (stage) stage.classList.add('has-cover');
}

function applyArtistPhoto(dataUrl) {
  ensureRefs();
  _artistPhotoUrl = dataUrl || '';
  _artistPhotoPending = false;
  if (_artistPhotoTimeout) { clearTimeout(_artistPhotoTimeout); _artistPhotoTimeout = null; }
  if (backdrop) backdrop.style.backgroundImage = `url("${_currentBackdropUrl()}")`;
}

function _currentBackdropUrl() {
  if (_playerStyle === 'lyrics' && _artistPhotoUrl) return _artistPhotoUrl;
  return _coverDataUrl;
}

/** 写真获取失败/超时时，对歌词优先样式回退到专辑封面 */
function _fallbackArtistPhotoBackdrop() {
  _artistPhotoPending = false;
  if (_artistPhotoTimeout) { clearTimeout(_artistPhotoTimeout); _artistPhotoTimeout = null; }
  if (backdrop && _playerStyle === 'lyrics') {
    backdrop.style.backgroundImage = `url("${_currentBackdropUrl()}")`;
  }
}

/** 退出音频模式：隐藏舞台、恢复视频态 */
export function exitAudioMode() {
  ensureRefs();
  if (!stage) return;
  _stopSpectrum();
  _stopLyricRAF();
  _clearLyrics();
  if (stage) stage.classList.remove('lyrics-on');
  // 诊断：仅在"确实正在隐藏一个已激活的音乐舞台"时打印调用栈，
  // 便于定位任何在 enterAudioMode 之后又意外 exitAudioMode 的竞态（曾导致黑屏不显示）。
  const wasAudio = document.body.classList.contains('audio-mode');
  document.body.classList.remove('audio-mode');
  stage.classList.add('hidden');
  if (wasAudio) console.warn('[lumen][stage] exitAudioMode 隐藏音乐舞台，调用栈:\n' + (new Error().stack || 'n/a'));
  stage.setAttribute('aria-hidden', 'true');
  stage.classList.remove('has-cover', 'playing');
  // 退出音频模式：清空系统媒体控制元数据，避免锁屏残留上一首
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch { /* noop */ }
  }
  // 退出音频模式：取消未到期的睡眠定时，避免后台静默暂停
  _cancelSleep();
  // 退出音频模式：顺手关闭均衡器面板(其按钮仅音频模式可见)
  closeEqPanel();
  _coverToken++; // 作废任何进行中的封面回调
  // 注意：保留 _coverDataUrl，不在退出时清空。返回首页再进入音乐模式时，
  // enterAudioMode 会用它「即时」恢复上一首封面，避免露出深色兜底背景（见 enterAudioMode）。
  // 仅在切换到确实无封面的新曲目时，才在 enterAudioMode 的 getCoverArt 回调里清空。
  _artistPhotoUrl = '';
  _artistPhotoPending = false;
  if (_artistPhotoTimeout) { clearTimeout(_artistPhotoTimeout); _artistPhotoTimeout = null; }
  if (cover) cover.style.backgroundImage = '';
  if (backdrop) backdrop.style.backgroundImage = '';
}

export function setPlaying(playing) {
  ensureRefs();
  if (!stage) return;
  stage.classList.toggle('playing', !!playing);
  // 同步系统媒体控制播放状态（锁屏 / 任务栏缩略图 / 媒体键）
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch { /* noop */ }
  }
}

function _syncPlayIcons(paused) {
  if (mIconPlay) mIconPlay.classList.toggle('hidden', !paused);
  if (mIconPause) mIconPause.classList.toggle('hidden', paused);
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}
