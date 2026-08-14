/**
 * 音频输出封装（主线程侧）。
 *
 * 负责把解码来的 PCM 喂给 AudioWorklet，并把 worklet 回报的
 * 采样计数换算成可供视频对齐的媒体时间。
 *
 * 时间换算里最容易被忽略、但直接决定音画同步准不准的一项是
 * 输出延迟：consumedFrames 记的是"已交给声卡"，而人耳听到它
 * 还要再等 baseLatency + outputLatency。不减掉这一段，视频就会
 * 系统性地比声音早半帧到两帧。
 *
 * 多声部（交叉淡入淡出）：每个声部(Voice)有独立的 AudioWorkletNode +
 * GainNode，两路混入同一条 EQ→analyser→destination 总线。用户音量在
 * worklet 内施加（每声部独立），交叉淡入淡出系数由各自 GainNode 承载
 * （equal-power 曲线，逐采样平滑，无阶梯感）。activeVoice 为当前主时钟声部。
 */

// 音频均衡器：标准 10 段图示 EQ 的中心频率，由 core/eq.js 统一定义，
// 保证与 mpv equalizer 滤镜的频段对齐，同一组增益可复用于两条引擎路径。
import { EQ_FREQS } from './eq.js';

// worklet 侧维持的缓冲水位。1 秒足够吸收主线程 GC 和调度抖动，
// 又远小于环形缓冲的 4 秒容量，留足安全边际
const WORKLET_TARGET_SECONDS = 1.0;

// 主线程暂存上限。背压正常时根本到不了这个量级，纯粹是防失控的保险丝
const PENDING_MAX_SECONDS = 60;

// 交叉淡入淡出曲线采样点数（setValueCurveAtTime 用）
const XFADE_CURVE_POINTS = 128;

/**
 * 单个声部：独立 worklet 节点 + 增益节点 + 暂存队列 + 时钟快照。
 * 不直接碰 EQ/analyser/destination —— 它们由 AudioOutput 共享，声部只把
 * 自己的增益节点连到 AudioOutput._eqInput。
 */
class Voice {
  constructor(parent, index) {
    this.parent = parent;
    this.index = index;          // 0=主声部 1=交叉淡入淡出副声部
    this.node = null;            // AudioWorkletNode
    this.gain = null;            // GainNode（承载交叉淡入淡出系数）
    this.ready = false;

    this.epoch = 0;
    this.pending = [];           // [{ data: Float32Array, pts, epoch }]
    this.pendingFrames = 0;
    this.sentFrames = 0;
    this.droppedFrames = 0;
    this._wantPlay = false;

    // worklet 最近一次回报的时钟快照
    this.snapshot = {
      consumedFrames: 0, basePts: 0, hasBase: false,
      contextTime: 0, bufferedFrames: 0, underruns: 0, dropped: 0, playing: false, epoch: 0,
    };
    this._lastEpoch = null;
    this._lastPts = 0;
  }

