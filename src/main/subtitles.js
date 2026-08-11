'use strict';
/**
 * 在线字幕客户端（仅主进程使用）。
 *
 * 支持源：
 *  - OpenSubtitles v1：需 Api-Key（搜索），下载需登录。
 *  - 射手网 (Shooter)：无需配置，按文件 hash + 文件名匹配，适合中文片源。
 *  - 字幕网抓取（字幕库 zimuku / SubHD 字幕组）：无需配置，按关键词抓取，归由
 *    subtitle-scrapers.js 处理（HTML 解析 + zip/rar 解压）。
 *
 * 设计要点：
 *  - OpenSubtitles 搜索（GET /subtitles）只需 Api-Key，无需登录。
 *  - OpenSubtitles 下载（POST /download）需要 Bearer token，因此本模块按用户凭据
 *    做一次 /login，缓存 token 直到过期/进程退出。
 *  - OpenSubtitles 下载返回的 link 是临时直链（先 gzip 再 7z 套壳），用 Electron 内置
 *    能力解 gzip（Node zlib）；外层 7z 容器若命中则提示用内置解不了。
 *  - Shooter 使用文件 hash 搜索，直链下载，无需 API Key / 登录。
 *  - 解析 SRT 的逻辑集中在此，避免两份实现漂移。
 *
 * 凭据来源：config 的 opensubtitles-key / opensubtitles-user / opensubtitles-pass。
 * 未配置 OpenSubtitles 时，Shooter 仍可作为无配置源使用。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app } = require('electron');
const filenameParser = require('./filename-parser');
const scrapers = require('./subtitle-scrapers');

const BASE = 'https://api.opensubtitles.com/api/v1';
const SHOOTER_BASE = 'http://www.shooter.cn/api/subapi.php';
const UA = 'LumoraPlayer/1.0';

// 射手网语言代码映射（OpenSubtitles 风格 -> Shooter）
const SHOOTER_LANG_MAP = {
  zh: 'Chn', cmn: 'Chn', chi: 'Chn', zho: 'Chn',
  en: 'Eng', eng: 'Eng',
};

let _apiKey = '';
let _user = '';
let _pass = '';
let _token = null;
let _cacheDir = null;
let _proxyUrl = '';   // 字幕代理（OpenSubtitles 兼容聚合器）：填了之后搜索同时查官方与代理

function configure({ apiKey, user, pass, proxyUrl } = {}) {
  if (apiKey !== undefined) _apiKey = apiKey || '';
  if (user !== undefined) _user = user || '';
  if (pass !== undefined) _pass = pass || '';
  if (proxyUrl !== undefined) _proxyUrl = (proxyUrl || '').replace(/\/+$/, '');
}

function setCacheDir(dir) {
  _cacheDir = dir;
  if (_cacheDir) fs.mkdirSync(_cacheDir, { recursive: true });
}

function _headers(extra) {
  const h = {
    'Api-Key': _apiKey,
    'User-Agent': UA,
    'Accept': 'application/json',
  };
  if (_token) h['Authorization'] = 'Bearer ' + _token;
  return Object.assign(h, extra || {});
}

async function _fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 体 */ }
  if (!res.ok) {
    const msg = (data && (data.message || (data.errors && JSON.stringify(data.errors)))) || text || ('HTTP ' + res.status);
    const err = new Error('OpenSubtitles ' + res.status + ': ' + msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 登录拿 Bearer token；凭据缺失时抛明确错误 */
async function login() {
  if (_token) return _token;
  if (!_apiKey) throw new Error('未配置 OpenSubtitles API Key（设置 → 字幕 → API Key）');
  if (!_user || !_pass) throw new Error('下载字幕需要登录 OpenSubtitles（设置里填入用户名/密码）');
  const data = await _fetchJson(BASE + '/login', {
    method: 'POST',
    headers: _headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ username: _user, password: _pass }),
  });
  _token = data && data.token;
  if (!_token) throw new Error('OpenSubtitles 登录失败：响应中无 token');
  return _token;
}

function normalizeLang(code) {
  if (!code) return '';
  const c = String(code).toLowerCase();
  if (c === 'zh' || c === 'chi' || c === 'zho' || c === 'cmn') return 'zh';
  return c;
}

/**
 * 对单个 OpenSubtitles 兼容端点（官方或代理）执行搜索，归一化为统一行结构。
 * @param {string} base 端点基址（官方 BASE 或代理 _proxyUrl）
 * @param {object} opts 见 search()
 * @param {boolean} useApiKey 是否带 Api-Key 头（代理可不带）
 * @param {string} tag 来源标识，写入每行 source
 * @returns {Array<{...source,base}>}
 */
