/**
 * 投屏面板（自包含模块，cast-out，v1 = DLNA + Chromecast）。
 * 从 app.js 拆出（2026-08）：设备发现列表 + 连接 + 投屏当前/URL + 播放控制。
 * 主进程逻辑在 src/main/cast/* + ipc-cast.js；本模块只负责 UI 与调用 window.lumen.cast*。
 * 用法：setupCast({ player, osd });  toggleCastPanel() 由 app.js 暴露给右键菜单/命令总线。
 */
import { fmtTime } from '../core/player.js';
import { escapeHtml as esc } from '../../shared/escape-html.js';
import { baseName } from '../../shared/path-base.js';

const $ = (id) => document.getElementById(id);

let CTX = {};
let listenersRegistered = false;
let devices = [];          // 最近一次设备快照（udn -> summary）
let connectedUdn = null;   // 当前已连接的 udn
let lastState = null;      // 最近一次 cast:state
let castDragState = null;  // 拖拽会话状态
let castUserMoved = false; // 用户是否手动拖过位置

export function setupCast(ctx) {
  CTX = ctx || {};
  registerListeners();
  makeCastDraggable();
  isolateCastEvents();
  window.addEventListener('resize', onCastResize);
}
function registerListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;
  if (window.lumen && window.lumen.on) {
    window.lumen.on('cast:device', (d) => {
      const i = devices.findIndex((x) => x.udn === d.udn);
      if (i >= 0) devices[i] = d; else devices.push(d);
      if (isCastVisible()) renderCastPanel();
    });
    window.lumen.on('cast:state', (s) => {
      lastState = s;
      if (s && s.connected) connectedUdn = s.udn;
      else connectedUdn = null;
      if (isCastVisible()) renderCastPanel();
    });
  }
}

const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a) };

function isNetworkUrl(p) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(p || ''); }

/* ---------------- 面板开关 ---------------- */

export function toggleCastPanel() {
  const panel = $('cast-panel');
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    openCastPanel();
  } else {
    closeCastPanel();
  }
}

export function closeCastPanel() {
  const panel = $('cast-panel');
  if (panel) panel.classList.add('hidden');
  document.body.classList.remove('cast-open');
  castUserMoved = false;
  if (window.lumen && window.lumen.castStopDiscovery) window.lumen.castStopDiscovery();
}

export function isCastVisible() {
  const panel = $('cast-panel');
  return !!panel && !panel.classList.contains('hidden');
}

function openCastPanel() {
  const panel = $('cast-panel');
  if (!panel) return;
  renderCastPanel();
  panel.classList.remove('hidden');
  document.body.classList.add('cast-open');
  castUserMoved = false;
  // 显式居中并去掉 transform，让后续拖拽以真实 left/top 为准
  requestAnimationFrame(() => centerCastWindow());
  // 拉一次已知设备，并启动发现
  if (window.lumen && window.lumen.castList) {
    window.lumen.castList().then((list) => {
      if (Array.isArray(list)) { devices = list; if (isCastVisible()) renderCastPanel(); }
    }).catch(() => {});
  }
  if (window.lumen && window.lumen.castStartDiscovery) {
    window.lumen.castStartDiscovery().catch((e) => osd.message('投屏发现失败', e && e.message || '', { duration: 3000 }));
  }
}

function makeCastDraggable() {
  const head = document.querySelector('.cast-window .panel-head.draggable');
  const win = $('cast-window');
  if (!head || !win) return;

  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return; // 关闭按钮不触发拖拽
    castDragState = {
      startX: e.clientX,
      startY: e.clientY,
      initLeft: win.offsetLeft,
      initTop: win.offsetTop,
    };
    head.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!castDragState) return;
    const dx = e.clientX - castDragState.startX;
    const dy = e.clientY - castDragState.startY;
    let x = castDragState.initLeft + dx;
    let y = castDragState.initTop + dy;

    // 限制窗口主体不跑出视口
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minVisible = 48;
    x = Math.max(minVisible - win.offsetWidth, Math.min(x, vw - minVisible));
    y = Math.max(0, Math.min(y, vh - minVisible));

    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
    win.style.transform = 'none';
    castUserMoved = true;
  });

  window.addEventListener('mouseup', () => {
    if (!castDragState) return;
    castDragState = null;
    head.style.cursor = 'grab';
  });
}

