'use strict';
/**
 * 歌词加载与解析。
 *
 * 目前支持同目录下的 .lrc 外挂歌词：
 *   歌曲.mp3  →  歌曲.lrc
 * 解析后按时间排序返回，渲染端根据当前播放时间高亮对应行。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const iconv = require('iconv-lite');

/* ================= 繁→简转换（opencc-js，纯 JS 无原生模块） ================= */

let _simplifiedConverter = undefined; // undefined=未探测；null=不可用；否则为转换函数

/**
 * 把文本中的繁体中文转为简体。opencc-js 仅在首次调用时懒加载，
 * 任意异常都安全降级为原样返回（不影响歌词正常显示）。
 * @param {string} text
 * @returns {string}
 */
function toSimplified(text) {
  if (typeof text !== 'string' || !text) return text;
  if (_simplifiedConverter === undefined) {
    try {
      const OpenCC = require('opencc-js');
      _simplifiedConverter = OpenCC.Converter({ from: 'tw', to: 'cn' });
    } catch {
      _simplifiedConverter = null;
    }
  }
  if (!_simplifiedConverter) return text;
  try { return _simplifiedConverter(text); } catch { return text; }
}

/**
 * 按字节内容自动识别常见歌词文件编码（UTF-8 / GBK / Big5）。
 * 先尝试 UTF-8；若出现 U+FFFD 替换符则依次回退 GBK、Big5。
 * 返回的文本会去掉 BOM（若有）。
 */
function readTextAutoEncode(filePath) {
  const buf = fs.readFileSync(filePath);
  const candidates = ['utf-8', 'gbk', 'big5'];
  for (const enc of candidates) {
    try {
      const text = iconv.decode(buf, enc);
      if (!text.includes('\uFFFD')) {
        // 去掉 BOM
        if (text.charCodeAt(0) === 0xFEFF) return text.slice(1);
        return text;
      }
    } catch { /* 继续尝试下一编码 */ }
  }
  // 兜底：UTF-8（可能含替换符，但至少不会抛异常）
  const fallback = iconv.decode(buf, 'utf-8');
  return fallback.charCodeAt(0) === 0xFEFF ? fallback.slice(1) : fallback;
}

function timeToSec(t) {
  const m = String(t).match(/^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const min = Number(m[1] || '0') || 0;
  const sec = Number(m[2]) || 0;
  const ms = Number((m[3] || '0').padEnd(3, '0')) || 0;
  return min * 60 + sec + ms / 1000;
}

/* ================= 逐字歌词（word-LRC / Musixmatch rich-sync） =================
 * 行内 <mm:ss.xx> 标签标记其后文字被唱到的绝对时间（与行首 [mm:ss.xx] 同一时间基）。
 * 形如：[00:12.00]<00:12.50>但<00:12.90>愿<00:13.30>人<00:13.70>长<00:14.10>久
 * 解析为 words:[{text:'但',t:12.5},...]，再按字在词内均匀分配出逐字时间戳 charTimes。 */

const WORD_TAG_RE = /<([0-9]+(?::[0-9]+)?(?:\.[0-9]{1,3})?)>/g;

/** 从一行文本（已去掉行首时间标签）中提取逐字时间戳。
 *  @returns {{text:string, words:{text:string,t:number}[]}|null} 无 < > 标签返回 null。 */
function parseInlineWords(textPart, lineTime) {
  if (!WORD_TAG_RE.test(textPart)) return null;
  WORD_TAG_RE.lastIndex = 0;
  const words = [];
  let lastIndex = 0;
  let m;
  let prevTime = lineTime;
  while ((m = WORD_TAG_RE.exec(textPart)) !== null) {
    const chunk = textPart.slice(lastIndex, m.index);
    const t = timeToSec(m[1]);
    if (chunk) words.push({ text: chunk, t: prevTime });
    prevTime = (t != null) ? t : prevTime;
    lastIndex = WORD_TAG_RE.lastIndex;
  }
  const tail = textPart.slice(lastIndex);
  if (tail) words.push({ text: tail, t: prevTime });
  if (!words.length) return null;
  return { text: words.map((w) => w.text).join(''), words };
}

/** 把 words（词级时间戳）展开为逐字时间戳：每个字落在其所在词的 [t, nextT) 区间内、取中心时刻。
 *  @param {{text:string,t:number}[]} words
 *  @param {number} lineEnd 本行结束时间（下一行开始，用于最后一个词延伸到行尾） */
function wordsToCharTimes(words, lineEnd) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = (i + 1 < words.length) ? words[i + 1].t : lineEnd;
    const chars = Array.from(w.text);
    const span = Math.max(0, next - w.t);
    for (let c = 0; c < chars.length; c++) {
      const frac = chars.length > 1 ? (c + 0.5) / chars.length : 0.5;
      out.push(w.t + span * frac);
    }
  }
  return out;
}