async function _searchBase(base, opts, useApiKey, tag) {
  const params = new URLSearchParams();
  // 文档建议参数按字母序小写，利于缓存
  if (opts.query) params.set('query', String(opts.query).toLowerCase());
  if (opts.imdbId) params.set('imdb_id', String(opts.imdbId).replace(/^tt/, '').replace(/^0+/, ''));
  if (opts.moviehash) params.set('moviehash', opts.moviehash);
  const langs = (opts.languages || []).map(normalizeLang).filter(Boolean);
  if (langs.length) params.set('languages', langs.join(','));
  params.set('order_by', 'download_count');
  params.set('per_page', '50');

  const headers = useApiKey ? _headers() : { 'User-Agent': UA, 'Accept': 'application/json' };
  const data = await _fetchJson(base + '/subtitles?' + params.toString(), { headers });
  const slang = (opts.slang || []).map(normalizeLang);
  return (data && data.data || []).map((d) => {
    const a = d.attributes || {};
    const file = (a.files && a.files[0]) || {};
    const lang = normalizeLang(a.language);
    return {
      id: d.id,
      fileId: file.file_id,
      name: file.file_name || (a.feature_details && a.feature_details.title) || ('sub-' + d.id),
      lang,
      langName: a.language_name || a.language || '',
      downloads: a.download_count || 0,
      release: (a.release || '').toString(),
      hearingImpaired: !!a.hearing_impaired,
      source: tag,
      base,
      // 命中首选语言则加权，便于"自动匹配"挑中文
      score: (slang.includes(lang) ? 1e7 : 0) + (a.download_count || 0),
    };
  });
}

/**
 * 搜索字幕（多源：OpenSubtitles / 代理 / 射手网，结果合并去重后按 score 降序）。
 * @param {object} opts
 *  - query: 关键词（片名或文件名）
 *  - languages: 语言代码数组，如 ['zh','en']
 *  - moviehash: 16 位 hex（可选，配合 query 提升准确率）
 *  - imdbId: 数字（可选）
 *  - slang: 首选语言（加权用）
 *  - filePath: 本地文件路径（射手网需要，用于计算 hash）
 * @returns {Array<{id,fileId,name,lang,langName,downloads,release,score,source,base}>}
 */
async function search(opts = {}) {
  const bases = [];
  if (_apiKey) bases.push({ base: BASE, useApiKey: true, tag: 'opensubtitles' });
  if (_proxyUrl) bases.push({ base: _proxyUrl, useApiKey: !!_apiKey, tag: 'proxy' });

  const canUseShooter = opts.filePath && fs.existsSync(opts.filePath);
  const hasConfiguredSource = bases.length > 0;
  if (!hasConfiguredSource && !canUseShooter) {
    throw new Error('未配置字幕来源（设置 → 字幕 → API Key 或字幕代理地址），且未提供可用于射手网 hash 匹配的本地文件');
  }

  const all = [];
  const errors = [];

  for (const b of bases) {
    try {
      const rows = await _searchBase(b.base, opts, b.useApiKey, b.tag);
      all.push(...rows);
    } catch (e) {
      errors.push((b.tag === 'proxy' ? '代理: ' : 'OpenSubtitles: ') + e.message);
    }
  }

  if (canUseShooter) {
    try {
      const rows = await _searchShooter(opts.filePath, opts.languages || [], opts.slang || []);
      all.push(...rows);
    } catch (e) {
      errors.push('射手网: ' + e.message);
    }
  }

  // 字幕网抓取（无配置源）：仅有关键词时尝试，各站点独立并行、各自容错
  if (opts.query && opts.query.trim()) {
    const SCRAPER_PROVIDERS = ['zimuku', 'subhd'];
    const slangNorm = (opts.slang || []).map(normalizeLang);
    const tasks = SCRAPER_PROVIDERS.map((prov) =>
      scrapers.scrapeSearch(prov, opts.query)
        .then((rows) => rows.map((r) => {
          const lang = normalizeLang(r.lang);
          return {
            id: prov + ':' + r.detailUrl,
            fileId: r.detailUrl,
            name: r.name,
            lang,
            langName: r.langName || r.lang || '',
            downloads: r.downloads || 0,
            release: r.release || '',
            hearingImpaired: false,
            source: prov,
            base: prov,
            score: (slangNorm.includes(lang) ? 1e7 : 0) + (r.downloads || 0),
          };
        }))
        .catch((e) => { errors.push((prov === 'zimuku' ? '字幕库: ' : 'SubHD: ') + e.message); return []; })
    );
    const scraperResults = await Promise.all(tasks);
    for (const rows of scraperResults) all.push(...rows);
  }

  if (!all.length) throw new Error(errors.length ? errors.join('；') : '未找到字幕');
  // 先按 score 降序，再按 name+lang 去重（保留最高票者）
  all.sort((x, y) => y.score - x.score);
  const seen = new Map();
  const merged = [];
  for (const r of all) {
    const k = (r.name || '') + '|' + r.lang;
    if (seen.has(k)) continue;
    seen.set(k, true);
    merged.push(r);
  }
  return merged;
}

