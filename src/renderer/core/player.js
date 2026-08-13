/**
 * 播放器状态机。
 *
 * 采用属性(property)模型，和 mpv 的设计一致：所有状态都是可读写、
 * 可观察的具名属性，所有操作都是作用在属性上的命令。这样带来的
 * 好处是键位绑定、OSC、脚本、外部 IPC 全都走同一条路径 ——
 * 不需要为每个入口重复写一遍逻辑，也就不会出现"用快捷键调音量
 * 会更新 UI、用 IPC 调就不更新"这类经典 bug。
 */

import { AudioOutput } from './audio.js';
import { MasterClock } from './clock.js';
import { FrameQueue } from './framequeue.js';
import { Transport } from './transport.js';
import { Voice } from './wire.js';
import { VideoRenderer } from '../gl/renderer.js';
import { RENDER_DEFAULTS } from './defaults.js';
import { PlaybackEngine } from './engine.js';

export class Player extends PlaybackEngine {
  constructor(canvas, opts = {}) {
    // 基类 PlaybackEngine 负责：共享属性表(props)、observers、stats、
    // abLoop、info/videoTrackInfo/epoch/fps/frameDuration/needsRedraw/
    // voDisabled/voError/_lastReport，以及覆盖前用的兼容桩(buildStubs)。
    super();
    this.canvas = canvas;
    this.audioOnly = !!opts.audioOnly;  // 2026-08: 纯音频引擎(音乐)——不请求/不渲染视频帧

    // 真实后端对象覆盖基类里的兼容桩（buildStubs 里的 queue/renderer/
    // audio/transport/clock 都是空壳，这里换成能干活的实现）
    this.renderer = new VideoRenderer(canvas);
    this.audio = new AudioOutput();
    this.clock = new MasterClock(this.audio);
    this.queue = new FrameQueue(RENDER_DEFAULTS.defaultQueueSize);
    this.transport = new Transport();

    this.stepping = false;     // 逐帧模式：显示一帧后立即回到暂停
    this.seeking = false;
    this.showNextFrame = false; // 暂停态下待呈现的跳转目标帧
    this.eof = false;

    this.pendingSeekTarget = null;
    this._rafId = null;

    // —— 交叉淡入淡出（真·重叠）状态 ——
    // 副声部(SECONDARY/voice=1)解码下一曲目音频头，与主声部同时混音；
    // 到点做 equal-power 斜坡，结束后提升副声部为主声部。时钟始终由
    // activeVoice 驱动（提升前跟旧曲、提升后跟新曲），做到无缝切轨。
    this._secondaryEpoch = null;   // 副声部（下一曲）的 epoch，与主声部不同
    this._crossfadeInfo = null;    // 下一曲目的探测信息（sanitizeInfo 后）
    this._crossfadeDuration = 0;   // 斜坡时长（秒）
    this._crossfadePending = false;// 副声部已请求/生成，等待到点开始斜坡
    this._crossfadeRamping = false;// 斜坡进行中
    this._crossfadePromoteAt = null; // 斜坡结束（提升）的绝对 AudioContext 时间
    this._crossfadeReqId = 0;        // 交叉淡入淡出代际标记（作废在途副声部）

    // 字幕（ffmpeg 引擎）：主进程用 ffmpeg 把字幕轨 dump 成 SRT 解析后发来
    this.subtitleCues = [];      // [{ start, end, text }]（秒）—— 主字幕轨
    this.subtitleIndex = -1;     // 当前显示的字幕轨索引（-1 = 关闭）
    this.subtitleGraphic = false; // 是否为图形字幕（PGS/DVD，本管线不栅格化）
    this.subtitleExternal = false; // 当前字幕是否来自外部下载（在线字幕），区别于内嵌轨
    // 第二字幕轨（双字幕）：结构与主字幕对称
    this.subtitleCues2 = [];
    this.subtitleIndex2 = -1;
    this.subtitleExternal2 = false;
    this._lastSubtitleText = null;
    this._lastSubtitleText2 = null;
  }

  /* ================= 生命周期 ================= */

