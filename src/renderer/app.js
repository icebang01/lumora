/**
 * 渲染进程入口。
 *
 * 这里只做三件事：把模块装配起来、把输入事件翻译成命令、把状态变化
 * 反馈给用户。所有真正的播放逻辑都在 Player 里，所有画质处理都在
 * VideoRenderer 里 —— 这个文件不该出现任何"怎么播"的知识。
 *
 * 输入的单一入口原则：键盘、鼠标、OSC 按钮、用户脚本、外部 IPC，
 * 五条路径最终都汇聚到 runCommand()。想加一个新操作，只需要加一条
 * 命令，五个入口自动全都支持。
 */

import { KeybindManager } from './ui/keys.js';
import { Osd } from './ui/osd.js';
import { Osc } from './ui/osc.js';
import { StatsPanel } from './ui/stats.js';
import { KeymapPanel } from './ui/keymap.js';
import { ScriptHost } from './scripting.js';
import { DanmakuRenderer } from './core/danmaku-renderer.js';
import { initAiPanel } from './ui/ai-panel.js';
import { setupLicensesPanel, toggleLicenses, isLicensesVisible } from './panels/licenses.js';
import { setupContextMenu, openContextMenu, closeContextMenu, isCtxMenuOpen } from './panels/context-menu.js';
import { setupSubSearchPanel, setupSubtitlesPanel, toggleSubSearch, isSubSearchVisible, runSubAutoMatch } from './panels/subtitles.js';
import { setupDanmakuPanel, setupDanmakuPanelUi, toggleDanmaku, isDanmakuVisible, restoreDanmakuDisplay } from './panels/danmaku.js';
import { setupSettingsPanel, setupSettingsPanelUi, toggleSettings, isSettingsVisible, isSetSelectOpen,
  closeSetSelect, applyTheme, initTheme } from './panels/settings.js';
import { setupIdlePanel, setIdleMode, showLoadingScreen, endFirstFrameWait,
  showResumeCard, bindLibrary, bindResumeCard, bindPlaylistPanel, bindHomeButton,
  bindIdleCloseButton, bindIdleActions, clearLoadingState } from './panels/idle.js';
import { setupPlaylistPanel, renderPlaylist, togglePlaylistPanel, closePlaylistPanel } from './panels/playlist.js';
import { setupEqPanel } from './panels/eq.js';
import { setupCast, toggleCastPanel, closeCastPanel, isCastVisible } from './panels/cast.js';
import { createVideoPlayer } from './player/video-player.js';
import { createMusicPlayer } from './player/music-player.js';
import { setupInput, bindInput, bindDragDrop, bindAudioUnlock, bindClickToFront } from './input.js';
import { setupAudioUnlock, bindAudioUnlockOverlay } from './panels/audio-unlock.js';
import { setupDiagnostics, exposeDiagnostics, setupDebug } from './app-diagnostics.js';
import { setupMainEvents, bindMainEvents } from './app-events.js';
import { enterAudioMode, exitAudioMode } from './ui/music-stage.js';
import { resolveGamutMatrix, edidPrimaries } from './gl/display-profile.js';

const $ = (id) => document.getElementById(id);

let osd, osc, stats, keymap, scripts;
// 双播放器模块：视频引擎（mpv/ffmpeg/MF）+ 音乐引擎（ffmpeg 纯音频）。
// player 是「活跃引擎」的代理：载入时按来源在 video / music 间切换。
let videoPlayer = null;         // 视频播放器模块实例
let musicPlayer = null;         // 音乐播放器模块实例（ffmpeg 纯音频）
let activeEngine = null;        // 当前活跃引擎（videoPlayer.engine / musicPlayer.engine）
let player = null;              // 活跃引擎代理（共享 UI：OSC / 统计 / 脚本 / 主事件访问）
// 注意：player 代理必须在所有 setup*Panel 调用之前创建。
// 各面板在 boot() 早期以 { player } 快照拿到这一代理，其 get 懒读取 activeEngine，
// 因此即便此刻 activeEngine 仍为 null，待 220 行赋值后所有面板即可实时访问真实引擎。
// 双引擎切换（视频↔音乐）经 setActiveEngine 改写 activeEngine，代理自动跟随。
player = new Proxy({}, {
  get(_, k) {
    const e = activeEngine;
    if (!e) return undefined;
    return typeof e[k] === 'function' ? e[k].bind(e) : e[k];
  },
});
let danmakuRenderer = null;     // 弹幕 Canvas2D 渲染层实例

/**
 * 显示色彩管理·自动模式：读取显示器 EDID 实测色域并应用到渲染端。
 * 任何失败（非 Windows / 无显示器 / IPC 异常）都静默跳过 —— 渲染端
 * 此时保留 sRGB 单位阵假设，与改动前行为一致。
 */
async function applyAutoDisplayProfile() {
  if (!player || !player.renderer || !player.renderer.setDisplayMatrix) return;
  const prof = await window.lumen.getDisplayProfile();
  if (!prof || prof.error) return; // 回退 sRGB（单位阵）
  const mat = resolveGamutMatrix('custom', edidPrimaries(prof));
  if (mat) player.renderer.setDisplayMatrix(mat);
}
let keybinds = new KeybindManager();
let bootstrapData = null;
let ready = false;              // 初始化期间不弹 OSD
// 双播放列表：视频模式 / 音乐模式 各自独立（用户需求：不通用）。
// _modePlaylists 持有两份真实数组，playlist 仅作为「当前模式」的视图别名
// （引用语义，保证 playlist.js / idle.js 的 Proxy 始终跟随活跃列表）。
let _modePlaylists = { video: [], audio: [] };
let _modeIndexes = { video: -1, audio: -1 };
let playlist = _modePlaylists.video;
let playlistIndex = -1;

// 当前播放列表所属模式：音乐模式(audio-mode) 用音乐列表，其余（视频 / idle）用视频列表。
function _pmode() {
  return document.body.classList.contains('audio-mode') ? 'audio' : 'video';
}
// 文件类型 → 列表模式（音频文件归音乐列表，其余归视频列表）。
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|wma|ogg|opus|ac3|dts|eac3|mka|ape|tta|tak|alac|wv)$/i;
function _modeForPath(p) { return AUDIO_EXT.test(String(p || '')) ? 'audio' : 'video'; }
// 写某一模式的列表（原地替换数组内容，保持数组对象引用稳定，Proxy 不会失效）。
function _writeMode(mode, paths, index) {
  const arr = _modePlaylists[mode];
  const items = paths.slice();
  arr.length = 0;
  for (const p of items) arr.push(p);
  _modeIndexes[mode] = index;
  if (mode === _pmode()) { playlist = arr; playlistIndex = index; }
}
// 切歌 / 定位时更新当前模式索引（同时同步到 _modeIndexes，保证持久化正确）。
function setActiveIndex(i) {
  playlistIndex = i;
  _modeIndexes[_pmode()] = i;
}

