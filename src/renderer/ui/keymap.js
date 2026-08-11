/**
 * 键位速查（? 键）。
 *
 * 直接从生效的绑定表渲染，而不是硬编码一份说明文档 —— 用户改了
 * input.conf 之后这里立刻跟着变。一份会说谎的帮助文档比没有更糟。
 */

import { groupOf, describeBind, keyDisplay } from './keys.js';

/** 组的展示顺序：常用的排前面 */
const ORDER = [
  '文件', '播放控制', '时间跳转', '逐帧', '速度', '音量', '轨道',
  '窗口', '信息显示', '画面调整', '缩放旋转', '渲染管线',
  '截图', '循环', '播放列表', '退出', '其他',
];

export class KeymapPanel {
  constructor(el, bodyEl, closeBtn, onHide) {
    this.el = el;
    this.body = bodyEl;
    this.binds = [];
    this.built = false;
    this.userMoved = false;
    this.dragState = null;
    this.onHide = onHide;

    this.win = el.querySelector('.keymap-window');
    this.head = el.querySelector('.keymap-window .panel-head');
    this.backdrop = el.querySelector('.keymap-backdrop');

    // 顶部搜索框（即时过滤键位表）；放在标题与关闭按钮之间
    this.searchEl = document.createElement('input');
    this.searchEl.type = 'search';
    this.searchEl.className = 'set-text km-search-input';
    this.searchEl.placeholder = '搜索命令或按键…';
    this.searchEl.setAttribute('aria-label', '搜索键位');
    this.head.insertBefore(this.searchEl, closeBtn);
    this.searchEl.addEventListener('input', () => this._applyFilter());

    closeBtn.addEventListener('click', () => this.hide());
    if (this.backdrop) this.backdrop.addEventListener('click', () => this.hide());
    this._makeDraggable();
    window.addEventListener('resize', () => this._onResize());
  }

  load(binds) {
    this.binds = binds || [];
    this.built = false;
    return this;
  }

  toggle() { this.el.classList.contains('hidden') ? this.show() : this.hide(); }

  show() {
    if (!this.built) { this._build(); this.built = true; }
    this.el.classList.remove('hidden');
    if (!this.userMoved) this._center();
    this._applyFilter();
  }

  hide() {
    this.el.classList.add('hidden');
    if (typeof this.onHide === 'function') this.onHide();
  }

  get visible() { return !this.el.classList.contains('hidden'); }

  _center() {
    if (!this.win) return;
    this.win.style.left = '50%';
    this.win.style.top = '50%';
    this.win.style.transform = 'translate(-50%, -50%)';
  }

  _onResize() {
    if (!this.visible || !this.win) return;
    if (!this.userMoved) {
      this._center();
      return;
    }
    // 用户拖过：只做边界约束
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minVisible = 48;
    let x = parseInt(this.win.style.left || 0, 10);
    let y = parseInt(this.win.style.top || 0, 10);
    x = Math.max(minVisible - this.win.offsetWidth, Math.min(x, vw - minVisible));
    y = Math.max(0, Math.min(y, vh - minVisible));
    this.win.style.left = `${x}px`;
    this.win.style.top = `${y}px`;
  }

  _makeDraggable() {
    if (!this.head || !this.win) return;

    this.head.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, textarea, select')) return; // 关闭按钮/搜索框不触发拖拽
      this.dragState = {
        startX: e.clientX,
        startY: e.clientY,
        initLeft: this.win.offsetLeft,
        initTop: this.win.offsetTop,
      };
      this.head.style.cursor = 'grabbing';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.dragState || !this.win) return;
      const dx = e.clientX - this.dragState.startX;
      const dy = e.clientY - this.dragState.startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const minVisible = 48;
      let x = this.dragState.initLeft + dx;
      let y = this.dragState.initTop + dy;
      x = Math.max(minVisible - this.win.offsetWidth, Math.min(x, vw - minVisible));
      y = Math.max(0, Math.min(y, vh - minVisible));
      this.win.style.left = `${x}px`;
      this.win.style.top = `${y}px`;
      this.win.style.transform = 'none';
      this.userMoved = true;
    });

    window.addEventListener('mouseup', () => {
      if (!this.dragState) return;
      this.dragState = null;
      if (this.head) this.head.style.cursor = 'grab';
    });
  }

  _build() {
    const groups = new Map();
    for (const b of this.binds) {
      const g = groupOf(b);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(b);
    }

    // 同一个命令绑了多个键（比如空格和 p 都是暂停）就合并成一行
    const html = ORDER.filter((g) => groups.has(g)).map((title) => {
      const merged = new Map();
      for (const b of groups.get(title)) {
        const sig = `${b.command} ${(b.args || []).join(' ')}`;
        if (!merged.has(sig)) merged.set(sig, { bind: b, keys: [] });
        merged.get(sig).keys.push(b.key);
      }

      const rows = [...merged.values()].map(({ bind, keys }) => {
        const kbds = keys.slice(0, 3).map((k) =>
          keyDisplay(k).map((part) => `<kbd>${esc(part)}</kbd>`).join('')
        ).join('<span style="opacity:.3;margin:0 2px">/</span>');
        const hay = keys.join(' ') + ' ' + keys.map((k) => keyDisplay(k).join(' ')).join(' ') + ' ' + describeBind(bind);
        return `<div class="km-row" data-search="${esc(hay)}"><span class="km-keys">${kbds}</span>` +
               `<span class="km-desc">${esc(describeBind(bind))}</span></div>`;
      }).join('');

      return `<div class="km-group"><div class="km-group-title">${esc(title)}</div>${rows}</div>`;
    }).join('');

    this.body.innerHTML = html;
  }

  /** 按 data-search 即时过滤；空组整体隐藏 */
  _applyFilter() {
    if (!this.searchEl || !this.body) return;
    const q = (this.searchEl.value || '').trim().toLowerCase();
    this.body.querySelectorAll('.km-group').forEach((g) => {
      let visible = 0;
      g.querySelectorAll('.km-row').forEach((row) => {
        const hay = (row.dataset.search || '').toLowerCase();
        const show = !q || hay.includes(q);
        row.classList.toggle('hidden', !show);
        if (show) visible++;
      });
      g.classList.toggle('hidden', visible === 0);
    });
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
