/**
 * OSC —— 浮出式控制条。
 *
 * 全部状态都来自 player 的属性订阅，UI 自己不持有任何"真相"。
 * 这条纪律保证了无论用户是点按钮、按快捷键还是从外部 IPC 下指令，
 * 界面表现完全一致。
 *
 * 交互上的两个讲究：
 *   1. 拖动进度条时先本地预览、松手才真正 seek —— 拖动过程中不断
 *      重启解码管线会卡成幻灯片。
 *   2. 鼠标静止后控制条与光标一起消失，播放时界面必须彻底让位给画面。
 */

import { clamp } from '../../shared/clamp.js';
import { fmtTime, trackLabel } from '../core/player.js';
import { keyCandidates } from './keys.js';

const $ = (id) => document.getElementById(id);

const SCALER_LABELS = {
  bilinear: '双线性（最快）',
  bicubic: '双三次',
  spline36: 'Spline36',
  ewa_lanczos: 'EWA Lanczos（最佳）',
};

const TONEMAP_LABELS = {
  bt2390: 'BT.2390（标准）',
  hable: 'Hable（电影感）',
  mobius: 'Mobius（保色）',
  reinhard: 'Reinhard',
  clip: '直接裁剪',
};

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];

export class Osc {
  constructor(player, osd, configValues = {}, keybinds = null) {
    this.player = player;
    this.osd = osd;
    this.configValues = configValues;
    this.keybinds = keybinds;

    this.el = {
      osc: $('osc'),
      oscInner: $('osc-inner'),
      zone: $('seekbar-zone'),
      bar: $('seekbar'),
      buffered: $('seek-buffered'),
      progress: $('seek-progress'),
      abRange: $('seek-ab-range'),
      handle: $('seek-handle'),
      tooltip: $('seek-tooltip'),
      tooltipTime: $('seek-tooltip-time'),
      seekPreview: $('seek-preview'),
      seekPreviewImg: $('seek-preview-img'),
      seekPreviewTime: $('seek-preview-time'),
      timeCur: $('time-current'),
      timeTotal: $('time-total'),
      timeRemain: $('time-remain'),
      iconPlay: $('icon-play'),
      iconPause: $('icon-pause'),
      iconVol: $('icon-vol'),
      iconMute: $('icon-mute'),
      iconFs: $('icon-fs'),
      iconFsExit: $('icon-fs-exit'),
      volTrack: $('volume-track'),
      volFill: $('volume-fill'),
      volGroup: document.querySelector('.ctl-volume'),
      btnSpeed: $('btn-speed'),
      btnVideoTrack: $('btn-video-track'),
      btnAudioTrack: $('btn-audio-track'),
      btnSettings: $('btn-settings'),
      btnSubtitle: $('btn-subtitle'),
      btnDanmaku: $('btn-danmaku'),
      btnScreenshot: $('btn-screenshot'),
      btnScreenshotSeq: $('btn-screenshot-seq'),
      btnPip: $('btn-pip'),
      titlebarText: $('titlebar-text'),
      videoTrackMenu: $('video-track-menu'),
      audioTrackMenu: $('audio-track-menu'),
      settingsMenu: $('settings-menu'),
      speedMenu: $('speed-menu'),
      subtitleMenu: $('subtitle-menu'),
      abStatus: $('ab-status'),
    };

    this.dragging = false;
    this.draggingVolume = false;
    this.pointerInside = false;
    this.openPopover = null;
    this._hideTimer = null;
    this._cursorTimer = null;
    this._lastBufferPaint = 0;
    // 进度条悬停预览：精灵图 + 按文件缓存；_sheetToken 用于丢弃过期请求
    this._sheet = null;
    this._sheetCache = new Map();
    this._sheetToken = 0;
    this._sheetReqPending = false; // 请求在途标记，避免 pointermove 反复打飞 token
    this._PREVIEW_W = 200; // 预览框展示宽度（px），与 style.css 中 #seek-preview-img 一致
    this._hoveringSeekbar = false; // 当前是否在进度条上 hover
    this._lastHoverRatio = null;   // 最后 hover 的进度比例
    this._lastHoverClientX = null; // 最后 hover 的屏幕 X
    // 无 userHidden 锁定态：任何输入（含移动鼠标）都会唤起 UI，
    // 仅在空闲超过 osc-timeout 后控制条与光标一起隐去。

    this._bindPlayer();
    this._bindSeekbar();
    this._bindVolume();
    this._bindButtons();
    this._bindVisibility();
  }

  /* ================= 属性订阅 ================= */

