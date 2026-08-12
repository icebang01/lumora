/**
 * 播放列表面板(自包含模块)。
 * 从 app.js 拆出(2026-08):showPlaylist/renderPlaylist/拖拽排序/缩略图/面板开关。
 * 播放列表状态由 app.js 持有:playlist 数组用 Proxy 全转发(引用语义),
 * getPlaylistIndex() 用 ctx getter/setter 读写。
 * 用法:setupPlaylistPanel({ player, osd, playlist, getPlaylistIndex, setPlaylistIndex,
 *   playlistGoto, playlistRemove, persistPlaylist });(boot 时注入)
 */
import { isLiked, toggleLiked, onLikeChange } from '../core/likes.js';
import { collectDroppedPaths, endExternalDrag, naturalCompare } from '../input.js';

const $ = (id) => document.getElementById(id);

// 音频扩展名（与 panels/idle.js 的 AUDIO_EXT 保持一致）：音乐列表据此隐藏视频文件。
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|wma|ogg|opus|ac3|dts|eac3|mka|ape|tta|tak|alac|wv)$/i;
function isAudioPath(p) { return AUDIO_EXT.test(String(p || '')); }
// 音乐模式（audio-mode）下，播放列表仅显示音频，不显示视频。
function _playlistVisible(p) {
  if (!document.body.classList.contains('audio-mode')) return true;
  return isAudioPath(p);
}

let CTX = {};
export function setupPlaylistPanel(ctx) {
  CTX = ctx || {};
  const fbtn = $('playlist-like-filter');
  if (fbtn) {
    fbtn.classList.toggle('active', _likeFilter);
    fbtn.setAttribute('aria-pressed', _likeFilter ? 'true' : 'false');
    fbtn.addEventListener('click', () => {
      _likeFilter = !_likeFilter;
      fbtn.classList.toggle('active', _likeFilter);
      fbtn.setAttribute('aria-pressed', _likeFilter ? 'true' : 'false');
      renderPlaylist();
    });
  }
  // 添加音乐：弹出文件选择框，追加音频文件到当前播放列表
  const addBtn = $('playlist-add-music');
  if (addBtn) {
    addBtn.addEventListener('click', () => addMusicToPlaylist());
  }
  // 拖入文件到播放列表 ⇒ 作为「稍后播放」追加（不替换现有列表、不自动播放）
  const panel = $('playlist-panel');
  if (panel) {
    panel.addEventListener('dragenter', _onPanelDragEnter, true);
    panel.addEventListener('dragover', _onPanelDragOver, true);
    panel.addEventListener('dragleave', _onPanelDragLeave, true);
    panel.addEventListener('drop', _onPanelDrop, true);
  }

  // 收藏变化：面板打开时就地刷新徽标 / 过滤视图
  onLikeChange(({ path, liked }) => {
    const panel = $('playlist-panel');
    if (!panel || panel.classList.contains('hidden')) return;
    if (_likeFilter && !liked) {
      const el = _itemEls.get(path);
      if (el) { el.remove(); _itemEls.delete(path); _updatePlaylistCount(); }
      return;
    }
    const el = _itemEls.get(path);
    if (el && el._likeBtn) _paintLike(el._likeBtn, liked);
    if (el) el.classList.toggle('liked', liked);
  });
  // 监听 audio-mode 进出：音乐模式下隐藏视频，退出后恢复显示全部；面板开着时即时重渲染
  _observeAudioMode();
}

let _audioModeObserver = null;
let _lastAudioMode = null;
function _observeAudioMode() {
  if (_audioModeObserver) return;
  _audioModeObserver = new MutationObserver(() => {
    const now = document.body.classList.contains('audio-mode');
    if (now === _lastAudioMode) return;
    _lastAudioMode = now;
    const panel = $('playlist-panel');
    if (panel && !panel.classList.contains('hidden')) renderPlaylist();
  });
  _audioModeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a) };
