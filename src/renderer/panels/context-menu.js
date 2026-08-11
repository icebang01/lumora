/**
 * 右键菜单(自包含模块)。
 * 从 app.js 拆出(2026-08):openContextMenu/closeContextMenu/菜单构建/命令执行。
 * 用法:setupContextMenu({ runCommand, player, osd });(boot 时注入)
 */
import { fmtTime, trackLabel } from '../core/player.js';

const $ = (id) => document.getElementById(id);

let CTX = {};
export function setupContextMenu(ctx) { CTX = ctx || {}; }
function runCommand(args) { return CTX.runCommand ? CTX.runCommand(args) : null; }
// player/osd 全转发代理(方法自动 bind,属性直读)
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { burst: (...a) => CTX.osd && CTX.osd.burst(...a), message: (...a) => CTX.osd && CTX.osd.message(...a) };

let ctxMenuOpen = false;
export function isCtxMenuOpen() { return ctxMenuOpen; }

/** 是否处于音乐（纯音频）模式：音乐模式下仅暴露音频相关功能 */
const isAudio = () => document.body.classList.contains('audio-mode');

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];
const SCALER_LABELS = {
  bilinear: '双线性（最快）', bicubic: '双三次', spline36: 'Spline36', ewa_lanczos: 'EWA Lanczos（最佳）',
};
const TONEMAP_LABELS = {
  bt2390: 'BT.2390（标准）', hable: 'Hable（电影感）', mobius: 'Mobius（保色）', reinhard: 'Reinhard', clip: '直接裁剪',
};
function loopLabel(m) { return ({ off: '关闭', list: '列表循环', file: '单曲循环', random: '随机' })[m] || ''; }

export function openContextMenu(x, y) {
  closeContextMenu();
  const menu = $('context-menu');
  menu.innerHTML = '';
  buildContextMenuContent(menu);
  menu.classList.remove('hidden');
  ctxMenuOpen = true;

  // 先显示再测量，才能拿到真实尺寸做边界钳制
  const r = menu.getBoundingClientRect();
  let px = x, py = y;

  // 默认在光标右下；右/下空间不够时翻到光标左侧/上方，更像原生右键菜单
  if (px + r.width > window.innerWidth - 4) {
    px = x - r.width;
    if (px < 4) px = 4;
  }
  if (py + r.height > window.innerHeight - 4) {
    py = y - r.height;
    if (py < 4) py = 4;
  }
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';

  window.addEventListener('mousedown', onCtxOutside, true);
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('scroll', onCtxScroll, true);
  window.addEventListener('resize', closeContextMenu);
}

function onCtxOutside(e) {
  const menu = $('context-menu');
  // 子菜单挂在 body 上，不属于 #context-menu；点在子菜单内不关主菜单
  if (!menu.contains(e.target) && !(e.target.closest && e.target.closest('.ctx-submenu'))) closeContextMenu();
}
function onCtxScroll(e) {
  const menu = $('context-menu');
  if (menu.contains(e.target)) return; // 菜单自身滚动不关
  if (e.target.closest && e.target.closest('.ctx-submenu')) return; // 子菜单滚动不关
  closeContextMenu();
}

export function closeContextMenu() {
  const menu = $('context-menu');
  if (menu) menu.classList.add('hidden');
  // 子菜单挂在 body 上，必须一起清掉，否则主菜单隐藏后它们还会浮着
  document.body.querySelectorAll('.ctx-submenu').forEach((el) => el.remove());
  ctxMenuOpen = false;
  window.removeEventListener('mousedown', onCtxOutside, true);
  window.removeEventListener('blur', closeContextMenu);
  window.removeEventListener('scroll', onCtxScroll, true);
  window.removeEventListener('resize', closeContextMenu);
}

