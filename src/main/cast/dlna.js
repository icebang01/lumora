'use strict';
/**
 * DLNA / UPnP 控制点（cast-out，v1）。
 *
 * 纯粹基于 Node 内置 dgram + http，零原生依赖、零第三方依赖。
 * 设计目标：
 *   1) 可被 node:test 直接单测 —— 所有"网络 I/O"都通过 DI 注入
 *      （socketFactory / httpRequest），纯解析助手（parse 系列 / build 系列）则直接导出。
 *   2) 职责单一：本模块只管"发现 + SOAP 控制"，不碰 UI、不碰文件服务、
 *      不碰生命周期（那些在 ipc-cast.js 的 CastManager 里）。
 *
 * 术语：
 *   SSDP       —— 简单服务发现协议（UDP 多播 239.255.255.250:1900）
 *   MediaRenderer —— 我们要投屏到的智能电视 / 盒子
 *   AVTransport / RenderingControl / ConnectionManager —— 三个标准 UPnP 服务
 */

const { EventEmitter } = require('events');
const dgram = require('dgram');

/* ------------------------------------------------------------------ */
/* 服务类型常量                                                         */
/* ------------------------------------------------------------------ */

const SERVICE = {
  AVTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
  RenderingControl: 'urn:schemas-upnp-org:service:RenderingControl:1',
  ConnectionManager: 'urn:schemas-upnp-org:service:ConnectionManager:1',
};

const DEVICE_MEDIA_RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

/* ------------------------------------------------------------------ */
/* XML 小工具（无依赖解析，够 UPnP 用）                                  */
/* ------------------------------------------------------------------ */