  async init(ctx) {
    const node = new AudioWorkletNode(ctx, 'lumen-audio', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.parent.channels],
      processorOptions: {
        channels: this.parent.channels,
        sampleRate: this.parent.sampleRate,
        bufferSeconds: this.parent.bufferSeconds,
      },
    });
    const gain = ctx.createGain();
    // 主声部系数恒为 1；副声部初始静音，交叉淡入淡出开始时才斜坡拉起
    gain.gain.value = this.index === 0 ? 1.0 : 0.0;
    node.connect(gain);
    gain.connect(this.parent._eqInput);

    node.port.onmessage = (e) => {
      if (e.data && e.data.type === 'clock') {
        this.snapshot = e.data;
        this.lastClockAt = Date.now();
        // worklet 每报一次时钟（~64ms）就是一次"我消化了多少"的回执，
        // 顺势把本声部暂存队列往下续一段，形成闭环
        this.parent._drainVoice(this.index);
      }
    };
    // worklet 全局作用域异常（process 抛错）会静默杀死整个 worklet：
    // 渲染端无任何提示、时钟停止、消息不再处理 → 表现为"播着播着突然无声"。
    // processorerror 是唯一能感知到它的通道，必须记录并上报。
    // （测试桩的 FakeAudioWorkletNode 可能没有 addEventListener，防御跳过）
    if (typeof node.addEventListener === 'function') {
      node.addEventListener('processorerror', (ev) => {
        this.processorError = `processorerror @${new Date().toISOString()}: ${ev && ev.message || ''}`;
        console.error('[lumen][audio] 声部 ' + this.index + ' worklet 异常:', ev && ev.message);
      });
    }

    this.node = node;
    this.gain = gain;
    this.ready = true;

    // 重建/新建后必须重发状态：play / volume / epoch，否则新 worklet 收不到
    // play 或把音频当陈旧丢弃 → 静音
    if (this._lastEpoch != null) {
      node.port.postMessage({ type: 'flush', pts: this._lastPts || 0, epoch: this._lastEpoch });
    }
    node.port.postMessage({ type: 'volume', volume: this.parent._workletVolume(), muted: this.parent.muted });
    if (this._wantPlay) node.port.postMessage({ type: 'play' });
  }

  /** 推入一块 PCM（指定声部）。buffer 为交错 f32，会被 transfer。 */
  push(buffer, pts, epoch, pitched) {
    if (!this.ready) return; // 上下文未就绪：由 AudioOutput 层暂存补发
    if (epoch !== this.epoch) return; // seek 前的陈旧数据，直接丢

    this.pending.push({ data: new Float32Array(buffer), pts, epoch, pitched: !!pitched });
    this.pendingFrames += buffer.byteLength / 4 / this.parent.channels;

    // 兜底：真出现上游完全不理会背压的情况，也不能让内存无限涨。
    const cap = PENDING_MAX_SECONDS * this.parent.sampleRate;
    while (this.pendingFrames > cap && this.pending.length > 1) {
      const old = this.pending.shift();
      const n = old.data.length / this.parent.channels;
      this.pendingFrames -= n;
      this.droppedFrames += n;
    }
    this.parent._drainVoice(this.index);
  }

  /** 把本声部暂存队列往 worklet 续，直到设备侧缓冲达到目标水位。 */
  _drain() {
    if (!this.ready) return;
    while (this.pending.length && this.workletSeconds < WORKLET_TARGET_SECONDS) {
      const chunk = this.pending.shift();
      const n = chunk.data.length / this.parent.channels;
      this.pendingFrames -= n;
      if (chunk.epoch !== this.epoch) continue; // flush 后残留
      this.sentFrames += n;
      const buf = chunk.data.buffer;
      this.node.port.postMessage(
        { type: 'push', buffer: buf, pts: chunk.pts, epoch: chunk.epoch, pitched: chunk.pitched }, [buf],
      );
    }
  }

  get workletSeconds() {
    const s = this.snapshot;
    const measured = s.bufferedFrames / this.parent.sampleRate;
    const inFlight = (this.sentFrames - s.consumedFrames) / this.parent.sampleRate;
    return Math.max(0, measured, inFlight);
  }

  flush(pts, epoch) {
    this._lastEpoch = epoch;
    this._lastPts = pts;
    this.epoch = epoch;
    this.pending.length = 0;
    this.pendingFrames = 0;
    this.sentFrames = 0;
    this.snapshot = {
      consumedFrames: 0, basePts: pts, hasBase: false,
      contextTime: this.parent.ctx ? this.parent.ctx.currentTime : 0,
      bufferedFrames: 0, underruns: 0, dropped: 0, playing: false, epoch,
    };
    if (!this.ready) return;
    this.node.port.postMessage({ type: 'flush', pts, epoch });
  }

  play() {
    this._wantPlay = true;
    if (!this.ready) return;
    this.node.port.postMessage({ type: 'play' });
  }

  pause() {
    this._wantPlay = false;
    if (!this.ready) return;
    this.node.port.postMessage({ type: 'pause' });
  }

  /** 用户音量（感知曲线）下发到本声部 worklet。交叉淡入淡出系数由 GainNode 承担。 */
  setWorkletVolume() {
    if (!this.ready) return;
    this.node.port.postMessage({ type: 'volume', volume: this.parent._workletVolume(), muted: this.parent.muted });
  }

  /**
   * 设置本声部交叉淡入淡出系数。
   * @param {number} coeff 目标系数（0=静音 1=满音量）
   * @param {number} smoothSec 平滑时间常数
   */
  setCrossfade(coeff, smoothSec = 0.02) {
    if (!this.gain || !this.parent.ctx) return;
    this.gain.gain.setTargetAtTime(coeff, this.parent.ctx.currentTime, smoothSec);
  }

  /** 用 equal-power / 线性曲线在 durationSec 内将系数从当前值拉到 coeff。 */
  rampCrossfade(coeff, durationSec, equalPower = true) {
    if (!this.gain || !this.parent.ctx) return;
    const now = this.parent.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    const pts = XFADE_CURVE_POINTS;
    const curve = new Float32Array(pts);
    const start = this.gain.gain.value;
    for (let i = 0; i < pts; i++) {
      const theta = (i / (pts - 1)) * (Math.PI / 2);
      if (equalPower) {
        // equal-power：淡入走 sin(θ)（start→coeff），淡出走 cos(θ)（start→coeff）。
        // 两声部互补：sin²+cos²=1，总能量恒定，无听感凹陷。
        if (coeff >= start) {
          curve[i] = start + (coeff - start) * Math.sin(theta);
        } else {
          curve[i] = start * Math.cos(theta) + coeff * (1 - Math.cos(theta));
        }
      } else {
        curve[i] = start + (coeff - start) * (i / (pts - 1));
      }
    }
    this.gain.gain.setValueCurveAtTime(curve, now, Math.max(0.01, durationSec));
  }

  get mediaTime() {
    const s = this.snapshot;
    if (!this.ready || !s.hasBase) return null;
    const consumed = s.consumedFrames / this.parent.sampleRate;
    const elapsed = (this.parent.ctx && s.playing)
      ? Math.max(0, this.parent.ctx.currentTime - s.contextTime)
      : 0;
    const audible = consumed + elapsed - this.parent.outputLatency;
    return s.basePts + audible * this.parent.speed;
  }

  async close() {
    if (this.node) {
      try { if (this.node.port) this.node.port.onmessage = null; } catch { /* 已清空 */ }
      try { this.node.disconnect(); } catch { /* 已断开 */ }
    }
    if (this.gain) {
      try { this.gain.disconnect(); } catch { /* 已断开 */ }
    }
    this.node = null; this.gain = null; this.ready = false;
  }
}

