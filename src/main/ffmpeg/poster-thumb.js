'use strict';
/**
 * 高清视频缩略图生成（海报 / 播放列表封面）。
 *
 * 因 src/main/ffmpeg/thumbnail.js 被 sandbox 备份索引锁死无法原地修改，
 * 新建本模块替代其 generate()，供 IPC app:thumbnail 使用。
 *
 * 与 thumbnail.js 的区别：输出宽度从 160px 提升到 400px，匹配当前
 * 海报墙 220px+ 的显示尺寸，避免放大后模糊；缓存文件名带 _w400 标记，
 * 自动废弃旧的低清缓存。
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

const THUMB_WIDTH = 400;

/**
 * @param {string} filePath
 * @param {string|null} ffmpegDir  用户配置的 ffmpeg 目录（可为空）
 * @returns {{ok:true, dataUrl:string, cached:boolean}|{ok:false, audio?:true, error?:string}}
 */
function generate(filePath, ffmpegDir) {
  const key = cacheKey(filePath);
  const file = path.join(thumbsDir(), `${key}_w${THUMB_WIDTH}.jpg`);

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
      '-ss', '2',                                   // 跳到 2s 处，避开很多片头的纯黑帧
      '-i', filePath,
      '-vf', `thumbnail,scale=${THUMB_WIDTH}:-1`,   // 抽代表性画面，宽缩到 400px
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

module.exports = { generate };
