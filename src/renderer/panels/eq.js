/**
 * 音频均衡器(EQ)面板(自包含模块)。
 *
 * 10 段图示 EQ + 预设；状态由 core/eq.js 统一持久化与广播(跨引擎/跨模块同步)。
 * 变更实时应用到活跃引擎：
 *   - ffmpeg 路径(音乐模式)：经 AudioOutput.setEqualizer 改写 WebAudio BiquadFilter 链。
 *   - mpv 路径(视频模式)：经 af=equalizer 下发(最佳努力，未就绪时静默失败)。
 * 用法：setupEqPanel({ player });(boot 时注入，与 setupPlaylistPanel 同构)
 */
import {
  getEq, setEq, applyPreset, onEqChange,
  EQ_FREQS, EQ_MIN, EQ_MAX, EQ_PRESETS, eqToMpvString,
} from '../core/eq.js';
import { closePlaylistPanel } from './playlist.js';
import { toggleSettings } from './settings.js';

const $ = (id) => document.getElementById(id);

let CTX = {};
export function setupEqPanel(ctx) {
  CTX = ctx || {};
  _buildEqPanel();
  // 启动时把已保存的 EQ 状态应用到引擎(AudioContext 惰性创建，会在建链时落地)
  _applyEqToEngines(getEq());
  onEqChange((eq) => {
    _applyEqToEngines(eq);
    _refreshEqControls(eq);
  });
}

const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});

let _built = false;
let _eqDragState = null;      // 音乐模式 EQ 浮卡拖拽状态
let _eqDragBound = false;     // 拖拽事件只绑一次

function _presetLabel(name) {
  const map = {
    flat: '平直', bass: '重低音', treble: '高音增强', vocal: '人声',
    rock: '摇滚', pop: '流行', classical: '古典', electronic: '电子',
    acoustic: '原声', loudness: '响度', custom: '自定义',
  };
  return map[name] || name;
}

function _bandLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}

function _buildEqPanel() {
  if (_built) return;
  _built = true;

  // 预设下拉
  const presetSel = $('eq-preset');
  if (presetSel) {
    presetSel.innerHTML = Object.keys(EQ_PRESETS)
      .map((name) => `<option value="${name}">${_presetLabel(name)}</option>`)
      .join('');
    presetSel.addEventListener('change', () => {
      const eq = applyPreset(presetSel.value);
      _refreshEqControls(eq);
    });
  }

  // 10 段滑块(竖向)
  const sliders = $('eq-sliders');
  if (sliders) {
    sliders.innerHTML = EQ_FREQS.map((f, i) =>
      `<div class="eq-band">` +
        `<input type="range" class="eq-slider" data-band="${i}" min="${EQ_MIN}" max="${EQ_MAX}" step="1" value="0" ` +
        `aria-label="${_bandLabel(f)} 频段增益 (dB)">` +
        `<span class="eq-gain" data-gain="${i}">0</span>` +
        `<span class="eq-freq">${_bandLabel(f)}</span>` +
      `</div>`,
    ).join('');
    sliders.querySelectorAll('.eq-slider').forEach((s) => {
      s.addEventListener('input', () => {
        const bands = getEq().bands.slice();
        bands[Number(s.dataset.band)] = Number(s.value);
        const eq = setEq({ bands, preset: 'custom' });
        _refreshEqControls(eq);
      });
    });
  }

  // 启用开关
  const toggle = $('eq-enable');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const eq = setEq({ enabled: !getEq().enabled });
      _refreshEqControls(eq);
    });
  }

  // 平直重置
  const flat = $('eq-flat');
  if (flat) flat.addEventListener('click', () => { const eq = applyPreset('flat'); _refreshEqControls(eq); });

  // 关闭 / 背景点击关闭
  const close = $('eq-close');
  if (close) close.addEventListener('click', () => toggleEqPanel(false));
  const backdrop = document.querySelector('#eq-panel .eq-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => toggleEqPanel(false));

  _refreshEqControls(getEq());
}