export class AudioOutput {
  constructor() {
    this.ctx = null;
    this.analyser = null;   // 频域分析节点：渲染端可视化（频谱）从它取真实 FFT
    this.ready = false;     // AudioContext 是否已创建并 running
    this.sampleRate = 48000;
    this.channels = 2;

    this.speed = 1.0;
    this.volume = 1.0;
    this.muted = false;

    this.bufferSeconds = 4;

    // —— 双声部 ——
    // 两个槽位循环复用：activeVoice 为当前主时钟声部，另一槽位在交叉淡入
    // 淡出时为副声部(淡入)，或为空闲。归一后槽位即回收，供下一次交叉淡入淡出使用。
    this.voices = [null, null];
    this.activeVoice = 0;

    // 2026-08: 声部化重构后 snapshot 属 Voice——暴露活跃声部快照给诊断/冒烟
    // (app-diagnostics 读 audio.snapshot.consumedFrames 判断音频时钟是否在走)
    this._snapshotFallback = { consumedFrames: 0, hasBase: false, playing: false, epoch: 0, bufferedFrames: 0, underruns: 0 };
    Object.defineProperty(this, 'snapshot', {
      enumerable: true,
      get() {
        const v = this.voices[this.activeVoice];
        return v && v.snapshot ? v.snapshot : this._snapshotFallback;
      },
    });

    // 上下文就绪前（首个用户手势之前）暂存的音频块，避免这段窗口里
    // 到达的 PCM 被静默丢弃
    this._pending = [];

    this.enabled = false; // 当前媒体是否有音频轨

    // —— 音频均衡器(EQ) ——
    // 10 段图示 EQ：每段一个 peaking BiquadFilter，插在声部总线与 analyser 之间。
    // 禁用/全平时 gain=0(peaking 透明)，链始终连接，无需重建 context。
    this.eqBands = new Array(EQ_FREQS.length).fill(0);
    this.eqEnabled = false;
    this.eqFilters = [];
    this._eqInput = null; // 各声部增益节点连到这里（EQ 链入口）

    this._wantPlay = false; // 顶层播放意图（上下文重建后补发）

    // ── 自动播放策略兜底 ──
    // 某些 Chromium 环境（远程桌面 / 组策略）对 AudioContext 自动播放硬性卡死，
    // 任何非手势手段都绕不过。play() 后若 context 仍 suspended 即视为"被卡住"，
    // 广播 lumen:audio-blocked，由 panels/audio-unlock.js 弹"点击启用声音"浮层。
    this._playAttempted = false;    // 是否尝试过 play（区分"被卡"与"本就没播"）
    this.blockedByAutoplay = false; // 当前是否因自动播放策略无声音
  }

