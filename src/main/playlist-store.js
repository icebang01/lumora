'use strict';
/**
 * 播放列表持久化存储（双列表：视频模式 / 音乐模式 各自独立）。
 *
 * 同时保存两个播放队列（video / audio），每个含 items 与当前播放索引 index，
 * 供下次启动分别恢复视频列表与音乐列表——两者不通用（用户需求）。
 * 与 resume-store 的区别：resume 只记"最近一个文件"，这里记"整个队列"。
 *
 * 兼容旧格式（单列表 { index, items }）：按文件扩展名拆分到 video / audio 两个列表，
 * 音频文件（mp3/flac/ogg 等）归入音乐列表，其余归入视频列表。
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

// 音频文件扩展名（与渲染端 app.js _modeForPath 保持一致）
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|wma|ogg|opus|ac3|dts|eac3|mka|ape|tta|tak|alac|wv)$/i;
function isAudioPath(p) { return AUDIO_EXT.test(String(p || '')); }

function playlistPath() {
  return path.join(app.getPath('userData'), 'playlist.json');
}

/** 清洗单个列表：过滤不存在的文件、修正 index 越界、标准化 item */
function _sanitize(d) {
  const out = { index: -1, items: [] };
  if (!d || !Array.isArray(d.items)) return out;
  out.items = d.items
    .filter((it) => it && it.path && fs.existsSync(it.path))
    .map((it) => ({
      path: it.path,
      title: it.title || undefined,
      duration: it.duration || undefined,
      time: it.time || undefined,
    }));
  if (out.items.length === 0) { out.index = -1; return out; }
  let idx = typeof d.index === 'number' ? d.index : 0;
  if (idx < 0 || idx >= out.items.length) idx = 0;
  out.index = idx;
  return out;
}

/** 读取播放列表；损坏/不存在/全空返回 null。返回 { video:{index,items}, audio:{index,items} } */
function loadPlaylist() {
  try {
    const p = playlistPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 旧格式兼容：{ index, items } → 按扩展名拆分到 video / audio
    if (data && Array.isArray(data.items)) {
      const sanitized = _sanitize(data);
      if (!sanitized.items.length) return null;
      const videoItems = [];
      const audioItems = [];
      for (const it of sanitized.items) {
        (isAudioPath(it.path) ? audioItems : videoItems).push(it);
      }
      let vIdx = videoItems.length ? sanitized.index : -1;
      const aIdx = audioItems.length ? 0 : -1;
      // 若原 index 指向的是音频项，video 列表无对应项时回 0
      if (vIdx >= videoItems.length) vIdx = videoItems.length ? 0 : -1;
      return {
        video: { index: vIdx, items: videoItems },
        audio: { index: aIdx, items: audioItems },
      };
    }
    if (!data || typeof data !== 'object') return null;
    const video = _sanitize(data.video);
    const audio = _sanitize(data.audio);
    if (video.items.length === 0 && audio.items.length === 0) return null;
    return { video, audio };
  } catch {
    return null;
  }
}

/** 写入播放列表。state 形如 { video:{index,items}, audio:{index,items} }（兼容旧单列表 {index,items}）。
 *  两个列表都为空时删除文件。 */
function savePlaylist(state) {
  try {
    let video, audio;
    if (state && Array.isArray(state.items)) {
      // 旧单列表格式：整体视为视频列表，音乐列表留空
      video = _sanitize(state);
      audio = { index: -1, items: [] };
    } else {
      video = _sanitize(state && state.video);
      audio = _sanitize(state && state.audio);
    }
    if (video.items.length === 0 && audio.items.length === 0) {
      clearPlaylist();
      return;
    }
    const clean = {
      video: video.items.length ? { index: video.index, items: video.items } : { index: -1, items: [] },
      audio: audio.items.length ? { index: audio.index, items: audio.items } : { index: -1, items: [] },
    };
    fs.writeFileSync(playlistPath(), JSON.stringify(clean), 'utf8');
  } catch { /* 写不进去就算了 */ }
}

/** 删除播放列表文件（两个列表都为空时调用） */
function clearPlaylist() {
  try {
    const p = playlistPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

module.exports = { loadPlaylist, savePlaylist, clearPlaylist };
