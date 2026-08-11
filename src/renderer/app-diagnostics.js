/**
 * 渲染端诊断（自包含模块）。
 * 从 app.js 拆出（2026-08）：exposeDiagnostics（window.__lumen 快照/探针）+ setupDebug（调试 HUD）。
 * 用法：setupDiagnostics(ctx)（boot 末尾、一切就绪后注入；动态值用 getter）。
 */
let CTX = {};
export function setupDiagnostics(ctx) { CTX = ctx || {}; }

// player 全转发代理（方法自动 bind，属性直读）
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
function runCommand(args) { return CTX.runCommand ? CTX.runCommand(args) : null; }
function getReady() { return CTX.getReady ? CTX.getReady() : true; }
function getKeybinds() { return CTX.getKeybinds ? CTX.getKeybinds() : null; }
function getScripts() { return CTX.getScripts ? CTX.getScripts() : null; }
function getOsd() { return CTX.getOsd ? CTX.getOsd() : null; }
function getPlaylist() { return CTX.getPlaylist ? CTX.getPlaylist() : []; }
function getPlaylistIndex() { return CTX.getPlaylistIndex ? CTX.getPlaylistIndex() : -1; }

/**
 * 只读诊断句柄。
 *
 * 自动化冒烟测试（--smoke-test）和手工调试都需要看到渲染端的真实状态，
 * 但不该为此开一条新的特权通道。这里只做两件事：读一份状态快照、
 * 走既有的命令总线发一条命令 —— 不绕过任何既有约束。
 */
