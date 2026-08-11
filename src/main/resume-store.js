'use strict';
/**
 * 续播存储。
 *
 * 与 watch_later（按文件哈希存的精确 seek 点）不同，这里只保存
 * **最近一个媒体文件** 的快照，供 idle 屏的"继续观看"卡片展示用。
 * 两条机制同步写入，保证卡片上的时间点与真正 seek 到的位置一致。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function resumePath() {
  return path.join(app.getPath('userData'), 'resume.json');
}

/** 读取续播快照；损坏/不存在或媒体文件已失效返回 null */
function loadResume() {
  try {
    const p = resumePath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || !data.path) return null;
    if (!fs.existsSync(data.path)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 写入续播快照 */
function saveResume(entry) {
  try {
    fs.writeFileSync(resumePath(), JSON.stringify(entry), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 清除续播快照（自然播放到结尾时调用） */
function clearResume() {
  try {
    const p = resumePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* 清不掉也无所谓 */ }
}

module.exports = { loadResume, saveResume, clearResume };
