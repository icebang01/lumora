// 歌词自动偏移校准：用 ffmpeg 提取音频「人声频段」能量随时间的变化，
// 找到第一个明显起音（歌手/伴奏开始处），与 LRC 首行时间戳比较，
// 算出应施加的歌词偏移，使歌词高亮自动对齐音频。
//
// 说明：这是最佳努力（best-effort）校准。带长伴奏前奏的歌可能把「前奏起音」误判为
// 「人声起音」，导致偏移偏早；此时用户仍可用歌词区底部的 -0.5s/+0.5s 工具条手动修正
// （手动修正会覆盖自动值并持久化）。校准结果按曲目缓存，不重复跑 ffmpeg。
'use strict';
const { spawn } = require('child_process');

/**
 * 解析 ffmpeg ebur128 的 stderr 输出，返回 [timeSec, momentaryLoudness] 序列。
 * ebur128 逐帧输出形如：
 *   [Parsed_ebur128_0 @ 0x...] t: 1.2s TARGET:-23 LUFS M: -18.2 S: -30.1 I: -25.0 LUFS LRA: 12.3
 * @param {string} text ffmpeg stderr
 * @param {number} maxSec 只取 [0, maxSec] 内的点
 * @returns {Array<[number, number]>}
 */
function parseEbur128Series(text, maxSec) {
  const out = [];
  const re = /t:\s*([\d.]+)\s*s[^\n]*?M:\s*(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const t = parseFloat(m[1]);
    const loud = parseFloat(m[2]);
    if (Number.isFinite(t) && Number.isFinite(loud) && t <= maxSec) out.push([t, loud]);
  }
  return out;
}

/**
 * 从 ebur128 序列中找第一个明显起音的时间（秒）。
 * 阈值 = 窗口内峰值响度 - 12 LU（下限 -50 LU），即「明显超过安静基线」的第一刻。
 * @param {string} text ffmpeg stderr
 * @param {number} maxSec 分析窗口上限（秒）
 * @returns {number|null}
 */
function parseVocalOnset(text, maxSec) {
  const pts = parseEbur128Series(text, maxSec);
  if (!pts.length) return null;
  let maxM = -Infinity;
  for (const [, m] of pts) if (m > maxM) maxM = m;
  const thr = Math.max(maxM - 12, -50);
  for (const [t, m] of pts) {
    if (m >= thr) return t;
  }
  return null;
}

/**
 * 跑 ffmpeg 检测音频首个明显起音。
 * @param {string} filePath 本地音频文件路径
 * @param {string} ffmpegPath ffmpeg 可执行文件路径
 * @param {number} [maxSec=40] 只分析前若干秒（歌词一般 40s 内开始）
 * @returns {Promise<number|null>} 起音时间（秒），失败/无 ffmpeg 返回 null
 */
function detectVocalOnset(filePath, ffmpegPath, maxSec = 40) {
  return new Promise((resolve) => {
    if (!ffmpegPath || typeof filePath !== 'string' || !filePath) return resolve(null);
    // 仅对本地文件做校准；网络串流跳过（避免阻塞/鉴权问题）
    if (/^(https?|rtsp|rtmp|mms):/i.test(filePath)) return resolve(null);
    const args = [
      '-hide_banner', '-nostats',
      '-i', filePath,
      '-vn',
      '-af', 'bandpass=f=1000:width_type=h:width=2700,ebur128',
      '-t', String(maxSec),
      '-f', 'null', '-',
    ];
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (e) {
      return resolve(null);
    }
    let out = '';
    const onData = (d) => { out += d.toString(); };
    if (proc.stderr) proc.stderr.on('data', onData);
    const finish = () => resolve(parseVocalOnset(out, maxSec));
    proc.on('error', () => resolve(null));
    proc.on('close', finish);
    // 安全超时：分析窗口 + 余量，避免 ffmpeg 卡死挂起主进程
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish();
    }, (maxSec + 15) * 1000);
    // close 后清掉定时器
    proc.on('close', () => clearTimeout(timer));
  });
}

/**
 * 计算应施加的歌词偏移（秒）。
 * 偏移 = 音频首句起音时间 - LRC 首行时间戳；
 * 正值=歌词整体延后（音频前奏比 LRC 假设的长），负值=歌词提前。
 * 超出 [-10, +30] 视为误检，返回 null（不覆盖手动修正）。
 * @param {string} filePath 本地音频文件路径
 * @param {number} firstLineTime LRC 首行时间戳（秒）
 * @param {string} ffmpegPath ffmpeg 可执行文件路径
 * @param {number} [maxSec=40]
 * @returns {Promise<number|null>}
 */
async function computeLyricAutoOffset(filePath, firstLineTime, ffmpegPath, maxSec = 40) {
  if (typeof firstLineTime !== 'number' || !Number.isFinite(firstLineTime)) return null;
  const onset = await detectVocalOnset(filePath, ffmpegPath, maxSec);
  if (onset == null) return null;
  const off = Math.round((onset - firstLineTime) * 100) / 100;
  if (off < -10 || off > 30) return null;
  return off;
}

module.exports = { parseEbur128Series, parseVocalOnset, detectVocalOnset, computeLyricAutoOffset };