function exposeDiagnostics() {
  window.__lumen = {
    run: (args) => runCommand(args),

    /**
     * 从默认帧缓冲上取 3×3 网格像素。
     * 判断"画面上究竟有没有东西"只能靠回读 —— renderedFrames 增长
     * 只证明渲染调用发生了，不证明着色器输出不是一片黑。
     */
    probePixels: () => {
      const gl = player.renderer.gl;
      if (!gl) return null;
      player.renderer.render();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const samples = [];
      const px = new Uint8Array(4);
      for (const fy of [0.3, 0.5, 0.7]) {
        for (const fx of [0.3, 0.5, 0.7]) {
          gl.readPixels(Math.floor(w * fx), Math.floor(h * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          samples.push([px[0], px[1], px[2]]);
        }
      }
      return { w, h, samples };
    },

    snapshot: () => ({
      ready: getReady(),
      engine: document.body.className.includes('engine-ffmpeg') ? 'ffmpeg' : 'mpv',
      hasFile: !!player.info,
      voDisabled: !!player.voDisabled,
      voError: player.voError || null,
      props: {
        ...player.props,
        'time-pos': Number(player.props['time-pos'] ?? 0),
        duration: Number(player.props.duration ?? 0),
        speed: Number(player.props.speed ?? 1),
        volume: Number(player.props.volume ?? 100),
      },
      stats: {
        renderedFrames: player.stats.renderedFrames,
        avSync: player.stats.avSync,
        lastPts: player.stats.lastPts,
        queued: player.queue.length,
        presented: player.queue.presented,
        dropped: player.queue.dropped,
        totalReceived: player.queue.totalReceived,
      },
      gl: player.renderer.rendererInfo,
      video: player.renderer.hasFrame
        ? { pixfmt: player.renderer.pixfmt, w: player.renderer.srcWidth, h: player.renderer.srcHeight }
        : null,
      videoConfigured: !!player.renderer.texY,
      videoTrackInfo: player.videoTrackInfo,
      transport: { connected: !!player.transport.connected, epoch: player.epoch },
      audio: {
        ready: !!player.audio.ready,
        enabled: !!player.audio.enabled,
        state: player.audio.ctx ? player.audio.ctx.state : 'none',
        consumed: player.audio.snapshot ? player.audio.snapshot.consumedFrames : 0,
        hasBase: player.audio.snapshot ? !!player.audio.snapshot.hasBase : false,
        playing: player.audio.snapshot ? !!player.audio.snapshot.playing : false,
        mediaTime: Number((player.audio && player.audio.mediaTime) ?? 0),
        buffered: Number((player.audio && player.audio.bufferedSeconds) ?? 0),
        worklet: Number((player.audio && player.audio.workletSeconds) ?? 0),
        pending: player.audio.pendingFrames,
        overflow: player.audio.overflowFrames,
        underruns: player.audio.underruns,
        // 声部级状态：首曲无声类问题（epoch 错配丢块）就靠这些字段区分
        voiceEpoch: (() => { const v = player.audio.voices && player.audio.voices[player.audio.activeVoice]; return v ? v.epoch : null; })(),
        voiceSent: (() => { const v = player.audio.voices && player.audio.voices[player.audio.activeVoice]; return v ? v.sentFrames : 0; })(),
        voiceDropped: (() => { const v = player.audio.voices && player.audio.voices[player.audio.activeVoice]; return v ? v.droppedFrames : 0; })(),
        voicePending: (() => { const v = player.audio.voices && player.audio.voices[player.audio.activeVoice]; return v ? v.pending.length : 0; })(),
        // 频谱数据摘要：analyser 真实 FFT 有多少 bin 有值（>20dB）、峰值 bin、
        // 每 4 个 bin 取一个的全局轮廓、声部 gain / EQ 状态——"频谱只有一条"类问题靠它定位
        spectrum: (() => {
          const a = player.audio && player.audio.analyser;
          if (!a) return null;
          const f = new Uint8Array(a.frequencyBinCount);
          a.getByteFrequencyData(f);
          let peak = 0, nonzero = 0;
          for (let i = 0; i < f.length; i++) {
            if (f[i] > 20) { nonzero++; if (i > peak) peak = i; }
          }
          const profile = [];
          for (let i = 0; i < f.length; i += 4) profile.push(f[i]);
          const v0 = player.audio.voices && player.audio.voices[player.audio.activeVoice];
          // 声部 pending 队列里最新一帧 PCM 的前 24 个交错样本 —— 判断管线推给
          // worklet 的数据是真实音乐还是被破坏成周期音（频谱异常排查专用）
          let pcm = null;
          if (v0 && v0.pending && v0.pending.length) {
            const d = v0.pending[v0.pending.length - 1].data;
            pcm = Array.from(d.slice(0, 24)).map((x) => Number(x.toFixed(3)));
          }
          return {
            bins: f.length, nonzero, peak,
            profile,
            pcm,
            gain: v0 && v0.gain ? v0.gain.gain.value : null,
            eqEnabled: player.audio.eqEnabled,
            eqBands: player.audio.eqBands ? Array.from(player.audio.eqBands) : null,
            ctxRate: player.audio.ctx ? player.audio.ctx.sampleRate : null,
            ctxState: player.audio.ctx ? player.audio.ctx.state : null,
            ctxNow: player.audio.ctx ? Number(player.audio.ctx.currentTime.toFixed(3)) : null,
            lastClockAgo: v0 && v0.lastClockAt ? Math.round((Date.now() - v0.lastClockAt)) + 'ms' : 'never',
            processorError: v0 ? v0.processorError || null : null,
            pendingFrames: v0 ? v0.pendingFrames : null,
            vEpoch: v0 ? v0.epoch : null,
            wEpoch: v0 && v0.snapshot ? v0.snapshot.epoch : null,
            wBasePts: v0 && v0.snapshot ? v0.snapshot.basePts : null,
            wHasBase: v0 && v0.snapshot ? !!v0.snapshot.hasBase : null,
          };
        })(),
      },
      ui: {
        keybinds: getKeybinds().binds.length,
        scripts: getScripts().scripts.map((s) => ({ name: s.name, ok: s.ok, error: s.error })),
        osdItems: getOsd().items.size,
        statsVisible: !!player.props.stats,
        playlist: { count: getPlaylist().length, index: getPlaylistIndex() },
      },
    }),
  };
}
/**
 * 调试 HUD（反引号 ` 键开关）：把引擎 / 音频上下文状态 / 字幕接收情况 /
 * 运行时错误直接显示在屏幕上，便于远程排查"无声 / 无字幕"这类看不到内部
 * 状态的问题。纯诊断用，不影响正常播放，可随时移除。
 */
function setupDebug() {
  const hud = document.createElement('div');
  hud.id = 'debug-hud';
  hud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;max-width:380px;'
    + 'background:rgba(0,0,0,.85);color:#5f5;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;'
    + 'padding:8px 10px;border:1px solid #5f5;border-radius:8px;white-space:pre-wrap;'
    + 'display:none;pointer-events:none;max-height:82vh;overflow:auto;box-shadow:0 4px 20px rgba(0,0,0,.5);';
  document.body.appendChild(hud);

  const errors = [];
  const log = [];
  function render() {
    if (!player) { hud.textContent = 'player 尚未就绪'; return; }
    const a = player.audio || {};
    const ctxState = a.ctx ? (a.ctx.state || '?') : '未创建';
    const lines = [
      '引擎: ' + (document.body.className.includes('engine-ffmpeg') ? 'ffmpeg'
        : document.body.className.includes('engine-mediafoundation') ? 'mediafoundation' : 'mpv'),
      'audio.enabled: ' + a.enabled,
      'audio.ready:   ' + a.ready,
      'AudioContext:  ' + ctxState,
      '字幕 cues:     ' + (player.subtitleCues ? player.subtitleCues.length : 'n/a'),
      '字幕轨 index:  ' + (player.subtitleIndex != null ? player.subtitleIndex : 'n/a'),
      'sub-visibility:' + (player.props ? player.props['sub-visibility'] : 'n/a'),
      '当前字幕:      ' + (player._lastSubtitleText ? player._lastSubtitleText.slice(0, 22) : '(无)'),
      'time-pos:      ' + (player.props ? (player.props['time-pos'] || 0).toFixed(2) : 'n/a'),
      '--- 事件日志 ---',
      ...log.slice(-12),
      '--- 运行时错误 ---',
      ...errors.slice(-6),
    ];
    hud.textContent = lines.join('\n');
  }
  function pushLog(m) { log.push(m); if (log.length > 40) log.shift(); if (hud.style.display !== 'none') render(); }
  function pushErr(m) {
    errors.push(m); if (errors.length > 10) errors.shift();
    if (hud.style.display !== 'none') render();
    console.error('[lumen][debug]', m);
  }
  window.__lumenDebug = { log: pushLog, error: pushErr };

  window.addEventListener('error', (e) => {
    pushErr('ERR ' + (e.message || (e.error && e.error.message))
      + (e.filename ? ` @${e.filename}:${e.lineno}:${e.colno}` : ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    pushErr('PROMISE ' + ((r && (r.stack || r.message)) || r));
  });

  if (player && player.addEventListener) {
    player.addEventListener('loaded', () => pushLog('loaded ' + (player.info && player.info.path)));
    player.addEventListener('subtitle', (e) => pushLog('subtitle "' + ((e.detail && e.detail.text) || '').slice(0, 24) + '"'));
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.key === '~' || e.code === 'Backquote') {
      hud.style.display = hud.style.display === 'none' ? 'block' : 'none';
      if (hud.style.display !== 'none') render();
    }
  });
  setInterval(() => { if (hud.style.display !== 'none') render(); }, 500);
}

export { exposeDiagnostics, setupDebug };
