'use strict';
/**
 * 投屏用的临时局域网文件服务（cast-out，v1）。
 *
 * 问题：DLNA 渲染器（智能电视/盒子）要拉的是"一个它能在 LAN 上 GET 到的 URL"，
 * 而不是本机文件路径。所以当我们要把本地文件投到电视时，Lumora 必须在局域网
 * 上临时起一个 HTTP 服务，把该文件暴露成 http://<本机LAN IP>:<port>/cast。
 *
 * 设计：
 *   - 只服务"当前正在投"的那一个文件（v1 单文件），杜绝目录遍历/全盘暴露。
 *   - 正确 Content-Type + Accept-Ranges（部分渲染器靠 Range 做拖动）。
 *   - 纯 Node http，零依赖；httpServerFactory / getLanIp 均可 DI 注入便于单测。
 *   - 仅在投放期间运行；断开即关（生命周期由 ipc-cast.js 的 CastManager 管）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

/* ------------------------------------------------------------------ */
/* MIME 映射                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp:': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
  mka: 'audio/x-matroska',
  srt: 'application/x-subrip',
  ass: 'text/x-ssa',
  vtt: 'text/vtt',
};

/** 按扩展名解析 MIME（小写 ext，不带点）。未知 → application/octet-stream。 */
function resolveMime(filePath) {
  const ext = path.extname(filePath || '').toLowerCase().replace(/^\./, '');
  return MIME[ext] || 'application/octet-stream';
}

/* ------------------------------------------------------------------ */
/* 取本机 LAN IPv4（非回环、非内部）                                    */
/* ------------------------------------------------------------------ */

/**
 * 返回第一个可用的局域网 IPv4 地址（跳过 127.x / 169.254 链路本地 / 虚拟）。
 * DI：opts.getInterfaces 默认 os.networkInterfaces。找不到则返回 '127.0.0.1'。
 */
function getLanIp(opts) {
  const ifaces = (opts && opts.getInterfaces) ? opts.getInterfaces() : os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' && ni.family !== 4) continue;
      if (ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue; // 链路本地跳过
      candidates.push(ni.address);
    }
  }
  // 优先以太网/局域网段，退而求其次取第一个候选
  const lan = candidates.find((a) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a));
  return lan || candidates[0] || '127.0.0.1';
}

/* ------------------------------------------------------------------ */
/* 文件服务                                                             */
/* ------------------------------------------------------------------ */

/** 解析 HTTP Range 头，返回 { start, end } 或 null（不支持/畸形） */
function parseRange(header, size) {
  if (!header) return null;
  const m = header.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 投屏临时文件服务。同一时刻只服务一个文件。
 *
 * @param {object} [opts]
 *   httpServerFactory(reqListener) => http.Server   默认 http.createServer
 *   getLanIpImpl() => string                         默认 getLanIp()
 *   port                                          指定端口（默认 0 = 随机）
 */
class CastFileServer {
  constructor(opts) {
    this.opts = opts || {};
    this.server = null;
    this.filePath = null;
    this.mime = null;
    this.size = 0;
    this.port = 0;
    this._createServer = this.opts.httpServerFactory || ((h) => http.createServer(h));
    this._getLanIp = this.opts.getLanIpImpl || (() => getLanIp());
  }

  /**
   * 启动服务并开始服务指定文件。
   * @returns Promise<{ url, port, lanIp }> url 形如 http://192.168.x.x:port/cast
   */
  start(filePath, mime) {
    return new Promise((resolve, reject) => {
      if (this.server) this.stop();
      this.filePath = filePath;
      this.mime = mime || resolveMime(filePath);
      try {
        const st = fs.statSync(filePath);
        this.size = st.size;
      } catch (e) {
        return reject(new Error(`file not readable: ${filePath} (${e.message})`));
      }

      const handler = (req, res) => this._handle(req, res);
      this.server = this._createServer(handler);

      this.server.on('error', reject);
      this.server.listen(this.opts.port || 0, '0.0.0.0', () => {
        this.port = this.server.address().port;
        const lanIp = this._getLanIp();
        const url = `http://${lanIp}:${this.port}/cast`;
        resolve({ url, port: this.port, lanIp });
      });
    });
  }

  _handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      res.writeHead(404);
      return res.end('not serving');
    }

    const range = parseRange(req.headers.range, this.size);
    const headers = {
      'Content-Type': this.mime,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };

    if (range) {
      const len = range.end - range.start + 1;
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${this.size}`;
      headers['Content-Length'] = len;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(this.filePath, { start: range.start, end: range.end })
        .on('error', () => { res.destroy(); })
        .pipe(res);
    }

    headers['Content-Length'] = this.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(this.filePath)
      .on('error', () => { res.destroy(); })
      .pipe(res);
  }

  /** 停止服务并关闭监听 */
  stop() {
    if (this.server) {
      try { this.server.close(); } catch { /* 已关 */ }
      this.server = null;
    }
    this.filePath = null;
    this.mime = null;
    this.size = 0;
    this.port = 0;
  }

  get serving() { return !!this.server; }
}

module.exports = {
  MIME,
  resolveMime,
  getLanIp,
  parseRange,
  CastFileServer,
};
