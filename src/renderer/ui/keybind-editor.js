/**
 * 快捷键自定义编辑器。
 *
 * 设计要点：
 *  - 以"默认键位表"为蓝本，每一行对应一个默认键。用户改键 / 改命令 / 解除绑定
 *    都落在这一行上，序列化时只把"与默认不同的行"写回 input.conf，
 *    其余交给 DEFAULT_KEYBINDS 兜底 —— 这样未来的默认键位更新仍能自动生效，
 *    且 input.conf 不会越改越臃肿。
 *  - 按键录制走真实 keydown，复用 keys.js 的 keyCandidates 把浏览器事件翻成
 *    mpv 键名，保证写回的键名能被 input.conf 直接识别。
 *  - 同一命令可能被多个默认键绑定（空格 / p / 左键 都是 cycle pause），
 *    这里把它们视为互相独立的行，改其中一行不影响其余行。
 */

import { keyCandidates, wheelCandidates, mouseCandidates, keyDisplay, groupOf, describeBind } from './keys.js';
import { escapeHtml } from '../../shared/escape-html.js';

/**
 * 命令下拉的可选项：覆盖默认键位表中的全部命令，且命令写法与默认表一致
 * （例如默认用 cycle audio 切音轨，这里也用 cycle audio，而不是 add audio 1 ——
 * 后者虽功能相似，但与默认语义不符，容易被误以为是另一套机制）。
 * 落在预设外的命令仍会作为"当前值"选项保留，不会丢数据。
 */
