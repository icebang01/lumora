/**
 * 视频播放器模块(自包含)。
 * 2026-08 从 app.js/panels/feedback.js 拆出:视频引擎创建 + 视频反馈绑定 +
 * 质量徽章 + 加载遮罩联动。与 music-player.js 完全独立——各自持有引擎、
 * 各自绑定反馈、各自处理加载与舞台切换。
 *
 * 用法:
 *   const video = await createVideoPlayer(bootstrapData, ctx);
 *   video.engine          // 视频引擎实例(MpvPlayer/Player/MediaFoundationEngine)
 *   video.applyStage()    // 切到视频舞台(has-video)
 *   await video.stop()    // 停止(委托主进程)
 */
import { Player } from '../core/player.js';
import { MpvPlayer } from '../core/mpv-player.js';
import { MediaFoundationEngine } from '../core/engine.js';
import {
  notifyFirstFrame, notifySeeking, setIdleMode, beginFirstFrameWait,
  markVoReconfig, markVideoFrame, clearLoadingState,
} from '../panels/idle.js';
import { applySubtitleStyle } from '../panels/subtitle-style.js';

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------------- 引擎创建 ---------------- */

/**
 * 按配置选择视频引擎:
 *   - mpv            (默认,进程内 GPU 解码,最稳,支持 8K)
 *   - ffmpeg         内置 LGPL 解码管线(ffmpeg 子进程 → WebSocket → WebGL2)
 *   - mediafoundation 路线 A 占位,后端未实现,仅给清晰报错
 */
function createVideoEngine(bootstrapData) {
  const engineName = (bootstrapData.config.values.engine) || 'mpv';
  if (engineName === 'mediafoundation') {
    return new MediaFoundationEngine(window.lumen);
  }
  if (engineName === 'ffmpeg') {
    const canvas = document.getElementById('video-canvas');
    document.body.classList.add('engine-ffmpeg');
    return new Player(canvas);
  }
  return new MpvPlayer('video');
}

/* ---------------- 质量徽章 ---------------- */

let qualityBadgeTimer = null;
let qualityBadgeFadeTimer = null;

/** 清掉质量徽章的显示/淡出定时器(进入 idle 时调用,避免残留) */
export function clearQualityBadges() {
  if (qualityBadgeTimer) { window.clearTimeout(qualityBadgeTimer); qualityBadgeTimer = null; }
  if (qualityBadgeFadeTimer) { window.clearTimeout(qualityBadgeFadeTimer); qualityBadgeFadeTimer = null; }
}

function hideQualityBadges() {
  const box = $('quality-badges');
  if (!box) return;
  box.classList.add('fading');
  qualityBadgeFadeTimer = window.setTimeout(() => {
    box.classList.add('hidden');
    box.classList.remove('fading');
  }, 420);
}

function scheduleQualityBadgeHide(delay = 7000) {
  if (qualityBadgeTimer) { window.clearTimeout(qualityBadgeTimer); qualityBadgeTimer = null; }
  if (qualityBadgeFadeTimer) { window.clearTimeout(qualityBadgeFadeTimer); qualityBadgeFadeTimer = null; }
  const box = $('quality-badges');
  if (box) { box.classList.remove('hidden', 'fading'); }
  qualityBadgeTimer = window.setTimeout(hideQualityBadges, delay);
}

function bindQualityBadgeHover() {
  const box = $('quality-badges');
  if (!box || box.__qbHoverBound) return;
  box.__qbHoverBound = true;
  box.addEventListener('mouseenter', () => {
    if (qualityBadgeTimer) { window.clearTimeout(qualityBadgeTimer); qualityBadgeTimer = null; }
    box.classList.remove('hidden', 'fading');
  });
  box.addEventListener('mouseleave', () => scheduleQualityBadgeHide(1200));
}

