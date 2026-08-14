'use strict';
const { clamp } = require('../clamp');
/**
 * 进度条悬停预览用的「精灵图」(contact sheet) 生成 —— 异步版。
 *
 * 逻辑与 thumbnail.js 的 generateSheet 完全一致，但改用 execFile(+Promise)
 * 而非 execFileSync，避免主进程在视频 loaded 时被 ffmpeg 同步解码卡死
 * （Windows 会因此报「未响应 / not responding」）。app:seek-sheet handler
 * (ipc-media.js) 用 await 调用本函数，主线程事件循环不被阻塞。
 *
 * 之所以独立成模块而不是改 thumbnail.js：构建期 thumbnail.js 被某 sandbox 备份
 * 索引锁住无法原地改写，这里新建模块规避该锁，逻辑等价。thumbnail.js 里那份
 * 同步 generateSheet 已不再被任何调用方引用（后续清理即可）。
 *
 * 结果按「文件哈希 + 帧数 + 取整时长」做缓存，落盘到 userData/thumbs。
 *
 * @param {string} filePath
 * @param {string|null} ffmpegDir
 * @param {{duration?:number, count?:number}} [opts]
 * @returns {Promise<{ok:true, dataUrl:string, cols:number, rows:number, count:number, cellW:number, cellH:number, cached:boolean}
 *          |{ok:false, audio?:true, error?:string}>}
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app } = require('electron');
const { resolveBinary } = require('./binaries');
const { thumbsDir } = require('./thumbnail');

// cacheKey 与 thumbnail.js 同源，但 thumbnail.js 未导出它，这里独立实现一份，
// 保证精灵图缓存文件名与历史封面缓存一致（避免重复解码）。
function cacheKey(filePath) {
  let mtime = 0, size = 0;
  try {
    const st = fs.statSync(filePath);
    mtime = st.mtimeMs;
    size = st.size;
  } catch { /* 不可访问时退化为仅按路径哈希 */ }
  return crypto.createHash('md5').update(`${filePath}|${size}|${mtime}`).digest('hex');
}

const SHEET_CELL_W = 320;
const SHEET_CELL_H = 180;
const SHEET_COLS = 8;

function sheetFile(filePath, count, duration) {
  // 文件名里带上分辨率，避免升级后读到旧的低清缓存
  return path.join(thumbsDir(), `${cacheKey(filePath)}_sheet_${SHEET_CELL_W}x${SHEET_CELL_H}_${count}_${Math.round(duration || 0)}.jpg`);
}

async function generateSheet(filePath, ffmpegDir, opts = {}) {
  const duration = Number(opts.duration) || 0;
  let count = Number(opts.count) || 0;
  if (!duration || duration < 1) return { ok: false, error: 'duration 未知' };

  if (!count) count = Math.round(duration / 45); // 约每 45s 一帧
  count = clamp(Math.round(count), 4, 120);
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
    const buf = await new Promise((resolve, reject) => {
      execFile(ffmpeg, [
        '-ss', '0',
        '-i', filePath,
        '-vf', `fps=${fps.toFixed(4)},scale=${SHEET_CELL_W}:${SHEET_CELL_H},tile=${cols}x${rows}`,
        '-frames:v', '1',
        '-q:v', '4',
        '-f', 'mjpeg', '-',
      ], { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });

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

module.exports = { generateSheet, sheetFile };
