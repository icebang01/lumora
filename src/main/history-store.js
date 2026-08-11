'use strict';
/**
 * 播放历史存储。
 *
 * 与 resume-store（只存最近一个未看完文件的续播点）不同，这里保存
 * **最近播放过的文件列表**，供 idle 屏"最近播放"区域展示。
 * 上限 LIMIT 条（来自配置 history-count，默认 5，可 1~50 调节），
 * 同路径再次播放时移到最前。idle 屏"最近播放"最多展示 LIMIT 条。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_LIMIT = 5;
// 当前"最近播放"保留/展示上限。默认 5，由 setHistoryLimit() 从配置 history-count 同步。
let LIMIT = DEFAULT_LIMIT;

/**
 * 设置"最近播放"保留/展示上限（来自配置 history-count）。
 * 传入非数字或越界值会被夹紧到 [1, 50]。
 * @param {number|string} n
 */
function setHistoryLimit(n) {
  const v = parseInt(n, 10);
  if (Number.isFinite(v)) LIMIT = Math.min(50, Math.max(1, v));
}

// 规范化用于去重比较：统一为正斜杠 + 小写，忽略路径分隔符/大小写差异
function normKey(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

/** 读取历史列表（新→旧）；损坏/不存在返回空数组；自动折叠同文件的重复项 */
function loadHistory() {
  try {
    const p = historyPath();
    if (!fs.existsSync(p)) { console.log('[history] 文件不存在:', p); return []; }
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) { console.warn('[history] 内容非数组，重置'); return []; }
    const seen = new Set();
    const out = [];
    for (const e of arr) {
      if (!e || !e.path) continue;
      const key = normKey(e.path);
      if (seen.has(key)) continue; // 保留最先出现的（即最新的）一条
      seen.add(key);
      out.push(e);
    }
    const result = out.slice(0, LIMIT);
    if (!result.length) console.log('[history] 去重后为空（原始 %d 条)', arr.length);
    return result;
  } catch (err) {
    console.error('[history] loadHistory 异常:', err.message);
    return [];
  }
}

function saveHistory(arr) {
  try {
    fs.writeFileSync(historyPath(), JSON.stringify(arr), 'utf8');
    return true;
  } catch (err) {
    console.error('[history] saveHistory 写入失败:', err.message);
    return false;
  }
}

/** 记录一次播放；同路径移到最前，超出上限裁剪 */
function addHistory(entry) {
  if (!entry || !entry.path) return loadHistory();
  const list = loadHistory();
  const key = normKey(entry.path);
  const idx = list.findIndex((e) => normKey(e.path) === key);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift({
    path: entry.path,
    title: entry.title || path.basename(entry.path),
    duration: entry.duration || 0,
    lastPlayed: Date.now(),
  });
  const trimmed = list.slice(0, LIMIT);
  saveHistory(trimmed);
  return trimmed;
}

/** 清空历史 */
function clearHistory() {
  try {
    const p = historyPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* 清不掉也无所谓 */ }
}

/** 删除单条历史（按规范化路径匹配） */
function removeHistory(entryPath) {
  if (!entryPath) return loadHistory();
  const key = normKey(entryPath);
  const list = loadHistory().filter((e) => normKey(e.path) !== key);
  saveHistory(list);
  return list;
}

module.exports = { loadHistory, addHistory, clearHistory, removeHistory, setHistoryLimit, MAX: DEFAULT_LIMIT };
