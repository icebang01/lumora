/**
 * 设置面板(自包含模块)。
 * 从 app.js 拆出(2026-08):toggleSettings/buildSettings/saveSetting/设置自定义下拉/确认框。
 * visible 状态模块内自持,对外暴露 isSettingsVisible()/isSetSelectOpen()。
 * 用法:setupSettingsPanel(ctx);(boot 时注入;动态值用 getter)
 */
import { fmtTime } from '../core/player.js';
import { KeybindEditor } from '../ui/keybind-editor.js';
import { toggleLicenses, isLicensesVisible } from './licenses.js';
import { parseICCProfile } from '../gl/display-profile.js';
import { applySubtitleStyle } from './subtitle-style.js';

const $ = (id) => document.getElementById(id);

/**
 * 验证 URL 连通性：发一个轻量 GET 请求，返回 { ok, time, error, status }。
 * 用于设置面板内代理地址 / API 端点的「验证连通性」按钮。
 *
 * @param {string} url - 用户填的完整地址
 * @param {object} opts
 * @param {string} [opts.testPath] - 追加到 url 后的测试路径（如 danmu_api 的 /api/v2/search/anime?keyword=test）
 * @param {number} [opts.timeout=5000] - 超时毫秒数
 * @returns {Promise<{ok:boolean, time:number, error?:string, status?:number}>}
 */
async function verifyConnectivity(url, opts = {}) {
  const { testPath = '', timeout = 5000 } = opts;
  const trimmed = (url || '').trim();
  if (!trimmed) return { ok: false, error: '请先填写地址', time: 0 };

  // 基本校验：看起来像 URL
  let fullUrl = trimmed;
  if (testPath) {
    // 拼接测试路径：去掉尾部斜杠再拼
    fullUrl = trimmed.replace(/\/+$/, '') + testPath;
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(fullUrl, {
      method: 'GET',
      signal: controller.signal,
      // 不跟随跨域重定向到非预期域名；但允许同源/正常重定向以便测通
      redirect: 'follow',
      // 只拿 header 不读 body（省流量）
    });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    // 2xx/3xx 算可达（danmu_api 可能返回 JSON 错误体但 HTTP 200；代理可能 401 但说明服务在跑）
    if (res.status >= 200 && res.status < 500) {
      return { ok: true, time: elapsed, status: res.status };
    }
    return { ok: false, time: elapsed, error: `HTTP ${res.status}`, status: res.status };
  } catch (e) {
    const elapsed = Date.now() - start;
    const msg = e.name === 'AbortError' ? `超时 (${timeout}ms)` : (e.message || '连接失败');
    return { ok: false, time: elapsed, error: msg };
  }
}

/** 给某个验证按钮绑定点击事件 + 内联结果渲染 */
function bindVerifyButton(btnId, inputKey, testPath, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = '检测中…';

    // 从当前 input 取值（不依赖 config 缓存，反映用户刚输入的内容）
    const input = document.querySelector(`.set-text[data-key="${inputKey}"]`);
    const url = input ? input.value.trim() : '';
    const resultSpan = document.getElementById(`${btnId}-result`);

    const res = await verifyConnectivity(url, { testPath });
    if (resultSpan) {
      resultSpan.className = 'verify-result ' + (res.ok ? 'ok' : 'fail');
      resultSpan.textContent = res.ok
        ? `✓ 已连接 (${res.time}ms)`
        : `✗ ${res.error || '失败'}${res.time ? ` (${res.time}ms)` : ''}`;
    }
    btn.disabled = false;
    btn.textContent = origText;
    // 8 秒后淡出结果
    if (resultSpan) setTimeout(() => { resultSpan.textContent = ''; resultSpan.className = 'verify-result'; }, 8000);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let CTX = {};
export function setupSettingsPanel(ctx) { CTX = ctx || {}; }
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a) };
function bootstrapData() { return CTX.getBootstrapData ? CTX.getBootstrapData() : null; }
function scripts() { return CTX.getScripts ? CTX.getScripts() : null; }
function keymap() { return CTX.getKeymap ? CTX.getKeymap() : null; }
const keybinds = new Proxy({}, {
  get(_, k) {
    const kb = CTX.keybinds;
    if (!kb) return undefined;
    return typeof kb[k] === 'function' ? kb[k].bind(kb) : kb[k];
  },
});

let settingsVisible = false;
export function isSettingsVisible() { return settingsVisible; }
let settingsBuilt = false;
let settingsUserMoved = false;
let settingsActiveSection = 'general';
let settingsDragState = null;
let keybindEditor = null;      // 快捷键自定义编辑器实例(设置面板内创建)
const settingsActions = {};    // name -> 点击回调
const settingsFmt = {};        // key -> 滑块值格式化函数
let setSelectOpen = null;     // 当前展开的设置下拉 { el, fly, closeTimer, openTimer }
export function isSetSelectOpen() { return !!setSelectOpen; }
let updateDownloaded = false;   // 当前是否已下载就绪、等待用户确认安装
let updateEventsBound = false;  // updater:status / progress 全局监听只绑一次

export function closeSetSelect(immediate) {
  if (!setSelectOpen) return;
  const cur = setSelectOpen;
  setSelectOpen = null;
  clearTimeout(cur.openTimer);
  const finish = () => {
    cur.el.classList.remove('open');
    cur.el.setAttribute('aria-expanded', 'false');
    if (cur.fly && cur.fly.parentNode) cur.fly.parentNode.removeChild(cur.fly);
  };
  if (immediate) finish();
  else { cur.fly && cur.fly.classList.add('closing'); setTimeout(finish, 130); }
}

/**
 * 把设置下拉的选项列表渲染为一个挂在 body 上的 fixed 浮层。
 * 原因：frameless Electron 窗口里原生 <select> 的弹出层在 Windows 上
 * 经常无法滚动 / 被裁剪；自定义浮层可保证稳定可滚动且不被窗口边缘裁切。
 */
export function openSetSelect(el, list) {
  const fly = document.createElement('div');
  fly.className = 'set-select-fly';
  fly.setAttribute('role', 'listbox');
  // 复制选项
  Array.from(list.children).forEach((o) => {
    const item = o.cloneNode(true);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    fly.appendChild(item);
  });
  document.body.appendChild(fly);
  setSelectOpen.fly = fly;

  // 定位：优先在下沿展开，空间不足则上沿
  const r = el.getBoundingClientRect();
  const fh = Math.min(fly.scrollHeight, window.innerHeight - 16);
  fly.style.visibility = 'hidden';
  fly.style.maxHeight = fh + 'px';
  fly.classList.add('open');
  const flyW = fly.offsetWidth || r.width;
  let left = r.left + r.width / 2 - flyW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - flyW - 8));
  let top = r.bottom + 6;
  if (top + fh > window.innerHeight - 8) top = Math.max(8, r.top - 6 - fh);
  fly.style.left = left + 'px';
  fly.style.top = top + 'px';
  fly.style.visibility = '';

  // 点击浮层外 / 滚动 / Esc 关闭
  setSelectOpen.openTimer = setTimeout(() => {
    fly.addEventListener('mousedown', (e) => e.stopPropagation());
    fly.addEventListener('wheel', (e) => e.stopPropagation());
  }, 0);
}

/**
 * 把主进程推送的更新状态映射到设置面板的更新行。
 * payload: { status, version, info?, error? }
 */
