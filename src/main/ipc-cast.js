'use strict';
/**
 * IPC 注册·cast（自包含模块）。
 * 投屏域（cast-out，v1 = DLNA + Chromecast）。编排 CastManager：
 *   - 发现：DLNA（SSDP MediaRenderer）+ Chromecast（mDNS _googlecast._tcp）
 *   - 连接：按设备 type 建 DlnaRenderer 或 ChromecastClient
 *   - 投本地文件（起 LAN 文件服务）/ 投远程 URL → 统一控制（play/pause/stop/seek/setVolume）
 *   - 状态变更 → 推 'cast:state' 给渲染端
 *
 * Chromecast 鉴权：CASTV2 TLS 要求标准 Cast 客户端证书（含 salt）。证书/私钥
 * 通过配置项 cast.chromecastCert / cast.chromecastKey / cast.chromecastSalt 注入
 * （PEM 字符串或文件路径，缺则无法过鉴权）。见 chromecast.js。
 */
const { ipcMain } = require('electron');
const {
  DlnaDiscovery, DlnaRenderer, parseDeviceDescription,
  isMediaRenderer, nodeHttpRequest,
} = require('./cast/dlna');
const {
  ChromecastDiscovery, ChromecastClient,
} = require('./cast/chromecast');
const { CastFileServer, resolveMime } = require('./cast/file-server');

let CTX = {};
let manager = null;

function register(ipcCtx) {
  CTX = ipcCtx || {};
  manager = new CastManager(buildCastOpts(ipcCtx));
  wireIpc();
}

/** 从宿主 ctx 抽取投屏相关配置（证书等） */
function buildCastOpts(ipcCtx) {
  const cfg = ipcCtx && typeof ipcCtx.getConfig === 'function' ? ipcCtx.getConfig() : null;
  const o = {};
  if (cfg && typeof cfg.get === 'function') {
    const pick = (k) => { try { return cfg.get(k); } catch { return undefined; } };
    o.authCertificate = pick('cast.chromecastCert');
    o.authKey = pick('cast.chromecastKey');
    o.authSalt = pick('cast.chromecastSalt');
    const fso = pick('cast.fileServer');
    if (fso && typeof fso === 'object') o.fileServerOpts = fso;
  }
  return o;
}

function getManager() { return manager; }
function sendToRenderer(channel, payload) {
  return CTX.sendToRenderer ? CTX.sendToRenderer(channel, payload) : null;
}

/* ------------------------------------------------------------------ */
/* CastManager                                                         */
/* ------------------------------------------------------------------ */

class CastManager {
  constructor(opts) {
    this.opts = opts || {};
    this.discoveries = new Map();   // type('dlna'|'chromecast') -> discovery instance
    this.devices = new Map();        // udn/id -> { udn, type, ... }
    this.client = null;              // 当前活动客户端（DlnaRenderer | ChromecastClient）
    this.activeUdn = null;
    this.fileServer = new CastFileServer(this.opts.fileServerOpts || {});
    this.httpRequest = this.opts.httpRequest || nodeHttpRequest;
    this._createDlnaDiscovery = this.opts.createDlnaDiscovery ||
      (() => new DlnaDiscovery());
    this._createChromecastDiscovery = this.opts.createChromecastDiscovery ||
      (() => new ChromecastDiscovery());
  }

  /* ---- 发现 ---- */

  startDiscovery() {
    if (this.discoveries.size) return { ok: true, already: true };
    this._startDlnaDiscovery();
    this._startChromecastDiscovery();
    return { ok: true };
  }

  _startDlnaDiscovery() {
    let d;
    try { d = this._createDlnaDiscovery(); }
    catch (e) { console.warn('[cast] DLNA 发现初始化失败:', e.message); return; }
    d.on('response', ({ headers, address }) => {
      if (!isMediaRenderer(headers)) return;
      const loc = headers.location;
      if (!loc) return;
      const usn = headers.usn || '';
      const udn = (usn.split('::')[0]) || loc;
      const existing = this.devices.get(udn);
      if (existing && existing.desc) return;
      this._fetchDescription(udn, loc, headers)
        .catch((e) => console.warn('[cast] DLNA 设备描述拉取失败', loc, e.message));
    });
    d.on('error', (e) => console.warn('[cast] DLNA 发现错误:', e.message));
    this.discoveries.set('dlna', d);
    d.start().catch((e) => console.warn('[cast] DLNA 发现启动失败:', e.message));
  }

