/**
 * 弹幕搜索/匹配面板(自包含模块)。
 * 从 app.js 拆出(2026-08):toggleDanmaku/搜索/匹配/加载。
 * visible 状态模块内自持,对外暴露 isDanmakuVisible()。
 * 用法:setupDanmakuPanel({ player, osd, getDanmakuRenderer, closeOthers });(boot 时注入)
 */
import { clamp } from '../../shared/clamp.js';
import { escapeHtml } from '../../shared/escape-html.js';

const $ = (id) => document.getElementById(id);

let visible = false;
export function isDanmakuVisible() { return visible; }

let CTX = {};
export function setupDanmakuPanel(ctx) { CTX = ctx || {}; }
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a) };
function danmakuRenderer() { return CTX.getDanmakuRenderer ? CTX.getDanmakuRenderer() : null; }
function closeOthers() { if (CTX.closeOthers) CTX.closeOthers(); }

export function toggleDanmaku(force) {
  const next = (force !== undefined) ? force : !visible;
  visible = next;
  const panel = $('danmaku-panel');
  panel.classList.toggle('hidden', !visible);
  document.body.classList.toggle('danmaku-open', visible);
  if (visible) {
    closeOthers();
    if (isLicensesVisible()) toggleLicenses(false);
    closeOthers();
    const input = $('danmaku-input');
    if (input && player.info) {
      const base = (player.props.filename || '').replace(/\.[^.]+$/, '');
      if (base) input.value = base;
    }
    if (input) requestAnimationFrame(() => input.focus());
  }
}

let danmakuDragState = null;
let danmakuUserMoved = false;

export function setupDanmakuPanelUi() {
  $('danmaku-close').addEventListener('click', () => toggleDanmaku(false));
  const backdrop = $('danmaku-panel').querySelector('.danmaku-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => toggleDanmaku(false));
  $('danmaku-go').addEventListener('click', () => runDanmakuSearch($('danmaku-input').value.trim()));
  $('danmaku-auto').addEventListener('click', () => runDanmakuAutoMatch());
  $('danmaku-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runDanmakuSearch(e.target.value.trim()); }
  });

  makeDanmakuDraggable();
  window.addEventListener('resize', onDanmakuResize);

  // 显示参数联动（含持久化 + 启动时恢复）
  const en = $('danmaku-enable');
  if (en) en.addEventListener('change', () => {
    try { if (window.lumen && window.lumen.saveConfig) window.lumen.saveConfig('danmaku-enabled', en.checked); } catch { /* ignore */ }
    applyDanmakuDisplay();
  });
  bindDanmakuSlider('danmaku-opacity', 'danmaku-opacity', (v) => { danmakuRenderer().setOpacity(v / 100); $('danmaku-opacity-val').textContent = v + '%'; });
  bindDanmakuSlider('danmaku-fontsize', 'danmaku-fontsize', (v) => { danmakuRenderer().setFontSize(v); $('danmaku-fontsize-val').textContent = v; });
  bindDanmakuSlider('danmaku-area', 'danmaku-area', (v) => { danmakuRenderer().setArea(v / 100); $('danmaku-area-val').textContent = v + '%'; });
  bindDanmakuSlider('danmaku-speed', 'danmaku-speed', (v) => { danmakuRenderer().setSpeedScale(v / 100); $('danmaku-speed-val').textContent = (v / 100).toFixed(1) + '×'; });
  bindDanmakuSlider('danmaku-density', 'danmaku-density', (v) => { danmakuRenderer().setDensity(v); $('danmaku-density-val').textContent = v; });
}

function makeDanmakuDraggable() {
  const head = document.querySelector('.danmaku-window .panel-head.draggable');
  const win = document.querySelector('.danmaku-window');
  if (!head || !win) return;

  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return; // 关闭按钮不触发拖拽
    danmakuDragState = {
      startX: e.clientX, startY: e.clientY,
      initLeft: win.offsetLeft, initTop: win.offsetTop,
    };
    head.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!danmakuDragState) return;
    const w = document.querySelector('.danmaku-window');
    const dx = e.clientX - danmakuDragState.startX;
    const dy = e.clientY - danmakuDragState.startY;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = danmakuDragState.initLeft + dx;
    let y = danmakuDragState.initTop + dy;
    // 保证窗口不会被完全拖出视口
    x = clamp(x, 8, vw - w.offsetWidth - 8);
    y = clamp(y, 8, vh - w.offsetHeight - 8);
    w.style.left = `${x}px`;
    w.style.top = `${y}px`;
    w.style.transform = 'none';
    danmakuUserMoved = true;
  });

  window.addEventListener('mouseup', () => {
    if (!danmakuDragState) return;
    danmakuDragState = null;
    head.style.cursor = 'grab';
  });
}

