'use strict';
/**
 * 文件名解析器（本地、零依赖、离线）。
 *
 * 把杂乱的发布文件名（含制作组、分辨率、编码、集数、年份等噪声）解析成结构化字段：
 *   { raw, group, season, episode, year, resolution, title }
 * 供字幕/弹幕自动匹配时生成更精准的搜索词，提升 hash 未命中时的兜底命中率。
 *
 * 设计取向（契合 #73「本地模型优先」）：不打包重模型，用确定性正则解析——
 * 视频播放器的"AI 匹配"90% 收益来自把文件名洗干净 + 抽对集数，而非跑神经网络。
 */

const path = require('path');

// 常见 release 标记（大小写不敏感），匹配后从标题中剔除
const TAGS = [
  '720p', '1080p', '1440p', '2160p', '4k', '8k', 'uhd',
  'web-dl', 'webrip', 'web', 'bluray', 'blu-ray', 'bd', 'dvd', 'hdtv', 'tvrip', 'hdtvrip',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'vp9', 'av1', '10bit', '8bit', '10-bit', '8-bit', 'hi10p',
  'flac', 'aac', 'ac3', 'mp3', 'truehd', 'dts', 'dts-hd', 'eac3', 'opus', '5.1', '2.0',
  'dual', 'dualaudio', 'dual-audio', 'multisub', 'multiaudio', 'sub', 'subbed', 'raw',
  'chs', 'cht', 'zh', 'sc', 'tc', 'jp', 'jpn', 'ja', 'eng', 'en', 'gb', 'big5', 'chs&jpn', 'cht&jpn',
  'proper', 'repack', 'remux', 'mini', 'complete', 'batch', 'uncensored', 'censored', 'vostfr', 'utf-8', 'utf8',
  'audio',
];

// 集数提取候选（按顺序，首命中即止）
const EP_PATTERNS = [
  /\bS(\d{1,2})[ ._-]?E(\d{1,3})\b/i,                                   // S01E12
  /\b(\d{1,2})[xX](\d{1,3})\b/,                                         // 01x12 / 1X12
  /\b(?:ep|episode|第)[ .]?(\d{1,3})\s*(?:话|集|期|ep|episode)?\b/i,   // 第12话 / EP12 / episode 12
  /\bE(\d{1,3})\b/i,                                                   // E12
  /(?:^|[\s_\-]+)(\d{1,3})(?:\s*$|\s+\[|\s+\()/,                      // 结尾 - 12 [ / 结尾 - 12 (（anime 常见）
];

const SEASON_RE = /\bS(\d{1,2})\b/i;

function _escapeTag(t) {
  return t.replace(/[.\-]/g, '\\$&');
}

function _stripTags(s) {
  let out = s;
  for (const t of TAGS) {
    out = out.replace(new RegExp('\\b' + _escapeTag(t) + '\\b', 'gi'), ' ');
  }
  return out;
}

/**
 * 解析文件名。
 * @param {string} filePath
 * @returns {{raw:string,group:?string,season:?number,episode:?number,year:?number,resolution:?string,title:string}}
 */
function parseFilename(filePath) {
  let name = filePath ? path.basename(String(filePath)) : '';
  const ext = path.extname(name);
  if (ext) name = name.slice(0, -ext.length);

  const result = { raw: name, group: null, season: null, episode: null, year: null, resolution: null, title: '' };

  // 1) 制作组：首对括号内容
  const gm = name.match(/^[\[\(\{]([^\]\)\}]+)[\]\)\}]\s*/);
  if (gm) { result.group = gm[1].trim(); name = name.slice(gm[0].length); }

  // 2) 年份
  const ym = name.match(/\b(19|20)\d{2}\b/);
  if (ym) { result.year = parseInt(ym[0], 10); name = name.replace(ym[0], ' '); }

  // 3) 分辨率
  const rm = name.match(/\b(2160p|1440p|1080p|720p|4k|8k|uhd)\b/i);
  if (rm) { result.resolution = rm[0].toUpperCase(); name = name.replace(rm[0], ' '); }

  // 4) 季度
  const sm = name.match(SEASON_RE);
  if (sm) { result.season = parseInt(sm[1], 10); name = name.replace(sm[0], ' '); }

  // 5) 集数（首命中即止，并据此补全 season）
  for (const re of EP_PATTERNS) {
    const m = name.match(re);
    if (m) {
      if (m[2] !== undefined) {
        if (result.season == null) result.season = parseInt(m[1], 10);
        result.episode = parseInt(m[2], 10);
      } else {
        result.episode = parseInt(m[1], 10);
      }
      name = name.replace(m[0], ' ');
      break;
    }
  }

  // 6) 清洗：剔除 release 标记 + 括号 + 分隔符，余下即标题
  let title = _stripTags(name);
  title = title.replace(/[\[\]\(\)\{\}]/g, ' ');
  title = title.replace(/[._]+/g, ' ');
  // 去掉残留的制作组/标记碎片（如 "GROUP"、"B-Global"、"&"）与孤立标点
  title = title.replace(/\b[A-Z0-9]{2,}(?:-[A-Z0-9]+)*\b/g, ' '); // 全大写连写组名
  title = title.replace(/[&|/\\]/g, ' ');
  title = title.replace(/[-–—]+/g, ' ');
  title = title.replace(/\s+/g, ' ').trim();
  result.title = title;
  return result;
}

/**
 * 生成搜索词。
 * @param {object} parsed parseFilename 的返回值
 * @param {{withEpisode?:boolean}} [opts] withEpisode 时在标题后追加「第N话」（B 站/弹弹更精准）
 */
function searchQuery(parsed, { withEpisode = false } = {}) {
  let q = (parsed && parsed.title) || '';
  if (withEpisode && parsed && parsed.episode != null) {
    q += ' 第' + parsed.episode + '话';
  }
  return (q.trim() || (parsed && parsed.raw) || '').trim();
}

/** 向后兼容：直接返回清洗后的标题 */
function guessTitle(filePath) {
  return parseFilename(filePath).title;
}

module.exports = { parseFilename, searchQuery, guessTitle };