const COMMAND_PRESETS = [
  // 文件
  { command: 'open-file', args: [], label: '打开文件…' },
  { command: 'open-network-stream', args: [], label: '打开网络串流…' },
  // 播放控制 / 窗口
  { command: 'cycle', args: ['pause'], label: '播放 / 暂停' },
  { command: 'cycle', args: ['fullscreen'], label: '全屏切换' },
  { command: 'set', args: ['fullscreen', 'no'], label: '退出全屏' },
  { command: 'pip', args: [], label: '画中画' },
  { command: 'cycle', args: ['ontop'], label: '窗口置顶' },
  { command: 'set', args: ['window-scale', '0.5'], label: '窗口缩放 50%' },
  { command: 'set', args: ['window-scale', '1.0'], label: '窗口缩放 100%' },
  { command: 'set', args: ['window-scale', '2.0'], label: '窗口缩放 200%' },
  // 时间跳转
  { command: 'seek', args: ['5'], label: '快进 5 秒' },
  { command: 'seek', args: ['-5'], label: '后退 5 秒' },
  { command: 'seek', args: ['60'], label: '快进 60 秒' },
  { command: 'seek', args: ['-60'], label: '后退 60 秒' },
  { command: 'seek', args: ['1', 'exact'], label: '精确 +1 秒' },
  { command: 'seek', args: ['-1', 'exact'], label: '精确 -1 秒' },
  { command: 'seek', args: ['10', 'exact'], label: '精确 +10 秒' },
  { command: 'seek', args: ['-10', 'exact'], label: '精确 -10 秒' },
  { command: 'seek', args: ['0', 'absolute'], label: '跳到开头' },
  { command: 'seek', args: ['100', 'absolute-percent'], label: '跳到结尾' },
  { command: 'add', args: ['chapter', '1'], label: '下一章节' },
  { command: 'add', args: ['chapter', '-1'], label: '上一章节' },
  // 逐帧
  { command: 'frame-step', args: [], label: '前进一帧' },
  { command: 'frame-back-step', args: [], label: '后退一帧' },
  // 速度
  { command: 'multiply', args: ['speed', '0.9091'], label: '速度 −10%' },
  { command: 'multiply', args: ['speed', '1.1'], label: '速度 +10%' },
  { command: 'multiply', args: ['speed', '0.5'], label: '速度 ×0.5' },
  { command: 'multiply', args: ['speed', '2.0'], label: '速度 ×2.0' },
  { command: 'set', args: ['speed', '1.0'], label: '速度重置 (1.0)' },
  { command: 'add', args: ['speed', '0.1'], label: '速度 +0.1' },
  { command: 'add', args: ['speed', '-0.1'], label: '速度 −0.1' },
  // 音量
  { command: 'add', args: ['volume', '5'], label: '音量 +5' },
  { command: 'add', args: ['volume', '-5'], label: '音量 −5' },
  { command: 'add', args: ['volume', '2'], label: '音量 +2' },
  { command: 'add', args: ['volume', '-2'], label: '音量 −2' },
  { command: 'cycle', args: ['mute'], label: '静音切换' },
  // 轨道
  { command: 'cycle', args: ['audio'], label: '切换音轨' },
  { command: 'cycle', args: ['audio', 'down'], label: '上一音轨' },
  { command: 'cycle', args: ['sub'], label: '切换字幕' },
  { command: 'cycle', args: ['sub', 'down'], label: '上一字幕' },
  { command: 'cycle', args: ['sub-visibility'], label: '字幕显隐' },
  { command: 'cycle', args: ['video'], label: '切换视频轨' },
  { command: 'add', args: ['sub-delay', '100'], label: '字幕延后 0.1s' },
  { command: 'add', args: ['sub-delay', '-100'], label: '字幕提前 0.1s' },
  { command: 'add', args: ['sub-delay', '1000'], label: '字幕延后 1s' },
  { command: 'add', args: ['sub-delay', '-1000'], label: '字幕提前 1s' },
  // 信息显示
  { command: 'show-progress', args: [], label: '显示进度' },
  { command: 'cycle', args: ['osd-level'], label: '切换 OSD 级别' },
  { command: 'cycle', args: ['stats'], label: '切换统计面板' },
  { command: 'show-keymap', args: [], label: '键位速查' },
  // 画面调整
  { command: 'add', args: ['contrast', '1'], label: '对比度 +1' },
  { command: 'add', args: ['contrast', '-1'], label: '对比度 −1' },
  { command: 'add', args: ['brightness', '1'], label: '亮度 +1' },
  { command: 'add', args: ['brightness', '-1'], label: '亮度 −1' },
  { command: 'add', args: ['gamma', '1'], label: '伽马 +1' },
  { command: 'add', args: ['gamma', '-1'], label: '伽马 −1' },
  { command: 'add', args: ['saturation', '1'], label: '饱和度 +1' },
  { command: 'add', args: ['saturation', '-1'], label: '饱和度 −1' },
  { command: 'reset-video-eq', args: [], label: '重置画面参数' },
  // 缩放平移 / 旋转
  { command: 'add', args: ['video-zoom', '0.1'], label: '缩放 +0.1' },
  { command: 'add', args: ['video-zoom', '-0.1'], label: '缩放 −0.1' },
  { command: 'add', args: ['video-pan-x', '0.02'], label: '水平平移 +' },
  { command: 'add', args: ['video-pan-x', '-0.02'], label: '水平平移 −' },
  { command: 'add', args: ['video-pan-y', '0.02'], label: '垂直平移 +' },
  { command: 'add', args: ['video-pan-y', '-0.02'], label: '垂直平移 −' },
  { command: 'reset-pan-zoom', args: [], label: '重置缩放平移' },
  { command: 'cycle-values', args: ['video-rotate', '90', '180', '270', '0'], label: '旋转 90°→0°' },
  // 渲染管线
  { command: 'cycle', args: ['hwdec'], label: '切换硬件解码' },
  { command: 'cycle', args: ['deband'], label: '切换去色带' },
  { command: 'cycle-values', args: ['scaler', 'bilinear', 'bicubic', 'spline36', 'ewa_lanczos'], label: '缩放算法轮换' },
  { command: 'cycle-values', args: ['tone-mapping', 'hable', 'mobius', 'reinhard', 'bt2390', 'clip'], label: '色调映射轮换' },
  // 截图
  { command: 'screenshot', args: [], label: '截图' },
  { command: 'screenshot', args: ['video'], label: '截图（视频帧）' },
  { command: 'screenshot', args: ['window'], label: '截图（含界面）' },
  { command: 'screenshot-sequence', args: [], label: '连拍截图' },
  // 循环 / 播放列表
  { command: 'ab-loop', args: [], label: 'A-B 循环打点' },
  { command: 'loop-mode-cycle', args: [], label: '循环模式切换' },
  { command: 'playlist-next', args: [], label: '下一个文件' },
  { command: 'playlist-prev', args: [], label: '上一个文件' },
  { command: 'show-playlist', args: [], label: '显示播放列表' },
  // 主题 / 退出
  { command: 'toggle-theme', args: [], label: '切换主题外观' },
  { command: 'quit', args: [], label: '退出' },
  { command: 'quit-watch-later', args: [], label: '退出并记住进度' },
  { command: 'script-binding', args: ['console'], label: '控制台 (脚本)' },
];

const GROUP_ORDER = [
  '文件', '播放控制', '时间跳转', '逐帧', '速度', '音量', '轨道',
  '窗口', '信息显示', '画面调整', '缩放旋转', '渲染管线',
  '截图', '循环', '播放列表', '退出', '其他',
];

