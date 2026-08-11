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
        break;
      case 'volume':
        this.gainTarget = msg.muted ? 0 : Math.max(0, Math.min(msg.volume, 2));
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

    if (!this.playing || this.available < need) {
      // 缺数据：输出静音。绝不能输出上一帧的残留，那是刺耳的嗡鸣
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      if (this.playing && this.available < need) this.underruns++;
      this._maybeReport(frames);
      return true;
    }

    // 音量平滑系数：约 5ms 时间常数，足够快到跟手，又不会咔哒
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
    // 声道数不匹配时（比如输出设备是单声道），把多余通道填静音
    for (let c = this.channels; c < output.length; c++) output[c].fill(0);

    this.readPos = rp;
    this.available -= need;
    this.consumedFrames += frames;

    this._maybeReport(frames);
    return true;
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
