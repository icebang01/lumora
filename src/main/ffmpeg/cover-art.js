'use strict';
/**
 * 音频文件专辑封面提取。
 *
 * 从音频文件（mp3/flac/m4a/ape 等）的内嵌封面中抽出一张图，
 * 作为音频播放器模式的唱片封面。结果按路径+大小+修改时间缓存，
 * 避免同一首歌反复解码。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app } = require('electron');
const { resolveBinary } = require('./binaries');

const execFileAsync = promisify(execFile);

function coversDir() {
  const dir = path.join(app.getPath('userData'), 'covers');
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
 * @param {string|null} ffmpegDir
 * @returns {Promise<{ok:true, dataUrl:string, cached:boolean}|{ok:false, error?:string}>}
 */
async function extractCoverArt(filePath, ffmpegDir) {
  const key = cacheKey(filePath);
  const cache = path.join(coversDir(), key + '.jpg');

  if (fs.existsSync(cache)) {
    try {
      const b64 = fs.readFileSync(cache).toString('base64');
      return { ok: true, dataUrl: `data:image/jpeg;base64,${b64}`, cached: true };
    } catch { /* 读缓存失败则重新生成 */ }
  }

  const ffmpeg = resolveBinary('ffmpeg', ffmpegDir || null);
  if (!ffmpeg) return { ok: false, error: 'ffmpeg 不可用' };

  try {
    // 音频文件的内嵌封面会被 ffprobe 识别为 video stream（disposition.attached_pic=1）。
    // 用 -map 0:v:0 只取第一条视频流（封面），-frames:v 1 只抽一帧，
    // -vf scale=480:-1 限制高度避免特大图，-q:v 2 保证质量。
    // 注意：必须异步（execFile），绝不用 execFileSync —— 同步会阻塞主进程，
    // 导致抽封面期间 mpv↔渲染端协调停滞、整个应用卡顿（封面抽完才恢复）。
    const { stdout: buf } = await execFileAsync(ffmpeg, [
      '-i', filePath,
      '-an',
      '-map', '0:v:0',
      '-vf', 'scale=480:-1',
      '-frames:v', '1',
      '-q:v', '2',
      '-f', 'mjpeg', '-',
    ], { maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });

    if (!buf || buf.length < 200) {
      return { ok: false, error: 'no cover data' };
    }
    try { fs.writeFileSync(cache, buf); } catch { /* 写缓存失败不影响本次返回 */ }
    return { ok: true, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, cached: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { extractCoverArt };