  async init(bootstrap) {
    this.bootstrap = bootstrap;

    // 拿不到 WebGL2 不该让整个播放器躺平。退化成"无视频输出"模式：
    // 音频照常播、进度与命令全部可用，只是不出画 —— 等价于 mpv 的 --vo=null。
    // 常见于远程桌面、虚拟机、显卡驱动异常的机器，直接白屏报错太粗暴了。
    try {
      this.renderer.init();
      this.voDisabled = false;
      this.voError = null;
    } catch (err) {
      this.voDisabled = true;
      this.voError = err.message;
      console.warn('[lumen] 视频输出不可用，降级为纯音频模式：', err.message);
    }


    const cfg = bootstrap.config.values;
    this.queue.maxSize = Math.max(4, cfg['frame-queue-size'] || RENDER_DEFAULTS.defaultQueueSize);

    // 流控水位（需求驱动背压的迟滞阈值）来自统一配置，不再硬编码
    this.flowHigh = Number(cfg['flow-high-seconds']) || 2.0;
    this.flowLow = Number(cfg['flow-low-seconds']) || 1.0;

    const audioBufferSeconds = Number(cfg['audio-buffer']) || 0;
    const audioInitFrames = audioBufferSeconds > 0
      ? Math.max(RENDER_DEFAULTS.audioBufferMinMultiplier, audioBufferSeconds * RENDER_DEFAULTS.audioFramesPerSecond)
      : RENDER_DEFAULTS.audioBufferZeroFallback;
    await this.audio.init(audioInitFrames);

    // 用配置初始化属性，一次性同步到渲染器
    this.setProperty('volume', cfg.volume, true);
    this.setProperty('mute', cfg.mute, true);
    this.setProperty('scaler', cfg.scaler, true);
    this.setProperty('deband', cfg.deband, true);
    this.setProperty('tone-mapping', cfg['tone-mapping'], true);
    this.setProperty('display-gamut', cfg['display-gamut'] ?? 'auto', true);
    this.setProperty('brightness', cfg.brightness, true);
    this.setProperty('contrast', cfg.contrast, true);
    this.setProperty('saturation', cfg.saturation, true);
    this.setProperty('gamma', cfg.gamma, true);
    this.setProperty('hwdec', cfg.hwdec, true);
    this.setProperty('loop-file', cfg['loop-file'], true);

    // 字幕外观默认值：ffmpeg 引擎由渲染端覆盖层读取这些 props 绘制字幕
    this.props['sub-font-size'] = cfg['sub-font-size'];
    this.props['sub-color'] = cfg['sub-color'];
    this.props['sub-bold'] = cfg['sub-bold'];
    this.props['sub-font-family'] = cfg['sub-font-family'];
    this.props['sub-outline-size'] = cfg['sub-outline-size'];
    this.props['sub-outline-color'] = cfg['sub-outline-color'];
    this.props['sub-shadow-size'] = cfg['sub-shadow-size'];
    this.props['sub-bg'] = cfg['sub-bg'];
    this.props['sub-bg-color'] = cfg['sub-bg-color'];
    this.props['sub-bg-opacity'] = cfg['sub-bg-opacity'];
    this.props['sub-pos'] = cfg['sub-pos'];
    this.props['sub-codepage'] = cfg['sub-codepage'];
    this.props['sub-delay'] = cfg['sub-delay'] || 0;
    this.props.sid2 = -1;

    this.renderer.setOption('targetPeak', cfg['target-peak'] || 203);
    this.renderer.setOption('dither', cfg.dither !== false);
    this.renderer.setOption('debandStrength', cfg['deband-strength'] || 0.35);

    // 连接媒体流
    this.transport.onVideo = (f) => this._onVideoFrame(f);
    this.transport.onAudio = (c) => this._onAudioChunk(c);
    this.transport.onEos = (e) => this._onEos(e);
    window.lumen.on('player:subtitles', (p) => this._onSubtitles(p));
    window.lumen.on('player:crossfade-started', (p) => this._onCrossfadeStarted(p));
    window.lumen.on('player:crossfade-ended', (p) => this._onCrossfadeEnded(p));
    await this.transport.connect(bootstrap.server.port, bootstrap.server.token);

    this._startLoop();
    return this;
  }

  /* ================= 属性系统 ================= */

  /**
   * 读属性。派生量（percent-pos / time-remaining / chapter / core-idle /
   * estimated-vf-fps / drop-frame-count 等）由基类 PlaybackEngine.getProperty
   * 统一计算，这里不再重复实现。
   */

  /**
   * 写属性。副作用统一在这里处理，外面任何入口都不需要关心
   * "改了这个值还要顺带做什么"。
   */
  setProperty(name, value, silent = false) {
    const old = this.props[name];

    switch (name) {
      case 'pause': {
        const v = !!value;
        this.props.pause = v;
        if (v) {
          this.clock.pause();
          this.audio.pause();
        } else {
          if (this.eof) {
            // 播完后按播放键 → 从头开始，符合直觉
            this.eof = false;
            this.props['eof-reached'] = false;
            this.command(['seek', 0, 'absolute']);
          }
          this.clock.play();
          this.audio.play();
        }
        break;
      }

      case 'volume': {
        const v = Math.max(0, Math.min(Number(value) || 0, 150));
        this.props.volume = v;
        this.audio.setVolume(v, this.props.mute);
        break;
      }

      case 'mute':
        this.props.mute = !!value;
        this.audio.setVolume(this.props.volume, this.props.mute);
        break;

      case 'speed': {
        const v = Math.max(0.05, Math.min(Number(value) || 1, 16));
        if (Math.abs(v - this.props.speed) < 1e-6) return;
        this.props.speed = v;
        this.audio.setSpeed(v);
        this.clock.setSpeed(v);
        // 变速要重启解码管线（音频得重新过 atempo）
        window.lumen.setSpeed(v, this.props['time-pos']).then((r) => {
          if (r && r.ok && r.epoch) this._applyEpoch(r.epoch, this.props['time-pos']);
        });
        break;
      }

      case 'fullscreen':
        this.props.fullscreen = !!value;
        if (!silent) window.lumen.windowCommand('fullscreen', !!value);
        break;

      case 'ontop':
        this.props.ontop = !!value;
        window.lumen.windowCommand('ontop', !!value);
        break;

      case 'scaler':
        this.props.scaler = value;
        this.renderer.setOption('scaler', value);
        this.needsRedraw = true;
        break;

      case 'deband':
        this.props.deband = !!value;
        this.renderer.setOption('deband', !!value);
        this.needsRedraw = true;
        break;

      case 'tone-mapping':
        this.props['tone-mapping'] = value;
        this.renderer.setOption('tonemap', value);
        this.needsRedraw = true;
        break;

      case 'display-gamut':
        this.props['display-gamut'] = value;
        this.renderer.setOption('displayGamut', value);
        this.needsRedraw = true;
        break;

      case 'target-peak': {
        const v = Math.max(1, Math.min(Number(value) || 203, 10000));
        this.props['target-peak'] = v;
        this.renderer.setOption('targetPeak', v);
        this.needsRedraw = true;
        break;
      }

      case 'brightness': case 'contrast': case 'saturation': case 'gamma': {
        const v = Math.max(-100, Math.min(Number(value) || 0, 100));
        this.props[name] = v;
        this.renderer.setOption(name, v);
        this.needsRedraw = true;
        break;
      }

      case 'video-rotate': {
        const v = ((Number(value) % 360) + 360) % 360;
        this.props['video-rotate'] = v;
        this.renderer.setOption('rotation', v);
        this.needsRedraw = true;
        break;
      }

      case 'video-zoom': {
        const v = Math.max(0.1, Math.min(Number(value) || 1, 10));
        this.props['video-zoom'] = v;
        this.renderer.setOption('zoom', v);
        this.needsRedraw = true;
        break;
      }

      case 'video-pan-x': case 'video-pan-y': {
        const v = Math.max(-2, Math.min(Number(value) || 0, 2));
        this.props[name] = v;
        this.renderer.setOption(name === 'video-pan-x' ? 'panX' : 'panY', v);
        this.needsRedraw = true;
        break;
      }

      case 'hwdec':
        this.props.hwdec = value;
        window.lumen.setHwdec(value, this.props['time-pos']).then((r) => {
          if (r && r.epoch) this._applyEpoch(r.epoch, this.props['time-pos']);
        });
        break;

      case 'sid': {
        const v = Number(value);
        this.props.sid = v;
        if (v < 0) {
          this.subtitleIndex = -1;
          this.subtitleExternal = false; // 关闭字幕时清掉外部下载字幕标记
          this._updateSubtitle();
        } else {
          this.setSubtitleTrack(v);
        }
        this._notify('sid', this.props.sid);
        break;
      }

      case 'sid2': {
        // 第二字幕轨（双字幕）
        const v = Number(value);
        this.props.sid2 = v;
        if (v < 0) {
          this.subtitleIndex2 = -1;
          this.subtitleExternal2 = false;
          this._updateSubtitle();
        } else {
          this.setSecondarySubtitleTrack(v);
        }
        this._notify('sid2', this.props.sid2);
        break;
      }

      case 'sub-visibility': {
        this.props['sub-visibility'] = !!value;
        this._updateSubtitle();
        this._notify('sub-visibility', this.props['sub-visibility']);
        break;
      }

      case 'sub-delay': {
        this.props['sub-delay'] = Number(value) || 0;
        this._updateSubtitle();
        this._notify('sub-delay', this.props['sub-delay']);
        break;
      }

      case 'aid':
        this.props.aid = Number(value);
        window.lumen.setTrack('audio', Number(value), this.props['time-pos']).then((r) => {
          if (r && r.ok) this._applyEpoch(r.epoch, this.props['time-pos']);
        });
        break;

      case 'vid':
        this.props.vid = Number(value);
        window.lumen.setTrack('video', Number(value), this.props['time-pos']).then((r) => {
          if (r && r.ok) {
            if (r.output) {
              this._configureVideo(r.output);
            } else {
              this.renderer.clear();
              this.videoTrackInfo = null;
            }
            this._applyEpoch(r.epoch, this.props['time-pos']);
          }
        });
        break;

      case 'window-scale':
        this.props['window-scale'] = Number(value);
        window.lumen.windowCommand('scale', Number(value));
        break;

      default:
        this.props[name] = value;
    }

    if (!silent && old !== this.props[name]) {
      this._notify(name, this.props[name]);
    }
  }

