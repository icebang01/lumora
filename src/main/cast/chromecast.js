'use strict';
/**
 * Chromecast 投屏客户端（cast-out，从零实现，DI 可注入）。
 *
 * 设计目标（对齐 dlna.js）：
 *   1) 所有"网络 I/O"通过 DI 注入（createMdns / createTls），纯助手（parse 系列 /
 *      frame 系列 / build 系列）直接导出，可被 node:test 单测。
 *   2) 本模块只管"发现 + CASTV2 控制"，不碰 UI、不碰文件服务、不碰生命周期。
 *
 * 发现：mDNS `_googlecast._tcp.local`（multicast-dns，可注入假实现单测）。
 * 控制：CASTV2 over TLS `:8009`（消息帧 = 2 字节大端长度 + UTF-8 JSON）。
 *
 * ⚠️ 鉴权须知：Chromecast 要求客户端持有"标准 Cast 客户端证书 + salt"。
 *   证书 / 私钥 / salt 通过 opts 注入（PEM 字符串或文件路径），本模块**不内置任何
 *   证书材料**。缺证书时 TLS 握手会被拒（属预期，需用户提供 castv2-client 自带的
 *   自签名证书与对应 salt）。详见 ChromecastClient 构造参数。
 */

const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */

const CAST_TLS_PORT = 8009;
const SENDER_ID = 'sender-0';
const DEFAULT_RECEIVER_APP_ID = 'CC1AD845'; // 内置默认媒体接收器
const HEARTBEAT_MS = 5000;

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  deviceAuth: 'urn:x-cast:com.google.cast.tp.deviceauth',
  media: 'urn:x-cast:com.google.cast.media',
};

/* ------------------------------------------------------------------ */
/* 纯助手：Chromecast TXT 记录解析                                       */
/* ------------------------------------------------------------------ */

/**
 * 解析 Chromecast mDNS TXT 记录。
 * @param {Buffer|Buffer[]|object} txt
 *   - Buffer：单条 mDNS TXT（含 <len><bytes> 子段）
 *   - Buffer[]：multicast-dns 给出的 TXT（数组）
 *   - object：已被解析过的（直接复用）
 * @returns {object} { id, friendlyName, model, state, authRequired, version, icon, raw }
 */
function parseTxtRecords(txt) {
  if (txt && typeof txt === 'object' && !Buffer.isBuffer(txt) && !Array.isArray(txt)) {
    return normalizeTxt(txt);
  }
  const buffers = Array.isArray(txt) ? txt : (Buffer.isBuffer(txt) ? [txt] : []);
  const raw = {};
  for (const buf of buffers) {
    if (!Buffer.isBuffer(buf)) continue;
    let i = 0;
    while (i < buf.length) {
      const len = buf[i++];
      if (!len || i + len > buf.length) break;
      const chunk = buf.slice(i, i + len).toString('utf8');
      i += len;
      const eq = chunk.indexOf('=');
      if (eq < 0) continue;
      raw[chunk.slice(0, eq)] = chunk.slice(eq + 1);
    }
  }
  return normalizeTxt(raw);
}

/** 把原始 key（id/fn/md/rs/ca/ve/ic/rm/nf）映射成友好字段 */
function normalizeTxt(raw) {
  return {
    id: raw.id || '',
    friendlyName: raw.fn || raw.nf || '',
    model: raw.md || raw.rm || '',
    state: raw.rs || '',
    authRequired: raw.ca === '1' || raw.ca === 1,
    version: raw.ve || '',
    icon: raw.ic || '',
    raw,
  };
}

/**
 * 取 Chromecast TXT 里的设备状态为人类可读串。
 * rs ∈ 'stopped' | 'ready' | 'connecting' ...（不同固件略有差异）
 */
function receiverStateText(rs) {
  if (!rs) return '';
  if (rs === 'ready') return 'ready';
  if (rs === 'stopped') return 'idle';
  return rs;
}

/* ------------------------------------------------------------------ */
/* 纯助手：CASTV2 消息帧                                                */
/* ------------------------------------------------------------------ */

/**
 * 把一条 Cast 消息对象编码成线上帧：2 字节大端长度 + UTF-8 JSON。
 * @returns {Buffer}
 */
function frameCastMessage(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const frame = Buffer.alloc(2 + json.length);
  frame.writeUInt16BE(json.length, 0);
  json.copy(frame, 2);
  return frame;
}