  _startChromecastDiscovery() {
    let d;
    try { d = this._createChromecastDiscovery(); }
    catch (e) { console.warn('[cast] Chromecast 发现初始化失败:', e.message); return; }
    d.on('device', (dev) => {
      const id = dev.id;
      if (!id) return;
      const existing = this.devices.get(id);
      if (existing) {
        if (!existing.friendlyName && dev.friendlyName) existing.friendlyName = dev.friendlyName;
        return;
      }
      const entry = {
        udn: id, type: 'chromecast',
        friendlyName: dev.friendlyName || id, modelName: dev.model || '',
        address: dev.address, port: dev.port || 8009,
        connected: false, desc: null, ssdp: null,
      };
      this.devices.set(id, entry);
      sendToRenderer('cast:device', this._deviceSummary(id, entry));
    });
    d.on('error', (e) => console.warn('[cast] Chromecast 发现错误:', e.message));
    this.discoveries.set('chromecast', d);
    d.start().catch((e) => console.warn('[cast] Chromecast 发现启动失败:', e.message));
  }

  async _fetchDescription(udn, loc, ssdpHeaders) {
    const res = await this.httpRequest(loc, { method: 'GET' });
    if (!res || (res.statusCode && res.statusCode >= 400)) {
      throw new Error('http ' + (res && res.statusCode));
    }
    const desc = parseDeviceDescription(res.body, loc);
    const entry = {
      udn, type: 'dlna', ssdp: ssdpHeaders, desc, connected: false,
      friendlyName: undefined, modelName: undefined, manufacturer: undefined,
    };
    this.devices.set(udn, entry);
    sendToRenderer('cast:device', this._deviceSummary(udn, entry));
    return entry;
  }

  _deviceSummary(udn, entry) {
    const d = entry.desc || {};
    const svcTypes = (d.services || []).map((s) => s.type);
    return {
      udn,
      type: entry.type || 'dlna',
      friendlyName: entry.friendlyName || d.friendlyName || udn,
      modelName: entry.modelName || d.modelName || '',
      manufacturer: entry.manufacturer || d.manufacturer || '',
      hasAvTransport: svcTypes.some((t) => t.includes('AVTransport')),
      hasRenderingControl: svcTypes.some((t) => t.includes('RenderingControl')),
      connected: !!entry.connected,
    };
  }

  stopDiscovery() {
    for (const d of this.discoveries.values()) {
      try { d.stop(); } catch { /* 忽略 */ }
    }
    this.discoveries.clear();
    return { ok: true };
  }

  listDevices() {
    return [...this.devices.values()].map((e) => this._deviceSummary(e.udn, e));
  }

  /* ---- 连接 / 控制 ---- */

  async connect(udn) {
    const entry = this.devices.get(udn);
    if (!entry) throw new Error('未知设备: ' + udn);

    if (entry.type === 'chromecast') {
      const client = new ChromecastClient({
        address: entry.address,
        port: entry.port,
        authCertificate: this.opts.authCertificate,
        authKey: this.opts.authKey,
        authSalt: this.opts.authSalt,
        createTls: this.opts.createTls,
      });
      await client.connect();
      this.client = client;
    } else {
      if (!entry.desc) await this._fetchDescription(udn, entry.ssdp.location, entry.ssdp);
      this.client = new DlnaRenderer({ device: entry.desc, httpRequest: this.httpRequest });
    }

    this.activeUdn = udn;
    entry.connected = true;
    const summary = this._deviceSummary(udn, entry);
    sendToRenderer('cast:state', {
      connected: true, type: summary.type, udn,
      friendlyName: summary.friendlyName,
    });
    return summary;
  }

  async _ensureClient() {
    if (!this.client) throw new Error('尚未连接到投屏设备');
  }