function centerCastWindow() {
  const win = $('cast-window');
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

function onCastResize() {
  const panel = $('cast-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  const win = $('cast-window');
  if (!win) return;
  if (!castUserMoved) {
    centerCastWindow();
    return;
  }
  // 用户拖过：只做边界约束
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minVisible = 48;
  let x = win.offsetLeft;
  let y = win.offsetTop;
  x = Math.max(minVisible - win.offsetWidth, Math.min(x, vw - minVisible));
  y = Math.max(0, Math.min(y, vh - minVisible));
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
}

function isolateCastEvents() {
  const win = $('cast-window');
  if (!win) return;
  // 阻止投屏浮窗内事件继续冒泡到 window 层的播放区监听器
  // （input.js 的 isUiTarget 已把 cast 容器加入白名单，这里是双重保险）
  for (const ev of ['mousedown', 'wheel', 'dblclick']) {
    win.addEventListener(ev, (e) => { e.stopPropagation(); }, false);
  }
  // 点遮罩关闭（mousedown 已在 backdrop 处被 isUiTarget 拦截，不会触发播放区点击）
  const backdrop = $('cast-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCastPanel();
    });
  }
}

/* ---------------- 渲染 ---------------- */

function renderCastPanel() {
  const list = $('cast-list');
  if (!list) return;
  list.innerHTML = '';

  // 连接状态条
  const status = $('cast-status');
  if (status) {
    if (lastState && lastState.connected) {
      const dev = devices.find((d) => d.udn === connectedUdn);
      const st = (lastState.state || '').replace('_PLAYBACK', '').toLowerCase();
      status.className = 'cast-status connected';
      status.textContent = `已连接：${dev ? dev.friendlyName : connectedUdn} · ${st || '—'}` +
        (lastState.positionSeconds != null ? ` · ${fmtTime(lastState.positionSeconds)}` +
          (lastState.durationSeconds ? '/' + fmtTime(lastState.durationSeconds) : '') : '');
    } else {
      status.className = 'cast-status';
      status.textContent = devices.length ? `发现 ${devices.length} 台设备` : '正在搜索局域网设备…';
    }
  }

  if (!devices.length) {
    const empty = document.createElement('div');
    empty.className = 'cast-empty';
    empty.textContent = '未发现投屏设备。请确保电视/盒子已开机并连入同一 Wi-Fi，且开启了 DLNA 或 Chromecast 投屏。';
    list.appendChild(empty);
    return;
  }

  devices.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'cast-device' + (d.udn === connectedUdn ? ' connected' : '');
    const info = document.createElement('div');
    info.className = 'cast-device-info';
    const typeLabel = d.type === 'chromecast' ? 'Chromecast'
      : d.type === 'dial' ? 'DIAL'
      : 'DLNA';
    info.innerHTML =
      `<span class="cast-device-head">` +
        `<span class="cast-device-name">${esc(d.friendlyName || d.udn)}</span>` +
        `<span class="cast-device-type type-${(d.type || 'dlna')}">${typeLabel}</span>` +
      `</span>` +
      `<span class="cast-device-model">${esc([d.manufacturer, d.modelName].filter(Boolean).join(' '))}</span>`;
    const btn = document.createElement('button');
    btn.className = 'cast-connect-btn';
    if (d.udn === connectedUdn) {
      btn.textContent = '已连接';
      btn.disabled = true;
    } else {
      btn.textContent = '连接';
      btn.addEventListener('click', () => connectDevice(d.udn));
    }
    row.append(info, btn);
    list.appendChild(row);
  });

  // 连接后显示控制区
  const controls = $('cast-controls');
  if (controls) {
    controls.innerHTML = '';
    if (connectedUdn) {
      controls.appendChild(buildControls());
    } else {
      const hint = document.createElement('div');
      hint.className = 'cast-hint';
      hint.textContent = '连接设备后即可投屏当前正在播放的内容，或投屏任意网络串流地址。';
      controls.appendChild(hint);
    }
  }
}