function centerDanmakuWindow() {
  const win = document.querySelector('.danmaku-window');
  if (!win) return;
  win.style.left = `${Math.round((window.innerWidth - win.offsetWidth) / 2)}px`;
  win.style.top = `${Math.round((window.innerHeight - win.offsetHeight) / 2)}px`;
  win.style.transform = 'none';
}

function onDanmakuResize() {
  if (!visible) return;
  const win = document.querySelector('.danmaku-window');
  if (!win) return;
  if (!danmakuUserMoved) { centerDanmakuWindow(); return; }
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = win.offsetLeft, y = win.offsetTop;
  x = clamp(x, 8, vw - win.offsetWidth - 8);
  y = clamp(y, 8, vh - win.offsetHeight - 8);
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
}

function bindDanmakuSlider(id, cfgKey, onInput) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => onInput(Number(el.value)));
  // 松手时持久化，避免拖动过程中高频写盘
  if (cfgKey) el.addEventListener('change', () => {
    try { if (window.lumen && window.lumen.saveConfig) window.lumen.saveConfig(cfgKey, Number(el.value)); } catch { /* ignore */ }
  });
}

/** 启动 / 换片时把已保存的弹幕显示参数恢复到滑块与渲染层 */
export function restoreDanmakuDisplay() {
  const bd = CTX.getBootstrapData ? CTX.getBootstrapData() : null;
  const cfg = (bd && bd.config && bd.config.values) || {};
  const en = $('danmaku-enable');
  if (en && cfg['danmaku-enabled'] !== undefined) en.checked = !!cfg['danmaku-enabled'];
  const items = [
    ['danmaku-opacity', 'danmaku-opacity', (v) => danmakuRenderer().setOpacity(v / 100), (v) => v + '%'],
    ['danmaku-fontsize', 'danmaku-fontsize', (v) => danmakuRenderer().setFontSize(v), (v) => String(v)],
    ['danmaku-area', 'danmaku-area', (v) => danmakuRenderer().setArea(v / 100), (v) => v + '%'],
    ['danmaku-speed', 'danmaku-speed', (v) => danmakuRenderer().setSpeedScale(v / 100), (v) => (v / 100).toFixed(1) + '×'],
    ['danmaku-density', 'danmaku-density', (v) => danmakuRenderer().setDensity(v), (v) => String(v)],
  ];
  for (const [id, cfgKey, apply, fmt] of items) {
    const el = $(id);
    if (!el) continue;
    const saved = Number(cfg[cfgKey]);
    if (Number.isFinite(saved)) {
      const min = Number(el.min), max = Number(el.max);
      el.value = clamp(saved, min, max);
    }
    const v = Number(el.value);
    apply(v);
    const lab = $(id + '-val');
    if (lab) lab.textContent = fmt(v);
  }
}

/** 开关 + 启用渲染层（载入弹幕后调用以显示） */
export function applyDanmakuDisplay() {
  const on = $('danmaku-enable') ? $('danmaku-enable').checked : true;
  if (danmakuRenderer()) danmakuRenderer().setEnabled(on);
  document.body.classList.toggle('danmaku-active', on && !!(danmakuRenderer() && danmakuRenderer().comments.length));
}

