'use strict';
const { clamp } = require('../clamp');
/**
 * FFmpeg 解码管线。
 *
 * 设计要点（这些决策直接决定播放是否稳）：
 *
 * 1) 视频与音频各起一个 ffmpeg 子进程。
 *    单进程输出双流需要复用成容器再自己解析，得不偿失；两进程各自
 *    stdout 是干净的裸流，文件被读两遍的代价由 OS 页缓存兜底。
 *
 * 2) rawvideo 不携带 PTS，所以强制 CFR 输出（-vsync cfr -r fps），
 *    PTS = seekBase + frameIndex / fps。ffmpeg 会自动复制/丢弃帧来
 *    匹配恒定帧率，对 CFR 源精确，对 VFR 源也能保证时间轴单调。
 *    音频侧则用 samplesWritten / sampleRate 精确推算，作为主时钟。
 *
 * 3) 不做"暂停子进程"这种事 —— 直接靠背压。渲染端停止消费 →
 *    WebSocket bufferedAmount 上涨 → 我们 pause() stdout →
 *    管道填满 → ffmpeg 自己阻塞在 write 上。零额外状态。
 *
 * 4) seek 用代际号(epoch)隔离。旧进程的 in-flight 数据带着旧 epoch，
 *    渲染端一律丢弃，不会出现 seek 后闪回旧画面的经典 bug。
 */

const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');
const { resolveBinary } = require('./binaries');
const { frameSize, normalizePixFmt } = require('../../shared/protocol');

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BYTES_PER_SAMPLE = 4; // f32le
const AUDIO_CHUNK_FRAMES = 2048;  // 每包 2048 帧 ≈ 42.6ms @48k，兼顾延迟与包开销

/**
 * 把 ffmpeg 的流式 stdout 按固定长度切成完整单元。
 *
 * 直接 Buffer.concat 每个 chunk 会产生大量内存拷贝（1080p 一帧 3MB，
 * 30fps 就是 90MB/s 的无谓拷贝）。这里用 chunk 队列 + 字节计数，
 * 只在真正凑够一个单元时做一次拷贝，且单 chunk 够大时走零拷贝 subarray。
 */
class FixedSizeSlicer {
  constructor(unitSize, onUnit) {
    this.unitSize = unitSize;
    this.onUnit = onUnit;
    this.chunks = [];
    this.pending = 0;
  }

  push(chunk) {
    // 快路径：缓冲区为空且当前 chunk 恰好包含 N 个完整单元 → 零拷贝
    if (this.pending === 0 && chunk.length >= this.unitSize) {
      let off = 0;
      while (chunk.length - off >= this.unitSize) {
        this.onUnit(chunk.subarray(off, off + this.unitSize));
        off += this.unitSize;
      }
      if (off < chunk.length) {
        this.chunks.push(chunk.subarray(off));
        this.pending = chunk.length - off;
      }
      return;
    }

    this.chunks.push(chunk);
    this.pending += chunk.length;

    while (this.pending >= this.unitSize) {
      const merged = Buffer.concat(this.chunks, this.pending);
      let off = 0;
      while (merged.length - off >= this.unitSize) {
        this.onUnit(merged.subarray(off, off + this.unitSize));
        off += this.unitSize;
      }
      const rest = merged.subarray(off);
      this.chunks = rest.length ? [rest] : [];
      this.pending = rest.length;
      break;
    }
  }

  reset() {
    this.chunks = [];
    this.pending = 0;
  }
}

/**
 * 构造 atempo 滤镜链。单个 atempo 只接受 0.5~2.0，
 * 超出范围要串联多级（例如 4x = atempo=2.0,atempo=2.0）。
 */
function buildAtempoChain(speed) {
  if (Math.abs(speed - 1) < 1e-6) return null;
  const parts = [];
  let remain = speed;
  while (remain > 2.0) { parts.push('atempo=2.0'); remain /= 2.0; }
  while (remain < 0.5) { parts.push('atempo=0.5'); remain /= 0.5; }
  parts.push(`atempo=${remain.toFixed(6)}`);
  return parts.join(',');
}

