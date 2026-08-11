/**
 * ffmpeg 引擎解码编排（自包含模块）。
 * 从 index.js 拆出（2026-08）：setupPipeline（MediaPipeline 事件接线 + 背压）。
 * 用法：setCtx({ getConfig, getPipeline, setPipeline, getSecondaryPipeline,
 *   setSecondaryPipeline, getMediaServer, getCurrentInfo, getLastKnownTime,
 *   sendToRenderer })（bootstrap 时注入；pipeline 是 index.js 顶层变量，
 *   读写走 getter/setter 保持单一事实源）。engine==='mediafoundation' 时不调用。
 *
 * 交叉淡入淡出：用第二个并发 MediaPipeline（副声部，voice=1）解码下一曲目的
 * 音频头，与主声部（voice=0）同时混音；提升为主声部时无需重新 seek（副声部
 * ffmpeg 一直跑到 EOF，由渲染端背压限速）。
 */
const { MediaPipeline } = require('./ffmpeg/decoder');
const { PacketType, Voice } = require('../shared/protocol');
const { sanitizeInfo } = require('./pip');
const { probeMedia } = require('./ffmpeg/probe');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getPipeline() { return CTX.getPipeline ? CTX.getPipeline() : null; }
function setPipeline(v) { if (CTX.setPipeline) CTX.setPipeline(v); }
function getSecondaryPipeline() { return CTX.getSecondaryPipeline ? CTX.getSecondaryPipeline() : null; }
function setSecondaryPipeline(v) { if (CTX.setSecondaryPipeline) CTX.setSecondaryPipeline(v); }
function getMediaServer() { return CTX.getMediaServer ? CTX.getMediaServer() : null; }
function getCurrentInfo() { return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null; }
function getLastKnownTime() { return CTX.getLastKnownTime ? CTX.getLastKnownTime() : 0; }
function sendToRenderer(channel, payload) { if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload); }

/* 解码编排                                                             */
/* ------------------------------------------------------------------ */

/**
 * 给任意一个 MediaPipeline 接上音频/事件接线。主声部与交叉淡入淡出副声部共用，
 * 通过 isPrimary 区分只有主声部才需要的接线（EOS 终止播放、硬解回退）。
 * 同一实例只接线一次，防止重复监听导致重复发包。
 */
function wirePipeline(pipeline, { isPrimary = false } = {}) {
  if (pipeline._wired) return;
  pipeline._wired = true;

  if (isPrimary) {
    pipeline.on('video-frame', (f) => getMediaServer().sendVideoFrame(f));
  }

  pipeline.on('audio-chunk', (c) => getMediaServer().sendAudioChunk(c));

  if (isPrimary) {
    pipeline.on('eos', ({ epoch, decodeError, detail }) => {
      // EOS 控制包的 pts 字段对 EOS 本就空闲（恒为 0），复用它携带 decodeError
      // 标记，让渲染端区分"自然放完"与"解码失败"——失败时不报"播放结束"、不误回主页。
      getMediaServer().sendControl(PacketType.EOS, epoch, decodeError ? 1 : 0, Voice.PRIMARY);
    });
  }

  pipeline.on('error', (err) => {
    // 解码子进程异常退出（_decodeError 已置位）会走 EOS 的 decodeError 专用
    // 提示（"无法解码该文件"），这里不再重复弹"错误"红框，避免同一失败刷多条提示。
    // 真正的启动失败（ffmpeg 缺失/无法 spawn）未置 _decodeError，照常上报。
    if (pipeline._decodeError) return;
    sendToRenderer('player:error', { message: err.message });
  });
  pipeline.on('log', ({ stream, text }) => {
    const t = text.trim();
    if (!t) return;
    // ffmpeg 的 error 级日志值得让用户看到，其余吞掉避免刷屏
    sendToRenderer('player:log', { stream, text: t });
  });
  pipeline.on('started', (meta) => {
    sendToRenderer('player:pipeline-started', meta);
  });

  if (isPrimary) {
    pipeline.on('hwaccel-fallback', ({ epoch }) => {
      if (!getPipeline() || getPipeline().hwaccelFailed || !getPipeline().hwaccelTentative) return;
      if (epoch !== getPipeline().epoch) return;
      console.warn('[lumen] 硬解试探失败，回退到软解');
      sendToRenderer('osd', { text: '硬件解码不兼容，已回退到软件解码' });
      getPipeline().hwaccelFailed = true;
      getPipeline().hwaccelTentative = false;
      const newEpoch = getPipeline().start(getLastKnownTime());
      sendToRenderer('player:loaded', {
        info: sanitizeInfo(getCurrentInfo()),
        epoch: newEpoch,
        resumeAt: getLastKnownTime(),
        output: getPipeline().videoOutput || null,
      });
    });
  }
}