// 网络串流弹窗拖拽状态
let nsDragState = null;
let nsUserMoved = false;

/* ================================================================== */
/* 启动                                                                */
/* ================================================================== */

/**
 * 拖拽状态现在完全由主进程用 move-storm 判定（见 src/main/index.js 第二十八轮），
 * 渲染端无需任何参与，故此处不再有 setupTitlebarDrag。
 */

async function boot() {
  try {
    bootstrapData = await window.lumen.bootstrap();
  } catch (err) {
    return fatal('无法与主进程通信', err.message);
  }

  osd = new Osd($('osd'), $('osd-center'));
  // 启动静默窗口：mpv 启动后会推送全部初始属性（volume/mute/speed/loop-file…），
  // 各观察者会因此闪现"音量/静音/循环"等 OSD 图标与消息。窗口期内抑制，
  // 用户启动后看到的落地页保持干净（1.5s 足够覆盖 mpv 初始推送）。
  osd.startSilentWindow(1500);

  // 合规面板独立于播放后端，尽早初始化（即使 mpv 后端失败也应可用）
  setupLicensesPanel({
    closeOverlays: () => {
      if (isSettingsVisible()) toggleSettings(false);
      if (keymap && keymap.visible) toggleKeymap(false);
    },
  });
  setupIdlePanel({ player, osd, returnHome, load, openDialog, openNetworkStream, toggleSettings, getPlaylist: () => playlist, getPlaylistIndex: () => playlistIndex, playlistGoto, persistPlaylist, enterAudioMode, enterVideoMode });
  setupPlaylistPanel({
    player, osd,
    getPlaylist: () => playlist,
    getPlaylistIndex: () => playlistIndex,
    setPlaylistIndex: (i) => { playlistIndex = i; _modeIndexes[_pmode()] = i; },
    playlistGoto,
    playlistRemove,
    persistPlaylist,
  });
  _initPlaylistModeSync();
  setupEqPanel({ player });
  setupCast({ player, osd });
  window.takeScreenshotSequence = takeScreenshotSequence;
  window.takeScreenshot = takeScreenshot;
  window.toggleCast = toggleCastPanel;
  setupSettingsPanel({
    player, osd,
    keybinds,
    getBootstrapData: () => bootstrapData,
    getScripts: () => scripts,
    getKeymap: () => keymap,
  });
  setupSettingsPanelUi();
  initTheme();
  setupSubSearchPanel();
  setupSubtitlesPanel({
    player, osd,
    closeOthers: () => {
      if (isSettingsVisible()) toggleSettings(false);
      if (isLicensesVisible()) toggleLicenses(false);
    },
  });
  setupDanmakuPanel({
    player, osd,
    getBootstrapData: () => bootstrapData,
    getDanmakuRenderer: () => danmakuRenderer,
    closeOthers: () => {
      if (isSettingsVisible()) toggleSettings(false);
      if (isLicensesVisible()) toggleLicenses(false);
      if (isSubSearchVisible()) toggleSubSearch(false);
    },
  });
  setupDanmakuPanelUi();
  initAiPanel();

  // 弹幕渲染层：全窗口 Canvas，独立于播放后端。立即实例化以便随时载入。
  danmakuRenderer = new DanmakuRenderer(document.getElementById('danmaku-canvas'));
  // 实例化后再恢复已保存的弹幕显示参数（此时 danmakuRenderer 才存在）
  restoreDanmakuDisplay();

  // 弹幕自驱动渲染循环：每帧读取当前媒体时间喂给渲染层。
  // 与播放器自身 rAF 解耦，保证暂停时弹幕冻结、seek 时重排都由同一 now 决定。
  const danmakuLoop = () => {
    if (danmakuRenderer && danmakuRenderer.enabled) {
      danmakuRenderer.render(player ? (player.props['time-pos'] || 0) : 0);
    }
    requestAnimationFrame(danmakuLoop);
  };
  requestAnimationFrame(danmakuLoop);

  // 装配两个独立播放器模块（见 player/）：
  //   video-player.js —— 视频引擎（mpv/ffmpeg/mediafoundation）+ 视频反馈 + 质量徽章 + 加载遮罩
  //   music-player.js —— 音乐引擎（ffmpeg 纯音频）+ 音频舞台（封面/歌词/唱片）
  // 每个模块自持引擎；共享 UI（OSC/统计/脚本）经 player 代理指向「活跃引擎」，
  // 加载时按来源在 video / music 间切换（见 app-events player:loaded）。
  try {
    videoPlayer = await createVideoPlayer(bootstrapData, {
      osd,
      runCommand,
      getReady: () => ready,
      onEof: (detail) => handleEof(detail),
      onPlaylistNext: () => playlistJump(1),
      onPlaylistPrev: () => playlistJump(-1),
      onShowPlaylist: () => showPlaylist(),
      onLoadfile: (path) => load(path),
      onScriptBinding: (name) => {
        if (!scripts.triggerBinding(name) && name !== 'console') {
          osd.message('未注册的脚本绑定', name);
        }
      },
      onScreenshot: (mode) => takeScreenshot(mode),
    });
  } catch (err) {
    console.error(err);
    return fatal('播放器初始化失败', err.message);
  }
  // 音乐引擎：恒为 ffmpeg 纯音频后端（即使 config.engine=mpv，音乐也不走 mpv）。
  // 初始化失败不阻断视频引擎——视频仍可用，仅音乐退化提示。
  try {
    musicPlayer = await createMusicPlayer(bootstrapData, {
      runCommand,
      getReady: () => ready,
      onEof: (detail) => handleEof(detail),
      onPlaylistNext: () => playlistJump(1),
      onPlaylistPrev: () => playlistJump(-1),
    });
  } catch (err) {
    console.error('[lumen] 音乐引擎初始化失败:', err);
    osd.message('音乐引擎初始化失败', err.message, { duration: 5000, force: true });
  }
  // 交叉淡入淡出：副声部提升为主声部时，推进播放列表索引并链式预滚再下一首，
  // 保证连续接歌也无缝（仅音乐引擎产生该事件）。
  if (musicPlayer && musicPlayer.engine) {
    musicPlayer.engine.addEventListener('crossfade-committed', () => {
      const next = nextPlaylistIndex(1);
      if (next >= 0) {
        setActiveIndex(next);
        persistPlaylist();
        renderPlaylist();
      }
      maybeStartCrossfade();
    });
  }
  // 活跃引擎：载入时按来源切换（视频 ↔ 音乐）。player 代理已在文件顶部声明区先行创建，
  // 此处只需把活跃引擎指向视频引擎，所有共享 UI（含各面板经 { player } 快照持有的同一代理）
  // 即实时生效；各引擎自身订阅在创建时已绑定，无需重订阅。
  activeEngine = videoPlayer.engine;

  // 显示色彩管理：display-gamut=auto 时读取显示器 EDID 实测色域，
  // 让渲染端把内容换算到真实显示器色域（失败则保留 sRGB 单位阵假设）。
  if ((bootstrapData.config.values['display-gamut'] || 'auto') === 'auto') {
    applyAutoDisplayProfile().catch((e) => console.warn('[lumen][cm] EDID 自动探测跳过:', e && e.message || e));
  }

  // 视频输出/应用级命令反馈已内化到 player 模块（video-player.js）

  keybinds.load(bootstrapData.config.keybinds);

  osc = new Osc(player, osd, bootstrapData.config.values, keybinds);
  setupContextMenu({
    runCommand, player, osd,
    getLoopMode: () => loopMode,
    setLoopMode,
    togglePlaylistPanel, returnHome, openDialog, openNetworkStream,
    toggleSettings, toggleKeymap, toggleLicenses,
    takeScreenshot, takeScreenshotSequence,
  });
  stats = new StatsPanel($('stats-panel'), player, bootstrapData);

  // 根据配置立即显隐 OSC
  document.body.classList.toggle('no-osc', !bootstrapData.config.values.osc);
  keymap = new KeymapPanel($('keymap-panel'), $('keymap-body'), $('keymap-close'), () => {
    document.body.classList.remove('keymap-open');
  }).load(bootstrapData.config.keybinds);

  scripts = new ScriptHost(player, osd, keybinds, runCommand);
  scripts.attachIpc();
  await scripts.loadUserScripts();

  // 播放器反馈（属性观察/质量徽章/音频舞台）已内化到各 player 模块；
  // 初始舞台：默认视频模块
  videoPlayer.applyStage();
  setupMainEvents({
    player, osd,
    getEngine: (source) => (source === 'music' && musicPlayer ? musicPlayer.engine : videoPlayer.engine),
    getMusicEngine: () => (musicPlayer ? musicPlayer.engine : null),
    getActiveEngine: () => activeEngine,
    setActiveEngine: (e) => { activeEngine = e; },
    getPlaylist: () => playlist,
    getReady: () => ready,
    getPlaylistIndex: () => playlistIndex,
    setPlaylistIndex: (v) => { playlistIndex = v; _modeIndexes[_pmode()] = v; },
    getDanmakuRenderer: () => danmakuRenderer,
    setPlaylist, persistPlaylist, appendToPlaylist, load, runCommand, warnNoVideoOutput,
  });
  bindMainEvents();
  // 每次音乐曲目载入后，若启用交叉淡入淡出则预滚下一首音频头。
  // 注册在 setupMainEvents 之后：app-events 的同名处理器会先 setActiveEngine(音乐引擎)，
  // 保证此处 maybeStartCrossfade 的 activeEngine 守卫在首曲载入时也能正确放行。
  window.lumen.on('player:loaded', (payload) => {
    if (payload && payload.source === 'music') maybeStartCrossfade();
  });
  setupInput({ player, osd, osc, keybinds, keymap, runCommand, openDialog, toggleKeymap, setPlaylist, load,
    getPlaylist: () => playlist, getPlaylistIndex: () => playlistIndex, appendToPlaylist,
    getConfig: () => bootstrapData.config.values });
  setupAudioUnlock({ player });
  bindInput();
  bindAudioUnlock();
  bindAudioUnlockOverlay();
  bindClickToFront();

  // 诊断：枚举 Chromium 能看到的音频输出设备，确认运行环境是否真的有可用声卡。
  // 这是纯 Web API，不依赖任何被沙箱禁用的系统工具，是最干净的设备证据。
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then((devs) => {
        const outs = devs.filter((d) => d.kind === 'audiooutput');
        const ins = devs.filter((d) => d.kind === 'audioinput');
        console.log('[lumen][diag] 音频输出设备数=' + outs.length + ' 输入设备数=' + ins.length);
        outs.forEach((d, i) => {
          const label = d.label || (d.deviceId ? d.deviceId.slice(0, 8) + '…(未授权)' : '(无id)');
          console.log('[lumen][diag]   输出#' + i + ': ' + label);
        });
        if (outs.length === 0) {
          console.warn('[lumen][diag] 未检测到任何音频输出设备 —— 这极可能是"有画面没声音"的根本原因（环境无声卡 / 远程桌面未重定向音频）');
        }
      }).catch((e) => console.log('[lumen][diag] enumerateDevices 失败: ' + e.message));
    } else {
      console.log('[lumen][diag] navigator.mediaDevices.enumerateDevices 不可用');
    }
  } catch (e) {
    console.log('[lumen][diag] 枚举音频设备异常: ' + e.message);
  }
  setupDiagnostics({
    player, runCommand,
    getOsd: () => osd,
    getKeybinds: () => keybinds,
    getScripts: () => scripts,
    getReady: () => ready,
    getPlaylist: () => playlist,
    getPlaylistIndex: () => playlistIndex,
  });
  setupDebug();
  bindDragDrop();
  bindResumeCard();
  bindLibrary();
  bindPlaylistPanel();
  // 投屏面板：关闭按钮 + 点遮罩关闭
  const castClose = document.getElementById('cast-close');
  if (castClose) castClose.addEventListener('click', closeCastPanel);
  const castBackdrop = document.getElementById('cast-backdrop');
  if (castBackdrop) castBackdrop.addEventListener('click', closeCastPanel);
  bindHomeButton();
  bindIdleCloseButton();
  bindIdleActions();
  bindNetworkStreamDialog();

  // 启动时若没有已载入文件，进入 idle 模式（隐藏 titlebar / OSC，显示 Lumora 卡片）
  setIdleMode(!bootstrapData.hasFile);

  // 自动化测试探针：记录命令行传入的文件
  window.__pendingFile = bootstrapData.pendingFile || null;

  // 恢复上次的播放列表（视频 / 音乐 分别独立恢复），重启后仍能看到各自队列。
  // 兼容旧单列表格式（整体视为视频列表）；双列表格式分别恢复 video / audio。
  const _restored = bootstrapData.playlist;
  if (_restored) {
    if (Array.isArray(_restored.items)) {
      // 旧格式：整体当作视频列表
      _modePlaylists.video = _restored.items.map((it) => it.path).filter(Boolean);
      _modeIndexes.video = typeof _restored.index === 'number' ? _restored.index : 0;
    } else {
      if (_restored.video && Array.isArray(_restored.video.items) && _restored.video.items.length) {
        _modePlaylists.video = _restored.video.items.map((it) => it.path).filter(Boolean);
        _modeIndexes.video = typeof _restored.video.index === 'number' ? _restored.video.index : 0;
      }
      if (_restored.audio && Array.isArray(_restored.audio.items) && _restored.audio.items.length) {
        _modePlaylists.audio = _restored.audio.items.map((it) => it.path).filter(Boolean);
        _modeIndexes.audio = typeof _restored.audio.index === 'number' ? _restored.audio.index : 0;
      }
    }
  }
  // 活跃视图指向当前模式（启动默认 video 模式；首个文件载入后由 source 决定切换）
  playlist = _modePlaylists[_pmode()];
  playlistIndex = _modeIndexes[_pmode()];

  checkEnvironment();

  // 命令行/资源管理器双击带进来的文件
  if (bootstrapData.pendingFile) {
    const mode = _modeForPath(bootstrapData.pendingFile);
    const arr = _modePlaylists[mode];
    if (!arr.includes(bootstrapData.pendingFile)) {
      arr.push(bootstrapData.pendingFile);
      _modeIndexes[mode] = arr.length - 1;
    } else {
      _modeIndexes[mode] = arr.indexOf(bootstrapData.pendingFile);
    }
    if (mode === _pmode()) { playlist = arr; playlistIndex = _modeIndexes[mode]; }
    persistPlaylist();
    load(bootstrapData.pendingFile);
  }

  ready = true;
  exposeDiagnostics();
  // 测试用：手动刷新"继续观看"卡片（正常情况下随 idle 进入自动刷新）
  window.__lumen.refreshResumeCard = () => showResumeCard();
  // 测试钩子：自动化测试驱动播放列表逻辑（不影响正常功能）
  window.__lumen.__setPlaylist = (paths, index) => setPlaylist(paths, index);
  window.__lumen.__getPlaylistLength = () => playlist.length;
  window.__lumen.__getPlaylistIndex = () => playlistIndex;
  window.__lumen.__playlistJump = (dir) => playlistJump(dir);
  window.__lumen.__playlistGoto = (i) => playlistGoto(i);
  window.__lumen.__playlistRemove = (i) => playlistRemove(i);
  window.__lumen.__togglePlaylistPanel = () => togglePlaylistPanel();
  window.__lumen.__closePlaylistPanel = () => closePlaylistPanel();
  window.__lumen.__isPlaylistPanelVisible = () => {
    const p = document.getElementById('playlist-panel');
    return !!(p && !p.classList.contains('hidden'));
  };
  window.__lumen.__takeScreenshotSequence = () => takeScreenshotSequence();
  // 循环模式测试钩子
  window.__lumen.cycleLoopMode = () => cycleLoopMode();
  window.__lumen.loopMode = () => loopMode;
  window.__lumen.__getLoopMode = () => loopMode;
  window.__lumen.__setLoopMode = (m) => setLoopMode(m);
  // OSC / 右键菜单通过 window.toggleDanmaku / window.toggleSubSearch / window.runSubAutoMatch 调用
  window.toggleDanmaku = toggleDanmaku;
  window.toggleSubSearch = toggleSubSearch;
  window.runSubAutoMatch = runSubAutoMatch;
  console.log('[lumen] 就绪', bootstrapData.versions);
}