function renderQualityBadges(info, player) {
  const box = $('quality-badges');
  if (!box) return;
  bindQualityBadgeHover();
  // 质量徽标开关：默认显示（undefined 视为 true）；仅显式关闭时隐藏
  if (player.getProperty && player.getProperty('show-quality-badges') === false) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  if (qualityBadgeTimer) { window.clearTimeout(qualityBadgeTimer); qualityBadgeTimer = null; }
  if (qualityBadgeFadeTimer) { window.clearTimeout(qualityBadgeFadeTimer); qualityBadgeFadeTimer = null; }

  const badges = [];
  const v = info.video && info.video[0];
  if (v) {
    const h = v.height || 0;
    if (h >= 4320) badges.push({ brand: '8K', sub: 'ULTRA HD', kind: 'res', icon: ICON_RES });
    else if (h >= 2160) badges.push({ brand: '4K', sub: 'ULTRA HD', kind: 'res', icon: ICON_RES });
    else if (h >= 1440) badges.push({ brand: '1440', sub: 'QHD', kind: 'res', icon: ICON_RES });
    else if (h >= 1080) badges.push({ brand: '1080', sub: 'FULL HD', kind: 'res', icon: ICON_RES });
    else if (h >= 720) badges.push({ brand: '720', sub: 'HD', kind: 'res', icon: ICON_RES });

    // Dolby Vision 与 HDR 变体互斥；但可以和音频 Dolby Atmos 共存
    if (v.dvProfile != null) badges.push({ brand: 'DOLBY', sub: 'VISION', kind: 'dv', icon: ICON_DV });
    else if (v.hdrVariant === 'hdr10+') badges.push({ brand: 'HDR', sub: '10+', kind: 'hdr', icon: ICON_HDR });
    else if (v.hdrVariant === 'hdr10') badges.push({ brand: 'HDR', sub: '10', kind: 'hdr', icon: ICON_HDR });
    else if (v.hdrVariant === 'hlg') badges.push({ brand: 'HLG', sub: 'HYBRID', kind: 'hdr', icon: ICON_HDR });

    if (v.bitDepth >= 10) badges.push({ brand: `${v.bitDepth}`, sub: 'BIT', kind: 'depth', icon: ICON_DEPTH });
  }
  const a0 = info.audio && info.audio[0];
  if (a0) {
    if (a0.atmos) badges.push({ brand: 'DOLBY', sub: 'ATMOS', kind: 'audio', icon: ICON_ATMOS });
    else if (a0.dolbyLabel) badges.push({ brand: 'DOLBY', sub: a0.dolbyLabel.replace('Dolby ', '').toUpperCase(), kind: 'audio', icon: ICON_ATMOS });
  }

  // 数量超过 4 个时启用更紧凑的"认证条"模式，避免右上角堆太满
  box.classList.toggle('compact', badges.length > 3);
  box.innerHTML = badges
    .map((b) => `<span class="qbadge kind-${b.kind}">${b.icon}<span class="qtext"><span class="qbrand">${escapeHtml(b.brand)}</span><span class="qsub">${escapeHtml(b.sub)}</span></span></span>`)
    .join('');
  box.classList.toggle('hidden', badges.length === 0);
  if (badges.length) scheduleQualityBadgeHide(7000);
}

/* 质量徽标内联 SVG 图标：品牌 logo 风格的几何标志 */
const ICON_RES = `<svg class="qlogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M6 9.5h4M6 12h5M6 14.5h3" stroke-width="1.2"/><circle cx="17" cy="11" r="1.6" fill="currentColor" stroke="none"/></svg>`;
const ICON_HDR = `<svg class="qlogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="4.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4"/></svg>`;
const ICON_DV = `<svg class="qlogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5.5 4.5 h4 a4.5 4.5 0 0 1 0 9 h-4 Z"/><path d="M18.5 4.5 h-4 a4.5 4.5 0 0 0 0 9 h4 Z"/><circle cx="12" cy="16.8" r="1.4" fill="currentColor" stroke="none"/></svg>`;
const ICON_ATMOS = `<svg class="qlogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 4.5 h4 a4.5 4.5 0 0 1 0 9 h-4 Z"/><path d="M15.5 5.5 c3 1 5 3 5 6 s-2 5 -5 6"/><path d="M15.5 9.5 c1.2 .6 2 1.8 2 3 s-.8 2.4 -2 3"/></svg>`;
const ICON_DEPTH = `<svg class="qlogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="6" width="17" height="12" rx="1.5"/><path d="M3.5 10h17M3.5 14h17" stroke-width="1.1" opacity=".55"/></svg>`;

/* ---------------- 视频反馈绑定 ---------------- */

/**
 * 绑定视频引擎的 UI 反馈：字幕覆盖层、属性观察（音量/静音/速度/渲染参数）、
 * 首帧遮罩信号、EOF/载入事件。音乐专属的歌词/唱片逻辑不在此模块。
 * @param {object} p 视频引擎实例
 * @param {object} ctx { osd, getReady, onEof, onPlaylistNext, onPlaylistPrev,
 *   onShowPlaylist, onLoadfile, onScriptBinding, onScreenshot }
 */