function describeRow(b) {
  return describeBind({ command: b.command, args: b.args, raw: `${b.key} ${b.command} ${(b.args || []).join(' ')}`.trim() });
}

function sig(b) {
  return `${b.command} ${(b.args || []).join(' ')}`.trim();
}

export class KeybindEditor {
  constructor(rootEl) {
    this.root = rootEl;          // 挂载点（settings-content 内的一个容器）
    this.rows = [];              // 工作模型：每行 { key, command, args, defaultKey, removed, changed }
    this.recording = null;       // 正在录制的行索引
    this.searchEl = null;        // 顶部搜索框（持久，不被 _render 冲刷）
    this.listEl = null;          // 列表容器
    this._dblTimer = null;       // 鼠标单击/双击区分定时器
  }

  /** 用默认表 + 用户覆盖初始化工作模型 */
  init(defaults, userOverrides) {
    const userByKey = new Map();
    for (const b of userOverrides || []) {
      if (b.command === 'ignore') userByKey.set(b.key, { removed: true });
      else userByKey.set(b.key, { command: b.command, args: b.args || [] });
    }
    this.rows = (defaults || []).map((d) => {
      const ov = userByKey.get(d.key);
      if (ov && ov.removed) {
        return { key: d.key, command: d.command, args: d.args || [], defaultKey: d.key, removed: true, changed: true };
      }
      if (ov) {
        return { key: d.key, command: ov.command, args: ov.args || [], defaultKey: d.key, removed: false, changed: true };
      }
      return { key: d.key, command: d.command, args: d.args || [], defaultKey: d.key, removed: false, changed: false };
    });
  }

  /** 把工作模型序列化成 input.conf 文本：只写与默认不同的行 */
  serialize() {
    const lines = [
      '# Lumora 用户键位（由设置面板生成，仅含与默认不同的项）',
      '# 语法与 mpv input.conf 相同。完整默认表见"导出键位表"。',
      '',
    ];
    for (const r of this.rows) {
      if (!r.changed) continue;
      if (r.removed) { lines.push(`${r.defaultKey} ignore`); continue; }
      const args = (r.args || []).join(' ');
      lines.push(`${r.key} ${r.command}${args ? ' ' + args : ''}`);
    }
    return lines.join('\n') + '\n';
  }

  _render() {
    // 按命令分组（groupOf 依赖 command/args）
    const groups = new Map();
    this.rows.forEach((r, idx) => {
      const g = groupOf({ command: r.command, args: r.args });
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(idx);
    });

    const html = GROUP_ORDER.filter((g) => groups.has(g)).map((g) => {
      const body = groups.get(g).map((idx) => this._renderRow(idx)).join('');
      return `<div class="km-group"><div class="km-group-title">${escapeHtml(g)}</div>${body}</div>`;
    }).join('');
    this._ensureChrome();
    this.listEl.innerHTML = html;
    this._bind();
    this._markConflicts();
    this._applyFilter();
  }

  /** 首次渲染时建立持久化的搜索框 + 列表容器（不被 _render 重建冲刷） */
  _ensureChrome() {
    if (this.listEl) return;
    this.root.innerHTML = '';
    const search = document.createElement('div');
    search.className = 'km-search';
    search.innerHTML = '<input type="search" class="set-text km-search-input" placeholder="搜索命令或按键…" aria-label="搜索键位">';
    this.root.appendChild(search);
    this.searchEl = search.querySelector('input');
    this.listEl = document.createElement('div');
    this.listEl.className = 'km-list';
    this.root.appendChild(this.listEl);
    this.searchEl.addEventListener('input', () => this._applyFilter());
  }

  /** 按 data-search 即时过滤；空组整体隐藏 */
  _applyFilter() {
    if (!this.listEl) return;
    const q = (this.searchEl.value || '').trim().toLowerCase();
    this.listEl.querySelectorAll('.km-group').forEach((g) => {
      let visible = 0;
      g.querySelectorAll('.set-row').forEach((row) => {
        const hay = (row.dataset.search || '').toLowerCase();
        const show = !q || hay.includes(q);
        row.classList.toggle('hidden', !show);
        if (show) visible++;
      });
      g.classList.toggle('hidden', visible === 0);
    });
  }