  _bindPlayer() {
    const p = this.player;

    p.observeProperty('pause', (v) => {
      // 严格 === true：首次打开时 pause 还是 undefined，若按 truthy 判断
      // 会让暂停图标闪现（用户反馈"第一次打开出现播放暂停图标"）
      const paused = v === true;
      this.el.iconPlay.classList.toggle('hidden', !paused);
      this.el.iconPause.classList.toggle('hidden', paused);
      // 音乐舞台据此驱动唱片旋转 / 频谱跳动（暂停冻结）
      document.dispatchEvent(new CustomEvent('lumen:playstate', { detail: { paused } }));
      // 暂停时控制条常驻，免得用户为了看进度还得晃鼠标
      if (paused) this.show(); else this.scheduleHide();
    });

    p.observeProperty('time-pos', () => {
      if (!this.dragging) this._paintTime();
    });
    p.observeProperty('duration', () => { this._paintTime(); this._requestSeekSheet(); });

    p.observeProperty('volume', () => this._paintVolume());
    p.observeProperty('mute', (v) => {
      this.el.iconVol.classList.toggle('hidden', v);
      this.el.iconMute.classList.toggle('hidden', !v);
      this._paintVolume();
    });

    p.observeProperty('speed', (v) => {
      this.el.btnSpeed.textContent = `${Number(v).toFixed(2)}×`;
      this.el.btnSpeed.classList.toggle('active', Math.abs(v - 1) > 1e-6);
    });

    p.observeProperty('fullscreen', (v) => {
      this.el.iconFs.classList.toggle('hidden', v);
      this.el.iconFsExit.classList.toggle('hidden', !v);
      document.body.classList.toggle('is-fullscreen', !!v);
    });

    p.observeProperty('media-title', (v) => {
      this.el.titlebarText.textContent = v || '';
    });

    // 字幕轨道状态：sub-visibility / sid
    p.observeProperty('sub-visibility', (v) => {
      this.el.btnSubtitle.classList.toggle('active', !!v);
    });
    p.observeProperty('sid', (v) => {
      this.el.btnSubtitle.classList.toggle('active', !!v || !!this.player.props['sub-visibility']);
    });

    p.addEventListener('ab-loop-change', () => this._paintAbLoop());
    p.addEventListener('loaded', () => {
      this._paintAbLoop();
      this._requestSeekSheet();
      this.show();
    });
    p.addEventListener('show-progress', () => {
      this.show();
      this.scheduleHide(3200);
    });
  }

  /* ================= 进度条 ================= */

