/**
 * 播放控制(自包含模块,ctx 注入模式)。
 * 从 index.js 拆出(2026-08):loadFile/applyAspectRatio/currentDar。
 * 用法:playControl.setCtx({ getConfig, getWin, getVideoWin, getUseMpv, getMpvBackend,
 *   getPipeline, getMediaServer, getCurrentInfo, setCurrentInfo, getLastKnownTime,
 *   setLastKnownTime, getIsSmoke, sendToRenderer, resyncNow });(bootstrap 开头注入)
 */
const { probeMedia } = require('./ffmpeg/probe');
const { readWatchLater, writeWatchLater } = require('./resume');
const { sanitizeInfo } = require('./pip');
const { maybeAutoLoadOnlineSubtitle, maybeAutoLoadDanmaku } = require('./media-auto');
const { screen } = require('electron');
const fs = require('fs');
const path = require('path');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function win() { return CTX.getWin ? CTX.getWin() : null; }
function videoWin() { return CTX.getVideoWin ? CTX.getVideoWin() : null; }
function useMpv() { return CTX.getUseMpv ? CTX.getUseMpv() : true; }
function mpvBackend() { return CTX.getMpvBackend ? CTX.getMpvBackend() : null; }
function backend() { return CTX.getBackend ? CTX.getBackend() : null; }
function pipeline() { return CTX.getPipeline ? CTX.getPipeline() : null; }
function mediaServer() { return CTX.getMediaServer ? CTX.getMediaServer() : null; }
function currentInfo() { return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null; }
function setCurrentInfo(v) { if (CTX.setCurrentInfo) CTX.setCurrentInfo(v); }
function lastKnownTime() { return CTX.getLastKnownTime ? CTX.getLastKnownTime() : 0; }
function setLastKnownTime(v) { if (CTX.setLastKnownTime) CTX.setLastKnownTime(v); }
function isSmoke() { return CTX.getIsSmoke ? CTX.getIsSmoke() : false; }
function sendToRenderer(...a) { return CTX.sendToRenderer ? CTX.sendToRenderer(...a) : null; }
function resyncNow() { if (CTX.resyncNow) CTX.resyncNow(); }
function startMpv(w) { return CTX.startMpv ? CTX.startMpv(w) : Promise.resolve(); }