/**
 * 增量解析器：喂入任意分片的 TCP 数据，每解析出一条完整消息回调一次。
 * 处理跨包拆分 / 粘包。
 */
class CastMessageParser {
  constructor() {
    this._buf = Buffer.alloc(0);
  }
  push(chunk, onMessage) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 2) {
      const len = this._buf.readUInt16BE(0);
      if (this._buf.length < 2 + len) break; // 帧未收全，等更多数据
      const msgBuf = this._buf.slice(2, 2 + len);
      this._buf = this._buf.slice(2 + len);
      let msg;
      try {
        msg = JSON.parse(msgBuf.toString('utf8'));
      } catch {
        continue; // 畸形帧跳过，继续后续
      }
      if (onMessage) onMessage(msg);
    }
  }
  reset() {
    this._buf = Buffer.alloc(0);
  }
}

/* ------------------------------------------------------------------ */
/* 纯助手：媒体加载 / 接收器启动载荷                                     */
/* ------------------------------------------------------------------ */

/**
 * 构造 CASTV2 媒体 LOAD 载荷。
 * @param opts { contentId, contentType, title, thumb, subtitles, autoplay, currentTime, sessionId, requestId }
 *   - subtitles: 可选 [{ url, name, lang }]（外部字幕由 LAN 文件服务托管）
 * @returns 完整 LOAD 消息对象
 */
function buildMediaLoad(opts) {
  const o = opts || {};
  const media = {
    contentId: o.contentId,
    contentType: o.contentType || 'video/mp4',
    streamType: 'BUFFERED',
    autoplay: o.autoplay !== false,
  };
  const metadata = {};
  if (o.title) metadata.title = o.title;
  if (o.thumb) metadata.images = [{ url: o.thumb }];
  if (Object.keys(metadata).length) media.metadata = metadata;
  if (Array.isArray(o.subtitles) && o.subtitles.length) {
    media.textTracks = o.subtitles.map((s) => ({
      trackId: s.trackId || 1,
      type: 'TEXT',
      trackContentId: s.url,
      trackContentType: s.contentType || 'text/vtt',
      name: s.name || 'Subtitle',
      language: s.lang || 'und',
      subtype: 'SUBTITLES',
    }));
  }
  return {
    type: 'LOAD',
    requestId: o.requestId != null ? o.requestId : 0,
    sessionId: o.sessionId || '',
    media,
    currentTime: o.currentTime || 0,
  };
}

/** 构造接收器 LAUNCH 载荷 */
function buildReceiverLaunch(appId, requestId) {
  return { type: 'LAUNCH', requestId: requestId != null ? requestId : 0, appId };
}

/* ------------------------------------------------------------------ */
/* 发现：ChromecastDiscovery（mDNS）                                    */
/* ------------------------------------------------------------------ */

/**
 * mDNS 发现器（仅 Chromecast：`_googlecast._tcp.local`）。
 * DI：opts.createMdns 默认用懒加载的 multicast-dns；测试可注入假实现。
 *
 * 吐出 'device' 事件：{ id, friendlyName, model, address, port, state, type:'chromecast' }。
 * address 取自 mDNS 响应的发送方 rinfo（设备 IP）；port 默认 8009。
 */
class ChromecastDiscovery extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts || {};
    this.mdns = null;
    this._createMdns = this.opts.createMdns || defaultCreateMdns;
    this._seen = new Set();
    this.searchTimeout = this.opts.searchTimeout || 5000;
    this._timer = null;
  }

  start(durationMs) {
    if (this.mdns) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let mdns;
      try {
        mdns = this._createMdns();
      } catch (e) {
        return reject(e);
      }
      this.mdns = mdns;
      mdns.on('error', (e) => this.emit('error', e));
      mdns.on('response', (packet, rinfo) => this._onResponse(packet, rinfo));

      try {
        mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
      } catch (e) {
        this.emit('error', e);
      }
      const dur = durationMs || this.searchTimeout;
      this._timer = setTimeout(() => {
        this.emit('search-timeout');
        this.stop();
      }, dur);
      if (this._timer.unref) this._timer.unref();
      resolve();
    });
  }

  _onResponse(packet, rinfo) {
    if (!packet || !Array.isArray(packet.answers)) return;
    for (const ans of packet.answers) {
      const name = (ans.name || '').toLowerCase();
      if (ans.type !== 'TXT' || !name.includes('_googlecast._tcp')) continue;
      const parsed = parseTxtRecords(ans.data);
      const id = parsed.id || (rinfo && rinfo.address) || '';
      if (!id || this._seen.has(id)) continue;
      this._seen.add(id);
      const device = {
        id,
        friendlyName: parsed.friendlyName || id,
        model: parsed.model || '',
        address: rinfo && rinfo.address,
        port: CAST_TLS_PORT,
        state: receiverStateText(parsed.state),
        authRequired: parsed.authRequired,
        type: 'chromecast',
      };
      this.emit('device', device);
    }
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.mdns) {
      try { this.mdns.destroy(); } catch { /* 忽略 */ }
      this.mdns = null;
    }
    this.emit('stop');
  }
}

