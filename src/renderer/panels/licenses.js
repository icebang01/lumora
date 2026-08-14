import { clamp } from '../../shared/clamp.js';
/**
 * 许可证面板(自包含模块)。
 * 从 app.js 拆出(2026-08):setupLicensesPanel/toggleLicenses/构建与拖拽。
 * visible 状态模块内自持,对外暴露 isLicensesVisible()。
 */
const $ = (id) => document.getElementById(id);

let visible = false;
export function isLicensesVisible() { return visible; }
let licensesBuilt = false;
let licensesDragState = null;   // 拖拽会话状态(pointerdown 记录, mousemove 消费)
let licensesUserMoved = false;

let CTX = {};
export function setupLicensesPanel(ctx) {
  CTX = ctx || {};
  $('licenses-close').addEventListener('click', () => toggleLicenses(false));
  $('tb-licenses').addEventListener('click', () => toggleLicenses(true));

  const panel = $('licenses-panel');
  const backdrop = panel.querySelector('.licenses-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => toggleLicenses(false));

  makeLicensesDraggable();
  window.addEventListener('resize', onLicensesResize);
  buildLicenses();
}

function makeLicensesDraggable() {
  const head = document.querySelector('.licenses-window .panel-head.draggable');
  const win = document.querySelector('.licenses-window');
  if (!head || !win) return;

  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return; // 关闭按钮不触发拖拽
    licensesDragState = {
      startX: e.clientX,
      startY: e.clientY,
      initLeft: win.offsetLeft,
      initTop: win.offsetTop,
    };
    head.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!licensesDragState) return;
    const win = document.querySelector('.licenses-window');
    const dx = e.clientX - licensesDragState.startX;
    const dy = e.clientY - licensesDragState.startY;
    let x = licensesDragState.initLeft + dx;
    let y = licensesDragState.initTop + dy;

    // 限制窗口主体不跑出视口
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minVisible = 48;
    x = clamp(x, minVisible - win.offsetWidth, vw - minVisible);
    y = clamp(y, 0, vh - minVisible);

    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
    win.style.transform = 'none';
    licensesUserMoved = true;
  });

  window.addEventListener('mouseup', () => {
    if (!licensesDragState) return;
    licensesDragState = null;
    const head = document.querySelector('.licenses-window .panel-head.draggable');
    if (head) head.style.cursor = 'grab';
  });
}

function centerLicensesWindow() {
  const win = document.querySelector('.licenses-window');
  if (!win) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = win.getBoundingClientRect();
  const x = Math.round((vw - rect.width) / 2);
  const y = Math.round((vh - rect.height) / 2);
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
  win.style.transform = 'none';
}

function onLicensesResize() {
  if (!visible) return;
  const win = document.querySelector('.licenses-window');
  if (!win) return;
  if (!licensesUserMoved) {
    centerLicensesWindow();
    return;
  }
  // 用户拖过：只做边界约束，避免 resize 后窗口跑到不可见区域
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minVisible = 48;
  let x = win.offsetLeft;
  let y = win.offsetTop;
  x = clamp(x, minVisible - win.offsetWidth, vw - minVisible);
  y = clamp(y, 0, vh - minVisible);
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
}

function buildLicenses() {
  if (licensesBuilt) return;
  const body = $('licenses-body');
  if (!body) return;
  body.innerHTML = `
    <p>Lumora 随附以下第三方组件。完整许可文本以各上游仓库为准；
       应用内仅列要点，完整版见仓库 <code>THIRD_PARTY_LICENSES.md</code>。</p>

    <h3>mpv · 视频后端（独立进程）</h3>
    <p>许可证：<b>GPLv2-or-later</b> ·
       源码 <a href="https://github.com/mpv-player/mpv" target="_blank" rel="noopener">github.com/mpv-player/mpv</a><br>
       义务：须提供 mpv 对应源码与许可证全文；若对其有修改须公开。</p>

    <h3>FFmpeg / ffprobe · 解封装与探测（独立进程 · LGPL 构建）</h3>
    <p>许可证：<b>LGPL v2.1</b>（发布构建为 lgpl，无 GPL 组件；<code>npm run fetch-deps</code> 拉取）·
       源码 <a href="https://github.com/FFmpeg/FFmpeg" target="_blank" rel="noopener">github.com/FFmpeg/FFmpeg</a><br>
       义务：仅随附 LGPL 许可证与源码要约，未修改/链接其代码。</p>

    <h3>Electron · 应用框架</h3>
    <p>许可证：<b>MIT</b> ·
       源码 <a href="https://github.com/electron/electron" target="_blank" rel="noopener">github.com/electron/electron</a>
       （同时捆绑 Chromium / Node.js，各自许可随附保留）。</p>

    <h3>ws · WebSocket 库</h3>
    <p>许可证：<b>MIT</b> ·
       源码 <a href="https://github.com/websockets/ws" target="_blank" rel="noopener">github.com/websockets/ws</a></p>

    <div class="lic-note">
      本项目正在将解码后端迁移到 Windows Media Foundation（系统编解码器），
      以彻底移除 GPL 二进制并规避 H.264/AAC/HEVC 等编解码器专利。
      迁移完成前，上述 GPL/LGPL 义务须被履行。详见 <code>COMMERCIALIZATION.md</code>。
    </div>
  `;
  licensesBuilt = true;
}

export function toggleLicenses(force) {
  const next = (force !== undefined) ? force : !visible;
  visible = next;
  const panel = $('licenses-panel');
  panel.classList.toggle('hidden', !visible);
  document.body.classList.toggle('licenses-open', visible);
  if (visible) {
    // 打开合规面板时关闭其他浮层，避免叠加（由 app.js 注入闭包）
    if (CTX.closeOverlays) CTX.closeOverlays();
    // 面板显示后再获取实际尺寸并居中；首次打开时重置用户拖拽标记
    if (!licensesUserMoved) {
      requestAnimationFrame(() => centerLicensesWindow());
    }
  }
  }

