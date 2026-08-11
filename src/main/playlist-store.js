'use strict';
/**
 * 播放列表持久化存储。
 *
 * 保存当前的播放队列（items）与当前播放到的索引（index），
 * 供下次启动直接恢复整个列表 + 续播位置。
 * 与 resume-store 的区别：resume 只记"最近一个文件"，这里记"整个队列"。
 *
 * item 结构：{ path, title?, duration?, time? }
 *   - path    必填，媒体文件绝对路径
 *   - title   显示名（缺省时回退到文件名）
 *   - duration 时长（秒，可选）
 *   - time    已观看位置（秒，可选，用于续播）
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function playlistPath() {
  return path.join(app.getPath('userData'), 'playlist.json');
}

/** 读取播放列表；损坏/不存在/为空返回 null */
function loadPlaylist() {
  try {
    const p = playlistPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;
    // 过滤掉已不存在的文件，避免列表里躺着失效项
    data.items = data.items.filter((it) => it && it.path && fs.existsSync(it.path));
    if (data.items.length === 0) return null;
    if (typeof data.index !== 'number' || data.index < 0 || data.index >= data.items.length) {
      data.index = 0;
    }
    return data;
  } catch {
    return null;
  }
}

/** 写入播放列表 */
function savePlaylist(state) {
  try {
    if (!state || !Array.isArray(state.items) || state.items.length === 0) {
      clearPlaylist();
      return;
    }
    const clean = {
      index: typeof state.index === 'number' ? state.index : 0,
      items: state.items
        .filter((it) => it && it.path)
        .map((it) => ({
          path: it.path,
          title: it.title || undefined,
          duration: it.duration || undefined,
          time: it.time || undefined,
        })),
    };
    if (clean.items.length === 0) { clearPlaylist(); return; }
    fs.writeFileSync(playlistPath(), JSON.stringify(clean), 'utf8');
  } catch { /* 写不进去就算了 */ }
}

/** 删除播放列表文件（清空时调用） */
function clearPlaylist() {
  try {
    const p = playlistPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

module.exports = { loadPlaylist, savePlaylist, clearPlaylist };