function setDanmakuStatus(text, kind) {
  const el = $('danmaku-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'danmaku-status' + (kind ? ' ' + kind : '');
}

function renderDanmakuSources(sources) {
  const host = $('danmaku-results');
  if (!host) return;
  host.innerHTML = '';
  if (!sources || !sources.length) {
    host.innerHTML = '<div class="danmaku-empty">没有匹配的弹幕源，换个关键词试试（弹弹play 需配 AppId，B 站 零配置，聚合代理需自托管）。</div>';
    return;
  }
  const srcLabel = { dandanplay: '弹弹', proxy: '聚合', bilibili: 'B站' };
  sources.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'danmaku-item';
    const tag = srcLabel[s.source] || s.source;
    const sub = s.confidence != null ? ` · 匹配度 ${Math.round(s.confidence * 100)}%` : '';
    row.innerHTML =
      `<div class="dmi-main">` +
        `<span class="dmi-tag dmi-${s.source}">${tag}</span>` +
        `<span class="dmi-name" title="${escapeHtml(s.title || '')}">${escapeHtml(s.title || '(未命名)')}</span>` +
      `</div>` +
      `<div class="dmi-meta" data-source-index="${sources.indexOf(s)}">${escapeHtml(sub)}<span class="dmi-count"></span></div>`;
    row.addEventListener('click', () => loadDanmakuSource(s));
    host.appendChild(row);
  });
  // 异步预加载每个源的弹幕数量（不阻塞 UI 显示，逐个更新）
  prefetchDanmakuCounts(sources);
}

/** 异步查询每个弹幕源的弹幕数量，拿到后更新对应行的 meta */
async function prefetchDanmakuCounts(sources) {
  // 并发限制：最多同时 5 个请求，避免瞬间打爆 API
  const CONCURRENCY = 5;
  const running = new Set();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const p = (async () => {
      try {
        const res = await window.lumen.countDanmaku(s);
        if (res && res.ok && res.count > 0) {
          const metaEl = document.querySelector(`.dmi-meta[data-source-index="${i}"] .dmi-count`);
          if (metaEl) metaEl.textContent = ` · ${res.count} 条`;
        }
      } catch { /* 静默失败，不干扰主列表 */ }
    })();
    running.add(p);
    p.then(() => running.delete(p));
    if (running.size >= CONCURRENCY) await Promise.race(running);
  }
  await Promise.allSettled(running); // 等待剩余的
}

async function runDanmakuSearch(query) {
  if (!query) { setDanmakuStatus('请输入关键词', 'warn'); return; }
  setDanmakuStatus('搜索中…');
  $('danmaku-results').innerHTML = '';
  const res = await window.lumen.searchDanmaku(query);
  if (!res || !res.ok) {
    setDanmakuStatus(res && res.error ? ('搜索失败：' + res.error) : '搜索失败', 'bad');
    return;
  }
  const all = (res.sources || []);
  setDanmakuStatus(`找到 ${all.length} 个弹幕源` + (res.errors && res.errors.length ? '（' + res.errors.join('；') + '）' : ''), all.length ? 'good' : 'warn');
  renderDanmakuSources(all);
}

async function runDanmakuAutoMatch() {
  setDanmakuStatus('自动匹配中…');
  $('danmaku-results').innerHTML = '';
  const res = await window.lumen.autoMatchDanmaku();
  if (!res || !res.ok) {
    setDanmakuStatus(res && res.error ? ('匹配失败：' + res.error) : '匹配失败', 'bad');
    return;
  }
  const all = (res.sources || []);
  setDanmakuStatus(`已匹配到 ${all.length} 个弹幕源` + (res.errors && res.errors.length ? '（' + res.errors.join('；') + '）' : ''), all.length ? 'good' : 'warn');
  renderDanmakuSources(all);
}

/** 选定弹幕源 → 拉取并解析 → 注入渲染层显示 */
async function loadDanmakuSource(source) {
  if (!source) return;
  setDanmakuStatus('正在加载弹幕…');
  const res = await window.lumen.loadDanmaku(source);
  if (!res || !res.ok) {
    setDanmakuStatus(res && res.error ? ('加载失败：' + res.error) : '加载失败', 'bad');
    return;
  }
  if (!res.comments || !res.comments.length) {
    setDanmakuStatus('该弹幕源没有弹幕内容', 'warn');
    return;
  }
  danmakuRenderer().load(res.comments);
  applyDanmakuDisplay();
  setDanmakuStatus(`已载入 ${res.count || res.comments.length} 条弹幕`, 'good');
  osd.message('弹幕', `${res.count || res.comments.length} 条`, { duration: 2500, key: 'danmaku' });
}
