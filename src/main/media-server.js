'use strict';
/**
 * 媒体传输服务。
 *
 * 为什么不用 Electron IPC 传裸帧：ipcMain/ipcRenderer 走结构化克隆，
 * 1080p30 的裸 YUV 是 ~93MB/s，每帧都要复制一次再反序列化一次，
 * 主进程会被拖死，GC 抖动直接体现为掉帧。
 *
 * 本地 WebSocket 走 loopback，ws 库在这个场景能跑到 GB/s，而且
 * bufferedAmount 天然就是一个背压信号 —— 渲染端消费不动时它会涨，
 * 我们据此掐住 ffmpeg 的 stdout，整条链路自动限速，不需要额外的
 * 队列长度协商。
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { HEADER_SIZE, PacketType, writeHeader } = require('../shared/protocol');

// 背压阈值：1080p YUV 帧约 3MB，设为 24MB（约 8 帧）高水位，
// 低于 8MB 才恢复。给 WebSocket 足够缓冲空间避免误触发。
const BACKPRESSURE_HIGH = 24 * 1024 * 1024;
const BACKPRESSURE_LOW = 8 * 1024 * 1024;

class MediaServer {
  constructor() {
    this.server = null;
    this.wss = null;
    this.client = null;
    this.port = 0;
    this.token = crypto.randomBytes(16).toString('hex');
    this.throttled = false;         // 兼容：整体限速状态（= audioThrottled || videoThrottled）
    this.audioThrottled = false;    // 音频 stdout 是否被掐住
    this.videoThrottled = false;    // 视频 stdout 是否被掐住（视频走另一套背压）
    this.socketFull = false;        // 信号一：socket 发送缓冲积压（对音视频都生效）
    this.rendererAudioFull = false; // 信号二：渲染端音频缓冲已满
    this.rendererVideoFull = false; // 信号三：渲染端视频队列已满
    this.onThrottleChange = null;   // 回调签名变为 ({ audio, video }) => void
    this.onClientReady = null;
    this.bytesSent = 0;
    this.packetsSent = 0;
    // 复用同一块头部缓冲：每秒几千个包，没必要每次都 alloc
    this._hdr = Buffer.allocUnsafe(HEADER_SIZE);
    // 发送缓冲空闲池：视频帧 ~3MB，避免每帧都 allocUnsafe + 整帧 memcpy。
    // 缓冲在 send 回调（数据真正写入 socket 后）才回收，杜绝竞态。
    this._freeBufs = [];
  }

  async listen() {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server, perMessageDeflate: false });

    this.wss.on('connection', (ws, req) => {
      // 简单令牌校验：本机环回也可能被同机其他进程连上
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.searchParams.get('token') !== this.token) {
        ws.close(1008, 'bad token');
        return;
      }
      // 只服务一个渲染进程，后来者顶替前者（窗口重载时会发生）
      if (this.client && this.client.readyState === this.client.OPEN) {
        try { this.client.close(1000, 'replaced'); } catch { /* 旧连接已断 */ }
      }
      this.client = ws;
      ws.binaryType = 'nodebuffer';
      // 新连接默认不掐：首曲靠 ffmpeg -re 限制输出速度，背压只负责常态限速。
      this.rendererAudioFull = false;
      this.rendererVideoFull = false;
      this.socketFull = false;
      this._applyThrottle();

      // 反向通道：渲染端的流控请求。音频和视频分开控制，
      // 各自根据自己的缓冲水位独立请求 pause/resume
      ws.on('message', (data, isBinary) => {
        if (isBinary) return; // 上行只走文本控制帧
        try {
          const msg = JSON.parse(data.toString());
          if (msg && msg.t === 'flow') {
            if (msg.audio !== undefined) {
              this.rendererAudioFull = !msg.audio;
              this.rendererVideoFull = !msg.video;
            } else {
              // 兼容旧格式：单一 go 信号同时控制音视频
              this.rendererAudioFull = !msg.go;
              this.rendererVideoFull = !msg.go;
            }
            this._applyThrottle();
          }
        } catch {
          // 畸形控制帧：背压失灵时这里是最直接的现场线索，不能静默吞掉。
          // 用限流计数器避免日志洪泛（每秒最多警告一次）。
          const now = Date.now();
          if (!this._malformedWarnedAt || now - this._malformedWarnedAt > 1000) {
            this._malformedWarnedAt = now;
            console.warn('[lumen][media-server] 收到畸形控制帧，已忽略（背压信令可能异常）');
          }
        }
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          // 连接没了就别把上游一直掐着，否则重连后要等一轮才恢复
          this.rendererAudioFull = false;
          this.rendererVideoFull = false;
          this.socketFull = false;
          this._applyThrottle();
        }
      });
      ws.on('error', () => { /* 连接错误由 close 统一处理 */ });
      if (this.onClientReady) this.onClientReady();
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      // 端口 0 = 让系统分配空闲端口，避免与用户其他服务冲突
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });

    return { port: this.port, token: this.token };
  }

  get connected() {
    return !!(this.client && this.client.readyState === 1);
  }

  /**
   * 发送一个带头部的二进制包。
   *
   * 这里做了一次 concat 把头和载荷合成单帧 —— 分两次 send 会让渲染端
   * 收到两个独立 message，还得自己拼，反而更慢。1080p 一帧 3MB 的
   * 拷贝在现代 CPU 上是 ~0.3ms，可以接受。
   */
  _send(headerFields, payload) {
    if (!this.connected) return false;
    writeHeader(this._hdr, headerFields);

    const needed = HEADER_SIZE + payload.length;
    // 复用发送缓冲：避免每视频帧（~3MB）都 allocUnsafe + 整帧 memcpy。
    // 从空闲池取一块够大的；不够则新分配。缓冲在 send 回调（数据真正写入
    // socket 后）才放回空闲池，因此不会出现"上一包未发完就被下一包覆盖"。
    let packet = this._freeBufs.pop();
    if (!packet || packet.length < needed) packet = Buffer.allocUnsafe(needed);
    this._hdr.copy(packet, 0);
    payload.copy(packet, HEADER_SIZE);

    // 关键：send 的是 packet 的 subarray(仅 needed 字节)，不是整块缓冲。
    // 复用的缓冲可能远大于本次载荷（视频帧 3MB 池给 16KB 音频块用），
    // 若 send(packet) 会把尾部残留的旧帧数据一起发出去 → 音频包带
    // 视频垃圾尾，worklet 当 PCM 播放 → 爆音 + 环形缓冲污染 + 误背压。
    // subarray 与 packet 共享底层内存，send 回调(数据已写入 socket)后才回收，
    // 复用依然安全。
    this.client.send(packet.subarray(0, needed), { binary: true }, () => {
      // 回收：放回空闲池供下次复用；长度不足的旧块自然被 GC 掉
      this._freeBufs.push(packet);
    });
    this.bytesSent += packet.length;
    this.packetsSent++;
    this._checkBackpressure();
    return true;
  }

  _checkBackpressure() {
    if (!this.client) return;
    const buffered = this.client.bufferedAmount;
    if (!this.socketFull && buffered > BACKPRESSURE_HIGH) this.socketFull = true;
    else if (this.socketFull && buffered < BACKPRESSURE_LOW) this.socketFull = false;
    else return; // 状态没变，省掉一次回调
    this._applyThrottle();
  }

  /** 三路信号取或：socket 满只掐视频（音频包小不会导致积压） */
  _applyThrottle() {
    // socketFull 只影响视频：视频帧大（3MB），是 socket 缓冲积压的元凶。
    // 音频包小（16KB），不会导致 socket 满。如果 socketFull 也暂停音频，
    // 会导致音频断流、时钟停摆，进而拖垮整个播放。
    const audioNext = this.rendererAudioFull;
    const videoNext = this.socketFull || this.rendererVideoFull;
    const anyNext = audioNext || videoNext;

    if (audioNext === this.audioThrottled && videoNext === this.videoThrottled) return;

    this.audioThrottled = audioNext;
    this.videoThrottled = videoNext;
    this.throttled = anyNext; // 兼容字段
    if (this.onThrottleChange) this.onThrottleChange({ audio: audioNext, video: videoNext });
  }

  sendVideoFrame(f) {
    return this._send({
      type: PacketType.VIDEO,
      seq: f.seq,
      pts: f.pts,
      epoch: f.epoch,
      a: f.width,
      b: f.height,
      c: 0,
    }, f.data);
  }

  sendAudioChunk(c) {
    return this._send({
      type: PacketType.AUDIO,
      seq: c.seq,
      pts: c.pts,
      epoch: c.epoch,
      voice: c.voice || 0,
      a: c.frames,
      b: c.sampleRate,
      c: c.channels,
    }, c.data);
  }

  /** 控制包（flush / eos）没有载荷，只发头。voice 用于把 EOS 路由到对应声部 */
  sendControl(type, epoch, pts = 0, voice = 0) {
    if (!this.connected) return false;
    const buf = Buffer.allocUnsafe(HEADER_SIZE);
    writeHeader(buf, { type, epoch, pts, voice });
    this.client.send(buf, { binary: true });
    return true;
  }

  /** 渲染端剩余待处理字节数，统计面板会用到 */
  get bufferedAmount() {
    return this.client ? this.client.bufferedAmount : 0;
  }

  close() {
    try { if (this.wss) this.wss.close(); } catch { /* 已关闭 */ }
    try { if (this.server) this.server.close(); } catch { /* 已关闭 */ }
    this.client = null;
  }
}

module.exports = { MediaServer };
