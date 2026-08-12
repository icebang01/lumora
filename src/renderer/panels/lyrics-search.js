/**
 * 手动搜索歌词弹窗。
 *
 * 自动下载失败时，多半是本地元数据（歌名/歌手/专辑）和在线源对不上。
 * 这里提供一个对话框：预填当前曲目信息，用户可修改关键词后重新搜索，
 * 列出 LRCLIB 候选结果（含是否已同步歌词、时长匹配），选择后保存到本地并应用。
 *
 * 风格复用全局设计令牌（accent 渐变 + 毛玻璃），与 audio-unlock 等浮层一致。
 *
 * API：openLyricsSearch({ path, title, artist, album, duration, info, onApply })
 *   - onApply(lines, lrcMeta, info)：用户选中候选并保存成功后回调，由调用方渲染歌词。
 */

let overlayEl = null;
let cardEl = null;
let statusEl = null;
let resultsEl = null;
let titleInput = null;
let artistInput = null;
let visible = false;

// 当前上下文（跨回调使用）
let _ctx = { path: '', title: '', artist: '', album: '', duration: 0, info: null, onApply: null };
let _searching = false;
let _dragCleanup = null;

function fmtDur(sec) {
  const s = Number(sec) || 0;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function ensureDom() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.className = 'lyric-search-overlay';
  overlayEl.setAttribute('role', 'dialog');
  overlayEl.setAttribute('aria-modal', 'true');
  overlayEl.setAttribute('aria-label', '搜索歌词');
  overlayEl.innerHTML = `
    <div class="lyric-search-card" role="document">
      <div class="lyric-search-head">
        <div class="lyric-search-title">搜索歌词</div>
        <button class="lyric-search-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="lyric-search-form">
        <label class="lsq-field">
          <span class="lsq-label">歌名</span>
          <input class="lsq-input" id="lsq-title" type="text" autocomplete="off" placeholder="修改歌名后更准确" />
        </label>
        <label class="lsq-field">
          <span class="lsq-label">歌手</span>
          <input class="lsq-input" id="lsq-artist" type="text" autocomplete="off" placeholder="修改歌手" />
        </label>
        <button class="lyric-search-btn" id="lsq-search" type="button">搜索</button>
      </div>
      <div class="lyric-search-status" id="lsq-status"></div>
      <div class="lyric-search-results" id="lsq-results"></div>
      <div class="lyric-search-foot">提示：自动下载失败通常是歌名/歌手对不上，修改关键字后再搜即可。</div>
    </div>`;
  cardEl = overlayEl.querySelector('.lyric-search-card');
  statusEl = overlayEl.querySelector('#lsq-status');
  resultsEl = overlayEl.querySelector('#lsq-results');
  titleInput = overlayEl.querySelector('#lsq-title');
  artistInput = overlayEl.querySelector('#lsq-artist');
  overlayEl.querySelector('.lyric-search-close').addEventListener('click', hideLyricsSearch);
  overlayEl.querySelector('#lsq-search').addEventListener('click', doSearch);
  // 点击遮罩空白处关闭
  overlayEl.addEventListener('mousedown', (e) => { if (e.target === overlayEl) hideLyricsSearch(); });
  // 拖拽：按住标题栏可移动弹窗
  const head = overlayEl.querySelector('.lyric-search-head');
  head.addEventListener('mousedown', startDragCard);
  // ESC 关闭
  overlayEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideLyricsSearch(); });
  // 回车触发搜索（在输入框内）
  [titleInput, artistInput].forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  });

  document.body.appendChild(overlayEl);
}

function resetCardPosition() {
  if (!cardEl) return;
  cardEl.style.position = '';
  cardEl.style.left = '';
  cardEl.style.top = '';
  cardEl.style.margin = '';
  cardEl.style.transform = '';
}

function startDragCard(e) {
  // 点击关闭按钮时不触发拖拽
  if (e.target.closest('.lyric-search-close')) return;
  if (!cardEl) return;
  const rect = cardEl.getBoundingClientRect();
  const offsetX = e.clientX - rect.left;
  const offsetY = e.clientY - rect.top;
  const prevBodyCursor = document.body.style.cursor;
  const prevUserSelect = document.body.style.userSelect;

  // 把卡片从 flex 居中切换为 fixed 定位，避免父容器影响
  cardEl.style.position = 'fixed';
  cardEl.style.left = `${rect.left}px`;
  cardEl.style.top = `${rect.top}px`;
  cardEl.style.margin = '0';
  cardEl.style.transform = 'scale(1)';
  document.body.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';

  function onMove(ev) {
    if (!cardEl) return;
    let nx = ev.clientX - offsetX;
    let ny = ev.clientY - offsetY;
    const pad = 20;
    const maxX = window.innerWidth - pad;
    const maxY = window.innerHeight - pad;
    nx = Math.max(pad - rect.width, Math.min(nx, maxX));
    ny = Math.max(pad - rect.height, Math.min(ny, maxY));
    cardEl.style.left = `${nx}px`;
    cardEl.style.top = `${ny}px`;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = prevBodyCursor;
    document.body.style.userSelect = prevUserSelect;
    _dragCleanup = null;
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  _dragCleanup = onUp;
  e.preventDefault();
}

function showLyricsSearch(opts) {
  ensureDom();
  if (_dragCleanup) { _dragCleanup(); }
  resetCardPosition();
  _ctx = Object.assign({ path: '', title: '', artist: '', album: '', duration: 0, info: null, onApply: null }, opts || {});
  titleInput.value = _ctx.title || '';
  artistInput.value = _ctx.artist || '';
  statusEl.textContent = '';
  resultsEl.innerHTML = '';
  // 自适应当前播放器样式背景色：把 #music-stage 的 style-* 类同步到弹窗卡片
  try {
    const stage = document.getElementById('music-stage');
    const styleClass = stage && Array.from(stage.classList).find((c) => /^style-/.test(c));
    cardEl.className = 'lyric-search-card' + (styleClass ? ' ' + styleClass : '');
  } catch { /* noop */ }
  visible = true;
  overlayEl.classList.add('show');
  setTimeout(() => { try { titleInput.focus(); titleInput.select(); } catch { /* noop */ } }, 60);
}

function hideLyricsSearch() {
  if (!visible || !overlayEl) return;
  visible = false;
  overlayEl.classList.remove('show');
  if (_dragCleanup) { _dragCleanup(); }
}

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'lyric-search-status' + (kind ? ` lsq-${kind}` : '');
}