function buildControls() {
  const wrap = document.createElement('div');
  wrap.className = 'cast-controls-inner';

  // 投屏当前 / URL
  const actions = document.createElement('div');
  actions.className = 'cast-actions';
  const castCur = document.createElement('button');
  castCur.className = 'cast-action-btn primary';
  castCur.textContent = '投屏当前内容';
  castCur.addEventListener('click', () => castCurrent());
  actions.appendChild(castCur);

  const urlRow = document.createElement('div');
  urlRow.className = 'cast-url-row';
  const urlInput = document.createElement('input');
  urlInput.id = 'cast-url-input';
  urlInput.type = 'url';
  urlInput.className = 'cast-url-input';
  urlInput.placeholder = '投屏网络串流地址（http/rtsp/rtmp…）';
  const urlBtn = document.createElement('button');
  urlBtn.className = 'cast-action-btn';
  urlBtn.textContent = '投屏';
  urlBtn.addEventListener('click', () => {
    const u = urlInput.value.trim();
    if (!u) { osd.message('地址为空', '', { duration: 2000 }); return; }
    castUrl(u);
  });
  urlRow.append(urlInput, urlBtn);
  actions.appendChild(urlRow);
  wrap.appendChild(actions);

  // 传输控制
  const transport = document.createElement('div');
  transport.className = 'cast-transport';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'cast-tbtn';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  transport.appendChild(mk('暂停', () => doCast('castPause', '已暂停投屏')));
  transport.appendChild(mk('继续', () => doCast('castResume', '继续投屏')));
  transport.appendChild(mk('停止', () => doCast('castStop', '已停止投屏')));
  transport.appendChild(mk('同步进度', () => {
    const t = player.props ? (player.props['time-pos'] || 0) : 0;
    if (window.lumen.castSeek) window.lumen.castSeek(t).then(() => osd.message('已同步进度', fmtTime(t), { duration: 2000 })).catch((e) => osd.message('同步失败', e.message, { duration: 2500 }));
  }));
  wrap.appendChild(transport);

  // 音量
  const volRow = document.createElement('div');
  volRow.className = 'cast-vol-row';
  const volLabel = document.createElement('span');
  volLabel.className = 'cast-vol-label';
  volLabel.textContent = '电视音量';
  const vol = document.createElement('input');
  vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.value = '100'; vol.className = 'cast-vol';
  const volVal = document.createElement('span');
  volVal.className = 'cast-vol-val'; volVal.textContent = '100';
  vol.addEventListener('input', () => { volVal.textContent = vol.value; });
  vol.addEventListener('change', () => {
    if (window.lumen.castSetVolume) window.lumen.castSetVolume(Number(vol.value)).catch((e) => osd.message('音量失败', e.message, { duration: 2000 }));
  });
  volRow.append(volLabel, vol, volVal);
  wrap.appendChild(volRow);

  // 断开
  const disc = document.createElement('button');
  disc.className = 'cast-action-btn danger';
  disc.textContent = '断开连接';
  disc.addEventListener('click', () => {
    if (window.lumen.castDisconnect) window.lumen.castDisconnect().then(() => { connectedUdn = null; renderCastPanel(); }).catch(() => {});
  });
  wrap.appendChild(disc);

  return wrap;
}

/* ---------------- 动作 ---------------- */

async function connectDevice(udn) {
  if (!window.lumen || !window.lumen.castConnect) return;
  try {
    const dev = await window.lumen.castConnect(udn);
    connectedUdn = udn;
    osd.message('已连接', dev.friendlyName || udn, { duration: 2000 });
    renderCastPanel();
  } catch (e) {
    osd.message('连接失败', e.message, { duration: 3000 });
  }
}

async function castCurrent() {
  const info = player.info;
  if (!info || !info.path) { osd.message('无法投屏', '当前未载入媒体', { duration: 2500 }); return; }
  const args = {
    title: info.title || baseName(info.path),
    duration: info.duration,
    resolution: (info.width && info.height) ? `${info.width}x${info.height}` : undefined,
  };
  try {
    if (isNetworkUrl(info.path)) {
      await window.lumen.castPlayUrl(info.path, { title: args.title });
      osd.message('已投屏', '网络串流', { duration: 2000 });
    } else {
      await window.lumen.castPlayFile(info.path, args);
      osd.message('已投屏', args.title, { duration: 2000 });
    }
  } catch (e) {
    osd.message('投屏失败', e.message, { duration: 3000 });
  }
}

async function castUrl(url) {
  try {
    await window.lumen.castPlayUrl(url, { title: url });
    osd.message('已投屏', '网络串流', { duration: 2000 });
  } catch (e) {
    osd.message('投屏失败', e.message, { duration: 3000 });
  }
}

function doCast(method, okMsg) {
  if (window.lumen && window.lumen[method]) {
    window.lumen[method]().then(() => osd.message(okMsg, '', { duration: 1500 })).catch((e) => osd.message('操作失败', e.message, { duration: 2500 }));
  }
}