function applyUpdaterStatus(payload) {
  const st = document.getElementById('update-status');
  const btn = document.getElementById('btn-check-update');
  if (!st) return;
  const ver = payload && payload.info && payload.info.version ? payload.info.version : '';
  const cur = payload && payload.version ? payload.version : '';
  switch (payload && payload.status) {
    case 'disabled':
      updateDownloaded = false;
      st.textContent = '开发模式，更新不可用';
      st.className = 'update-status muted';
      if (btn) btn.disabled = true;
      break;
    case 'checking':
      updateDownloaded = false;
      st.textContent = '正在检查更新…';
      st.className = 'update-status busy';
      break;
    case 'available':
      updateDownloaded = false;
      st.textContent = ver ? `发现新版本 v${ver}，正在下载…` : '发现新版本，正在下载…';
      st.className = 'update-status busy';
      break;
    case 'not-available':
      updateDownloaded = false;
      st.textContent = `已是最新（v${cur || ''}）`;
      st.className = 'update-status ok';
      break;
    case 'downloaded':
      updateDownloaded = true;
      st.textContent = `v${ver} 已下载，可重启安装`;
      st.className = 'update-status ok';
      if (btn) { btn.textContent = '重启并安装'; btn.disabled = false; }
      break;
    case 'error':
      updateDownloaded = false;
      st.textContent = '更新出错：' + ((payload && payload.error) || '未知');
      st.className = 'update-status error';
      break;
    default:
      updateDownloaded = false;
      st.textContent = `当前 v${cur || ''}`;
      st.className = 'update-status';
  }
}

/** 绑定主进程 → 渲染端的更新事件（仅一次）。 */
function bindUpdateEvents() {
  if (updateEventsBound) return;
  if (!window.lumen || !window.lumen.on) return;
  updateEventsBound = true;
  window.lumen.on('updater:status', (payload) => {
    applyUpdaterStatus(payload);
    if (payload && payload.status === 'downloaded') {
      const ver = payload.info && payload.info.version ? payload.info.version : '';
      osd && osd.message('更新就绪', `v${ver} 已下载，打开设置重启安装`, { duration: 6000, force: true });
    }
  });
  window.lumen.on('updater:progress', (p) => {
    const st = document.getElementById('update-status');
    if (!st || !p) return;
    const pct = (p.percent || 0).toFixed(0);
    st.textContent = `下载更新 ${pct}%`;
    st.className = 'update-status busy';
  });
}

export function setupSettingsPanelUi() {
  $('settings-close').addEventListener('click', () => toggleSettings(false));
  $('tb-settings').addEventListener('click', () => toggleSettings(true));
  const backdrop = document.querySelector('#settings-panel .settings-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => toggleSettings(false));
  const search = document.getElementById('settings-search');
  if (search) {
    search.addEventListener('input', () => filterSettings(search.value.trim().toLowerCase()));
    search.addEventListener('keydown', (e) => { e.stopPropagation(); });
    search.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  }
  bindUpdateEvents();
  makeSettingsDraggable();
  window.addEventListener('resize', onSettingsResize);
}

/**
 * 设置内搜索：空查询时恢复"仅当前分区可见"；有查询时展开全部分区并
 * 按行内 data-search 文本过滤，跨分区一次性呈现结果。
 */
function filterSettings(q) {
  const content = $('settings-content');
  if (!content) return;
  const sections = content.querySelectorAll('.settings-section');
  if (!q) {
    sections.forEach((s) => s.classList.toggle('active', s.dataset.section === settingsActiveSection));
    sections.forEach((s) => s.querySelectorAll('.set-row').forEach((r) => r.classList.remove('hidden')));
    return;
  }
  sections.forEach((s) => s.classList.add('active'));
  sections.forEach((s) => {
    s.querySelectorAll('.set-row').forEach((r) => {
      const text = (r.dataset.search || '').toLowerCase();
      r.classList.toggle('hidden', !text.includes(q));
    });
  });
}

/** 轻量确认弹窗（不依赖被禁用的 window.confirm）。返回 Promise<boolean>。 */
export function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      `<div class="confirm-card">` +
      `<div class="confirm-msg">${escapeHtml(message)}</div>` +
      `<div class="confirm-actions">` +
      `<button type="button" class="set-action ghost" data-r="cancel">取消</button>` +
      `<button type="button" class="set-action danger" data-r="ok">确认</button>` +
      `</div></div>`;
    document.body.appendChild(overlay);
    // 跟随当前主题：亮色外观下确认卡片也用亮色（见 .light-surface 作用域）
    if (document.documentElement.dataset.theme === 'light') overlay.classList.add('light-surface');
    const close = (val) => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(val); };
    overlay.addEventListener('click', (e) => {
      const r = e.target.dataset.r;
      if (r === 'ok') close(true);
      else if (r === 'cancel') close(false);
      else if (e.target === overlay) close(false);
    });
  });
}

function makeSettingsDraggable() {
  const head = document.querySelector('.settings-window .panel-head.draggable');
  const win = document.querySelector('.settings-window');
  if (!head || !win) return;
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // 点标题栏上的按钮 / 输入框 / 搜索框不触发拖拽
    if (e.target.closest('button, input, textarea, select')) return;
    settingsDragState = {
      startX: e.clientX, startY: e.clientY,
      initLeft: win.offsetLeft, initTop: win.offsetTop,
    };
    head.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!settingsDragState) return;
    const w = document.querySelector('.settings-window');
    const dx = e.clientX - settingsDragState.startX;
    const dy = e.clientY - settingsDragState.startY;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = settingsDragState.initLeft + dx;
    let y = settingsDragState.initTop + dy;
    x = Math.max(8, Math.min(x, vw - w.offsetWidth - 8));
    y = Math.max(8, Math.min(y, vh - w.offsetHeight - 8));
    w.style.left = `${x}px`;
    w.style.top = `${y}px`;
    w.style.transform = 'none';
    settingsUserMoved = true;
  });
  window.addEventListener('mouseup', () => {
    settingsDragState = null;
    head.style.cursor = 'grab';
  });
}

/** 确保设置窗口完全在视口内（底部不超出） */
function clampSettingsWindowInViewport() {
  const win = document.querySelector('.settings-window');
  if (!win) return;
  const vh = window.innerHeight;
  const wh = win.offsetHeight;
  let top = win.offsetTop;
  // 底部不能超出视口（留 8px 边距）
  if (top + wh > vh - 8) {
    top = Math.max(8, vh - wh - 8);
    win.style.top = `${top}px`;
  }
}

/** 切换到指定设置分区 */
function switchSettingsSection(secId) {
  settingsActiveSection = secId;
  document.querySelectorAll('.settings-nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.section === secId);
  });
  document.querySelectorAll('.settings-section').forEach((s) => {
    s.classList.toggle('active', s.dataset.section === secId);
  });
}

function centerSettingsWindow() {
  const win = document.querySelector('.settings-window');
  if (!win) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const ww = win.offsetWidth, wh = win.offsetHeight;
  // 居中但钳位到视口内（上下左右至少留 8px 边距）
  let left = Math.round((vw - ww) / 2);
  let top = Math.round((vh - wh) / 2);
  left = Math.max(8, Math.min(left, vw - ww - 8));
  top = Math.max(8, Math.min(top, vh - wh - 8));
  win.style.left = `${left}px`;
  win.style.top = `${top}px`;
  win.style.transform = 'none';
}

function onSettingsResize() {
  if (!settingsVisible) return;
  const win = document.querySelector('.settings-window');
  if (!win) return;
  if (!settingsUserMoved) { centerSettingsWindow(); return; }
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = win.offsetLeft, y = win.offsetTop;
  x = Math.max(8, Math.min(x, vw - win.offsetWidth - 8));
  y = Math.max(8, Math.min(y, vh - win.offsetHeight - 8));
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
}

export async function saveSetting(key, value) {
  try {
    if (window.lumen && window.lumen.saveConfig) await window.lumen.saveConfig(key, value);
    else if (window.lumen && window.lumen.setConfig) await window.lumen.setConfig(key, value);
  } catch (e) { /* 主进程 handler 未就绪时忽略 */ }

  // 同步本地缓存，让 OSC 等动态读取配置的地方立即生效
  if (bootstrapData && bootstrapData().config && bootstrapData().config.values) {
    bootstrapData().config.values[key] = value;
  }

  // 对支持运行时生效的属性，立即应用到播放器或界面
  applySettingImmediately(key, value);

  // 广播设置变更，供歌词字体等需要实时响应的模块即时生效
  try {
    document.dispatchEvent(new CustomEvent('lumen:settings-changed', { detail: { key, value } }));
  } catch { /* ignore */ }
}