function setupPipeline() {
  setPipeline(new MediaPipeline({
    ffmpegPath: getConfig().get('ffmpeg-dir') || null,
    hwaccel: getConfig().get('hwdec'),
  }));
  wirePipeline(getPipeline(), { isPrimary: true });

  // 背压：渲染端消费不动 → 同时掐住两个管线（主 + 交叉淡入淡出副）的音频 stdout。
  // 两个声部共享同一个渲染端音频缓冲，必须一起限速，否则副声部一路解码到 EOF
  // 会把环形缓冲灌爆。
  getMediaServer().onThrottleChange = (throttled) => {
    const p = getPipeline();
    if (p) p.throttle(throttled);
    const s = getSecondaryPipeline();
    if (s) s.throttle(throttled);
  };
}

/**
 * 启动交叉淡入淡出副声部：用第二个并发 MediaPipeline 解码下一曲目音频头，
 * 声部标签 = SECONDARY(1)。该管线只解音频、跑到 EOF，由渲染端负责增益斜坡
 * 与提升为主声部（提升时无需重新 seek，做到无缝）。
 * @param {object} info 下一曲目的探测信息（与 load 同形）
 * @param {number} atTime 副声部起始解码时间（通常为 0）
 * @returns {number} 副声部 epoch
 */
function startCrossfade(info, reqId = 0) {
  // 代际标记：每次发起交叉淡入淡出自增，作废在途（被取消 / 已被新请求替代）
  // 的副声部，避免过期副声部的 voice=1 chunk 叠加到新曲产生双音。
  CTX._cfReqId = reqId;
  let sec = getSecondaryPipeline();
  if (!sec) {
    sec = new MediaPipeline({
      ffmpegPath: getConfig().get('ffmpeg-dir') || null,
      hwaccel: 'no', // 副声部只解音频，无需硬解试探
    });
    setSecondaryPipeline(sec);
  }
  wirePipeline(sec, { isPrimary: false });
  // 异步探测下一曲目：拿到时长/标题/是否纯音频，并校验能否做重叠淡化。
  Promise.resolve()
    .then(() => probeMedia(info.path, { ffprobePath: getConfig().get('ffmpeg-dir') || null }))
    .then((probed) => {
      // 探测期间可能被取消 / 新的交叉淡入淡出已发起：作废本代
      if (reqId !== CTX._cfReqId) { try { sec._killProcs(); } catch { /* 已停用 */ } return; }
      // 只对纯音频下一曲做重叠淡化；视频文件（需 mpv/videoWin）交给普通切轨，
      // 否则会出现"音频重叠但画面硬切 + 音乐模式无视频窗"的怪异表现。
      if (!probed.audioOnly) {
        try { sec._killProcs(); } catch { /* 已停用 */ }
        setSecondaryPipeline(null);
        sendToRenderer('player:crossfade-ended', {});
        return;
      }
      sec.load(probed);
      const epoch = sec.startAudioOnly(0, Voice.SECONDARY);
      sendToRenderer('player:crossfade-started', { epoch, info: sanitizeInfo(probed), reqId });
    })
    .catch((err) => {
      console.warn('[lumen] 交叉淡入淡出副声部探测失败，退化普通切轨:', err && err.message);
      try { sec._killProcs(); } catch { /* 已停用 */ }
      setSecondaryPipeline(null);
      sendToRenderer('player:crossfade-ended', {});
    });
  return -1;
}

/**
 * 终止交叉淡入淡出副声部（用户停止 / 前一曲目被硬切时调用）。
 * 注意：把副声部"提升为主声部"由编排层处理，不走这里（否则会把还在播的
 * 新曲一起杀掉）。本函数仅在交叉淡入淡出被打断时使用。
 */
function endCrossfade() {
  CTX._cfReqId = -1; // 作废任何在途的副声部发起
  const sec = getSecondaryPipeline();
  if (sec) {
    try { sec.throttle({ audio: false, video: false }); } catch { /* 已停用 */ }
    try { sec._killProcs(); } catch { /* 已停用 */ }
    setSecondaryPipeline(null);
  }
  sendToRenderer('player:crossfade-ended', {});
}

/**
 * 提升副声部为主声部：把副声部管线交换为新的主声部管线（旧主声部已被
 * 渲染端在 promoteVoice 时丢弃）。交换后后续的 pause/seek/volume 等操作
 * 自然作用于新曲目；副声部槽位清空，供下一次交叉淡入淡出复用。
 */
function commitCrossfade() {
  CTX._cfReqId = -1; // 作废任何在途的副声部发起
  const sec = getSecondaryPipeline();
  if (sec) {
    setPipeline(sec);
    setSecondaryPipeline(null);
  }
  sendToRenderer('player:crossfade-ended', {});
}

module.exports = { setCtx, setupPipeline, startCrossfade, endCrossfade, commitCrossfade };
