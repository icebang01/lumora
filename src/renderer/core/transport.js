/**
 * 媒体数据接收。
 *
 * 连接主进程开的本地 WebSocket，把二进制包拆成视频帧 / 音频块。
 *
 * 性能关键点：全程零拷贝。ws 给的是 ArrayBuffer，我们只在它上面
 * 建 Uint8Array 视图，不做 slice。1080p30 每秒 30 次 × 3MB 的
 * 拷贝如果发生，光是 memcpy 就能吃掉一个核心。
 */

import { HEADER_SIZE, PacketType, readHeader } from './wire.js';

export class Transport extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.bytesReceived = 0;
    this.packetsReceived = 0;

    this.onVideo = null;
    this.onAudio = null;
    this.onEos = null;

    // 流控状态。undefined = 还没表过态，保证首次调用一定会发出去
    this._demandAudio = undefined;
    this._demandVideo = undefined;

    // 码率统计用的滑动窗口
    this._rateWindow = [];
  }

  connect(port, token) {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}/?token=${token}`;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      const timer = setTimeout(() => {
        reject(new Error('连接媒体服务超时'));
        try { ws.close(); } catch { /* 已关闭 */ }
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timer);
        this.connected = true;
        this.ws = ws;
        this._demandAudio = undefined; // 新连接上游默认放行，重新表态
        this._demandVideo = undefined;
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timer);
        if (!this.connected) reject(new Error('无法连接媒体服务'));
      };

      ws.onclose = () => {
        this.connected = false;
        this.dispatchEvent(new CustomEvent('disconnected'));
      };

      ws.onmessage = (e) => this._handle(e.data);
    });
  }

  /**
   * 告诉上游"我还要不要数据"——音频和视频分开控制。
   *
   * 这是整条链路唯一真正有效的背压信号。上游只看 socket 的
   * bufferedAmount 是不够的：环回连接下它几乎恒为 0，ffmpeg 会一路
   * 把整个文件灌进来 —— 音频环形缓冲溢出、视频帧成批被丢，
   * 主时钟随之失真。真正知道"缓冲够不够"的只有消费端。
   *
   * 音频和视频的数据率差两个数量级、消费速率也完全不同，必须分开
   * 控制否则会互相饿死：音频几十毫秒就攒满 2 秒缓冲，如果共用一个
   * 信号触发 pause，视频 stdout 被一起掐住后一帧都凑不齐。
   *
   * 只在状态翻转时发，一次几十字节，对带宽没有影响。
   */
  setDemand({ audio, video }) {
    const a = !!audio;
    const v = !!video;
    if (this._demandAudio === a && this._demandVideo === v) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    this._demandAudio = a;
    this._demandVideo = v;
    try {
      this.ws.send(JSON.stringify({ t: 'flow', audio: a, video: v }));
    } catch { /* 连接已断，下一次重连会重新表态 */ }
  }

  _handle(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_SIZE) return;

    const view = new DataView(buffer, 0, HEADER_SIZE);
    const h = readHeader(view);

    this.bytesReceived += buffer.byteLength;
    this.packetsReceived++;
    this._trackRate(buffer.byteLength);

    switch (h.type) {
      case PacketType.VIDEO: {
        if (!this.onVideo) return;
        // 零拷贝视图。注意 data 的生命周期绑定在这个 ArrayBuffer 上，
        // 帧队列持有它期间不能被复用 —— 每条 ws 消息都是独立 buffer，安全
        const data = new Uint8Array(buffer, HEADER_SIZE);
        this.onVideo({
          data,
          pts: h.pts,
          seq: h.seq,
          epoch: h.epoch,
          width: h.a,
          height: h.b,
        });
        break;
      }
      case PacketType.AUDIO: {
        if (!this.onAudio) return;
        // 音频要 transfer 给 worklet，必须是独立 ArrayBuffer 才能转移所有权。
        // 这里 slice 一次是不可避免的成本，但音频数据量只有视频的 1/100
        const pcm = buffer.slice(HEADER_SIZE);
        this.onAudio({
          buffer: pcm,
          pts: h.pts,
          seq: h.seq,
          epoch: h.epoch,
          voice: h.voice,
          frames: h.a,
          sampleRate: h.b,
          channels: h.c,
        });
        break;
      }
      case PacketType.EOS:
        // h.pts 在主进程被复用为 decodeError 标记（1=解码失败）
        if (this.onEos) this.onEos({ epoch: h.epoch, voice: h.voice, decodeError: h.pts === 1 });
        break;
    }
  }

  _trackRate(bytes) {
    const now = performance.now();
    this._rateWindow.push([now, bytes]);
    // 只保留最近 1 秒
    while (this._rateWindow.length && now - this._rateWindow[0][0] > 1000) {
      this._rateWindow.shift();
    }
  }

  /** 当前接收速率（字节/秒） */
  get bitrate() {
    if (this._rateWindow.length < 2) return 0;
    let sum = 0;
    for (const [, b] of this._rateWindow) sum += b;
    const span = (this._rateWindow[this._rateWindow.length - 1][0] - this._rateWindow[0][0]) / 1000;
    return span > 0 ? sum / span : 0;
  }

  close() {
    if (this.ws) {
      // 显式清空所有事件回调，断开 ws → Transport 的闭包引用，
      // 避免旧连接对象在 close 后还挂着处理器（监听残留）。
      try {
        this.ws.onopen = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.onmessage = null;
      } catch { /* 已清空 */ }
      try { this.ws.close(); } catch { /* 已关闭 */ }
    }
    this.ws = null;
    this.connected = false;
  }
}
