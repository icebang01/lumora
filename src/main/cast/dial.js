'use strict';
/**
 * DIAL 投屏客户端（cast-out，v2 = +DIAL）。
 *
 * DIAL = Discovery and Launch，由 Netflix 提出的轻量投屏协议，被大量智能电视 /
 * 盒子采用（YouTube / Netflix 等 App 的"投屏到电视"即基于 DIAL）。
 *
 * 协议要点（仅 SSDP 发现 + HTTP 应用控制，无持续媒体通道）：
 *   1) 发现：SSDP M-SEARCH ST=urn:dial-multiscreen-org:service:dial:1，
 *      响应 LOCATION → 设备描述 XML。
 *   2) 设备描述里找 serviceType=urn:dial-multiscreen-org:service:dial:1 的
 *      服务，其 controlURL 即"应用基址"（如 http://tv:8001/apps/）。
 *   3) 应用状态：GET {appBase}/{appName} →
 *      <service><state>running|stopped|hidden</state>
 *      <link rel="run" href="{instanceURL}"/></service>
 *   4) 启动：POST {appBase}/{appName}（Content-Type: application/dial+xml，
 *      请求体含 <payload><url>...</url></payload>）→ 201 + LOCATION=instanceURL。
 *   5) 停止：DELETE {instanceURL} → 200。
 *
 * 与 DLNA / Chromecast 不同：DIAL 不直接传音视频流，而是"让设备上的 App 自己去取
 * 指定 URL 播放"。因此 Lumora 通过 DIAL 投屏 = 启动目标 App 并告诉它去播某个 URL
 * （默认 YouTube）。暂停 / 进度 / 音量等传输控制依赖具体 App，本客户端对它们返回
 * 明确的不支持错误，而非伪造——这既是协议事实，也避免 UI 出现"假可用"按钮。
 *
 * 设计目标（与 dlna.js / chromecast.js 对齐）：
 *   1) 可被 node:test 直接单测 —— 所有"网络 I/O"都通过 DI 注入
 *      （httpRequest 默认走 Node http/https；DialDiscovery 复用 DlnaDiscovery 的
 *       socketFactory / send 注入）。
 *   2) 职责单一：本模块只管"发现 + 应用启动/停止/状态"，不碰 UI、不碰文件服务、
 *      不碰生命周期（那些在 ipc-cast.js 的 CastManager 里）。
 */
const { EventEmitter } = require('events');
const {
  DlnaDiscovery, parseDeviceDescription, nodeHttpRequest, resolveUrl,
} = require('./dlna');

const DIAL_SERVICE = 'urn:dial-multiscreen-org:service:dial:1';
const DIAL_ST = DIAL_SERVICE;                       // SSDP 搜索目标
const DIAL_XMLNS = 'urn:dial-multiscreen-org:schemas:dial';

/* ------------------------------------------------------------------ */
/* 纯助手：SSDP 头 / DIAL XML 解析                                      */
/* ------------------------------------------------------------------ */

/** SSDP 头是否指向 DIAL 设备（ST 或 NT 命中 dial-multiscreen） */
function isDialDevice(headers) {
  const st = (headers && (headers.st || '') || '').toLowerCase();
  const nt = (headers && (headers.nt || '') || '').toLowerCase();
  return st.includes('dial-multiscreen') || nt.includes('dial-multiscreen');
}

/** 取第一个匹配标签的文本（DIAL XML 命名空间无关，简单正则即可） */
function dialTag(xml, tag) {
  if (!xml) return '';
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

/** 取 <link rel="run" href="..."/> 的 href（应用实例 URL） */
function dialInstanceHref(xml) {
  if (!xml) return '';
  const re = /<link\b[^>]*\brel="run"[^>]*\bhref="([^"]+)"[^>]*\/?>/i;
  const m = xml.match(re);
  if (m) return m[1];
  // 退化：<link href="..." rel="run"/>
  const re2 = /<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="run"[^>]*\/?>/i;
  const m2 = xml.match(re2);
  return m2 ? m2[1] : '';
}

/**
 * 解析 DIAL 应用状态响应（GET {appBase}/{appName} 的 200 / 404 体）。
 * 返回 { installed, state, instanceUrl }。
 * state ∈ 'running' | 'stopped' | 'hidden' | 'not_installed'。
 */
function parseDialAppStatus(xml, statusCode) {
  if (statusCode === 404) return { installed: false, state: 'not_installed', instanceUrl: '' };
  const state = dialTag(xml, 'state') || 'stopped';
  const instanceUrl = dialInstanceHref(xml);
  return { installed: true, state, instanceUrl };
}

/** 转义 XML 文本（构造 DIAL 启动体时防止 URL 破坏信封） */
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 构造 DIAL 启动请求体（application/dial+xml）。
 * @param appName 目标 App 名（如 YouTube）
 * @param url     让 App 去播放的 URL（放 <payload><url> 内）
 */
function buildDialLaunch(appName, url) {
  return `<?xml version="1.0" encoding="utf-8"?>
<app xmlns="${DIAL_XMLNS}" dialVer="1.7">
  <name>${escapeXml(appName)}</name>
  <payload><url>${escapeXml(url)}</url></payload>
</app>`;
}

/* ------------------------------------------------------------------ */
/* 发现：DialDiscovery（SSDP，复用 DlnaDiscovery 套接字）                */
/* ------------------------------------------------------------------ */