function bindVideoFeedback(p, ctx) {
  const osd = ctx.osd;

  // ffmpeg 引擎字幕：渲染端按媒体时间算出当前应显示的字幕文本，写入覆盖层
  p.addEventListener('subtitle', (e) => {
    const el = document.getElementById('subtitle-overlay');
    const el2 = document.getElementById('subtitle-overlay-2');
    const text = (e.detail && e.detail.text) || '';
    const text2 = (e.detail && e.detail.text2) || '';
    if (el) el.textContent = text;
    if (el2) el2.textContent = text2;
    // 每次字幕刷新都重写字幕样式（内联样式随引擎/设置变化而变），保证设置即时生效
    applySubtitleStyle(p.props);
  });

  // 跳过首次 pause 推送：mpv 启动时会推送初始 pause=false，
  // 若照常 burst 会在启动瞬间于屏幕中央闪一下播放图标（用户感觉像"加载图标"）
  let pauseFeedbackSeen = false;
  p.observeProperty('pause', (v) => {
    if (!ctx.getReady()) return;
    if (pauseFeedbackSeen === false) { pauseFeedbackSeen = true; return; }
    // idle 落地页不显示中央图标：返回主页/停止会触发 pause 通知
    if (document.body.classList.contains('idle-mode')) return;
    osd.burst(v ? 'pause' : 'play');
  });

  // 首帧缓冲：mpv 在 file-loaded 后会先报一次 time-pos=0（首帧尚未真正绘到 VO），
  // 必须等 time-pos 真正推进过首帧（v>0）才撤遮罩，盖住 videoWin 纯黑底。
  p.observeProperty('time-pos', (v) => {
    notifyFirstFrame(v); // 首帧缓冲逻辑在 panels/idle.js
  });

  // 跳转（含续播跳转）开始：载入/续播阶段重新进入首帧等待，遮罩盖住解码黑底
  p.addEventListener('seeking', () => notifySeeking());

  // mpv VO 重配置（窗口缩放 / 载入新文件都会触发一次或多次）：
  // 加载遮罩据此判断 VO 是否已稳定到最终尺寸，盖住 DWM 缩放动画拖尾的黑帧。
  p.addEventListener('vo-reconfig', () => markVoReconfig());

  // mpv 真正把一帧输出到 VO（video-out-params 配置完成）："帧画到屏上"的
  // 确定性信号，加载遮罩据此撤下。
  p.addEventListener('frame-ready', () => markVideoFrame());

  p.observeProperty('volume', (v) => {
    if (!ctx.getReady()) return;
    osd.message(p.props.mute ? '音量（静音中）' : '音量', `${Math.round(v)}%`, { key: 'volume' });
  });

  p.observeProperty('mute', (v) => {
    if (!ctx.getReady()) return;
    osd.burst(v ? 'mute' : 'volume');
    osd.message('静音', v ? '开' : '关', { key: 'volume' });
  });

  p.observeProperty('speed', (v) => {
    if (!ctx.getReady()) return;
    osd.message('速度', `${v.toFixed(2)}×`, { key: 'speed' });
  });

  p.observeProperty('scaler', (v) => {
    if (ctx.getReady()) osd.message('缩放算法', p.renderer.scalerLabel || v, { key: 'render' });
  });
  p.observeProperty('tone-mapping', (v) => {
    if (ctx.getReady()) osd.message('色调映射', v, { key: 'render' });
  });
  p.observeProperty('deband', (v) => {
    if (ctx.getReady()) osd.message('去色带', v ? '开' : '关', { key: 'render' });
  });
  p.observeProperty('hwdec', (v) => {
    if (ctx.getReady()) osd.message('硬件解码', v === 'no' ? '关闭' : v, { key: 'render' });
  });
  p.observeProperty('loop-file', (v) => {
    if (ctx.getReady()) { osd.burst('loop'); osd.message('单文件循环', v === 'inf' ? '开' : '关', { key: 'loop' }); }
  });
  p.observeProperty('ontop', (v) => {
    if (ctx.getReady()) osd.message('窗口置顶', v ? '开' : '关', { key: 'window' });
  });
  p.observeProperty('osd-level', (v) => {
    osd.setLevel(v);
    if (ctx.getReady()) osd.message('OSD 级别', String(v), { key: 'osd', force: true });
  });

  for (const [key, label] of [
    ['brightness', '亮度'], ['contrast', '对比度'],
    ['saturation', '饱和度'], ['gamma', '伽马'],
  ]) {
    p.observeProperty(key, (v) => {
      if (ctx.getReady()) osd.message(label, String(v), { key: 'eq' });
    });
  }

  p.observeProperty('video-zoom', (v) => {
    if (ctx.getReady()) osd.message('缩放', `${(v * 100).toFixed(0)}%`, { key: 'zoom' });
  });
  p.observeProperty('video-rotate', (v) => {
    if (ctx.getReady()) osd.message('旋转', `${v}°`, { key: 'rotate' });
  });

  // 播放器内部发出的 UI 请求
  p.addEventListener('osd', (e) => {
    osd.message(e.detail.text, e.detail.value, { key: e.detail.text });
  });

  p.addEventListener('screenshot-request', (e) => ctx.onScreenshot && ctx.onScreenshot(e.detail.mode));

  p.addEventListener('playlist', (e) => {
    const a = e.detail.action;
    if (a === 'playlist-next') ctx.onPlaylistNext();
    else if (a === 'playlist-prev') ctx.onPlaylistPrev();
    else ctx.onShowPlaylist();
  });

  p.addEventListener('loadfile', (e) => ctx.onLoadfile && ctx.onLoadfile(e.detail.path));

  p.addEventListener('script-binding', (e) => ctx.onScriptBinding && ctx.onScriptBinding(e.detail.name));

  p.addEventListener('eof', (e) => { if (ctx.onEof) ctx.onEof(e.detail); });

  p.addEventListener('loaded', () => {
    // 进入播放态：立即撤掉 idle 落地页（透明窗口露出 videoWin 开始渲染），
    // 但【保留】加载遮罩，直到 mpv 真正画出首帧才撤下。
    setIdleMode(false, true);
    beginFirstFrameWait('正在缓冲…');

    const info = p.info || {};
    const v = info.video && info.video[0] ? info.video[0] : null;
    const tag = v
      ? describeVideo(v)
      : (info.audio && info.audio.length ? describeAudio(info.audio[0]) : '').trim();
    osd.message(p.props['media-title'], tag, { duration: 2600, force: true });

    // 质量徽标：视频模块专属
    renderQualityBadges(info, p);
  });
}