/** multicast-dns 懒加载（仅运行时、无注入时；测试注入假实现无需此依赖） */
function defaultCreateMdns() {
  // eslint-disable-next-line global-require
  const m = require('multicast-dns')();
  return m;
}

/* ------------------------------------------------------------------ */
/* 控制：ChromecastClient（CASTV2 over TLS）                            */
/* ------------------------------------------------------------------ */

/**
 * 一个 Chromecast 的 CASTV2 控制客户端。
 * 实现与 DlnaRenderer 一致的方法签名（setAvUri/play/pause/stop/seek/setVolume/
 * getTransportInfo/getPositionInfo），以便 CastManager 不区分设备类型统一调用。
 *
 * @param opts { address, port, authCertificate, authKey, authSalt, createTls }
 *   authCertificate / authKey：标准 Cast 客户端证书/私钥，PEM 字符串或文件路径。
 *   authSalt：客户端签名 salt（Buffer 或 base64 字符串）。缺失则无法过鉴权。
 *   createTls：DI 注入（测试用）；默认 tls.connect。
 */
class ChromecastClient extends EventEmitter {
  constructor(opts) {
    super();
    if (!opts || !opts.address) throw new Error('ChromecastClient requires address');
    this.address = opts.address;
    this.port = opts.port || CAST_TLS_PORT;
    this._authCert = opts.authCertificate || opts.authCert;
    this._authKey = opts.authKey;
    this._authSalt = opts.authSalt;
    this._createTls = opts.createTls || defaultCreateTls;

    this._requestId = 1;
    this._transportId = 'receiver-0';
    this._sessionId = null;
    this._mediaSessionId = null;
    this._socket = null;
    this._parser = new CastMessageParser();
    this._pending = new Map();
    this._connected = false;
    this._authed = false;
    this._lastMedia = null;
    this._hbTimer = null;
  }

  /* ---- 连接 / 鉴权 ---- */

  connect() {
    return new Promise((resolve, reject) => {
      const tlsOpts = { host: this.address, port: this.port, rejectUnauthorized: false };
      if (this._authCert && this._authKey) {
        try {
          tlsOpts.cert = this._loadPem(this._authCert);
          tlsOpts.key = this._loadPem(this._authKey);
        } catch (e) {
          return reject(new Error('证书/私钥加载失败: ' + e.message));
        }
      }
      let sock;
      try {
        sock = this._createTls(tlsOpts);
      } catch (e) {
        return reject(e);
      }
      this._socket = sock;
      sock.setKeepAlive(true);

      sock.once('error', reject);
      sock.on('data', (d) => this._onData(d));
      sock.on('close', () => {
        this._connected = false;
        if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
        this.emit('close');
      });
      sock.on('secureConnect', () => {
        this._connected = true;
        sock.removeListener('error', reject);
        sock.on('error', (e) => this.emit('error', e));
        // 建立传输连接（receiver-0）
        this._send(NS.connection, { type: 'CONNECT', connType: 'CAST' }, this._transportId);
        this._startHeartbeat();
        // 乐观 resolve：鉴权挑战由 _onData 异步响应（见 _handleDeviceAuth）
        resolve();
      });
    });
  }

  _startHeartbeat() {
    if (this._hbTimer) return;
    this._hbTimer = setInterval(() => {
      if (this._connected) this._send(NS.heartbeat, { type: 'PING' });
    }, HEARTBEAT_MS);
    if (this._hbTimer.unref) this._hbTimer.unref();
  }

  _onData(chunk) {
    this._parser.push(chunk, (msg) => this._onMessage(msg));
  }