/**
 * DIAL 发现器：直接复用 DlnaDiscovery 的 SSDP 套接字实现，仅换 ST 与过滤条件。
 * 吐出 'response' 事件 { headers, address, port }（与 DlnaDiscovery 完全一致），
 * 由上层 CastManager 用 isDialDevice 过滤。
 *
 * DI：opts.createSocket 默认沿用 DlnaDiscovery 的 dgram 套接字（继承自 DlnaDiscovery）；
 *     opts.searchTimeout 可调。测试可注入假 socket。
 */
class DialDiscovery extends DlnaDiscovery {
  constructor(opts) {
    super(Object.assign({ st: DIAL_ST }, opts || {}));
  }
}

/* ------------------------------------------------------------------ */
/* 控制：DialClient（按 App 维度的 DIAL 客户端）                        */
/* ------------------------------------------------------------------ */

/**
 * 一个 DIAL 设备的控制客户端。
 * 构造：opts { device, httpRequest, appName }。
 *   device：{ dialServiceUrl } —— DIAL 应用基址（由 CastManager 从设备描述提取）。
 *   appName：要启动的 App（默认 YouTube）。
 *   httpRequest：DI 注入（默认 Node http/https），便于单测。
 *
 * 实现与 DlnaRenderer / ChromecastClient 一致的方法签名
 *   （setAvUri / play / pause / resume / stop / seek / setVolume /
 *    getTransportInfo / getPositionInfo），以便 CastManager 不区分设备类型统一调用。
 * 注意：DIAL 无通用传输控制，pause / resume / seek / setVolume 明确抛"不支持"。
 */
class DialClient extends EventEmitter {
  constructor(opts) {
    super();
    if (!opts || !opts.device) throw new Error('DialClient requires device');
    this.device = opts.device;
    this.appName = opts.appName || 'YouTube';
    this.httpRequest = opts.httpRequest || nodeHttpRequest;
    this.appBase = this.device.dialServiceUrl || '';
    if (!this.appBase) throw new Error('DIAL 服务地址缺失（设备描述无 DIAL 服务）');
    this._instanceUrl = '';
    this._pendingUri = '';
    this._pendingOpts = {};
  }

  /** 应用基址 + App 名 → 应用 URL */
  _appUrl() {
    return resolveUrl(this.appBase, this.appName);
  }

  /** 查应用状态（running / stopped / hidden / 未安装） */
  async getAppStatus() {
    const res = await this.httpRequest(this._appUrl(), { method: 'GET' });
    const sc = res && res.statusCode;
    return parseDialAppStatus((res && res.body) || '', sc);
  }

  /** 设待播资源（仅记录，真正启动在 play()） */
  async setAvUri(uri, opts) {
    this._pendingUri = uri || '';
    this._pendingOpts = opts || {};
    return { ok: true };
  }

  /** 启动目标 App 并让它播放 _pendingUri（DIAL 的"播放"） */
  async play(speed = 1) {
    const url = this._pendingUri;
    if (!url) throw new Error('DIAL 无待播 URL（请先 castFile / castUrl）');
    const body = buildDialLaunch(this.appName, url);
    const res = await this.httpRequest(this._appUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dial+xml',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    if (res.statusCode === 201 || res.statusCode === 200) {
      this._instanceUrl = (res.headers && (res.headers.location || res.headers.LOCATION)) || this._instanceUrl;
      return { ok: true, instanceUrl: this._instanceUrl, launched: this.appName };
    }
    if (res.statusCode === 404) throw new Error(`目标 App「${this.appName}」未安装`);
    throw new Error(`DIAL 启动失败：HTTP ${res.statusCode}`);
  }

  /** DIAL 无通用暂停（由 App 决定）；明确不支持 */
  async pause() { throw new Error('DIAL 不支持通用暂停（由目标 App 控制）'); }
  /** DIAL 无通用继续；明确不支持 */
  async resume() { throw new Error('DIAL 不支持通用继续（由目标 App 控制）'); }
  /** DIAL 无进度跳转；明确不支持 */
  async seek(seconds) { throw new Error('DIAL 不支持进度跳转（由目标 App 控制）'); }
  /** DIAL 无音量控制；明确不支持 */
  async setVolume(v) { throw new Error('DIAL 不支持音量控制（由目标 App 控制）'); }

  /** 停止：DELETE 应用实例（若已知） */
  async stop() {
    if (this._instanceUrl) {
      try {
        await this.httpRequest(this._instanceUrl, { method: 'DELETE' });
      } catch { /* 实例可能已不在，忽略 */ }
      this._instanceUrl = '';
    }
    return { ok: true };
  }

  /** 传输状态（DIAL 仅能反映 App 是否 running） */
  async getTransportInfo() {
    try {
      const st = await this.getAppStatus();
      const state = st.state === 'running' ? 'PLAYING'
        : st.state === 'hidden' ? 'PAUSED_PLAYBACK'
        : 'STOPPED';
      return { state, speed: '1' };
    } catch {
      return { state: 'STOPPED', speed: '1' };
    }
  }

  /** 位置信息（DIAL 无通用位置查询，返回 0） */
  async getPositionInfo() {
    return { positionSeconds: 0, durationSeconds: 0, uri: this._pendingUri };
  }
}

module.exports = {
  DIAL_SERVICE, DIAL_ST, DIAL_XMLNS,
  isDialDevice, DialDiscovery, DialClient,
  parseDialAppStatus, buildDialLaunch, dialInstanceHref, dialTag, escapeXml,
};