/** 把控件同步到当前 EQ 状态(不触发应用，仅刷新 UI) */
function _refreshEqControls(eq) {
  const toggle = $('eq-enable');
  if (toggle) {
    toggle.classList.toggle('on', eq.enabled);
    toggle.setAttribute('aria-pressed', eq.enabled ? 'true' : 'false');
  }
  const presetSel = $('eq-preset');
  if (presetSel) presetSel.value = EQ_PRESETS[eq.preset] ? eq.preset : 'custom';
  const sliders = $('eq-sliders');
  if (sliders) {
    sliders.querySelectorAll('.eq-slider').forEach((s) => {
      const i = Number(s.dataset.band);
      const v = eq.bands[i] || 0;
      // 不抢占用户正在拖动的滑块
      if (document.activeElement !== s) s.value = String(v);
      const g = sliders.querySelector(`[data-gain="${i}"]`);
      if (g) g.textContent = (v > 0 ? '+' : '') + v;
    });
  }
  // 音乐控制条的 EQ 按钮同步高亮
  const mbtn = $('m-btn-eq');
  if (mbtn) {
    mbtn.classList.toggle('active', eq.enabled);
    mbtn.setAttribute('aria-pressed', eq.enabled ? 'true' : 'false');
    mbtn.title = eq.enabled ? '均衡器：已启用' : '均衡器';
  }
}

/** 把 EQ 状态应用到活跃引擎 */
function _applyEqToEngines(eq) {
  // ffmpeg 引擎：AudioOutput 的 WebAudio 滤波器链(音乐模式走这里)
  const audio = player && player.audio;
  if (audio && typeof audio.setEqualizer === 'function') {
    try { audio.setEqualizer(eq.bands, eq.enabled); } catch { /* 节点未就绪 */ }
  }
  // mpv 引擎：af=equalizer(视频模式；最佳努力，未就绪时静默失败)
  if (window.lumen && typeof window.lumen.mpvSetProperty === 'function') {
    const af = eqToMpvString(eq);
    try { window.lumen.mpvSetProperty('af', af, 'video'); } catch { /* mpv 未就绪 */ }
  }
}

/** 让音乐模式下的 EQ 浮卡可拖拽（仅 audio-mode，视频模式仍为右侧抽屉）。
 *  拖拽时把 fixed 定位从 right/top/transform 切换为 left/top，避免 transform 与拖拽冲突。 */
function _makeEqDraggable() {
  if (_eqDragBound) return;
  _eqDragBound = true;
  const head = document.querySelector('#eq-panel .eq-window .panel-head.draggable');
  const win = document.querySelector('#eq-panel .eq-window');
  if (!head || !win) return;

  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return; // 关闭按钮不触发拖拽
    if (!document.body.classList.contains('audio-mode')) return;
    const rect = win.getBoundingClientRect();
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    win.style.right = 'auto';
    win.style.transform = 'none';
    _eqDragState = {
      startX: e.clientX,
      startY: e.clientY,
      initLeft: rect.left,
      initTop: rect.top,
    };
    head.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!_eqDragState) return;
    const dx = e.clientX - _eqDragState.startX;
    const dy = e.clientY - _eqDragState.startY;
    let x = _eqDragState.initLeft + dx;
    let y = _eqDragState.initTop + dy;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = win.getBoundingClientRect();
    const minVisible = 48;
    x = Math.max(minVisible - rect.width, Math.min(x, vw - minVisible));
    y = Math.max(0, Math.min(y, vh - minVisible));
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!_eqDragState) return;
    _eqDragState = null;
    head.style.cursor = 'grab';
  });
}

export function toggleEqPanel(force) {
  const panel = $('eq-panel');
  if (!panel) return;
  const open = force === undefined ? panel.classList.contains('hidden') : force;
  if (open) {
    // 避免与右侧其他面板叠加
    closePlaylistPanel();
    try { toggleSettings(false); } catch { /* noop */ }
    _buildEqPanel();
    _makeEqDraggable();
    _refreshEqControls(getEq());
    // 音乐模式下每次打开都重置到默认右侧悬浮位置
    const win = document.querySelector('#eq-panel .eq-window');
    if (win && document.body.classList.contains('audio-mode')) {
      win.style.left = '';
      win.style.top = '';
      win.style.right = '';
      win.style.transform = '';
    }
    panel.classList.remove('hidden');
    document.body.classList.add('eq-open');
  } else {
    panel.classList.add('hidden');
    document.body.classList.remove('eq-open');
  }
}

export function closeEqPanel() {
  const panel = $('eq-panel');
  if (panel) panel.classList.add('hidden');
  document.body.classList.remove('eq-open');
}
