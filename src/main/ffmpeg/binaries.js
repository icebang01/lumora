'use strict';
/**
 * FFmpeg 二进制定位。
 *
 * 查找优先级：显式配置 > 环境变量 > PATH > 平台常见安装位置。
 * 一次解析后缓存，避免每次启动解码都去探测文件系统。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXE = process.platform === 'win32' ? '.exe' : '';

// 仓库自带 bin/（git-bash 下为 D:/IDEA/videos/bin）：源码运行 / 独立 config-dir
// 测试实例（冒烟等，空 player.conf 无 mpv-dir/ffmpeg-dir）也能找到 mpv/ffmpeg。
// 路径相对本文件：src/main/ffmpeg/ → 仓库根。
let REPO_BIN = path.join(__dirname, '..', '..', '..', 'bin');

// 打包后修正：binaries.js 在 app.asar 内，__dirname 指向 app.asar/src/main/ffmpeg，
// 但 extraResources 把仓库 bin/ 复制到 resources/app/bin（asar 外可执行）。
// 当源码路径不存在时，回退到 resources/app/bin。
if (!fs.existsSync(REPO_BIN)) {
  try {
    const packagedBin = path.join(process.resourcesPath, 'app', 'bin');
    if (fs.existsSync(packagedBin)) REPO_BIN = packagedBin;
  } catch { /* 非 Electron 环境无需处理 */ }
}

const COMMON_DIRS = {
  win32: [
    REPO_BIN,
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    'C:\\ProgramData\\chocolatey\\bin',
    path.join(os.homedir(), 'scoop', 'shims'),
    path.join(os.homedir(), 'scoop', 'apps', 'ffmpeg', 'current', 'bin'),
  ],
  darwin: [REPO_BIN, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'],
  linux: [REPO_BIN, '/usr/bin', '/usr/local/bin', '/snap/bin'],
};

const cache = new Map();

function which(name) {
  // 先尝试系统自带的 where/which 命令
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* where/which 不可用或未找到，走手动搜索 */ }

  // 退化方案：手动遍历 PATH 环境变量查找可执行文件。
  // 某些精简版 Windows 或定制环境没有 where.exe，但 PATH 仍然有效。
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE').split(';')
    : [''];
  const sep = process.platform === 'win32' ? ';' : ':';
  const paths = (process.env.PATH || '').split(sep).filter(Boolean);
  for (const dir of paths) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch { /* 继续下一个 */ }
    }
  }
  return null;
}

/**
 * @param {'ffmpeg'|'ffprobe'} name
 * @param {string|null} configured 用户在 player.conf 中指定的路径（可以是目录或完整路径）
 */
function resolveBinary(name, configured = null) {
  const key = `${name}:${configured || ''}`;
  if (cache.has(key)) return cache.get(key);

  const candidates = [];

  if (configured) {
    // 配置项既可以是完整可执行文件路径，也可以是包含它的目录
    try {
      if (fs.existsSync(configured) && fs.statSync(configured).isDirectory()) {
        candidates.push(path.join(configured, name + EXE));
      } else {
        candidates.push(configured);
      }
    } catch { /* 路径不可访问就跳过 */ }
  }

  const envKey = name.toUpperCase() + '_PATH'; // FFMPEG_PATH / FFPROBE_PATH
  if (process.env[envKey]) candidates.push(process.env[envKey]);

  const fromPath = which(name + EXE);
  if (fromPath) candidates.push(fromPath);

  for (const dir of COMMON_DIRS[process.platform] || []) {
    candidates.push(path.join(dir, name + EXE));
  }

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
        cache.set(key, c);
        return c;
      }
    } catch { /* 继续尝试下一个候选 */ }
  }

  cache.set(key, null);
  return null;
}

/**
 * 读取 ffmpeg 版本与编译特性，用于统计面板展示和硬件解码能力判断。
 */
function probeCapabilities(ffmpegPath) {
  const result = { version: 'unknown', hwaccels: [], buildFlags: [] };
  if (!ffmpegPath) return result;
  try {
    const banner = execFileSync(ffmpegPath, ['-hide_banner', '-version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = banner.match(/ffmpeg version (\S+)/);
    if (m) result.version = m[1];
    const cfg = banner.match(/configuration:([^\n]*)/);
    if (cfg) {
      result.buildFlags = cfg[1].trim().split(/\s+/).filter((f) => f.startsWith('--enable-'));
      // GPL 检测：含 --enable-gpl 或已知 GPL 编码库即为 GPL 构建。
      // 商用分发必须改用 lgpl 构建（见 tools/fetch-ffmpeg.js）。
      const gplMarkers = [
        '--enable-gpl', '--enable-version3', '--enable-libx264',
        '--enable-libx265', '--enable-libxvid', '--enable-gplv3',
      ];
      result.gpl = result.buildFlags.some((f) => gplMarkers.includes(f));
      if (result.gpl) {
        console.warn(
          '[ffmpeg] 检测到 GPL 构建（含 ' +
            result.buildFlags.filter((f) => gplMarkers.includes(f)).join(', ') +
            '）。商用分发请改用 lgpl 构建：npm run fetch-deps',
        );
      } else {
        console.log('[ffmpeg] 确认为 LGPL 构建，可用于商用分发。');
      }
    }
  } catch { /* 版本读取失败不影响播放 */ }

  try {
    const hw = execFileSync(ffmpegPath, ['-hide_banner', '-hwaccels'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    result.hwaccels = hw.split(/\r?\n/).slice(1).map((s) => s.trim()).filter(Boolean);
  } catch { /* 硬解列表读取失败则按纯软解处理 */ }

  return result;
}

module.exports = { resolveBinary, probeCapabilities };
