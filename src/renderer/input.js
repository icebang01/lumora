/**
 * 输入绑定（自包含模块）。
 * 从 app.js 拆出（2026-08）：bindInput / bindDragDrop / bindAudioUnlock /
 * bindClickToFront + 输入辅助函数（isEditable / isUiTarget / isNonRepeatable）。
 * 用法：setupInput(ctx)；（boot 时注入；player/osc/keymap/keybinds 用 Proxy 全转发）
 *
 * 注意：execute 由 context-menu.js 导出（右键菜单与输入共用同一条命令执行路径），
 * 拆出时发现此前漏了 export —— 本次一并修复。
 */
import { keyCandidates, wheelCandidates, mouseCandidates } from './ui/keys.js';
import { fmtTime } from './core/player.js';
import { isCtxMenuOpen, closeContextMenu, openContextMenu, execute } from './panels/context-menu.js';
import { isSetSelectOpen, closeSetSelect, toggleSettings, isSettingsVisible } from './panels/settings.js';
import { toggleLicenses, isLicensesVisible } from './panels/licenses.js';
import { toggleSubSearch, isSubSearchVisible } from './panels/subtitles.js';
import { toggleDanmaku, isDanmakuVisible } from './panels/danmaku.js';

let CTX = {};
export function setupInput(ctx) { CTX = ctx || {}; }

// player 全转发代理（方法自动 bind，属性直读，赋值直写 —— bindInput 里 resize 会写 needsRedraw）
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
  set(_, k, v) {
    const p = CTX.player;
    if (p) p[k] = v;
    return true;
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a), burst: (...a) => CTX.osd && CTX.osd.burst(...a) };
const osc = new Proxy({}, {
  get(_, k) {
    const o = CTX.osc;
    if (!o) return undefined;
    return typeof o[k] === 'function' ? o[k].bind(o) : o[k];
  },
});
const keymap = new Proxy({}, {
  get(_, k) {
    const m = CTX.keymap;
    if (!m) return undefined;
    return typeof m[k] === 'function' ? m[k].bind(m) : m[k];
  },
});
const keybinds = new Proxy({}, {
  get(_, k) {
    const b = CTX.keybinds;
    if (!b) return undefined;
    return typeof b[k] === 'function' ? b[k].bind(b) : b[k];
  },
});
function runCommand(args) { return CTX.runCommand ? CTX.runCommand(args) : null; }
function openDialog() { return CTX.openDialog ? CTX.openDialog() : null; }
function toggleKeymap(force) { if (CTX.toggleKeymap) CTX.toggleKeymap(force); }
function setPlaylist(paths, index) { if (CTX.setPlaylist) CTX.setPlaylist(paths, index); }
function load(filePath, opts) { return CTX.load ? CTX.load(filePath, opts) : null; }
function getPlaylist() { return CTX.getPlaylist ? CTX.getPlaylist() : []; }
function getPlaylistIndex() { return CTX.getPlaylistIndex ? CTX.getPlaylistIndex() : -1; }
function appendToPlaylist(path) { if (CTX.appendToPlaylist) CTX.appendToPlaylist(path); }

/**
 * 浏览器自动播放策略：AudioContext 只有在用户手势（点击/按键）调用栈内
 * resume() 才会真正从 suspended 变为 running。否则它会永久挂起，
 * AudioWorklet 的 process() 根本不会被调用 —— 表现为"视频有画面、没声音"。
 *
 * 这条坑只有 ffmpeg 引擎踩得到：mpv 引擎走系统音频输出，不经过 WebAudio。
 * 这里在首个手势里主动 resume，确保上下文在 playback 之前就已 running；
 * `AudioOutput.play()` 里还有一次兜底 resume。
 */
export function bindAudioUnlock() {
  const unlock = () => {
    try {
      if (player && player.audio && typeof player.audio.resumeContext === 'function') {
        player.audio.resumeContext(true);
        if (window.__lumenDebug) {
          const a = player.audio;
          window.__lumenDebug.log('手势解锁 audio: ctx=' + (a.ctx ? a.ctx.state : '未创建') + ' ready=' + a.ready);
        }
      }
    } catch { /* 忽略：尚未初始化或非 ffmpeg 引擎 */ }
  };
  for (const ev of ['pointerdown', 'keydown', 'click', 'touchstart']) {
    window.addEventListener(ev, unlock, { passive: true });
  }
}