function fatal(title, detail) {
  // 致命错误（比如 WebGL 完全不可用）→ 强制进入 idle 并把错误显示在卡片里
  setIdleMode(true);
  const box = $('idle-warning');
  box.innerHTML = `<strong>${esc(title)}</strong><br>${esc(detail || '')}`;
}

/**
 * 无视频输出模式的告知。
 *
 * 这条提示要"可操作"：只说"WebGL 不可用"没有用，得告诉用户下一步该做什么。
 */
function warnNoVideoOutput(reason) {
  document.body.classList.add('no-video-output');
  $('idle-warning').innerHTML =
    '<strong>视频输出不可用，已切换为纯音频模式</strong><br>' +
    esc(reason || '') + '<br>' +
    '常见原因：显卡驱动异常、远程桌面会话、虚拟机无 GPU。<br>' +
    '可尝试用 <code>--use-angle=gl</code> 或 <code>--disable-gpu-sandbox</code> 启动。';
  osd.message('无视频输出', '已降级为纯音频播放', { duration: 6000, force: true });
}

/** 缺 FFmpeg 是最常见的启动问题，提前说清楚，别等到用户打开文件才报错 */
function checkEnvironment() {
  const ff = bootstrapData.ffmpeg;
  if (!ff || !ff.path) {
    $('idle-warning').innerHTML =
      '<strong>未找到 FFmpeg</strong><br>请安装 FFmpeg 并加入 PATH，' +
      '或在 <code>player.conf</code> 里设置 <code>ffmpeg-dir</code>。';
  }
}