/** 反转义 XML 实体（SOAP/设备描述里的文本值可能带 &amp; 等） */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 转义 XML 文本（构造 SOAP/DIDL 时防止注入破坏信封） */
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 取第一个匹配标签的文本内容（忽略命名空间前缀，大小写不敏感） */
function tagText(xml, tag) {
  // 匹配 <tag ...>...</tag> 或带前缀 <ns:tag ...>...</ns:tag>
  const re = new RegExp(`<([\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/\\1?${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return unescapeXml(m[2].trim());
}

/** 取所有 <service>...</service> 块（服务列表） */
function extractBlocks(xml, tag) {
  const blocks = [];
  const re = new RegExp(`<([\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/\\1?${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[2]);
  return blocks;
}

/* ------------------------------------------------------------------ */
/* 纯助手：SSDP 头解析                                                   */
/* ------------------------------------------------------------------ */

/**
 * 解析一条 SSDP 报文（HTTP 类头）。接受 string 或 Buffer。
 * 返回 { _method, _statusCode, _statusLine, <小写头名>: <值> }。
 * 例：M-SEARCH 响应首行 "HTTP/1.1 200 OK"；NOTIFY 首行 "NOTIFY * HTTP/1.1"。
 * 头名统一小写（LOCATION / location 都归到 location）。
 */
function parseSsdpHeaders(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  // SSDP 既可能是 \r\n 也可能是 \n；统一化
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = {};
  const first = (lines.shift() || '').trim();
  if (first) {
    out._statusLine = first;
    const m = first.match(/^(NOTIFY|M-SEARCH|HTTP)\b/i);
    if (m) out._method = m[1].toUpperCase();
    const code = first.match(/HTTP\/\d\.\d\s+(\d{3})/i);
    if (code) out._statusCode = Number(code[1]);
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue; // 跳过分隔空行 / 畸形行
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    // 同名字段（少见）用数组聚合；否则覆盖
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (Array.isArray(out[key])) out[key].push(val);
      else out[key] = [out[key], val];
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** 判断一条 SSDP 头是否指向 MediaRenderer（ST 或 NT 命中） */
function isMediaRenderer(headers) {
  const st = (headers.st || '').toLowerCase();
  const nt = (headers.nt || '').toLowerCase();
  return st.includes('mediarenderer') || nt.includes('mediarenderer');
}

/* ------------------------------------------------------------------ */
/* 纯助手：设备描述 XML 解析                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析设备描述 XML（LOCATION 指向的 HTTP 文档）。
 * baseURL 用于把相对 controlURL 解析成绝对地址（必填）。
 * 返回：
 *   { friendlyName, modelName, modelNumber, manufacturer, deviceType,
 *     udn, presentationURL, baseURL, services: [{ type, id, controlURL,
 *     eventSubURL, scpdURL }] }
 * 解析失败（非 XML / 无 device）抛错。
 */
function parseDeviceDescription(xml, baseURL) {
  if (!xml || typeof xml !== 'string') throw new Error('device description empty');
  const deviceBlock = extractBlocks(xml, 'device')[0];
  if (!deviceBlock) throw new Error('no <device> in description');

  const udn = tagText(deviceBlock, 'UDN') || tagText(xml, 'UDN');
  const desc = {
    friendlyName: tagText(deviceBlock, 'friendlyName'),
    modelName: tagText(deviceBlock, 'modelName'),
    modelNumber: tagText(deviceBlock, 'modelNumber'),
    manufacturer: tagText(deviceBlock, 'manufacturer'),
    deviceType: tagText(deviceBlock, 'deviceType'),
    udn,
    presentationURL: tagText(deviceBlock, 'presentationURL'),
    baseURL: baseURL || '',
    services: [],
  };

  // 服务可能在 device 下的 serviceList，也可能直接在 deviceList 嵌套；
  // 这里直接扫描整文档里所有 <service> 块，够用且鲁棒。
  for (const svc of extractBlocks(xml, 'service')) {
    const type = tagText(svc, 'serviceType');
    const id = tagText(svc, 'serviceId');
    const controlURL = resolveUrl(baseURL, tagText(svc, 'controlURL'));
    const eventSubURL = resolveUrl(baseURL, tagText(svc, 'eventSubURL'));
    const scpdURL = resolveUrl(baseURL, tagText(svc, 'SCPDURL'));
    if (!type) continue;
    desc.services.push({ type, id, controlURL, eventSubURL, scpdURL });
  }
  return desc;
}

/** 把相对 URL 解析成绝对（基于 baseURL）。已经是绝对则原样返回。 */
function resolveUrl(base, url) {
  if (!url) return url || '';
  if (/^https?:\/\//i.test(url)) return url;
  if (!base) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ */
/* 纯助手：SOAP 信封构造 / 解析                                         */
/* ------------------------------------------------------------------ */

/**
 * 构造一个 SOAP 1.1 控制请求信封。
 * @param serviceType 完整 URN，如 urn:schemas-upnp-org:service:AVTransport:1
 * @param action      动作名，如 Play / Pause / SetAVTransportURI
 * @param args        参数对象，键 → 子元素；值转义后写入
 * @returns 完整 XML 字符串
 */
function buildSoapRequest(serviceType, action, args) {
  const argXml = Object.keys(args || {})
    .map((k) => `  <${k}>${escapeXml(args[k])}</${k}>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
${argXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;
}

/** SOAP 故障（fault）：解析到 <s:Fault> 时抛出 */
class DlnaSoapError extends Error {
  constructor(faultCode, faultString, detail) {
    super(`SOAP fault: ${faultCode} - ${faultString}`);
    this.name = 'DlnaSoapError';
    this.faultCode = faultCode;
    this.faultString = faultString;
    this.detail = detail;
  }
}

/**
 * 解析 SOAP 响应信封。
 * 成功：返回 { action, args } —— action 为响应动作名，args 为子元素键值。
 * 失败：抛出 DlnaSoapError（含 faultcode / faultstring）。
 * 解析失败（非 SOAP / 无 Body）：抛普通 Error。
 */
function parseSoapResponse(xml) {
  if (!xml || typeof xml !== 'string') throw new Error('soap response empty');
  if (/<s:Fault\b/i.test(xml) || /<fault\b/i.test(xml)) {
    const code = tagText(xml, 'faultcode') || 'Unknown';
    const str = tagText(xml, 'faultstring') || 'unknown error';
    const detail = tagText(xml, 'detail');
    throw new DlnaSoapError(code, str, detail);
  }
  const body = extractBlocks(xml, 'Body')[0];
  if (!body) throw new Error('no <s:Body> in soap response');
  // 取 Body 内第一个"动作响应"块：标签形如 <u:ActionResponse> 或 <ActionResponse>
  const respBlocks = extractBlocks(body, '\\w+:?\\w*Response') ||
    extractBlocks(body, 'Response');
  // 上面正则不稳定，退化为手动找第一个含 xmlns:u 的子元素
  const actionMatch = body.match(/<([\w-]+:)?(\w+Response)\b[^>]*>([\s\S]*?)<\/\1?\2>/i);
  if (!actionMatch) throw new Error('no action response in soap body');
  const action = actionMatch[2];
  const inner = actionMatch[3];
  const args = {};
  // 解析内层所有简单子元素（只取一层，值做反转义）
  const elRe = /<([\w-]+:)?(\w+)\b[^>]*>([\s\S]*?)<\/\1?\2>/gi;
  let em;
  while ((em = elRe.exec(inner)) !== null) {
    const name = em[2];
    if (/Response$/i.test(name)) continue; // 跳过外层响应容器自身
    args[name] = unescapeXml(em[3].trim());
  }
  return { action, args };
}

/* ------------------------------------------------------------------ */
/* 纯助手：DIDL-Lite 元数据（SetAVTransportURI 用）                      */
/* ------------------------------------------------------------------ */

/**
 * 构造投屏资源的 DIDL-Lite 元数据。
 * @param uri    渲染器可访问的绝对 URL（本地文件经 LAN 文件服务暴露）
 * @param opts   { title, mime, duration(秒，可选), resolution(如 "1920x1080") }
 * protocolInfo 形如 http-get:*:video/mp4:*（DLNA 用 * 通配即可）
 */
function buildDidl(uri, opts) {
  const o = opts || {};
  const mime = o.mime || 'video/mp4';
  const title = escapeXml(o.title || 'Lumora');
  const proto = `http-get:*:${mime}:*`;
  const resAttrs = [
    `protocolInfo="${proto}"`,
    o.duration != null ? `duration="${formatDuration(o.duration)}"` : '',
    o.resolution ? `resolution="${escapeXml(o.resolution)}"` : '',
  ].filter(Boolean).join(' ');
  return `<?xml version="1.0" encoding="utf-8"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <item id="0" parentID="-1" restricted="0">
    <dc:title>${title}</dc:title>
    <upnp:class>object.item.videoItem</upnp:class>
    <res ${resAttrs}>${escapeXml(uri)}</res>
  </item>
</DIDL-Lite>`;
}

/** 把秒数格式化成 DIDL duration（H+:MM:SS.FFF） */
function formatDuration(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${hh}:${p2(mm)}:${p2(ss)}.${String(ms).padStart(3, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 发现：DlnaDiscovery（SSDP M-SEARCH）                                  */
/* ------------------------------------------------------------------ */

/**
 * SSDP 发现器。只负责发 M-SEARCH + 收 UDP 响应，解析成头后用
 * 'response' 事件吐出（不含设备描述，描述由上层按需 HTTP 拉取）。
 *
 * DI：opts.createSocket 默认用 dgram.createSocket；
 *     opts.send 可注入以绕过真实多播（测试用）。
 */
class DlnaDiscovery extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts || {};
    this.socket = null;
    this._timer = null;
    this._createSocket = this.opts.createSocket || (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
    this.searchTimeout = this.opts.searchTimeout || 4000;
    this.st = this.opts.st || DEVICE_MEDIA_RENDERER;
  }

  /**
   * 开始发现。
   * @param {number} [durationMs] 持续多久后自动 stop（默认 searchTimeout）
   * @returns {Promise<void>} socket 已就绪
   */
  start(durationMs) {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let sock;
      try {
        sock = this._createSocket();
      } catch (e) {
        return reject(e);
      }
      this.socket = sock;

      sock.on('error', (err) => {
        this.emit('error', err);
        // 端口占用等致命错误也向上传递
        if (!this.socket) reject(err);
      });

      sock.on('message', (msg, rinfo) => {
        let headers;
        try {
          headers = parseSsdpHeaders(msg);
        } catch {
          return; // 残缺报文忽略
        }
        if (!headers.location) return; // 我们只关心带 LOCATION 的（响应或通知）
        this.emit('response', { headers, address: rinfo && rinfo.address, port: rinfo && rinfo.port });
      });

      sock.on('listening', () => {
        try {
          sock.addMembership(SSDP_ADDR);
        } catch { /* 某些环境无多播路由，忽略但继续（单播响应仍可收） */ }
        this._sendSearch(sock);
        const dur = durationMs || this.searchTimeout;
        this._timer = setTimeout(() => {
          this.emit('search-timeout');
          this.stop();
        }, dur);
        if (this._timer.unref) this._timer.unref();
        resolve();
      });

      try {
        // 绑到随机高位端口；多播响应回发到这个端口
        sock.bind(0, '0.0.0.0');
      } catch (e) {
        reject(e);
      }
    });
  }

  _sendSearch(sock) {
    const msg =
      'M-SEARCH * HTTP/1.1\r\n' +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 3\r\n' +
      `ST: ${this.st}\r\n` +
      '\r\n';
    const buf = Buffer.from(msg, 'utf8');
    sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR, (err) => {
      if (err) this.emit('error', err);
    });
  }

  /** 停止发现并关闭 socket */
  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.socket) {
      try { this.socket.dropMembership(SSDP_ADDR); } catch { /* 忽略 */ }
      try { this.socket.close(); } catch { /* 忽略 */ }
      this.socket = null;
    }
    this.emit('stop');
  }
}

/* ------------------------------------------------------------------ */
/* 控制：DlnaRenderer                                                   */
/* ------------------------------------------------------------------ */

/**
 * 一个 DLNA 渲染器（智能电视/盒子）的控制客户端。
 * 基于 parseDeviceDescription 得到的描述 + 三个服务的 controlURL。
 *
 * DI：opts.httpRequest(url, options) => Promise<{statusCode, headers, body}>。
 *    默认走 Node http/https。这样测试可注入假响应，无需真实设备。
 */
class DlnaRenderer {
  constructor(opts) {
    if (!opts || !opts.device) throw new Error('DlnaRenderer requires device description');
    this.device = opts.device;
    this.httpRequest = opts.httpRequest || nodeHttpRequest;
    this.baseURL = opts.baseURL || this.device.baseURL || '';
    this._serviceCache = {};
  }

  /** 取某服务类型的 controlURL（缓存，找不到返回 null） */
  _controlUrl(serviceType) {
    if (this._serviceCache[serviceType]) return this._serviceCache[serviceType];
    const svc = this.device.services.find((s) => s.type === serviceType);
    const url = svc && svc.controlURL ? svc.controlURL : null;
    this._serviceCache[serviceType] = url;
    return url;
  }

  /**
   * 发送一个 SOAP 动作到某个服务。
   * @returns Promise<args> SOAP 响应体里的参数对象
   */
  async _soap(serviceType, action, args) {
    const url = this._controlUrl(serviceType);
    if (!url) throw new Error(`service not available: ${serviceType}`);
    const body = buildSoapRequest(serviceType, action, args);
    const res = await this.httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"${serviceType}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    if (res.statusCode && res.statusCode >= 400) {
      // 4xx/5xx 可能带 SOAP fault（如 500 + fault），仍尝试解析以拿到可读错误
      try {
        parseSoapResponse(res.body || '');
      } catch (e) {
        if (e instanceof DlnaSoapError) throw e;
        throw new Error(`HTTP ${res.statusCode} from ${action}`);
      }
      throw new Error(`HTTP ${res.statusCode} from ${action}`);
    }
    const { args: out } = parseSoapResponse(res.body || '');
    return out;
  }

  /** 设当前播放资源（本地文件经 LAN 文件服务 / 远程 URL 皆可）。返回 Promise */
  async setAvUri(uri, opts) {
    return this._soap(SERVICE.AVTransport, 'SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: uri,
      CurrentURIMetaData: buildDidl(uri, Object.assign({ title: this.device.friendlyName || 'Lumora' }, opts)),
    });
  }

  /** 播放（可带倍速，默认 1） */
  async play(speed = 1) {
    return this._soap(SERVICE.AVTransport, 'Play', { InstanceID: 0, Speed: String(speed) });
  }

  /** 暂停 */
  async pause() {
    return this._soap(SERVICE.AVTransport, 'Pause', { InstanceID: 0 });
  }

  /** 停止 */
  async stop() {
    return this._soap(SERVICE.AVTransport, 'Stop', { InstanceID: 0 });
  }

  /** 跳转（秒，绝对位置） */
  async seek(seconds) {
    return this._soap(SERVICE.AVTransport, 'Seek', {
      InstanceID: 0,
      Unit: 'ABS_TIME',
      Target: formatDuration(seconds),
    });
  }

  /** 设置音量（0~100） */
  async setVolume(volume) {
    const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
    return this._soap(SERVICE.RenderingControl, 'SetVolume', {
      InstanceID: 0, Channel: 'Master', DesiredVolume: v,
    });
  }

  /** 取传输状态：返回 { state, speed }，state ∈ STOPPED/PLAYING/PAUSED_PLAYBACK/... */
  async getTransportInfo() {
    const args = await this._soap(SERVICE.AVTransport, 'GetTransportInfo', { InstanceID: 0 });
    return { state: (args.CurrentTransportState || '').toUpperCase(), speed: args.CurrentSpeed };
  }

  /** 取播放位置：返回 { positionSeconds, durationSeconds, uri } */
  async getPositionInfo() {
    const args = await this._soap(SERVICE.AVTransport, 'GetPositionInfo', { InstanceID: 0 });
    return {
      positionSeconds: parseDuration(args.RelTime),
      durationSeconds: parseDuration(args.TrackDuration),
      uri: args.TrackURI || '',
    };
  }
}

/** 解析 DIDL duration（H+:MM:SS.FFF）→ 秒；失败返回 0 */
function parseDuration(str) {
  if (!str || typeof str !== 'string') return 0;
  const m = str.match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const ms = Number((m[4] || '0').padEnd(3, '0')) / 1000;
  return h * 3600 + mm * 60 + s + ms;
}

/* ------------------------------------------------------------------ */
/* 默认 HTTP 实现（生产路径；测试注入假实现）                            */
/* ------------------------------------------------------------------ */

/**
 * 用 Node http/https 发一次请求。options.body 为字符串时作为请求体。
 * 返回 { statusCode, headers, body }。
 */
function nodeHttpRequest(url, options) {
  const http = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

module.exports = {
  SERVICE,
  DEVICE_MEDIA_RENDERER,
  SSDP_ADDR,
  SSDP_PORT,
  parseSsdpHeaders,
  isMediaRenderer,
  parseDeviceDescription,
  resolveUrl,
  buildSoapRequest,
  parseSoapResponse,
  DlnaSoapError,
  buildDidl,
  formatDuration,
  parseDuration,
  DlnaDiscovery,
  DlnaRenderer,
  nodeHttpRequest,
};