  _bindSeekbar() {
    const zone = this.el.zone;

    const ratioAt = (clientX) => {
      const r = this.el.bar.getBoundingClientRect();
      return clamp((clientX - r.left) / Math.max(r.width, 1), 0, 1);
    };

    zone.addEventListener('pointerenter', () => { this._hoveringSeekbar = true; });
    zone.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.player.info) return;
      this.dragging = true;
      this._hoveringSeekbar = true;
      zone.setPointerCapture(e.pointerId);
      zone.classList.add('dragging');
      this._previewAt(ratioAt(e.clientX));
      this._paintSeekPreview(ratioAt(e.clientX), e.clientX);
      e.preventDefault();
    });

    zone.addEventListener('pointermove', (e) => {
      if (!this.player.info) return;
      this._hoveringSeekbar = true;
      const r = ratioAt(e.clientX);
      this._lastHoverRatio = r;
      this._lastHoverClientX = e.clientX;
      this._paintTooltip(r, e.clientX);
      if (this.dragging) this._previewAt(r);
      this._paintSeekPreview(r, e.clientX);
    });

    zone.addEventListener('pointerleave', () => {
      this._hoveringSeekbar = false;
      this._lastHoverRatio = null;
      this._lastHoverClientX = null;
      this._hideSeekPreview();
    });

    const finish = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      zone.classList.remove('dragging');
      try { zone.releasePointerCapture(e.pointerId); } catch { /* 指针已释放 */ }
      const r = ratioAt(e.clientX);
      this.player.command(['seek', r * 100, 'absolute-percent']);
    };
    zone.addEventListener('pointerup', finish);
    zone.addEventListener('pointercancel', () => { this.dragging = false; zone.classList.remove('dragging'); });

    // 进度条上滚轮 = 细粒度跳转，比用鼠标精确点位置舒服得多
    zone.addEventListener('wheel', (e) => {
      if (!this.player.info) return;
      e.preventDefault();
      e.stopPropagation();
      this.player.command(['seek', e.deltaY < 0 ? 5 : -5]);
    }, { passive: false });

    // 双击进度条空白处 = 直接 seek 到该位置
    zone.addEventListener('dblclick', (e) => {
      if (!this.player.info) return;
      if (e.target.closest('.user-chapter-tick, .bookmark-tick')) return;
      const d = this.player.props.duration;
      if (!d) return;
      this.player.command(['seek', ratioAt(e.clientX) * d, 'absolute']);
    });
  }

  _previewAt(ratio) {
    const d = this.player.props.duration;
    const t = d * ratio;
    this.el.progress.style.width = `${ratio * 100}%`;
    this.el.handle.style.left = `${ratio * 100}%`;
    this.el.timeCur.textContent = fmtTime(t, d >= 3600);
  }

  _paintTooltip(ratio, clientX) {
    const d = this.player.props.duration;
    if (!d) return;
    const t = d * ratio;
    this.el.tooltipTime.textContent = fmtTime(t, d >= 3600);

    const zoneRect = this.el.zone.getBoundingClientRect();
    const x = clamp(clientX - zoneRect.left, 46, zoneRect.width - 46);
    this.el.tooltip.style.left = `${x}px`;
  }

  /* ============ 进度条悬停预览（精灵图） ============ */

  /**
   * 载入新文件后，后台请求该文件的预览精灵图（带按文件缓存）。
   * 纯音频 / 无视频流 → 主进程返回 ok:false，预览直接不显示。
   */
  _requestSeekSheet() {
    if (this._sheetReqPending) return; // 已在请求中，避免重复打飞 token / 互相取消
    const info = this.player.info;
    const path = info && info.path;
    const duration = this.player.props.duration;
    if (!path || !duration) {
      console.warn('[seek-preview] skip: missing path/duration', { path: !!path, duration });
      this._sheet = null;
      return;
    }

    const cached = this._sheetCache.get(path);
    if (cached) { this._sheet = cached; return; }
    this._sheet = null;
    this._sheetReqPending = true;

    const token = ++this._sheetToken;
    const count = clamp(Math.round(duration / 45), 12, 60);
    if (window.lumen && window.lumen.getSeekSheet) {
      window.lumen.getSeekSheet({ path, duration, count }).then((r) => {
        this._sheetReqPending = false;
        if (token !== this._sheetToken) return; // 已切到别的文件，丢弃
        if (r && r.ok && r.dataUrl) {
          this._sheetCache.set(path, r);
          this._sheet = r;
          console.log('[seek-preview] ready', r.cols + 'x' + r.rows, 'count=' + r.count, 'cached=' + !!r.cached);
          // 请求完成时如果鼠标还在进度条上，立即重绘，不需要用户再晃一下鼠标
          if (this._hoveringSeekbar && this._lastHoverRatio != null) {
            this._paintSeekPreview(this._lastHoverRatio, this._lastHoverClientX);
          }
        } else {
          this._sheet = null;
          console.warn('[seek-preview] failed:', r && (r.error || (r.audio ? 'audio-only' : JSON.stringify(r))));
        }
      }).catch((e) => {
        this._sheetReqPending = false;
        if (token === this._sheetToken) { this._sheet = null; }
        console.warn('[seek-preview] IPC error:', e && e.message);
      });
    } else {
      this._sheetReqPending = false;
      console.warn('[seek-preview] window.lumen.getSeekSheet not available');
    }
  }

  /** 按光标 X 水平定位预览框（含左右边界约束），并做垂直夹紧，不负责显示内容 */
  _placeSeekPreview(clientX) {
    const el = this.el.seekPreview;
    const zoneRect = this.el.zone.getBoundingClientRect();
    /* 用实际渲染宽度的一半做边界约束（含 padding/border），
       避免预览框贴到进度条左右边缘时溢出窗口。 */
    const halfW = el.offsetWidth / 2 || this._PREVIEW_W / 2;
    const x = clamp(clientX - zoneRect.left, halfW, zoneRect.width - halfW);
    el.style.left = `${x}px`;

    /* 垂直夹紧：窗口极矮时预览框（bottom:54px 向上浮）可能顶出上沿，
       向下压回安全边距内；否则复位到 CSS 的 54px。 */
    const TOP_MARGIN = 8;
    const top = el.getBoundingClientRect().top;
    if (top < TOP_MARGIN) {
      el.style.bottom = `${54 + (TOP_MARGIN - top)}px`;
    } else if (el.style.bottom) {
      el.style.bottom = '';
    }
  }

  /**
   * 按 hover 比例定位精灵图中的某一格并显示。
   * 展示框宽度固定，按 cellW 缩放整张精灵图后用 background-position 裁切对应格。
   * 若精灵图仍在后台生成（_sheetReqPending），显示「生成中」占位，避免用户误判功能失效。
   */
  _paintSeekPreview(ratio, clientX) {
    const sheet = this._sheet;
    const el = this.el.seekPreview;
    if (!sheet) this._requestSeekSheet(); // 懒触发：loaded 若错过，hover 也能补上

    const d = this.player.props.duration;
    this.el.seekPreviewTime.textContent = fmtTime(d * ratio, d >= 3600);

    if (!sheet || !sheet.dataUrl) {
      // 后台正在生成精灵图：显示「生成中」骨架占位（位置随光标实时更新）
      if (this._sheetReqPending) {
        this._placeSeekPreview(clientX);
        el.classList.add('loading', 'show');
      } else {
        this._hideSeekPreview();
      }
      return;
    }
    el.classList.remove('loading');

    const { cols, rows, count, cellW, cellH, dataUrl } = sheet;
    const idx = clamp(Math.floor(ratio * count), 0, count - 1);
    const col = idx % cols;
    const row = Math.floor(idx / cols);

    const img = this.el.seekPreviewImg;
    const scale = this._PREVIEW_W / cellW;
    if (img.dataset.src !== dataUrl) {
      img.style.backgroundImage = `url("${dataUrl}")`;
      img.style.backgroundSize = `${cols * cellW * scale}px ${rows * cellH * scale}px`;
      img.dataset.src = dataUrl;
    }
    img.style.backgroundPosition = `${-col * cellW * scale}px ${-row * cellH * scale}px`;

    this._placeSeekPreview(clientX);
    el.classList.add('show');
  }

  _hideSeekPreview() {
    this.el.seekPreview.classList.remove('show', 'loading');
  }

  _paintTime() {
    const p = this.player;
    const d = p.props.duration;
    const t = p.props['time-pos'];
    const pct = d > 0 ? clamp(t / d, 0, 1) : 0;

    this.el.progress.style.width = `${pct * 100}%`;
    this.el.handle.style.left = `${pct * 100}%`;
    this.el.timeCur.textContent = fmtTime(t, d >= 3600);
    this.el.timeTotal.textContent = fmtTime(d, d >= 3600);
    this.el.timeRemain.textContent = d > 0 ? `−${fmtTime(d - t, d >= 3600)}` : '';

    // 缓冲量刷新得慢一点，这东西变化频繁但没人盯着看
    const now = performance.now();
    if (d > 0 && now - this._lastBufferPaint > 250) {
      this._lastBufferPaint = now;
      const ahead = p.queue.bufferedSeconds(p.frameDuration);
      const w = Math.min((t + ahead) / d, 1) * 100;
      this.el.buffered.style.width = `${w}%`;
    }
  }

  _paintAbLoop() {
    const { a, b } = this.player.abLoop;
    const d = this.player.props.duration;
    const el = this.el.abRange;
    const status = this.el.abStatus;
    if (a === null || !d) {
      el.style.display = 'none';
      if (status) status.classList.add('hidden');
      return;
    }
    const left = (a / d) * 100;
    const right = b === null ? left + 0.4 : (b / d) * 100;
    el.style.display = 'block';
    el.style.left = `${left}%`;
    el.style.width = `${Math.max(right - left, 0.4)}%`;

    // 右上角的 AB 状态浮窗：A → B / 仅 A
    if (status) {
      status.classList.remove('hidden');
      const aStr = fmtTime(a);
      const bStr = b === null ? '…' : fmtTime(b);
      status.innerHTML = `<span>AB</span><span style="opacity:.5">·</span><span>${aStr} → ${bStr}</span>`;
    }
  }

  /* ================= 音量 ================= */

  _bindVolume() {
    const track = this.el.volTrack;
    const ratioAt = (clientX) => {
      const r = track.getBoundingClientRect();
      return clamp((clientX - r.left) / Math.max(r.width, 1), 0, 1);
    };

    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.draggingVolume = true;
      this.el.volGroup.classList.add('dragging');
      track.setPointerCapture(e.pointerId);
      this.player.setProperty('volume', Math.round(ratioAt(e.clientX) * 100));
      e.preventDefault();
    });

    track.addEventListener('pointermove', (e) => {
      if (!this.draggingVolume) return;
      this.player.setProperty('volume', Math.round(ratioAt(e.clientX) * 100));
    });

    const end = (e) => {
      if (!this.draggingVolume) return;
      this.draggingVolume = false;
      this.el.volGroup.classList.remove('dragging');
      try { track.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }

  _paintVolume() {
    const v = this.player.props.mute ? 0 : Math.min(this.player.props.volume, 100);
    this.el.volFill.style.width = `${v}%`;
    $('volume-handle').style.left = `${v}%`;
  }

  /* ================= 按钮与弹层 ================= */

  _bindButtons() {
    // data-cmd 上写的就是 input.conf 的命令语法，一条路径到底
    for (const btn of document.querySelectorAll('[data-cmd]')) {
      btn.addEventListener('click', () => {
        this.player.command(btn.dataset.cmd.split(/\s+/));
      });
    }

    for (const btn of document.querySelectorAll('[data-window]')) {
      btn.addEventListener('click', () => window.lumen.windowCommand(btn.dataset.window));
    }

    this.el.btnSpeed.addEventListener('click', (e) => {
      this._togglePopover(this.el.speedMenu, e.currentTarget, () => this._buildSpeedMenu());
    });
    this.el.btnVideoTrack.addEventListener('click', (e) => {
      this._togglePopover(this.el.videoTrackMenu, e.currentTarget, () => this._buildVideoTrackMenu());
    });
    this.el.btnAudioTrack.addEventListener('click', (e) => {
      this._togglePopover(this.el.audioTrackMenu, e.currentTarget, () => this._buildAudioTrackMenu());
    });
    this.el.btnSettings.addEventListener('click', (e) => {
      this._togglePopover(this.el.settingsMenu, e.currentTarget, () => this._buildSettingsMenu());
    });
    this.el.btnSubtitle.addEventListener('click', (e) => {
      this._togglePopover(this.el.subtitleMenu, e.currentTarget, () => this._buildSubtitleMenu());
    });
    this.el.btnDanmaku.addEventListener('click', () => {
      if (window.toggleDanmaku) window.toggleDanmaku(true);
    });
    // 弹幕按钮激活态：与字幕按钮(.active 圆点)对称，反映 body.danmaku-open。
    // 点击 OSC 弹幕键走 toggleDanmaku(true) 强制开，键盘 d 走 toggle；
    // 用 body class 的 MutationObserver 统一反射，避免重复绑定。
    const syncDanmakuActive = () => {
      this.el.btnDanmaku.classList.toggle('active', document.body.classList.contains('danmaku-open'));
    };
    syncDanmakuActive();
    new MutationObserver(syncDanmakuActive).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // 注意：btn-screenshot 已通过上面的 [data-cmd] 循环绑定（data-cmd="screenshot"），
    // 这里不要再显式绑定，否则点击会触发两条 screenshot 命令（重复截图）
    if (this.el.btnScreenshot) {
      this.el.btnScreenshot.addEventListener('click', () => {
        if (window.takeScreenshot) window.takeScreenshot();
      });
    }
    if (this.el.btnScreenshotSeq) {
      this.el.btnScreenshotSeq.addEventListener('click', () => {
        if (window.takeScreenshotSequence) window.takeScreenshotSequence();
      });
    }
    this.el.btnPip.addEventListener('click', () => {
      // 画中画：把窗口缩成浮窗
      if (window.lumen.togglePip) window.lumen.togglePip();
    });

    document.addEventListener('pointerdown', (e) => {
      if (!this.openPopover) return;
      if (this.openPopover.contains(e.target)) return;
      if (e.target.closest('#btn-speed, #btn-video-track, #btn-audio-track, #btn-settings, #btn-subtitle')) return;
      this.closePopover();
    }, true);
  }

  _togglePopover(el, anchor, build) {
    if (this.openPopover === el) { this.closePopover(); return; }
    this.closePopover();
    el.innerHTML = '';
    build();
    el.classList.remove('hidden');
    this.openPopover = el;
    this._place(el, anchor);
    this.show();
  }

  closePopover() {
    if (!this.openPopover) return;
    this.openPopover.classList.add('hidden');
    this.openPopover = null;
    this.scheduleHide();
  }

  _place(el, anchor) {
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = a.left + a.width / 2 - r.width / 2;
    left = clamp(left, 10, window.innerWidth - r.width - 10);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(10, a.top - r.height - 10))}px`;
  }

  /* ---------- 弹层内容 ---------- */

  _buildSpeedMenu() {
    const el = this.el.speedMenu;
    el.appendChild(section('播放速度'));
    const cur = this.player.props.speed;
    for (const s of SPEEDS) {
      el.appendChild(item({
        label: `${s}×`,
        meta: s === 1 ? '正常' : '',
        selected: Math.abs(cur - s) < 1e-6,
        onClick: () => {
          this.player.setProperty('speed', s);
          this.osd.message('速度', `${s.toFixed(2)}×`, { key: 'speed' });
          this.closePopover();
        },
      }));
    }
  }

  _buildVideoTrackMenu() {
    const el = this.el.videoTrackMenu;
    const info = this.player.info;
    if (!info) { el.appendChild(section('未载入媒体')); return; }

    if (info.video.length) {
      el.appendChild(section('视频轨'));
      info.video.forEach((t, i) => el.appendChild(item({
        label: trackLabel(t),
        meta: `${t.width}×${t.height} ${Math.round(t.fps)}fps`,
        selected: this.player.props.vid === i,
        onClick: () => { this.player.setProperty('vid', i); this.closePopover(); },
      })));
    } else {
      el.appendChild(item({ label: '此文件没有视频轨', disabled: true }));
    }
    el.appendChild(divider());
    el.appendChild(item({
      label: '添加外置视频轨',
      meta: '载入外部视频文件',
      onClick: () => this._addExternalTrack('video'),
    }));
  }

  _buildAudioTrackMenu() {
    const el = this.el.audioTrackMenu;
    const info = this.player.info;
    if (!info) { el.appendChild(section('未载入媒体')); return; }

    if (info.audio.length) {
      el.appendChild(section('音轨'));
      info.audio.forEach((t, i) => el.appendChild(item({
        label: trackLabel(t),
        meta: `${t.codec} ${t.channels}ch`,
        selected: this.player.props.aid === i,
        onClick: () => { this.player.setProperty('aid', i); this.closePopover(); },
      })));
    } else {
      el.appendChild(item({ label: '此文件没有音轨', disabled: true }));
    }
    el.appendChild(divider());
    el.appendChild(item({
      label: '添加外置音轨',
      meta: '载入外部音频文件',
      onClick: () => this._addExternalTrack('audio'),
    }));
  }

  /**
   * 添加外置轨：弹文件选择框（按类型筛选）→ 用 mpv 的 video-add/audio-add/sub-add
   * 把外部文件作为额外轨载入并选中。外置轨不入播放列表、不影响当前文件。
   */
  async _addExternalTrack(kind) {
    this.closePopover();
    const cfg = {
      sub:   { title: '添加外置字幕', extensions: ['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'smi', 'ttxt', 'txt', 'lrc'] },
      audio: { title: '添加外置音轨', extensions: ['mp3', 'flac', 'aac', 'wav', 'ogg', 'opus', 'm4a', 'wma', 'ac3', 'dts', 'eac3', 'mka'] },
      video: { title: '添加外置视频轨', extensions: ['mkv', 'mp4', 'avi', 'webm', 'mov', 'ts', 'm2ts', 'flv', 'wmv', 'ogv', 'm4v'] },
    }[kind];
    const res = await window.lumen.openDialog({
      title: cfg.title,
      filters: [{ name: cfg.title, extensions: cfg.extensions }, { name: '全部文件', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (!res || !res.ok || !res.paths || !res.paths.length) return;
    const path = res.paths[0];
    const cmd = { sub: 'sub-add', audio: 'audio-add', video: 'video-add' }[kind];
    try {
      this.player.command([cmd, path, 'select']);
      const name = path.split(/[\\/]/).pop();
      this.osd.message(cfg.title.replace('添加', '已添加'), name, { duration: 2200 });
    } catch (e) {
      this.osd.message('添加失败', (e && e.message) || '', { duration: 2500 });
    }
  }

  _buildSettingsMenu() {
    const el = this.el.settingsMenu;
    const p = this.player;

    el.appendChild(section('缩放算法'));
    for (const [k, label] of Object.entries(SCALER_LABELS)) {
      el.appendChild(item({
        label,
        selected: p.props.scaler === k,
        onClick: () => { p.setProperty('scaler', k); this._buildSettingsMenuRefresh(); },
      }));
    }

    el.appendChild(divider());
    el.appendChild(section('色调映射 (HDR)'));
    for (const [k, label] of Object.entries(TONEMAP_LABELS)) {
      el.appendChild(item({
        label,
        selected: p.props['tone-mapping'] === k,
        onClick: () => { p.setProperty('tone-mapping', k); this._buildSettingsMenuRefresh(); },
      }));
    }

    el.appendChild(divider());
    el.appendChild(section('开关'));
    el.appendChild(item({
      label: '去色带 (Deband)',
      meta: p.props.deband ? '开' : '关',
      selected: p.props.deband,
      onClick: () => { p.setProperty('deband', !p.props.deband); this._buildSettingsMenuRefresh(); },
    }));
    el.appendChild(item({
      label: '硬件解码',
      meta: p.props.hwdec === 'no' ? '关' : p.props.hwdec,
      selected: p.props.hwdec !== 'no',
      onClick: () => {
        p.setProperty('hwdec', p.props.hwdec === 'no' ? 'auto' : 'no');
        this._buildSettingsMenuRefresh();
      },
    }));

    el.appendChild(divider());
    el.appendChild(section('画面调整'));
    for (const [key, label] of [
      ['brightness', '亮度'], ['contrast', '对比度'],
      ['saturation', '饱和度'], ['gamma', '伽马'],
    ]) {
      el.appendChild(slider({
        label,
        value: p.props[key],
        min: -100, max: 100,
        onInput: (v) => p.setProperty(key, v),
      }));
    }
    el.appendChild(item({
      label: '重置画面参数',
      onClick: () => { p.command(['reset-video-eq']); this._buildSettingsMenuRefresh(); },
    }));

    el.appendChild(divider());
    el.appendChild(item({
      label: '打开配置目录',
      meta: 'player.conf',
      onClick: () => { window.lumen.openConfigDir(); this.closePopover(); },
    }));
  }

  /** 改完设置就地重建，让选中态跟上 */
  _buildSettingsMenuRefresh() {
    const el = this.el.settingsMenu;
    const scroll = el.scrollTop;
    el.innerHTML = '';
    this._buildSettingsMenu();
    el.scrollTop = scroll;
  }

  /* ================= 显隐 ================= */

  _bindVisibility() {
    // 红框（视频区）鼠标移动唤起 UI；蓝框（OSC 区域）鼠标移动不唤起 UI。
    // 但若 UI 已显示，在蓝框内移动要续隐藏计时，避免停在控制条上反而被隐藏。
    // 注意：idle 模式下完全不响应活动事件，避免误唤起 UI 或泄露播放器状态到落地页。
    const activity = (e) => {
      // idle 模式：忽略所有鼠标/滚轮活动，不让 OSC/标题栏闪现
      if (document.body.classList.contains('idle-mode')) return;

      if (e && e.type === 'mousemove') {
        const rect = this.el.osc.getBoundingClientRect();
        const inOsc = e.clientX >= rect.left && e.clientX < rect.right
                   && e.clientY >= rect.top && e.clientY < rect.bottom;
        if (inOsc) {
          if (document.body.classList.contains('ui-visible')) this.scheduleHide();
          return;
        }
      }
      this.show();
    };

    window.addEventListener('mousemove', activity);
    window.addEventListener('pointerdown', activity);
    window.addEventListener('wheel', activity, { passive: true });
    window.addEventListener('keydown', (e) => {
      // 隐藏 UI 时，只有真正绑定了播放命令的按键才把控制条唤出来；
      // 随机未绑定的按键不应把界面重新弹出（更贴近"沉浸式观影"的预期）
      if (!this.keybinds || !this.keybinds.lookup(keyCandidates(e))) return;
      activity(e);
    });

    this.el.osc.addEventListener('pointerenter', () => { this.pointerInside = true; this.show(); });
    this.el.osc.addEventListener('pointerleave', () => { this.pointerInside = false; this.scheduleHide(); });
    this.el.osc.addEventListener('pointermove', () => {
      if (document.body.classList.contains('ui-visible')) this.scheduleHide();
    });

    // 点击 OSC 胶囊两侧空白区域：仅收起 UI（不隐藏光标、不上锁），不暂停/不 seek
    this.el.osc.addEventListener('pointerdown', (e) => {
      if (this.el.oscInner.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      this.hideNow();
    });

    // 失去焦点（点桌面/切窗口）时不应唤起 UI；否则用户一点别处控制条就弹出来。
    // 重新获得焦点时再唤起，方便 Alt-Tab 回来后看到控制条。
    window.addEventListener('focus', () => this.show());
    this.show();
  }

  hideNow() {
    // 仅收起 UI；不隐藏光标、不上锁。鼠标一动即恢复，
    // 若继续静止则由 scheduleHide 按默认空闲延时隐藏光标。
    clearTimeout(this._hideTimer);
    clearTimeout(this._cursorTimer);
    document.body.classList.remove('ui-visible');
    this.scheduleHide();
  }

  show() {
    // idle 落地页（logo/续播卡片）上绝不显示播放器控制条：
    // 停止/返回主页时 pause 通知会触发 show()（osc 的 pause 观察者），
    // 没有这层保护控制条会盖在落地页上（用户反馈"返回主页出现播放暂停图标"）。
    if (document.body.classList.contains('idle-mode')) return;
    document.body.classList.add('ui-visible');
    document.body.classList.remove('cursor-hidden');
    this.scheduleHide();
  }

  scheduleHide(delay) {
    clearTimeout(this._hideTimer);
    clearTimeout(this._cursorTimer);

    const p = this.player;
    // idle 落地页不排隐藏定时器：idle 下鼠标移动被 activity 过滤（不会 show），
    // 若这里照常排 cursorTimer，2.8s 后 body 会被加上 cursor-hidden 且永远
    // 无人移除——主页光标消失但 hover 交互还在（用户反馈的现象）。
    const canHide = p.info && !p.props.pause && !this.dragging
      && !this.draggingVolume && !this.pointerInside && !this.openPopover
      && !document.body.classList.contains('idle-mode');
    if (!canHide) return;

    // 优先用设置面板/配置文件的 osc-timeout；未指定时保持原默认 2600ms
    const ms = delay !== undefined ? delay : (Number(this.configValues['osc-timeout']) || 2600);

    this._hideTimer = setTimeout(() => {
      document.body.classList.remove('ui-visible');
    }, ms);
    this._cursorTimer = setTimeout(() => {
      document.body.classList.add('cursor-hidden');
    }, ms + 200);
  }

  /* ---------- 字幕弹层（独立面板，按钮直接唤出） ---------- */

  _buildSubtitleMenu() {
    const el = this.el.subtitleMenu;
    const info = this.player.info;
    if (!info) { el.appendChild(section('未载入媒体')); return; }

    el.appendChild(section('字幕轨'));
    el.appendChild(item({
      label: '关闭字幕',
      selected: this.player.props.sid === -1,
      onClick: () => { this.player.setProperty('sid', -1); this.closePopover(); },
    }));
    if (info.subtitle.length) {
      info.subtitle.forEach((t, i) => el.appendChild(item({
        label: trackLabel(t),
        meta: t.graphic ? '图形' : t.codec,
        selected: this.player.props.sid === i,
        onClick: () => { this.player.setProperty('sid', i); this.closePopover(); },
      })));
    } else {
      el.appendChild(item({ label: '此文件没有字幕轨', disabled: true }));
    }
    el.appendChild(divider());
    el.appendChild(item({
      label: '添加外置字幕',
      meta: '载入外部字幕文件',
      onClick: () => this._addExternalTrack('sub'),
    }));

    // 第二字幕轨（双字幕）：与主字幕同构，可单独选一条轨作为副字幕
    el.appendChild(section('第二字幕轨'));
    el.appendChild(item({
      label: '关闭第二字幕',
      selected: this.player.props.sid2 === -1,
      onClick: () => { this.player.setProperty('sid2', -1); this.closePopover(); },
    }));
    if (info.subtitle.length) {
      info.subtitle.forEach((t, i) => el.appendChild(item({
        label: trackLabel(t),
        meta: t.graphic ? '图形' : t.codec,
        selected: this.player.props.sid2 === i,
        onClick: () => { this.player.setProperty('sid2', i); this.closePopover(); },
      })));
    } else {
      el.appendChild(item({ label: '此文件没有字幕轨', disabled: true }));
    }

    el.appendChild(section('同步'));
    const curDelayMs = this.player.props['sub-delay'] || 0;
    el.appendChild(slider({
      label: '字幕延迟',
      value: `${curDelayMs >= 0 ? '+' : ''}${(curDelayMs / 1000).toFixed(2)} s`,
      min: -10, max: 10, value: curDelayMs / 1000,
      onInput: (v) => this.player.setProperty('sub-delay', v * 1000),
    }));

    el.appendChild(section('操作'));
    el.appendChild(item({
      label: '搜索在线字幕',
      onClick: () => { this.closePopover(); window.toggleSubSearch(true); },
    }));
    // 注意：弹幕已移至独立工具栏按钮（btn-danmaku），不在此菜单内重复。
    el.appendChild(item({
      label: '自动匹配字幕',
      meta: '聚合',
      onClick: () => { this.closePopover(); window.toggleSubSearch(true); window.runSubAutoMatch(); },
    }));
    el.appendChild(item({
      label: '重新载入字幕文件',
      onClick: () => { this.player.command(['sub-add']); this.closePopover(); },
    }));
  }
}

/* ------------------------------------------------------------------ */
/* 弹层元素工厂                                                         */
/* ------------------------------------------------------------------ */

function section(title) {
  const el = document.createElement('div');
  el.className = 'pop-section-title';
  el.textContent = title;
  return el;
}

function divider() {
  const el = document.createElement('div');
  el.className = 'pop-divider';
  return el;
}

function item({ label, meta, selected, disabled, onClick }) {
  const el = document.createElement('div');
  el.className = 'pop-item' + (selected ? ' selected' : '');
  if (disabled) el.style.opacity = '.45';

  const check = document.createElement('span');
  check.className = 'pop-check';
  check.textContent = '✓';

  const text = document.createElement('span');
  text.className = 'pop-label';
  text.textContent = label;

  el.append(check, text);
  if (meta) {
    const m = document.createElement('span');
    m.className = 'pop-meta';
    m.textContent = meta;
    el.appendChild(m);
  }
  if (onClick && !disabled) el.addEventListener('click', onClick);
  return el;
}

function slider({ label, value, min, max, onInput }) {
  const row = document.createElement('div');
  row.className = 'pop-slider-row';

  const head = document.createElement('div');
  head.className = 'pop-slider-head';
  const name = document.createElement('span');
  name.textContent = label;
  const val = document.createElement('b');
  val.textContent = value;
  head.append(name, val);

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'pop-slider';
  input.min = min; input.max = max; input.value = value;
  input.addEventListener('input', () => {
    val.textContent = input.value;
    onInput(Number(input.value));
  });

  row.append(head, input);
  return row;
}

/* ---------- 工具函数 ---------- */