  /** 投本地文件：起 LAN 文件服务 → 拿 URL → SetAVTransportURI/LOAD + Play */
  async castFile(localPath, opts) {
    await this._ensureClient();
    const info = await this.fileServer.start(localPath, (opts && opts.mime) || resolveMime(localPath));
    const meta = Object.assign({ title: (opts && opts.title) || 'Lumora' },
      opts && opts.duration != null ? { duration: opts.duration } : {},
      opts && opts.resolution ? { resolution: opts.resolution } : {});
    await this.client.setAvUri(info.url, meta);
    await this.client.play(1);
    this._pushState();
    return { ok: true, url: info.url, lanIp: info.lanIp };
  }

  /** 投远程 URL（网络串流）：直接 SetAVTransportURI/LOAD + Play */
  async castUrl(url, opts) {
    await this._ensureClient();
    await this.client.setAvUri(url, opts || {});
    await this.client.play(1);
    this._pushState();
    return { ok: true };
  }

  async pause() { await this._ensureClient(); await this.client.pause(); this._pushState(); return { ok: true }; }
  async resume() { await this._ensureClient(); await this.client.play(1); this._pushState(); return { ok: true }; }
  async stop() {
    await this._ensureClient();
    await this.client.stop();
    this.fileServer.stop();
    this._pushState();
    return { ok: true };
  }
  async seek(seconds) { await this._ensureClient(); await this.client.seek(seconds); this._pushState(); return { ok: true }; }
  async setVolume(v) { await this._ensureClient(); await this.client.setVolume(v); this._pushState(); return { ok: true }; }

  async getState() {
    if (!this.client) return { connected: false };
    try {
      const [ti, pi] = await Promise.all([
        this.client.getTransportInfo(),
        this.client.getPositionInfo(),
      ]);
      return {
        connected: true, udn: this.activeUdn,
        state: ti.state, positionSeconds: pi.positionSeconds,
        durationSeconds: pi.durationSeconds,
      };
    } catch (e) {
      return { connected: true, udn: this.activeUdn, state: 'UNKNOWN', error: e.message };
    }
  }

  disconnect() {
    if (this.client) {
      try {
        if (typeof this.client.disconnect === 'function') this.client.disconnect();
        else if (typeof this.client.stop === 'function') this.client.stop().catch(() => {});
      } catch { /* 忽略 */ }
    }
    this.fileServer.stop();
    const udn = this.activeUdn;
    if (udn && this.devices.has(udn)) this.devices.get(udn).connected = false;
    this.client = null;
    this.activeUdn = null;
    sendToRenderer('cast:state', { connected: false });
    return { ok: true };
  }

  _pushState() {
    this.getState().then((s) => sendToRenderer('cast:state', s)).catch(() => {});
  }

  /** 关机/退出时清理一切 */
  stopAll() {
    this.stopDiscovery();
    this.disconnect();
  }
}

/* ------------------------------------------------------------------ */
/* IPC 接线                                                           */
/* ------------------------------------------------------------------ */

function wireIpc() {
  ipcMain.handle('cast:start-discovery', () => manager.startDiscovery());
  ipcMain.handle('cast:stop-discovery', () => manager.stopDiscovery());
  ipcMain.handle('cast:list', () => manager.listDevices());
  ipcMain.handle('cast:connect', (_e, { udn }) => manager.connect(udn));
  ipcMain.handle('cast:play-file', (_e, { path, title, mime, duration, resolution }) =>
    manager.castFile(path, { title, mime, duration, resolution }));
  ipcMain.handle('cast:play-url', (_e, { url, title, mime }) =>
    manager.castUrl(url, { title, mime }));
  ipcMain.handle('cast:pause', () => manager.pause());
  ipcMain.handle('cast:resume', () => manager.resume());
  ipcMain.handle('cast:stop', () => manager.stop());
  ipcMain.handle('cast:seek', (_e, { seconds }) => manager.seek(seconds));
  ipcMain.handle('cast:set-volume', (_e, { volume }) => manager.setVolume(volume));
  ipcMain.handle('cast:disconnect', () => manager.disconnect());
  ipcMain.handle('cast:get-state', () => manager.getState());
}

module.exports = { register, getManager, CastManager };
