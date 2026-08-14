/**
 * 本文件经 blob: URL 加载进 AudioWorkletGlobalScope，相对路径 import 无法解析
 * （blob 是非层级化 scheme），故 clamp 必须内联、保持 worklet 自包含。
 * 语义与 src/shared/clamp.js 逐字节一致（含 swap 保护）。
 */
function clamp(value, min, max) {
  if (min > max) { const t = min; min = max; max = t; }
  return Math.max(min, Math.min(value, max));
}

/**
 * 音频输出 Worklet —— 同时是整个播放器的主时钟源。
 *
 * 为什么音频当主时钟：人耳对音频的连续性极度敏感，0.5% 的音高抖动
 * 就能听出来；而视频掉一两帧几乎无感。所以正确做法永远是让音频
 * 自由跑（由声卡晶振驱动），视频去追音频。反过来做的播放器都会爆音。
 *
 * 这里跑在音频渲染线程上，每 128 帧被调用一次（@48kHz 约 2.67ms）。
 * 这个线程里任何阻塞、任何 GC 都会直接变成爆音，所以：
 *   - 零分配（所有缓冲预分配）
 *   - 无异常抛出
 *   - 上报走节流，不是每次 process 都发消息
 */

const REPORT_INTERVAL = 24; // 每 24 次 process 上报一次 ≈ 64ms，够时钟插值用了

/**
 * WSOLA（波形相似重叠相加）时域变速保音高核心。
 * 抽成顶层纯函数，便于 node 离线单元测试直接抽取验证（与 worklet 内联、无
 * import，blob 加载安全）。设计要点见 LumenAudioProcessor._wsolaProcess 注释。
 * 所有状态挂在传入的 processor p 上，运行时零额外分配。
 */
/**
 * WSOLA 时域变速保音高核心（完整版）。
 * 抽成顶层纯函数，便于 node 离线单元测试直接抽取验证（与 worklet 内联、无
 * import，blob 加载安全）。设计要点：
 *   - 分析 hop Ha = HS * speed：每帧消费 Ha 个样本、产出 HS 个 → 时长缩放 1/speed。
 *   - 波形相似搜索：在重叠段(合成缓冲尾)找使"分析窗口头"最相似的相位偏移 δ，
 *     把由 Ha≠HS 引起的逐帧相位突变校正回信号周期 → 严格保音高（关键修复）。
 *   - M 互补半正弦窗（M=W/HS）：Σ_{m} win[n+m*HS]² ≡ 1，四重叠帧相加幅度守恒、
 *     无爆音、无振幅调制。
 * 所有状态挂在传入的 processor p 上，运行时零额外分配。
 */