  _onMessage(msg) {
    const ns = msg.namespace;
    const payload = typeof msg.payloadUtf8 === 'string' ? safeJson(msg.payloadUtf8) : (msg.payload || {});
    if (!payload) return;

    // 请求回执（按 requestId 解 pending）
    if (payload.requestId != null && this._pending.has(payload.requestId)) {
      const entry = this._pending.get(payload.requestId);
      this._pending.delete(payload.requestId);
      if (entry.timer) clearTimeout(entry.timer);
      if (payload.type && /ERROR|INVALID/.test(payload.type)) entry.reject(new Error(payload.reason || payload.type));
      else entry.resolve(payload);
    }

    if (ns === NS.deviceAuth) this._handleDeviceAuth(payload);
    else if (ns === NS.receiver && payload.type === 'RECEIVER_STATUS') this._handleReceiverStatus(payload);
    else if (ns === NS.media && payload.type === 'MEDIA_STATUS') this._handleMediaStatus(payload);
    else if (ns === NS.heartbeat && payload.type === 'PING') this._send(NS.heartbeat, { type: 'PONG' });
  }

  _handleDeviceAuth(payload) {
    if (payload.type !== 'DEVICE_AUTH_CHALLENGE') return;
    const challenge = payload.data && payload.data.challenge;
    if (!challenge) return;
    try {
      const resp = this._respondAuth(challenge);
      this._send(NS.deviceAuth, resp, this._transportId);
      this._authed = true;
      this.emit('authed');
    } catch (e) {
      this.emit('auth-error', e);
    }
  }

  _handleReceiverStatus(payload) {
    const apps = payload.status && payload.status.applications;
    if (apps && apps.length) {
      this._sessionId = apps[0].sessionId;
      this._transportId = apps[0].transportId || this._transportId;
    } else {
      this._sessionId = null;
    }
    this.emit('receiver-status', payload.status);
  }

  _handleMediaStatus(payload) {
    const status = Array.isArray(payload.status) ? payload.status[0] : payload.status;
    if (!status) return;
    this._mediaSessionId = status.mediaSessionId != null ? status.mediaSessionId : this._mediaSessionId;
    this._lastMedia = status;
    this.emit('media-status', status);
  }

  /* ---- 发送 / 请求助手 ---- */

  _send(namespace, payloadObj, destinationId) {
    if (!this._socket) throw new Error('未连接');
    const msg = {
      protocolVersion: 0,
      sourceId: SENDER_ID,
      destinationId: destinationId || this._transportId,
      namespace,
      payloadType: 0,
      payloadUtf8: JSON.stringify(payloadObj),
    };
    this._socket.write(frameCastMessage(msg));
  }