/** 把视频流的编码/色彩信息拼成一行可读描述（用于载入 OSD）。 */
function describeVideo(v) {
  if (!v) return '';
  const parts = [`${v.width}×${v.height}`, v.codec.toUpperCase()];
  if (v.dvProfile != null) parts.push('Dolby Vision');
  else if (v.hdrVariant === 'hdr10+') parts.push('HDR10+');
  else if (v.hdrVariant === 'hdr10') parts.push('HDR10');
  else if (v.hdrVariant === 'hlg') parts.push('HLG');
  if (v.bitDepth >= 10) parts.push(`${v.bitDepth}-bit`);
  return parts.join(' · ');
}

/** 把音频流的编码信息拼成一行（杜比家族 / Atmos）。 */
function describeAudio(a) {
  if (!a) return '';
  if (a.atmos) return 'Dolby Atmos';
  if (a.dolbyLabel) return a.dolbyLabel;
  return a.codec.toUpperCase();
}

/* ---------------- 播放器装配 ---------------- */

/**
 * 创建视频播放器（自包含）。
 * @param {object} bootstrapData 启动数据（config 等）
 * @param {object} ctx 共享层注入：
 *   { osd, getReady, runCommand, onEof, onPlaylistNext, onPlaylistPrev,
 *     onShowPlaylist, onLoadfile, onScriptBinding, onScreenshot }
 * @returns {Promise<{engine, load, stop, applyStage}>}
 */
export async function createVideoPlayer(bootstrapData, ctx) {
  const engine = createVideoEngine(bootstrapData);
  await engine.init(bootstrapData);

  // OSC 按钮的 data-cmd 若是 app 级命令（非 mpv 原生命令），路由回共享命令总线
  engine.addEventListener('app-command', ({ detail }) => {
    ctx.runCommand(detail.args);
  });

  // 视频输出（WebGL/渲染）失败时给用户明确提示，而不是黑屏干瞪眼
  engine.addEventListener('vo-error', ({ detail }) => {
    ctx.osd.message('视频输出失败', detail.message, { duration: 6000, force: true });
  });

  bindVideoFeedback(engine, ctx);

  // 进入 idle(返回主页)时清理质量徽章残留——由 idle.js 发事件驱动,避免循环依赖
  window.addEventListener('lumen:idle-enter', clearQualityBadges);

  // 从视频模式返回主页：通知主进程保留当前窗口位置，使返回主页不重置为居中首页尺寸。
  // 音乐模式由 music-stage.js 的 exitAudioMode() 处理，此处排除 audio-mode 避免重复通知。
  window.addEventListener('lumen:idle-enter', () => {
    if (document.body.classList.contains('audio-mode')) return;
    try { if (window.lumen && window.lumen.videoReturnHome) window.lumen.videoReturnHome(); } catch { /* noop */ }
  });

  return {
    engine,
    /** 停止视频引擎（主进程 stop 活跃后端） */
    async stop() {
      try { if (window.lumen && window.lumen.stop) await window.lumen.stop('video'); } catch { /* noop */ }
      clearLoadingState();
      const ls = $('loading-screen');
      if (ls) ls.classList.add('hidden');
    },
    /** 切到视频舞台：显示视频画面（音乐模式已移除，此调用保持幂等） */
    applyStage() {
      document.body.classList.remove('audio-only');
      document.body.classList.add('has-video');
    },
  };
}