/* ================================================================== */
/* 命令总线                                                            */
/* ================================================================== */

/**
 * 所有输入的唯一出口。
 * UI 层面的命令在这里消化，其余原样交给播放器状态机。
 */
// 音乐（纯音频）模式下整体失效的视频专属命令：避免无意义调用与底层报错
const AUDIO_BLOCKED_COMMANDS = new Set([
  'pip', 'screenshot', 'screenshot-sequence',
  'frame-step', 'frame-back-step',
  'reset-video-eq', 'hwdec', 'deband', 'scaler', 'tone-mapping',
]);
function isAudioBlockedCommand(args) {
  const c = args[0];
  if (AUDIO_BLOCKED_COMMANDS.has(c)) return true;
  if (c === 'add' && ['brightness', 'contrast', 'gamma', 'saturation'].includes(args[1])) return true;
  return false;
}

function runCommand(args) {
  if (!Array.isArray(args) || !args.length) return false;

  // 音乐模式：视频专属命令整体失效并提示，不向下转发
  if (document.body.classList.contains('audio-mode') && isAudioBlockedCommand(args)) {
    osd.message('音乐模式不可用', '该功能仅视频模式', { duration: 1500, key: 'audio-only' });
    return true;
  }

  switch (args[0]) {
    case 'open-file':
      openDialog();
      return true;

    case 'open-network-stream':
      openNetworkStream();
      return true;

    case 'show-keymap':
      toggleKeymap();
      return true;

    case 'playlist-next':
      playlistJump(1);
      return true;

    case 'playlist-prev':
      playlistJump(-1);
      return true;

    case 'show-playlist':
      togglePlaylistPanel();
      return true;

    case 'pip':
      if (window.lumen && window.lumen.togglePip) window.lumen.togglePip();
      return true;

    case 'loop-mode-cycle':
      cycleLoopMode();
      return true;

    case 'loop-mode-set':
      setLoopMode(args[1] || 'off');
      return true;

    case 'shuffle-toggle':
      // 随机与循环共享同一枚举；随机开关只切 random ↔ off
      setLoopMode(loopMode === 'random' ? 'off' : 'random');
      return true;

    case 'repeat-cycle':
      // 循环三态 off → list → file → off；若当前在 random，先退出随机进入 list
      if (loopMode === 'random') setLoopMode('list');
      else setLoopMode({ off: 'list', list: 'file', file: 'off' }[loopMode] || 'off');
      return true;

    case 'screenshot':
      takeScreenshot(args[1]);
      return true;

    case 'screenshot-sequence':
      takeScreenshotSequence();
      return true;

    case 'toggle-theme': {      // 循环切换主题：system → dark → light → system
      const cfg = (bootstrapData && bootstrapData.config && bootstrapData.config.values) || null;
      const current = (cfg && cfg.theme) || 'system';
      const next = { system: 'dark', dark: 'light', light: 'system' }[current] || 'dark';
      if (window.lumen && window.lumen.setConfig) {
        window.lumen.setConfig('theme', next).then(() => {
          applyTheme();
          // 同步更新本地 bootstrapData 缓存，让下次读取一致
          if (bootstrapData && bootstrapData.config && bootstrapData.config.values) {
            bootstrapData.config.values.theme = next;
          }
          const labels = { system: '跟随系统', dark: '暗色', light: '亮色' };
          osd.message('主题', labels[next] || next, { duration: 1500, key: 'theme' });
        }).catch(() => {});
      }
      return true;
    }

    case 'script-binding': {
      const name = args[1];
      if (!scripts.triggerBinding(name) && name !== 'console') {
        osd.message('未注册的脚本绑定', name);
      }
      return true;
    }

    default:
      return player.command(args);
  }
}

