/**
 * 统计面板（i 键）。
 *
 * 风格融合 mpv stats.lua 的密集内联布局 + 中文标签 + 品牌色分区强调：
 * section 标题与主值同行、子字段缩进、一行可并列多个字段；分区标题用
 * 品牌色强调（v1 的渐变竖条改为内联强调色），面板保留卡片化质感。
 */

import { escapeHtml as esc } from '../../shared/escape-html.js';

const FT_BARS = 60;

export class StatsPanel {
  constructor(el, player, bootstrap) {
    this.el = el;
    this.player = player;
    this.bootstrap = bootstrap;
    this.visible = false;
    this._timer = null;
    this._graph = null;

    player.observeProperty('stats', (v) => this.setVisible(!!v));
  }

  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('hidden', !v);
    clearInterval(this._timer);
    if (v) {
      this._render();
      // 4Hz 足够读数了，再快只会让数字糊成一团
      this._timer = setInterval(() => this._render(), 250);
    }
  }

  _render() {
    const p = this.player;
    const sections = [];

    /* ---- 文件 ---- */
    if (p.info) {
      const i = p.info;
      const title = i.title || p.props['media-title'] || '—';
      const chapterText = i.chapters && i.chapters.length
        ? `${(Number(p.props.chapter) || 0) + 1} / ${i.chapters.length}`
        : '—';
      const totalReceivedMiB = p.transport && p.transport.totalReceived
        ? (p.transport.totalReceived / 1048576).toFixed(2)
        : '0.00';
      sections.push({
        title: '文件',
        header: [['', p.props.filename]],
        lines: [
          [['标题', title]],
          [
            ['章节', chapterText],
            ['大小', i.size ? fmtBytes(i.size) : '—'],
            ['封装 / 协议', i.container || '—'],
          ],
          [['总缓存', `${totalReceivedMiB} MiB`]],
        ],
      });
    } else {
      sections.push({ title: '状态', header: [['', '空闲，等待载入文件']], lines: [] });
    }

    /* ---- 显示 ---- */
    const ri = p.renderer.rendererInfo;
    const clockText = p.clock.source === 'audio' ? '音频' : p.clock.source === 'mpv' ? 'mpv' : '系统';
    sections.push({
      title: '显示',
      header: [
        ['', shorten(ri.renderer || '未知', 42)],
        ['上下文', p.props['gpu-api'] || '—'],
      ],
      lines: [
        [['A-V', ...fmtSync(p.stats.avSync)]],
        [['丢帧', `${p.queue.dropped}（解码器） 0（输出）`]],
        [['主时钟', clockText]],
      ],
    });

    /* ---- 帧时间 ---- */
    const ft = this._frameTimeStats();
    if (ft) {
      sections.push({
        title: '帧时间',
        subtitle: '（末值 / 均值 / 峰值 ms）',
        lines: [
          [[`${ft.last.toFixed(3)} / ${ft.avg.toFixed(3)} / ${ft.peak.toFixed(3)}`]],
        ],
      });
    }

    /* ---- 视频 ---- */
    const v = p.info && p.info.video[p.props.vid];
    if (v) {
      const out = p.videoTrackInfo || {};
      const aspect = (v.width / v.height).toFixed(2);
      const sarText = v.sar !== 1 ? ` SAR ${v.sar.toFixed(2)}:1` : '';
      sections.push({
        title: '视频',
        header: [['', `${v.codec} ${v.bitDepth}bit`]],
        lines: [
          [
            ['帧率', `${v.fps.toFixed(3)} fps`],
            ['分辨率', `${v.width}×${v.height}${sarText}（${aspect}:1）`],
          ],
          [
            ['格式', out.pixfmt || '—'],
            ['色阶', v.colorRange || '—'],
          ],
          [
            ['色彩矩阵', v.colorSpace || '—'],
            ['原色', v.colorSpace || '—'],
            ['传输特性', v.colorTransfer || '—'],
          ],
          ...(v.hdr && v.hdr.maxCll ? [[['MaxCLL', `${v.hdr.maxCll} nits`]]] : []),
          [['码率', p.info.bitrate ? `${(p.info.bitrate / 1e6).toFixed(3)} Mbps` : '—']],
        ],
      });
    }

    /* ---- 音频 ---- */
    const a = p.info && p.info.audio[p.props.aid];
    if (a) {
      sections.push({
        title: '音频',
        header: [['', `${a.codec}`]],
        lines: [
          [
            ['声道', String(a.channels)],
            ['采样率', `${a.sampleRate} Hz`],
          ],
          [
            ['码率', a.bitrate ? `${(a.bitrate / 1e6).toFixed(3)} Mbps` : '—'],
            ['缓冲', ...fmtLevel(p.audio.bufferedSeconds, 's', 0.15, 0.05, 3)],
          ],
          [['欠载', ...fmtLevel(p.audio.underruns, '', 1, 5, 0, true)]],
        ],
      });
    }

    /* ---- 渲染管线 ---- */
    sections.push({
      title: '渲染管线',
      header: [],
      lines: [
        [
          ['缩放算法', p.renderer.scalerLabel],
          ['色调映射', p.props['tone-mapping']],
        ],
        [
          ['去色带', p.props.deband ? '开' : '关'],
          ['硬件解码', p.props.hwdec],
          ['浮点缓冲', ri.floatFBO ? '是' : '否'],
        ],
        [['绘制耗时', `${p.renderer.avgRenderMs.toFixed(2)} ms`]],
      ],
    });

    /* ---- 传输 ---- */
    sections.push({
      title: '传输',
      header: [],
      lines: [
        [
          ['帧队列', `${p.queue.length} / ${p.queue.maxSize} 帧`],
          ['已呈现', `${p.queue.presented} 帧`],
        ],
        [
          ['传输速率', `${(p.transport.bitrate / 1048576).toFixed(2)} MB/s`],
          ['播放速度', `${p.props.speed.toFixed(2)}×`],
        ],
      ],
    });

    /* ---- 环境 ---- */
    const bs = this.bootstrap;
    sections.push({
      title: '环境',
      header: [],
      lines: [
        [
          ['FFmpeg', shorten(bs.ffmpeg.version || '—', 22)],
          ['硬件加速', (bs.ffmpeg.hwaccels || []).slice(0, 4).join(' ') || '—'],
        ],
        [
          ['Electron', bs.versions.electron],
          ['Chromium', bs.versions.chrome],
        ],
      ],
    });

    const scrollTop = this.el.scrollTop;
    this.el.innerHTML =
      '<div class="stats-header">' +
        '<span class="stats-title">媒体信息</span>' +
        '<span class="stats-hint">按 <kbd>i</kbd> 关闭</span>' +
      '</div>' +
      '<div class="stats-body">' +
        sections.map(renderSection).join('') +
        '<div class="stat-section" data-section="frametime">' +
          '<div class="stat-line stat-section-title"><span class="stat-section-label">帧时间图</span></div>' +
          '<div id="frametime-graph"></div>' +
        '</div>' +
      '</div>';
    this.el.scrollTop = scrollTop;

    this._renderGraph();
  }

  _frameTimeStats() {
    const times = this.player.stats.frameTimes;
    if (!times || times.length < 2) return null;
    const recent = times.slice(-FT_BARS);
    const last = recent[recent.length - 1];
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const peak = Math.max(...recent);
    return { last, avg, peak };
  }

  _renderGraph() {
    const host = this.el.querySelector('#frametime-graph');
    if (!host) return;
    const times = this.player.stats.frameTimes.slice(-FT_BARS);
    if (!times.length) return;

    // 以两倍目标帧时间为满格，超过一帧的柱子标红
    const target = 1000 / Math.max(this.player.fps, 1);
    const scale = target * 2;
    host.innerHTML = times.map((t) => {
      const h = Math.max(2, Math.min(t / scale, 1) * 100);
      const over = t > target * 1.5 ? ' over' : '';
      return `<div class="ft-bar${over}" style="height:${h}%"></div>`;
    }).join('');
  }
}