/* ================= LRC 元信息（标准标签 + credits 行）提取 ================= */

// 标准 LRC 标签：解析为 meta.tags，其余（offset/length 等数值指令）忽略
const LRC_STANDARD_TAGS = ['ti', 'ar', 'al', 'au', 'by', 'music', 'co', 'author', 'artist', 'album', 'title', 'albumartist', 'editor', 'maker', 'program'];

// credits 关键词白名单：把 LRC 时间轴里的「词：/曲：/编曲：」行归一化为统一标签
const LRC_CREDIT_KEYWORDS = {
  '词': ['词', '作词', '填词'],
  '曲': ['曲', '作曲', '谱曲'],
  '编曲': ['编曲', '编配'],
  '演唱': ['演唱', '原唱', '歌手', '演唱者'],
  '制作人': ['制作人', '监制', 'producer'],
  '和声': ['和声', '和音'],
  '混音': ['混音', '混音师'],
  '母带': ['母带'],
  '出品': ['出品', '发行', '厂牌'],
  '钢琴': ['钢琴'],
  '吉他': ['吉他'],
  '鼓': ['鼓'],
  '贝斯': ['贝斯', '低音'],
  '弦乐': ['弦乐'],
};

const LRC_TAG_RE = /^\[([A-Za-z]+):\s*(.+?)\s*\]$/;
const LRC_CREDIT_RE = /^(.+?)[:：]\s*(.+)$/;

/**
 * 解析 LRC 文本。
 * @returns {{lines:{time:number,text:string}[], meta:{tags:Object, credits:Object}}}
 *   - lines：带时间戳的歌词行（credits 行仍保留在滚动歌词中，像传统 LRC 一样显示）
 *   - meta.tags：标准标签 [ti:]/[ar:]/[al:]/[au:]/[by:]/[music:]/[co:]
 *   - meta.credits：从时间轴行提取出的词/曲/编曲等（归一化为白名单标签，供顶部 credits 横条使用）
 */
function parseLrc(text) {
  const lines = String(text || '').split(/\r?\n/);
  const raw = [];
  const tags = {};
  const credits = {};
  for (const line of lines) {
    // 1) 标准标签行：[key:value]（无时间戳）
    const tagM = line.match(LRC_TAG_RE);
    if (tagM) {
      const key = tagM[1].toLowerCase();
      if (LRC_STANDARD_TAGS.includes(key)) tags[key] = tagM[2];
      continue; // 非标准标签（offset/length 等）跳过，不视为歌词
    }
    // 2) 带时间戳的歌词行
    const ts = [...line.matchAll(/\[(\d{1,2}:\d{1,2}(?:\.\d{1,3})?)\]/g)];
    if (!ts.length) continue;
    const textPart = line.replace(/\[\d{1,2}:\d{1,2}(?:\.\d{1,3})?\]/g, '').trim();
    if (!textPart) continue;
    // 2a) 提取 credits 行：以「关键词 + 冒号」开头（如 [00:00.50]词：周杰伦）
    //    保留在滚动歌词中（不单独剥离），但标记 isCredit，稍后分配递增时间戳，
    //    使其像普通歌词一样随播放时间顺序着色，而不是全部堆在 00:00 把第一句歌词挤后。
    //    仅白名单内的关键词会进入 meta.credits。
    const cr = textPart.match(LRC_CREDIT_RE);
    let isCredit = false;
    if (cr) {
      const label = cr[1].trim();
      const val = cr[2].trim();
      for (const [norm, aliases] of Object.entries(LRC_CREDIT_KEYWORDS)) {
        if (aliases.includes(label)) { if (!credits[norm]) credits[norm] = val; isCredit = true; break; }
      }
    }
    for (const tag of ts) {
      const t = timeToSec(tag[1]);
      if (t === null || t < 0) continue;
      raw.push({ time: t, text: textPart, isCredit });
    }
  }
  raw.sort((a, b) => a.time - b.time);

  // credits 行（词/曲/编曲/和声/混音…）常常全部标记 [00:00.00]，会让它们集体成为
  // “当前句”，把真正第一句歌词推到后面无法点亮（表现为“不从第一个字开始着色”）。
  // 这里给这些前置 credits 行分配递增时间戳，均匀铺在 [0, 第一句真实歌词) 之间，
  // 使其随播放时间顺序依次着色，再自然过渡到第一句歌词——
  // 符合「不单独提取、但跟着时间顺序着色」的诉求。
  const firstReal = raw.reduce((m, r) => (r.isCredit ? m : Math.min(m, r.time)), Infinity);
  if (firstReal > 0.05) {
    const preCredits = raw.filter((r) => r.isCredit && r.time <= firstReal + 1e-6);
    const n = preCredits.length;
    if (n) {
      const step = firstReal / n;
      preCredits.forEach((r, i) => { r.time = (i + 0.5) * step; });
      raw.sort((a, b) => a.time - b.time);
    }
  }

  // 3) 逐字解析：若某行含行内 < > 时间戳，则提取 words / charTimes（精确逐字）；
  //    否则仅保留纯文本（渲染端按行跨度均匀估算逐字时间）。
  const out = raw.map((r, i) => {
    const next = (i + 1 < raw.length) ? raw[i + 1].time : (r.time + 10);
    const parsed = parseInlineWords(r.text, r.time);
    if (parsed) {
      return {
        time: r.time,
        text: parsed.text,
        words: parsed.words,
        charTimes: wordsToCharTimes(parsed.words, next),
      };
    }
    return { time: r.time, text: r.text };
  });

  return { lines: out, meta: { tags, credits } };
}