async function openDialog(append = false, mode = 'all') {
  // 打开文件对话框：列视频与音频（音乐模式已移除，播放器可播任意媒体）
  // append=true 时把所选文件追加到现有播放列表（首页"添加媒体"按钮使用），
  // 否则整体替换（快捷键 / 双击打开文件的默认行为）。
  // mode='audio'|'video' 用于 idle 左右入口：默认只显示对应类型文件，
  // 强化"点击进入音乐/视频模式"的语义。
  const videoExts = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'ts', 'm2ts', 'wmv', 'mpg', 'mpeg', 'm4v', '3gp', 'ogv'];
  const audioExts = ['mp3', 'flac', 'aac', 'wav', 'ogg', 'opus', 'm4a', 'wma'];
  let filters;
  if (mode === 'audio') {
    filters = [
      { name: '音频', extensions: audioExts },
      { name: '全部文件', extensions: ['*'] },
    ];
  } else if (mode === 'video') {
    filters = [
      { name: '视频', extensions: videoExts },
      { name: '全部文件', extensions: ['*'] },
    ];
  } else {
    filters = [
      { name: '视频', extensions: videoExts },
      { name: '音频', extensions: audioExts },
      { name: '全部文件', extensions: ['*'] },
    ];
  }
  const title = mode === 'audio' ? '打开音频文件' : mode === 'video' ? '打开视频文件' : '打开文件';
  const r = await window.lumen.openDialog({ title, filters });
  if (r && r.ok && Array.isArray(r.paths) && r.paths.length) {
    // 按对话框模式(idle 左右入口)决定写入哪个列表：'audio'→音乐列表，'video'→视频列表，'all'→当前模式
    const targetMode = mode === 'all' ? _pmode() : mode;
    if (append && playlist.length) {
      // 追加：引用语义原地 push，保持当前播放项与索引不变；首页停留不自动播放
      const arr = _modePlaylists[targetMode];
      for (const p of r.paths) arr.push(p);
      if (targetMode === _pmode()) playlist = arr;
    } else {
      setPlaylist(r.paths, 0, targetMode);
    }
    persistPlaylist();
    if (!append) load(r.paths[0]);
  } else if (r && r.canceled && !player.info) {
    // 取消对话框且当前没在播文件 → 回到 idle，避免 loaded 后再取消导致黑屏
    setIdleMode(true);
    // 再补一道延迟保险：某些 Windows 透明窗口在模态对话框关闭后
    // 会出现绘制状态不一致，100ms 后强制把 idle 屏拉回来。
    setTimeout(() => {
      const idle = $('idle-screen');
      idle.classList.remove('hidden', 'fading');
      idle.style.opacity = '1';
    }, 100);
  }
}

/** 进入视频模式（无文件空态）：首页「视频」入口点击直接进入视频播放视图。
 *  退出 idle、退出音频模式，显示主视频播放区（OSC + 视频区）；
 *  用户拖入/打开文件后由 player:loaded 正常接管。
 *  同时显示 #video-idle-bg 不透明背景层，避免底层 videoWin 透明露出桌面；
 *  加载视频后 player:loaded 会隐藏该层，让视频透出。 */
function enterVideoMode() {
  exitAudioMode();
  setIdleMode(false, true);
  const bg = document.getElementById('video-idle-bg');
  if (bg) bg.classList.add('visible');
}

/** 打开"网络串流"地址输入框（玻璃拟态 modal）。校验通过后才交给 load()。 */
function openNetworkStream() {
  const dlg = $('network-stream-dialog');
  if (!dlg) return;
  const input = $('ns-input');
  const err = $('ns-error');
  if (err) err.classList.add('hidden');
  dlg.classList.remove('hidden');
  if (!nsUserMoved) centerNetworkStreamWindow();
  // 渲染层初始化期间（osd 静默窗）不在这儿弹 OSD，直接展示即可
  if (input) {
    input.value = '';
    // 等元素从 display:none 切回后再聚焦，否则 focus 无效
    setTimeout(() => input.focus(), 30);
  }
}

function closeNetworkStreamDialog() {
  const dlg = $('network-stream-dialog');
  if (dlg) dlg.classList.add('hidden');
}

function submitNetworkStream() {
  const input = $('ns-input');
  const err = $('ns-error');
  if (!input) return;
  const url = input.value.trim();
  // 与主进程 loadFile 同口径：任何 scheme:// 都视为网络地址（http/https/rtmp/rtsp/ftp/mms…）
  if (!/^[a-z]+:\/\//i.test(url)) {
    if (err) { err.textContent = '请输入有效的网络地址（需包含协议，如 https://…）'; err.classList.remove('hidden'); }
    input.focus();
    return;
  }
  closeNetworkStreamDialog();
  load(url);
}

/** 绑定网络串流对话框的按钮 / 遮罩 / 键盘交互 */
function bindNetworkStreamDialog() {
  const dlg = $('network-stream-dialog');
  if (!dlg) return;
  const ok = $('ns-ok');
  const cancel = $('ns-cancel');
  const close = $('ns-close');
  const backdrop = dlg.querySelector('.ns-backdrop');
  if (ok) ok.addEventListener('click', submitNetworkStream);
  if (cancel) cancel.addEventListener('click', closeNetworkStreamDialog);
  if (close) close.addEventListener('click', closeNetworkStreamDialog);
  if (backdrop) backdrop.addEventListener('click', closeNetworkStreamDialog);
  // 模态：阻止按键冒泡到全局快捷键（否则 Esc/Enter 会穿透到全屏/打开文件等）
  dlg.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeNetworkStreamDialog(); }
    else if (e.key === 'Enter') { e.preventDefault(); submitNetworkStream(); }
  });

  makeNetworkStreamDraggable();
  isolateNetworkStreamEvents();
  window.addEventListener('resize', onNetworkStreamResize);
}