  async init(bufferSeconds = 4) {
    this.bufferSeconds = bufferSeconds;
  }

  /** 感知线性音量（听感刻度 → 振幅刻度）。 */
  _workletVolume() {
    return Math.pow(Math.max(0, this.volume) / 100, 1.8);
  }

  /**
   * 惰性创建 AudioContext + AudioWorkletNode（主声部）。
   * 必须在用户手势调用栈内首次调用，context 才会以 running 态出生。
   *
   * 串行化：drop 手势解锁（resumeContext）与载入自动播放（onLoaded→play）
   * 可能并发进入本方法。若无保护会创建两个 AudioContext——后完成者覆盖
   * this.ctx，而声部 node 挂在先创建者上（先创建者的 this.ctx 已被覆盖，
   * 只留下孤儿 ctx 在工作），表现为：首曲无声、拖进度条后 play() 重走
   * _ensureContext 才自愈、第二首起正常（ctx 已存在，不再并发创建）。
   */
  async _ensureContext(forceRecreate = false) {
    if (this._ctxInFlight) {
      // 已有创建/重建在进行中：共享它，绝不并发创建第二个 AudioContext。
      // （forceRecreate 意图若被吞，play() 的 suspended 检测 + audio-unlock
      //   浮层仍能兜底：用户手势内点击 → resumeContext(true) 正常重建。）
      await this._ctxInFlight;
      return;
    }
    this._ctxInFlight = this._ensureContextInner(forceRecreate);
    try {
      await this._ctxInFlight;
    } finally {
      this._ctxInFlight = null;
    }
  }

