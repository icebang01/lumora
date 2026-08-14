/**
 * 主进程事件绑定（自包含模块）。
 * 从 app.js 拆出（2026-08）：bindMainEvents（window.lumen.on 全部分发 + 音频不可用提示）。
 * 用法：setupMainEvents(ctx)（boot 中 player 就绪后注入；playlist/playlistIndex 走 getter/setter
 * 保持实时——setPlaylist 会整体替换数组引用，不能存旧引用）。
 */
import { showLoadingScreen, endFirstFrameWait, setIdleMode } from './panels/idle.js';
import { renderPlaylist } from './panels/playlist.js';
import { applyDanmakuDisplay } from './panels/danmaku.js';
import { initMusicStage, enterAudioMode, exitAudioMode } from './ui/music-stage.js';
import { isAudioPath } from '../shared/audio-path.js';

const $ = (id) => document.getElementById(id);

let CTX = {};
export function setupMainEvents(ctx) { CTX = ctx || {}; initMusicStage(CTX.getMusicEngine ? CTX.getMusicEngine() : player, CTX); }

// player/osd 全转发代理（方法自动 bind，属性直读）
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.getActiveEngine ? CTX.getActiveEngine() : null;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a) };
// playlist 数组代理：每次取最新引用（setPlaylist 会整体替换数组）
const playlist = new Proxy([], {
  get(_, k) {
    const arr = CTX.getPlaylist ? CTX.getPlaylist() : [];
    if (!arr) return undefined;
    const v = arr[k];
    return typeof v === 'function' ? v.bind(arr) : v;
  },
});
function getReady() { return CTX.getReady ? CTX.getReady() : true; }
function getPlaylistIndex() { return CTX.getPlaylistIndex ? CTX.getPlaylistIndex() : -1; }
function setPlaylistIndex(v) { if (CTX.setPlaylistIndex) CTX.setPlaylistIndex(v); }
function getDanmakuRenderer() { return CTX.getDanmakuRenderer ? CTX.getDanmakuRenderer() : null; }
function setPlaylist(paths, index, mode) { if (CTX.setPlaylist) CTX.setPlaylist(paths, index, mode); }
function appendToPlaylist(path, mode) { if (CTX.appendToPlaylist) CTX.appendToPlaylist(path, mode); }
function persistPlaylist() { if (CTX.persistPlaylist) CTX.persistPlaylist(); }
function load(filePath, opts) { return CTX.load ? CTX.load(filePath, opts) : null; }
function runCommand(args) { return CTX.runCommand ? CTX.runCommand(args) : null; }
function warnNoVideoOutput(reason) { if (CTX.warnNoVideoOutput) CTX.warnNoVideoOutput(reason); }

/* ================================================================== */
/* 主进程事件                                                          */
/* ================================================================== */

