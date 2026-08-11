/**
 * 收藏 / 红心 共享存储。
 * 按媒体路径持久化到 localStorage，渲染端多个模块（音乐舞台、播放列表）共用，
 * 通过 onLikeChange 订阅保持 UI 同步，避免各模块各自维护一份导致状态漂移。
 */

const LIKE_KEY = 'lumen:liked';
let _set = null;
const _listeners = new Set();

function _load() {
  if (_set) return _set;
  _set = new Set();
  try {
    const raw = localStorage.getItem(LIKE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach((p) => { if (p) _set.add(p); });
    }
  } catch { /* localStorage 不可用则退化为内存态 */ }
  return _set;
}

function _persist() {
  try { localStorage.setItem(LIKE_KEY, JSON.stringify([..._load()])); } catch { /* ignore */ }
}

function _emit(path, liked) {
  _listeners.forEach((fn) => { try { fn({ path, liked }); } catch { /* noop */ } });
}

/** 是否已收藏 */
export function isLiked(path) {
  return !!(path && _load().has(path));
}

/** 设置收藏状态；状态实际变化时持久化并广播。返回最终状态。 */
export function setLiked(path, val) {
  if (!path) return false;
  const s = _load();
  const had = s.has(path);
  if (val) s.add(path); else s.delete(path);
  if (had !== val) { _persist(); _emit(path, val); }
  return val;
}

/** 切换收藏状态，返回切换后的状态。 */
export function toggleLiked(path) {
  return setLiked(path, !isLiked(path));
}

/** 订阅收藏变化，返回取消订阅函数。 */
export function onLikeChange(fn) {
  if (typeof fn === 'function') _listeners.add(fn);
  return () => _listeners.delete(fn);
}