/**
 * 从 ffmpeg stderr 文本中识别已知的致命解码错误。
 *
 * ffmpeg 遇到坏帧/损坏容器时常会打印 "Decoding error"、"Error while decoding"
 * 或 "Invalid data found"，但仍以 exit=0 退出。只看退出码会漏判这类失败，
 * 导致把解码失败误报成"自然放完"。这里用滚动 stderr 缓冲区做模式匹配。
 */
const DECODE_ERROR_PATTERNS = [
  /Decoding error\s*:.*$/mi,
  /Error while decoding stream[^\n]*/i,
  /Invalid data found when processing input/i,
  /(?:corrupt|truncated) (?:frame|stream|file|block)/i,
];
const MAX_STDERR_BUF = 4096;

function detectDecodeError(text) {
  for (const re of DECODE_ERROR_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].trim().replace(/\s+/g, ' ').slice(0, 240);
  }
  return null;
}

// 诊断开关（默认关闭）：LUMORA_DEBUG_DECODE=1 时把每次音频解码子进程的
// 启动参数、进程号、全局计数与 kill 事件写入项目根 .decode-debug.log，
// 用于定位"首曲拖入必定解码失败"——确认是喂错了文件还是进程被中途 kill。
const DEBUG_DECODE = process.env.LUMORA_DEBUG_DECODE === '1';
let _dbgCount = 0;
function _dbgDecode(tag, extra) {
  if (!DEBUG_DECODE) return;
  try {
    const fs = require('fs');
    const line = `[${new Date().toISOString()}] #${++_dbgCount} ${tag} ${extra || ''}\n`;
    fs.appendFileSync(require('path').join(__dirname, '..', '..', '.decode-debug.log'), line);
  } catch { /* 诊断写失败不影响播放 */ }
}

/**
 * 帧率模式参数。FFmpeg 5.1 起 -vsync 改名为 -fps_mode，
 * 老名字虽然还能用但已标记废弃，早晚会被移除。
 */
function fpsModeArgs(ffmpegPath) {
  if (fpsModeArgs._cache) return fpsModeArgs._cache;
  let flag = '-vsync';
  try {
    const out = execFileSync(ffmpegPath, ['-hide_banner', '-h', 'full'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
    });
    if (/\s-fps_mode\b/.test(out)) flag = '-fps_mode';
  } catch { /* 探测不到就用老参数，它在所有版本上都认 */ }
  fpsModeArgs._cache = [flag, 'cfr'];
  return fpsModeArgs._cache;
}