/** 右键菜单：按使用频率与语义分层，减少单屏长度 */
function buildContextMenuContent(menu) {
  const p = player;
  const hasMedia = !!(p && p.info);

  // —— 播放控制（最常用） ——
  menu.appendChild(ctxItem({
    label: '播放/暂停',
    meta: hasMedia ? (p.props.pause ? '已暂停' : '播放中') : '',
    disabled: !hasMedia,
    onClick: () => p.setProperty('pause', !p.props.pause),
  }));
  menu.appendChild(ctxItem({ label: '全屏', meta: 'F', onClick: () => runCommand(['cycle', 'fullscreen']) }));
  // —— 以下为视频专属功能，音乐模式下隐藏 ——
  if (!isAudio()) {
    menu.appendChild(ctxItem({ label: '画中画', meta: 'T', onClick: () => { if (window.lumen && window.lumen.togglePip) window.lumen.togglePip(); } }));
    menu.appendChild(ctxItem({
      label: '截图', submenu: [
        ctxItem({ label: '截取视频帧', onClick: () => CTX.takeScreenshot && CTX.takeScreenshot('video') }),
        ctxItem({ label: '截取视频帧（含字幕）', onClick: () => CTX.takeScreenshot && CTX.takeScreenshot('subtitles') }),
        ctxItem({ label: '连拍截图', onClick: () => CTX.takeScreenshotSequence && CTX.takeScreenshotSequence() }),
      ],
    }));
  }
  menu.appendChild(ctxDivider());

  // —— 播放设置 ——
  menu.appendChild(ctxItem({
    label: '播放速度',
    meta: hasMedia ? `${(p.props.speed || 1).toFixed(2)}×` : '',
    disabled: !hasMedia,
    submenu: SPEEDS.map((s) => ctxItem({
      label: `${s}×`, meta: s === 1 ? '正常' : '',
      selected: hasMedia && Math.abs((p.props.speed || 1) - s) < 1e-6,
      disabled: !hasMedia,
      onClick: () => { p.setProperty('speed', s); osd.message('速度', `${s.toFixed(2)}×`, { key: 'speed' }); },
    })),
  }));
  menu.appendChild(ctxItem({
    label: '循环模式',
    meta: hasMedia ? loopLabel(CTX.getLoopMode ? CTX.getLoopMode() : 'off') : '',
    disabled: !hasMedia,
    submenu: [['off', '关闭循环'], ['list', '列表循环'], ['file', '单曲循环'], ['random', '随机播放']]
      .map(([m, l]) => ctxItem({ label: l, selected: hasMedia && CTX.getLoopMode() === m, disabled: !hasMedia, onClick: () => CTX.setLoopMode && CTX.setLoopMode(m) })),
  }));
  menu.appendChild(ctxDivider());

  // —— 媒体轨道 / 画面 / 弹幕 ——
  // 音乐模式下：媒体轨道仅保留音轨+字幕；画面设置与弹幕为视频专属，隐藏
  menu.appendChild(ctxItem({ label: '媒体轨道', submenu: buildTracksSubmenu() }));
  if (!isAudio()) {
    menu.appendChild(ctxItem({ label: '画面设置', disabled: !hasMedia, submenu: buildPictureSubmenu() }));
    menu.appendChild(ctxItem({ label: '弹幕', disabled: !hasMedia, onClick: () => { if (window.toggleDanmaku) window.toggleDanmaku(true); } }));
  }
  menu.appendChild(ctxDivider());

  // —— 面板与导航 ——
  menu.appendChild(ctxItem({ label: '播放列表', meta: 'F8', onClick: () => CTX.togglePlaylistPanel && CTX.togglePlaylistPanel() }));
  menu.appendChild(ctxItem({ label: '返回主界面', disabled: !hasMedia, onClick: () => CTX.returnHome && CTX.returnHome() }));
  menu.appendChild(ctxDivider());

  // —— 打开 / 来源 ——
  menu.appendChild(ctxItem({ label: '打开文件…', meta: 'O', onClick: () => CTX.openDialog && CTX.openDialog() }));
  menu.appendChild(ctxItem({ label: '打开网络串流…', meta: 'Ctrl+U', onClick: () => runCommand(['open-network-stream']) }));
  menu.appendChild(ctxItem({ label: '投屏到设备…', onClick: () => { if (window.toggleCast) window.toggleCast(); } }));
  menu.appendChild(ctxDivider());

  // —— 系统 ——
  menu.appendChild(ctxItem({ label: '设置', meta: 'F2', onClick: () => CTX.toggleSettings && CTX.toggleSettings() }));
  menu.appendChild(ctxItem({ label: '键位速查', onClick: () => CTX.toggleKeymap && CTX.toggleKeymap() }));
}

