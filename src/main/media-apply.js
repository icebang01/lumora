'use strict';

/**
 * 媒体应用胶水层（media-apply）
 * -------------------------------------------------------------
 * 把 index.js 里两段"自动加载字幕 / 自动加载弹幕"的实现抽出来，
 * 供两处复用：
 *   1) index.js 原有的 subtitles-autoload / danmaku-autoload 开关；
 *   2) AI 助手的 auto_subtitle / auto_danmaku 工具。
 * 行为与原有内联实现保持一致（mpv 走 sub-add，ffmpeg 走 cue 推送），
 * 仅参数化语言偏好，并改为返回结构化结果便于工具层回灌 LLM。
 *
 * 依赖通过 deps 注入，便于单测传 mock：
 *   { Subtitles, Danmaku, sendToRenderer, config, useMpv, subAdd(path) }
 */

const path = require('path');
const fs = require('fs');

// 用户画像语言(chi/eng/jpn…) → OpenSubtitles ISO(zh/en/ja…)
const LANG_ISO = {
  chi: 'zh', zh: 'zh',
  eng: 'en', en: 'en',
  jpn: 'ja', ja: 'ja',
  kor: 'ko', ko: 'ko',
};

function langToIso(lang) {
  if (!lang) return null;
  return LANG_ISO[String(lang).toLowerCase()] || String(lang).toLowerCase();
}

/**
 * 自动搜索 + 下载 + 加载字幕。
 * @param {object} info 当前媒体信息（至少含 path）
 * @param {object} deps 注入依赖
 * @param {object} [opts] { lang } 偏好语言（覆盖默认 zh/en）
 * @returns {Promise<{ok:boolean, name?:string, lang?:string, count?:number, error?:string}>}
 */
async function autoLoadSubtitle(info, deps, { lang } = {}) {
  const { Subtitles, sendToRenderer, useMpv, subAdd } = deps;
  const slang = (deps.config && deps.config.get('slang') || '')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const iso = langToIso(lang);
  const languages = iso ? [iso] : slang.length ? slang : ['zh', 'en'];

  const title = Subtitles.guessSearchQueryForSubtitle(info.path);
  const moviehash = Subtitles.computeMovieHash(info.path) || undefined;
  const rows = await Subtitles.search({ query: title, languages, moviehash, slang, filePath: info.path });
  if (!rows.length) return { ok: false, error: 'no_subtitle' };

  const pick = (iso && rows.find((r) => r.lang === iso)) || rows.find((r) => r.lang === 'zh') || rows[0];
  const dl = await Subtitles.download(pick.fileId, path.basename(info.path) + '-' + pick.fileId, pick.base, iso || undefined);

  if (useMpv && subAdd) {
    subAdd(dl.path);
    sendToRenderer('osd', { text: 'AI 自动加载字幕', value: dl.name });
  } else {
    sendToRenderer('player:subtitles', { index: -2, cues: dl.cues, external: true });
  }
  return { ok: true, name: dl.name, lang: pick.lang, count: dl.cues ? dl.cues.length : 0 };
}

/**
 * 自动匹配 + 加载弹幕（弹弹play / B 站，按 confidence 降序逐源尝试）。
 * @param {object} info 当前媒体信息（至少含 path）
 * @param {object} deps 注入依赖
 * @returns {Promise<{ok:boolean, count?:number, source?:string, error?:string, errors?:Array}>}
 */
async function autoLoadDanmaku(info, deps) {
  const { Subtitles, Danmaku, sendToRenderer } = deps;
  const hash = Subtitles.computeMovieHash(info.path) || undefined;
  const stat = fs.existsSync(info.path) ? fs.statSync(info.path) : null;
  const r = await Danmaku.autoMatch(info.path, hash, stat ? stat.size : 0);
  const sources = r.sources || [];
  if (!sources.length) return { ok: false, error: 'no_source', errors: r.errors };

  const scored = sources.map((s) => ({ s, c: typeof s.confidence === 'number' ? s.confidence : -1 }));
  scored.sort((a, b) => b.c - a.c);

  let loaded = null;
  let lastErr = null;
  for (const { s } of scored) {
    try {
      console.log('[lumen][danmaku] 尝试源: ' + s.source + ' / ' + (s.title || s.id || s.episodeId));
      loaded = await Danmaku.load(s);
      break;
    } catch (e) {
      lastErr = e.message;
      console.warn('[lumen][danmaku] 源加载失败，尝试下一个: ' + s.source + ' -> ' + e.message);
    }
  }
  if (!loaded) {
    console.warn('[lumen][danmaku] 所有候选源均失败' + (lastErr ? (': ' + lastErr) : ''));
    return { ok: false, error: lastErr || 'load_failed' };
  }

  sendToRenderer('player:danmaku', { count: loaded.count, comments: loaded.comments });
  return { ok: true, count: loaded.count, source: loaded.source };
}

module.exports = { autoLoadSubtitle, autoLoadDanmaku, langToIso };
