'use strict';
/**
 * Media Foundation 解码后端（JS 封装）。
 *
 * 路线 A（彻底去 GPL）：用 Windows 系统自带的 Media Foundation
 * （IMFSourceReader）做音视频解码，替代 ffmpeg/mpv 二进制，不再随包
 * 分发 GPL 二进制，专利责任随系统授权转移给 Microsoft。
 *
 * 本类刻意对齐 ffmpeg 管线的 MediaPipeline 接口契约（事件名 / 载荷形状 /
 * 方法签名），使主进程控制面（ipc-player.js）、loadFile 路由（play-control.js）
 * 与媒体服务接线（media-pipeline.js 的 wirePipeline）零改动复用：
 *
 *   事件：video-frame / audio-chunk / eos / started / error / log
 *   方法：load / start / startAudioOnly / seek / setSpeed / setVideoTrack /
 *         setAudioTrack / throttle / stop
 *   属性：videoOutput / epoch / speed / hwaccel / videoTrack / audioTrack /
 *         voice / currentVideo / currentAudio
 *
 * 原生 addon（src/main/mf/native/mf_backend.cc）负责真正的解码与
 * NV12→I420 转换，暴露 open/start/stop/setThrottle 四个方法，通过回调
 * 把 {type:'video'|'audio'|'eos'|'error', ...} 事件回传。渲染端完全无感——
 * 它收到的 WebSocket 裸帧与 ffmpeg 管线同形（yuv420p / f32le）。
 *
 * 仅 Windows 可编译运行；其他平台构造 MfBackend 会得到清晰的报错。
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

/**
 * 懒加载原生模块。多候选路径覆盖「开发态」与「打包态」：
 *  - 开发态：src/main/mf/native/build/{Release,Debug}/mf_backend.node
 *  - 打包态：app.asar.unpacked 下的真实文件（asar 内的 .node 无法 require）
 * 模块顶层不加载原生，确保 `require('./mf/backend')` 在任意平台都不崩。
 */
function loadNative() {
  if (loadNative._mod) return loadNative._mod;

  const candidates = [];
  const devBase = path.join(__dirname, 'native');
  candidates.push(path.join(devBase, 'build', 'Release', 'mf_backend.node'));
  candidates.push(path.join(devBase, 'build', 'Debug', 'mf_backend.node'));
  candidates.push(path.join(devBase, 'mf_backend.node'));
  if (process.resourcesPath) {
    const unpacked = path.join(
      process.resourcesPath, 'app.asar.unpacked',
      'src', 'main', 'mf', 'native',
    );
    candidates.push(path.join(unpacked, 'build', 'Release', 'mf_backend.node'));
    candidates.push(path.join(unpacked, 'build', 'Debug', 'mf_backend.node'));
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      loadNative._mod = require(c);
      return loadNative._mod;
    }
  }
  throw new Error(
    'MediaFoundation 原生模块（mf_backend.node）未编译。\n' +
    '请在 Windows 上先运行：npm run rebuild-mf\n' +
    '（需要 Visual Studio 构建工具 + Python，且仅 Windows 可编译）',
  );
}

const AUDIO_SAMPLE_RATE = 48000; // 回报渲染端的采样率恒为 48000（PTS 公式基准）
const AUDIO_CHUNK_FRAMES = 2048; // 与原生侧切片一致

// MF 逐帧/逐包诊断日志开关。生产环境保持静默（避免每 60 帧/100 包的高频
// console.log 拖慢主进程）；设 LUMORA_MF_DEBUG=1 才开启，便于本地排查解码。
const MF_DEBUG = process.env.LUMORA_MF_DEBUG === '1';

