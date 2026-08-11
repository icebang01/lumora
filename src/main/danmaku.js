'use strict';
/**
 * 弹幕客户端（仅主进程使用）。
 *
 * 目标：把本地视频文件匹配到弹幕并解析为统一格式
 *   { time, mode, color, text }
 *   - time: 出现秒数
 *   - mode: 1=滚动 4=底部 5=顶部 6=逆向 7=高级(定位) 8=代码(忽略)
 *   - color: 0xRRGGBB
 *   - text: 弹幕文本
 *
 * 数据源（弹弹play 需 AppId；B 站 零配置；聚合代理可选）：
 *  1) DandanPlay 弹弹play开放弹幕网络（文件名/hash 自动匹配最强，本地播放器事实标准）
 *     - 公开接口 https://api.dandanplay.net；调用需 AppId/AppSecret 签名。
 *     - AppId/AppSecret 来自 config 的 dandanplay-id/secret（开发者中心 DevCenter 免费申请）。
 *     - 签名 = base64(sha256(AppId+ts+path+secret))
 *  2) Bilibili 原生（最大弹幕池，零配置）：关键词搜 av/bv → view 取 cid → dm/list.so 取 XML
 *     - 仅靠 WBI 签名即可，无需任何 key；bilibili-cookie 仅用于提升配额（留空也工作）。
 *  3) danmu_api 代理（cirnot9，可自托管）：兼容 DandanPlay 接口规范，
 *     后端聚合 爱优腾芒哔人韩巴 + 弹弹，是"接所有能接的"的总开关。
 *     - 通过配置 danmaku-proxy-url 启用（留空则不走代理）。
 *
 * 凭据来源：config 的 dandanplay-id / dandanplay-secret / danmaku-proxy-url / bilibili-cookie。
 */

const crypto = require('crypto');
const filenameParser = require('./filename-parser');

const DD_BASE = 'https://api.dandanplay.net';
const BILI_BASE = 'https://api.bilibili.com';

let _cfg = { dandanplayId: '', dandanplaySecret: '', proxyUrl: '', biliCookie: '' };

function configure({ dandanplayId, dandanplaySecret, proxyUrl, biliCookie } = {}) {
  if (dandanplayId !== undefined) _cfg.dandanplayId = dandanplayId || '';
  if (dandanplaySecret !== undefined) _cfg.dandanplaySecret = dandanplaySecret || '';
  if (proxyUrl !== undefined) _cfg.proxyUrl = (proxyUrl || '').replace(/\/+$/, '');
  if (biliCookie !== undefined) _cfg.biliCookie = biliCookie || '';
}

function _ddHeaders(path) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash('sha256')
    .update(_cfg.dandanplayId + ts + path + _cfg.dandanplaySecret)
    .digest('base64');
  return { 'X-AppId': _cfg.dandanplayId, 'X-Timestamp': String(ts), 'X-Signature': sig };
}

