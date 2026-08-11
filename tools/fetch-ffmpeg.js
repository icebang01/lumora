#!/usr/bin/env node
'use strict';
/**
 * 拉取 LGPL 构建的 FFmpeg / ffprobe，替换 bin/ 下随附的 GPL 构建。
 *
 * 为什么需要它：
 *   bin/ 里最初放的是 gyan.dev 的 GPL 构建（含 --enable-gpl --enable-version3
 *   以及 libx264/libx265/libxvid 等 GPL 编码库），分发即触发完整 GPL 义务。
 *   播放器只需要"解码"，LGPL 构建已包含全部所需解码器（H.264/HEVC/AAC/…）
 *   与滤镜（scale/format/atempo），无任何 GPL 组件。
 *
 * 用法：
 *   node tools/fetch-ffmpeg.js            # 用默认 LGPL 构建源
 *   FFMPEG_LGPL_URL=... node tools/fetch-ffmpeg.js
 *
 * 仅 Windows 目标（用 PowerShell 的 Expand-Archive 解压，零额外依赖）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const BIN_DIR = path.resolve(__dirname, '..', 'bin');
const DEFAULT_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip';
const URL = process.env.FFMPEG_LGPL_URL || DEFAULT_URL;

/** 跟随重定向下载文件 */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(download(res.headers.location, dest));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Windows 目标：用 PowerShell 内置 Expand-Archive，无需第三方依赖 */
function extractZip(zipPath, outDir) {
  const ps = `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}'`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
}

async function main() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const tmp = path.join(os.tmpdir(), `lumora-ffmpeg-${Date.now()}.zip`);
  console.log(`[fetch-ffmpeg] 下载 LGPL 构建：\n  ${URL}`);
  await download(URL, tmp);

  console.log('[fetch-ffmpeg] 解压中…');
  const extractDir = path.join(os.tmpdir(), `lumora-ffmpeg-extract-${Date.now()}`);
  extractZip(tmp, extractDir);

  // BtbN 的 zip 内结构通常带版本前缀文件夹（如 ffmpeg-master-latest-win64-lgpl/bin/...），
  // 用递归查找容错，避免硬编码 bin/ 路径。
  const found = {};
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'ffmpeg.exe' || e.name === 'ffprobe.exe') found[e.name] = p;
    }
  })(extractDir);

  let copied = 0;
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const from = found[name];
    if (!from) {
      console.warn(`[fetch-ffmpeg] 警告：压缩包内未找到 ${name}`);
      continue;
    }
    fs.copyFileSync(from, path.join(BIN_DIR, name));
    copied++;
  }

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(tmp, { force: true });

  if (copied === 0) throw new Error('没有复制任何可执行文件，请检查压缩包结构');

  // 校验：确认是 LGPL（不含 GPL 标记）
  try {
    const out = execFileSync(path.join(BIN_DIR, 'ffmpeg.exe'), ['-hide_banner', '-version'], {
      encoding: 'utf8',
    });
    // GPL 触发条件：显式 --enable-gpl，或包含 GPL 编码器（libx264/265/xvid）。
    // 注意：--enable-version3 单独出现仅表示 (L)GPL 升到 v3（本构建为 LGPLv3，合法可分发的 LGPL），不算 GPL。
    const gpl = /--enable-gpl\b/.test(out) || /--enable-(libx264|libx265|libxvid)\b/.test(out);
    const version3 = /--enable-version3\b/.test(out);
    const ver = (out.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown';
    console.log(
      `[fetch-ffmpeg] 已写入 bin/ffmpeg.exe (${ver}) — ${
        gpl ? '仍为 GPL，请更换源' : `LGPL${version3 ? 'v3' : 'v2.1'} ✓ 可用于商用分发`
      }`,
    );
  } catch (e) {
    console.warn('[fetch-ffmpeg] 版本校验跳过：', e.message);
  }

  console.log(
    '[fetch-ffmpeg] 完成。mpv 仍为 GPLv2+ 组件（聚合分发，源码见 THIRD_PARTY_LICENSES.md）。',
  );
}

main().catch((e) => {
  console.error('[fetch-ffmpeg] 失败：', e.message);
  process.exit(1);
});