  _request(namespace, payloadObj, destinationId) {
    const requestId = this._nextReq();
    const full = Object.assign({ requestId }, payloadObj);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error('CASTV2 请求超时: ' + (payloadObj.type || namespace)));
      }, 8000);
      if (timer.unref) timer.unref();
      this._pending.set(requestId, { resolve, reject, timer });
      try {
        this._send(namespace, full, destinationId);
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        reject(e);
      }
    });
  }

  _nextReq() { return this._requestId++; }

  /* ---- 媒体会话控制（与 DlnaRenderer 同签名） ---- */

  /** 投屏一个可访问 URL：启动默认接收器 + LOAD（autoplay=false，随后调 play） */
  async setAvUri(uri, opts) {
    await this._request(NS.receiver, buildReceiverLaunch(DEFAULT_RECEIVER_APP_ID));
    const load = buildMediaLoad(Object.assign(
      { contentId: uri, contentType: (opts && opts.mime) || 'video/mp4', title: (opts && opts.title) || 'Lumora' },
      opts && opts.thumb ? { thumb: opts.thumb } : {},
      opts && opts.subtitles ? { subtitles: opts.subtitles } : {},
      { sessionId: this._sessionId, autoplay: false, currentTime: opts && opts.currentTime || 0 },
    ));
    await this._request(NS.media, load);
    // LOAD 回执可能早于 mediaSessionId 落库；等媒体会话建立后再 resolve，避免紧接的 play() 报"无媒体会话"
    await this._waitMediaSession();
    return { ok: true };
  }

  /** 等媒体会话建立（LOAD 回执慢于 MEDIA_STATUS 时的竞态保护） */
  _waitMediaSession(timeoutMs) {
    if (this._mediaSessionId != null) return Promise.resolve();
    return new Promise((resolve) => {
      const cleanup = () => { clearTimeout(timer); this.removeListener('media-status', onStatus); };
      const onStatus = () => { if (this._mediaSessionId != null) { cleanup(); resolve(); } };
      this.on('media-status', onStatus);
      const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs || 5000);
      if (timer.unref) timer.unref();
    });
  }

  async play() {
    if (this._mediaSessionId == null) throw new Error('无媒体会话');
    return this._request(NS.media, { type: 'PLAY', mediaSessionId: this._mediaSessionId });
  }
  async pause() {
    if (this._mediaSessionId == null) throw new Error('无媒体会话');
    return this._request(NS.media, { type: 'PAUSE', mediaSessionId: this._mediaSessionId });
  }
  async stop() {
    if (this._mediaSessionId == null) return { ok: true };
    return this._request(NS.media, { type: 'STOP', mediaSessionId: this._mediaSessionId });
  }
  async seek(seconds) {
    if (this._mediaSessionId == null) throw new Error('无媒体会话');
    return this._request(NS.media, { type: 'SEEK', mediaSessionId: this._mediaSessionId, currentTime: Number(seconds) || 0 });
  }
  async setVolume(volume) {
    const level = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
    return this._request(NS.receiver, { type: 'SET_VOLUME', volume: { level } });
  }

  async getTransportInfo() {
    const ps = this._lastMedia && this._lastMedia.playerState;
    return { state: mapPlayerState(ps) };
  }
  async getPositionInfo() {
    const m = this._lastMedia || {};
    return {
      positionSeconds: m.currentTime || 0,
      durationSeconds: (m.media && m.media.duration) || 0,
    };
  }

  /** 拉一次最新状态（供 CastManager.getState） */
  async getState() {
    try {
      await this._request(NS.media, { type: 'GET_STATUS', mediaSessionId: this._mediaSessionId });
    } catch { /* 忽略 */ }
    const ti = await this.getTransportInfo();
    const pi = await this.getPositionInfo();
    return {
      type: 'chromecast',
      connected: this._connected,
      authed: this._authed,
      state: ti.state,
      positionSeconds: pi.positionSeconds,
      durationSeconds: pi.durationSeconds,
    };
  }

  disconnect() {
    const sock = this._socket;
    if (sock) {
      try { this._send(NS.connection, { type: 'CLOSE', connType: 'CAST' }, this._transportId); } catch { /* */ }
      // 若有媒体会话，尽量先发 STOP，避免投屏内容残留在设备上
      if (this._mediaSessionId != null) {
        try { this._send(NS.media, { type: 'STOP', mediaSessionId: this._mediaSessionId }); } catch { /* */ }
      }
    }
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    this._connected = false;
    this._socket = null;
    if (sock) { try { sock.end(); } catch { /* */ } }
  }

  /* ---- 鉴权签名 ---- */

  _respondAuth(challengeB64) {
    const challenge = Buffer.from(challengeB64, 'base64');
    const salt = this._authSalt
      ? (Buffer.isBuffer(this._authSalt) ? this._authSalt : Buffer.from(this._authSalt, 'base64'))
      : Buffer.alloc(0);
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(Buffer.concat([challenge, salt]));
    const signature = signer.sign(this._loadPem(this._authKey));
    return {
      type: 'DEVICE_AUTH_CHALLENGE_RESPONSE',
      data: {
        signature: signature.toString('base64'),
        clientAuthCertificate: pemToDerBase64(this._loadPem(this._authCert)),
      },
    };
  }

  _loadPem(v) {
    if (!v) throw new Error('缺少证书/私钥');
    if (typeof v === 'string' && v.includes('-----BEGIN')) return v;
    return fs.readFileSync(v, 'utf8');
  }

  get connected() { return this._connected; }
}

/** 把 PEM 证书转成 DER 的 base64（CASTV2 鉴权要求 clientAuthCertificate 为 DER base64） */
function pemToDerBase64(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');
  return der.toString('base64');
}

function defaultCreateTls(opts) {
  return tls.connect(opts);
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** Chromecast playerState → DLNA 风格状态串 */
function mapPlayerState(ps) {
  if (!ps) return 'UNKNOWN';
  switch (ps) {
    case 'PLAYING': return 'PLAYING';
    case 'PAUSED': return 'PAUSED_PLAYBACK';
    case 'BUFFERING': return 'TRANSITIONING';
    case 'IDLE': return 'STOPPED';
    default: return 'UNKNOWN';
  }
}

module.exports = {
  CAST_TLS_PORT,
  DEFAULT_RECEIVER_APP_ID,
  NS,
  parseTxtRecords,
  receiverStateText,
  frameCastMessage,
  CastMessageParser,
  buildMediaLoad,
  buildReceiverLaunch,
  ChromecastDiscovery,
  ChromecastClient,
};