async function loadFile(filePath, opts = {}) {
  if (!filePath) return { ok: false, error: '未指定文件' };
  if (!/^[a-z]+:\/\//i.test(filePath) && !fs.existsSync(filePath)) {
    return { ok: false, error: `文件不存在: ${filePath}` };
  }

  // 远端地址（http/https/rtmp/rtsp/ftp/mms…）：不读/写续播进度、不入"最近播放"，
  // 标题按 URL 推导，避免本地文件那套路径处理对网络地址失效或污染本地记录。
  const isUrl = /^[a-z]+:\/\//i.test(filePath);

  try {
    // 用 ffprobe 探测媒体信息（轨道列表、章节、HDR 元数据等）
    // mpv 自己也能获取这些信息，但 ffprobe 的结果更详细且格式与旧管线一致
    const info = await probeMedia(filePath, {
      ffprobePath: getConfig().get('ffmpeg-dir') || null,
    });

    if (!info.hasVideo && !info.hasAudio) {
      return { ok: false, error: '文件中没有可播放的音视频轨道' };
    }

    setCurrentInfo(info);

    // 解码后端选择：默认 trust ffprobe 的 audioOnly；渲染端可显式传入 source 覆盖——
    // source:'music' 强制 ffmpeg 纯音频、绝不启动 mpv（与「音乐模式不启动 mpv」语义一致）；
    // source:'video' 走 mpv 分支。覆盖逻辑保证双引擎切换的语义不被探测结果意外反转。
    const forcedMusic = !!(opts && opts.source === 'music');
    const forcedVideo = !!(opts && opts.source === 'video');
    const isAudioFile = forcedMusic ? true : (forcedVideo ? false : !!info.audioOnly);
    const source = isAudioFile ? 'music' : 'video';
    // 加载遮罩：视频需要（盖住 videoWin 黑底）；音乐跳过（无画面，不启动 mpv）
    sendToRenderer('player:loading', { path: filePath, source });

    // 按真实宽高比调整窗口（音乐模式/纯音频不调整——无画面可匹配）
    if (info.hasVideo && !isAudioFile && win && !win().isFullScreen()) {
      applyAspectRatio(info.video[0]);
    }

    // 续播：读取上次退出时的位置
    // isSmoke() 模式必须跳过——否则测试被上次播放位置污染（8K 大文件可能
    // 从几十秒处续播，time-pos 一上来就超上限）。
    // opts.resumeFromStart=true：停止后点"播放"等"从头重新播放"场景。
    let resumeAt = 0;
    if (getConfig().get('save-position-on-quit') && !isSmoke() && !opts.resumeFromStart && !isUrl) {
      resumeAt = readWatchLater(filePath);
    }

    // ---- 按文件类型选择解码后端（isAudioFile / source 已在上文确定）----
    // 纯音频（含仅封面图的音乐）→ ffmpeg 解码管线（不启动 mpv，无 videoWin 视频输出）
    // 有视频 → mpv（默认 GPU 解码）；mpv 不可用/未配置 → ffmpeg 管线兜底
    let loadEpoch = 0;
    let loadOutput = null;

    // 切换后端前，停掉另一个可能仍在跑的后端，避免串音 / 残留画面
    if (isAudioFile) {
      if (mpvBackend() && mpvBackend().ready) { try { await mpvBackend().stop(); } catch { /* 已停 */ } }
    } else if (pipeline()) {
      try { pipeline().stop(); } catch { /* 已停 */ }
    }

    if (isAudioFile) {
      // 音乐：ffmpeg 管线（纯音频，无 mpv、无 videoWin）
      pipeline().load(info);
      loadEpoch = pipeline().start(resumeAt);
      loadOutput = pipeline().videoOutput || null;
      setLastKnownTime(resumeAt);
    } else if (useMpv && mpvBackend()) {
      // 视频：mpv 懒启动（boot 仅构造 backend 对象，未 spawn 进程；
      // 仅首个视频文件才在此真正拉起 mpv 子进程）
      if (!mpvBackend().ready) {
        try { await startMpv(videoWin()); }
        catch (e) { console.warn('[lumen][mpv] 懒启动失败，降级 ffmpeg 管线:', e.message); }
      }
      if (mpvBackend() && mpvBackend().ready) {
        await mpvBackend().loadFile(filePath);
        if (info.hasVideo && info.video[0]) {
          const v = info.video[0];
          mpvBackend().applyResolutionProfile(v.width, v.height);
        }
        setLastKnownTime(resumeAt);
      } else {
        // mpv 启动失败 → ffmpeg 管线兜底（音频轨仍在，画面可能缺失）
        pipeline().load(info);
        loadEpoch = pipeline().start(resumeAt);
        loadOutput = pipeline().videoOutput || null;
        setLastKnownTime(resumeAt);
      }
    } else if (pipeline()) {
      // ffmpeg 解码管线（engine=ffmpeg 时已覆盖视频）
      pipeline().load(info);
      loadEpoch = pipeline().start(resumeAt);
      loadOutput = pipeline().videoOutput || null;
      setLastKnownTime(resumeAt);
    }

    const payload = {
      info: sanitizeInfo(info),
      epoch: loadEpoch,
      resumeAt,
      output: loadOutput,
      source,
    };
    sendToRenderer('player:loaded', payload);

    // 在线字幕自动匹配：开启 subtitles-autoload 即触发。
    // 会同时尝试 OpenSubtitles（如已配置 API Key）、射手网、字幕库、SubHD。
    // 默认关闭，避免每次载入都消耗网络配额。
    if (getConfig().get('subtitles-autoload') && currentInfo()) {
      maybeAutoLoadOnlineSubtitle(currentInfo);
    }

    // 弹幕自动加载：用户开启 danmaku-autoload 即触发。
    // 内部按可用源逐源尝试（弹弹需凭据，B站零配置兜底）。
    if (getConfig().get('danmaku-autoload') && currentInfo()) {
      maybeAutoLoadDanmaku(currentInfo);
    }

    // ffmpeg 引擎：载入即自动提取默认（或首条）文本字幕轨，与 mpv 默认
    // 显示默认字幕的行为一致。图形字幕标记 graphic，渲染端会提示不支持。
    if (!isAudioFile && pipeline() && info.subtitle && info.subtitle.length) {
      console.log('[lumen][sub] 检测到字幕轨 ' + info.subtitle.length + ' 条: '
        + info.subtitle.map((s, i) => `#${i}${s.graphic ? '(图形)' : ''}${s.lang ? '[' + s.lang + ']' : ''}${s.isDefault ? '(默认)' : ''}`).join(' '));
      const slang = (getConfig().get('slang') || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      const prefer = slang.length
        ? info.subtitle.findIndex((s) => !s.graphic && s.lang && slang.includes(s.lang.toLowerCase()))
        : -1;
      const def = info.subtitle.findIndex((s) => s.isDefault && !s.graphic);
      const auto = prefer >= 0 ? prefer
        : (def >= 0 ? def
          : (info.subtitle[0] && !info.subtitle[0].graphic ? 0 : -1));
      console.log('[lumen][sub] 自动提取轨 auto=' + auto + (prefer >= 0 ? ' (语言匹配)' : ''));
      if (auto >= 0) extractAndSendSubtitles(auto);
    } else {
      console.log('[lumen][sub] 无字幕轨或未走 ffmpeg 管线，跳过提取');
    }

    if (win()) {
      const base = mediaTitleBase(filePath, isUrl);
      win().setTitle(`${info.title || base} — Lumora`);
    }

    // 写入播放历史（idle 屏"最近播放"用）；冒烟测试不污染真实记录；远端地址不入历史
    if (!isSmoke() && !isUrl) {
      try {
        addHistory({
          path: info.path,
          title: info.title || path.basename(info.path),
          duration: info.duration || 0,
        });
      } catch { /* 记录失败不影响播放 */ }
    }

    return { ok: true, ...payload };
  } catch (err) {
    sendToRenderer('player:error', { message: err.message });
    return { ok: false, error: err.message };
  }
}

/** 窗口标题用的"文件名"：本地文件取 basename；网络地址取 URL 末段（去查询串），失败回退全地址 */
function mediaTitleBase(filePath, isUrl) {
  if (isUrl) {
    try {
      const u = new URL(filePath);
      const seg = u.pathname.split('/').filter(Boolean).pop();
      return seg ? decodeURIComponent(seg) : u.host;
    } catch { return filePath; }
  }
  return path.basename(filePath);
}

/** 按视频显示宽高比调整窗口尺寸，并锁定比例 */
function applyAspectRatio(v) {
  if (!v || !v.width || !v.height) return;
  const dar = v.dar || (v.width / v.height);
  const rotated = v.rotation === 90 || v.rotation === 270;
  const ratio = rotated ? 1 / dar : dar;

  const display = screen.getDisplayNearestPoint(win().getBounds());
  const { width: sw, height: sh } = display.workAreaSize;

  let w = rotated ? v.height : Math.round(v.width * (v.sar || 1));
  let h = rotated ? Math.round(v.width * (v.sar || 1)) : v.height;

  // 超出屏幕就等比缩到 85% 可用区域内
  const maxW = sw * 0.85, maxH = sh * 0.85;
  if (w > maxW || h > maxH) {
    const s = Math.min(maxW / w, maxH / h);
    w = Math.round(w * s); h = Math.round(h * s);
  }
  w = Math.max(w, 320); h = Math.max(h, 200);

  videoWin().setAspectRatio(ratio);
  videoWin().setSize(w, h, false);
  videoWin().center();
  // setSize/center 都会触发 DWM 异步调整，立即同步+安全网兜底
  resyncNow();
  // 关键：mpv 嵌入子窗口（--wid）不一定在父窗口 setSize 后自动收到 WM_SIZE
  //   → mpv 继续用旧尺寸渲染 → 画面只覆盖部分区域（右侧/下侧黑底）。
  //
  // 修复时机（避免“闪一下才播放”）：本函数早于 mpv.loadFile 执行，此时 mpv
  //   尚未呈现任何帧。故**同步**用已知正确的 (w,h) 重设一次 videoWin bounds，
  //   强制 WM_SIZE → mpv 按正确尺寸首帧呈现；resize 发生在首帧之前，肉眼不可见，
  //   不会与加载遮罩淡出（Round 14）产生可见闪烁。
  //   （早期实现用 setTimeout(120ms) 延迟 nudge，对加载快的文件 mpv 已先呈现，
  //     nudge 在其后触发重绘 → 闪一帧黑，正是本轮要修的症状。）
  if (useMpv()) {
    try {
      const vw = videoWin();
      if (!vw || vw.isDestroyed()) return;
      if (vw.isFullScreen()) return;
      const cur = vw.getBounds();
      vw.setBounds({ x: cur.x, y: cur.y, width: w, height: h });
    } catch {}
    // 重设 bounds 后再次同步 UI 窗口覆盖（videoWin 尺寸已确定）
    resyncNow();
  }
}

/** 当前视频显示宽高比（DAR）；无视频时回退 16:9，供 PiP 定尺寸 */
function currentDar() {
  const v = currentInfo() && currentInfo().video && currentInfo().video[0];
  if (!v || !v.width || !v.height) return 16 / 9;
  const dar = v.dar || (v.width / v.height);
  const rotated = v.rotation === 90 || v.rotation === 270;
  return rotated ? 1 / dar : dar;
}

module.exports = { setCtx, loadFile, applyAspectRatio, currentDar };