  async _ensureContextInner(forceRecreate = false) {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        // 同步发起 resume，不能 await：某些 Chromium 环境（远程桌面/组策略）
        // 在无用户手势时 resume() 返回的 Promise 会永久 pending，一旦 await
        // 就会让 play() 永远挂在此处，后续检测 suspended / 弹"点击启用声音"
        // 浮层的代码永远执行不到。resume 是否成功由 play() 同步检查 state 决定。
        try { this.ctx.resume(); } catch { /* 尚无用户激活 */ }
      }
      if (this.ctx.state === 'running' || !forceRecreate) return;
      if (window.__lumenDebug) {
        window.__lumenDebug.log('AudioContext 仍 ' + this.ctx.state + '，手势内重建');
      }
      await this._closeContext();
    }

    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: this.sampleRate, latencyHint: 'playback' });
    } catch (err) {
      const msg = 'AudioContext 创建失败: ' + (err && err.message);
      console.error('[lumen]', msg, err);
      if (window.__lumenDebug) window.__lumenDebug.log(msg);
      this._notifyUnavailable(msg);
      this.ctx = null; this.ready = false;
      return;
    }

    this.sampleRate = ctx.sampleRate; // 回填真实采样率

    try {
      await this._loadWorklet(ctx);
    } catch (err) {
      const msg = 'AudioWorklet 加载失败: ' + (err && err.message);
      console.error('[lumen]', msg, err);
      if (window.__lumenDebug) window.__lumenDebug.log(msg);
      this._notifyUnavailable(msg);
      try { await ctx.close(); } catch { /* 已关闭 */ }
      this.ctx = null; this.ready = false;
      return;
    }

    // 频域分析节点 + 均衡器链（共享，所有声部都汇入这里）
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    // 降低时间平滑(0.82→0.5)：让频谱更跟拍、能砸出鼓点，而不是被时间平均抹平。
    analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -10;

    this.eqFilters = EQ_FREQS.map((f, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'peaking';
      bp.frequency.value = f;
      bp.Q.value = 1.0;
      bp.gain.value = this.eqEnabled ? (this.eqBands[i] || 0) : 0;
      return bp;
    });
    this._eqInput = this.eqFilters.length ? this.eqFilters[0] : analyser;
    for (let i = 0; i < this.eqFilters.length - 1; i++) {
      this.eqFilters[i].connect(this.eqFilters[i + 1]);
    }
    this.eqFilters[this.eqFilters.length - 1].connect(analyser);
    analyser.connect(ctx.destination);

    this.ctx = ctx;
    this.analyser = analyser;
    // 仅当 AudioContext 真正 running 才算就绪。suspended/error（无声卡、远程桌面
    // 未重定向音频）时保持 false —— 否则 clock 会误判音频时钟可用，走进 suspended
    // 下 mediaTime 固定值分支导致时钟卡死、视频帧不消费、画面冻结。
    this.ready = ctx.state === 'running';

    // ── 首曲无声根因修复 ──
    // 新建的 AudioContext 默认处于 suspended 态：即便已用 autoplay-policy=
    // no-user-gesture-required 放开手势限制，Chromium 仍不会让它自动 running，
    // 必须显式 resume() 一次。否则 worklet.process() 永远不会被调用 →
    // mediaTime 恒为 null → 时钟回退墙钟（时间码照走）→ 但完全无声。
    // 同步发起 resume 即可，不能 await：无手势环境 resume Promise 会永久 pending。
    if (ctx.state === 'suspended') {
      try { ctx.resume(); } catch { /* 仍需真实手势，交给 bindAudioUnlock */ }
    }

    console.log('[lumen][audio] AudioContext 已创建 state=' + ctx.state
      + ' baseLatency=' + (ctx.baseLatency || 0)
      + ' outputLatency=' + (ctx.outputLatency || 0)
      + ' sampleRate=' + ctx.sampleRate);
    ctx.onstatechange = () => {
      console.log('[lumen][audio] AudioContext state -> ' + ctx.state);
      if (ctx.state === 'running') {
        this.ready = true;  // AudioContext 真正 running：音频时钟可用
        // 解除卡住状态；若用户仍有播放意图，自动恢复播放（浮层点击后无需再点播放）
        this._setBlocked(false);
        if (this._wantPlay) this.play().catch(() => {});
      } else if (ctx.state === 'suspended') {
        this.ready = false;  // 被策略重新卡住：音频时钟不可用，回归系统时钟（不冻结视频）
        // 播放意图仍在（未暂停）却被打回 suspended：视为被策略重新卡住
        if (this._wantPlay) this._setBlocked(true);
      }
    };

    // 创建主声部（槽位 0）
    await this._ensureVoice(0);

    // 若是 force-recreate 重建的 context，顶层播放意图需重新下发
    if (this._wantPlay) this.voices[0].play();

    // 上下文就绪前暂存的音频块补发到主声部
    const pend = this._pending;
    this._pending = [];
    for (const p of pend) this.pushVoice(this.activeVoice, p.buffer, p.pts, p.epoch, p.pitched);
    this._drainVoice(this.activeVoice);
  }

  async _closeContext() {
    try { if (this.ctx && this.ctx.onstatechange) this.ctx.onstatechange = null; } catch { /* */ }
    if (this.voices[0]) await this.voices[0].close();
    if (this.voices[1]) await this.voices[1].close();
    this.voices = [null, null];
    if (this.eqFilters) {
      for (const f of this.eqFilters) { try { f.disconnect(); } catch { /* */ } }
      this.eqFilters = [];
    }
    if (this.analyser) { try { this.analyser.disconnect(); } catch { /* */ } this.analyser = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch { /* */ } }
    this.ctx = null; this.ready = false; this._eqInput = null;
  }

  /** 确保某槽位声部已创建并接入总线。 */
  async _ensureVoice(index) {
    if (this.voices[index]) return this.voices[index];
    const v = new Voice(this, index);
    this.voices[index] = v;
    if (this.ctx) await v.init(this.ctx);
    // 首曲无声根因（epoch 错配）：声部创建晚于音频层 flush（ctx 未就绪时
    // audio.flush 只记 _lastEpoch 不触达声部），声部出生 epoch=0，而首曲数据
    // 块（_pending 补发 + 实时流）都带真实 epoch → voice.push 按
    // `epoch !== this.epoch` 全部丢弃 → 无声直到 seek（seek 重建声部 epoch）。
    // 补种：把音频层记录的首个播放 epoch 灌给新声部（等价于声部当时就收到了 flush）。
    if (index === 0 && v._lastEpoch == null && this._lastEpoch != null) {
      v.flush(this._lastPts || 0, this._lastEpoch);
    }
    return v;
  }

  /** 创建并使用交叉淡入淡出副声部（槽位 1）。返回该声部。 */
  async ensureSecondary() {
    return this._ensureVoice(1);
  }

  async _loadWorklet(ctx) {
    const hasSource = window.lumen && typeof window.lumen.getAudioWorkletSource === 'function';
    const src = hasSource ? window.lumen.getAudioWorkletSource() : null;
    if (window.__lumenDebug) {
      window.__lumenDebug.log('worklet preload API=' + hasSource + ', srcLength=' + (src ? src.length : 0));
    }
    if (src) {
      const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
        if (window.__lumenDebug) window.__lumenDebug.log('worklet blob 加载成功');
        return;
      } catch (err) {
        URL.revokeObjectURL(blobUrl);
        if (window.__lumenDebug) window.__lumenDebug.log('worklet blob 加载失败: ' + (err && err.message));
        throw err;
      }
    }
    const url = new URL('./audio-worklet.js', import.meta.url).href;
    try {
      await ctx.audioWorklet.addModule(url);
    } catch (err) {
      if (window.__lumenDebug) window.__lumenDebug.log('worklet 直接加载失败，退回 blob: ' + (err && err.message));
      const s = await (await fetch(url)).text();
      const blobUrl = URL.createObjectURL(new Blob([s], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(blobUrl);
    }
  }

  _notifyUnavailable(message) {
    try { window.dispatchEvent(new CustomEvent('lumen:audio-unavailable', { detail: String(message || '') })); } catch { /* 无副作用 */ }
  }

  /** 浏览器的自动播放策略会让 AudioContext 处于 suspended，首次交互时恢复。 */
  async resumeContext(forceRecreate = false) {
    // 先同步 resume：Chrome 要求 AudioContext.resume() 必须在用户手势调用栈内
    // 触发。drop/click/keydown 等事件调用 resumeContext 时，这里立即同步 resume，
    // 比 await _ensureContext 后再 resume 更可靠；若 context 尚未创建，后续
    // _ensureContext 会负责创建并 resume（异步链在手势事件内，浏览器同样认可）。
    if (this.ctx && this.ctx.state === 'suspended') {
      try { this.ctx.resume(); } catch { /* 尚无用户激活 */ }
    }
    await this._ensureContext(forceRecreate);
    if (this.ready && this.voices[this.activeVoice]) {
      if (this._wantPlay) this.voices[this.activeVoice].play();
      this._drainVoice(this.activeVoice);
    }
  }

  /** 推入一块 PCM 到指定声部。buffer 会被 transfer。pitched=源是否已保音高。 */
  pushVoice(voice, buffer, pts, epoch, pitched) {
    if (!this.ready) {
      // 上下文还没创建（首个手势之前）：暂存到主声部槽，待 _ensureContext 后补发
      this._pending.push({ voice, buffer, pts, epoch, pitched });
      return;
    }
    const v = this.voices[voice];
    if (!v) return;
    v.push(buffer, pts, epoch, pitched);
  }

  /** 兼容旧调用：推到当前主声部。 */
  push(buffer, pts, epoch) {
    this.pushVoice(this.activeVoice, buffer, pts, epoch);
  }

  _drainVoice(index) {
    const v = this.voices[index];
    if (v) v._drain();
  }

  /** 当前音频播放到的媒体时间（来自主声部）。 */
  get mediaTime() {
    const v = this.voices[this.activeVoice];
    if (!v) return null;
    return v.mediaTime;
  }

  /**
   * 还有多少秒音频没播出去 —— 上游流控的输入信号。
   * 取所有已就绪声部的最大值：交叉淡入淡出时副声部可能先填满缓冲，
   * 必须据此掐住两个上游管线，否则副声部一路解码到 EOF 灌爆环形缓冲。
   *
   * 关键：必须计入上下文就绪前的暂存队列 `_pending`。首次打开播放器后
   * 拖入音乐时 AudioContext 尚未创建（惰性创建于首个 play()），这段窗口里
   * 到达的 PCM 全部暂存在 `_pending` 而不是声部 pending。若不计入，此窗口
   * bufferedSeconds 恒为 0 → 永不触发背压 → ffmpeg 一口气 dump 完整个文件
   * → 其 stdout 被抽空 → 立即 EOS → "播放结束"并弹回主页。这也是"首曲必现、
   * 续播正常"的根因（续播时上下文已就绪，音频直抵声部 pending，背压正常）。
   */
  get bufferedSeconds() {
    let max = 0;
    for (const v of this.voices) {
      if (v && v.ready) max = Math.max(max, v.workletSeconds + v.pendingFrames / this.sampleRate);
    }
    // 计入上下文就绪前的暂存（首次手势前到达的 PCM）
    let pendingSec = 0;
    for (const p of this._pending) {
      pendingSec += (p.buffer.length / this.channels) / this.sampleRate;
    }
    return max + pendingSec;
  }

  get workletSeconds() {
    const v = this.voices[this.activeVoice];
    return v ? v.workletSeconds : 0;
  }

  /**
   * 标记/解除"被自动播放策略卡住"。
   * 仅当确实因策略无声音时才置位并广播，避免在正常环境误弹兜底浮层。
   * panels/audio-unlock.js 监听这两个事件显示/隐藏"点击启用声音"浮层。
   */
  _setBlocked(blocked) {
    const was = this.blockedByAutoplay;
    if (blocked === was) return;
    this.blockedByAutoplay = blocked;
    try {
      if (blocked) {
        window.dispatchEvent(new CustomEvent('lumen:audio-blocked', { detail: { reason: 'autoplay-policy' } }));
      } else {
        window.dispatchEvent(new CustomEvent('lumen:audio-unblocked', {}));
      }
    } catch { /* 无副作用 */ }
  }

  async play() {
    this._playAttempted = true;
    this._wantPlay = true;
    await this._ensureContext();
    if (!this.ready) return;
    if (window.__lumenDebug) window.__lumenDebug.log('play() ctx=' + (this.ctx ? this.ctx.state : 'none') + ' enabled=' + this.enabled);
    if (this.ctx && this.ctx.state === 'suspended') {
      // 自动播放策略卡在 suspended：广播事件让 UI 弹"点击启用声音"兜底浮层。
      // 正常环境（resume 成功）不会走到这里；只有被硬性卡住才广播。
      console.warn('[lumen] AudioContext 仍为 suspended，自动播放策略未解除 —— 广播 audio-blocked（弹"点击启用声音"浮层）');
      this._setBlocked(true);
      return; // 等 onstatechange running 或浮层点击后再恢复播放
    }
    this._setBlocked(false);
    // 交叉淡入淡出进行中时副声部也在出声，暂停/恢复必须覆盖所有声部，
    // 否则会出现"主线静音、副线还在播"的割裂感。
    for (const v of this.voices) if (v) v.play();
    this._drainVoice(this.activeVoice);
  }

  pause() {
    this._wantPlay = false;
    for (const v of this.voices) if (v) v.pause();
  }

  /** seek：清空主声部缓冲并把时钟基准挪到新位置；顺便丢弃任何交叉淡入淡出副声部。 */
  flush(pts, epoch) {
    this._lastEpoch = epoch;
    this._lastPts = pts;
    const v = this.voices[this.activeVoice];
    if (v) v.flush(pts, epoch);
    // 主时钟 seek 时不应有任何副声部残留
    if (this.voices[1]) this.dropVoice(1);
    if (!this.ready) return;
  }

  /** 清空指定声部缓冲并重置其时钟。 */
  flushVoice(voice, pts, epoch) {
    const v = this.voices[voice];
    if (v) v.flush(pts, epoch);
  }

  setVolume(volume, muted) {
    this.volume = volume;
    this.muted = muted;
    if (!this.ready) return;
    for (const v of this.voices) if (v && v.ready) v.setWorkletVolume();
  }

  /**
   * 音频均衡器：实时改写 10 段 BiquadFilter 的增益(dB)。
   * 共享 EQ 链，所有声部都受益；context 未创建时仅保存状态。
   */
  setEqualizer(bands, enabled) {
    if (Array.isArray(bands)) {
      this.eqBands = bands.map((v) => Number(v) || 0).slice(0, EQ_FREQS.length);
      while (this.eqBands.length < EQ_FREQS.length) this.eqBands.push(0);
    }
    this.eqEnabled = enabled === undefined ? this.eqEnabled : !!enabled;
    if (!this.ctx || !this.eqFilters.length) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < this.eqFilters.length; i++) {
      const target = this.eqEnabled ? (this.eqBands[i] || 0) : 0;
      try { this.eqFilters[i].gain.setTargetAtTime(target, t, 0.015); } catch { /* 节点已被销毁 */ }
    }
  }

  /** 声卡输出延迟（秒）—— 音画同步必须补偿掉这一段 */
  get outputLatency() {
    if (!this.ctx) return 0;
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
  }

  get underruns() {
    const v = this.voices[this.activeVoice];
    return v ? v.snapshot.underruns : 0;
  }

  /** worklet 侧因环形缓冲溢出丢掉的帧数 —— 正常恒为 0，非 0 即背压失效 */
  get overflowFrames() {
    const v = this.voices[this.activeVoice];
    return v ? (v.snapshot.dropped || 0) : 0;
  }

  setSpeed(speed) {
    this.speed = speed;
    // 下发到所有已就绪声部 worklet：MF 源走 WSOLA 变速，ffmpeg(atempo) 源
    // 在 worklet 内不进入 WSOLA 分支，此值仅用于主线程时钟换算。
    for (const v of this.voices) {
      if (v && v.ready && v.node) v.node.port.postMessage({ type: 'speed', speed: this.speed });
    }
  }

  /**
   * 开始交叉淡入淡出斜坡：主声部系数 1→0，副声部系数 0→1。
   * @param {number} durationSec 过渡时长
   * @param {boolean} equalPower 是否 equal-power（默认 true）
   * @returns {number} 斜坡结束的绝对 AudioContext 时间（编排层据此定时提升）
   */
  beginCrossfade(durationSec, equalPower = true) {
    if (!this.ready || !this.ctx) return this.ctx ? this.ctx.currentTime : 0;
    const a = this.voices[this.activeVoice];
    const b = this.voices[this.activeVoice === 0 ? 1 : 0];
    if (a) a.rampCrossfade(0, durationSec, equalPower);
    if (b) b.rampCrossfade(1, durationSec, equalPower);
    return this.ctx.currentTime + durationSec;
  }

  /**
   * 提升交叉淡入淡出副声部为主声部：副声部成为新主时钟，旧主声部丢弃。
   * 提升后副声部槽位即回收，供下一次交叉淡入淡出复用。
   */
  promoteVoice() {
    const old = this.activeVoice;
    const neu = old === 0 ? 1 : 0;
    if (!this.voices[neu]) return; // 没有副声部可提升（异常情况，保持现状）
    // 新主声部系数复位为 1（斜坡已到 1，确保无残留过渡）
    const ng = this.voices[neu].gain;
    if (ng && this.ctx) ng.gain.cancelScheduledValues(this.ctx.currentTime);
    this.voices[neu].setCrossfade(1, 0.005);
    this.activeVoice = neu;
    this.dropVoice(old);
  }

  /** 丢弃指定声部（淡出后断开并释放槽位），用于交叉淡入淡出被打断或提升后清理。 */
  dropVoice(index) {
    const v = this.voices[index];
    if (!v) return;
    if (v.gain && this.ctx) {
      const now = this.ctx.currentTime;
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setTargetAtTime(0, now, 0.01);
    }
    // 给一个极短淡出后再断开，避免咔哒；用 setTimeout 不阻塞音频线程
    const node = v.node; const gain = v.gain;
    setTimeout(() => {
      if (node) { try { node.disconnect(); } catch { /* */ } try { if (node.port) node.port.onmessage = null; } catch { /* */ } }
      if (gain) { try { gain.disconnect(); } catch { /* */ } }
    }, 60);
    v.node = null; v.gain = null; v.ready = false;
    this.voices[index] = null;
  }

  /** 取消交叉淡入淡出：副声部淡出丢弃，主声部恢复满音量。 */
  cancelCrossfade() {
    const sec = this.activeVoice === 0 ? 1 : 0;
    const a = this.voices[this.activeVoice];
    if (a) a.rampCrossfade(1, 0.08, false); // 主声部迅速回满
    this.dropVoice(sec);
  }

  async close() {
    await this._closeContext();
  }
}