class MfBackend extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.info = null;
    this.epoch = 0;

    this.videoTrack = 0;
    this.audioTrack = 0;
    this.speed = 1.0;
    this.startTime = 0;

    this.videoSeq = 0;
    this.audioSeq = 0;

    // 运行期诊断计数（release 后可删）
    this._diag = { v: 0, a: 0, eos: 0, err: 0 };

    // 已产出计数：用于 EOS 时区分"自然放完"与"解码失败"（对齐 ffmpeg 管线的
    // realDecodeError = _decodeError && audioFrameCount===0 守卫，避免把偶发
    // 可恢复坏帧误报成"无法解码该文件"并误回主页）
    this._audioEmitted = 0;
    this._videoEmitted = 0;

    this.hwaccel = opts.hwaccel || 'auto'; // 'auto' | 'no'
    this.voice = opts.voice || 0;          // 0=主声部 1=交叉淡入淡出副声部
    this._maxWidth = opts.maxWidth || 1920;
    this._audioOnly = false;

    // 原生层回报的元信息
    this._nativeSampleRate = AUDIO_SAMPLE_RATE;
    this._nativeChannels = 2;
    this._fpsNum = 25;
    this._fpsDen = 1;

    this.videoOutput = null; // { width, height, pixfmt, frameSize, fps }

    // 解码失败标记：与 MediaPipeline 同语义，供 wirePipeline 的 error 处理去重
    this._decodeError = false;
    // 硬解试探状态（MF 自带 DXVA 回退，不主动发 hwaccel-fallback，仅占位以满足守卫）
    this.hwaccelTentative = false;
    this.hwaccelFailed = false;

    this._reader = null;
    try {
      const native = loadNative();
      this._reader = new native.MediaFoundationReader();
    } catch (e) {
      // 构造失败（模块未编译 / 非 Windows）先记下，start 时再抛出明确错误
      this._initError = e;
    }
  }

  get available() { return !!this._reader; }

  /* ---------------- 载入探测结果（仅存信息，解码等 start） ---------------- */

  load(info) {
    this.info = info;
    this.videoTrack = 0;
    this.audioTrack = 0;
    this.startTime = 0;
    this.videoSeq = 0;
    this.audioSeq = 0;
    this._audioEmitted = 0;
    this._videoEmitted = 0;
    this._audioOnly = !!(info && info.audioOnly);
    this.hwaccelFailed = false;
    this.videoOutput = null;
  }

  get currentVideo() {
    return this.info && this.info.video && this.info.video[this.videoTrack]
      ? this.info.video[this.videoTrack] : null;
  }

  get currentAudio() {
    return this.info && this.info.audio && this.info.audio[this.audioTrack]
      ? this.info.audio[this.audioTrack] : null;
  }

  get outputFps() {
    const v = this.currentVideo;
    if (!v) return 25;
    return Math.min(Math.max(v.fps || 25, 1), 240);
  }

  /* ---------------- 内部：把原生 open 回报的 meta 落成本地状态 ---------------- */

  _applyMeta(meta) {
    this._nativeSampleRate = meta.sampleRate || AUDIO_SAMPLE_RATE;
    // 输出强制立体声（原生 ConfigureAudioOutput 已下混），所以"已交付音频格式"
    // 的声道数恒为 2，与 ffmpeg 管线 started 报告的 AUDIO_CHANNELS=2 对齐；
    // meta.channels 是源文件原始声道数（仅作诊断），不用于播放契约。
    this._nativeChannels = 2;
    this._fpsNum = meta.fpsNum || 25;
    this._fpsDen = meta.fpsDen || 1;
    // 解码侧真实像素宽高比（SAR）；MF 原生层输出「源原生存储尺寸」、不预拉伸，
    // 此处把 sar 带入 videoOutput 供渲染端 _buildTransform 按 DAR（宽×SAR）适配；
    // 同时回写媒体信息使窗口尺寸（ipc-window.js 的 v.width * v.sar）拿到正确值。
    this._sar = (typeof meta.sar === 'number' && meta.sar > 0) ? meta.sar : 1;

    if (meta.hasVideo && !this._audioOnly) {
      const w = meta.width | 0;
      const h = meta.height | 0;
      this.videoOutput = {
        width: w,
        height: h,
        pixfmt: 'yuv420p', // 原生层已把 NV12 解交织成 I420，渲染端零改动
        frameSize: Math.floor(w * h * 1.5),
        fps: (this._fpsNum / Math.max(this._fpsDen, 1)) || 25,
        sar: this._sar,
      };
      // 以解码侧真实 SAR 为准回写媒体信息：anamorphic 素材（如 1440x1080 SAR
      // 4:3 → 应显示 16:9）窗口尺寸（v.width * v.sar）必须拿到正确 SAR，否则
      // OS 窗口会被压成 4:3。仅当 SAR 显著非 1 时才覆盖（方形像素源保留 probe
      // 的原值，避免无意义改动）。注意：此处只影响窗口尺寸，渲染端显示由
      // videoOutput.sar 经 _configureVideo 单独传入，不会与窗口尺寸重复计算。
      if (this._sar > 1.001 || this._sar < 0.999) {
        const v = this.info && this.info.video && this.info.video[this.videoTrack];
        if (v) {
          v.sar = this._sar;
          v.dar = ((v.width || w) * this._sar) / (v.height || h);
        }
      }
    } else {
      this.videoOutput = null;
    }
  }

  /* ---------------- 启动解码 ---------------- */

  /**
   * 从指定时间点启动解码。先 open（创建 SourceReader + 协商格式），
   * 再 start（拉起工作线程）。每次启动递增代际号（epoch）隔离陈旧数据，
   * 渲染端按 epoch 丢弃 seek 前的旧帧。
   */
  start(atTime = 0) {
    if (!this.info) throw new Error('尚未载入媒体');
    if (!this._reader) throw this._initError || new Error('MediaFoundation 后端未初始化');

    this.epoch++;
    this.startTime = Math.max(0, atTime);
    this._audioEmitted = 0;
    this._videoEmitted = 0;
    this._decodeError = false;

    let meta;
    try {
      meta = this._reader.open(this.info.path, {
        videoTrack: this.videoTrack,
        audioTrack: this.audioTrack,
        maxWidth: this._maxWidth,
        audioOnly: this._audioOnly,
        hwaccel: this.hwaccel,
      });
    } catch (e) {
      this._decodeError = true;
      this.emit('error', e);
      this.emit('started', {
        epoch: this.epoch, startTime: this.startTime, video: null, audio: null,
      });
      this.emit('eos', { epoch: this.epoch, decodeError: true, detail: e.message });
      return this.epoch;
    }

    this._applyMeta(meta);
    if (!meta.hasAudio) {
      console.warn('[lumen][mf] 未检测到可解码音频流（ATMOS/E-AC3/TrueHD 可能需要系统杜比解码器，视频仍会播放）');
    }
    this._reader.start(
      (ev) => this._onNative(ev),
      {
        startTime: this.startTime,
        speed: this.speed,
        videoThrottled: false,
        audioThrottled: false,
      },
    );

    this.emit('started', {
      epoch: this.epoch,
      startTime: this.startTime,
      video: this.videoOutput ? { ...this.videoOutput, hwaccel: this.hwaccel } : null,
      audio: this.currentAudio
        ? { sampleRate: AUDIO_SAMPLE_RATE, channels: this._nativeChannels }
        : null,
    });
    return this.epoch;
  }

  /**
   * 仅音频解码（交叉淡入淡出副声部专用）。声部标签由 voice 指定，
   * 与 MediaPipeline.startAudioOnly(atTime, voice) 同语义。
   */
  startAudioOnly(atTime = 0, voice = this.voice) {
    if (!this.info) throw new Error('尚未载入媒体');
    if (!this._reader) throw this._initError || new Error('MediaFoundation 后端未初始化');

    this.epoch++;
    this.startTime = Math.max(0, atTime);
    this.voice = voice;
    this._audioEmitted = 0;
    this._videoEmitted = 0;
    this._decodeError = false;

    let meta;
    try {
      meta = this._reader.open(this.info.path, {
        videoTrack: this.videoTrack,
        audioTrack: this.audioTrack,
        maxWidth: this._maxWidth,
        audioOnly: true, // 副声部只解音频，跑到 EOF 供渲染端背压限速
        hwaccel: this.hwaccel,
      });
    } catch (e) {
      this._decodeError = true;
      this.emit('error', e);
      this.emit('started', {
        epoch: this.epoch, startTime: this.startTime, video: null, audio: null,
      });
      this.emit('eos', { epoch: this.epoch, decodeError: true, detail: e.message });
      return this.epoch;
    }

    this._applyMeta(meta);
    if (!meta.hasAudio) {
      console.warn('[lumen][mf] 未检测到可解码音频流（ATMOS/E-AC3/TrueHD 可能需要系统杜比解码器，视频仍会播放）');
    }
    this._reader.start(
      (ev) => this._onNative(ev),
      {
        startTime: this.startTime,
        speed: this.speed,
        videoThrottled: false,
        audioThrottled: false,
      },
    );

    this.emit('started', {
      epoch: this.epoch,
      startTime: this.startTime,
      video: null,
      audio: this.currentAudio
        ? { sampleRate: AUDIO_SAMPLE_RATE, channels: this._nativeChannels }
        : null,
    });
    return this.epoch;
  }

  seek(time) {
    const dur = this.info ? this.info.duration : 0;
    const t = Math.max(0, dur > 0 ? Math.min(time, dur - 0.05) : time);
    return this.start(t);
  }

  setSpeed(speed, currentTime) {
    const s = Math.min(Math.max(speed, 0.05), 16);
    if (Math.abs(s - this.speed) < 1e-6) return null;
    this.speed = s;
    // 变速需重启解码：原生按 48000/speed 重配置输出采样率（与 ffmpeg atempo 同 PTS 公式）
    return this.start(currentTime);
  }

  setVideoTrack(idx, currentTime) {
    if (!this.info || !this.info.video || !this.info.video[idx]) return null;
    this.videoTrack = idx;
    return this.start(currentTime);
  }

  setAudioTrack(idx, currentTime) {
    if (!this.info || !this.info.audio || !this.info.audio[idx]) return null;
    this.audioTrack = idx;
    return this.start(currentTime);
  }

  /**
   * 背压控制：独立暂停/恢复音频和视频流读取（原生层按 atomic 标志跳过读取）。
   * 形状不符时记告警并跳过，绝不擅自改变任一通道的节流状态（对齐 MediaPipeline）。
   */
  throttle(state) {
    if (typeof state !== 'object' || state === null) {
      console.warn('[lumen][mf] throttle 收到非法信号，已忽略:', state);
      return;
    }
    if (!this._reader) return;
    this._reader.setThrottle({ audio: !!state.audio, video: !!state.video });
  }

  stop() {
    this.epoch++;
    if (this._reader) this._reader.stop();
  }

  /** 交叉淡入淡出取消时直接停掉副声部（对齐 MediaPipeline._killProcs 的语义）。 */
  _killProcs() {
    if (this._reader) this._reader.stop();
  }

  /* ---------------- 原生事件翻译 ---------------- */

  _onNative(ev) {
    try {
    switch (ev.type) {
      case 'video':
        this._diag.v++;
        this._videoEmitted++;
        // 2026-08 Pull 方案:TSFN 只发 frameId 信号,数据经 readFrame 普通调用拉取
        // (TSFN 回调里创建大 Buffer 在 electron 必崩;普通调用 3MB 安全)。
        let data = null;
        try { data = this._reader.readFrame(ev.frameId); } catch { data = null; }
        if (MF_DEBUG && (this._diag.v <= 3 || this._diag.v % 60 === 0)) {
          console.log(`[lumen][mf] video-frame #${this._diag.v} pts=${ev.pts.toFixed(3)} w=${ev.width} h=${ev.height} bytes=${data && data.length}`);
        }
        this.emit('video-frame', {
          data,
          pts: ev.pts,
          seq: this.videoSeq++,
          epoch: this.epoch,
          width: ev.width,
          height: ev.height,
        });
        break;
      case 'audio':
        this._diag.a++;
        this._audioEmitted++;
        if (MF_DEBUG && (this._diag.a <= 3 || this._diag.a % 100 === 0)) {
          console.log(`[lumen][mf] audio-chunk #${this._diag.a} pts=${ev.pts.toFixed(3)} frames=${ev.frames} sr=${ev.sampleRate} ch=${ev.channels} bytes=${ev.buffer && ev.buffer.length}`);
        }
        this.emit('audio-chunk', {
          data: ev.buffer,
          pts: ev.pts,
          seq: this.audioSeq++,
          epoch: this.epoch,
          voice: this.voice,
          frames: ev.frames,
          sampleRate: ev.sampleRate,
          channels: ev.channels,
        });
        break;
      case 'eos':
        this._diag.eos++;
        console.log(`[lumen][mf] eos decodeError=${ev.decodeError} audioEmitted=${this._audioEmitted} videoEmitted=${this._videoEmitted}`);
        // 与 ffmpeg 管线对齐（2026-08-09 健壮性修正）：仅当「确无音频产出」时
        // 才算解码失败，否则中途遇到的可恢复坏帧（已产出音频）按自然放完处理，
        // 避免把偶发坏帧误报成"无法解码该文件"并误回主页。
        const realDecodeError = ev.decodeError && this._audioEmitted === 0;
        this.emit('eos', {
          epoch: this.epoch,
          decodeError: realDecodeError,
          detail: realDecodeError ? 'MediaFoundation 解码中断' : null,
        });
        break;
      case 'error':
        this._diag.err++;
        console.log(`[lumen][mf] error: ${ev.message}`);
        this._decodeError = true;
        this.emit('error', new Error(ev.message || 'MediaFoundation 解码错误'));
        break;
      default:
        break;
    }
    } catch (e) {
      console.error('[lumen][mf] _onNative 异常:', e && e.message ? e.message : e);
    }
  }
}

module.exports = { MfBackend, AUDIO_SAMPLE_RATE, AUDIO_CHUNK_FRAMES };
