/**
 * IPC 注册·media（自包含模块）。
 * 从 register-ipc.js 拆出（2026-08）：内容域：subtitles:* + danmaku:* + app:*（续播/历史/缩略图/封面/歌词）+ playlist:*。
 * 用法：register(ctx)——ctx 与 register-ipc.js 的 setCtx 同构（getConfig/getCurrentInfo/...），
 * 由 register-ipc.js 编排器统一注入。
 */
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadResume, clearResume } = require('./resume-store');
const { loadPlaylist, savePlaylist, clearPlaylist } = require('./playlist-store');
const { loadHistory, clearHistory, removeHistory } = require('./history-store');
// 海报/播放列表封面用高清缩略图（400px 宽），替代被 sandbox 锁死的 thumbnail.js
const { generate: generateThumbnail } = require('./ffmpeg/poster-thumb');
const { generateSheet } = require('./ffmpeg/seek-sheet');
const { probeMedia } = require('./ffmpeg/probe');
const { extractCoverArt } = require('./ffmpeg/cover-art');
const { getArtistPhoto } = require('./ffmpeg/artist-photo');
const { loadLyrics, downloadLyrics, translateLyrics, queryCredits } = require('./ffmpeg/lyrics');
const { resolveBinary } = require('./ffmpeg/binaries');
const { computeLyricAutoOffset } = require('./ffmpeg/lyrics-offset');
const Subtitles = require('./subtitles');
const Danmaku = require('./danmaku');
let CTX = {};
function register(ipcCtx) { CTX = ipcCtx || {};
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getCurrentInfo() { return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null; }
function _isLyricsSimplified() {
  const v = getConfig() && getConfig().get ? getConfig().get('music.lyrics-simplified') : undefined;
  // 默认开启；仅当显式设为 false / 'no' / 0 时关闭
  return !(v === false || v === 'no' || v === 0);
}


  /* ------------------------------------------------------------------ */
  /* 在线字幕（OpenSubtitles v1）                                         */
  /* ------------------------------------------------------------------ */

  // 关键词搜索：返回归一化列表，渲染端展示

  ipcMain.handle('subtitles:search', async (_e, { query, languages, imdbId, moviehash, filePath } = {}) => {
    try {
      const slang = (getConfig().get('slang') || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      const rows = await Subtitles.search({
        query: query || '',
        languages: languages && languages.length ? languages : slang.length ? slang : ['zh'],
        imdbId, moviehash,
        slang,
        filePath: filePath || (getCurrentInfo() && getCurrentInfo().path) || '',
      });
      return { ok: true, results: rows };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  // 自动匹配：根据当前文件猜测片名 + 文件名 hash，优先中文

  ipcMain.handle('subtitles:auto-match', async () => {
    if (!getCurrentInfo()) return { ok: false, error: '未载入媒体' };
    try {
      const slang = (getConfig().get('slang') || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      const title = Subtitles.guessSearchQueryForSubtitle(getCurrentInfo().path);
      const moviehash = Subtitles.computeMovieHash(getCurrentInfo().path) || undefined;
      const rows = await Subtitles.search({
        query: title,
        languages: slang.length ? slang : ['zh', 'en'],
        moviehash,
        slang,
        filePath: getCurrentInfo().path,
      });
      return { ok: true, title, results: rows };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  // 下载：fileId → 缓存 .srt + cues，返回给渲染端（base 区分官方/代理来源）

  ipcMain.handle('subtitles:download', async (_e, { fileId, cacheKey, base, lang } = {}) => {
    try {
      const r = await Subtitles.download(fileId, cacheKey, base, lang);
      return { ok: true, path: r.path, cues: r.cues, fileId: r.fileId, name: r.name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  // 仅校验凭据是否足够（有 key 且能登录）

  ipcMain.handle('subtitles:login', async () => {
    try {
      await Subtitles.login();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  /* ------------------------------------------------------------------ */
  /* 弹幕（弹弹play / B 站 / 可自托管代理）                               */
  /* ------------------------------------------------------------------ */

  // 关键词搜索弹幕源（弹弹 + B 站同时查）

  ipcMain.handle('danmaku:search', async (_e, { keyword } = {}) => {
    if (!keyword) return { ok: false, error: '请输入关键词' };
    try {
      const r = await Danmaku.search(keyword);
      return { ok: true, sources: r.sources, errors: r.errors };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  // 自动匹配：按当前文件名+hash 匹配（弹弹），兜底 B 站关键词

  ipcMain.handle('danmaku:auto-match', async () => {
    if (!getCurrentInfo()) return { ok: false, error: '未载入媒体' };
    try {
      const hash = Subtitles.computeMovieHash(getCurrentInfo().path) || undefined;
      const stat = fs.existsSync(getCurrentInfo().path) ? fs.statSync(getCurrentInfo().path) : null;
      const r = await Danmaku.autoMatch(getCurrentInfo().path, hash, stat ? stat.size : 0);
      return { ok: true, sources: r.sources, errors: r.errors };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  // 加载选定弹幕源，返回解析后的弹幕列表

  ipcMain.handle('danmaku:load', async (_e, { source } = {}) => {
    if (!source) return { ok: false, error: '缺少弹幕源' };
    try {
      const r = await Danmaku.load(source);
      return { ok: true, count: r.count, comments: r.comments };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  // 仅查询弹幕数量（不返回全量弹幕数据，用于列表预览）

  ipcMain.handle('danmaku:count', async (_e, { source } = {}) => {
    if (!source) return { ok: false, error: '缺少弹幕源' };
    try {
      const r = await Danmaku.load(source);
      return { ok: true, count: r.count || 0 };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  // 自然播放到结尾时清除续播卡片

  ipcMain.handle('app:clear-resume', () => {
    clearResume();
    return { ok: true };
  });


  // 续播快照读取（idle 屏"继续观看"卡片用）

  ipcMain.handle('app:get-resume', () => loadResume());


  // 播放历史读取（idle 屏"最近播放"区域用）

  ipcMain.handle('app:get-history', () => loadHistory());

  ipcMain.handle('app:clear-history', () => { clearHistory(); return { ok: true }; });

  ipcMain.handle('app:remove-history', (_e, p) => { removeHistory(p); return { ok: true }; });


  // 缩略图：从视频抽一帧，返回 base64 data URL（带磁盘缓存）

  ipcMain.handle('app:thumbnail', (_e, p) => {
    try {
      return generateThumbnail(p, getConfig().get('ffmpeg-dir') || null);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 媒体元数据（时长/分辨率），供 idle 海报墙 badge 使用；带内存缓存，避免重复探测
  const mediaMetaCache = new Map();
  ipcMain.handle('app:get-media-meta', async (_e, { path: p } = {}) => {
    if (!p) return { ok: false, error: 'missing path' };
    const cached = mediaMetaCache.get(p);
    if (cached) return { ok: true, ...cached };
    try {
      const m = await probeMedia(p, { ffprobePath: getConfig().get('ffmpeg-dir') || null });
      const v = (m.video && m.video[0]) || {};
      const meta = { duration: m.duration || 0, width: v.width || 0, height: v.height || 0 };
      mediaMetaCache.set(p, meta);
      return { ok: true, ...meta };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 进度条悬停预览精灵图：沿时间轴均匀抽帧拼成网格图，返回 base64 + 网格元信息（带磁盘缓存）
  ipcMain.handle('app:seek-sheet', async (_e, { path, duration, count } = {}) => {
    try {
      return await generateSheet(path, getConfig().get('ffmpeg-dir') || null, { duration, count });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });


  // 音频封面：从音频文件抽取内嵌封面，返回 base64 data URL（带磁盘缓存）

  ipcMain.handle('app:cover-art', (_e, p) => {
    try {
      return extractCoverArt(p, getConfig().get('ffmpeg-dir') || null);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });


  // 艺人写真：本地目录优先，未找到时从网易云音乐自动下载并缓存

  ipcMain.handle('app:artist-photo', async (_e, { artist } = {}) => {
    try {
      return await getArtistPhoto(artist);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });


  // 歌词：读取同目录 .lrc 文件并解析

  ipcMain.handle('app:lyrics', (_e, p) => {
    try {
      return loadLyrics(p, { simplified: _isLyricsSimplified() });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 歌词：从 LRCLIB 在线搜索并下载同步歌词，自动保存到音频同目录

  ipcMain.handle('app:lyrics-download', async (_e, { path, meta, force } = {}) => {
    try {
      if (!force) {
        const enabled = getConfig().get('music.lyrics-auto-download');
        if (enabled === false || enabled === 'no' || enabled === 0) {
          return { ok: false, error: 'auto download disabled' };
        }
      }
      const mxToken = getConfig().get('music.lyrics-musixmatch-token') || '';
      const includeCredits = getConfig().get('music.lyrics-include-credits');
      return await downloadLyrics(path, meta || {}, {
        simplified: _isLyricsSimplified(),
        musixmatchToken: mxToken || '',
        includeCredits: includeCredits === undefined ? true : (includeCredits !== false && includeCredits !== 'no' && includeCredits !== 0),
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 歌词：自动偏移校准（ffmpeg 检测音频首句起音，与 LRC 首行时间戳对齐）
  ipcMain.handle('app:lyric-auto-offset', async (_e, { path, firstLineTime } = {}) => {
    try {
      const ff = resolveBinary('ffmpeg', (getConfig() && getConfig().get) ? (getConfig().get('ffmpeg-dir') || null) : null);
      const off = await computeLyricAutoOffset(path, firstLineTime, ff);
      return { ok: true, offset: off };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 歌词：逐行翻译（主进程发起网络请求，绕过渲染端 CORS；任意失败安全返回空翻译）
  ipcMain.handle('app:lyrics-translate', async (_e, { lines, to }) => {
    try {
      if (!Array.isArray(lines)) return { ok: false, error: 'bad input' };
      return await translateLyrics(lines, { to });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 词曲编曲在线查询（MusicBrainz work 实体 + 网易云音乐歌词 fallback；任意失败安全返回 { ok:false }）
  ipcMain.handle('app:credits', async (_e, { title, artist }) => {
    try {
      return await queryCredits(title, artist);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });


  // ---- 播放列表持久化 ----

  ipcMain.handle('playlist:load', () => loadPlaylist());

  ipcMain.handle('playlist:save', (_e, state) => {
    // 双列表格式 { video:{index,items}, audio:{index,items} }；store 内部兼容旧单列表并负责空列表清文件
    savePlaylist(state || {});
    return { ok: true };
  });
}

module.exports = { register };
