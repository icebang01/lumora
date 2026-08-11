'use strict';
/**
 * 视频缩略图生成。
 *
 * 用 ffmpeg 从每个媒体文件抽取一帧，作为播放列表 / 最近播放的封面。
 * 结果按「路径 + 文件大小 + 修改时间」做哈希缓存，落盘到 userData/thumbs，
 * 重复渲染直接读缓存，不必再次解码。
 *
 * 只产出 base64 data URL：渲染端 CSP 已放行 data:，无需新增自定义协议。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const { resolveBinary } = require('./binaries');

function thumbsDir() {
  const dir = path.join(app.getPath('userData'), 'thumbs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  return dir;
}

function cacheKey(filePath) {
  let mtime = 0, size = 0;
  try {
    const st = fs.statSync(filePath);
    mtime = st.mtimeMs;
    size = st.size;
  } catch { /* 不可访问时退化为仅按路径哈希 */ }
  return crypto.createHash('md5').update(`${filePath}|${size}|${mtime}`).digest('hex');
}

/**
 * @param {string} filePath
 * @param {string|null} ffmpegDir  用户配置的 ffmpeg 目录（可为空）
 * @returns {{ok:true, dataUrl:string, cached:boolean}|{ok:false, audio?:true, error?:string}}
 */
function generate(filePath, ffmpegDir) {
  const key = cacheKey(filePath);
  const file = path.join(thumbsDir(), key + '.jpg');

  if (fs.existsSync(file)) {
    try {
      const b64 = fs.readFileSync(file).toString('base64');
      return { ok: true, dataUrl: `data:image/jpeg;base64,${b64}`, cached: true };
    } catch { /* 读缓存失败则重新生成 */ }
  }

  const ffmpeg = resolveBinary('ffmpeg', ffmpegDir || null);
  if (!ffmpeg) return { ok: false, error: 'ffmpeg 不可用' };

  try {
    const buf = execFileSync(ffmpeg, [
      '-ss', '2',                       // 跳到 2s 处，避开很多片头的纯黑帧
      '-i', filePath,
      '-vf', 'thumbnail,scale=160:-1',  // 抽一帧有代表性的画面，宽缩到 160
      '-frames:v', '1',
      '-q:v', '3',
      '-f', 'mjpeg', '-',
    ], { maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });

    if (!buf || buf.length < 200) {
      // 输出过小：基本可判定没有可用视频帧（纯音频等）
      return { ok: false, audio: true };
    }
    try { fs.writeFileSync(file, buf); } catch { /* 写缓存失败不影响本次返回 */ }
    return { ok: true, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, cached: false };
  } catch (e) {
    // 多半是纯音频文件：ffmpeg 找不到视频流直接报错
    return { ok: false, audio: true, error: e.message };
  }
}

/**
 * 进度条悬停预览用的「精灵图」(contact sheet) 生成。
 *
 * 沿时间轴均匀抽 count 帧、缩放成统一小格后拼成一张网格大图，
 * 渲染端 hover 进度条时按位置裁切其中一格显示 —— 单张图 + 纯 CSS 定位，
 * 比逐帧生成 N 张缩略图省一个数量级的 IPC 与解码开销。
 *
 * 结果按「文件哈希 + 帧数 + 取整时长」做缓存，落盘到 userData/thumbs。
 * 返回精灵图本身 + 网格元信息（cols/rows/count/cellW/cellH），
 * 渲染端据此把 hover 比例映射到具体某一格的 background-position。
 *
 * @param {string} filePath
 * @param {string|null} ffmpegDir
 * @param {{duration?:number, count?:number}} [opts]
 * @returns {{ok:true, dataUrl:string, cols:number, rows:number, count:number, cellW:number, cellH:number, cached:boolean}
 *          |{ok:false, audio?:true, error?:string}}
 */
const SHEET_CELL_W = 160;
const SHEET_CELL_H = 90;
const SHEET_COLS = 8;

function sheetFile(filePath, count, duration) {
  return path.join(thumbsDir(), `${cacheKey(filePath)}_sheet_${count}_${Math.round(duration || 0)}.jpg`);
}

function generateSheet(filePath, ffmpegDir, opts = {}) {
  const duration = Number(opts.duration) || 0;
  let count = Number(opts.count) || 0;
  if (!duration || duration < 1) return { ok: false, error: 'duration 未知' };

  if (!count) count = Math.round(duration / 45); // 约每 45s 一帧
  count = Math.max(4, Math.min(120, Math.round(count)));
  const cols = SHEET_COLS;
  const rows = Math.ceil(count / cols);
  const file = sheetFile(filePath, count, duration);

  if (fs.existsSync(file)) {
    try {
      const b64 = fs.readFileSync(file).toString('base64');
      return {
        ok: true,
        dataUrl: `data:image/jpeg;base64,${b64}`,
        cols, rows, count,
        cellW: SHEET_CELL_W, cellH: SHEET_CELL_H,
        cached: true,
      };
    } catch { /* 读缓存失败则重新生成 */ }
  }

  const ffmpeg = resolveBinary('ffmpeg', ffmpegDir || null);
  if (!ffmpeg) return { ok: false, error: 'ffmpeg 不可用' };

  // fps 滤镜按时间均匀取样：count/duration 帧/秒 → 整段均匀抽 count 帧；
  // tile 在流末会把未填满的网格 flush 出来（多余格留黑，渲染端不会索引到）。
  const fps = count / duration;
  try {
    const buf = execFileSync(ffmpeg, [
      '-ss', '0',
      '-i', filePath,
      '-vf', `fps=${fps.toFixed(4)},scale=${SHEET_CELL_W}:${SHEET_CELL_H},tile=${cols}x${rows}`,
      '-frames:v', '1',
      '-q:v', '4',
      '-f', 'mjpeg', '-',
    ], { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });

    if (!buf || buf.length < 400) {
      // 输出过小：基本可判定没有可用视频帧（纯音频等）
      return { ok: false, audio: true };
    }
    try { fs.writeFileSync(file, buf); } catch { /* 写缓存失败不影响本次返回 */ }
    return {
      ok: true,
      dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
      cols, rows, count,
      cellW: SHEET_CELL_W, cellH: SHEET_CELL_H,
      cached: false,
    };
  } catch (e) {
    // 多半是纯音频文件：ffmpeg 找不到视频流直接报错
    return { ok: false, audio: true, error: e.message };
  }
}

module.exports = { generate, generateSheet, thumbsDir };