/**
 * 透明分层窗口点击激活修复。
 * Electron 透明窗口（WS_EX_LAYERED）被其他窗口遮挡时，点击第一下往往
 * 只激活窗口而不置顶（Windows 已知行为），用户感觉"点了一下没反应"。
 * 失焦状态下收到 mousedown 时，显式请求主进程把窗口 moveTop + focus。
 * 窗口已聚焦时（正常点击）不打扰——不重复置顶。
 */
export function bindClickToFront() {
  window.addEventListener('mousedown', () => {
    if (document.hasFocus()) return;
    try {
      if (window.lumen && window.lumen.windowCommand) {
        window.lumen.windowCommand('focus');
      }
    } catch { /* 主进程未就绪时忽略 */ }
  });
}

export function bindInput() {
  /* ---------- 键盘 ---------- */
  window.addEventListener('keydown', (e) => {
    if (isEditable(e.target)) return;
    // 右键菜单打开时，Esc 先关菜单
    if (isCtxMenuOpen() && e.key === 'Escape') { closeContextMenu(); e.preventDefault(); return; }
    if (isSetSelectOpen() && e.key === 'Escape') { closeSetSelect(); e.preventDefault(); return; }
    if (e.repeat && isNonRepeatable(e)) return;

    // F1 / Ctrl+, 打开开源声明（合规要求，不占用播放键位）
    if (e.key === 'F1' || (e.key === ',' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      toggleLicenses();
      return;
    }
    // F2 打开设置窗口
    if (e.key === 'F2') {
      e.preventDefault();
      toggleSettings();
      return;
    }

    // Ctrl+U 打开网络串流：idle 与播放态都应可用，故放在 idle 拦截之前，
    // 否则退回落地页后按键会被下方的 idle 分支整段屏蔽（与打开文件键同理）。
    if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) {
      e.preventDefault();
      runCommand(['open-network-stream']);
      return;
    }

    // Esc 优先关闭浮层，其次才是退出全屏
    if (e.key === 'Escape') {
      if (osc.openPopover) { osc.closePopover(); e.preventDefault(); return; }
      if (keymap.visible) { toggleKeymap(false); e.preventDefault(); return; }
      if (isSettingsVisible()) { toggleSettings(false); e.preventDefault(); return; }
      if (isLicensesVisible()) { toggleLicenses(false); e.preventDefault(); return; }
      if (isSubSearchVisible()) { toggleSubSearch(false); e.preventDefault(); return; }
      if (isDanmakuVisible()) { toggleDanmaku(false); e.preventDefault(); return; }
    }

    // 空闲状态下所有"确认类"按键都用来打开文件，降低上手门槛
    // （idle 时 player.info 可能仍在，必须用 idle-mode 显式判断，否则会落到播放键位）
    if ((!player.info || document.body.classList.contains('idle-mode'))
        && ['o', 'O', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openDialog();
      return;
    }

    // idle 模式：? 切换页脚快捷键提示的显隐（默认隐藏，按需展开）；
    // 播放态下的 ? 仍走下方 keybinds 打开完整「键位速查」面板，互不影响
    if (document.body.classList.contains('idle-mode') && e.key === '?') {
      e.preventDefault();
      const idle = document.getElementById('idle-screen');
      if (idle) idle.classList.toggle('show-hints');
      return;
    }

    // idle 模式：除上方已处理的打开文件键外，屏蔽一切播放控制键
    // （空格/暂停键等），避免退回落地页后仍触发中央暂停图标等播放器状态泄露
    if (document.body.classList.contains('idle-mode')) return;

    const hit = keybinds.lookup(keyCandidates(e));
    if (!hit) return;
    e.preventDefault();
    execute(hit);
  });

  /* ---------- 滚轮 ---------- */
  window.addEventListener('wheel', (e) => {
    if (e.target.closest('#osc, .popover, #context-menu, .ctx-submenu, .set-select-fly, #stats-panel, #keymap-panel, #settings-panel, #licenses-panel, #subsearch-panel, #danmaku-panel, #playlist-panel, #cast-panel, .cast-backdrop, .cast-window, .cast-body, .cast-scroller, .cast-controls-inner, .settings-window, .licenses-window, .subsearch-window, .danmaku-window, .playlist-window, #side-rail, #ai-panel, #network-stream-dialog, .ns-backdrop, .ns-window, .ns-body, .ns-foot')) return;
    // idle 模式：不响应滚轮音量/进度，避免落地页泄露播放器反馈
    if (document.body.classList.contains('idle-mode')) return;
    const hit = keybinds.lookup(wheelCandidates(e));
    if (!hit) return;
    e.preventDefault();
    execute(hit);
  }, { passive: false });

  /* ---------- 鼠标 ---------- */
  let clickTimer = null;

  // 设置自定义下拉：点击浮层外 / 滚动 / 窗口尺寸变化 时关闭
  window.addEventListener('mousedown', (e) => {
    if (isSetSelectOpen() && !e.target.closest('.set-select, .set-select-fly')) closeSetSelect();
  });
  window.addEventListener('scroll', (e) => {
    // 滚动的是浮层自身（或其内部）时不关；仅滚动页面其它区域才关
    if (isSetSelectOpen() && !(e.target.closest && e.target.closest('.set-select, .set-select-fly'))) closeSetSelect();
  }, true);
  window.addEventListener('resize', () => { if (isSetSelectOpen()) closeSetSelect(); });

  window.addEventListener('mousedown', (e) => {
    if (isUiTarget(e.target)) return;
    // idle 模式下单击不触发任何播放控制（含 MBTN_LEFT=cycle pause）。
    // returnHome 后 player.info 仍保留，若只按 !player.info 判断，单击落地页
    // 仍会 dispatch cycle pause → 中央蹦出暂停/播放图标，故必须显式拦截 idle。
    if (document.body.classList.contains('idle-mode')) return;
    // idle 状态下单击不打开文件——只响应双击，避免误触
    if (!player.info) return;
    // 音乐模式：单击/双击屏幕不触发任何播放器命令（进度条/控制按钮仍可用）
    if (document.body.classList.contains('audio-mode')) return;

    const hit = keybinds.lookup(mouseCandidates(e));
    if (!hit) return;

    if (e.button === 0) {
      // 左键延后执行，等一等双击 —— 否则双击全屏会顺带暂停两次
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => execute(hit), 210);
    } else {
      execute(hit);
    }
  });

  window.addEventListener('dblclick', (e) => {
    if (isUiTarget(e.target)) return;
    clearTimeout(clickTimer);
    // idle 状态下双击 = 打开文件（即便刚播过、player.info 仍在，也不要触发全屏）
    if (document.body.classList.contains('idle-mode') || !player.info) { openDialog(); return; }
    // 音乐模式：双击屏幕不触发全屏/命令（控制按钮仍可用）
    if (document.body.classList.contains('audio-mode')) return;
    const hit = keybinds.lookup(mouseCandidates(e, true));
    if (hit) execute(hit);
    else runCommand(['cycle', 'fullscreen']);
  });

  window.addEventListener('contextmenu', (e) => {
    // 模态面板 / 可编辑区域里保留原生行为（主页、音乐播放器同样适用）
    if (e.target.closest('#settings-panel, #licenses-panel, #keymap-panel, #stats-panel, #playlist-panel, #cast-panel, .cast-backdrop, .cast-window, .cast-body, .cast-scroller, .cast-controls-inner, #speed-menu, #video-track-menu, #audio-track-menu, #settings-menu, #subtitle-menu, #danmaku-panel, .danmaku-window, #subsearch-panel, .subsearch-window, #set-select-fly, .ctx-submenu, .settings-window, .licenses-window, #side-rail, #ai-panel, #network-stream-dialog, .ns-backdrop, .ns-window, .ns-body, .ns-foot, input, textarea, select')) return;
    // idle 主页 / 音乐播放器 不显示任何自定义右键菜单
    if (document.body.classList.contains('idle-mode') || document.body.classList.contains('audio-mode')) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY);
  });

  /* ---------- 拖拽手势（鼠标手势） ----------
   * 仅在画面区按住左键拖动：
   *   - 横向  → 快进/后退（预览 OSC 进度 + 浮层，松手才精确提交，避免解码管线重启卡顿）
   *   - 纵向（左半屏）→ 音量；纵向（右半屏）→ 亮度（实时调节，即时反馈）
   * 12px 阈值区分"点击"与"拖拽"：越过阈值即取消待执行的"点击暂停"，与暂停互不打架。
   * 仅左键发起，右键保留给上下文菜单，避免手势/菜单冲突。
   */
  let dragGesture = null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  const gestureOverlayEl = () => {
    let el = document.getElementById('gesture-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gesture-overlay';
      el.className = 'gesture-overlay hidden';
      el.innerHTML =
        '<div class="gesture-glyph"></div>' +
        '<div class="gesture-text"></div>' +
        '<div class="gesture-bar"><div class="gesture-bar-fill"></div></div>';
      document.body.appendChild(el);
    }
    return el;
  };

  // 预览 seek：直接改 OSC 进度条与当前时间，不真正 seek（提交在松手时）
  const paintSeekPreview = (t, dur) => {
    const pct = dur > 0 ? clamp(t / dur, 0, 1) : 0;
    const prog = document.getElementById('seek-progress');
    const handle = document.getElementById('seek-handle');
    const cur = document.getElementById('time-current');
    if (prog) prog.style.width = `${pct * 100}%`;
    if (handle) handle.style.left = `${pct * 100}%`;
    if (cur) cur.textContent = fmtTime(t, dur >= 3600);
  };

  const showGestureOverlay = (mode, glyph) => {
    const el = gestureOverlayEl();
    const g = el.querySelector('.gesture-glyph');
    if (g) g.textContent = glyph || '';
    el.classList.remove('hidden');
    void el.offsetWidth; // 强制 reflow，让淡入过渡生效
    el.classList.add('visible');
    document.body.classList.add('gesture-active'); // 拖拽期间禁选区、防蓝条
    if (osc && typeof osc.show === 'function') osc.show();
    if (mode === 'seek' && osc) osc.dragging = true; // 抑制 OSC 在拖拽期间重绘进度
  };

  const updateGestureOverlay = (text, ratio) => {
    const el = gestureOverlayEl();
    const t = el.querySelector('.gesture-text');
    if (t) t.textContent = text;
    const fill = el.querySelector('.gesture-bar-fill');
    if (fill) fill.style.width = `${clamp(ratio, 0, 1) * 100}%`;
  };

  const hideGestureOverlay = () => {
    const el = document.getElementById('gesture-overlay');
    if (el) { el.classList.remove('visible'); el.classList.add('hidden'); }
    document.body.classList.remove('gesture-active');
    if (dragGesture && dragGesture.mode === 'seek' && osc) osc.dragging = false;
  };

  const gestureEnabled = () => {
    try {
      const cfg = CTX.getConfig && CTX.getConfig();
      return !cfg || cfg['mouse-gesture'] !== false;
    } catch { return true; }
  };

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !gestureEnabled()) return;
    if (isUiTarget(e.target)) return;
    if (document.body.classList.contains('idle-mode')) return;
    if (!player.info) return;
    // 音乐模式：不启动任何拖拽手势（音量/亮度/快进全禁），进度条/控制按钮仍可用
    if (document.body.classList.contains('audio-mode')) return;
    dragGesture = {
      pending: true,
      startX: e.clientX, startY: e.clientY,
      mode: null,
      startTime: player.props['time-pos'] || 0,
      startVolume: typeof player.props.volume === 'number' ? player.props.volume : 100,
      startBrightness: typeof player.props.brightness === 'number' ? player.props.brightness : 0,
      target: 0,
    };
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragGesture) return;
    const dx = e.clientX - dragGesture.startX;
    const dy = e.clientY - dragGesture.startY;
    if (dragGesture.pending) {
      if (Math.hypot(dx, dy) < 12) return; // 未越过阈值：仍可能是一次点击
      dragGesture.pending = false;
      clearTimeout(clickTimer);           // 取消待执行的"点击暂停"
      if (Math.abs(dx) >= Math.abs(dy)) {
        dragGesture.mode = 'seek';
        showGestureOverlay('seek', '↔');
      } else if (dragGesture.startX < window.innerWidth / 2) {
        dragGesture.mode = 'volume';
        showGestureOverlay('volume', '');
      } else {
        dragGesture.mode = 'brightness';
        showGestureOverlay('brightness', '');
      }
    }

    const dur = player.props.duration || 0;
    if (dragGesture.mode === 'seek') {
      const target = clamp(dragGesture.startTime + (dx / window.innerWidth) * dur, 0, dur || dragGesture.startTime);
      dragGesture.target = target;
      paintSeekPreview(target, dur);
      updateGestureOverlay(`${fmtTime(target, dur >= 3600)} / ${fmtTime(dur, dur >= 3600)}`, dur > 0 ? target / dur : 0);
    } else if (dragGesture.mode === 'volume') {
      const v = clamp(dragGesture.startVolume + ((dragGesture.startY - e.clientY) / window.innerHeight) * 150, 0, 150);
      try { player.setProperty('volume', Math.round(v)); } catch (_) {}
      updateGestureOverlay(`音量 ${Math.round(v)}`, v / 150);
    } else if (dragGesture.mode === 'brightness') {
      const b = clamp(dragGesture.startBrightness + ((dragGesture.startY - e.clientY) / window.innerHeight) * 200, -100, 100);
      try { player.setProperty('brightness', Math.round(b)); } catch (_) {}
      updateGestureOverlay(b >= 0 ? `亮度 +${Math.round(b)}` : `亮度 ${Math.round(b)}`, (b + 100) / 200);
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragGesture) return;
    if (!dragGesture.pending && dragGesture.mode === 'seek') {
      try { player.seek(clamp(dragGesture.target, 0, player.props.duration || dragGesture.target)); } catch (_) {}
    }
    hideGestureOverlay();
    dragGesture = null;
  });

  window.addEventListener('blur', () => {
    if (dragGesture) { hideGestureOverlay(); dragGesture = null; }
  });

  /* ---------- 窗口 ---------- */
  window.addEventListener('resize', () => { player.needsRedraw = true; });

  window.addEventListener('beforeunload', () => {
    window.lumen.reportTime(player.props['time-pos']);
  });
}