class MediaPipeline extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.ffmpegPath = resolveBinary('ffmpeg', opts.ffmpegPath);
    this.info = null;
    this.epoch = 0;

    this.videoProc = null;
    this.audioProc = null;
    this.videoSlicer = null;
    this.audioSlicer = null;

    this.videoTrack = 0;
    this.audioTrack = 0;
    this.speed = 1.0;
    this.startTime = 0;

    this.videoFrameIndex = 0;
    this.audioFrameCount = 0;
    this.videoSeq = 0;
    this.audioSeq = 0;

    this.hwaccel = opts.hwaccel || 'auto'; // 'auto' | 'no' | 具体名称
    this.voice = 0; // 声部标签：0=主声部(A) 1=交叉淡入淡出副声部(B)
    this.running = false;
    this.videoEnded = false;
    this.audioEnded = false;

    // 硬件解码试探状态：auto 模式下对 HDR/10bit 先尝试硬解，失败再回退软解
    this.hwaccelTentative = false;
    this.hwaccelFailed = false;
    this._hwaccelWatchdog = null;
    this._videoFramesInThisRun = 0;

    // 解码失败标记：任一音/视频子进程异常退出（非 0 退出码）或 stderr
    // 出现致命解码错误时置位，用于在 EOS 时区分"自然放完"与"解码失败"，
    // 避免把失败误报成"播放结束"。
    this._decodeError = false;
    this._decodeErrorDetail = null;

    // 滚动 stderr 缓冲区，用来识别可能被 chunk 边界截断的解码错误行。
    this._videoStderrBuf = '';
    this._audioStderrBuf = '';
  }

  get available() { return !!this.ffmpegPath; }

  /**
   * 载入探测结果。真正的解码进程要等 start() 才拉起。
   */
  load(info) {
    this.info = info;
    this.videoTrack = 0;
    this.audioTrack = 0;
    this.videoFrameIndex = 0;
    this.audioFrameCount = 0;
    this.startTime = 0;
    // 新文件重新尝试硬件解码（上一文件若回退过软解，不应连累后续文件）
    this.hwaccelFailed = false;
    // 重置上一文件的输出描述，避免音频-only 文件继承旧 videoOutput
    this.videoOutput = null;
  }

  get currentVideo() {
    return this.info && this.info.video[this.videoTrack] ? this.info.video[this.videoTrack] : null;
  }

  get currentAudio() {
    return this.info && this.info.audio[this.audioTrack] ? this.info.audio[this.audioTrack] : null;
  }

  /**
   * 有效帧率 —— 变速播放时视频帧率按倍速缩放，
   * 这样 PTS 推算与音频 atempo 后的时间轴保持一致。
   */
  get outputFps() {
    const v = this.currentVideo;
    if (!v) return 25;
    // 限制在合理区间，防止损坏文件报出 1000fps 这种荒谬值把内存吃爆
    return clamp(v.fps || 25, 1, 240);
  }

  _hwaccelArgs(v) {
    if (this.hwaccel === 'no') return [];
    // 已经失败过一回，这一文件剩余时间全程软解
    if (this.hwaccelFailed) return [];
    // 必须显式指定回读格式：hardware decode 的帧默认留在 GPU 显存里，
    // 不指定 -hwaccel_output_format 时 ffmpeg 无法把硬解帧拷成 rawvideo，
    // 导致 3 秒看门狗判失败 → 回退软解（8K AV1 软解必掉帧）。
    // 10bit/HDR 用 p010 保留高位深，8bit 用 nv12；ffmpeg 会在 hw 边界自动
    // 插入 hwdownload + 格式转换，把帧送回系统内存供 WebSocket 传输。
    const outFmt = v && v.bitDepth > 8 ? 'p010' : 'nv12';
    if (this.hwaccel === 'auto') {
      // 10-bit / HDR 片源在部分显卡/驱动上硬解后无法拷贝成 rawvideo，会黑屏。
      // 自动模式下先尝试硬解，由看门狗监控：3 秒内无帧则回退软解。
      // 普通 8bit SDR 也走 hwaccel auto，让 ffmpeg 自己挑可用解码器。
      if (v && (v.bitDepth > 8 || (v.hdrType && v.hdrType !== 'sdr'))) {
        this.hwaccelTentative = true;
      }
      return ['-hwaccel', 'auto', '-hwaccel_output_format', outFmt];
    }
    return ['-hwaccel', this.hwaccel, '-hwaccel_output_format', outFmt];
  }

  _spawnVideo(atTime) {
    const v = this.currentVideo;
    if (!v) { this.videoEnded = true; return; }

    const fps = this.outputFps;
    const myEpoch = this.epoch;

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-nostdin',
      ...this._hwaccelArgs(v),
    ];
    // -ss 放在 -i 之前：ffmpeg 会先跳到最近关键帧再解码到目标点，
    // 既快又精确（现代 ffmpeg 的输入端 seek 已是精确 seek）
    if (atTime > 0.001) args.push('-ss', atTime.toFixed(6));

    args.push('-i', this.info.path);
    args.push('-map', `0:v:${this.videoTrack}`);

    // 源可能是 nv12/p010/yuvj420p/12bit 之类，收敛成管线认识的平面格式。
    // ffmpeg 会自动插入转换滤镜，比在着色器里穷举每种格式划算得多。
    const outFmt = normalizePixFmt(v.pixfmt, v.bitDepth);

    // 输出尺寸：SAR 拉伸后宽度会变；子采样格式还要求边长是偶数，
    // 否则 ffmpeg 实际吐出的行数与我们算的对不上，切帧会整体错位
    let outW = v.sar && Math.abs(v.sar - 1) > 0.01
      ? Math.round(v.width * v.sar) : v.width;
    let outH = v.height;

    // 架构限制：Lumen 通过 WebSocket 传输原始 YUV 帧到渲染进程，
    // 而 mpv 是进程内直接共享 GPU 显存。WebSocket 单条消息过大时
    // Chromium 无法及时组装，帧会卡在传输层。
    // 1080p YUV420p = 3MB/帧，是 WebSocket 可靠传输的上限。
    // 超过此分辨率的源统一降采样到 1080p 输出。
    const MAX_OUTPUT_WIDTH = 1920;
    if (outW > MAX_OUTPUT_WIDTH) {
      const scale = MAX_OUTPUT_WIDTH / outW;
      outW = MAX_OUTPUT_WIDTH;
      outH = Math.round(outH * scale);
    }

    if (outFmt.startsWith('yuv420')) { outW -= outW % 2; outH -= outH % 2; }
    else if (outFmt.startsWith('yuv422')) { outW -= outW % 2; }
    outW = Math.max(outW, 2);
    outH = Math.max(outH, 2);

    // 尺寸有任何变化都显式写成 scale，绝不让 ffmpeg 自己决定 ——
    // 帧长度算错一个字节，整个流就废了
    if (outW !== v.width || outH !== v.height) {
      args.push('-vf', `scale=${outW}:${outH}:flags=bicubic`);
    }

    args.push(
      ...fpsModeArgs(this.ffmpegPath),
      '-r', String(fps),
      '-pix_fmt', outFmt,
      '-f', 'rawvideo',
      '-',
    );

    const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
    this.videoProc = proc;

    const fsize = frameSize(outFmt, outW, outH);
    this.videoOutput = { width: outW, height: outH, pixfmt: outFmt, frameSize: fsize, fps };

    this.videoSlicer = new FixedSizeSlicer(fsize, (frame) => {
      if (myEpoch !== this.epoch) return; // seek 后的陈旧数据，丢弃
      this._clearHwaccelWatchdog();
      this._videoFramesInThisRun++;
      const pts = this.startTime + this.videoFrameIndex / fps;
      this.videoFrameIndex++;
      this.emit('video-frame', {
        data: frame,
        pts,
        seq: this.videoSeq++,
        epoch: myEpoch,
        width: outW,
        height: outH,
      });
    });

    // 硬解试探看门狗：auto 模式下 HDR/10bit 片源若 3 秒无帧，认为硬解失败
    this._startHwaccelWatchdog(myEpoch);

    proc.stdout.on('data', (c) => this.videoSlicer.push(c));
    // ffmpeg stderr 在 Windows 上以 GBK 输出
    proc.stderr.on('data', (d) => {
      const text = (typeof d === 'string' ? d : d.toString('utf8')).trim();
      if (!text) return;
      this.emit('log', { stream: 'video', text });
      // 滚动累积 stderr，识别 exit=0 但已报致命解码错误的坏文件。
      this._videoStderrBuf = (this._videoStderrBuf + '\n' + text).slice(-MAX_STDERR_BUF);
      const detail = detectDecodeError(this._videoStderrBuf);
      if (detail && !this._decodeError) {
        this._decodeError = true;
        this._decodeErrorDetail = detail;
      }
    });
    proc.on('error', (e) => this.emit('error', new Error(`视频解码进程启动失败: ${e.message}`)));
    proc.on('close', (code, signal) => {
      this._clearHwaccelWatchdog();
      _dbgDecode('close-video', `pid=${proc.pid} code=${code} signal=${signal} myEpoch=${myEpoch} thisEpoch=${this.epoch} frames=${this.videoFrameIndex}`);
      if (myEpoch !== this.epoch) return; // 是我们主动为 seek 杀掉的
      this.videoEnded = true;
      if (code !== 0 && code !== null && !signal) {
        const msg = `视频解码异常退出 (code ${code})`;
        this._decodeError = true;
        this._decodeErrorDetail = msg;
        this.emit('error', new Error(msg));
      }
      this._checkEos();
    });
  }

  _startHwaccelWatchdog(epoch) {
    if (!this.hwaccelTentative || this.hwaccelFailed) return;
    this._clearHwaccelWatchdog();
    this._hwaccelWatchdog = setTimeout(() => {
      if (epoch !== this.epoch || this._videoFramesInThisRun > 0) return;
      this.emit('hwaccel-fallback', { epoch });
    }, 3000);
  }

  _clearHwaccelWatchdog() {
    if (this._hwaccelWatchdog) {
      clearTimeout(this._hwaccelWatchdog);
      this._hwaccelWatchdog = null;
    }
  }

  _spawnAudio(atTime, voice = this.voice) {
    const a = this.currentAudio;
    if (!a) { this.audioEnded = true; return; }

    const myEpoch = this.epoch;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-nostdin',
    ];
    // 首曲根治：Windows 上 child_process.stdout.pause() 无法阻塞 ffmpeg 写入端，
    // 主声部音乐文件用 -re 按实时速度输出，避免渲染端 AudioContext 就绪前 ffmpeg
    // 瞬间 dump 完整文件并退出（stdout 抽空 → EOS → "播放结束"）。副声部（交叉淡入
    // 淡出）需要提前解码，不加 -re；视频兜底路径 audioOnly=false 也不加。
    if (this.info.audioOnly && voice === 0) args.push('-re');
    if (atTime > 0.001) args.push('-ss', atTime.toFixed(6));
    args.push('-i', this.info.path);
    args.push('-map', `0:a:${this.audioTrack}`);

    const tempo = buildAtempoChain(this.speed);
    if (tempo) args.push('-af', tempo);

    args.push(
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      '-ar', String(AUDIO_SAMPLE_RATE),
      '-ac', String(AUDIO_CHANNELS),
      '-',
    );

    const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
    this.audioProc = proc;
    _dbgDecode('spawnAudio', `pid=${proc.pid} ffmpeg=${this.ffmpegPath} -i ${this.info && this.info.path} args=${JSON.stringify(args)}`);

    const unitBytes = AUDIO_CHUNK_FRAMES * AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE;

    // 调试钩子：LUMEN_DUMP_AUDIO=<路径> 时把主声部切片原样落盘（首 4MB），
    // 用于对比"管线收到的音频"与"文件真实内容"（频谱异常排查，用完即删）
    const dumpPath = process.env.LUMEN_DUMP_AUDIO;
    let dumpFd = null, dumpLeft = 4 * 1024 * 1024;
    if (dumpPath && voice === 0) {
      try { dumpFd = require('fs').openSync(dumpPath, 'w'); } catch { dumpFd = null; }
    }

    this.audioSlicer = new FixedSizeSlicer(unitBytes, (chunk) => {
      if (myEpoch !== this.epoch) return;
      if (dumpFd !== null && dumpLeft > 0) {
        const n = Math.min(dumpLeft, chunk.length);
        try { require('fs').writeSync(dumpFd, chunk.subarray(0, n)); } catch { /* 磁盘满等忽略 */ }
        dumpLeft -= n;
        if (dumpLeft <= 0) { try { require('fs').closeSync(dumpFd); } catch {} dumpFd = null; }
      }
      // 音频 PTS 由累计采样数精确推算 —— 这是整个播放器的时间基准。
      // 变速时输出的是加速后的时间轴，所以要乘回 speed 才是媒体时间。
      const pts = this.startTime + (this.audioFrameCount / AUDIO_SAMPLE_RATE) * this.speed;
      this.audioFrameCount += AUDIO_CHUNK_FRAMES;
      this.emit('audio-chunk', {
        data: chunk,
        pts,
        seq: this.audioSeq++,
        epoch: myEpoch,
        voice,
        frames: AUDIO_CHUNK_FRAMES,
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: AUDIO_CHANNELS,
        pitched: true, // ffmpeg 已用 atempo 在解码侧保音高，消费侧 worklet 直出
      });
    });

    proc.stdout.on('data', (c) => this.audioSlicer.push(c));
    // ffmpeg stderr 在 Windows 上以 GBK 输出
    proc.stderr.on('data', (d) => {
      const text = (typeof d === 'string' ? d : d.toString('utf8')).trim();
      if (!text) return;
      this.emit('log', { stream: 'audio', text });
      // 滚动累积 stderr，识别 exit=0 但已报致命解码错误的坏文件。
      this._audioStderrBuf = (this._audioStderrBuf + '\n' + text).slice(-MAX_STDERR_BUF);
      const detail = detectDecodeError(this._audioStderrBuf);
      if (detail && !this._decodeError) {
        this._decodeError = true;
        this._decodeErrorDetail = detail;
        _dbgDecode('decodeError-audio', detail);
      }
    });
    proc.on('error', (e) => this.emit('error', new Error(`音频解码进程启动失败: ${e.message}`)));
    proc.on('close', (code, signal) => {
      _dbgDecode('close-audio', `pid=${proc.pid} code=${code} signal=${signal} myEpoch=${myEpoch} thisEpoch=${this.epoch} frames=${this.audioFrameCount}`);
      if (myEpoch !== this.epoch) return;
      this.audioEnded = true;
      if (code !== 0 && code !== null && !signal) {
        const msg = `音频解码异常退出 (code ${code})`;
        this._decodeError = true;
        this._decodeErrorDetail = msg;
        this.emit('error', new Error(msg));
      }
      this._checkEos();
    });
  }

  _checkEos() {
    if (this.videoEnded && this.audioEnded && this.running) {
      this.running = false;
      // 携带 decodeError 标记：渲染端据此区分"自然放完"与"解码失败"，
      // 失败时不报"播放结束"、不误回主页。
      //
      // 健壮性修正（2026-08-09）：ffmpeg 在遇到可恢复的坏帧时常打印
      // "Decoding error: Invalid data found when processing input" 但仍继续
      // 把整文件解码完（退出码 0、产出完整音频）。若仅凭 stderr 关键字就判定
      // 整文件"无法解码"，会把首曲等偶发坏帧误报成致命失败。因此仅当「stderr
      // 命中关键字 且 音频确实几乎零产出」时才算解码失败——零产出意味着文件
      // 从头就解不出，才是真正的不可解码；有产出则说明只是中途可恢复的警告。
      const realDecodeError = this._decodeError && this.audioFrameCount === 0;
      this.emit('eos', { epoch: this.epoch, decodeError: realDecodeError, detail: this._decodeErrorDetail });
    }
  }

  /**
   * 从指定时间点启动解码。会先停掉现有进程并递增代际号。
   */
  start(atTime = 0) {
    if (!this.info) throw new Error('尚未载入媒体');
    if (!this.ffmpegPath) throw new Error('找不到 ffmpeg 可执行文件');

    this._killProcs();
    _dbgDecode('start()', `path=${this.info && this.info.path} atTime=${atTime} epoch=${this.epoch + 1} speed=${this.speed}`);
    this._clearHwaccelWatchdog();
    this.epoch++;
    this.startTime = Math.max(0, atTime);
    this.videoFrameIndex = 0;
    this.audioFrameCount = 0;
    this.videoEnded = false;
    this.audioEnded = false;
    this.running = true;
    this._videoFramesInThisRun = 0;
    // 每次解码运行重置失败标记（seek / 重载都走 start）
    this._decodeError = false;
    this._decodeErrorDetail = null;
    this._videoStderrBuf = '';
    this._audioStderrBuf = '';
    // 每次 start 重新判断是否需要试探硬解；失败标记跨 seek 保持，避免反复重试
    this.hwaccelTentative = false;

    this._spawnVideo(this.startTime);
    this._spawnAudio(this.startTime);

    this.emit('started', {
      epoch: this.epoch,
      startTime: this.startTime,
      video: this.videoOutput || null,
      audio: this.currentAudio
        ? { sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS }
        : null,
    });
    return this.epoch;
  }

  /**
   * 仅音频解码（交叉淡入淡出副声部专用）。
   *
   * 从指定时间点解码音频跑到 EOF，不拉起视频进程。声部标签由 voice 指定
   * （副声部 = 1）。ffmpeg 进程一路解码到曲目结束，渲染端用背压限速，
   * 这样在交叉淡入淡出结束、把副声部提升为主声部时无需重新 seek，做到无缝。
   *
   * @param {number} atTime 起始解码时间（秒），通常为 0
   * @param {number} voice 声部标签（0 主 / 1 副）
   * @returns {number} 本次启动的 epoch
   */
  startAudioOnly(atTime = 0, voice = 0) {
    if (!this.info) throw new Error('尚未载入媒体');
    if (!this.ffmpegPath) throw new Error('找不到 ffmpeg 可执行文件');

    this._killProcs();
    this.epoch++;
    this.startTime = Math.max(0, atTime);
    this.audioFrameCount = 0;
    this.videoFrameIndex = 0;
    this.videoEnded = true;   // 无视频：视频视作已结束
    this.audioEnded = false;
    this.running = true;

    this._spawnAudio(this.startTime, voice);

    this.emit('started', {
      epoch: this.epoch,
      startTime: this.startTime,
      video: null,
      audio: this.currentAudio
        ? { sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS }
        : null,
    });
    return this.epoch;
  }

  seek(time) {
    const dur = this.info ? this.info.duration : 0;
    const t = clamp(time, 0, dur > 0 ? dur - 0.05 : time);
    return this.start(t);
  }

  setSpeed(speed, currentTime) {
    const s = clamp(speed, 0.05, 16);
    if (Math.abs(s - this.speed) < 1e-6) return null;
    this.speed = s;
    // 变速必须重启管线：音频要重新过 atempo 滤镜，
    // 在 worklet 里做 WSOLA 变调补偿的音质远不如 ffmpeg 原生实现
    return this.start(currentTime);
  }

  setVideoTrack(idx, currentTime) {
    if (!this.info || !this.info.video[idx]) return null;
    this.videoTrack = idx;
    return this.start(currentTime);
  }

  setAudioTrack(idx, currentTime) {
    if (!this.info || !this.info.audio[idx]) return null;
    this.audioTrack = idx;
    return this.start(currentTime);
  }

  /**
   * 背压控制：独立暂停/恢复音频和视频的 stdout。
   *
   * 音频和视频的数据率差两个数量级（音频 ~16KB/包 vs 视频 ~3MB/帧），
   * 消费速率也完全不同，必须分开控制：
   *   - 音频缓冲满了 → 只 pause 音频 stdout，视频继续解码
   *   - 视频队列满了 → 只 pause 视频 stdout，音频继续喂
   *   - socket 积压 → 两个都 pause（由 media-server 的 socketFull 统一触发）
   *
   * pause 视频 stdout 不会丢数据：已收到的 chunk 留在 slicer 内部缓冲里，
   * resume 后继续拼接，下一帧自然凑齐。
   */
  throttle(state) {
    // 主进程始终传入 { audio, video } 对象。旧的单布尔信号路径已移除：
    // 若误把布尔当成"同时掐音视频"，会掐断音频主时钟、拖垮整个播放。
    // 形状不符时记告警并跳过，绝不擅自改变任一通道的节流状态。
    if (typeof state !== 'object' || state === null) {
      console.warn('[lumen][decoder] throttle 收到非法信号，已忽略:', state);
      return;
    }
    const audio = !!state.audio;
    const video = !!state.video;

    if (this.audioProc && this.audioProc.stdout) {
      if (audio) this.audioProc.stdout.pause();
      else this.audioProc.stdout.resume();
    }
    if (this.videoProc && this.videoProc.stdout) {
      if (video) this.videoProc.stdout.pause();
      else this.videoProc.stdout.resume();
    }
  }

  _killProcs() {
    for (const key of ['videoProc', 'audioProc']) {
      const p = this[key];
      if (!p) continue;
      _dbgDecode('kill', `killing ${key} pid=${p.pid}`);
      try {
        p.stdout.removeAllListeners();
        p.stderr.removeAllListeners();
        p.removeAllListeners('close');
        p.kill('SIGKILL');
      } catch { /* 进程可能已经退出 */ }
      this[key] = null;
    }
    if (this.videoSlicer) this.videoSlicer.reset();
    if (this.audioSlicer) this.audioSlicer.reset();
    this._clearHwaccelWatchdog();
  }

  stop() {
    this.running = false;
    this.epoch++;
    this._killProcs();
  }
}

module.exports = { MediaPipeline, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, buildAtempoChain };