/**
 * @param {string} mediaPath
 * @param {{simplified?:boolean}} [opts] 为 true 时把歌词中的繁体中文转为简体
 * @returns {{ok:true, lines:{time:number,text:string}[]}|{ok:false, error?:string}}
 */
function loadLyrics(mediaPath, opts) {
  if (!mediaPath) return { ok: false, error: 'no path' };
  const base = path.join(path.dirname(mediaPath), path.basename(mediaPath, path.extname(mediaPath)));
  const candidates = [`${base}.lrc`, `${base}.Lrc`, `${base}.LRC`];
  const simplified = !!(opts && opts.simplified);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      let text = readTextAutoEncode(p);
      if (simplified) text = toSimplified(text);
      const { lines, meta } = parseLrc(text);
      if (!lines.length) return { ok: false, error: 'empty lyrics' };
      return { ok: true, lines, meta };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: 'not found' };
}

/* ================= 在线词曲编曲查询（MusicBrainz，免费无需 key） ================= */
// 本地 LRC / ID3 标签缺失词曲时，按 歌名 + 歌手 查询 MusicBrainz 的 work（作品）实体，
// 其 artist-rels 直接带有 lyricist（词）/ composer（曲）/ arranger（编曲）关系。
// 任意异常 / 超时 / 无结果都安全降级为 { ok:false }，不影响歌词主流程。

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_UA = 'Lumora/1.0 (https://github.com/icebang01/lumora)';
const MB_TIMEOUT_MS = 12000;

function mbGetJson(url) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(new URL(url), {
        timeout: MB_TIMEOUT_MS,
        headers: { 'User-Agent': MB_UA, 'Accept': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          } else { resolve(null); }
        });
      });
    } catch { resolve(null); return; }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve(null); });
  });
}

const MB_REL_TO_ROLE = { lyricist: 'lyricist', composer: 'composer', arranger: 'arranger' };

/**
 * 从 MusicBrainz work 实体提取词/曲/编曲（纯函数，便于单测）。
 * work.relations 中 type 为 lyricist/composer/arranger 且指向 artist 的关系会被提取；
 * 同名多个关系只取第一个；artist 名经繁→简转换统一显示。
 * @param {Object} work
 * @returns {{lyricist:string, composer:string, arranger:string}}
 */
function extractCreditsFromWork(work) {
  const out = { lyricist: '', composer: '', arranger: '' };
  const rels = (work && Array.isArray(work.relations)) ? work.relations : [];
  for (const r of rels) {
    if (!r || !r.artist || !r.type) continue;
    const role = MB_REL_TO_ROLE[r.type];
    if (role) {
      const name = toSimplified(String(r.artist.name || '').trim());
      if (name && !out[role]) out[role] = name; // 同名多个关系只取第一个
    }
  }
  return out;
}