/* ---------------- 格式化 ---------------- */

function renderSection(sec) {
  const title = esc(sec.title);
  const subtitle = sec.subtitle ? ` <span class="stat-subtitle">${esc(sec.subtitle)}</span>` : '';
  const headerFields = sec.header ? sec.header.map(renderField).join('') : '';
  const header = `<div class="stat-line stat-section-title"><span class="stat-section-label">${title}：</span>${headerFields}${subtitle}</div>`;
  const lines = sec.lines.map((line) => renderLine(line, true)).join('');
  return `<div class="stat-section" data-section="${title}">${header}${lines}</div>`;
}

function renderLine(fields, indent = false) {
  const cls = indent ? ' stat-indent' : '';
  return `<div class="stat-line${cls}">${fields.map(renderField).join('')}</div>`;
}

function renderField(f) {
  if (!Array.isArray(f) || !f.length) return '';
  // fmtLevel/fmtSync 返回 [text, '', cls] 三元组；这里只处理字符串三元组
  const [label, value = '', cls = ''] = f;
  const valCls = cls ? ` ${cls}` : '';
  if (!label) {
    return `<span class="stat-field"><span class="stat-val raw${valCls}">${esc(value)}</span></span>`;
  }
  return `<span class="stat-field"><span class="stat-label">${esc(label)}：</span><span class="stat-val${valCls}">${esc(value)}</span></span>`;
}

function fmtSync(s) {
  const ms = s * 1000;
  const abs = Math.abs(ms);
  const cls = abs < 20 ? 'good' : abs < 60 ? 'warn' : 'bad';
  return [`${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms`, '', cls];
}

/** 阈值着色。invert=true 表示"越小越好" */
function fmtLevel(value, unit, goodAt, warnAt, digits = 0, invert = false) {
  const n = Number(value) || 0;
  const text = `${n.toFixed(digits)}${unit}`;
  let cls;
  if (invert) cls = n < goodAt ? 'good' : n < warnAt ? 'warn' : 'bad';
  else cls = n >= goodAt ? 'good' : n >= warnAt ? 'warn' : 'bad';
  return [text, '', cls];
}

function fmtBytes(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 2 : 0)} ${u[i]}`;
}

function shorten(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

