/**
 * 在线字幕搜索面板(自包含模块)。
 * 从 app.js 拆出(2026-08):toggleSubSearch/搜索/下载/加载字幕。
 * visible 状态模块内自持,对外暴露 isSubSearchVisible()。
 * 用法:setupSubtitlesPanel({ player, osd });(boot 时注入)
 */
const $ = (id) => document.getElementById(id);

let visible = false;
export function isSubSearchVisible() { return visible; }

let CTX = {};
export function setupSubtitlesPanel(ctx) { CTX = ctx || {}; }
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a) };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function toggleSubSearch(force) {
  const next = (force !== undefined) ? force : !visible;
  visible = next;
  const panel = $('subsearch-panel');
  panel.classList.toggle('hidden', !visible);
  document.body.classList.toggle('subsearch-open', visible);
  if (visible) {
    if (CTX.closeOthers) CTX.closeOthers();
    const input = $('subsearch-input');
    if (input && player.info) {
      // 预填当前文件名（去扩展名），方便直接搜
      const base = (player.props.filename || '').replace(/\.[^.]+$/, '');
      if (base) input.value = base;
    }
    if (input) requestAnimationFrame(() => input.focus());
  }
}

export function setupSubSearchPanel() {
  $('subsearch-close').addEventListener('click', () => toggleSubSearch(false));
  const backdrop = $('subsearch-panel').querySelector('.subsearch-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => toggleSubSearch(false));
  $('subsearch-go').addEventListener('click', () => runSubSearch($('subsearch-input').value.trim()));
  $('subsearch-auto').addEventListener('click', () => runSubAutoMatch());
  $('subsearch-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSubSearch(e.target.value.trim()); }
  });
}

function setSubSearchStatus(text, kind) {
  const el = $('subsearch-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'subsearch-status' + (kind ? ' ' + kind : '');
}

function renderSubResults(results) {
  const host = $('subsearch-results');
  if (!host) return;
  host.innerHTML = '';
  if (!results || !results.length) {
    host.innerHTML = '<div class="subsearch-empty">没有匹配的字幕，换个关键词试试。</div>';
    return;
  }
  results.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'subsearch-item';
    const flag = r.lang === 'zh' ? '🇨🇳' : (r.langName || r.lang || '');
    const srcTag = r.source === 'proxy' ? '代理' : (r.source === 'opensubtitles' ? 'OS' : (r.source === 'shooter' ? '射手' : (r.source === 'zimuku' ? '字幕库' : (r.source === 'subhd' ? 'SubHD' : ''))));
    row.innerHTML =
      `<div class="sri-main">` +
        `<span class="sri-lang">${escapeHtml(flag)}</span>` +
        `<span class="sri-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>` +
        (srcTag ? `<span class="sri-source sri-${r.source}">${escapeHtml(srcTag)}</span>` : '') +
      `</div>` +
      `<div class="sri-meta">` +
        `<span>${escapeHtml((r.langName || r.lang || '').toUpperCase())}</span>` +
        (r.downloads ? `<span>↓ ${r.downloads.toLocaleString()}</span>` : '') +
        (r.release ? `<span class="sri-release" title="${escapeHtml(r.release)}">${escapeHtml(r.release.slice(0, 28))}</span>` : '') +
      `</div>`;
    row.addEventListener('click', () => downloadAndLoadSubtitle(r));
    // 第二字幕（双字幕）：把该字幕作为副轨加载，与主字幕同屏显示
    const subBtn = document.createElement('button');
    subBtn.className = 'sri-sub';
    subBtn.title = '作为第二字幕加载';
    subBtn.textContent = '副';
    subBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadAndLoadSubtitle(r, true); });
    row.appendChild(subBtn);
    host.appendChild(row);
  });
}