// playlist 数组引用转发(方法自动 bind,保持 push/splice 等原地修改语义)
const playlist = new Proxy([], {
  get(_, k) {
    const arr = CTX.playlist;
    if (!arr) return undefined;
    const v = arr[k];
    return typeof v === 'function' ? v.bind(arr) : v;
  },
});
function getPlaylistIndex() { return CTX.getPlaylistIndex ? CTX.getPlaylistIndex() : -1; }
function setPlaylistIndex(i) { if (CTX.setPlaylistIndex) CTX.setPlaylistIndex(i); }
function playlistGoto(i) { if (CTX.playlistGoto) CTX.playlistGoto(i); }
function playlistRemove(i) { if (CTX.playlistRemove) CTX.playlistRemove(i); }
function persistPlaylist() { if (CTX.persistPlaylist) CTX.persistPlaylist(); }

/** 从文件对话框选择音频文件并追加到当前播放列表（不自动播放）。 */
export async function addMusicToPlaylist() {
  const audioExts = ['mp3', 'flac', 'aac', 'wav', 'ogg', 'opus', 'm4a', 'wma'];
  try {
    const r = await window.lumen.openDialog({
      title: '添加音乐',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频', extensions: audioExts },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (!r || !r.ok || !Array.isArray(r.paths) || !r.paths.length) return;
    for (const p of r.paths) playlist.push(p);
    persistPlaylist();
    renderPlaylist();
    osd.message('已添加', `${r.paths.length} 首音乐到播放列表`, { duration: 2000 });
  } catch (e) {
    console.error('[playlist] 添加音乐失败:', e);
    osd.message('添加失败', e && e.message ? e.message : '无法读取所选文件', { duration: 3000 });
  }
}

/** 判断拖放来源是操作系统文件管理器（携带 files / 文件型 items），区别于列表内部排序拖拽（仅 text/plain）。 */
function _dropHasFiles(dt) {
  if (!dt) return false;
  if (dt.files && dt.files.length) return true;
  if (dt.items && dt.items.length) {
    for (const it of dt.items) if (it && it.kind === 'file') return true;
  }
  return false;
}

// 以下三个捕获阶段监听器挂在 #playlist-panel 上，先于列表项自身的冒泡 drop 处理执行：
// 仅当检测到外部文件拖放时拦截（preventDefault + stopPropagation），阻断「窗口级拖放即播放」与「列表项排序」；
// 内部排序拖拽（无 files）则放行，交给列表项 handler 重排。

// 播放列表面板打开时，整个面板（左侧 backdrop + 右侧侧栏）都是「稍后播放」投放区：
// 外部文件拖放落到面板任意位置都追加到播放列表，不替换、不自动播放。
function _setDragAdd(on) {
  const panel = $('playlist-panel');
  if (panel) panel.classList.toggle('drag-add-active', !!on);
}
function _onPanelDragEnter(e) {
  if (!_dropHasFiles(e.dataTransfer)) return;
  e.preventDefault();
  _setDragAdd(true);
}
function _onPanelDragOver(e) {
  if (!_dropHasFiles(e.dataTransfer)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  _setDragAdd(true);
}
function _onPanelDragLeave(e) {
  const panel = $('playlist-panel');
  if (!panel) return;
  // 仅当真正离开面板（relatedTarget 不在面板内）才移除高亮，避免子元素间移动导致闪烁
  if (e.relatedTarget && panel.contains(e.relatedTarget)) return;
  _setDragAdd(false);
}
async function _onPanelDrop(e) {
  if (!_dropHasFiles(e.dataTransfer)) return; // 内部排序拖拽：放行给列表项 handler
  e.preventDefault();
  e.stopPropagation(); // 阻断窗口级「拖放即播放」handler 与列表项排序 handler
  _setDragAdd(false);
  endExternalDrag(); // 因上一步已 stopPropagation，窗口级 drop 不会执行，此处手动复位拖放遮罩与 depth
  await _appendDroppedAsLater(e.dataTransfer);
}

/** 把从系统拖入的文件/文件夹追加到当前播放列表，作为「稍后播放」（不自动播放、不替换现有列表）。 */
async function _appendDroppedAsLater(dt) {
  let rawPaths;
  try {
    rawPaths = collectDroppedPaths(dt);
  } catch (err) {
    console.error('[playlist] 拖放解析失败:', err);
    osd.message('拖放解析失败', '', { duration: 2200 });
    return;
  }
  if (!rawPaths.length) {
    osd.message('未识别到可播放的文件', '请拖入音视频文件或文件夹', { duration: 2400 });
    return;
  }
  let paths;
  try {
    const res = await window.lumen.collectMedia(rawPaths);
    paths = (res && res.ok && Array.isArray(res.paths) && res.paths.length) ? res.paths : rawPaths;
  } catch {
    paths = rawPaths;
  }
  // 音乐模式只收音频（与「添加音乐」按钮、列表可视过滤保持一致）
  if (document.body.classList.contains('audio-mode')) {
    paths = paths.filter(isAudioPath);
  }
  if (!paths.length) {
    osd.message('音乐模式下仅支持音频文件', '', { duration: 2400 });
    return;
  }
  paths.sort(naturalCompare);
  const before = playlist.length;
  for (const p of paths) playlist.push(p);
  persistPlaylist();
  renderPlaylist();
  const list = $('playlist-list');
  if (list) list.scrollTop = list.scrollHeight; // 滚到底展示新加入的「稍后播放」项
  const added = playlist.length - before;
  osd.message('已加入稍后播放', `${added} 首已添加到播放列表`, { duration: 2200 });
}

let dragSrcIndex = null;        // 当前被拖拽的播放列表项索引
let lastDropAt = 0;             // 最近一次落点时间戳，用于抑制拖拽后的误触单击
let _likeFilter = false;        // 是否只看「我喜欢的」
const _itemEls = new Map();     // path -> 列表项 DOM，便于收藏变化时就地更新
function baseName(p) { return String(p).split(/[\\/]/).pop(); }

export function showPlaylist() {
  if (playlist.length < 2) {
    osd.message('播放列表为空', '拖入多个文件即可建立列表', { duration: 3000 });
    return;
  }
  const lines = playlist
    .map((f, i) => `${i === getPlaylistIndex() ? '▶ ' : '   '}${i + 1}. ${baseName(f)}`)
    .slice(0, 8);
  osd.message(lines.join(' | '), undefined, { duration: 4000, key: 'playlist' });
}

/* ---------------- 可视化播放列表面板 ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 渲染列表内容到面板（拆分为「正在播放」+「接下来播放」两段队列） */
export function renderPlaylist() {
  const list = $('playlist-list');
  if (!list) return;
  list.innerHTML = '';
  _itemEls.clear();

  if (!playlist.length) {
    const empty = document.createElement('div');
    empty.className = 'playlist-empty';
    empty.textContent = '列表为空，拖入或打开多个文件即可建立';
    list.appendChild(empty);
    _updatePlaylistCount();
    return;
  }

  const activeIndex = getPlaylistIndex();

  // 过滤模式，或未开始播放（activeIndex<0）：保持扁平渲染，不做 Now Playing 拆分
  if (_likeFilter || activeIndex < 0) {
    playlist.forEach((p, i) => {
      if (_likeFilter && !isLiked(p)) return;
      if (!_playlistVisible(p)) return;
      list.appendChild(_createItem(p, i, {}));
    });
    _updatePlaylistCount();
    return;
  }

  // 正常视图：顶部「正在播放」固定展示当前曲目，下方「接下来播放」为可重排队列
  list.appendChild(_createItem(playlist[activeIndex], activeIndex, { nowPlaying: true }));
  const upcoming = playlist.filter((p, i) => i !== activeIndex && _playlistVisible(p));
  if (upcoming.length) {
    const header = document.createElement('div');
    header.className = 'pl-section-title';
    header.textContent = `接下来播放 · ${upcoming.length}`;
    list.appendChild(header);
    upcoming.forEach((p) => {
      list.appendChild(_createItem(p, playlist.indexOf(p), {}));
    });
  }

  _updatePlaylistCount();
}

/** 构造单个列表项 DOM（含缩略图 / 序号 / 标题 / 收藏 / 删除 / 拖拽排序）。
 *  opts.nowPlaying 为 true 时标记为「正在播放」：不可拖拽、不可点击跳转，仅作展示。 */
function _createItem(p, i, opts) {
  opts = opts || {};
  const item = document.createElement('div');
  item.className = 'playlist-item'
    + (i === getPlaylistIndex() ? ' active' : '')
    + (opts.nowPlaying ? ' now-playing' : '');
  item.draggable = !_likeFilter && !opts.nowPlaying;
  item.dataset.index = String(i);
  item.dataset.path = p;

  // 缩略图（异步拉取，渲染时先给占位渐变）
  const thumb = document.createElement('img');
  thumb.className = 'pl-thumb';
  thumb.alt = '';
  thumb.draggable = false;
  thumb.decoding = 'async';
  thumb.loading = 'lazy';
  item.appendChild(thumb);
  requestThumbnail(p, thumb);

  const idx = document.createElement('span');
  idx.className = 'pl-index';
  idx.textContent = String(i + 1);
  const title = document.createElement('span');
  title.className = 'pl-title';
  title.textContent = baseName(p);
  title.title = p;
  item.appendChild(idx);
  item.appendChild(title);

  // 「正在播放」徽标（仅当前曲目展示，强调队列语义）
  if (opts.nowPlaying) {
    const npTag = document.createElement('span');
    npTag.className = 'pl-nowplaying-tag';
    npTag.textContent = '正在播放';
    item.appendChild(npTag);
  }

  // 收藏红心徽标（点击切换，经 likes.js 广播统一刷新）
  const likeBtn = document.createElement('button');
  likeBtn.className = 'pl-like';
  likeBtn.title = '喜欢 / 取消';
  likeBtn.setAttribute('aria-label', '喜欢');
  _paintLike(likeBtn, isLiked(p));
  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLiked(p);
  });
  item.appendChild(likeBtn);

  const del = document.createElement('button');
  del.className = 'pl-del';
  del.textContent = '✕';
  del.title = '从列表移除';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    playlistRemove(i);
  });
  item.appendChild(del);

  item.classList.toggle('liked', isLiked(p));
  item._likeBtn = likeBtn;
  _itemEls.set(p, item);

  // 单击播放（正在播放项已是当前曲，无需跳转）；拖动松手后 250ms 内的误触单击被忽略
  if (!opts.nowPlaying) {
    item.addEventListener('click', () => {
      if (Date.now() - lastDropAt < 250) return;
      playlistGoto(i);
    });
    item.addEventListener('dblclick', (e) => { e.stopPropagation(); playlistGoto(i); });
  }

  /* ---------- 拖拽排序（正在播放项与过滤模式下禁用，避免索引错位） ---------- */
  if (!_likeFilter && !opts.nowPlaying) {
    item.addEventListener('dragstart', (e) => {
      dragSrcIndex = i;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* 部分环境不支持 */ }
      requestAnimationFrame(() => item.classList.add('dragging'));
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      clearDropIndicators();
      dragSrcIndex = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = item.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      clearDropIndicators();
      item.classList.add(after ? 'drop-after' : 'drop-before');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drop-before', 'drop-after');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drop-before', 'drop-after');
      if (dragSrcIndex === null || dragSrcIndex === i) return;
      const rect = item.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      lastDropAt = Date.now();
      reorderPlaylist(dragSrcIndex, i, after);
    });
  }

  return item;
}