function bindMainEvents() {
  window.lumen.on('player:loading', (payload) => {
    // 加载遮罩仅视频模块需要（盖住 videoWin 黑底）；音乐模块无画面，不弹遮罩。
    if (payload && payload.source === 'music') return;
    // 仅确保遮罩可见；不要调用 showLoadingScreen——它会重置 vo-reconfig 跟踪状态，
    // 若早于本载荷的「早到 vo-reconfig」已到达，这里会把有效信号抹掉，导致首帧黑闪回归
    // （遮罩退化为 time-pos 兜底提前撤下）。遮罩的武装由 load() 的 showLoadingScreen 负责一次。
    $('loading-screen').classList.remove('hidden');
  });

  window.lumen.on('player:loaded', (payload) => {
    try {
      console.log('[lumen][stage] player:loaded → source=' + payload.source +
        ', audioOnly=' + (payload.info && payload.info.audioOnly) +
        ', title=' + ((payload.info && payload.info.title) || '') +
        ', hasVideo=' + (payload.info && payload.info.hasVideo));
      // 路由到与来源匹配的引擎实例（视频 / 音乐）填充媒体信息并自动播放
      const eng = (CTX.getEngine && CTX.getEngine(payload.source)) || player;
      // 引擎 onLoaded 仅做内部状态同步，绝不应阻断舞台路由；隔离其异常，
      // 避免任何引擎层意外报错把 enterAudioMode / exitAudioMode 一起拖垮（曾导致音乐舞台不显示）。
      try { eng.onLoaded(payload); } catch (e) { console.warn('[lumen][stage] eng.onLoaded 异常(已隔离):', e && e.message); }
      // 音乐模式不启用首帧等待逻辑，此处兜底确保加载遮罩不会卡住
      if (payload.source === 'music') endFirstFrameWait();
      // 切换活跃引擎：共享 UI（OSC / 统计 / 设置 / 音乐控制条）的方法调用实时落到它
      if (CTX.setActiveEngine) CTX.setActiveEngine(eng);
      // 舞台路由必须与主进程解码后端选择保持一致：以 payload.source 为准。
      // source:'music' = 主进程已选 ffmpeg 纯音频后端（绝不启动 mpv）。
      // 不能用 info.audioOnly 判定——当 source 被显式强制为 music（音乐引擎 / 音乐入口 /
      // 双引擎切换语义）时，若 ffprobe 误报 audioOnly=false，渲染端会错误地 exitAudioMode，
      // 造成"音乐在播却无舞台、黑屏不显示"的现象。两者取或，保留 audioOnly 作为兜底。
      const isMusic = payload.source === 'music' || (payload.info && payload.info.audioOnly);
      if (isMusic) enterAudioMode(payload.info);
      else exitAudioMode();
      console.log('[lumen][stage] 路由 → source=' + payload.source +
        ', audioOnly=' + (payload.info && payload.info.audioOnly) +
        ', isMusic=' + isMusic +
        ', audio-mode=' + document.body.classList.contains('audio-mode') +
        ', hidden=' + document.getElementById('music-stage').classList.contains('hidden'));
    } catch (e) {
      console.error('[lumen][stage] player:loaded 处理异常:', e && e.message, (e && e.stack || '').split('\n')[1] || '');
    }
    // 加载任意媒体后隐藏视频空态背景层（让视频/音乐接管显示）
    const vib = $('video-idle-bg');
    if (vib) vib.classList.remove('visible');
    // 音乐模块不污染视频播放列表（两个模块各自独立）
    if (payload.source !== 'music') {
      if (!playlist.includes(payload.info.path)) setPlaylist([payload.info.path], 0);
      else setPlaylistIndex(playlist.indexOf(payload.info.path));
    }
    // 换片 → 清空上一部残留的弹幕/字幕
    if (getDanmakuRenderer()) getDanmakuRenderer().clear();
    document.body.classList.remove('danmaku-active');
    // 面板开着时同步高亮当前项
    const panel = $('playlist-panel');
    if (panel && !panel.classList.contains('hidden')) renderPlaylist();
  });

  window.lumen.on('player:error', ({ message }) => {
    endFirstFrameWait();
    osd.message('错误', message, { duration: 5000, force: true });
  });

  // mpv 落到纯音频兜底模式（无 GPU 环境）：友好降级，不弹致命错误红框
  window.lumen.on('player:degraded', ({ reason }) => {
    endFirstFrameWait();
    warnNoVideoOutput(reason);
  });

  // 主进程自动匹配到的弹幕（danmaku-autoload=yes 时由 loadFile 推送）
  window.lumen.on('player:danmaku', ({ count, comments }) => {
    if (!getDanmakuRenderer() || !comments || !comments.length) return;
    getDanmakuRenderer().load(comments);
    applyDanmakuDisplay();
    osd.message('弹幕（自动）', `${count || comments.length} 条`, { duration: 2500, key: 'danmaku' });
  });

  // AI 助手下发的播放控制命令 → 走统一命令总线（runCommand → player.command）
  window.lumen.on('player:command', (args) => {
    try { runCommand(args); } catch (e) { console.warn('[ai] player:command 执行失败', args, e); }
  });

  // 外部打开文件（双击关联 / 已运行时 second-instance / macOS open-file）
  window.lumen.on('app:open-file', ({ path }) => {
    window.__test_openFile = path;
    // 按文件类型决定写入哪个列表（音频→音乐列表，其余→视频列表），两者不通用
    const mode = isAudioPath(path) ? 'audio' : 'video';
    if (!player.info) {
      setPlaylist([path], 0, mode);
      load(path);
    } else {
      // 运行中双击新文件 → 追加进对应模式列表，并从它开始播
      appendToPlaylist(path, mode);
      load(path);
    }
  });

  window.lumen.on('player:log', ({ text }) => {
    // ffmpeg 的噪音日志已经在主进程过滤过，这里只挑真正的错误提示用户
    if (/error|failed|invalid|unsupported/i.test(text)) {
      console.warn('[ffmpeg]', text);
      if (getReady()) osd.message('解码器', text.slice(0, 90), { duration: 4000, key: 'ffmpeg-log' });
    }
  });

  window.lumen.on('osd', ({ text, value }) => {
    if (getReady()) osd.message(text, value || '', { duration: 3500, key: 'main-osd' });
  });

  window.lumen.on('window:state', ({ fullscreen }) => {
    player.setProperty('fullscreen', fullscreen, true);
    document.body.classList.toggle('is-fullscreen', !!fullscreen);
    $('icon-fs').classList.toggle('hidden', fullscreen);
    $('icon-fs-exit').classList.toggle('hidden', !fullscreen);
  });

  // 画中画状态同步：主进程进入/退出 PiP 时点亮按钮
  window.lumen.on('window:pip', ({ active }) => {
    const b = $('btn-pip');
    if (b) b.classList.toggle('active', !!active);
    document.body.classList.toggle('pip-active', !!active);
  });

  // 最小化恢复：渲染端页面可能"冻住"，需强制刷新 UI 状态。
  // 常见症状：idle 落地页未隐藏（媒体已加载但显示"今天想看些什么？"）。
  // 注意：仅当"还原时不在 idle 主页"才强制退出 idle——若用户本就是从主页
  // 最小化的（player.info 可能残留上次媒体），还原后必须保持主页，否则会被
  // 错误切回播放界面（表现为"最小化放大后回到的不是主页"）。
  window.lumen.on('window:restored', () => {
    if (player && player.info && !document.body.classList.contains('idle-mode')) {
      // instant=true：立即移除 idle 屏，不做 400ms 淡出动画
      setIdleMode(false, true);
    }
  });

  // 音频彻底不可用（无设备 / worklet 被安全策略阻止）时给一条明确提示，
  // 让用户知道这是环境限制而非解码 bug。detail 里带具体错误，方便定位。
  window.addEventListener('lumen:audio-unavailable', (e) => {
    const detail = (e && e.detail) || '';
    const body = detail
      ? `当前环境不支持 WebAudio 播放：${detail}`
      : '当前环境不支持 WebAudio 播放';
    try { osd.message('无音频输出', body, { duration: 8000, force: true }); } catch { /* 尚无 osd */ }
  });
}

export { bindMainEvents };