/** 视频 / 音频 / 字幕轨道 + 字幕延迟 + 重载字幕（镜像 OSC 的轨道弹层） */
function buildTracksSubmenu() {
  const frag = document.createDocumentFragment();
  const info = player && player.info;
  if (!info) { frag.appendChild(ctxSection('未载入媒体')); return frag; }

  // 音乐模式无视频，跳过视频轨选择（即使文件带视频轨也不暴露）
  if (!isAudio() && info.video && info.video.length) {
    frag.appendChild(ctxSection('视频轨'));
    info.video.forEach((t, i) => frag.appendChild(ctxItem({
      label: trackLabel(t), meta: `${t.width}×${t.height} ${Math.round(t.fps)}fps`,
      selected: player.props.vid === i, onClick: () => player.setProperty('vid', i),
    })));
  }
  if (info.audio && info.audio.length) {
    frag.appendChild(ctxSection('音轨'));
    info.audio.forEach((t, i) => frag.appendChild(ctxItem({
      label: trackLabel(t), meta: `${t.codec} ${t.channels}ch`,
      selected: player.props.aid === i, onClick: () => player.setProperty('aid', i),
    })));
  }
  frag.appendChild(ctxSection('字幕'));
  frag.appendChild(ctxItem({ label: '关闭字幕', selected: player.props.sid === -1, onClick: () => player.setProperty('sid', -1) }));
  if (info.subtitle && info.subtitle.length) {
    info.subtitle.forEach((t, i) => frag.appendChild(ctxItem({
      label: trackLabel(t), meta: t.graphic ? '图形' : t.codec,
      selected: player.props.sid === i, onClick: () => player.setProperty('sid', i),
    })));
  } else {
    frag.appendChild(ctxItem({ label: '此文件没有字幕轨', disabled: true }));
  }

  frag.appendChild(ctxSection('第二字幕轨'));
  frag.appendChild(ctxItem({ label: '关闭第二字幕', selected: player.props.sid2 === -1, onClick: () => player.setProperty('sid2', -1) }));
  if (info.subtitle && info.subtitle.length) {
    info.subtitle.forEach((t, i) => frag.appendChild(ctxItem({
      label: trackLabel(t), meta: t.graphic ? '图形' : t.codec,
      selected: player.props.sid2 === i, onClick: () => player.setProperty('sid2', i),
    })));
  } else {
    frag.appendChild(ctxItem({ label: '此文件没有字幕轨', disabled: true }));
  }

  frag.appendChild(ctxSection('同步'));
  const curDelayMs = player.props['sub-delay'] || 0;
  frag.appendChild(ctxSlider({
    label: '字幕延迟', min: -10, max: 10, step: 0.1, value: curDelayMs / 1000,
    format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}s`,
    onInput: (v) => player.setProperty('sub-delay', v * 1000),
  }));
  frag.appendChild(ctxSection('操作'));
  frag.appendChild(ctxItem({ label: '重新载入字幕文件', onClick: () => player.command(['sub-add']) }));
  return frag;
}

/** 缩放 / 色调映射 / 去色带 / 硬解 / 画面 EQ（镜像 OSC 的渲染设置弹层） */
function buildPictureSubmenu() {
  const frag = document.createDocumentFragment();
  const p = player;

  frag.appendChild(ctxSection('缩放算法'));
  for (const [k, label] of Object.entries(SCALER_LABELS)) {
    frag.appendChild(ctxItem({ label, selected: p.props.scaler === k, onClick: () => p.setProperty('scaler', k) }));
  }
  frag.appendChild(ctxDivider());
  frag.appendChild(ctxSection('色调映射 (HDR)'));
  for (const [k, label] of Object.entries(TONEMAP_LABELS)) {
    frag.appendChild(ctxItem({ label, selected: p.props['tone-mapping'] === k, onClick: () => p.setProperty('tone-mapping', k) }));
  }
  frag.appendChild(ctxDivider());
  frag.appendChild(ctxSection('开关'));
  frag.appendChild(ctxItem({ label: '去色带 (Deband)', meta: p.props.deband ? '开' : '关', selected: !!p.props.deband, onClick: () => p.setProperty('deband', !p.props.deband) }));
  frag.appendChild(ctxItem({ label: '硬件解码', meta: p.props.hwdec === 'no' ? '关' : (p.props.hwdec || 'auto'), selected: p.props.hwdec !== 'no', onClick: () => p.setProperty('hwdec', p.props.hwdec === 'no' ? 'auto' : 'no') }));
  frag.appendChild(ctxDivider());
  frag.appendChild(ctxSection('画面调整'));
  for (const [key, label] of [['brightness', '亮度'], ['contrast', '对比度'], ['saturation', '饱和度'], ['gamma', '伽马']]) {
    frag.appendChild(ctxSlider({ label, min: -100, max: 100, step: 1, value: p.props[key] || 0, onInput: (v) => p.setProperty(key, v) }));
  }
  frag.appendChild(ctxItem({ label: '重置画面参数', onClick: () => p.command(['reset-video-eq']) }));
  frag.appendChild(ctxDivider());
  frag.appendChild(ctxItem({ label: '打开配置目录', meta: 'player.conf', onClick: () => { if (window.lumen && window.lumen.openConfigDir) window.lumen.openConfigDir(); } }));
  return frag;
}

/* ---------- 菜单元素工厂 ---------- */

function ctxSection(title) {
  const el = document.createElement('div');
  el.className = 'pop-section-title';
  el.textContent = title;
  return el;
}

function ctxDivider() {
  const el = document.createElement('div');
  el.className = 'pop-divider';
  return el;
}

function ctxItem({ label, meta, selected, disabled, submenu, onClick }) {
  const el = document.createElement('div');
  el.className = 'pop-item'
    + (submenu ? ' ctx-has-sub' : '')
    + (selected ? ' selected' : '')
    + (disabled ? ' disabled' : '');

  const check = document.createElement('span');
  check.className = 'pop-check';
  check.textContent = '✓';
  el.appendChild(check);

  const lab = document.createElement('span');
  lab.className = 'pop-label';
  lab.textContent = label;
  el.appendChild(lab);

  if (meta) {
    const m = document.createElement('span');
    m.className = 'pop-meta';
    m.textContent = meta;
    el.appendChild(m);
  }

  if (submenu && !disabled) {
    const caret = document.createElement('span');
    caret.className = 'ctx-caret';
    caret.innerHTML = "<svg viewBox='0 0 12 12'><path d='M4.5 2.5 L8 6 L4.5 9.5' fill='none' stroke='currentColor' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/></svg>";
    el.appendChild(caret);

    // 子菜单延迟创建并挂到 body，避免被主菜单 overflow 裁剪或挤出水平滚动条
    let fly = null;
    let hideTimer = null;
    const scheduleHide = () => { hideTimer = setTimeout(() => { if (fly) fly.classList.add('hidden'); }, 250); };
    const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };

    el.addEventListener('pointerenter', () => {
      cancelHide();
      if (!fly) {
        fly = document.createElement('div');
        fly.className = 'ctx-submenu hidden';
        if (submenu instanceof DocumentFragment) fly.appendChild(submenu);
        else if (Array.isArray(submenu)) submenu.forEach((n) => fly.appendChild(n));
        document.body.appendChild(fly);
        fly.addEventListener('pointerenter', cancelHide);
        fly.addEventListener('pointerleave', scheduleHide);
        fly.addEventListener('wheel', (e) => e.stopPropagation());
      }
      // 隐藏其他已打开的子菜单
      document.body.querySelectorAll('.ctx-submenu').forEach((s) => { if (s !== fly) s.classList.add('hidden'); });
      showSubmenu(el, fly);
    });
    el.addEventListener('pointerleave', scheduleHide);
  }

  if (onClick && !disabled) {
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); closeContextMenu(); });
  }
  return el;
}

function ctxSlider({ label, value, min, max, step = 1, format, onInput }) {
  const row = document.createElement('div');
  row.className = 'pop-slider-row';
  const head = document.createElement('div');
  head.className = 'pop-slider-head';
  const name = document.createElement('span');
  name.textContent = label;
  const val = document.createElement('b');
  val.textContent = format ? format(value) : value;
  head.appendChild(name);
  head.appendChild(val);
  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'pop-slider';
  input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = format ? format(v) : input.value;
    onInput(v);
  });
  row.appendChild(head);
  row.appendChild(input);
  return row;
}

/** 子菜单浮层：fixed 定位，挂到 body，避免被主菜单 overflow 裁剪 */
function showSubmenu(itemEl, fly) {
  fly.classList.remove('hidden');

  const itemRect = itemEl.getBoundingClientRect();
  const flyRect = fly.getBoundingClientRect();

  // 子菜单要紧贴父菜单面板，不能压着主菜单内容。用父面板的 border-box
  // 右边缘而不是菜单项的右边缘定位，否则子菜单会压到父菜单的边框/内边距上。
  // 左右空间不足时折叠到另一侧（同样用父面板左边缘做基准）。
  const parent = itemEl.closest('#context-menu') || itemEl.closest('.ctx-submenu');
  const parentRect = parent ? parent.getBoundingClientRect() : itemRect;

  let left = parentRect.right;
  if (left + flyRect.width > window.innerWidth - 4) {
    left = parentRect.left - flyRect.width;
  }
  if (left < 4) left = 4;

  // 默认与父项顶部对齐；底部不够时向上收缩并动态限制 max-height
  let top = itemRect.top - 6;
  const bottomMargin = 4;
  const availH = window.innerHeight - top - bottomMargin;

  if (flyRect.height > availH) {
    // 内容超出可用高度：限制 max-height 让滚动条生效，同时确保不超出视口
    fly.style.maxHeight = `${Math.max(availH, 120)}px`;
    // 重新测量约束后的尺寸
    const cappedRect = fly.getBoundingClientRect();
    if (top + cappedRect.height > window.innerHeight - bottomMargin) {
      top = window.innerHeight - cappedRect.height - bottomMargin;
    }
  }
  if (top < 4) {
    top = 4;
    // 即使 top=4 也放不下就再收紧 max-height
    const finalAvail = window.innerHeight - top - bottomMargin;
    fly.style.maxHeight = `${Math.max(finalAvail, 120)}px`;
  }

  fly.style.left = left + 'px';
  fly.style.top = top + 'px';
}

/** 执行一次命中的绑定，并补上键盘专属的视觉反馈 */
export function execute(hit) {
  if (hit.script) {
    try { hit.script.handler(); } catch (err) { console.error('[script]', err); }
    return;
  }
  const bind = hit.bind;
  const args = [bind.command, ...(bind.args || [])];

  // 跳转给一个方向感提示，纯数字 OSD 看不出快进还是后退
  if (bind.command === 'seek' && player.info) {
    const n = Number(bind.args[0]);
    const mode = bind.args[1] || 'relative';
    if (mode === 'relative' || mode === 'exact') {
      osd.burst(n > 0 ? 'forward' : 'backward');
      osd.message(n > 0 ? '快进' : '后退', `${Math.abs(n)} 秒`, { key: 'seek' });
    }
  }

  runCommand(args);

  if (bind.command === 'frame-step' || bind.command === 'frame-back-step') {
    osd.message('逐帧', fmtTime(player.props['time-pos']) , { key: 'frame' });
  }
}