function wsolaSynthesize(p, output, frames, ch) {
  const W = p.WSOLA_W, HS = p.WSOLA_HS, SEARCH = p.WSOLA_SEARCH;
  const overlapLen = W - HS;
  const chN = p.channels, cap = p.capacity, ring = p.ring;
  // 分析 hop（样本/声道）：Ha = HS * speed。变速的时间伸缩完全由 Ha 决定
  // （每帧消费 Ha、产出 HS），音高则由下方波形相似搜索保住，与 Ha 无关。
  // W-HS 是分析窗口重叠量，须 > 0 供搜索找相位；故 Ha 上限钳到 W-1，
  // 对应 speed 上限 (W-1)/HS ≈ 4（W=512, HS=128），超出则钳制、不丢段。
  const effSpeed = clamp(p.speed, 0.05, 4);
  const Ha = clamp(Math.round(HS * effSpeed), 1, W - 1);

  // 波形相似搜索：直接在分析位置附近以绝对偏移 δ∈[-SEARCH,SEARCH] 搜索。
  // 信号的周期性会把相位对齐折叠进这个窗口，故 δ 始终有界、不会逐帧累积漂移
  // （否则会与 Ha 相消、毁掉时间伸缩）；分析指针仍每帧前进 Ha，时间缩放 = HS/Ha = 1/speed。
  const first = (p.wsolaDelta === null || p.wsolaDelta === undefined);

  // 可用性检查：最远向前读 SEARCH+(W-1) 个样本（δ 有界，故窗口固定）。
  const fwdMax = SEARCH + (W - 1);
  if (p.available < (fwdMax + 2) * chN) {
    for (let c = 0; c < output.length; c++) output[c].fill(0);
    return false;
  }

  const win = p.wsolaWin, synth = p.wsolaSynth, ana = p.wsolaAna;
  const idx = (frameOff, c) => {
    let q = p.readPos + frameOff * chN + c;
    q %= cap; if (q < 0) q += cap;
    return q;
  };

  // —— 波形相似搜索（WSOLA 核心）——
  // 比较候选偏移下"分析窗口头(原始样本)"与合成缓冲重叠段(左移后位于 synth[0..overlapLen)，
  // 稳态即上一帧已重建信号) 的差方和，取最小者为最优相位偏移 bestDelta。用原始样本
  // 而非加窗值比较，避免相位估计偏置（这是保音高的关键）。首帧尚无重叠段可参照，直取 δ=0。
  let bestDelta = 0;
  if (!first) {
    let bestCost = Infinity;
    for (let d = -SEARCH; d <= SEARCH; d++) {
      const delta = d;
      let cost = 0;
      for (let c = 0; c < chN; c++) {
        const sOff = W * c; // 重叠段位于 synth[0..overlapLen)（左移后）
        for (let k = 0; k < overlapLen; k++) {
          const head = ring[idx(delta + k, c)];
          const diff = head - synth[sOff + k];
          cost += diff * diff;
        }
      }
      if (cost < bestCost) { bestCost = cost; bestDelta = delta; }
    }
  }

  // 读分析窗口 + 加窗（以 bestDelta 为起点）
  for (let c = 0; c < chN; c++) {
    const off = W * c;
    for (let n = 0; n < W; n++) {
      ana[off + n] = ring[idx(bestDelta + n, c)] * win[n];
    }
  }
  // 重叠相加进合成缓冲（全 W 长度累加；互补窗保证稳态幅度=1）
  for (let c = 0; c < chN; c++) {
    const off = W * c;
    for (let n = 0; n < W; n++) synth[off + n] += ana[off + n];
  }
  // 输出合成缓冲前 HS 个样本
  const smooth = 1 - Math.exp(-1 / (p.sampleRate_ * 0.005));
  for (let k = 0; k < HS; k++) {
    p.gainCurrent += (p.gainTarget - p.gainCurrent) * smooth;
    const g = p.gainCurrent;
    for (let c = 0; c < ch; c++) output[c][k] = synth[W * c + k] * g;
  }
  for (let c = ch; c < output.length; c++) output[c].fill(0);
  // 合成缓冲左移 HS：重叠段(尾)前移，新尾区清零等待下一帧填充
  for (let c = 0; c < chN; c++) {
    const off = W * c;
    for (let n = 0; n < overlapLen; n++) synth[off + n] = synth[off + n + HS];
    for (let n = overlapLen; n < W; n++) synth[off + n] = 0;
  }

  p.wsolaDelta = bestDelta;
  p.readPos = (p.readPos + Ha * chN) % cap;
  p.available -= Ha * chN;
  return true;
}

class LumenAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};

    this.channels = opt.channels || 2;
    this.sampleRate_ = opt.sampleRate || 48000;

    // 环形缓冲：默认 4 秒容量。够大以吸收调度抖动，
    // 又不至于让 seek 后残留太多旧音频
    const seconds = opt.bufferSeconds || 4;
    this.capacity = Math.ceil(this.sampleRate_ * seconds) * this.channels;
    this.ring = new Float32Array(this.capacity);
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0; // 环形缓冲内可读的样本数（含所有声道）

    this.consumedFrames = 0;  // 累计已送出声卡的帧数 —— 时钟的基准
    this.basePts = 0;         // 当前代际第一个音频块的 PTS
    this.epoch = 0;
    this.playing = false;
    this.volume = 1.0;
    this.muted = false;
    this.underruns = 0;
    this.dropped = 0; // 环形缓冲溢出丢弃的帧数。背压正常时恒为 0
    this.tick = 0;

    // —— 变速保音高（WSOLA）——
    // MF 引擎按原始 48k 输出 PCM（不变调），倍速的"时间伸缩"在消费侧用
    // WSOLA（波形相似重叠相加）完成：保持音高、只缩放时长。ffmpeg 引擎已在
    // 解码侧用 atempo 保音高（pitched=true），这里直接直出、不再二次变速。
    // 窗口/跳跃常量在构造期固定，运行时零分配。
    this.speed = 1.0;
    this.pitched = false; // 当前 epoch 源是否已保音高（true=直出，false=WSOLA）
    this.WSOLA_W = 512;        // 分析/合成窗口长（样本）；M=W/HS=4 重叠
    this.WSOLA_HS = 128;       // 合成 hop = 每 process 输出帧数（与 128 对齐）
    this.WSOLA_SEARCH = 128;   // 波形相似搜索范围（±样本）；覆盖至 ~187Hz 周期
    // M 互补(线性)窗：win[n] = (2/M)·sin²(πn/W)，M=W/HS。
    // 关键性质 Σ_{m=0}^{M-1} win[n+m*HS] ≡ 1（对任意 n），故四重叠帧的重叠相加
    // 幅度严格守恒=1、无爆音、无振幅调制（这是线性互补，区别于仅平方互补的窗）。
    const WSOLA_M = this.WSOLA_W / this.WSOLA_HS;
    this.wsolaWin = new Float32Array(this.WSOLA_W);
    for (let n = 0; n < this.WSOLA_W; n++) {
      const s = Math.sin((Math.PI * n) / this.WSOLA_W);
      this.wsolaWin[n] = (2 / WSOLA_M) * s * s;
    }
    // 合成缓冲（完整 OLA 累加器，长度 W*声道）：每帧加窗写入、取前 HS 输出、左移 HS。
    this.wsolaSynth = new Float32Array(this.WSOLA_W * this.channels);
    this.wsolaAna = new Float32Array(this.WSOLA_W * this.channels);
    this.wsolaDelta = null;    // 上一帧选定的相位偏移（搜索状态；null=首帧不搜索）

    // 音量渐变：直接跳变会产生咔哒声，用一阶平滑过渡
    this.gainCurrent = 1.0;
    this.gainTarget = 1.0;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'push': {
        // 收到的是 transferable ArrayBuffer，零拷贝送达
        const data = new Float32Array(msg.buffer);
        if (msg.epoch !== this.epoch) return; // seek 后的陈旧数据
        // 源是否已在解码侧保音高：ffmpeg(atempo)=true → 直出；MF 原始=false → WSOLA
        const np = !!msg.pitched;
        if (np !== this.pitched) this.wsolaDelta = null; // 引擎切换，重置相位搜索
        this.pitched = np;
        this._write(data);
        if (!this.hasBase) {
          this.basePts = msg.pts;
          this.hasBase = true;
        }
        break;
      }
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'speed':
        // 倍速：仅更新 speed。MF 原始 48k PCM 的"时间伸缩"由 WSOLA 完成，
        // 不重启解码、不变采样率。重置相位搜索以适配新的分析 hop。
        this.speed = clamp(msg.speed || 1, 0.05, 16);
        this.wsolaDelta = null;
        break;
      case 'flush':
        // seek：丢弃全部缓冲，重置时钟基准
        this.writePos = 0;
        this.readPos = 0;
        this.available = 0;
        this.consumedFrames = 0;
        this.basePts = msg.pts || 0;
        this.hasBase = false;
        this.epoch = msg.epoch;
        this.underruns = 0;
        this.dropped = 0;
        this.wsolaSynth.fill(0); // 清空 WSOLA 合成缓冲
        this.wsolaDelta = null;  // 重置相位搜索
        break;
      case 'volume':
        this.gainTarget = msg.muted ? 0 : clamp(msg.volume, 0, 2);
        this.muted = !!msg.muted;
        break;
      case 'epoch':
        this.epoch = msg.epoch;
        break;
    }
  }

  _write(data) {
    const n = data.length;
    // 缓冲满了就丢最老的数据。正常情况下主线程的暂存队列会把水位卡在
    // 1 秒，根本走不到这里；真走到了说明背压彻底失效。
    //
    // 注意 consumedFrames 必须跟着推进：它是"流内位置"而不是"播了多久"，
    // 丢掉的样本同样占据流内位置，不推进的话 basePts + consumed 换算出来的
    // 媒体时间会永久性偏后。代价是主时钟会瞬间前跳 —— 所以这里单独计数，
    // 让这种失真在统计面板里现形，而不是被当成"音画不同步"去瞎调。
    if (this.available + n > this.capacity) {
      const overflow = this.available + n - this.capacity;
      this.readPos = (this.readPos + overflow) % this.capacity;
      this.available -= overflow;
      this.consumedFrames += overflow / this.channels;
      this.dropped += overflow / this.channels;
    }

    const first = Math.min(n, this.capacity - this.writePos);
    this.ring.set(data.subarray(0, first), this.writePos);
    if (first < n) {
      this.ring.set(data.subarray(first), 0);
    }
    this.writePos = (this.writePos + n) % this.capacity;
    this.available += n;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const frames = output[0].length;
    const ch = Math.min(this.channels, output.length);
    const need = frames * this.channels;

    if (!this.playing) {
      // 暂停态：输出静音，但时钟仍回报（让 mediaTime 维持现状，不漂移）
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      this._maybeReport(frames);
      return true;
    }

    const useWsola = !this.pitched && Math.abs(this.speed - 1) > 1e-4;
    if (!useWsola) {
      if (this.available < need) {
        // 缺数据：输出静音。绝不能输出上一帧的残留，那是刺耳的嗡鸣
        for (let c = 0; c < output.length; c++) output[c].fill(0);
        this.underruns++;
        this._maybeReport(frames);
        return true;
      }
      // 1:1 直出：ffmpeg(atempo) 已保音高，或 speed=1 无需变速
      const smooth = 1 - Math.exp(-1 / (this.sampleRate_ * 0.005));
      let rp = this.readPos;
      for (let i = 0; i < frames; i++) {
        this.gainCurrent += (this.gainTarget - this.gainCurrent) * smooth;
        const g = this.gainCurrent;
        for (let c = 0; c < this.channels; c++) {
          const s = this.ring[rp] * g;
          if (c < ch) output[c][i] = s;
          rp++;
          if (rp === this.capacity) rp = 0;
        }
      }
      for (let c = this.channels; c < output.length; c++) output[c].fill(0);
      this.readPos = rp;
      this.available -= need;
      this.consumedFrames += frames;
      this._maybeReport(frames);
      return true;
    }

    // WSOLA 分支：MF 引擎原始 48k PCM，消费侧按时域伸缩保音高。
    // consumedFrames 记的是"墙钟帧数"（声卡实际播放帧），与 1:1 分支一致，
    // 主线程 mediaTime = basePts + consumed/48k * speed 因此仍正确（无需改时钟）。
    this._wsolaProcess(output, frames, ch);
    this.consumedFrames += frames;
    this._maybeReport(frames);
    return true;
  }

  /**
   * 波形相似重叠相加（WSOLA）时域变速保音高。
   * 合成 hop HS=128（=每 process 输出帧数），分析 hop Ha=round(128*speed)；
   * 窗口 W=512、M=4 互补半正弦窗（四重叠帧相加幅度严格守恒）；
   * 在 ±SEARCH 内做波形相似搜索，把由 Ha≠HS 引起的逐帧相位突变校正回信号周期，
   * 从而变速严格保音高，避免 watery / 相位伪影。实现见顶层 wsolaSynthesize。
   */
  _wsolaProcess(output, frames, ch) {
    const ok = wsolaSynthesize(this, output, frames, ch);
    if (!ok) this.underruns++;
  }

  _maybeReport(frames) {
    this.tick++;
    if (this.tick % REPORT_INTERVAL !== 0) return;
    this.port.postMessage({
      type: 'clock',
      consumedFrames: this.consumedFrames,
      basePts: this.basePts,
      hasBase: !!this.hasBase,
      // currentTime 是 AudioWorkletGlobalScope 的全局量，等于 AudioContext.currentTime
      contextTime: currentTime,
      bufferedFrames: this.available / this.channels,
      underruns: this.underruns,
      dropped: this.dropped,
      playing: this.playing,
      epoch: this.epoch,
    });
  }
}

registerProcessor('lumen-audio', LumenAudioProcessor);