  /** 同一按键绑到不同命令 => 标记冲突（mpv 以后写入者为准，属静默坑） */
  _markConflicts() {
    if (!this.listEl) return;
    const byKey = new Map();
    this.listEl.querySelectorAll('.set-row[data-idx]').forEach((rowEl) => {
      const idx = Number(rowEl.dataset.idx);
      const r = this.rows[idx];
      if (r.removed) return;
      if (!byKey.has(r.key)) byKey.set(r.key, []);
      byKey.get(r.key).push(idx);
    });
    byKey.forEach((idxs) => {
      if (idxs.length < 2) return;
      const sigs = new Set(idxs.map((i) => sig(this.rows[i])));
      if (sigs.size < 2) return; // 同一命令多键（空格/回车/左键都暂停）不算冲突
      idxs.forEach((i) => {
        const el = this.listEl.querySelector(`.set-row[data-idx="${i}"]`);
        if (el) el.classList.add('conflict');
      });
    });
  }

  _renderRow(idx) {
    const r = this.rows[idx];
    const kbds = keyDisplay(r.removed ? r.defaultKey : r.key)
      .map((p) => `<kbd>${escapeHtml(p)}</kbd>`).join('');
    const desc = describeRow(r);
    const presetMatch = COMMAND_PRESETS.find((p) => p.command === r.command && p.args.join(' ') === (r.args || []).join(' '));
    const opts = COMMAND_PRESETS.map((p) => {
      const v = `${p.command} ${(p.args || []).join(' ')}`.trim();
      const selected = presetMatch ? v === `${r.command} ${(r.args || []).join(' ')}`.trim() : false;
      return `<option value="${escapeHtml(v)}"${selected ? ' selected' : ''}>${escapeHtml(p.label)}</option>`;
    }).join('');
    // 若当前命令不在预设里，补一个"当前值"选项
    const inPreset = !!presetMatch;
    const curVal = `${r.command} ${(r.args || []).join(' ')}`.trim();
    const extraOpt = inPreset ? '' : `<option value="${escapeHtml(curVal)}" selected>${escapeHtml(curVal)}</option>`;
    const changedCls = r.changed ? ' changed' : '';
    const removedCls = r.removed ? ' removed' : '';
    return `<div class="set-row km-row${changedCls}${removedCls}" data-idx="${idx}" data-search="${escapeHtml(desc + ' ' + curVal + ' ' + (r.removed ? r.defaultKey : r.key))}">` +
      `<div class="set-label"><span class="name">${escapeHtml(desc)}</span>` +
      `<span class="km-conflict-warn" title="同一按键已绑定不同命令，mpv 以后写入者为准">⚠</span>` +
      `<span class="hint">${r.removed ? '已解除绑定（默认 ' + escapeHtml(r.defaultKey) + '）' : '默认键 ' + escapeHtml(r.defaultKey)}</span></div>` +
      `<div class="set-control">` +
      `<select class="set-text set-keycmd" data-role="cmd">${extraOpt}${opts}` +
      `<option value="__custom__">自定义…</option></select>` +
      `<button type="button" class="set-keybtn${r.removed ? '' : (r.changed ? ' user' : '')}" data-role="key">${r.removed ? '解除' : kbds}</button>` +
      (r.changed ? `<button type="button" class="set-action ghost" data-role="reset" title="恢复默认">↺</button>` : '') +
      `</div></div>`;
  }

  _bind() {
    this.root.querySelectorAll('.set-row[data-idx]').forEach((rowEl) => {
      const idx = Number(rowEl.dataset.idx);
      const r = this.rows[idx];

      const cmdSel = rowEl.querySelector('[data-role="cmd"]');
      cmdSel.addEventListener('change', () => {
        const v = cmdSel.value;
        if (v === '__custom__') {
          // 退回自定义输入框：用 prompt 收集原始命令串
          const raw = window.prompt('输入 mpv 命令（如 seek 10 exact）：', `${r.command} ${(r.args || []).join(' ')}`.trim());
          if (raw && raw.trim()) {
            const toks = raw.trim().split(/\s+/);
            r.command = toks[0];
            r.args = toks.slice(1);
          }
          this._render();
          return;
        }
        const toks = v.split(/\s+/);
        r.command = toks[0];
        r.args = toks.slice(1);
        r.changed = true;
        this._render();
      });

      const keyBtn = rowEl.querySelector('[data-role="key"]');
      keyBtn.addEventListener('click', () => this._startRecord(idx, keyBtn));

      const resetBtn = rowEl.querySelector('[data-role="reset"]');
      if (resetBtn) resetBtn.addEventListener('click', () => {
        // 还原到默认：命令/参数/键/移除状态全部回到初始（未改）值
        r.command = r._origCommand;
        r.args = r._origArgs;
        r.key = r.defaultKey;
        r.removed = false;
        r.changed = false;
        this._render();
      });
    });
  }