/** 清掉所有拖拽落点指示线 */
export function clearDropIndicators() {
  document
    .querySelectorAll('#playlist-list .playlist-item.drop-before, #playlist-list .playlist-item.drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

/** 刷新单个红心徽标状态 */
function _paintLike(btn, liked) {
  btn.classList.toggle('liked', liked);
  btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  btn.textContent = '♥';
}

/** 刷新播放列表计数（过滤模式下显示已收藏数量；音乐模式显示可见音频数） */
function _updatePlaylistCount() {
  const count = $('playlist-count');
  if (!count) return;
  if (_likeFilter) count.textContent = `❤ ${_itemEls.size}`;
  else if (document.body.classList.contains('audio-mode')) count.textContent = `♪ ${_itemEls.size}`;
  else count.textContent = playlist.length ? `${getPlaylistIndex() + 1} / ${playlist.length}` : '';
}

/**
 * 把 from 项移动到 to 项之前或之后，并修正当前播放索引。
 * 重排后让当前播放项重新指向原来的文件，避免索引错位导致跳错片。
 */
export function reorderPlaylist(from, to, after) {
  if (from === to) return;
  const currentPath = playlist[getPlaylistIndex()];
  const moved = playlist.splice(from, 1)[0];
  let target = to + (after ? 1 : 0);
  if (from < target) target -= 1;            // 抽出后后续索引前移
  target = Math.max(0, Math.min(target, playlist.length));
  playlist.splice(target, 0, moved);
  setPlaylistIndex(currentPath ? playlist.indexOf(currentPath) : Math.min(getPlaylistIndex(), playlist.length - 1));
  if (getPlaylistIndex() < 0) setPlaylistIndex(0);
  persistPlaylist();
  renderPlaylist();
}

/** 串行队列拉取缩略图，避免一次性向主进程压太多 ffmpeg 请求卡住主线程 */
let thumbQueue = Promise.resolve();

/** 实际入队拉取缩略图（已避开首屏外项目） */
function fetchThumbnail(filePath, img) {
  if (img.dataset.loaded === '1') return;
  img.classList.add('pl-thumb-loading');
  thumbQueue = thumbQueue.then(async () => {
    // onload 在图片真正绘制完成后再淡入，避免空白闪烁；先于 src 赋值
    // 以保证即使是已缓存的 data-URL 也能触发过渡。
    img.onload = () => img.classList.add('thumb-loaded');
    try {
      const r = await window.lumen.getThumbnail(filePath);
      if (r && r.ok && r.dataUrl) img.src = r.dataUrl;
      else if (r && r.audio) img.src = THUMB_AUDIO;
      else img.src = THUMB_MISSING;
    } catch {
      img.src = THUMB_MISSING;
    } finally {
      img.classList.remove('pl-thumb-loading');
      img.dataset.loaded = '1';
    }
  });
}

/**
 * 请求缩略图：先用 IntersectionObserver 只在临近视口才真正入队。
 * 长媒体库滚动时，离屏海报不会发起 ffmpeg/解码/绘制，显著减少滚动卡顿。
 */
export function requestThumbnail(filePath, img) {
  if (img.dataset.loaded === '1' || img._thumbObserver) return;
  if ('IntersectionObserver' in window) {
    img._thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const target = entry.target;
          target._thumbObserver.unobserve(target);
          target._thumbObserver = null;
          fetchThumbnail(filePath, target);
        }
      }
    }, { root: null, rootMargin: '200px 0px' });
    img._thumbObserver.observe(img);
  } else {
    fetchThumbnail(filePath, img);
  }
}