/** 网络串流弹窗居中（打开时/窗口大小变化且用户未手动拖过时调用） */
function centerNetworkStreamWindow() {
  const win = document.querySelector('#network-stream-dialog .ns-window');
  if (!win) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = win.getBoundingClientRect();
  const x = Math.round((vw - rect.width) / 2);
  const y = Math.round((vh - rect.height) / 2);
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
  win.style.transform = 'none';
}

/** 网络串流弹窗标题栏拖拽 */
function makeNetworkStreamDraggable() {
  const head = document.querySelector('#network-stream-dialog .ns-window .panel-head.draggable');
  const win = document.querySelector('#network-stream-dialog .ns-window');
  if (!head || !win) return;

  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return; // 关闭按钮不触发拖拽
    nsDragState = {
      startX: e.clientX,
      startY: e.clientY,
      initLeft: win.offsetLeft,
      initTop: win.offsetTop,
    };
    head.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!nsDragState) return;
    const dx = e.clientX - nsDragState.startX;
    const dy = e.clientY - nsDragState.startY;
    let x = nsDragState.initLeft + dx;
    let y = nsDragState.initTop + dy;

    // 限制窗口主体不跑出视口
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minVisible = 48;
    x = Math.max(minVisible - win.offsetWidth, Math.min(x, vw - minVisible));
    y = Math.max(0, Math.min(y, vh - minVisible));

    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
    win.style.transform = 'none';
    nsUserMoved = true;
  });

  window.addEventListener('mouseup', () => {
    if (!nsDragState) return;
    nsDragState = null;
    head.style.cursor = 'grab';
  });
}

