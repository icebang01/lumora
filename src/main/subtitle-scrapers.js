'use strict';
/**
 * 字幕网抓取框架（无配置字幕源）。
 * 仅主进程使用。依赖 cheerio（HTML 解析）、yauzl（zip）、node-unrar-js（rar）。
 *
 * 设计要点：
 *  - 每个站点是一个 provider，注册在 PROVIDERS 中，各自提供 search 解析与下载解析。
 *  - 站点无公开 API，HTML 结构可能随改版变化；选择器集中在 provider 内部，便于单独修正。
 *  - 抓取失败（网络 / 反爬 / 验证码）只影响该站点，不拖累其它字幕源；错误汇总到调用方。
 *
 * 重要：字幕网通常有反爬或验证码，抓取结果需在真实联网环境验证；本模块保证「抓取 + 解压」
 *       逻辑正确，但具体选择器需按线上 HTML 调整（见各 provider 内的注释）。
 */

const zlib = require('zlib');
const yauzl = require('yauzl');
const cheerio = require('cheerio');
const Rar = require('node-unrar-js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 12000;

let _enabled = true;
function setEnabled(v) { _enabled = !!v; }
function isEnabled() { return _enabled; }

/* ------------------------------------------------------------------ */
/* 通用网络                                                            */
/* ------------------------------------------------------------------ */

async function fetchHtml(url, { timeout = FETCH_TIMEOUT, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: Object.assign({
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }, headers),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchBuffer(url, { timeout = FETCH_TIMEOUT, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: Object.assign({ 'User-Agent': UA }, headers),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* 语言判定                                                            */
/* ------------------------------------------------------------------ */

function detectLang(text) {
  const s = String(text || '').toLowerCase();
  const zh = /(简体|繁體|简繁|中英|双语|chs|cht|chinese|中文|国语|粤语|gb|big5)/.test(s);
  const en = /(english|英语|eng|英字)/.test(s);
  if (zh && en) return { lang: 'zh', langName: 'Chinese&English' };
  if (zh) return { lang: 'zh', langName: 'Chinese' };
  if (en) return { lang: 'en', langName: 'English' };
  return { lang: 'zh', langName: 'Chinese' };
}

/* ------------------------------------------------------------------ */
/* 归档解压                                                            */
/* ------------------------------------------------------------------ */

const SUB_EXT = /\.(srt|ass|vtt|ssa|sup|smi|lrc)$/i;

function isTextBuffer(buf) {
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function isArchiveMagic(buf) {
  // zip: PK\x03\x04 ; rar: Rar!
  if (buf.length >= 4 &&
      buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return true;
  if (buf.length >= 4 &&
      buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return true;
  return false;
}

function isLikelySrt(text) {
  return /-->/.test(text.slice(0, 2000));
}

async function extractFromZip(buf) {
  const zip = await yauzl.fromBufferPromise(buf, { lazyEntries: true });
  return new Promise((resolve, reject) => {
    const found = [];
    zip.on('entry', (entry) => {
      if (/\/$/.test(entry.fileName) || !SUB_EXT.test(entry.fileName)) { zip.readEntry(); return; }
      zip.openReadStream(entry, (err, stream) => {
        if (err) { zip.readEntry(); return; }
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          found.push({ name: entry.fileName, content: Buffer.concat(chunks).toString('utf8') });
          zip.readEntry();
        });
        stream.on('error', () => zip.readEntry());
      });
    });
    zip.on('end', () => resolve(found));
    zip.on('error', reject);
    zip.readEntry();
  });
}

async function extractFromRar(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const extractor = await Rar.createExtractorFromData({ data: ab });
  const arcFiles = extractor.extract();
  const found = [];
  for (const f of arcFiles.files) {
    const name = f.fileHeader && f.fileHeader.name;
    if (!name || !SUB_EXT.test(name)) continue;
    const content = f.extraction; // Uint8Array
    if (!content) continue;
    found.push({ name, content: Buffer.from(content).toString('utf8') });
  }
  return found;
}

/**
 * 解归档缓冲，返回所有字幕文件 [{ name, content }]。
 * 支持：明文 srt/ass/vtt；gz（解压后递归）；zip；rar。
 */
async function decodeArchiveBuffer(buf, fallbackName) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);

  // 明文（排除归档魔数）
  if (!isArchiveMagic(buf) && isTextBuffer(buf) &&
      (SUB_EXT.test(fallbackName || '') || isLikelySrt(buf.toString('utf8')))) {
    return [{ name: fallbackName || 'sub.srt', content: buf.toString('utf8') }];
  }

  // gzip 单流（可能包着归档或明文）
  try {
    const out = zlib.gunzipSync(buf);
    if (isTextBuffer(out)) return [{ name: fallbackName || 'sub.srt', content: out.toString('utf8') }];
    const inner = await decodeArchiveBuffer(out, fallbackName);
    if (inner.length) return inner;
  } catch { /* 不是 gzip */ }

  // zip
  try {
    const z = await extractFromZip(buf);
    if (z.length) return z;
  } catch { /* 不是 zip */ }

  // rar
  try {
    const r = await extractFromRar(buf);
    if (r.length) return r;
  } catch { /* 不是 rar */ }

  throw new Error('字幕归档解压失败：未知格式（期望 .srt/.ass/.vtt/.zip/.rar/.gz）');
}

/* ------------------------------------------------------------------ */
/* Provider 注册                                                      */
/* ------------------------------------------------------------------ */

function dedupeResults(arr) {
  const seen = new Map();
  const out = [];
  for (const r of arr) {
    const k = (r.name || '') + '|' + r.lang + '|' + r.detailUrl;
    if (seen.has(k)) continue;
    seen.set(k, true);
    out.push(r);
  }
  return out;
}

function absUrl(href, host) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return host + (href.startsWith('/') ? '' : '/') + href;
}

const PROVIDERS = {
  /* ------------------------------------------------------------------ */
  /* 字幕库 (zimuku)                                                     */
  /* 站点结构可能改版，以下选择器需按线上 HTML 调整。                    */
  /* ------------------------------------------------------------------ */
  zimuku: {
    name: '字幕库',
    host: 'https://www.zimuku.cn',
    searchUrl(query) {
      return this.host + '/search?q=' + encodeURIComponent(query);
    },
    parseSearch(html) {
      const $ = cheerio.load(html);
      const out = [];
      $('a[href]').each((_, el) => {
        const a = $(el);
        const href = a.attr('href') || '';
        if (!/\/(detail|sub|s)\//i.test(href)) return; // 详情页链接
        const txt = (a.attr('title') || a.text() || '').trim();
        if (!txt) return;
        const detailUrl = absUrl(href, this.host);
        const { lang, langName } = detectLang(txt);
        out.push({ name: txt, lang, langName, detailUrl, downloads: 0, release: '' });
      });
      return dedupeResults(out);
    },
    async resolveDownload(detailUrl) {
      const html = await fetchHtml(detailUrl, { headers: { Referer: this.host + '/' } });
      const $ = cheerio.load(html);
      let dl = '';
      // 优先 /down 或 .zip/.rar 直链
      $('a[href]').each((_, el) => {
        const h = $(el).attr('href') || '';
        if (!dl && (/\/down/i.test(h) || /\.(zip|rar)(\?|$)/i.test(h))) dl = h;
      });
      if (!dl) throw new Error('字幕库：未找到下载链接');
      const url = absUrl(dl, this.host);
      return fetchBuffer(url, { headers: { Referer: detailUrl } });
    },
  },

  /* ------------------------------------------------------------------ */
  /* SubHD (字幕组)                                                      */
  /* 经典 anti-bot：详情页取 id + token，POST /ajax/download 拿直链。    */
  /* 若线上改了 token 字段名或加了验证码，需调整此处。                  */
  /* ------------------------------------------------------------------ */
  subhd: {
    name: 'SubHD',
    host: 'https://subhd.tv',
    searchUrl(query) {
      return this.host + '/search?q=' + encodeURIComponent(query);
    },
    parseSearch(html) {
      const $ = cheerio.load(html);
      const out = [];
      $('a[href]').each((_, el) => {
        const a = $(el);
        const href = a.attr('href') || '';
        if (!/\/s\//i.test(href)) return; // 详情页形如 /s/<id>
        const txt = (a.text() || '').trim();
        if (!txt) return;
        const detailUrl = absUrl(href, this.host);
        const { lang, langName } = detectLang(txt);
        out.push({ name: txt, lang, langName, detailUrl, downloads: 0, release: '' });
      });
      return dedupeResults(out);
    },
    async resolveDownload(detailUrl) {
      const html = await fetchHtml(detailUrl, { headers: { Referer: this.host + '/' } });
      const $ = cheerio.load(html);

      const idMatch = detailUrl.match(/\/s\/(\d+)/);
      const id = idMatch ? idMatch[1]
        : ($('input[name="id"]').attr('value') || $('#download-id').attr('value') || '');
      const token = $('meta[name="subhd-token"]').attr('content')
        || $('input[name="token"]').attr('value')
        || $('#subhd-token').attr('value') || '';
      if (!id) throw new Error('SubHD：未找到字幕 id');

      const body = new URLSearchParams({ id, token: token || '', _: '' }).toString();
      const res = await fetch(this.host + '/ajax/download', {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Referer': detailUrl,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body,
      });
      if (!res.ok) throw new Error('SubHD 下载请求失败：HTTP ' + res.status);
      const data = await res.json().catch(() => null);
      const dlUrl = (data && (data.url || data.data || (data.result && data.result.url)))
        || (typeof data === 'string' ? data : '');
      if (!dlUrl) throw new Error('SubHD：未返回下载地址（可能被反爬拦截）');
      const url = absUrl(dlUrl, this.host);
      return fetchBuffer(url, { headers: { Referer: detailUrl } });
    },
  },
};

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/** 搜索某站点字幕（按关键词），返回统一结构数组（未归一化 id/fileId）。 */
async function scrapeSearch(provider, query) {
  if (!_enabled) return [];
  const p = PROVIDERS[provider];
  if (!p) throw new Error('未知字幕站点：' + provider);
  if (!query || !query.trim()) return [];
  const html = await fetchHtml(p.searchUrl(query.trim()));
  return p.parseSearch(html);
}

/** 下载某站点字幕，返回 { content, fileName }（content 为字幕文本）。 */
async function scrapeDownload(provider, detailUrl, lang) {
  if (!_enabled) return null;
  const p = PROVIDERS[provider];
  if (!p) throw new Error('未知字幕站点：' + provider);
  const buf = await p.resolveDownload(detailUrl);
  const files = await decodeArchiveBuffer(buf, String(detailUrl).split('/').pop());
  if (!files.length) throw new Error('归档中未找到字幕文件');
  // 选最优：优先匹配请求语言
  let chosen = files[0];
  if (lang) {
    const wantZh = String(lang).toLowerCase().startsWith('zh');
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (wantZh && /(chs|cht|chinese|中文|简|繁|gb|big5)/.test(n)) { chosen = f; break; }
      if (!wantZh && /(eng|english|\.en)/.test(n)) { chosen = f; break; }
    }
  }
  const ext = (chosen.name.match(/\.[^.]+$/) || ['.srt'])[0];
  const base = chosen.name.replace(/\.[^.]+$/, '') || 'sub';
  return { content: chosen.content, fileName: base + ext };
}

module.exports = {
  scrapeSearch,
  scrapeDownload,
  setEnabled,
  isEnabled,
  decodeArchiveBuffer,
  PROVIDERS,
};