/** 设置项中可立即生效的部分。其余项（如启动时全屏、cursor-autohide）需下次启动才生效。 */
export function applySettingImmediately(key, value) {
  switch (key) {
    case 'volume':
    case 'mute':
    case 'speed':
    case 'loop-file':
    case 'hwdec':
    case 'ontop':
    case 'scaler':
    case 'deband':
    case 'correct-downscaling':
    case 'dither':
    case 'interpolation':
    case 'tone-mapping':
    case 'display-gamut':
    case 'target-peak':
    case 'brightness':
    case 'contrast':
    case 'saturation':
    case 'gamma':
    case 'video-sync':
    case 'audio-delay':
    case 'audio-exclusive':
    case 'sub-delay':
    case 'slang':
    case 'keep-open':
      if (player && player.setProperty) {
        try { player.setProperty(key, value); } catch (e) { console.warn('[settings] 即时应用失败', key, e); }
      }
      break;
    case 'sub-font-size':
    case 'sub-color':
    case 'sub-bold':
    case 'sub-outline-size':
    case 'sub-outline-color':
    case 'sub-shadow-size':
    case 'sub-bg':
    case 'sub-bg-color':
    case 'sub-bg-opacity':
    case 'sub-pos':
    case 'sub-font-family':
    case 'sub-codepage':
      if (player && player.setProperty) {
        try { player.setProperty(key, value); } catch (e) { console.warn('[settings] 即时应用失败', key, e); }
        try { applySubtitleStyle(player.props); } catch (e) { console.warn('[settings] 字幕样式应用失败', e); }
      }
      break;
    case 'osc':
      document.body.classList.toggle('no-osc', !value);
      break;
    case 'theme':
      applyTheme();
      break;
    // fullscreen 为"启动时全屏"，不立即切换当前窗口；
    // osc-timeout 已被 OSC.scheduleHide 动态读取；
    // cursor-autohide / save-position-on-quit / engine 需重启生效。
  }
}

/**
 * 应用主题到独立窗口（设置 / 许可证）和 idle 落地页。
 * 播放覆盖层（OSC / 播放列表 / 书签 / 弹幕等）永远保持暗色 —— 亮色覆盖层
 * 会在暗场画面旁形成眩光，破坏瞳孔适应（见 style.css 顶部说明）。
 * theme 取值：system（跟随系统 prefers-color-scheme）/ dark / light。
 */
export function applyTheme() {
  const cfg = bootstrapData && bootstrapData().config && bootstrapData().config.values;
  const theme = (cfg && cfg.theme) || 'system';
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const resolved = theme === 'system' ? (mq && mq.matches ? 'dark' : 'light') : theme;
  const light = resolved === 'light';
  document.querySelectorAll('[data-light-surface]').forEach((el) => {
    el.classList.toggle('light-surface', light);
  });
  document.documentElement.dataset.theme = resolved;
}

let _themeMq = null;
export function initTheme() {
  applyTheme();
  if (!window.matchMedia) return;
  // 跟随系统时，系统配色切换要实时反映
  if (!_themeMq) _themeMq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    const cfg = bootstrapData && bootstrapData().config && bootstrapData().config.values;
    if ((cfg && cfg.theme) === 'system') applyTheme();
  };
  if (_themeMq.addEventListener) _themeMq.addEventListener('change', handler);
  else if (_themeMq.addListener) _themeMq.addListener(handler);
}

/** 重新加载 AI 后端（应用刚保存的 ai-* 配置）并刷新状态徽标。 */
async function reloadAiFromSettings() {
  try {
    if (window.lumen && window.lumen.aiReload) await window.lumen.aiReload();
  } catch (e) { /* 主进程 handler 未就绪时忽略 */ }
  await refreshAiStatus();
}

/** 拉取 AI 后端状态并渲染到设置里的状态徽标。 */
export async function refreshAiStatus() {
  const badge = document.getElementById('ai-status-badge');
  if (!badge) return;
  try {
    const st = await window.lumen.aiStatus();
    const real = !!st.hasKey;
    badge.textContent = real ? `在线模型 · ${st.model || ''}` : '离线桩（未配置 Key）';
    badge.classList.toggle('on', real);
    badge.classList.toggle('off', !real);
  } catch (e) {
    badge.textContent = '状态获取失败';
    badge.classList.add('off');
  }
}

/**
 * 从 OpenAI 兼容 API 获取可用模型列表，渲染为下拉选择。
 * 点击模型项自动填入输入框并保存配置。
 */