// 外部拖放状态（拖放遮罩 + 深度计数）提升到模块作用域，供播放列表面板
// 「拖入为稍后播放」在 stopPropagation 拦截 drop 后复位，避免窗口级 drop 处理未执行导致状态残留。
let _dragDepth = 0;
let _dragOverlayEl = null;

/** 复位外部拖放状态：隐藏「拖放即播放」遮罩、清除 body 拖放类、depth 归零。
 *  播放列表面板用捕获阶段拦截外部文件 drop 并 stopPropagation 后调用，确保与窗口级 drop 处理行为一致。 */
export function endExternalDrag() {
  _dragDepth = 0;
  if (_dragOverlayEl) _dragOverlayEl.classList.add('hidden');
  document.body.classList.remove('drag-over', 'external-dragging');
}

export function bindDragDrop() {
  _dragOverlayEl = document.getElementById('drag-overlay');
  const showOverlay = () => { if (_dragOverlayEl) _dragOverlayEl.classList.remove('hidden'); };
  const hideOverlay = () => { if (_dragOverlayEl) _dragOverlayEl.classList.add('hidden'); };

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    _dragDepth++;
    document.body.classList.add('drag-over', 'external-dragging');
    // 拖到播放列表面板时不显示「拖放即播放」遮罩（该面板会用自身「稍后播放」提示替代）
    const overPlaylist = !!(e.target && e.target.closest && e.target.closest('#playlist-panel'));
    if (_dragDepth === 1 && !overPlaylist) showOverlay();
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // 悬停在播放列表面板上方时隐藏全局「拖放即播放」遮罩，避免与「稍后播放」提示冲突
    const overPlaylist = !!(e.target && e.target.closest && e.target.closest('#playlist-panel'));
    if (overPlaylist) hideOverlay();
    else showOverlay();
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--_dragDepth <= 0) {
      _dragDepth = 0;
      document.body.classList.remove('drag-over', 'external-dragging');
      hideOverlay();
    }
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    _dragDepth = 0;
    document.body.classList.remove('drag-over', 'external-dragging');
    hideOverlay();

    // 拖放本身也是用户意图明确的交互，必须在这里尝试解锁 AudioContext。
    // 若不解锁，首曲拖入后 context 处于 suspended，worklet 不消费 → 有画面/时间码在走但无声音。
    try {
      if (player && player.audio && typeof player.audio.resumeContext === 'function') {
        player.audio.resumeContext(false);
      }
    } catch { /* 尚未初始化或非 ffmpeg 引擎 */ }

    // 1) 收集原始路径（文件 + 文件夹）。拖文件夹时 Chromium 常把文件夹放进
    //    dataTransfer.files（type=''），路径由 webUtils.getPathForFile 拿；
    //    部分平台 files 为空，兜底走 items→getAsFile。
    let rawPaths;
    try {
      rawPaths = collectDroppedPaths(e.dataTransfer);
    } catch (err) {
      console.error('[lumen][drop] 解析拖放内容失败:', err && err.stack || err);
      osd.message('拖放解析失败', '', { duration: 2200, force: true });
      return;
    }
    if (!rawPaths.length) {
      osd.message('未识别到可播放的文件', '请拖入音视频文件或文件夹', { duration: 2400, force: true });
      // 诊断线索：若拖文件恒为空，多半是透明窗口在 Windows 上没收到 OLE 拖放
      console.warn('[lumen][drop] dataTransfer 中无可解析路径（files/items 均为空）');
      return;
    }

    const primary = rawPaths[0];

    try {
      // 2) 已存在播放列表且只拖了单个文件：在列表里就跳转，否则追加并播放
      const existing = getPlaylist();
      if (existing.length > 0 && rawPaths.length === 1) {
        const idx = existing.findIndex((p) => samePath(p, primary));
        if (idx >= 0) {
          setPlaylist(existing, idx);
          load(existing[idx]);
        } else {
          appendToPlaylist(primary);
          load(primary);
          osd.message('已追加到播放列表', String(primary).split(/[\\/]/).pop(), { duration: 2000, force: true });
        }
        return;
      }

      // 3) 多文件 / 文件夹 / 空列表 → 主进程统一递归展开文件夹并按自然序排
      const res = await window.lumen.collectMedia(rawPaths);
      const paths = (res && res.ok && Array.isArray(res.paths) && res.paths.length)
        ? res.paths
        : rawPaths;
      if (!paths.length) {
        osd.message('文件夹中没有支持的媒体', '', { duration: 2400, force: true });
        return;
      }
      paths.sort(naturalCompare);
      const startIndex = Math.max(0, paths.findIndex((p) => samePath(p, primary)));
      setPlaylist(paths, startIndex);
      if (paths.length > 1) {
        osd.message('已建立播放列表', `${paths.length} 个文件`, { duration: 3000, force: true });
      }
      load(paths[startIndex]);
    } catch (err) {
      console.error('[lumen][drop] 处理拖放失败:', err && err.stack || err);
      osd.message('拖放播放失败', String((err && err.message) || err), { duration: 2600, force: true });
    }
  });
}