// 构造 multipart/form-data 请求体（Node 原生，不依赖第三方包）
function _multipartBody(fields) {
  const boundary = '----LumoraFormBoundary' + Math.random().toString(36).slice(2);
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 射手网搜索：按文件 hash + 文件名匹配，无需 API Key。 */
async function _searchShooter(filePath, languages, slang) {
  const hash = computeMovieHash(filePath);
  if (!hash) throw new Error('无法计算文件 hash');
  const fileName = path.basename(filePath);

  // 按请求的语言决定查什么；默认中文
  const langCodes = new Set();
  for (const l of languages) {
    const c = normalizeLang(l);
    const mapped = SHOOTER_LANG_MAP[c];
    if (mapped) langCodes.add(mapped);
  }
  if (!langCodes.size) langCodes.add('Chn');

  const slangNorm = slang.map(normalizeLang);
  const all = [];

  for (const lang of langCodes) {
    const { body, contentType } = _multipartBody({
      filehash: hash,
      pathinfo: fileName,
      format: 'json',
      lang,
    });
    const res = await fetch(SHOOTER_BASE, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': contentType },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!text || text.trim() === '') continue; // 无结果返回空体
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('响应不是有效 JSON'); }
    // 射手网返回 [[{subtitle}], [{subtitle}]] 结构
    const groups = Array.isArray(data) ? data : [data];
    for (const group of groups) {
      const subs = Array.isArray(group) ? group : [group];
      for (const s of subs) {
        if (!s || !s.Files || !s.Files.length) continue;
        const file = s.Files[0];
        const ext = (file.Ext || 'srt').toLowerCase();
        const langCode = lang === 'Chn' ? 'zh' : (lang === 'Eng' ? 'en' : 'zh');
        const name = `${path.basename(fileName, path.extname(fileName))}.${ext}`;
        const link = file.Link;
        if (!link) continue;
        all.push({
          id: 'shooter-' + (s.Id || Math.random().toString(36).slice(2)),
          fileId: 'shooter:' + link,
          name,
          lang: langCode,
          langName: langCode === 'zh' ? 'Chinese' : 'English',
          downloads: 0,
          release: s.Desc || '',
          hearingImpaired: false,
          source: 'shooter',
          base: 'shooter',
          score: (slangNorm.includes(lang) ? 1e7 : 0),
        });
      }
    }
  }
  return all;
}

/** 射手网下载：fileId 格式为 "shooter:<url>"，直接 GET 直链。 */
async function _downloadShooter(fileId, cacheKey) {
  const link = fileId.startsWith('shooter:') ? fileId.slice(8) : fileId;
  if (!link) throw new Error('射手网字幕链接为空');
  const res = await fetch(link, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('下载字幕失败：HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = decodeSubtitleBuffer(buf, 'sub.srt');

  let cachePath = null;
  if (_cacheDir) {
    const safe = (cacheKey || 'shooter-sub').replace(/[^a-zA-Z0-9_-]/g, '_');
    cachePath = path.join(_cacheDir, safe + '.srt');
    try { fs.writeFileSync(cachePath, text, 'utf8'); } catch { cachePath = null; }
  }
  return { path: cachePath, cues: parseSrt(text), fileId, name: path.basename(cacheKey || 'shooter-sub') + '.srt' };
}

/** 字幕网下载：fileId 即详情页 URL；由 scraper 框架解析下载链接并解归档。 */
async function _downloadScraper(provider, detailUrl, cacheKey, lang) {
  const d = await scrapers.scrapeDownload(provider, detailUrl, lang);
  if (!d) throw new Error('字幕网下载失败');
  const text = d.content;

  let cachePath = null;
  if (_cacheDir) {
    const ext = (d.fileName.match(/\.[^.]+$/) || ['.srt'])[0];
    const safe = (cacheKey || String(detailUrl)).replace(/[^a-zA-Z0-9_-]/g, '_');
    cachePath = path.join(_cacheDir, safe + ext);
    try { fs.writeFileSync(cachePath, text, 'utf8'); } catch { cachePath = null; }
  }
  return { path: cachePath, cues: parseSrt(text), fileId: detailUrl, name: d.fileName };
}

/**
 * 按当前文件路径猜测搜索用的片名（清洗常见 release 标记）。
 * 委托给 filename-parser（单一真相源，字幕与弹幕共用同一解析逻辑）。
 */
function guessTitle(filePath) {
  return filenameParser.guessTitle(filePath);
}

/** 字幕自动匹配专用查询：优先带「第N话」的同季集数，提升命中率 */
function guessSearchQueryForSubtitle(filePath) {
  return filenameParser.searchQuery(filenameParser.parseFilename(filePath), { withEpisode: true });
}

/**
 * 下载字幕到缓存目录，返回 { path, cues, fileId, name }。
 * OpenSubtitles 需要登录；射手网无需配置，直接下载直链。
 */
async function download(fileId, cacheKey, base, lang) {
  if (base === 'shooter' || String(fileId).startsWith('shooter:')) {
    return _downloadShooter(fileId, cacheKey);
  }
  if (base === 'zimuku' || base === 'subhd') {
    return _downloadScraper(base, fileId, cacheKey, lang);
  }
  const useBase = base || BASE;
  // 仅官方端点需要 /login 拿 token；代理通常靠 Api-Key 头或无需登录
  if (useBase === BASE) await login();
  const data = await _fetchJson(useBase + '/download', {
    method: 'POST',
    headers: _headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ file_id: fileId }),
  });
  const link = data && data.link;
  if (!link) throw new Error('OpenSubtitles 下载响应缺少 link（可能超出当日配额）');
  const fileName = data.file_name || ('sub-' + fileId + '.srt');

  const res = await fetch(link, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('下载字幕文件失败：HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());

  const text = decodeSubtitleBuffer(buf, fileName);

  // 缓存到磁盘，便于下次直接加载（无需再联网）
  let cachePath = null;
  if (_cacheDir) {
    const safe = (cacheKey || String(fileId)).replace(/[^a-zA-Z0-9_-]/g, '_');
    cachePath = path.join(_cacheDir, safe + '.srt');
    try { fs.writeFileSync(cachePath, text, 'utf8'); } catch { cachePath = null; }
  }

  return { path: cachePath, cues: parseSrt(text), fileId, name: fileName };
}

/**
 * 解码头缓冲：OpenSubtitles 直链多为 gzip 单流；
 * 若外层是 7z 容器则 zlib 解不出，给出明确错误。
 */
function decodeSubtitleBuffer(buf, fileName) {
  // 先试 gzip
  try {
    const out = zlib.gunzipSync(buf);
    // gzip 解出的若是压缩包（7z 等）再识别
    if (out.length && isLikelyText(out)) return out.toString('utf8');
  } catch { /* 不是 gzip，继续 */ }

  // 已解密文？
  if (isLikelyText(buf)) return buf.toString('utf8');

  // 7z 容器（OpenSubtitles 的 gzip→7z 双层）无法用 Node 原生解，明确报错
  if (buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc) {
    throw new Error('该字幕为 7z 压缩包，内置解压不支持，请在设置里改用「下载后手动解压」或选择其它字幕');
  }
  // 也可能是 .gz 但 gunzip 失败，或未知编码
  throw new Error('字幕文件解压失败：未知格式（期望 .srt/.gz）');
}

function isLikelyText(buf) {
  // 采样前若干字节判断是否像文本（出现 NUL 多半是二进制）
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return false;
  }
  return true;
}

/** 解析 SRT 文本为 [{ start, end, text }]（单位：秒）。
 *  与 index.js 旧实现行为一致，但集中在此处维护。 */
function parseSrt(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length);
    if (lines.length < 2) continue;
    let timeLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/-->/.test(lines[i])) { timeLine = i; break; }
    }
    if (timeLine < 0) continue;
    const m = lines[timeLine].match(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
    );
    if (!m) continue;
    const toSec = (h, mi, s, ms) => (+h) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    const txt = lines.slice(timeLine + 1).join('\n');
    const clean = txt.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (clean) cues.push({ start, end, text: clean });
  }
  return cues;
}

/** 计算 moviehash（64-bit，OpenSubtitles / 射手网通用）。 */
function computeMovieHash(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = BigInt(stat.size);
    if (size < 8n) return null;
    const fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.alloc(65536);
    let hash = size;
    // 头部 64KB
    fs.readSync(fd, chunk, 0, 65536, 0);
    for (let i = 0; i < 65536; i += 8) hash += readU64(chunk, i);
    // 尾部 64KB
    fs.readSync(fd, chunk, 0, 65536, Number(size) - 65536);
    for (let i = 0; i < 65536; i += 8) hash += readU64(chunk, i);
    fs.closeSync(fd);
    // 取低 64 位并格式化为 16 位 hex
    const u64 = hash & ((1n << 64n) - 1n);
    return u64.toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

function readU64(buf, off) {
  const lo = BigInt(buf.readUInt32LE(off));
  const hi = BigInt(buf.readUInt32LE(off + 4));
  return (hi << 32n) | lo;
}

module.exports = {
  configure,
  setCacheDir,
  login,
  search,
  download,
  guessTitle,
  guessSearchQueryForSubtitle,
  parseSrt,
  computeMovieHash,
  _filenameParser: filenameParser,
};