async function fetchAiModels() {
  const btn = document.getElementById('ai-fetch-models-btn');
  const dropdown = document.getElementById('ai-model-dropdown');
  if (!btn || !dropdown) return;

  // 防重复点击
  if (btn.disabled) return;
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '获取中…';

  try {
    const res = await window.lumen.aiFetchModels();
    if (!res.ok) {
      dropdown.innerHTML = `<div class="ai-model-err">⚠️ ${escapeHtml(res.error || '获取失败')}</div>`;
      dropdown.hidden = false;
      return;
    }

    const models = res.models || [];
    if (!models.length) {
      dropdown.innerHTML = '<div class="ai-model-err">⚠️ 接口返回空列表</div>';
      dropdown.hidden = false;
      return;
    }

    // 渲染下拉列表：按首字母分组显示
    const input = document.querySelector('.ai-model-input');
    const currentVal = input ? input.value.trim() : '';

    let html = '<div class="ai-model-list">';
    // 常用/推荐模型置顶（如果当前值在列表里，把它标出来）
    const items = models.map((id) => {
      const isCurrent = id === currentVal;
      return `<div class="ai-model-item${isCurrent ? ' selected' : ''}" data-model="${escapeHtml(id)}">` +
        `${isCurrent ? '✓ ' : ''}${escapeHtml(id)}</div>`;
    }).join('');
    html += items + '</div>';
    html += `<div class="ai-model-count">共 ${models.length} 个模型</div>`;

    dropdown.innerHTML = html;
    dropdown.hidden = false;

    // 绑定点击事件
    dropdown.querySelectorAll('.ai-model-item').forEach((item) => {
      item.addEventListener('click', () => {
        const modelId = item.dataset.model;
        if (!input || !modelId) return;
        input.value = modelId;
        saveSetting('ai-model', modelId);
        dropdown.hidden = true;
        // 高亮选中的项
        dropdown.querySelectorAll('.ai-model-item').forEach((i) => i.classList.remove('selected'));
        item.classList.add('selected');
      });
    });
  } catch (e) {
    dropdown.innerHTML = `<div class="ai-model-err">⚠️ ${escapeHtml(e.message || '网络异常')}</div>`;
    dropdown.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

function buildSettings() {
  const cfg = bootstrapData().config.values;
  const nav = $('settings-nav');
  const content = $('settings-content');
  nav.innerHTML = '';
  content.innerHTML = '';

  const sections = [
    {
      id: 'general', label: '常规',
      desc: '播放引擎与基础行为。',
      rows: [
        { type: 'select', key: 'engine', name: '播放引擎',
          hint: 'mediafoundation（默认）走 Windows 系统解码器（路线 A，彻底去 GPL，需 Windows + 已编译原生模块）；mpv 稳定且支持 8K；ffmpeg 走内置 LGPL 解码管线（可去 GPL，分辨率≤1080p）。修改需重启生效。',
          options: [
            ['mpv', 'mpv（稳定，GPU 解码）'],
            ['ffmpeg', 'ffmpeg（LGPL 内置解码）'],
            ['mediafoundation', 'mediafoundation（默认，系统解码器去 GPL）'],
          ] },
        { type: 'toggle', key: 'file-association', name: '关联到系统文件类型',
          hint: '双击 mp4/mkv 等文件用 Lumora 打开（写入当前用户注册表，无需管理员）' },
        { type: 'toggle', key: 'scripts', name: '启用脚本',
          hint: '自动加载 scripts/ 目录下的 Lua 脚本（增强功能 / 自定义）' },
        { type: 'action', name: '打开配置目录', hint: '手动编辑 player.conf / input.conf',
          action: () => window.lumen.openConfigDir && window.lumen.openConfigDir() },
      ],
    },
    {
      id: 'playback', label: '播放',
      desc: '默认音量与播放行为（载入新文件时生效）。',
      rows: [
        { type: 'slider', key: 'volume', name: '默认音量', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
        { type: 'toggle', key: 'mute', name: '静音' },
        { type: 'select', key: 'loop-file', name: '循环模式',
          options: [['no', '不循环'], ['inf', '单文件循环']] },
        { type: 'select', key: 'hwdec', name: '硬件解码',
          options: [['auto', '自动'], ['no', '关闭']] },
        { type: 'toggle', key: 'keep-open', name: '播完停在最后一帧',
          hint: '文件结束后停留在末帧而非关闭窗口' },
        { type: 'toggle', key: 'save-position-on-quit', name: '退出时记住播放进度' },
        { type: 'toggle', key: 'return-home-on-eof', name: '播放结束后返回主界面',
          hint: '播完且无后续视频时自动回到 logo 落地页；关闭则停在末帧' },
        { type: 'slider', key: 'history-count', name: '最近播放保留条数',
          hint: 'idle 屏"最近播放"最多保留/展示的文件数（1~20）。注意：只统计不同的文件，重复播放同一部只算一条', min: 1, max: 20, step: 1, fmt: (v) => `${v} 条` },
        { type: 'toggle', key: 'auto-add-siblings', name: '拖入单文件时自动加入同目录媒体',
          hint: '从资源管理器拖入一个视频/音频时，自动把所在文件夹里其他媒体也加进播放列表（按文件名排序）' },
        { type: 'select', key: 'video-sync', name: '音画同步基准',
          options: [['audio', '音频（推荐）'], ['display', '显示']] },
        { type: 'slider', key: 'audio-delay', name: '音画偏移', hint: '正值=音频延后，负值=音频提前', min: -2000, max: 2000, step: 10, fmt: (v) => `${v}ms` },
        { type: 'slider', key: 'speed', name: '默认速度', min: 0.25, max: 4, step: 0.05, fmt: (v) => `${Number(v).toFixed(2)}×` },
      ],
    },
    {
      id: 'audio', label: '音频',
      desc: '音频输出与语言偏好（部分项需重启生效）。',
      rows: [
        { type: 'toggle', key: 'audio-exclusive', name: '独占模式',
          hint: '绕过系统混音器，直连音频设备以获得 bit-perfect 原音质（需重启生效）' },
        { type: 'text', key: 'alang', name: '首选音频语言',
          hint: '如 jpn / eng / chi，多语言片源优先选中（需重启生效）', placeholder: '如 jpn' },
      ],
    },
    {
      id: 'interface', label: '界面',
      desc: '控制条与窗口行为。',
      rows: [
        { type: 'select', key: 'theme', name: '主题外观',
          hint: '暗色（沉浸观影，默认）/ 亮色（设置等独立窗口）/ 跟随系统。播放覆盖层始终暗色以防眩光。',
          options: [['system', '跟随系统'], ['dark', '暗色'], ['light', '亮色']] },
        { type: 'toggle', key: 'osc', name: '显示控制条' },
        { type: 'toggle', key: 'mouse-gesture', name: '鼠标手势',
          hint: '在画面上按住拖动：横向=快进/后退，纵向(左半屏)=音量，纵向(右半屏)=亮度' },
        { type: 'slider', key: 'osc-timeout', name: '控制条自动隐藏', hint: '鼠标静止后控制条淡出延迟', min: 500, max: 6000, step: 100, fmt: (v) => `${v}ms` },
        { type: 'toggle', key: 'show-quality-badges', name: '显示质量徽标',
          hint: '如 8K ULTRA HD / HDR 10 / DOLBY ATMOS' },
        { type: 'toggle', key: 'fullscreen', name: '启动时全屏', hint: '下次启动时生效' },
        { type: 'toggle', key: 'ontop', name: '始终置顶' },
        { type: 'slider', key: 'cursor-autohide', name: '鼠标自动隐藏', hint: '下次启动时生效', min: 0, max: 5000, step: 100, fmt: (v) => `${v}ms` },
        { type: 'text', key: 'autofit', name: '首次窗口大小',
          hint: '首次打开时窗口占屏幕比例，如 70% 或 1280x720（需重启生效）', placeholder: '70%' },
      ],
    },
    {
      id: 'video', label: '画面',
      desc: '渲染管线与画面均衡。',
      rows: [
        { type: 'select', key: 'scaler', name: '缩放算法',
          options: [['bilinear', 'bilinear（最快）'], ['bicubic', 'bicubic'], ['spline36', 'spline36'], ['ewa_lanczos', 'ewa_lanczos（最锐利）']] },
        { type: 'toggle', key: 'deband', name: '去色带' },
        { type: 'toggle', key: 'correct-downscaling', name: '校正缩小',
          hint: '缩小时使用更精确的采样，避免发虚' },
        { type: 'toggle', key: 'dither', name: '输出抖动',
          hint: '消除 8bit 输出的色带（开启后过渡更平滑）' },
        { type: 'toggle', key: 'interpolation', name: '运动插值',
          hint: 'smoothmotion，低帧率片源更顺滑（GPU 开销略增）' },
        { type: 'select', key: 'tone-mapping', name: 'HDR 色调映射',
          options: [['hable', 'hable'], ['mobius', 'mobius'], ['reinhard', 'reinhard'], ['bt2390', 'bt2390（推荐）'], ['clip', 'clip']] },
        { type: 'select', key: 'display-gamut', name: '显示色彩空间',
          hint: '色彩管理：把视频从规范 sRGB/BT.709 换算到显示器实际色域，修正广色域屏上的过饱和。自动=读取显示器 EDID 实测色域（失败回退 sRGB）。',
          options: [['auto', '自动（读取显示器 EDID）'], ['srgb', 'sRGB / BT.709'], ['display-p3', 'Display-P3'], ['adobe-rgb', 'Adobe RGB'], ['bt2020', 'BT.2020'], ['custom', '自定义（ICC 文件）']] },
        { type: 'action', name: '加载显示器 ICC 配置文件…',
          hint: '选择系统或显示器自带的 .icc/.icm 文件，按其实测色域做色彩管理（需配合上方选「自定义」）。',
          action: async () => {
            try {
              const res = await window.lumen.openIcc();
              if (!res || res.canceled || res.error) return;
              if (!res.bytes) return;
              const u8 = new Uint8Array(res.bytes);
              const { matrix } = parseICCProfile(u8);
              if (player && player.renderer) player.renderer.setDisplayMatrix(matrix);
              await saveSetting('display-gamut', 'custom');
              console.info('[settings] 已加载 ICC 配置文件:', res.name);
            } catch (e) {
              console.warn('[settings] ICC 加载失败', e);
            }
          } },
        { type: 'slider', key: 'target-peak', name: '目标亮度', min: 100, max: 1000, step: 1, fmt: (v) => `${v} nits` },
        { type: 'slider', key: 'brightness', name: '亮度', min: -100, max: 100, step: 1, fmt: (v) => `${v}` },
        { type: 'slider', key: 'contrast', name: '对比度', min: -100, max: 100, step: 1, fmt: (v) => `${v}` },
        { type: 'slider', key: 'saturation', name: '饱和度', min: -100, max: 100, step: 1, fmt: (v) => `${v}` },
        { type: 'slider', key: 'gamma', name: '伽马', min: -100, max: 100, step: 1, fmt: (v) => `${v}` },
      ],
    },
    {
      id: 'subtitles', label: '字幕',
      desc: '字幕样式与同步（实时生效，语言偏好需重启）。',
      rows: [
        { type: 'section', name: '字幕外观（实时生效）' },
        { type: 'slider', key: 'sub-font-size', name: '字号', min: 10, max: 120, step: 1, fmt: (v) => `${v}` },
        { type: 'color', key: 'sub-color', name: '字幕颜色' },
        { type: 'toggle', key: 'sub-bold', name: '粗体' },
        { type: 'slider', key: 'sub-outline-size', name: '描边粗细', min: 0, max: 8, step: 1, fmt: (v) => `${v}px` },
        { type: 'color', key: 'sub-outline-color', name: '描边颜色' },
        { type: 'slider', key: 'sub-shadow-size', name: '阴影大小', min: 0, max: 8, step: 1, fmt: (v) => `${v}px` },
        { type: 'toggle', key: 'sub-bg', name: '字幕底衬' },
        { type: 'color', key: 'sub-bg-color', name: '底衬颜色' },
        { type: 'slider', key: 'sub-bg-opacity', name: '底衬不透明度', min: 0, max: 100, step: 5, fmt: (v) => `${v}%` },
        { type: 'slider', key: 'sub-pos', name: '垂直位置', hint: '0=顶部，100=底部', min: 5, max: 95, step: 1, fmt: (v) => `${v}` },
        { type: 'text', key: 'sub-font-family', name: '字体', hint: '留空使用系统默认（CJK 自动回退）；填写字体名区分大小写，如 "Microsoft YaHei"', placeholder: '如 Microsoft YaHei' },
        { type: 'text', key: 'sub-codepage', name: '字幕编码', hint: '外挂字幕文本编码；中文 GBK 可填 cp936，留空自动', placeholder: '如 cp936' },
        { type: 'divider' },
        { type: 'section', name: '同步与加载' },
        { type: 'slider', key: 'sub-delay', name: '字幕偏移', hint: '正值=字幕延后，负值=字幕提前（单位毫秒；与 OSC/右键菜单/快捷键的秒显示共用同一毫秒值）', min: -20000, max: 20000, step: 100, fmt: (v) => `${v}ms` },
        { type: 'select', key: 'sub-auto', name: '自动加载字幕',
          hint: 'mpv 引擎需重新载入文件或重启生效。',
          options: [['fuzzy', '自动（按文件名模糊匹配）'], ['exact', '严格匹配'], ['all', '加载全部字幕'], ['no', '关闭']] },
        { type: 'text', key: 'slang', name: '首选字幕语言',
          hint: '逗号分隔，如 chi,zho,zh,cmn / eng,jpn。ffmpeg 引擎即时生效；mpv 需重启或重新加载文件。', placeholder: 'chi,zho,zh,cmn' },
        { type: 'divider' },
        { type: 'section', name: '在线字幕（OpenSubtitles / 射手网 / 字幕库 / SubHD）' },
        { type: 'text', key: 'opensubtitles-key', name: 'API Key（OpenSubtitles）',
          hint: 'opensubtitles.com 免费注册后在个人设置创建。填写后搜索/下载 OpenSubtitles；不填时仍可使用无配置源：射手网、字幕库、SubHD。', placeholder: '如 ljnc55mUqXwU9OZcxC4Hf6ZqJ1WPVMIn' },
        { type: 'text', key: 'opensubtitles-user', name: '登录用户名',
          hint: 'OpenSubtitles 账号（即注册邮箱/用户名），仅用于下载。', placeholder: 'your account' },
        { type: 'password', key: 'opensubtitles-pass', name: '登录密码',
          hint: '明文存于 player.conf，请仅在私人机器使用。', placeholder: '••••••••' },
        { type: 'toggle', key: 'subtitles-autoload', name: '自动匹配字幕',
          hint: '载入视频时自动按文件名匹配首选语言字幕并加载；会同时尝试 OpenSubtitles（如已配置）、射手网、字幕库、SubHD。默认关闭以免消耗网络配额。' },
        { type: 'text', key: 'subtitles-proxy-url', name: '字幕代理地址（可选）',
          hint: 'OpenSubtitles 兼容代理（仅作用于 OpenSubtitles）。填了之后字幕搜索同时查官方与代理，结果更丰富。如 http://127.0.0.1:8080', placeholder: 'http://...',
          verify: { label: '验证', testPath: '' } },
      ],
    },
    {
      id: 'danmaku', label: '弹幕',
      desc: '弹幕来源（弹弹play 需 AppId / B 站 零配置 / 聚合代理覆盖爱奇艺·优酷·腾讯等）。',
      rows: [
        { type: 'divider' },
        { type: 'section', name: '弹幕来源（弹弹play 需 AppId · B 站 零配置 · 聚合代理覆盖爱奇艺/优酷/腾讯等）' },
        { type: 'text', key: 'dandanplay-id', name: '弹弹 AppId',
          hint: '弹弹play 调用需 AppId（免费）：打开 https://dandanplay.net → 开发者中心 → 创建应用即可获得 AppId 与 AppSecret。填入后按文件名+hash 精准匹配本地番剧弹幕。留空则跳过弹弹play（B 站 仍零配置可用）。', placeholder: '如 1234' },
        { type: 'password', key: 'dandanplay-secret', name: '弹弹 AppSecret',
          hint: '与 AppId 在同一页面获取（开发者中心 → 已创建应用详情）。明文存于 player.conf，请仅在私人机器使用。', placeholder: '••••••••' },
        { type: 'text', key: 'danmaku-proxy-url', name: '聚合代理地址（可选）',
          hint: '填了之后弹幕走 danmu_api 代理（cirnot9/huangxd- 项目，GitHub 可搜），一键覆盖 爱奇艺 / 优酷 / 腾讯视频 / 芒果TV / B站 / 人人 / 韩剧TV / 巴哈姆特 / 弹弹 等平台，无需逐个配 AppId。⚠️ 地址结尾必须带 /TOKEN，且 TOKEN 与部署时设的环境变量一致。例如 Vercel 部署后填 `https://你的项目.vercel.app/你的TOKEN`（未改 TOKEN 时默认 87654321）。留空则不走代理（仅用弹弹play + B 站）。部署：Docker `docker run -d -p 9321:9321 -e TOKEN=你的token logvar/danmu-api`，或 Vercel/Cloudflare 一键部署。', placeholder: 'https://域名/TOKEN',
          verify: { label: '验证', testPath: '/api/v2/search/anime?keyword=test' } },
        { type: 'password', key: 'bilibili-cookie', name: 'B 站 Cookie（可选）',
          hint: 'B 站弹幕零配置即可搜索/加载（仅靠 WBI 签名）。若想提升配额，登录 bilibili.com 后按 F12 → Application → Cookies → 复制 SESSDATA 完整值粘贴于此。', placeholder: 'SESSDATA=...（留空也工作）' },
        { type: 'toggle', key: 'danmaku-autoload', name: '自动匹配弹幕',
          hint: '载入视频时自动按文件名匹配弹幕并加载。开启即生效（B站零配置兜底，无需任何凭据）；配了弹弹 AppId 或聚合代理时会优先尝试精准匹配源。', default: true },
      ],
    },
    {
      id: 'cast', label: '投屏',
      desc: 'DLNA 投屏开箱即用，无需配置。Chromecast 投屏需自备「标准 Cast 客户端证书 + 私钥 + Salt」（Google 通过 Cast SDK 分发，Lumora 不内置任何证书）——在下方填入三项后方可连接 Chromecast。证书/私钥填 .pem 文件路径或粘贴 PEM 文本均可。',
      rows: [
        { type: 'divider' },
        { type: 'section', name: 'Chromecast 鉴权' },
        { type: 'text', key: 'cast.chromecastCert', name: '客户端证书',
          hint: '标准 Cast 客户端证书（.pem）。填文件路径（如 C:\\certs\\client.pem）或粘贴 PEM 文本（以 -----BEGIN CERTIFICATE----- 开头）。' },
        { type: 'password', key: 'cast.chromecastKey', name: '客户端私钥',
          hint: '与证书配对的私钥（.pem）。填文件路径或粘贴 PEM（-----BEGIN PRIVATE KEY-----）。明文存于 player.conf，仅私人机器使用。', placeholder: '路径或 PEM 文本' },
        { type: 'password', key: 'cast.chromecastSalt', name: '签名 Salt',
          hint: 'Google 分发的客户端签名 salt（十六进制/base64 字符串）。与证书、私钥一同获取。', placeholder: 'salt' },
      ],
    },
    {
      id: 'shortcuts', label: '快捷键',
      desc: '自定义按键与命令（点击按键后按下新键即可重新绑定；Esc 取消）。修改立即生效。',
      custom: 'keybinds',  // 由 KeybindEditor 接管渲染
    },
    {
      id: 'screenshots', label: '截图',
      desc: '截图输出设置（需重启生效）。',
      rows: [
        { type: 'select', key: 'screenshot-format', name: '图片格式',
          options: [['png', 'PNG（无损）'], ['jpg', 'JPG（更小）']] },
        { type: 'text', key: 'screenshot-dir', name: '保存目录',
          hint: '留空则保存到系统图片目录', placeholder: '如 D:\\Pictures' },
        { type: 'text', key: 'screenshot-template', name: '文件名模板',
          hint: '%F=文件名 %P=播放进度 %t=时间戳', placeholder: 'lumora-%F-%P' },
        { type: 'divider' },
        { type: 'section', name: '连拍（序列截图）' },
        { type: 'slider', key: 'screenshot-sequence-count', name: '连拍张数',
          hint: '一次连拍抓取的画面数量', min: 2, max: 30, step: 1, fmt: (v) => `${v} 张` },
        { type: 'slider', key: 'screenshot-sequence-interval', name: '连拍间隔',
          hint: '相邻两张画面的时间间隔（毫秒）', min: 100, max: 5000, step: 100, fmt: (v) => `${v} ms` },
        { type: 'action', name: '连拍截图', hint: '从当前播放位置起，按设定间隔连续抓取多张画面',
          action: () => window.takeScreenshotSequence && window.takeScreenshotSequence() },
      ],
    },
    {
      id: 'music', label: '音乐',
      desc: '音乐模式专属行为（纯音频播放时生效）。',
      rows: [
        { type: 'toggle', key: 'music.crossfade', name: '音乐接歌（交叉淡入淡出）',
          hint: '开启后，下一首的音频头会与当前曲尾重叠混音（equal-power 斜坡），曲目之间不再有静音缝隙。仅音乐模式（ffmpeg 引擎）支持；视频文件或 mpv 引擎下自动跳过。' },
        { type: 'slider', key: 'music.crossfade-duration', name: '交叉淡入淡出时长',
          hint: '斜坡时长（秒）。越大重叠越长、接缝越柔；过大会吞掉当前曲尾。建议 2~6 秒。', min: 0, max: 12, step: 0.5, fmt: (v) => `${Number(v).toFixed(1)}s` },
        { type: 'divider' },
        { type: 'section', name: '播放器内歌词字体' },
        { type: 'text', key: 'music.lyrics-font-family', name: '字体',
          hint: '留空使用界面默认字体；填写字体名区分大小写，如 "Microsoft YaHei"、"PingFang SC"，多个字体用逗号分隔。', placeholder: '如 Microsoft YaHei' },
        { type: 'slider', key: 'music.lyrics-font-weight', name: '字重',
          hint: '播放器内歌词粗细。100 最细，900 最粗。', min: 100, max: 900, step: 100, fmt: (v) => String(Number(v)) },
        { type: 'password', key: 'music.lyrics-musixmatch-token', name: 'Musixmatch 逐字歌词 Token',
          hint: '填入你自己的 Musixmatch 用户 token 后，歌词将优先下载「逐字」版本（唱到哪个字就哪个字着色）。留空则继续使用 LRCLIB 行级歌词（再由播放器按行跨度均匀估算逐字）。token 明文存于 player.conf，仅在私人机器使用。', placeholder: 'Musixmatch usertoken' },
      ],
    },
    {
      id: 'ai', label: 'AI 助手',
      desc: '配置内置 AI 助手的大模型后端（兼容 OpenAI 接口格式）。未填 API Key 时自动降级为离线桩，仍可演示字幕/弹幕/一键设置等能力（不联网）。',
      rows: [
        { type: 'section', name: '大模型接口' },
        { type: 'password', key: 'ai-api-key', name: 'API Key',
          hint: '填入后调用真实大模型（GPT / DeepSeek / 通义千问 / 智谱 / Claude / Gemini 等任意兼容 OpenAI chat/completions 格式的后端）。不填则使用内置离线桩，不联网也不消耗额度。明文存于 player.conf，请仅在私人机器使用。', placeholder: 'sk-...' },
        { type: 'text', key: 'ai-base-url', name: 'API 地址 (Base URL)',
          hint: '兼容 OpenAI 的 /chat/completions 端点前缀。各厂商默认地址不同：GPT 为 https://api.openai.com/v1；DeepSeek 为 https://api.deepseek.com；自建或第三方代理按实际填写。', placeholder: 'https://api.openai.com/v1' },
        { type: 'ai-model', key: 'ai-model', name: '模型名称',
          hint: '填后端支持的模型 ID（区分大小写）。可手动输入，也可点右侧「获取」自动从 API 拉取可用模型列表。常见值：OpenAI 用 gpt-4o-mini；DeepSeek 用 deepseek-chat 或 deepseek-v4；通义用 qwen-plus；智谱用 glm-4。', placeholder: 'deepseek-chat' },
        { type: 'ai-status', name: '当前后端', hint: '实时反映上方三项配置；填了 API Key 即切换为在线模型。修改后点击下方「重新加载 AI 后端」生效。' },
        { type: 'action', name: '重新加载 AI 后端', hint: '保存 Key / 地址 / 模型后点击，使其立即对助手生效（无需重启）；切换在线/离线也会同步刷新上方状态。',
          action: () => reloadAiFromSettings() },
        { type: 'action', name: '清空 AI 对话', hint: '重置助手对话上下文（已学习的习惯偏好会保留）',
          action: () => { if (window.lumen && window.lumen.aiReset) window.lumen.aiReset(); } },
      ],
    },
    {
      id: 'about', label: '关于',
      desc: '版本与许可信息。',
      rows: [
        { type: 'about' },
        { type: 'update' },
        { type: 'action', name: '导出键位表', hint: '查看并复制完整默认键位（mpv 语法）',
          action: () => exportKeybindsPreview() },
        { type: 'action', name: '查看开源声明', hint: '第三方许可与义务', action: () => toggleLicenses(true) },
        { type: 'action-danger', name: '恢复默认设置', hint: '将所有配置与键位重置为出厂默认（重启后完全生效）',
          action: () => resetAllSettings() },
      ],
    },
  ];

  // 构建侧边导航
  sections.forEach((sec, i) => {
    const item = document.createElement('button');
    item.className = 'settings-nav-item' + (i === 0 ? ' active' : '');
    item.dataset.section = sec.id;
    item.textContent = sec.label;
    item.addEventListener('click', () => {
      document.querySelectorAll('.settings-nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      settingsActiveSection = sec.id;
      document.querySelectorAll('.settings-section').forEach((s) => s.classList.remove('active'));
      const target = document.querySelector(`.settings-section[data-section="${sec.id}"]`);
      if (target) target.classList.add('active');
    });
    nav.appendChild(item);
  });

  // 顶部搜索框：跨分区过滤（粘性定位在内容区顶部）
  const searchWrap = document.createElement('div');
  searchWrap.className = 'set-search';
  searchWrap.innerHTML = `<input id="settings-search" type="text" placeholder="搜索设置项…" spellcheck="false">`;
  content.appendChild(searchWrap);
  const searchInput = searchWrap.querySelector('#settings-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => filterSettings(searchInput.value.trim().toLowerCase()));
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());
    searchInput.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // 构建各分区内容
  sections.forEach((sec, i) => {
    const section = document.createElement('section');
    section.className = 'settings-section' + (i === 0 ? ' active' : '');
    section.dataset.section = sec.id;
    section.innerHTML =
      `<h2>${sec.label}</h2><p class="section-desc">${sec.desc}</p>`;

    // 自定义分区（如快捷键编辑器）走专用渲染器，不走通用 row 模型
    if (sec.custom === 'keybinds') {
      const mount = document.createElement('div');
      mount.className = 'keybind-mount';
      section.appendChild(mount);
      mountSettingsKeybinds(mount);
      content.appendChild(section);
      return;
    }

    sec.rows.forEach((row) => {
      const r = document.createElement('div');
      r.className = 'set-row';
      const searchText = `${row.name || ''} ${row.hint || ''} ${row.key || ''} ${row.type === 'section' ? row.name : ''}`;
      if (row.type === 'about') {
        const ver = (bootstrapData && bootstrapData().version) || '未知';
        const plat = (bootstrapData && bootstrapData().platform) || '';
        r.innerHTML =
          `<div class="set-about"><div><span class="ver">Lumora</span> ${ver}</div>` +
          `<div>基于 Electron ${bootstrapData().versions ? bootstrapData().versions.electron : ''} · ${plat}</div>` +
          `<div>播放后端：mpv（仅 Windows 分发）</div>` +
          `<div style="margin-top:8px">本软件以私有许可分发。点击右侧「查看开源声明」了解随附的第三方组件许可与义务。</div></div>`;
      } else if (row.type === 'update') {
        const ver = (bootstrapData && bootstrapData().version) || '未知';
        r.innerHTML =
          `<div class="set-label"><span class="name">软件更新</span>` +
          `<span class="hint">自动检查并下载更新；就绪后重启安装（仅打包版本可用）</span></div>` +
          `<div class="set-control update-control">` +
            `<button type="button" class="set-action" id="btn-check-update">检查更新</button>` +
            `<span class="update-status" id="update-status">当前 v${escapeHtml(ver)}</span>` +
          `</div>`;
      } else if (row.type === 'action' || row.type === 'action-danger') {
        settingsActions[row.name] = row.action;
        const cls = row.type === 'action-danger' ? 'set-action danger' : 'set-action';
        const confirmAttr = row.type === 'action-danger' ? ' data-confirm="1"' : '';
        r.innerHTML =
          `<div class="set-label"><span class="name">${row.name}</span>` +
          (row.hint ? `<span class="hint">${row.hint}</span>` : '') + `</div>` +
          `<div class="set-control"><button class="${cls}" data-action="${row.name}"${confirmAttr}>${row.name}</button></div>`;
      } else if (row.type === 'divider') {
        r.className = 'set-row set-divider';
        r.innerHTML = '';
      } else if (row.type === 'section') {
        r.className = 'set-row set-subhead';
        r.innerHTML = `<div class="set-subhead-label">${escapeHtml(row.name)}</div>`;
      } else {
        const v = cfg[row.key];
        let ctrl = '';
        if (row.type === 'select') {
          const opts = row.options.map(([val, label]) =>
            `<div class="set-opt ${String(v) === val ? 'selected' : ''}" role="option" data-val="${escapeHtml(val)}">${escapeHtml(label)}</div>`
          ).join('');
          const curLabel = (row.options.find(([val]) => String(v) === val) || row.options[0])[1];
          ctrl = `<button type="button" class="set-select" data-key="${row.key}" aria-haspopup="listbox" aria-expanded="false">` +
            `<span class="set-select-val">${escapeHtml(curLabel)}</span>` +
            `<svg class="set-select-caret" viewBox="0 0 10 6" width="10" height="6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
            `<div class="set-select-list" role="listbox" hidden>${opts}</div>` +
            `</button>`;
        } else if (row.type === 'toggle') {
          ctrl = `<button class="set-toggle ${v ? 'on' : ''}" data-key="${row.key}" aria-pressed="${!!v}"></button>`;
        } else if (row.type === 'slider') {
          const cur = (v === undefined || v === null) ? row.min : v;
          ctrl = `<input type="range" class="set-slider" data-key="${row.key}" ` +
            `min="${row.min}" max="${row.max}" step="${row.step}" value="${cur}">` +
            `<span class="set-value" data-val="${row.key}">${row.fmt(cur)}</span>`;
          settingsFmt[row.key] = row.fmt;
        } else if (row.type === 'text') {
          ctrl = `<input type="text" class="set-text" data-key="${row.key}" ` +
            `value="${escapeHtml(v == null ? '' : v)}" ` +
            (row.placeholder ? `placeholder="${escapeHtml(row.placeholder)}" ` : '') + `>` +
            (row.verify ? `<button class="set-action ghost verify-btn" id="verify-${row.key}" title="验证连通性">${row.verify.label || '验证'}</button><span class="verify-result" id="verify-${row.key}-result"></span>` : '');
        } else if (row.type === 'password') {
          ctrl = `<input type="password" class="set-text" data-key="${row.key}" ` +
            `value="${escapeHtml(v == null ? '' : v)}" ` +
            (row.placeholder ? `placeholder="${escapeHtml(row.placeholder)}" ` : '') + `>` +
            (row.verify ? `<button class="set-action ghost verify-btn" id="verify-${row.key}" title="验证连通性">${row.verify.label || '验证'}</button><span class="verify-result" id="verify-${row.key}-result"></span>` : '');
        } else if (row.type === 'color') {
          ctrl = `<input type="color" class="set-color" data-key="${row.key}" value="${escapeHtml(v == null ? '#FFFFFF' : v)}">`;
        } else if (row.type === 'ai-status') {
          // 实时后端状态徽标；由 refreshAiStatus() 异步填充
          ctrl = '<span id="ai-status-badge" class="ai-status-badge">检测中…</span>';
        } else if (row.type === 'ai-model') {
          // 模型名称输入 + 获取按钮 + 下拉列表
          const v = cfg[row.key] || '';
          ctrl =
            `<div class="ai-model-row">` +
              `<input type="text" class="set-text ai-model-input" data-key="${row.key}" ` +
              `value="${escapeHtml(v)}" placeholder="${row.placeholder ? escapeHtml(row.placeholder) : ''}">` +
              `<button class="set-action ai-model-fetch-btn" id="ai-fetch-models-btn" title="从 API 获取可用模型列表">获取</button>` +
            `</div>` +
            `<div class="ai-model-dropdown" id="ai-model-dropdown" hidden></div>`;
        }
        r.innerHTML =
          `<div class="set-label"><span class="name">${row.name}</span>` +
          (row.hint ? `<span class="hint">${row.hint}</span>` : '') + `</div>` +
          `<div class="set-control">${ctrl}</div>`;
      }
      if (searchText) r.dataset.search = searchText;
      section.appendChild(r);
    });

    content.appendChild(section);
  });

  // 绑定控件事件
  content.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    if (el.classList.contains('set-select')) {
      // 自定义下拉：点击展开/收起；点选项即选中并保存
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        // 来自内联选项（浮层克隆项会派发合成 click 到原节点）的事件不应再次触发展开
        if (e.target.closest('.set-opt')) return;
        const list = el.querySelector('.set-select-list');
        if (!list) return;
        if (setSelectOpen && setSelectOpen.el === el) { closeSetSelect(); return; }
        closeSetSelect(true);
        setSelectOpen = { el, list };
        el.classList.add('open');
        el.setAttribute('aria-expanded', 'true');
        openSetSelect(el, list);
      });
      el.querySelectorAll('.set-opt').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.val;
          el.querySelectorAll('.set-opt').forEach((o) => o.classList.remove('selected'));
          opt.classList.add('selected');
          const label = el.querySelector('.set-select-val');
          if (label) label.textContent = opt.textContent;
          saveSetting(key, val);
          closeSetSelect();
        });
      });
    } else if (el.classList.contains('set-toggle')) {
      el.addEventListener('click', () => {
        const on = !el.classList.contains('on');
        el.classList.toggle('on', on);
        el.setAttribute('aria-pressed', String(on));
        saveSetting(key, on);
      });
    } else if (el.classList.contains('set-slider')) {
      const valLabel = content.querySelector(`[data-val="${key}"]`);
      el.addEventListener('input', () => { if (valLabel && settingsFmt[key]) valLabel.textContent = settingsFmt[key](el.value); });
      el.addEventListener('change', () => saveSetting(key, parseFloat(el.value)));
    } else if (el.classList.contains('set-text')) {
      el.addEventListener('change', async () => {
        await saveSetting(key, el.value.trim());
        // ai-* 配置改动后热重载后端（等 config 写完再读，避免竞态）
        if (key.indexOf('ai-') === 0) await reloadAiFromSettings();
      });
    } else if (el.classList.contains('set-color')) {
      el.addEventListener('input', () => saveSetting(key, el.value));
    }
  });
  content.querySelectorAll('[data-action]').forEach((el) => {
    const fn = settingsActions[el.dataset.action];
    if (!fn) return;
    el.addEventListener('click', async () => {
      if (el.dataset.confirm) {
        const ok = await confirmDialog('此操作将重置全部设置与快捷键为默认值，且不可撤销。确定继续？');
        if (!ok) return;
      }
      fn();
    });
  });

  // 软件更新：检查 / 安装按钮
  const btnCheckUpdate = document.getElementById('btn-check-update');
  if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener('click', () => {
      if (updateDownloaded) {
        if (window.lumen && window.lumen.installUpdate) window.lumen.installUpdate();
        return;
      }
      btnCheckUpdate.disabled = true;
      const st = document.getElementById('update-status');
      if (st) { st.textContent = '检查中…'; st.className = 'update-status busy'; }
      if (window.lumen && window.lumen.checkForUpdates) {
        window.lumen.checkForUpdates()
          .catch((e) => {
            if (st) { st.textContent = '检查失败：' + ((e && e.message) || e); st.className = 'update-status error'; }
          })
          .finally(() => { btnCheckUpdate.disabled = false; });
      } else {
        btnCheckUpdate.disabled = false;
      }
    });
  }

  settingsBuilt = true;
  // 设置面板构建完成后刷新 AI 后端状态徽标（异步，不阻塞）
  refreshAiStatus();

  // 绑定「获取模型列表」按钮（按钮由 ai-model 行类型动态生成）
  const fetchBtn = document.getElementById('ai-fetch-models-btn');
  if (fetchBtn) fetchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fetchAiModels();
  });

  // 绑定「验证连通性」按钮（由 text/password 行的 verify 属性动态生成）
  bindVerifyButton('verify-danmaku-proxy-url', 'danmaku-proxy-url',
    '/api/v2/search/anime?keyword=test', '验证');
  bindVerifyButton('verify-subtitles-proxy-url', 'subtitles-proxy-url',
    '', '验证');
}

/** 挂载快捷键编辑器：拉取默认表 + 用户覆盖，渲染可编辑列表 */
async function mountSettingsKeybinds(mountEl) {
  if (!mountEl) return;
  mountEl.innerHTML = '<div class="set-search-empty">读取键位中…</div>';
  let data;
  try {
    data = await window.lumen.getKeybinds();
  } catch (e) {
    mountEl.innerHTML = `<div class="set-search-empty">读取失败：${escapeHtml(e.message || e)}</div>`;
    return;
  }
  // 每次构建都用新实例绑定到当前挂载点（重建设置面板后旧 mount 已脱离 DOM）
  keybindEditor = new KeybindEditor(mountEl);
  // 顶部工具条：恢复全部默认 + 保存
  const toolbar = document.createElement('div');
  toolbar.className = 'keybind-toolbar';
  toolbar.innerHTML =
    `<button type="button" class="set-action ghost" data-kb="reset-all">恢复全部默认</button>` +
    `<button type="button" class="set-action" data-kb="save">保存修改</button>`;
  mountEl.parentNode.insertBefore(toolbar, mountEl);
  keybindEditor.build(data.defaults || [], data.user || []);
  toolbar.querySelector('[data-kb="reset-all"]').addEventListener('click', () => {
    keybindEditor.resetAll();
  });
  toolbar.querySelector('[data-kb="save"]').addEventListener('click', async () => {
    const text = keybindEditor.serialize();
    try {
      const res = await window.lumen.saveKeybinds(text);
      if (res && res.ok) {
        // 重新载入键位到生效表，并刷新键位速查面板
        if (res.config && res.config.keybinds) {
          keybinds.load(res.config.keybinds);
          if (keymap()) keymap().load(res.config.keybinds);
        }
        osd && osd.message('快捷键已保存', '重启后完全生效', { duration: 2200 });
      } else {
        osd && osd.message('保存失败', (res && res.error) || '', { duration: 2600 });
      }
    } catch (e) {
      osd && osd.message('保存失败', e.message || '', { duration: 2600 });
    }
  });
}

/** 导出键位表：弹窗展示完整默认键位（mpv 语法），便于复制 */
async function exportKeybindsPreview() {
  try {
    const res = await window.lumen.exportKeybinds();
    const text = (res && res.text) || '';
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      `<div class="confirm-card" style="max-width:560px">` +
      `<div class="confirm-msg" style="margin-bottom:10px">完整默认键位（mpv input.conf 语法）：</div>` +
      `<textarea class="kb-export" readonly spellcheck="false">${escapeHtml(text)}</textarea>` +
      `<div class="confirm-actions">` +
      `<button type="button" class="set-action ghost" data-r="copy">复制</button>` +
      `<button type="button" class="set-action" data-r="close">关闭</button>` +
      `</div></div>`;
    document.body.appendChild(overlay);
    const ta = overlay.querySelector('.kb-export');
    overlay.addEventListener('click', (e) => {
      if (e.target.dataset.r === 'close' || e.target === overlay) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      } else if (e.target.dataset.r === 'copy') {
        try { ta.select(); document.execCommand('copy'); } catch {}
        e.target.textContent = '已复制';
        setTimeout(() => { e.target.textContent = '复制'; }, 1200);
      }
    });
  } catch (e) {
    osd && osd.message('导出失败', e.message || '', { duration: 2200 });
  }
}

/** 恢复全部默认设置：重置 config + 键位，并刷新界面缓存 */
async function resetAllSettings() {
  try {
    const res = await window.lumen.resetConfig();
    if (res && res.ok) {
      // 刷新本地缓存，让依赖 bootstrapData().config.values 的地方生效
      if (bootstrapData && bootstrapData().config) {
        bootstrapData().config.values = res.config.values;
        bootstrapData().config.keybinds = res.config.keybinds;
      }
      keybinds.load(res.config.keybinds);
      if (keymap()) keymap().load(res.config.keybinds);
      // 重新构建设置面板以反映默认值
      settingsBuilt = false;
      buildSettings();
      osd && osd.message('已恢复默认设置', '重启播放器后完全生效', { duration: 2600 });
    } else {
      osd && osd.message('恢复失败', (res && res.error) || '', { duration: 2600 });
    }
  } catch (e) {
    osd && osd.message('恢复失败', e.message || '', { duration: 2600 });
  }
}

export function toggleSettings(force) {
  const next = (force !== undefined) ? force : !settingsVisible;
  settingsVisible = next;
  if (!settingsVisible) closeSetSelect(true);
  const panel = $('settings-panel');
  panel.classList.toggle('hidden', !settingsVisible);
  document.body.classList.toggle('settings-open', settingsVisible);
  if (settingsVisible) {
    // 打开设置时关闭合规面板，避免两个浮层叠加
    if (isLicensesVisible()) toggleLicenses(false);
    if (!settingsBuilt) buildSettings();
    // 延迟到布局完成后：居中窗口 + 重置滚动 + 切回第一个分区
    requestAnimationFrame(() => {
      if (!settingsUserMoved) centerSettingsWindow();
      // 确保窗口不超出视口底部
      clampSettingsWindowInViewport();
      // 重置滚动位置到顶部
      const content = $('settings-content');
      if (content) content.scrollTop = 0;
      // 切回默认分区（常规）
      switchSettingsSection('general');
    });
    // 刷新 AI 后端状态
    refreshAiStatus();
    // 拉取当前更新状态（dev 模式会显示「更新不可用」）
    if (window.lumen && window.lumen.getUpdateState) {
      window.lumen.getUpdateState().then(applyUpdaterStatus).catch(() => {});
    }
  }
}