/**
 * 从 MusicBrainz 查询词/曲/编曲。
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<{ok:true, lyricist:string, composer:string, arranger:string}|{ok:false, error?:string}>}
 */
async function queryMusicBrainzCredits(title, artist) {
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  if (!t && !a) return { ok: false, error: 'no metadata' };

  // 优先「歌手 + 歌名」精确匹配；失败回退仅歌名
  const terms = [];
  if (t && a) terms.push(`artist:"${a}" AND work:"${t}"`);
  if (t) terms.push(`work:"${t}"`);

  let works = null;
  for (const term of terms) {
    const url = `${MB_BASE}/work/?query=${encodeURIComponent(term)}&fmt=json&limit=5&inc=artist-rels`;
    const data = await mbGetJson(url); // 任意失败返回 null，继续下个 term
    if (data && Array.isArray(data.works) && data.works.length) { works = data.works; break; }
  }
  if (!works || !works.length) return { ok: false, error: 'no work' };

  // 取 score 最高的 work
  const work = works.slice().sort((x, y) => (Number(y.score) || 0) - (Number(x.score) || 0))[0];
  const c = extractCreditsFromWork(work);
  if (!c.lyricist && !c.composer && !c.arranger) return { ok: false, error: 'no credits' };
  return { ok: true, ...c };
}

/* ================= 网易云音乐 credits fallback（中文歌覆盖更好） ================= */
// MusicBrainz 对华语流行作品收录不全；网易云音乐歌词头部通常带完整词/曲/编曲/制作人信息，
// 可作为补充源。仅提取 credits，不保存歌词到本地，避免覆盖用户已有 LRC。

const NETEASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function neteaseGetJson(path) {
  return new Promise((resolve) => {
    const url = `https://music.163.com${path}`;
    let req;
    try {
      req = https.get(new URL(url), {
        timeout: MB_TIMEOUT_MS,
        headers: {
          'User-Agent': NETEASE_UA,
          'Referer': 'https://music.163.com/',
          'Accept': 'application/json, text/plain, */*',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          } else { resolve(null); }
        });
      });
    } catch { resolve(null); return; }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve(null); });
  });
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function pickNeteaseSong(songs, title, artist) {
  if (!Array.isArray(songs) || !songs.length) return null;
  const t = normalizeText(title);
  const artists = String(artist || '').toLowerCase()
    .split(/[\/.,;&＆、，；]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  // 优先 title + artist 都匹配
  for (const s of songs) {
    const sTitle = normalizeText(s.name);
    const sArtists = new Set((s.artists || []).map((a) => normalizeText(a.name)));
    const titleMatch = sTitle === t || (t && sTitle.includes(t)) || (sTitle && t.includes(sTitle));
    const artistMatch = artists.length === 0 || artists.some((a) => {
      for (const sa of sArtists) if (sa === a || sa.includes(a) || a.includes(sa)) return true;
      return false;
    });
    if (titleMatch && artistMatch) return s;
  }
  // 次优：仅 title 匹配
  for (const s of songs) {
    const sTitle = normalizeText(s.name);
    if (sTitle === t || (t && sTitle.includes(t))) return s;
  }
  // 兜底第一首（搜索结果通常最相关）
  return songs[0];
}

/**
 * 从网易云音乐搜索并提取 credits。
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<{ok:true, lyricist:string, composer:string, arranger:string, producer?:string, backing?:string, mixing?:string}|{ok:false, error?:string}>}
 */
async function queryNeteaseCredits(title, artist) {
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  if (!t && !a) return { ok: false, error: 'no metadata' };
  const q = [t, a].filter(Boolean).join(' ');
  const data = await neteaseGetJson(`/api/search/get/web?csrf_token=&s=${encodeURIComponent(q)}&type=1&offset=0&total=true&limit=10`);
  const songs = data && data.result && Array.isArray(data.result.songs) ? data.result.songs : [];
  if (!songs.length) return { ok: false, error: 'no netease song' };
  const song = pickNeteaseSong(songs, t, a);
  if (!song) return { ok: false, error: 'no match' };
  const lyricData = await neteaseGetJson(`/api/song/lyric?os=pc&id=${song.id}&lv=-1&kv=-1&tv=-1`);
  const lrcText = lyricData && lyricData.lrc && typeof lyricData.lrc.lyric === 'string' ? lyricData.lrc.lyric : '';
  if (!lrcText.trim()) return { ok: false, error: 'no lyric' };
  const { meta } = parseLrc(lrcText);
  const credits = (meta && meta.credits) || {};
  if (!credits['词'] && !credits['曲'] && !credits['编曲'] && !credits['制作人']) {
    return { ok: false, error: 'no credits in lyric' };
  }
  return {
    ok: true,
    lyricist: credits['词'] || '',
    composer: credits['曲'] || '',
    arranger: credits['编曲'] || '',
    producer: credits['制作人'] || '',
    backing: credits['和声'] || '',
    mixing: credits['混音'] || '',
  };
}

/**
 * 查询作品的词 / 曲 / 编曲等信息。
 * 聚合 MusicBrainz + 网易云音乐，任一源有结果即返回；优先取已有字段，互补合并。
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<{ok:true, lyricist:string, composer:string, arranger:string, producer?:string, backing?:string, mixing?:string}|{ok:false, error?:string}>}
 */
async function queryCredits(title, artist) {
  const [mb, netease] = await Promise.all([
    queryMusicBrainzCredits(title, artist).catch(() => ({ ok: false })),
    queryNeteaseCredits(title, artist).catch(() => ({ ok: false })),
  ]);
  const out = { ok: false, lyricist: '', composer: '', arranger: '', producer: '', backing: '', mixing: '' };
  let any = false;
  for (const src of [mb, netease]) {
    if (!src || !src.ok) continue;
    for (const k of Object.keys(out)) {
      if (k === 'ok') continue;
      if (src[k] && !out[k]) { out[k] = src[k]; any = true; }
    }
  }
  if (!any) {
    const err = (mb && mb.error) || (netease && netease.error) || 'no credits';
    return { ok: false, error: err };
  }
  out.ok = true;
  return out;
}

/* ================= Musixmatch 逐字歌词（rich-sync，需用户 token） =================
 * 仅当用户在设置里填入 Musixmatch 用户 token 时启用，作为「逐字歌词」的首选源：
 * 返回带 <mm:ss.xx> 行内时间戳的 LRC（唱到哪个字就哪个字着色）。任意失败均安全降级，
 * 回退到下面的 LRCLIB 行级歌词（再由渲染端按行跨度均匀估算逐字）。 */

const MX_BASE = 'https://apic.musixmatch.com/ws/1.1';
const MX_APP_ID = 'web-desktop-app-v1.0';
const MX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MX_TIMEOUT_MS = 12000;

function mxGetJson(url) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(new URL(url), {
        timeout: MX_TIMEOUT_MS,
        headers: { 'User-Agent': MX_UA, 'Accept': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
    } catch { resolve(null); return; }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve(null); });
  });
}

/** 用 Musixmatch 拉取逐字 LRC 文本（含 < > 行内时间戳）；无结果/失败返回 null。 */
async function fetchMusixmatchWordLrc(meta, token) {
  const title = String(meta && meta.title || '').trim();
  const artist = String(meta && meta.artist || '').trim();
  if (!title && !artist) return null;
  const params = new URLSearchParams();
  if (title) params.set('q_track', title);
  if (artist) params.set('q_artist', artist);
  params.set('page_size', '1');
  params.set('usertoken', token);
  params.set('app_id', MX_APP_ID);
  const search = await mxGetJson(`${MX_BASE}/track.search?${params.toString()}`).catch(() => null);
  const track = search && search.message && search.message.body
    && Array.isArray(search.message.body.track_list) && search.message.body.track_list[0]
    && search.message.body.track_list[0].track;
  if (!track || !track.track_id) return null;
  const sub = await mxGetJson(
    `${MX_BASE}/track.subtitles.get?track_id=${encodeURIComponent(track.track_id)}`
    + `&subtitle_format=lrc&usertoken=${encodeURIComponent(token)}&app_id=${encodeURIComponent(MX_APP_ID)}`
  ).catch(() => null);
  const body = sub && sub.message && sub.message.body
    && Array.isArray(sub.message.body.subtitle_list) && sub.message.body.subtitle_list[0]
    && sub.message.body.subtitle_list[0].subtitle
    && sub.message.body.subtitle_list[0].subtitle.subtitle_body;
  return typeof body === 'string' ? body : null;
}