  /* ================= 命令分发 ================= */

  /**
   * 执行一条命令。参数形式与 mpv 完全一致，
   * 所以 input.conf 里的写法可以直接照搬。
   */
  command(args) {
    if (!Array.isArray(args) || !args.length) return null;
    const cmd = String(args[0]);
    const a = args.slice(1);

    switch (cmd) {
      case 'set':
        this.setProperty(a[0], this._coerce(a[0], a[1]));
        return true;

      case 'add': {
        // chapter 是派生属性，写不进去，得走跳转
        if (a[0] === 'chapter') {
          this.seekChapter(Number(a[1]) < 0 ? -1 : 1);
          return true;
        }
        const cur = Number(this.getProperty(a[0])) || 0;
        this.setProperty(a[0], cur + (Number(a[1]) || 1));
        return true;
      }

      case 'multiply': {
        const cur = Number(this.getProperty(a[0])) || 0;
        this.setProperty(a[0], cur * (Number(a[1]) || 1));
        return true;
      }

      case 'cycle': {
        const name = a[0];
        const cur = this.getProperty(name);
        if (typeof cur === 'boolean') {
          this.setProperty(name, !cur);
        } else if (name === 'audio' || name === 'video' || name === 'sub') {
          this._cycleTrack(name, a[1] === 'down' ? -1 : 1);
        } else if (name === 'hwdec') {
          this.setProperty('hwdec', this.props.hwdec === 'no' ? 'auto' : 'no');
        } else if (name === 'stats') {
          this.setProperty('stats', !this.props.stats);
        } else if (name === 'osd-level') {
          this.setProperty('osd-level', (Number(cur) + 1) % 4);
        } else if (name === 'deband') {
          this.setProperty('deband', !this.props.deband);
        }
        return true;
      }

      case 'cycle-values': {
        const name = a[0];
        const values = a.slice(1);
        const cur = String(this.getProperty(name));
        let idx = values.findIndex((v) => String(v) === cur);
        idx = (idx + 1) % values.length;
        this.setProperty(name, this._coerce(name, values[idx]));
        return true;
      }

      case 'seek': {
        const amount = Number(a[0]) || 0;
        const mode = a[1] || 'relative';
        let target;
        if (mode.startsWith('absolute-percent')) {
          target = (this.props.duration * amount) / 100;
        } else if (mode.startsWith('absolute')) {
          target = amount;
        } else {
          target = this.props['time-pos'] + amount;
        }
        this.seek(target);
        return true;
      }

      case 'frame-step':
        this.frameStep(1);
        return true;

      case 'frame-back-step':
        this.frameStep(-1);
        return true;

      case 'screenshot':
        this.dispatchEvent(new CustomEvent('screenshot-request', { detail: { mode: a[0] || 'video' } }));
        return true;

      case 'stop':
        // 停止播放（卸载文件、清空画面），通过 IPC 交给主进程处理后端。
        // 对齐 mpv 引擎行为：停止 = 回到开头（eof 态），点播放从头开始，
        // 时间码归零。pause=true 必须设——_tick 的时间推进条件是
        // !pause,不设的话 clock.pause 停住的 now() 会持续写回 time-pos。
        this.eof = true;
        this.props['eof-reached'] = true;
        this.props.pause = true;
        this.props['time-pos'] = 0;
        this.clock.pause();
        this.audio.pause();
        // 停止也打断进行中的交叉淡入淡出
        if (this._crossfadePending || this._crossfadeRamping) this._cancelCrossfade();
        this._notify('pause', true);
        this._notify('time-pos', 0);
        window.lumen.stop();
        return true;

      case 'quit':
        window.lumen.stop();
        window.lumen.windowCommand('close');
        return true;

      case 'quit-watch-later':
        window.lumen.reportTime(this.props['time-pos']);
        window.lumen.windowCommand('close');
        return true;

      case 'ab-loop':
        this._cycleAbLoop();
        return true;

      case 'reset-video-eq':
        for (const k of ['brightness', 'contrast', 'saturation', 'gamma']) {
          this.setProperty(k, 0);
        }
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '画面参数已重置' } }));
        return true;

      case 'reset-pan-zoom':
        this.setProperty('video-zoom', 1);
        this.setProperty('video-pan-x', 0);
        this.setProperty('video-pan-y', 0);
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '缩放平移已重置' } }));
        return true;

      case 'show-progress':
        this.dispatchEvent(new CustomEvent('show-progress'));
        return true;

      case 'show-text':
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: a.join(' ') } }));
        return true;

      case 'show-playlist':
      case 'playlist-next':
      case 'playlist-prev':
        this.dispatchEvent(new CustomEvent('playlist', { detail: { action: cmd } }));
        return true;

      case 'script-binding':
        this.dispatchEvent(new CustomEvent('script-binding', { detail: { name: a[0] } }));
        return true;

      case 'loadfile':
        this.dispatchEvent(new CustomEvent('loadfile', { detail: { path: a[0] } }));
        return true;

      default:
        // app 级命令（toggle-theme 等）不由 player 处理，
        // 派发事件交给 app.js 的 runCommand() 路由
        this.dispatchEvent(new CustomEvent('app-command', { detail: { args: [cmd, ...a] } }));
        return true;
    }
  }

  _cycleTrack(kind, dir) {
    if (!this.info) return;
    if (kind === 'audio') {
      const n = this.info.audio.length;
      if (n <= 1) {
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '只有一条音轨' } }));
        return;
      }
      const next = (this.props.aid + dir + n) % n;
      this.setProperty('aid', next);
      const t = this.info.audio[next];
      this.dispatchEvent(new CustomEvent('osd', {
        detail: { text: `音轨 ${next + 1}/${n}`, value: trackLabel(t) },
      }));
    } else if (kind === 'video') {
      const n = this.info.video.length;
      if (n <= 1) return;
      const next = (this.props.vid + dir + n) % n;
      this.setProperty('vid', next);
    } else if (kind === 'sub') {
      const n = this.info.subtitle.length;
      if (n === 0) {
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '没有字幕轨' } }));
        return;
      }
      // -1 表示关闭
      let next = this.props.sid + dir;
      if (next >= n) next = -1;
      if (next < -1) next = n - 1;
      this.setProperty('sid', next);
      this.dispatchEvent(new CustomEvent('osd', {
        detail: {
          text: '字幕',
          value: next === -1 ? '关闭' : trackLabel(this.info.subtitle[next]),
        },
      }));
    }
  }

  /* ================= 字幕（ffmpeg 引擎） ================= */

  /**
   * 接收主进程发来的字幕数据（由 ffmpeg 把字幕轨 dump 成 SRT 后解析）。
   * mpv 引擎走系统渲染，不经过这里。
   */
  _onSubtitles(payload) {
    const secondary = !!payload.secondary;
    if (window.__lumenDebug) {
      window.__lumenDebug.log('收到字幕轨#' + payload.index + (secondary ? ' [副]' : '')
        + ' cues=' + (payload.cues ? payload.cues.length : 0)
        + (payload.graphic ? ' [图形]' : '')
        + (payload.error ? ' [err:' + payload.error + ']' : ''));
    }
    console.log('[lumen][render] 收到字幕轨#' + payload.index + (secondary ? ' [副]' : '')
      + ' cues=' + (payload.cues ? payload.cues.length : 0)
      + (payload.graphic ? ' [图形]' : '')
      + (payload.error ? ' [err:' + payload.error + ']' : ''));
    if (payload.graphic) {
      if (secondary) {
        this.subtitleCues2 = [];
        this.subtitleIndex2 = payload.index;
      } else {
        this.subtitleGraphic = true;
        this.subtitleCues = [];
        this.subtitleIndex = payload.index;
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '图形字幕（PGS/DVD）当前版本不支持' } }));
      }
      this._updateSubtitle();
      return;
    }
    if (secondary) {
      this.subtitleCues2 = Array.isArray(payload.cues) ? payload.cues : [];
      this.subtitleIndex2 = payload.index;
      if (payload.external) {
        this.subtitleExternal2 = true;
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '第二字幕', value: '在线（' + this.subtitleCues2.length + ' 条）' } }));
      } else {
        this.subtitleExternal2 = false;
        if (payload.index >= 0) this.props.sid2 = payload.index;
      }
    } else {
      this.subtitleGraphic = false;
      this.subtitleCues = Array.isArray(payload.cues) ? payload.cues : [];
      this.subtitleIndex = payload.index;
      if (payload.external) {
        // 外部下载字幕（在线字幕）：标记为外部，独立于内嵌轨索引
        this.subtitleExternal = true;
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '字幕', value: '在线（' + this.subtitleCues.length + ' 条）' } }));
      } else {
        this.subtitleExternal = false; // 内嵌轨覆盖任何外部下载字幕
        // 与 mpv 一致：载入即自动显示默认字幕轨
        if (payload.index >= 0) this.props.sid = payload.index;
      }
    }
    this._updateSubtitle();
    this._notify(secondary ? 'sid2' : 'sid', secondary ? this.props.sid2 : this.props.sid);
  }

  /** 请求主进程提取指定字幕轨（文本字幕，主字幕） */
  setSubtitleTrack(index) {
    if (typeof window.lumen.setSubtitleTrack === 'function') {
      window.lumen.setSubtitleTrack(index);
    }
  }

  /** 请求主进程提取指定字幕轨（文本字幕，第二字幕 / 双字幕） */
  setSecondarySubtitleTrack(index) {
    if (typeof window.lumen.setSecondarySubtitleTrack === 'function') {
      window.lumen.setSecondarySubtitleTrack(index);
    }
  }

  /** 根据当前时间码挑选应显示的字幕文本（主 + 副） */
  _updateSubtitle() {
    const visible = this.props['sub-visibility'] !== false;
    const active = this.subtitleExternal ? this.subtitleCues.length > 0 : (this.props.sid >= 0);
    const active2 = this.subtitleExternal2 ? this.subtitleCues2.length > 0 : (this.props.sid2 >= 0);
    if (!visible || (!active && !active2)) {
      this._emitSubtitle('', '');
      return;
    }
    // 字幕同步偏移：config 单位 ms → 秒（两个引擎统一口径）
    const t = this.props['time-pos'] + ((this.props['sub-delay'] || 0) / 1000);
    let text = '';
    if (active) {
      for (const c of this.subtitleCues) {
        if (t >= c.start && t < c.end) { text = c.text; break; }
      }
    }
    let text2 = '';
    if (active2) {
      for (const c of this.subtitleCues2) {
        if (t >= c.start && t < c.end) { text2 = c.text; break; }
      }
    }
    this._emitSubtitle(text, text2);
  }

  _emitSubtitle(text, text2 = '') {
    if (text === this._lastSubtitleText && text2 === this._lastSubtitleText2) return;
    this._lastSubtitleText = text;
    this._lastSubtitleText2 = text2;
    this.dispatchEvent(new CustomEvent('subtitle', { detail: { text, text2 } }));
  }

  /* ================= 载入与跳转 ================= */

  onLoaded(payload) {
    this.info = payload.info;
    this.props['idle-active'] = false;
    this.props.duration = payload.info.duration;
    this.props.path = payload.info.path;
    this.props.filename = payload.info.path.split(/[\\/]/).pop();
    this.props['media-title'] = payload.info.title || this.props.filename;
    this.props.aid = 0;
    this.props.vid = 0;
    this.props.sid = -1;
    this.props.sid2 = -1;
    this.subtitleExternal = false; // 新文件清除上一文件的外部字幕
    this.subtitleCues2 = [];
    this.subtitleExternal2 = false;
    this.eof = false;
    this.props['eof-reached'] = false;
    this.abLoop = { a: null, b: null };
    this.queue.resetStats();

    // 新文件重新尝试视频输出，避免上一文件的错误状态残留
    this.voDisabled = false;
    this.voError = null;

    if (payload.output) {
      this._configureVideo(payload.output);
    } else {
      // 切到音频-only 或无视频输出：清掉上一文件残留画面
      console.warn('[lumen][diag] 无视频输出，调用 renderer.clear()');
      this.renderer.clear();
      this.videoTrackInfo = null;
      // 强制触发一次重绘，确保新文件即使无视频也能立即进入清屏分支
      this.needsRedraw = true;
    }

    this.audio.enabled = payload.info.hasAudio;
    this.clock.useAudio(payload.info.hasAudio);

    this._applyEpoch(payload.epoch, payload.resumeAt || 0);

    // 载入即播放 —— 用户打开文件的意图就是要看
    this.setProperty('pause', false);

    for (const k of ['duration', 'filename', 'media-title', 'path', 'idle-active']) {
      this._notify(k, this.getProperty(k));
    }
    this.dispatchEvent(new CustomEvent('loaded', { detail: payload }));
  }

  _configureVideo(output) {
    const v = this.info.video[this.props.vid] || this.info.video[0];
    if (!v) return;
    if (!output) return;

    this.fps = output.fps || v.fps || 25;
    this.frameDuration = 1 / Math.max(this.fps, 1);

    this.videoTrackInfo = {
      width: output.width,
      height: output.height,
      pixfmt: output.pixfmt,
      colorSpace: v.colorSpace,
      colorRange: v.colorRange,
      hdrType: v.hdrType,
      hdr: v.hdr,
    };

    try {
      this.renderer.configure(this.videoTrackInfo);
    } catch (err) {
      // 8K / 极端分辨率下 GPU 分配可能失败；不让它把整个播放器打死
      this.voDisabled = true;
      this.voError = err.message;
      console.error('[lumen] 视频输出配置失败:', err);
      this._notify('vo-disabled', true);
      this.dispatchEvent(new CustomEvent('vo-error', { detail: { message: err.message } }));
      return;
    }
    // 文件自带旋转元数据时自动转正
    this.setProperty('video-rotate', v.rotation || 0, true);
    this.renderer.setOption('rotation', v.rotation || 0);
  }

  _applyEpoch(epoch, time) {
    this.epoch = epoch;
    this.queue.setEpoch(epoch);
    this.audio.flush(time, epoch);
    // 跳转/新载入会打断任何进行中的交叉淡入淡出（并通知主进程杀掉副声部管线）
    if (this._crossfadePending || this._crossfadeRamping) this._cancelCrossfade();
    this.clock.jump(time);
    this.props['time-pos'] = time;
    this.eof = false;
    this.props['eof-reached'] = false;
    this.seeking = false;
    this.needsRedraw = true;
    // 暂停时跳转也必须把目标帧顶出来 —— mpv 就是这个行为。
    // 否则画面还停在跳转前的那一帧，用户以为没跳成功
    this.showNextFrame = true;
  }

  async seek(target) {
    if (!this.info) return;
    const d = this.props.duration;
    const t = Math.max(0, d > 0 ? Math.min(target, d - 0.05) : target);

    this.seeking = true;
    this.props['time-pos'] = t;
    this._notify('time-pos', t);
    this._notify('percent-pos', this.getProperty('percent-pos'));

    const r = await window.lumen.seek(t);
    if (r && r.ok) this._applyEpoch(r.epoch, t);
  }

  /** 逐帧步进。向后步进要重新 seek，因为管线是单向的 */
  frameStep(dir) {
    if (!this.info) return;
    if (dir > 0) {
      this.setProperty('pause', true);
      this.stepping = true;   // 让渲染循环放行一帧
    } else {
      const t = Math.max(0, this.props['time-pos'] - this.frameDuration * 1.5);
      this.setProperty('pause', true);
      this.seek(t);
    }
  }

  /* ================= 数据回调 ================= */

  _onVideoFrame(f) {
    if (this.audioOnly) return;  // 纯音频引擎(音乐)不渲染视频帧
    if (f.epoch !== this.epoch) return;
    this.queue.push(f);
    this._updateFlow(); // 在数据到达时立刻表态，比等下一次 rAF 快一整帧
  }

  _onAudioChunk(c) {
    if (c.voice === Voice.SECONDARY) {
      // 副声部（下一曲目）的 chunk 带独立 epoch，必须匹配副声部 epoch，
      // 否则是过期/错轨数据，直接丢弃。路由到槽位 1（副声部）。
      if (this._secondaryEpoch == null || c.epoch !== this._secondaryEpoch) return;
      this.audio.pushVoice(1, c.buffer, c.pts, c.epoch);
    } else {
      // 主声部：epoch 必须匹配当前激活曲目。
      if (c.epoch !== this.epoch) return;
      this.audio.pushVoice(0, c.buffer, c.pts, c.epoch);
    }
    this._updateFlow();
  }

  _onEos({ epoch, voice, decodeError }) {
    if (epoch !== this.epoch) return;

    // 交叉淡入淡出接管了曲目切换：主声部 EOF 不再触发 eof/暂停，
    // 由 commitCrossfade 在斜坡结束时完成无缝切轨。副声部 EOF 因 epoch
    // 不匹配（≠ 主声部 epoch）已在上面被挡掉，这里只需挡主声部 EOF。
    // 仅当斜坡进行中、或副声部已就绪（即将开始斜坡）时才压下 EOF；
    // 若只是"已请求"但副声部尚未就绪就 EOF（副声部生成过慢），则放过 EOF，
    // 退化为普通切轨（不交叉淡入淡出），避免无声卡死。
    if (this._crossfadeRamping || this._secondaryEpoch != null) return;

    if (this.props['loop-file'] === 'inf') {
      this.seek(0);
      return;
    }

    this.eof = true;
    this.props['eof-reached'] = true;
    this._notify('eof-reached', true);
    // 把解码失败标记透传给上层（活跃引擎 → app.onEof），让其区分
    // "自然放完"与"解码失败"，失败时不报"播放结束"、不误回主页。
    this.dispatchEvent(new CustomEvent('eof', { detail: { decodeError: !!decodeError } }));
  }

  /* ================= 交叉淡入淡出（真·重叠） ================= */

  /**
   * 收到主进程副声部已就绪通知：下一曲目正在并发解码。
   * 创建副声部槽位并用其独立 epoch 重置时钟，否则后续 voice=1 的
   * chunk 会因 epoch 不匹配被 Voice.push 丢弃。
   */
  async _onCrossfadeStarted({ epoch, info, reqId }) {
    // 代作废校验：被取消 / 已提交 / 被新的交叉淡入淡出替代的副声部一律丢弃，
    // 否则过期副声部的 voice=1 chunk 会叠加到新曲上产生双音。
    if (!this._crossfadePending || reqId !== this._crossfadeReqId) return;
    this._secondaryEpoch = epoch;
    this._crossfadeInfo = info;
    this._crossfadePending = true;
    await this.audio.ensureSecondary();
    this.audio.flushVoice(1, 0, epoch);
    if (window.__lumenDebug) {
      window.__lumenDebug.log('交叉淡入淡出副声部就绪 epoch=' + epoch);
    }
  }

  /** 主进程主动终止了副声部（出错或被外部打断）：清理渲染端状态。 */
  _onCrossfadeEnded() {
    if (this._crossfadePending || this._crossfadeRamping) this.audio.cancelCrossfade();
    this._secondaryEpoch = null;
    this._crossfadeInfo = null;
    this._crossfadePending = false;
    this._crossfadeRamping = false;
    this._crossfadePromoteAt = null;
  }

  /**
   * 编排层请求开始交叉淡入淡出：记录下一曲目信息与斜坡时长，并请主进程
   * 生成并发副声部。实际斜坡由 _tick 在临近曲目末尾时触发。
   * @param {object} info 下一曲目探测信息（只需含 path；主进程会 ffprobe 补全）
   * @param {number} durationSec 斜坡时长
   */
  startCrossfade(info, durationSec) {
    if (!info || !info.path) return;
    // 已在预滚同一曲（如 player:loaded 重复触发）：跳过，避免重建副声部抖动
    if (this._crossfadePending && !this._crossfadeRamping
        && this._crossfadeInfo && this._crossfadeInfo.path === info.path) return;
    this._crossfadeReqId = (this._crossfadeReqId || 0) + 1;
    this._crossfadeInfo = info;
    this._crossfadeDuration = Number(durationSec) || 0;
    this._crossfadePending = true;
    if (typeof window.lumen.crossfadeStart === 'function') {
      window.lumen.crossfadeStart(info, this._crossfadeReqId).catch(() => { /* 主进程未就绪 */ });
    }
  }

  /** 公开取消接口（编排层在交叉淡入淡出被关闭/未启用时调用，打断在途副声部）。 */
  cancelCrossfade() { this._cancelCrossfade(); }

  /** 开始 equal-power 斜坡：主声部 1→0，副声部 0→1；到点由 _tick 提升。 */
  beginCrossfade(durationSec, equalPower = true) {
    if (!this.audio.ready) return;
    this.audio.beginCrossfade(durationSec, equalPower);
    this._crossfadeRamping = true;
    this._crossfadePending = false;
    this._crossfadePromoteAt = (this.audio.ctx ? this.audio.ctx.currentTime : 0) + durationSec;
    this.dispatchEvent(new CustomEvent('osd', { detail: { text: '交叉淡入淡出' } }));
  }

  /**
   * 提升副声部为主声部：音频侧完成切轨（promoteVoice 已回收旧主声部槽位），
   * 渲染端把副声部 epoch/信息转正，时钟随之切到新曲目。编排层据此
   * （crossfade-committed 事件）推进播放列表并让主进程交换主/副管线。
   */
  commitCrossfade() {
    if (!this._crossfadeRamping && this._secondaryEpoch == null) return;
    this.audio.promoteVoice();
    this._crossfadeReqId = (this._crossfadeReqId || 0) + 1; // 作废任何在途副声部发起
    const info = this._crossfadeInfo;
    if (info) {
      this.info = info;
      this.props.duration = info.duration;
      this.props.path = info.path;
      this.props.filename = info.path.split(/[\\/]/).pop();
      this.props['media-title'] = info.title || this.props.filename;
      this.audio.enabled = info.hasAudio;
      this.clock.useAudio(info.hasAudio);
      this.props.aid = 0; this.props.vid = 0;
      this.props.sid = -1; this.props.sid2 = -1;
      this.subtitleCues = []; this.subtitleCues2 = [];
      this.subtitleExternal = false; this.subtitleExternal2 = false;
    }
    this.epoch = this._secondaryEpoch;
    this._secondaryEpoch = null;
    this._crossfadeInfo = null;
    this._crossfadePending = false;
    this._crossfadeRamping = false;
    this._crossfadePromoteAt = null;
    // 通知主进程把副声部管线交换为新的主声部管线，使后续 pause/seek/volume
    // 等操作自然作用于新曲目
    if (typeof window.lumen.crossfadeCommit === 'function') {
      window.lumen.crossfadeCommit().catch(() => { /* 主进程未就绪 */ });
    }
    this._notify('duration', this.props.duration);
    this.dispatchEvent(new CustomEvent('crossfade-committed', { detail: { info } }));
  }

  /** 取消进行中的交叉淡入淡出（seek/stop/新载入触发）：丢弃副声部并复位状态。 */
  _cancelCrossfade() {
    const wasActive = this._crossfadePending || this._crossfadeRamping;
    this._crossfadeReqId = (this._crossfadeReqId || 0) + 1; // 作废在途副声部，防止迟到的 started 事件接管
    this.audio.cancelCrossfade();
    this._secondaryEpoch = null;
    this._crossfadeInfo = null;
    this._crossfadePending = false;
    this._crossfadeRamping = false;
    this._crossfadePromoteAt = null;
    if (wasActive && typeof window.lumen.crossfadeCancel === 'function') {
      window.lumen.crossfadeCancel().catch(() => { /* 主进程未就绪 */ });
    }
  }

  /** 渲染循环内的交叉淡入淡出调度：到点开始斜坡 / 斜坡结束提升。 */
  _tickCrossfade() {
    if (!this.info || this.props.pause) return;
    if (this._secondaryEpoch != null && !this._crossfadeRamping && this.props.duration > 0) {
      const dur = this._crossfadeDuration;
      // 临近曲目末尾（留一点余量）开始斜坡；副声部已预解码，无缝衔接。
      // 必须等副声部就绪（_secondaryEpoch 已设置）才允许开始，否则副声部
      // 还没缓冲好就斜坡会露出静音缝隙。
      if (this.props['time-pos'] >= Math.max(0, this.props.duration - dur - 0.05)) {
        this.beginCrossfade(dur, true);
      }
    } else if (this._crossfadeRamping && this._crossfadePromoteAt != null && this.audio.ctx
        && this.audio.ctx.currentTime >= this._crossfadePromoteAt) {
      this.commitCrossfade();
    }
  }

  /* ================= 渲染循环 ================= */

  _startLoop() {
    const loop = () => {
      this._rafId = requestAnimationFrame(loop);
      this._tick();
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _tick() {
    const now = performance.now();

    if (!this.info) {
      if (this.needsRedraw && !this.voDisabled) { this.renderer.render(); }
      this.needsRedraw = false;
      return;
    }

    const t = this.clock.now();

    // A-B 循环
    if (this.abLoop.a !== null && this.abLoop.b !== null && t >= this.abLoop.b) {
      this.seek(this.abLoop.a);
      return;
    }

    let frame = null;

    if (!this.props.pause) {
      frame = this.queue.take(t, this.frameDuration);
    } else if (this.stepping || this.showNextFrame) {
      // 逐帧 / 暂停态跳转：无视时钟，直接吃掉队首帧
      frame = this.queue.frames.shift() || null;
      if (frame) {
        this.stepping = false;
        this.showNextFrame = false;
        // 用解码器实际给到的 PTS 校正时间码：跳转会落到关键帧上，
        // 请求的位置和真实位置未必相等，显示真实的那个
        this.props['time-pos'] = frame.pts;
        this.clock.jump(frame.pts);
        this._notify('time-pos', frame.pts);
        this._notify('percent-pos', this.getProperty('percent-pos'));
      }
    }

    if (frame) {
      if (!this.voDisabled) {
        try {
          const ok = this.renderer.upload(frame.data);
          if (!ok) {
            throw new Error(`视频帧上传失败 (${this.videoTrackInfo.pixfmt})`);
          }
          this.renderer.render();
        } catch (err) {
          console.error('[lumen] 视频渲染失败:', err);
          this.voDisabled = true;
          this.voError = err.message;
          this._notify('vo-disabled', true);
          this.dispatchEvent(new CustomEvent('vo-error', { detail: { message: err.message } }));
        }
      }
      this.showNextFrame = false;
      this.stats.renderedFrames++;
      this.stats.lastPts = frame.pts;
      // 音画偏差：正值表示画面比声音快
      this.stats.avSync = frame.pts - t;

      // 首帧 lastFrameTime 仍为构造初值 0，据此跳过首个失真 delta，
      // 否则首样本≈performance.now()（数千秒）会短暂拉低 FPS 均值（修复 P1#4）
      if (this.stats.lastFrameTime > 0) {
        this.stats.frameTimes.push(now - this.stats.lastFrameTime);
        if (this.stats.frameTimes.length > RENDER_DEFAULTS.frameTimesMax) this.stats.frameTimes.shift();
      }
      this.stats.lastFrameTime = now;
      this.needsRedraw = false;
    } else if (this.needsRedraw) {
      // 暂停时改了画质参数也要立刻看到效果
      this.renderer.render();
      this.needsRedraw = false;
    } else if (this.info && !this.info.hasVideo && !this.voDisabled) {
      // 音频-only 文件：没有视频帧需要渲染，但为了防止上一文件/上一帧
      // 画面残留在 WebGL back buffer 或合成器缓存里，每帧都执行一次清屏。
      this.renderer.render();
    }

    // 时间推进
    if (!this.props.pause && !this.seeking) {
      const clamped = this.props.duration > 0 ? Math.min(t, this.props.duration) : t;
      if (Math.abs(clamped - this.props['time-pos']) > 0.008) {
        this.props['time-pos'] = clamped;
        this._notify('time-pos', clamped);
        this._notify('percent-pos', this.getProperty('percent-pos'));
      }
    }

    // 播完了：keep-open 语义 —— 停在最后一帧而不是关窗
    if (this.eof && !this.props.pause && this.queue.length === 0) {
      this.setProperty('pause', true);
    }

    // 消费掉一帧/一段音频之后水位会下降，这里负责把"再喂点"发回上游。
    // 即便暂停也要跑：暂停后队列不再被消费会迅速填满，必须靠它把"停喂"
    // 信号发回上游，否则解码器会无脑灌爆内存（背压正确性，不能跳过）。
    this._updateFlow();

    // 交叉淡入淡出调度：到点开始斜坡 / 斜坡结束提升副声部为主声部
    this._tickCrossfade();

    // 下面三件事全是 time-pos 的派生量：暂停且稳定（无待呈现帧、无重绘需求）
    // 时 time-pos 冻结，逐帧重算纯属浪费 CPU/GPU。故仅在"活跃"时才跑它们。
    // 活跃 = 播放中，或正在逐帧/跳转呈现，或刚改了画质参数需要重绘。
    const tickActive = !this.props.pause || this.stepping || this.showNextFrame || this.needsRedraw;
    if (tickActive) {
      // 章节是从时间码推导的，跟着时间码一起更新
      this._syncChapter();

      // 字幕跟着时间码走（暂停/逐帧/跳转时也照常更新）
      this._updateSubtitle();

      // 定期把时间回报主进程，用于退出时保存续播位置
      if (now - (this._lastReport || 0) > RENDER_DEFAULTS.reportIntervalMs) {
        this._lastReport = now;
        window.lumen.reportTime(this.props['time-pos']);
      }
    }
  }

  /**
   * 需求驱动的流控——音频和视频独立控制。
   *
   * 音频和视频的数据率差两个数量级（音频 ~16KB/包 vs 视频 ~3MB/帧），
   * 消费速率也完全不同。共用一个信号会导致：
   *   - 音频几十毫秒攒满 2s 缓冲 → 触发 pause → 视频 stdout 也被 pause
   *   - 视频一帧都凑不齐 → 画面永远出不来
   *   - "hungry" 条件要求音频也低水位，但音频还有 2s 缓冲不会低 → 视频永远不恢复
   *
   * 分开后各走各的迟滞：
   *   - 视频：队列 >= qMax-1 时停喂，<= qMax/2 时恢复
   *   - 音频：缓冲 > 2s 时停喂，< 1s 时恢复
   *   - 无音轨文件只控制视频，反之亦然
   */
  _updateFlow() {
    if (!this.info) return;

    const audioSec = this.audio.enabled ? this.audio.bufferedSeconds : 0;
    const qLen = this.queue.length;
    const qMax = this.queue.maxSize;

    // 视频水位（迟滞）
    if (this.audioOnly) this._videoDemand = false;  // 纯音频引擎不请求视频帧
    else {
      if (this._videoDemand === undefined) this._videoDemand = true;
      if (qLen >= qMax - 1) this._videoDemand = false;
      else if (qLen <= Math.max(2, qMax >> 1)) this._videoDemand = true;
    }

    // 音频水位（迟滞）
    if (this._audioDemand === undefined) this._audioDemand = true;
    if (this.audio.enabled) {
      if (audioSec > this.flowHigh) this._audioDemand = false;
      else if (audioSec < this.flowLow) this._audioDemand = true;
    }

    this.transport.setDemand({ audio: this._audioDemand, video: this._videoDemand });
  }

  /**
   * 把当前章节同步进属性存储并广播变化。
   *
   * chapter 是从 time-pos 推导出来的，但不能只做成"读的时候算一下"：
   * 那样 observe_property('chapter') 永远不会触发，OSC 和脚本都看不到
   * 章节切换。mpv 里 chapter 是可观察属性，这里必须对齐。
   */
  _syncChapter() {
    const cur = this._currentChapter();
    if (cur === this.props.chapter) return;
    this.props.chapter = cur;
    this._notify('chapter', cur);
  }

  /** FPS 测量：基类 PlaybackEngine._measuredFps 只返回 this.fps 兜底，
   *  这里用真实渲染帧间隔计算实际 vf-fps（需 ≥10 个样本才稳定）。 */
  _measuredFps() {
    const ft = this.stats.frameTimes;
    if (ft.length < 10) return this.fps;
    let s = 0;
    for (const v of ft) s += v;
    const avg = s / ft.length;
    return avg > 0 ? 1000 / avg : this.fps;
  }

  /** 章节跳转（PGUP/PGDN 用 add chapter ±1 触发） */
  seekChapter(dir) {
    if (!this.info || !this.info.chapters.length) {
      // 没有章节时退化成大跨度跳转，比什么都不做有用
      this.seek(this.props['time-pos'] + dir * 300);
      return;
    }
    const cur = this._currentChapter();
    let next = cur + dir;
    // 往回跳时，若已播过当前章节 3 秒以上，先回到本章开头（播放器通用惯例）
    if (dir < 0 && cur >= 0 && this.props['time-pos'] - this.info.chapters[cur].start > 3) {
      next = cur;
    }
    next = Math.max(0, Math.min(next, this.info.chapters.length - 1));
    const ch = this.info.chapters[next];
    this.seek(ch.start);
    this.dispatchEvent(new CustomEvent('osd', {
      detail: { text: `章节 ${next + 1}/${this.info.chapters.length}`, value: ch.title },
    }));
  }
}

/* ---------------- 工具 ---------------- */

export function fmtTime(sec, forceHours = false) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0 || forceHours) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function trackLabel(t) {
  if (!t) return '未知';
  const parts = [];
  if (t.title) parts.push(t.title);
  if (t.lang) parts.push(`[${t.lang}]`);
  if (!parts.length) parts.push(t.codec.toUpperCase());
  if (t.channels) parts.push(`${t.channels}ch`);
  return parts.join(' ');
}