/** 纯音频文件的封面占位 */
const THUMB_AUDIO = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 92 52'>` +
  `<rect width='92' height='52' rx='8' fill='#262936'/>` +
  `<g fill='#7c8cff'>` +
  `<ellipse cx='38' cy='34' rx='6' ry='4.5'/><ellipse cx='58' cy='30' rx='6' ry='4.5'/>` +
  `<rect x='42.5' y='14' width='2.4' height='20'/><rect x='62.5' y='10' width='2.4' height='20'/>` +
  `<path d='M42.5 14 L65 10 L65 14 L42.5 18 Z'/>` +
  `</g></svg>`);

/** 缩略图缺失（无视频帧且非音频）时的占位 */
const THUMB_MISSING = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 92 52'>` +
  `<rect width='92' height='52' rx='8' fill='#262936'/>` +
  `<g fill='none' stroke='#5a5f73' stroke-width='2'>` +
  `<rect x='36' y='18' width='20' height='16' rx='2'/>` +
  `<path d='M40 22 H52 M40 26 H52 M40 30 H52'/>` +
  `</g></svg>`);

export function togglePlaylistPanel() {
  const panel = $('playlist-panel');
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    renderPlaylist();
    panel.classList.remove('hidden');
    document.body.classList.add('playlist-open');
  } else {
    closePlaylistPanel();
  }
}

export function closePlaylistPanel() {
  const panel = $('playlist-panel');
  if (panel) panel.classList.add('hidden');
  document.body.classList.remove('playlist-open');
}