/** 窗口大小变化时：未拖动则居中，已拖动则做边界约束 */
function onNetworkStreamResize() {
  const dlg = $('network-stream-dialog');
  if (!dlg || dlg.classList.contains('hidden')) return;
  const win = document.querySelector('#network-stream-dialog .ns-window');
  if (!win) return;
  if (!nsUserMoved) {
    centerNetworkStreamWindow();
    return;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minVisible = 48;
  let x = win.offsetLeft;
  let y = win.offsetTop;
  x = Math.max(minVisible - win.offsetWidth, Math.min(x, vw - minVisible));
  y = Math.max(0, Math.min(y, vh - minVisible));
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
}

/** 阻止弹窗内 mousedown/wheel/dblclick 冒泡到全局播放区监听器（input.js isUiTarget 的双重保险） */
function isolateNetworkStreamEvents() {
  const win = document.querySelector('#network-stream-dialog .ns-window');
  if (!win) return;
  for (const ev of ['mousedown', 'wheel', 'dblclick']) {
    win.addEventListener(ev, (e) => { e.stopPropagation(); }, false);
  }
}

/** 把两个播放列表（视频 / 音乐）一并持久化到磁盘，下次启动可分别恢复 */
function persistPlaylist() {
  try {
    // 同步当前模式的索引（部分代码路径经 setActiveIndex 已同步，这里兜底）
    _modeIndexes[_pmode()] = playlistIndex;
    window.lumen.savePlaylist({
      video: { index: _modeIndexes.video, items: _modePlaylists.video.map((p) => ({ path: p })) },
      audio: { index: _modeIndexes.audio, items: _modePlaylists.audio.map((p) => ({ path: p })) },
    });
  } catch { /* ignore */ }
}

async function load(filePath, opts = {}) {
  // 统一入口：主进程 loadFile 按音频/视频决定后端（音乐→ffmpeg 管线，视频→mpv），
  // 并通过 player:loaded 的 source 切换活跃引擎与舞台。加载遮罩由 player:loading
  // 事件管理（音乐来源跳过遮罩）。这里只负责发起载入与失败兜底；舞台切换交给
  // app-events 的 player:loaded（enterAudioMode / exitAudioMode）。
  // opts 透传主进程：{ resumeFromStart: true } 强制从头播放（播放列表内切歌用）。
  const r = await window.lumen.load(filePath, opts);
  if (!r || !r.ok) {
    endFirstFrameWait();
    osd.message('无法播放', (r && r.error) || '未知错误', { duration: 4000, force: true });
    setIdleMode(true);
  }
  return r;
}

/* ---------------- 播放列表（拖入多个文件时成立） ---------------- */

let loopMode = 'off';

/**
 * 循环模式状态机：off → list(列表循环) → file(单曲循环) → random(随机) → off
 *
 * 关键点：Lumora 自管播放列表（playlist 数组 + playlistJump），并非 mpv 内部 playlist，
 * 因此 mpv 的 `loop`（列表循环）对我们无效。列表循环与随机循环全部由本状态机驱动；
 * 只有单曲循环（loop-file）交给 mpv 原生处理（loop-file=inf 时 mpv 自动重播，不触发 eof）。
 */
function setLoopMode(mode) {
  const modes = ['off', 'list', 'file', 'random'];
  if (!modes.includes(mode)) mode = 'off';
  loopMode = mode;
  // 单曲循环交给 mpv 原生；其余模式不依赖 mpv 的 loop（对我们无效）
  player.setProperty('loop-file', mode === 'file' ? 'inf' : 'no');
  // 事件驱动 OSC 图标更新，避免依赖 mpv 对我们无效的 loop 属性
  document.dispatchEvent(new CustomEvent('lumen:loopmode', { detail: { mode } }));
  const labels = { off: '关闭循环', list: '列表循环', file: '单曲循环', random: '随机播放' };
  osd.message('循环模式', labels[mode]);
}

function cycleLoopMode() {
  const next = { off: 'list', list: 'file', file: 'random', random: 'off' }[loopMode] || 'off';
  setLoopMode(next);
}

/** 整个列表（或单文件）自然播放到结尾的收尾动作 */
function endOfPlaylist() {
  osd.message('播放结束', undefined, { duration: 2500 });
  // 清掉续播卡片，下次启动不再提示这部
  try { if (window.lumen && window.lumen.clearResume) window.lumen.clearResume(); } catch { /* ignore */ }
  // 仅清空「当前模式」的播放列表（视频 / 音乐 各自独立），下次启动不再恢复这个队列
  const mode = _pmode();
  _modePlaylists[mode] = [];
  _modeIndexes[mode] = -1;
  if (mode === _pmode()) { playlist = _modePlaylists[mode]; playlistIndex = -1; }
  persistPlaylist();
  // 播完且无后续：根据设置决定是否自动返回 logo 落地页（默认开启）
  const autoHome = bootstrapData && bootstrapData.config &&
    bootstrapData.config.values && bootstrapData.config.values['return-home-on-eof'] !== false;
  if (autoHome) setIdleMode(true);
}

/**
 * 活跃引擎自然结束 / 解码失败的统一收尾（video / music 引擎共用）。
 *
 * 关键修复：解码失败（ffmpeg 异常退出）曾经与"自然放完"走同一条 EOS 路径，
 * 被渲染端误报成"播放结束"并弹回主页——用户明明没播完、文件根本没出声，
 * 却看到"播放结束"。现在 detail.decodeError 为真时走失败分支：
 *   1. 明确提示"无法解码该文件"（而非误导性的"播放结束"）；
 *   2. 失败不算"列表放完"——有下一首要继续播，无则退回主页；
 *   3. 不清续播卡片、不空列表（那些是"正常放完"的语义）。
 */
function handleEof(detail = {}) {
  if (detail.decodeError) {
    endFirstFrameWait();
    osd.message('无法解码该文件', detail.detail || '解码器无法读取该音视频流', { duration: 4000, force: true });
    // 失败不视作"列表到头"：还有下一首就续播，否则退回主页（不误报"播放结束"）
    if (playlist.length > 1 && (loopMode === 'list' || loopMode === 'random' || playlistIndex < playlist.length - 1)) {
      playlistJump(1);
    } else {
      setIdleMode(true);
    }
    return;
  }
  // 正常自然结束：单曲循环由 mpv(loop-file=inf)原生重播，不会进入这里
  if (loopMode === 'file') return;
  // 列表循环 / 随机循环：自动续播（random 在 playlistJump 内随机选位）
  if (playlist.length > 1 && (loopMode === 'list' || loopMode === 'random' || playlistIndex < playlist.length - 1)) {
    playlistJump(1);
  } else {
    endOfPlaylist();
  }
}

/** 手动返回 logo 落地页（播放界面 OSC 上的"主页"按钮）：停止播放并退回 idle 界面 */
function returnHome() {
  // ① 让视频播放器模块停掉自己的后端（会顺带清理加载遮罩）。
  //    注意：不能用 player.command(['stop']) —— Player.command() 没有 'stop' case，是空操作！
  videoPlayer.stop();

  // ② 清理首帧等待 / 加载遮罩相关定时器与状态，避免残留导致下次播放异常
  clearLoadingState();
  const ls = $('loading-screen');
  if (ls) ls.classList.add('hidden');

  // ③ 关闭可能打开的浮层（播放列表面板、AI 面板等），让落地页干净呈现
  try { closePlaylistPanel(); } catch { /* noop */ }
  try {
    const aiPanel = document.getElementById('ai-panel');
    if (aiPanel && !aiPanel.classList.contains('hidden')) aiPanel.classList.add('hidden');
  } catch { /* noop */ }

  // ④ 退回 logo 落地页
  setIdleMode(true);
}

function setPlaylist(paths, index, modeOpt) {
  // 路由到指定模式（默认当前模式）。_writeMode 原地修改该模式的数组，
  // 若恰为当前模式则同步 playlist 视图别名（Proxy 引用语义不失效）。
  _writeMode(modeOpt || _pmode(), paths, index);
}

/** 计算 playlistJump 的目标索引（不修改状态）；无下一首返回 -1。
 *  随机模式下目标在跳转时才随机选定，无法预知，返回 -1（交叉淡入淡出据此跳过预滚）。 */
function nextPlaylistIndex(dir) {
  if (playlist.length < 2) return -1;
  if (dir > 0) {
    if (playlistIndex < playlist.length - 1) return playlistIndex + 1;
    if (loopMode === 'list') return 0; // 列表循环回到开头
    return -1;
  }
  if (playlistIndex > 0) return playlistIndex - 1;
  if (loopMode === 'list') return playlist.length - 1;
  return -1;
}

function playlistJump(dir) {
  let target;
  if (loopMode === 'random') {
    // 随机模式：挑一个与当前不同的位置
    do { target = Math.floor(Math.random() * playlist.length); } while (target === playlistIndex && playlist.length > 1);
  } else {
    target = nextPlaylistIndex(dir);
  }
  if (target < 0) {
    osd.message(dir > 0 ? '已经是最后一个' : '已经是第一个');
    return;
  }
  setActiveIndex(target);
  osd.message(`播放列表 ${playlistIndex + 1}/${playlist.length}`, baseName(playlist[playlistIndex]));
  persistPlaylist();
  // 播放列表内切歌：每次都从头开始播放；续播只用于重新打开同一文件/历史恢复
  load(playlist[playlistIndex], { resumeFromStart: true });
}

/**
 * 音乐接歌（真·重叠交叉淡入淡出）编排入口：若启用且存在下一首纯音频曲目，
 * 请求主进程并发解码下一曲音频头（副声部），临近曲尾时由 player._tick 自动起斜坡。
 * 关闭交叉淡入淡出（或时长非法）时顺便打断在途副声部。
 */
function maybeStartCrossfade() {
  const cfg = (bootstrapData && bootstrapData.config && bootstrapData.config.values) || {};
  const engine = musicPlayer && musicPlayer.engine;
  if (!engine) return;
  const active = engine._crossfadePending || engine._crossfadeRamping;
  if (!cfg['music.crossfade']) {
    if (active) engine.cancelCrossfade();
    return;
  }
  if (engine !== activeEngine) return; // 仅当音乐引擎是当前活跃引擎（音乐模式）才接歌
  if (loopMode === 'file') return; // 单曲循环不接歌（EOF 由 loop-file=inf 重播）
  const dur = Number(cfg['music.crossfade-duration']) || 0;
  if (!(dur > 0)) { // 时长 0 视为关闭
    if (active) engine.cancelCrossfade();
    return;
  }
  const next = nextPlaylistIndex(1);
  if (next < 0) return;
  const nextPath = playlist[next];
  if (!nextPath) return;
  engine.startCrossfade({ path: nextPath }, dur);
}

/** 跳到列表指定位置 */
function playlistGoto(i) {
  if (i < 0 || i >= playlist.length) return;
  setActiveIndex(i);
  persistPlaylist();
  // 播放列表内切歌：每次都从头开始播放
  load(playlist[i], { resumeFromStart: true });
}

/** 从列表中移除一项，并修正当前索引 */
function playlistRemove(i) {
  if (i < 0 || i >= playlist.length) return;
  playlist.splice(i, 1);
  if (!playlist.length) {
    setActiveIndex(-1);
    persistPlaylist();
    closePlaylistPanel();
    return;
  }
  if (i < playlistIndex) setActiveIndex(playlistIndex - 1);
  else if (i === playlistIndex) setActiveIndex(Math.min(playlistIndex, playlist.length - 1));
  persistPlaylist();
  renderPlaylist();
}

/** 追加一项到播放列表末尾（按 modeOpt 路由到对应模式，默认当前模式）并切换播放 */
function appendToPlaylist(path, modeOpt) {
  const mode = modeOpt || _pmode();
  const arr = _modePlaylists[mode];
  arr.push(path);
  _modeIndexes[mode] = arr.length - 1;
  if (mode === _pmode()) { playlist = arr; playlistIndex = arr.length - 1; }
  persistPlaylist();
  renderPlaylist();
}

/**
 * 模式切换时交换视频 / 音乐 播放列表视图：进入某模式前先保存刚离开模式的
 * 当前索引，再把 playlist 视图别名与 playlistIndex 指向上一模式的列表。
 * 依赖 body 的 audio-mode 类作为唯一信号（enterAudioMode/exitAudioMode 切换它）。
 * 注册顺序上必须早于 playlist.js 的自有观察者，确保面板重渲染时读到的是新列表。
 */
let _lastPlaylistMode = 'video';
function _initPlaylistModeSync() {
  _lastPlaylistMode = _pmode();
  const obs = new MutationObserver(() => {
    const now = _pmode();
    if (now === _lastPlaylistMode) return; // 仅 audio-mode 变化才处理
    // 保存刚离开模式的索引（此刻 playlistIndex 仍属旧模式）
    _modeIndexes[_lastPlaylistMode] = playlistIndex;
    // 加载进入模式的列表与索引
    playlist = _modePlaylists[now];
    playlistIndex = _modeIndexes[now];
    _lastPlaylistMode = now;
    // 面板开着则即时重渲染为进入模式的列表
    const panel = document.getElementById('playlist-panel');
    if (panel && !panel.classList.contains('hidden')) renderPlaylist();
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/* ================================================================== */
/* 状态 → 用户反馈                                                     */
/* ================================================================== */



async function takeScreenshot(mode) {
  try {
    // mpv 后端：让 mpv 直接把当前帧写到文件
    if (!player.renderer.gl) {
      const r = await window.lumen.mpvScreenshot(mode);
      if (r.ok) osd.message('已保存截图', baseName(r.path), { duration: 3000, force: true });
      else osd.message('截图失败', r.error, { duration: 3500, force: true });
      return;
    }
    // 旧 WebGL 管线：从 canvas 回读像素
    const fmt = bootstrapData.config.values['screenshot-format'] || 'png';
    const dataUrl = player.renderer.screenshot(fmt);
    const r = await window.lumen.saveScreenshot(dataUrl, player.props['time-pos']);
    if (r.ok) osd.message('已保存截图', baseName(r.path), { duration: 3000, force: true });
    else osd.message('截图失败', r.error, { duration: 3500, force: true });
    if (mode === 'window') {
      osd.message('提示', '当前仅截取画面，不含界面元素', { duration: 3000 });
    }
  } catch (err) {
    osd.message('截图失败', err.message, { duration: 3500, force: true });
  }
}

/**
 * 连拍（序列截图）：从当前位置起，按设定间隔连续抓取多张画面。
 * 做法：先暂停以保证抓到精确帧 → seek 到目标时间 → 等该帧真正渲染出来 →
 * 抓单帧（复用 takeScreenshot 的两条保存链路）→ 循环 → 最后回到起点并恢复原播放状态。
 * 文件名按时间自动命名 + 去重，连拍的多张天然不冲突。
 */
async function takeScreenshotSequence() {
  if (!player || !player.info) {
    osd.message('连拍失败', '没有正在播放的媒体', { duration: 2500, force: true });
    return;
  }
  const cfg = (bootstrapData && bootstrapData.config && bootstrapData.config.values) || {};
  const count = Math.max(2, Math.min(30, parseInt(cfg['screenshot-sequence-count'], 10) || 5));
  const interval = Math.max(0.1, Math.min(5, (parseInt(cfg['screenshot-sequence-interval'], 10) || 500) / 1000));
  const subtitles = cfg['screenshot-subtitles'] ? 'subtitles' : 'video';
  const duration = player.props.duration || Infinity;
  const start = player.props['time-pos'] || 0;
  const wasPaused = !!player.props['pause'];

  let okCount = 0;
  osd.message('连拍中', `0 / ${count}`, { key: 'seq', duration: 600000, force: true });
  try {
    try { player.setProperty('pause', true); } catch (_) {}
    for (let i = 0; i < count; i++) {
      const target = start + i * interval;
      if (target > duration - 0.05) break;
      try { await player.seek(target); } catch (_) {}
      await waitForFrame(target);
      const r = await captureSingle(subtitles);
      if (r && r.ok) okCount++;
      osd.message('连拍中', `${okCount} / ${count}`, { key: 'seq', duration: 600000, force: true });
    }
  } finally {
    try { await player.seek(start); } catch (_) {}
    try { player.setProperty('pause', wasPaused); } catch (_) {}
    osd.message('连拍完成', `已保存 ${okCount} 张截图`, { key: 'seq', duration: 3000, force: true });
  }
}

/** 等到目标时间的画面真正渲染出来（mpv 用实际 time-pos 轮询；canvas 管线等两帧） */
async function waitForFrame(target) {
  const isCanvas = !!(player.renderer && player.renderer.gl);
  const t0 = performance.now();
  const timeout = 1200;
  while (performance.now() - t0 < timeout) {
    const tp = await readActualTimePos();
    if (tp != null && Math.abs(tp - target) < 0.15) {
      if (isCanvas) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  if (isCanvas) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

async function readActualTimePos() {
  try {
    const r = await window.lumen.mpvCommand(['get_property', 'time-pos']);
    if (typeof r === 'number') return r;
  } catch (_) { /* mpv 不可用（如 ffmpeg 管线）时退回乐观值 */ }
  return player.props['time-pos'];
}

/** 抓单帧并保存（与 takeScreenshot 同两条链路：mpv 直写 / canvas 回读） */
async function captureSingle(mode) {
  try {
    if (!player.renderer || !player.renderer.gl) {
      return await window.lumen.mpvScreenshot(mode);
    }
    const fmt = (bootstrapData.config.values['screenshot-format']) || 'png';
    const dataUrl = player.renderer.screenshot(fmt);
    return await window.lumen.saveScreenshot(dataUrl, player.props['time-pos']);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}



/* ================================================================== */
/* 键位面板（F7 打开/关闭）                                            */
/* ================================================================== */
function toggleKeymap(force) {
  const next = (force !== undefined) ? force : !(keymap && keymap.visible);
  if (next) keymap.show(); else keymap.hide();
  document.body.classList.toggle('keymap-open', next);
  if (next) {
    // 打开键位面板时关闭其他浮层，避免叠加
    if (isLicensesVisible()) toggleLicenses(false);
    if (isSettingsVisible()) toggleSettings(false);
  }
}

/* ================================================================== */
/* 工具                                                                */
/* ================================================================== */

function baseName(p) { return String(p).split(/[\\/]/).pop(); }

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ================================================================== */

boot().catch((err) => {
  console.error(err);
  fatal('启动失败', err.message);
});