  _startRecord(idx, btn) {
    if (this.recording !== null) this._cancelRecord();
    this.recording = idx;
    btn.classList.add('recording');
    btn.textContent = '按键 / 点击 / 滚轮…';

    // 键盘：复用 keyCandidates 翻成 mpv 键名（含 Shift+ 等修饰）
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const candidates = keyCandidates(e);
      if (!candidates.length) return;
      const key = candidates[0];
      if (key === 'ESC') { this._cancelRecord(); return; } // Esc 取消录制
      this._setKey(idx, key);
    };
    // 鼠标：MBTN_LEFT / MID / RIGHT / BACK / FORWARD；双击检测升级为 _DBL
    const clickState = { last: 0, btn: -1 };
    const onMouse = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      const isDbl = (e.button === clickState.btn) && (now - clickState.last < 320);
      clickState.last = now;
      clickState.btn = e.button;
      if (this._dblTimer) { clearTimeout(this._dblTimer); this._dblTimer = null; }
      if (isDbl) {
        this._setKey(idx, mouseCandidates(e, true)[0]);
        return;
      }
      const single = mouseCandidates(e, false).slice(-1)[0];
      // 延迟 320ms 落定，给双击留窗口；期间若再次点击则升级为 _DBL
      this._dblTimer = setTimeout(() => {
        this._dblTimer = null;
        this._setKey(idx, single);
      }, 320);
    };
    // 滚轮：WHEEL_UP / DOWN / LEFT / RIGHT
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._setKey(idx, wheelCandidates(e).slice(-1)[0]);
    };
    // 取消：再次点录制按钮，或点设置/速查面板之外的区域（键盘录制时"点别处放弃"）
    const cancel = (e) => {
      if (this._recBtn && this._recBtn.contains(e.target)) { this._cancelRecord(); return; }
      const inPanel = e.target.closest && e.target.closest('#settings-panel, #keymap-panel');
      if (!inPanel) this._cancelRecord();
    };

    this._recHandler = onKey;
    this._recMouse = onMouse;
    this._recWheel = onWheel;
    this._recCancel = cancel;
    this._recBtn = btn;
    // 捕获阶段以便抢在全局快捷键之前；wheel 需 passive:false 才能 preventDefault
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('wheel', onWheel, true, { passive: false });
    window.addEventListener('click', cancel, true);
  }

  /** 落定一个录制到的按键并结束录制（单次渲染，避免与 _cancelRecord 重复渲染） */
  _setKey(idx, key) {
    const r = this.rows[idx];
    r.key = key;
    r.removed = false;
    r.changed = true;
    this.recording = null;
    if (this._dblTimer) { clearTimeout(this._dblTimer); this._dblTimer = null; }
    if (this._recHandler) window.removeEventListener('keydown', this._recHandler, true);
    if (this._recMouse) window.removeEventListener('mousedown', this._recMouse, true);
    if (this._recWheel) window.removeEventListener('wheel', this._recWheel, true);
    if (this._recCancel) window.removeEventListener('click', this._recCancel, true);
    this._recHandler = this._recMouse = this._recWheel = this._recCancel = this._recBtn = null;
    this._render();
  }

  _cancelRecord() {
    if (this.recording === null) return;
    const idx = this.recording;
    this.recording = null;
    if (this._dblTimer) { clearTimeout(this._dblTimer); this._dblTimer = null; }
    if (this._recHandler) window.removeEventListener('keydown', this._recHandler, true);
    if (this._recMouse) window.removeEventListener('mousedown', this._recMouse, true);
    if (this._recWheel) window.removeEventListener('wheel', this._recWheel, true);
    if (this._recCancel) window.removeEventListener('click', this._recCancel, true);
    this._recHandler = this._recMouse = this._recWheel = this._recCancel = this._recBtn = null;
    // 重新渲染以还原按钮文字
    if (this.rows[idx]) this._render();
  }

  /** 注入每条默认的原始命令，供"恢复默认"回退（init 时已记录，这里补全） */
  _stampOriginals() {
    for (const r of this.rows) { r._origCommand = r.command; r._origArgs = r.args; }
  }

  build(defaults, userOverrides) {
    this.init(defaults, userOverrides);
    this._stampOriginals();
    this._render();
  }

  /** 恢复全部默认：清空所有改动 */
  resetAll() {
    for (const r of this.rows) {
      r.key = r.defaultKey;
      r.removed = false;
      r.changed = false;
      r.command = r._origCommand;
      r.args = r._origArgs;
    }
    this._render();
  }
}