/**
 * 从 DataTransfer 收集原始磁盘路径（文件 + 文件夹）。
 *  - 优先 dataTransfer.files（Windows 拖文件夹时此处往往含文件夹 File）
 *  - 兜底走 dataTransfer.items → getAsFile（部分平台 files 为空时）
 * 任一来源解析出的真实路径都收集，交由主进程 collectMediaFromSelection 递归展开文件夹。
 * @param {DataTransfer} dt
 * @returns {string[]}
 */
export function collectDroppedPaths(dt) {
  const out = [];
  if (dt && dt.files && dt.files.length) {
    for (const f of dt.files) {
      const p = window.lumen.pathForFile(f);
      if (p) out.push(p);
    }
  }
  if (!out.length && dt && dt.items && dt.items.length) {
    for (const it of dt.items) {
      if (!it || it.kind !== 'file') continue;
      try {
        const f = it.getAsFile();
        if (!f) continue;
        const p = window.lumen.pathForFile(f);
        if (p) out.push(p);
      } catch { /* 忽略单个解析失败 */ }
    }
  }
  return out;
}

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** 点在界面元素上时不该触发"点画面暂停/打开文件" */
function isUiTarget(el) {
  return !!(el && el.closest &&
    el.closest('#osc, #titlebar, .popover, .ctx-submenu, .set-select-fly, #stats-panel, #keymap-panel, #settings-panel, #licenses-panel, #subsearch-panel, #danmaku-panel, #playlist-panel, #cast-panel, .cast-backdrop, .cast-window, .cast-body, .cast-scroller, .cast-controls-inner, .settings-window, .licenses-window, .subsearch-window, .danmaku-window, .playlist-window, #ai-panel, #network-stream-dialog, .ns-backdrop, .ns-window, .ns-body, .ns-foot, button, input, select, textarea'));
}

/** 长按会连发的键：暂停、全屏这类切换类命令要挡掉重复 */
function isNonRepeatable(e) {
  return [' ', 'Enter', 'f', 'F'].includes(e.key);
}

export function naturalCompare(a, b) {
  return String(a).split(/[\\/]/).pop().localeCompare(String(b).split(/[\\/]/).pop(), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/** 判断两条路径是否指向同一文件（忽略 Windows 大小写与正反斜杠差异） */
function samePath(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return String(a).toLowerCase().replace(/\\/g, '/') === String(b).toLowerCase().replace(/\\/g, '/');
}