async function doSearch() {
  if (_searching) return;
  const path = _ctx.path;
  if (!path) { setStatus('当前曲目无效，无法搜索', 'err'); return; }
  const title = titleInput.value.trim();
  const artist = artistInput.value.trim();
  const album = (_ctx.album || '').trim();
  const duration = Number(_ctx.duration) || 0;
  if (!title && !artist) { setStatus('请至少填写歌名或歌手', 'err'); return; }

  if (!window.lumen || !window.lumen.searchLyrics) { setStatus('搜索不可用', 'err'); return; }

  _searching = true;
  setStatus('搜索中…');
  resultsEl.innerHTML = '';
  try {
    const r = await window.lumen.searchLyrics(path, { title, artist, album, duration });
    if (r && r.ok && Array.isArray(r.candidates) && r.candidates.length) {
      if (r.candidates.length === 1 && r.candidates[0].hasSync) {
        // 只有一条且带同步歌词时，仍可让用户确认；这里直接渲染列表更稳妥
      }
      setStatus(`找到 ${r.candidates.length} 条结果`, 'ok');
      renderResults(r.candidates);
    } else {
      const why = (r && r.error) ? r.error : '';
      setStatus(`未找到歌词${why ? '（' + why + '）' : ''}，试试换关键词`, 'err');
    }
  } catch (e) {
    setStatus(`搜索失败${e && e.message ? '：' + e.message : ''}`, 'err');
  } finally {
    _searching = false;
  }
}

function renderResults(candidates) {
  resultsEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  candidates.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = 'lsq-item' + (c.hasSync ? ' lsq-has-sync' : ' lsq-no-sync');
    const syncTag = c.hasSync
      ? '<span class="lsq-tag lsq-tag-sync">已同步</span>'
      : '<span class="lsq-tag lsq-tag-plain">纯文本</span>';
    const dur = c.duration ? `<span class="lsq-dur">${fmtDur(c.duration)}</span>` : '';
    item.innerHTML = `
      <div class="lsq-item-main">
        <div class="lsq-item-title">${esc(c.title || '(未知歌名)')} ${syncTag}</div>
        <div class="lsq-item-meta">${esc(c.artist || '未知艺人')} · ${esc(c.album || '未知专辑')} ${dur}</div>
        <pre class="lsq-preview" hidden>${esc(c.syncedLyrics || c.plainLyrics || '')}</pre>
      </div>
      <div class="lsq-item-actions">
        <button class="lsq-btn lsq-preview-btn" type="button">预览</button>
        <button class="lsq-btn lsq-use-btn" type="button">使用</button>
      </div>`;
    const previewBtn = item.querySelector('.lsq-preview-btn');
    const previewEl = item.querySelector('.lsq-preview');
    const useBtn = item.querySelector('.lsq-use-btn');
    previewBtn.addEventListener('click', () => {
      const willShow = previewEl.hasAttribute('hidden');
      previewEl.toggleAttribute('hidden', !willShow);
      previewBtn.textContent = willShow ? '收起' : '预览';
    });
    useBtn.addEventListener('click', () => applyCandidate(c));
    frag.appendChild(item);
  });
  resultsEl.appendChild(frag);
}

async function applyCandidate(candidate) {
  const path = _ctx.path;
  if (!path || !window.lumen || !window.lumen.saveLyricsCandidate) { setStatus('保存不可用', 'err'); return; }
  setStatus('正在保存…');
  try {
    const r = await window.lumen.saveLyricsCandidate(path, candidate);
    if (r && r.ok && Array.isArray(r.lines) && r.lines.length) {
      hideLyricsSearch();
      if (typeof _ctx.onApply === 'function') {
        _ctx.onApply(r.lines, r.meta || null, _ctx.info);
      }
    } else {
      const why = (r && r.error) ? r.error : '';
      setStatus(`保存失败${why ? '（' + why + '）' : ''}`, 'err');
    }
  } catch (e) {
    setStatus(`保存失败${e && e.message ? '：' + e.message : ''}`, 'err');
  }
}

/**
 * 打开手动搜索歌词弹窗。
 * @param {{path:string, title?:string, artist?:string, album?:string, duration?:number, info?:Object, onApply:(lines,lrcMeta,info)=>void}} opts
 */
export function openLyricsSearch(opts) {
  ensureDom();
  showLyricsSearch(opts);
}