async function _getJson(url, headers) {
  const res = await fetch(url, { headers: Object.assign({ 'Accept': 'application/json' }, headers || {}) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (data && (data.errorMessage || data.message)) || text || ('HTTP ' + res.status);
    const err = new Error('弹幕请求 ' + res.status + ': ' + msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ===================== DandanPlay / 代理（兼容接口） ===================== */

/**
 * 文件名/hash 自动匹配：POST /api/v2/match
 * @returns {Array<{episodeId, animeTitle, episodeTitle, confidence}>}
 */
async function dandanMatch(filePath, fileHash, fileSize) {
  const base = _cfg.proxyUrl || DD_BASE;
  const path = '/api/v2/match';
  const body = {
    fileName: filePath ? require('path').basename(filePath) : '',
    fileHash: fileHash || '',
    fileSize: fileSize || 0,
    matchMode: 'hashAndFileName',
  };
  const headers = _cfg.proxyUrl
    ? { 'Content-Type': 'application/json' }
    : _ddHeaders(path);
  const res = await fetch(base + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(body),
  });
  const data = await res.text();
  let json; try { json = JSON.parse(data); } catch {
    // 返回非 JSON：通常是应用审核中(403) / 凭据错误 / API 变更
    console.error('[lumen][danmaku] 弹弹 match 返回非 JSON, status:', res.status,
      ', contentType:', res.headers.get('content-type'),
      ', body 前200字符:', data.slice(0, 200));
    if (res.status === 403) {
      throw new Error('弹弹 API 返回 403：应用可能还在审核中（去 dandanplay.net 开发者中心确认状态），审核通过前该源不可用，可先用 B 站弹幕。');
    }
    throw new Error('弹弹匹配失败（HTTP ' + res.status + '）：API 返回非 JSON。');
  }
  if (!res.ok || json.errorCode !== 0) {
    throw new Error('弹弹匹配失败：' + (json && json.errorMessage || ('HTTP ' + res.status)));
  }
  const matches = (json.matches || []).map((m) => ({
    episodeId: m.episodeId,
    animeTitle: (m.anime && m.anime.title) || '',
    episodeTitle: (m.episode && m.episode.title) || '',
    confidence: m.confidence || 0,
  }));
  return matches;
}

/**
 * 关键词搜索番剧：GET /api/v2/search/anime?keyword=
 */
async function dandanSearch(keyword) {
  const base = _cfg.proxyUrl || DD_BASE;
  const path = '/api/v2/search/anime?keyword=' + encodeURIComponent(keyword);
  const headers = _cfg.proxyUrl ? {} : _ddHeaders(path);
  const res = await fetch(base + path, { headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    console.error('[lumen][danmaku] 弹弹 search 返回非 JSON, status:', res.status,
      ', body 前200字符:', text.slice(0, 200));
    if (res.status === 403) {
      throw new Error('弹弹 API 返回 403：应用可能还在审核中（去 dandanplay.net 开发者中心确认状态），审核通过前该源不可用，可先用 B 站弹幕。');
    }
    throw new Error('弹弹搜索失败（HTTP ' + res.status + '）：API 返回非 JSON。');
  }
  if (!data || data.errorCode !== 0) throw new Error('弹弹搜索失败：' + (data && data.errorMessage || 'unknown'));
  return (data.animes || []).map((a) => ({
    animeId: a.animeId,
    title: a.animeTitle,
    type: a.type,
    year: a.year,
    episodes: a.episodeCount,
  }));
}

/**
 * 取某番剧分集：GET /api/v2/bangumi/{animeId}
 */
async function dandanBangumi(animeId) {
  const base = _cfg.proxyUrl || DD_BASE;
  const path = '/api/v2/bangumi/' + animeId;
  const headers = _cfg.proxyUrl ? {} : _ddHeaders(path);
  const data = await _getJson(base + path, headers);
  if (!data || data.errorCode !== 0) throw new Error('弹弹详情失败：' + (data && data.errorMessage || 'unknown'));
  const b = data.bangumi || {};
  return {
    animeId,
    title: b.animeTitle,
    episodes: (b.episodes || []).map((e) => ({
      episodeId: e.episodeId,
      index: e.episodeNumber,
      title: e.episodeTitle,
    })),
  };
}

/**
 * 取弹幕：GET /api/v2/comment/{episodeId}
 * DandanPlay 弹幕为 JSON，字段：time, type(1/4/5/6/7/8...), color, comment
 */
async function dandanComments(episodeId, withRelated) {
  const base = _cfg.proxyUrl || DD_BASE;
  const path = '/api/v2/comment/' + episodeId + (withRelated ? '?withRelated=true' : '');
  const headers = _cfg.proxyUrl ? {} : _ddHeaders(path);
  const data = await _getJson(base + path, headers);
  if (!data || data.errorCode !== 0) throw new Error('弹弹弹幕失败：' + (data && data.errorMessage || 'unknown'));
  const comments = (data.comments || []).map((c) => ({
    time: c.time,
    mode: c.type,
    color: c.color !== undefined ? c.color : 0xffffff,
    text: c.comment,
  }));
  return { count: data.count || comments.length, comments };
}

/* ===================== Bilibili 原生 ===================== */

// WBI 签名：img_key+sub_key 经固定混淆表打乱后，对 query 排序加 wbi_sign
const WBI_MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

function _mixinKey(orig) {
  return WBI_MIXIN.map((i) => orig[i]).join('').slice(0, 32);
}

async function _biliNavKeys() {
  // 从 nav 接口拿 wbi_img/wbi_sub（带 Cookie 更稳定）
  const headers = _cfg.biliCookie ? { 'Cookie': _cfg.biliCookie, 'User-Agent': 'Mozilla/5.0' } : { 'User-Agent': 'Mozilla/5.0' };
  const data = await _getJson(BILI_BASE + '/x/web-interface/nav', headers);
  const wbi = data && data.data && data.data.wbi_img;
  if (!wbi) throw new Error('获取 B 站 WBI 密钥失败');
  const img = (wbi.img_url || '').split('/').pop().split('.')[0];
  const sub = (wbi.sub_url || '').split('/').pop().split('.')[0];
  return _mixinKey(img + sub);
}

async function biliSearch(keyword) {
  const mixin = await _biliNavKeys();
  const params = new URLSearchParams({ keyword, __refresh__: 'true' });
  params.set('wts', String(Math.floor(Date.now() / 1000)));
  // 排序后加 mixin key 做 md5
  const keys = [...params.keys()].sort();
  const signed = keys.map((k) => `${k}=${params.get(k)}`).join('&') + mixin;
  const wbiSign = crypto.createHash('md5').update(signed).digest('hex');
  params.set('w_rid', wbiSign);
  const headers = _cfg.biliCookie ? { 'Cookie': _cfg.biliCookie, 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://search.bilibili.com' } : { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://search.bilibili.com' };
  const data = await _getJson(BILI_BASE + '/x/web-interface/wbi/search/all/v2?' + params.toString(), headers);
  const results = [];
  const blocks = (data && data.data && data.data.result) || [];
  for (const blk of blocks) {
    if (blk.result_type !== 'media_bangumi' && blk.result_type !== 'video') continue;
    for (const item of (blk.data || [])) {
      if (blk.result_type === 'media_bangumi') {
        results.push({ source: 'bilibili', type: 'bangumi', id: item.season_id, title: item.title.replace(/<[^>]*>/g, ''), url: item.url });
      } else if (item.bvid) {
        results.push({ source: 'bilibili', type: 'video', id: item.bvid, title: item.title.replace(/<[^>]*>/g, ''), url: 'https://www.bilibili.com/video/' + item.bvid });
      }
    }
  }
  if (!results.length) throw new Error('B 站未搜到结果');
  return results;
}

async function biliGetCid(bvid) {
  const headers = _cfg.biliCookie ? { 'Cookie': _cfg.biliCookie, 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' } : { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' };
  const data = await _getJson(BILI_BASE + '/x/web-interface/view?bvid=' + encodeURIComponent(bvid), headers);
  const v = data && data.data;
  if (!v || !v.cid) throw new Error('B 站获取 cid 失败');
  return { cid: v.cid, title: v.title, bvid };
}

/**
 * B 站番剧：season_id → 分集 cid。
 * 自动匹配 / 关键词搜索得到的番剧源只有 season_id（无 cid），
 * 加载弹幕时在此补解析。episodeHint 为文件名解析出的集数（可选），
 * 命中则返回该集的 cid，否则取首集。
 */
async function biliBangumiCid(seasonId, episodeHint) {
  const headers = _cfg.biliCookie
    ? { 'Cookie': _cfg.biliCookie, 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' }
    : { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' };
  const data = await _getJson(BILI_BASE + '/pgc/view/web/season?season_id=' + encodeURIComponent(seasonId), headers);
  if (data && data.code != null && data.code !== 0) throw new Error('B 站番剧详情失败：' + (data.message || data.code));
  const season = data && data.data;
  const eps = (season && season.episodes) || [];
  if (!eps.length) throw new Error('B 站番剧无分集信息');
  let picked = eps;
  if (episodeHint != null) {
    const h = String(episodeHint);
    const hit = eps.find((e) =>
      String(e.index) === h ||
      (e.index_title && e.index_title.indexOf(h) >= 0) ||
      (e.title && e.title.indexOf(h) >= 0) ||
      (e.long_title && e.long_title.indexOf(h) >= 0));
    if (hit) picked = [hit];
  }
  const ep = picked[0];
  if (!ep || !ep.cid) throw new Error('B 站番剧分集缺少 cid');
  return {
    cid: ep.cid,
    epId: ep.id,
    episodeTitle: ep.long_title || ep.index_title || ep.title,
    seasonTitle: (season && (season.title || (season.info && season.info.title))) || '',
  };
}

async function biliGetDanmaku(cid) {
  const headers = _cfg.biliCookie ? { 'Cookie': _cfg.biliCookie, 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' } : { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' };
  const res = await fetch(BILI_BASE + '/x/v1/dm/list.so?oid=' + cid, { headers });
  if (!res.ok) throw new Error('B 站弹幕 HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  // list.so 是 UTF-8 XML（有时带压缩，先试解 gzip）
  let xml = '';
  try { xml = zlibGunzipSafe(buf).toString('utf8'); } catch { xml = buf.toString('utf8'); }
  return parseBiliXml(xml);
}

function zlibGunzipSafe(buf) {
  const zlib = require('zlib');
  try { return zlib.gunzipSync(buf); } catch { return buf; }
}

/** 解析 B 站 list.so XML：<d p="time,mode,fontsize,color,timestamp,pool,userhash,dmid">text</d> */
function parseBiliXml(xml) {
  const comments = [];
  const re = /<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1].split(',');
    const time = parseFloat(attrs[0]);
    const mode = parseInt(attrs[1], 10);
    const color = parseInt(attrs[3], 10) || 0xffffff;
    let text = m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
    if (isNaN(time) || !text) continue;
    comments.push({ time, mode, color, text });
  }
  return { count: comments.length, comments };
}

/* ===================== 统一入口 ===================== */

/**
 * 自动匹配：先用 DandanPlay/proxy 按文件名+hash 匹配，失败则按文件名猜番名关键词
 * 在 B 站搜。返回候选弹幕源列表（已含每条的 source 标识）。
 */
async function autoMatch(filePath, fileHash, fileSize) {
  const out = { sources: [], errors: [] };
  // 1) DandanPlay / 代理（文件名匹配，最准）
  if (_cfg.proxyUrl || (_cfg.dandanplayId && _cfg.dandanplaySecret)) {
    try {
      const matches = await dandanMatch(filePath, fileHash, fileSize);
      for (const mt of matches) {
        out.sources.push({
          source: _cfg.proxyUrl ? 'proxy' : 'dandanplay',
          episodeId: mt.episodeId,
          title: (mt.animeTitle ? mt.animeTitle + ' ' : '') + mt.episodeTitle,
          confidence: mt.confidence,
        });
      }
    } catch (e) { out.errors.push('弹弹: ' + e.message); }
  }
  // 2) B 站：按清洗后的文件名 + 集数搜（兜底，提升命中）
  try {
    const guess = guessSearchQuery(filePath);
    const ep = (filenameParser.parseFilename(filePath) || {}).episode;
    if (guess) {
      const bili = await biliSearch(guess);
      for (const r of bili) out.sources.push({
        source: 'bilibili',
        type: r.type,
        id: r.id,
        // 番剧源只有 season_id，加载时按集数提示补解析 cid
        episode: r.type === 'bangumi' ? ep : undefined,
        title: r.title,
        url: r.url,
      });
    }
  } catch (e) { out.errors.push('B站: ' + e.message); }
  return out;
}

/**
 * 关键词搜索（用户手动）：同时查 DandanPlay 与 B 站。
 */
async function search(keyword) {
  const out = { sources: [], errors: [] };
  if (_cfg.proxyUrl || (_cfg.dandanplayId && _cfg.dandanplaySecret)) {
    try {
      const animes = await dandanSearch(keyword);
      for (const a of animes) out.sources.push({ source: _cfg.proxyUrl ? 'proxy' : 'dandanplay', animeId: a.animeId, title: a.title, year: a.year, episodes: a.episodes });
    } catch (e) { out.errors.push('弹弹: ' + e.message); }
  }
  try {
    const bili = await biliSearch(keyword);
    for (const r of bili) out.sources.push({ source: 'bilibili', type: r.type, id: r.id, title: r.title, url: r.url });
  } catch (e) { out.errors.push('B站: ' + e.message); }
  return out;
}

/**
 * 加载弹幕：根据 source 类型拉取并解析。
 *  - dandanplay/proxy: 直接 comments
 *  - bilibili bangumi: 需先拿 cid（season→ep）→ dm
 *  - bilibili video:  bvid → view 拿 cid → dm
 * @returns {{count, comments:[{time,mode,color,text}]}}
 */
async function load(source) {
  if (source.source === 'dandanplay' || source.source === 'proxy') {
    const r = await dandanComments(source.episodeId, true);
    return r;
  }
  if (source.source === 'bilibili') {
    let cid = source.cid;
    if (!cid) {
      if (source.type === 'bangumi' && source.id) {
        // 番剧源常只有 season_id，无 cid：按集数补解析
        const b = await biliBangumiCid(source.id, source.episode);
        cid = b.cid;
      } else if (source.type === 'video' && source.id) {
        const v = await biliGetCid(source.id);
        cid = v.cid;
      } else if (source.bvid) {
        const v = await biliGetCid(source.bvid);
        cid = v.cid;
      }
    }
    if (!cid) throw new Error('B 站弹幕缺少 cid（该视频/番剧无法解析弹幕）');
    return await biliGetDanmaku(cid);
  }
  throw new Error('未知弹幕源: ' + source.source);
}

/** 文件名清洗（委托共享解析器，单一真相源） */
function guessTitle(filePath) {
  return filenameParser.guessTitle(filePath);
}

/** 弹幕兜底搜索专用：标题 + 「第N话」更精准 */
function guessSearchQuery(filePath) {
  return filenameParser.searchQuery(filenameParser.parseFilename(filePath), { withEpisode: true });
}

module.exports = {
  configure,
  autoMatch,
  search,
  load,
  dandanMatch,
  dandanSearch,
  dandanBangumi,
  biliSearch,
  biliGetCid,
  biliBangumiCid,
  guessTitle,
};
