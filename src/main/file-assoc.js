/**
 * 文件关联与播放列表收集(自包含模块)。
 * 从 index.js 拆出(2026-08):applyFileAssociation / collectMediaFromSelection。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { execFileSync } = require('child_process');

/* ------------------------------------------------------------------ */
/* 文件关联（双击用 Lumora 打开）                                        */
/* ------------------------------------------------------------------ */

// 要关联的媒体扩展名
const ASSOC_EXTENSIONS = [
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'ts', 'm2ts', 'wmv',
  'mpg', 'mpeg', 'm4v', '3gp', 'ogv', 'mp3', 'flac', 'aac', 'wav',
  'ogg', 'opus', 'm4a', 'wma',
];
const PROG_ID = 'Lumora.MediaFile';

/**
 * 在 HKCU（当前用户，无需管理员）下写入/清除文件关联。
 * 这样"打开方式 → 始终使用 Lumora"以及双击默认程序都能生效。
 * 安装包（electron-builder fileAssociations）会在系统级做同样的事，
 * 这里给"不重装就能改默认播放器"的用户一个即时入口。
 *
 * @returns {{ok:boolean, error?:string}}
 */
function applyFileAssociation(enable) {
  try {
    const exe = app.getPath('exe');
    const openCmd = `"${exe}" "%1"`;
    const tasks = [];
    if (enable) {
      tasks.push(['add', `HKCU\\Software\\Classes\\${PROG_ID}`, '/ve', '/t', 'REG_SZ', '/d', 'Lumora 媒体文件', '/f']);
      tasks.push(['add', `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', openCmd, '/f']);
      for (const ext of ASSOC_EXTENSIONS) {
        tasks.push(['add', `HKCU\\Software\\Classes\\.${ext}`, '/ve', '/t', 'REG_SZ', '/d', PROG_ID, '/f']);
      }
    } else {
      for (const ext of ASSOC_EXTENSIONS) {
        // 仅当我们自己写的值才清掉，不碰其它程序注册的
        tasks.push(['delete', `HKCU\\Software\\Classes\\.${ext}`, '/v', PROG_ID, '/f']);
      }
      tasks.push(['delete', `HKCU\\Software\\Classes\\${PROG_ID}`, '/f']);
    }
    for (const args of tasks) {
      // reg 命令串行执行，避免并发写同一键
      try {
        execFileSync('reg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        console.warn('[assoc] reg 失败:', args.join(' '), e.message);
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* 播放列表辅助                                                         */
/* ------------------------------------------------------------------ */

// 文件夹里要自动纳入播放列表的媒体扩展名
const PLAYLIST_EXT = new Set([
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'ts', 'm2ts', 'wmv',
  'mpg', 'mpeg', 'm4v', '3gp', 'ogv', 'mp3', 'flac', 'aac', 'wav',
  'ogg', 'opus', 'm4a', 'wma',
]);

/**
 * 把文件选择结果展开成媒体文件列表。
 * - 直接选的文件原样保留（即使不在白名单内，给用户最大自由度）
 * - 选中的文件夹递归列出其中的媒体文件，按文件名排序
 */
function collectMediaFromSelection(filePaths) {
  const out = [];
  for (const p of filePaths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const walk = (dir) => {
          let ents = [];
          try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            const full = path.join(dir, e.name);
            try {
              if (e.isDirectory()) walk(full);
              else if (PLAYLIST_EXT.has(path.extname(e.name).slice(1).toLowerCase())) out.push(full);
            } catch { /* ignore */ }
          }
        };
        walk(p);
        out.sort((a, b) => a.localeCompare(b));
      } else {
        out.push(p);
      }
    } catch { /* 不存在就跳过 */ }
  }
  return out;
}

/**
 * 给定单个文件路径，返回它所在目录中所有媒体文件（含自身），按文件名自然排序。
 * 用于"拖入单个文件 → 自动把同目录其他媒体也加进播放列表"。
 * 目录读取失败时退化为只返回 [filePath]，保证至少能播当前文件。
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function scanSiblings(filePath) {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return [filePath]; }
    const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    const siblings = ents
      .filter((e) => !e.isDirectory() && PLAYLIST_EXT.has(path.extname(e.name).slice(1).toLowerCase()))
      .map((e) => path.join(dir, e.name))
      .sort(cmp);
    // 原始文件若不在媒体白名单内（罕见），也强制保留并插到自然排序位置
    if (!siblings.some((p) => path.basename(p) === base)) {
      siblings.push(filePath);
      siblings.sort(cmp);
    }
    return siblings;
  } catch {
    return [filePath];
  }
}

module.exports = { applyFileAssociation, collectMediaFromSelection, scanSiblings };

/* ------------------------------------------------------------------ */