async function runSubSearch(query) {
  if (!query) { setSubSearchStatus('请输入关键词', 'warn'); return; }
  setSubSearchStatus('搜索中…');
  $('subsearch-results').innerHTML = '';
  const res = await window.lumen.searchSubtitles({ query, filePath: player.info && player.info.path });
  if (!res || !res.ok) {
    setSubSearchStatus(res && res.error ? ('搜索失败：' + res.error) : '搜索失败', 'bad');
    return;
  }
  if (!res.results.length) { setSubSearchStatus('未找到字幕', 'warn'); renderSubResults([]); return; }
  setSubSearchStatus(`找到 ${res.results.length} 条字幕`, 'good');
  renderSubResults(res.results);
}

export async function runSubAutoMatch() {
  setSubSearchStatus('自动匹配中…');
  $('subsearch-results').innerHTML = '';
  const res = await window.lumen.autoMatchSubtitles();
  if (!res || !res.ok) {
    setSubSearchStatus(res && res.error ? ('自动匹配失败：' + res.error) : '自动匹配失败', 'bad');
    return;
  }
  setSubSearchStatus(`已按「${res.title || ''}」匹配到 ${res.results.length} 条字幕`, res.results.length ? 'good' : 'warn');
  renderSubResults(res.results);
}

async function downloadAndLoadSubtitle(r, secondary = false) {
  if (!r || !r.fileId) { setSubSearchStatus('该字幕缺少 file_id，无法下载', 'bad'); return; }
  setSubSearchStatus(`正在下载：${r.name}`);
  const cacheKey = (player.props.filename || 'media') + '-' + r.fileId;
  const res = await window.lumen.downloadSubtitle({ fileId: r.fileId, cacheKey, base: r.base, lang: r.lang });
  if (!res || !res.ok) {
    setSubSearchStatus(res && res.error ? ('下载失败：' + res.error) : '下载失败', 'bad');
    return;
  }
  setSubSearchStatus('下载完成，正在加载…', 'good');
  applyExternalSubtitle(res, secondary);
}

/** 把下载到的字幕应用到当前播放：mpv 走 sub-add（原生渲染）；ffmpeg 走 cues 覆盖层 */
function applyExternalSubtitle(res, secondary = false) {
  const isFfmpeg = document.body.classList.contains('engine-ffmpeg');
  if (!isFfmpeg && res.path) {
    // mpv：把缓存文件交给 mpv 原生加载（其内置支持 .srt / .srt.gz 等）
    if (secondary) {
      // 第二字幕：先 add（auto=不自动选中），新轨追加在末尾，索引 = 添加前长度
      const before = (player.info && player.info.subtitle ? player.info.subtitle.length : 0);
      player.command(['sub-add', res.path, 'auto']);
      player.setProperty('sid2', before);
      player.dispatchEvent(new CustomEvent('osd', { detail: { text: '第二字幕', value: '在线：' + (res.name || 'subtitles') } }));
    } else {
      player.command(['sub-add', res.path, 'select']);
      player.dispatchEvent(new CustomEvent('osd', { detail: { text: '字幕', value: '在线：' + (res.name || 'subtitles') } }));
    }
  } else {
    // ffmpeg 引擎或下载无缓存路径时，退化为 cues 覆盖层
    loadSubtitleCues(res.cues, secondary);
  }
  toggleSubSearch(false);
}

/** 把 cues 注入渲染端字幕管线（ffmpeg 引擎 / 兜底）。secondary=true 时写入第二字幕层 */
function loadSubtitleCues(cues, secondary = false) {
  if (!Array.isArray(cues)) cues = [];
  player.subtitleGraphic = false;
  if (secondary) {
    player.subtitleCues2 = cues;
    player.subtitleExternal2 = true; // 标记为外部下载副字幕，_updateSubtitle 据此显示
    player._updateSubtitle();
    player._notify('sid2', player.props.sid2);
    player.dispatchEvent(new CustomEvent('osd', { detail: { text: '第二字幕', value: '在线（' + cues.length + ' 条）' } }));
  } else {
    player.subtitleCues = cues;
    player.subtitleExternal = true; // 标记为外部下载字幕，_updateSubtitle 据此显示
    player._updateSubtitle();
    player._notify('sid', player.props.sid);
    player.dispatchEvent(new CustomEvent('osd', { detail: { text: '字幕', value: '在线（' + cues.length + ' 条）' } }));
  }
}