/* ================= 在线歌词下载（LRCLIB 免费源） ================= */

const LRCLIB_HOST = 'lrclib.net';
const LRCLIB_TIMEOUT_MS = 12000;
const LRCLIB_UA = 'Lumora Music Player (https://github.com/icebang01/lumora)';

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(new URL(url), {
      timeout: LRCLIB_TIMEOUT_MS,
      headers: {
        'User-Agent': LRCLIB_UA,
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function pickBestResult(results, duration) {
  if (!Array.isArray(results) || !results.length) return null;
  if (duration && duration > 0) {
    // 优先选时长相差 < 3 秒且有同步歌词的结果
    const withSync = results.filter((r) => r && typeof r.syncedLyrics === 'string' && r.syncedLyrics.trim());
    const matched = withSync
      .map((r) => ({ r, diff: Math.abs((Number(r.duration) || 0) - duration) }))
      .filter((x) => x.diff < 3)
      .sort((a, b) => a.diff - b.diff);
    if (matched.length) return matched[0].r;
    if (withSync.length) return withSync[0];
  }
  for (const r of results) {
    if (r && typeof r.syncedLyrics === 'string' && r.syncedLyrics.trim()) return r;
  }
  return null;
}

function saveLyricsToDisk(mediaPath, lrcText) {
  try {
    const base = path.join(path.dirname(mediaPath), path.basename(mediaPath, path.extname(mediaPath)));
    fs.writeFileSync(`${base}.lrc`, lrcText, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// 下载歌词时写入 LRC 头部的 credits 字段顺序（与 queryCredits 返回键对应）
const DOWNLOAD_CREDIT_FIELDS = [
  ['lyricist', '词'],
  ['composer', '曲'],
  ['arranger', '编曲'],
  ['producer', '制作人'],
  ['backing', '和声'],
  ['mixing', '混音'],
];

/**
 * 生成 LRC 头部的 credits 文本（每行 [00:00.00]词：xxx），直接并入下载的 .lrc。
 * 若传入的已有 credits（LRC 自带）已含词/曲/编曲/制作人，则视为已齐全、不再补全（避免重复）。
 * 任意查询失败静默返回空串，调用方原样保存纯歌词。
 * @param {{title:string, artist:string}} info
 * @param {Object} [existingCredits] 已解析出的 LRC meta.credits
 * @returns {Promise<string>} 多行 credits 文本（末尾不带多余换行）或空串
 */
async function buildLyricsCreditsHeader(info, existingCredits) {
  if (existingCredits && (existingCredits['词'] || existingCredits['曲'] || existingCredits['编曲'] || existingCredits['制作人'])) {
    return '';
  }
  const title = String(info && info.title || '').trim();
  const artist = String(info && info.artist || '').trim();
  if (!title && !artist) return '';
  const r = await queryCredits(title, artist).catch(() => ({ ok: false }));
  if (!r || !r.ok) return '';
  const lines = [];
  for (const [key, label] of DOWNLOAD_CREDIT_FIELDS) {
    const val = String(r[key] || '').trim();
    if (val) lines.push(`[00:00.00]${label}：${val}`);
  }
  return lines.join('\n');
}

/**
 * @param {string} mediaPath
 * @param {{title?:string, artist?:string, album?:string, duration?:number}} meta
 * @param {{simplified?:boolean}} [opts] 为 true 时把歌词中的繁体中文转为简体（并保存简体到本地）
 * @returns {Promise<{ok:true, lines:{time:number,text:string}[], source:string}|{ok:false, error?:string}>}
 */
async function downloadLyrics(mediaPath, meta, opts) {
  if (!mediaPath) return { ok: false, error: 'no path' };
  const title = String(meta && meta.title || '').trim();
  const artist = String(meta && meta.artist || '').trim();
  const album = String(meta && meta.album || '').trim();
  const duration = Number(meta && meta.duration) || 0;
  const token = String((opts && opts.musixmatchToken) || '').trim();

  if (!title && !artist) return { ok: false, error: 'no metadata' };

  // 0) 优先 Musixmatch 逐字歌词（需用户 token）：返回带 < > 行内时间戳的 LRC
  if (token) {
    const mxText = await fetchMusixmatchWordLrc({ title, artist }, token).catch(() => null);
    if (mxText && mxText.trim()) {
      let synced = (opts && opts.simplified) ? toSimplified(mxText) : mxText;
      const baseMeta = parseLrc(synced).meta;
      // 下载时把词/曲/编曲/制作人等并入 LRC 头部，让所有歌的歌词都带制作信息
      if (opts && opts.includeCredits) {
        const header = await buildLyricsCreditsHeader({ title, artist }, baseMeta.credits).catch(() => '');
        if (header) synced = header + '\n' + synced;
      }
      const { lines, meta: lrcMeta } = parseLrc(synced);
      // 必须至少有一行带有效时间轴的歌词（词/曲等 credits 行是 [00:00.00] 不会算作歌词正文）。
      // 若 Musixmatch 返回异常、无时间轴，则不放过、继续往下走 LRCLIB 兜底，而不是落盘纯文本。
      if (lines.length && lines.some((l) => l.time > 0)) {
        saveLyricsToDisk(mediaPath, synced); // 含 < > 逐字标签 + 头部 credits，下次本地直接命中
        return { ok: true, lines, source: 'musixmatch', meta: lrcMeta };
      }
    }
  }

  // 1) 精确匹配（get）
  const params = new URLSearchParams();
  if (title) params.set('track_name', title);
  if (artist) params.set('artist_name', artist);
  if (album) params.set('album_name', album);
  if (duration > 0) params.set('duration', String(Math.round(duration)));

  let result = null;
  try {
    const exact = await httpGetJson(`https://${LRCLIB_HOST}/api/get?${params.toString()}`);
    if (exact && typeof exact.syncedLyrics === 'string' && exact.syncedLyrics.trim()) {
      result = exact;
    }
  } catch { /* ignore */ }

  // 2) 模糊搜索（search）
  if (!result) {
    const q = [title, artist, album].filter(Boolean).join(' ');
    try {
      const list = await httpGetJson(`https://${LRCLIB_HOST}/api/search?q=${encodeURIComponent(q)}`);
      result = pickBestResult(list, duration);
    } catch { /* ignore */ }
  }

  if (!result || typeof result.syncedLyrics !== 'string' || !result.syncedLyrics.trim()) {
    return { ok: false, error: 'no lyrics found online' };
  }

  // 繁→简：转换整段 LRC 文本（时间戳不受影响），既用于解析也原样保存到本地
  const simplified = !!(opts && opts.simplified);
  let synced = simplified ? toSimplified(result.syncedLyrics) : result.syncedLyrics;
  const baseMeta = parseLrc(synced).meta;
  // 下载时把词/曲/编曲/制作人等并入 LRC 头部，让所有歌的歌词都带制作信息
  if (opts && opts.includeCredits) {
    const header = await buildLyricsCreditsHeader({ title, artist }, baseMeta.credits).catch(() => '');
    if (header) synced = header + '\n' + synced;
  }
  const { lines, meta: lrcMeta } = parseLrc(synced);
  if (!lines.length) return { ok: false, error: 'empty lyrics' };
  // 健壮性双保险：在线源若只返回纯文本（无 [mm:ss.xx] 时间轴），拒绝落盘，
  // 确保下载到本地的 .lrc 一定带时间轴、可被播放器读取并匹配高亮。
  if (!lines.some((l) => l.time > 0)) return { ok: false, error: 'no timed lyrics in source' };

  // 保存到音频同目录（下次直接从本地读取；保存失败不影响本次使用）
  saveLyricsToDisk(mediaPath, synced);

  return { ok: true, lines, source: 'lrclib', meta: lrcMeta };
}

/* ================= 歌词翻译（多翻译源容错：Google gtx → MyMemory 兜底） =================
 * 默认主源为 Google Translate 的 gtx 公开端点（免费、无需 key），但该域名在中国大陆
 * 多数网络环境下被墙，请求会超时/连接重置 → 静默失败、译文永远不显示。
 * 因此增加 MyMemory（api.mymemory.translated.net，通常在中国可访问、免费无需 key）
 * 作为兜底：主源首个请求失败后整批降级到兜底源，避免每行都白白等待超时。 */

const TRANSLATE_TIMEOUT_MS = 8000;
// 覆盖日文（平/片假名 U+3040–U+30FF）、中文（CJK 基本集 U+4E00–U+9FFF + 扩展 A U+3400–U+4DBF）、韩文（Hangul U+AC00–U+D7A3）
const CJK_RE = new RegExp('[\\u3040-\\u30ff\\u4e00-\\u9fff\\u3400-\\u4dbf\\uac00-\\ud7a3]');

// 主源偏好：每批翻译开始前重置为 'google'；首个 google 请求失败则整批降级 'mymemory'
let _translateProviderPref = 'google';

// 粗粒度源语言探测（MyMemory 需要明确 langpair；gtx 用 sl=auto 无需此步）
function _detectSourceLang(text) {
  if (/[А-Яа-яЁё]/.test(text)) return 'ru';
  if (/[Α-Ωα-ω]/.test(text)) return 'el';
  if (/[가-힣]/.test(text)) return 'ko';
  return 'en';
}

// Google gtx 端点：返回译文；任意异常/超时返回空串
function _translateViaGoogle(text, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  return new Promise((resolve) => {
    const req = https.get(new URL(url), {
      timeout: TRANSLATE_TIMEOUT_MS,
      headers: { 'User-Agent': LRCLIB_UA, 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          // j[0] 是分段数组，每段 [translatedText, original, ...]；拼回整句
          const translated = (j && Array.isArray(j[0]) ? j[0] : [])
            .map((seg) => (seg && seg[0]) || '')
            .join('');
          resolve(translated || '');
        } catch {
          resolve('');
        }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve(''); });
  });
}

// MyMemory 兜底端点：返回译文；配额耗尽/报错时 translatedText 含警告文本，按失败处理
function _translateViaMyMemory(text, to) {
  const sl = _detectSourceLang(text);
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`${sl}|${to}`)}`;
  return new Promise((resolve) => {
    const req = https.get(new URL(url), {
      timeout: TRANSLATE_TIMEOUT_MS,
      headers: { 'User-Agent': LRCLIB_UA, 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const t = j && j.responseData && j.responseData.translatedText;
          if (typeof t !== 'string' || !t || /MYMEMORY WARNING|QUOTA/i.test(t)) return resolve('');
          resolve(t);
        } catch {
          resolve('');
        }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve(''); });
  });
}

// 单行翻译：优先主源；主源失败整批降级兜底源（避免每行都空等 google 超时）
async function _translateOne(text, to) {
  if (_translateProviderPref === 'google') {
    const g = await _translateViaGoogle(text, to);
    if (g) return g;
    _translateProviderPref = 'mymemory'; // 降级，后续行不再等待 google 超时
  }
  return _translateViaMyMemory(text, to);
}

/**
 * 批量翻译歌词行。已含中日韩字符的行视为无需翻译（跳过，返回空串）；
 * 空行/占位符（♪）同样跳过。非 CJK 行并发翻译（并发上限 4），主源失败自动兜底。
 * @param {string[]} lines 原始歌词文本数组
 * @param {{to?:string}} [opts] 目标语言，默认 'zh-CN'
 * @returns {Promise<{ok:true, translations:string[], provider:string, failed:boolean}>}
 *   translations 与输入按索引对齐；无需翻译/失败的行为空串。
 *   provider 为首个成功的源（'google'|'mymemory'），全部失败为 'none'。
 *   failed=true 表示存在可翻译行但所有源均失败（典型为网络受限），供前端提示用户。
 */
async function translateLyrics(lines, opts) {
  const to = (opts && opts.to) || 'zh-CN';
  const out = new Array(lines.length).fill('');
  const jobs = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] || '';
    if (!text || CJK_RE.test(text)) continue; // 已有中文/日文/韩文 → 无需翻译
    jobs.push(i);
  }
  let success = 0;
  _translateProviderPref = 'google'; // 每批重新探测主源
  const CONC = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const i = jobs[cursor++];
      const t = await _translateOne(lines[i], to);
      if (t) success++;
      out[i] = t;
    }
  }
  const workers = [];
  const n = Math.min(CONC, jobs.length);
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  const failed = jobs.length > 0 && success === 0;
  return { ok: true, translations: out, provider: success > 0 ? _translateProviderPref : 'none', failed };
}

module.exports = {
  loadLyrics, parseLrc, downloadLyrics, translateLyrics,
  queryCredits, extractCreditsFromWork, queryMusicBrainzCredits, queryNeteaseCredits,
};
