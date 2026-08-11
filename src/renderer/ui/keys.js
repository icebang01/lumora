/**
 * 键位系统 —— 把浏览器事件翻译成 mpv 的键名。
 *
 * 这一层存在的唯一理由：让用户的 input.conf 可以从 mpv 直接抄过来。
 * 浏览器给的是 KeyboardEvent.key（'ArrowRight'、' '、'Escape'），
 * mpv 用的是 RIGHT / SPACE / ESC，两套命名必须在这里对齐。
 *
 * 匹配策略是"候选列表"而不是"唯一键名"：同一个物理按键在不同写法下
 * 都能命中（BACKSPACE 与 BS、Shift+R 与 R）。这样用户不管从哪份配置
 * 抄过来的键位都能生效，而不是静默失灵 —— 后者是配置系统最劝退的
 * 一种失败方式。
 */

/** 浏览器 key → mpv 键名（按优先级排列的别名） */
const NAMED = new Map([
  [' ',          ['SPACE']],
  ['Spacebar',   ['SPACE']],
  ['Enter',      ['ENTER', 'KP_ENTER']],
  ['Escape',     ['ESC', 'ESCAPE']],
  ['Backspace',  ['BACKSPACE', 'BS']],
  ['Tab',        ['TAB']],
  ['Delete',     ['DEL', 'DELETE']],
  ['Insert',     ['INS', 'INSERT']],
  ['Home',       ['HOME']],
  ['End',        ['END']],
  ['PageUp',     ['PGUP', 'PAGEUP']],
  ['PageDown',   ['PGDWN', 'PGDOWN', 'PAGEDOWN']],
  ['ArrowRight', ['RIGHT']],
  ['ArrowLeft',  ['LEFT']],
  ['ArrowUp',    ['UP']],
  ['ArrowDown',  ['DOWN']],
  ['PrintScreen',['PRINT']],
  ['Menu',       ['MENU']],
  // mpv 里 '#' 只能写成 SHARP，因为行首的 # 是注释
  ['#',          ['SHARP', '#']],
]);
for (let i = 1; i <= 12; i++) NAMED.set(`F${i}`, [`F${i}`]);

/** 键名 → 面板上显示的样子 */
const DISPLAY = {
  SPACE: '空格', ENTER: '回车', ESC: 'Esc', BACKSPACE: '⌫', BS: '⌫',
  TAB: 'Tab', DEL: 'Del', INS: 'Ins', HOME: 'Home', END: 'End',
  PGUP: 'PgUp', PGDWN: 'PgDn', SHARP: '#',
  RIGHT: '→', LEFT: '←', UP: '↑', DOWN: '↓',
  WHEEL_UP: '滚轮↑', WHEEL_DOWN: '滚轮↓', WHEEL_LEFT: '滚轮←', WHEEL_RIGHT: '滚轮→',
  MBTN_LEFT: '左键', MBTN_RIGHT: '右键', MBTN_MID: '中键',
  MBTN_LEFT_DBL: '双击', MBTN_BACK: '侧键←', MBTN_FORWARD: '侧键→',
};

function modPrefix(e) {
  return (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.metaKey ? 'Meta+' : '');
}

/**
 * 从键盘事件生成候选键名，按匹配优先级排序。
 *
 * 可打印字符走"实际产生的字符"路线（Shift+2 在美式键盘上就是 @，
 * 不该写成 Shift+2），这与 mpv 的行为一致；具名键则带 Shift+ 前缀。
 */
export function keyCandidates(e) {
  const out = [];
  const mods = modPrefix(e);
  const withShift = mods + 'Shift+';

  const named = NAMED.get(e.key);
  if (named) {
    for (const n of named) {
      if (e.shiftKey) out.push(withShift + n);
      out.push(mods + n);
    }
    return out;
  }

  const k = e.key;
  if (typeof k !== 'string' || [...k].length !== 1) return out;

  const lower = k.toLowerCase();
  out.push(mods + k);
  if (e.shiftKey) {
    out.push(withShift + k);
    if (lower !== k) out.push(withShift + lower);
  }
  if (lower !== k) out.push(mods + lower);
  return out;
}

export function wheelCandidates(e) {
  // 滚轮一律用于 seek —— 故意忽略 Ctrl/Alt/Meta 修饰符。
  // 原因：Windows 上触控板双指缩放、部分鼠标驱动的"平滑滚动"会把普通滚动
  // 附带 Ctrl 修饰符上报，若在这里保留 Ctrl 前缀，普通滚动会被错配到
  // Ctrl+WHEEL 音量绑定上（即便没有该绑定，也会让 seek 命中失败）。
  // 音量改用屏幕滑块或 9/0/*// 键控制，滚轮语义保持单一、可预期。
  const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
  const name = vertical
    ? (e.deltaY < 0 ? 'WHEEL_UP' : 'WHEEL_DOWN')
    : (e.deltaX < 0 ? 'WHEEL_LEFT' : 'WHEEL_RIGHT');
  const out = [];
  if (e.shiftKey) out.push('Shift+' + name);
  out.push(name);
  return out;
}

const MBTN = ['MBTN_LEFT', 'MBTN_MID', 'MBTN_RIGHT', 'MBTN_BACK', 'MBTN_FORWARD'];

export function mouseCandidates(e, double = false) {
  const name = MBTN[e.button] || `MBTN_${e.button}`;
  const mods = modPrefix(e);
  const out = [];
  if (double) out.push(mods + name + '_DBL');
  if (e.shiftKey) out.push(mods + 'Shift+' + name);
  out.push(mods + name);
  return out;
}

/** 键名转成人看的样子：Ctrl+WHEEL_UP → Ctrl 滚轮↑ */
export function keyDisplay(key) {
  const parts = key.split('+');
  const base = parts.pop();
  const mods = parts.map((m) => (m === 'Meta' ? '⌘' : m));
  return [...mods, DISPLAY[base] || base];
}

/* ------------------------------------------------------------------ */
/* 绑定表                                                              */
/* ------------------------------------------------------------------ */

export class KeybindManager {
  constructor() {
    this.map = new Map();     // 键名 → bind
    this.binds = [];
    this.scriptBinds = new Map(); // 脚本注册的键位，优先级高于配置文件
  }

  load(binds) {
    this.binds = binds || [];
    this.map.clear();
    for (const b of this.binds) this.map.set(b.key, b);
    return this;
  }

  /** 脚本可以抢占键位。返回解绑函数 */
  addScriptBinding(key, name, handler) {
    this.scriptBinds.set(key, { key, name, handler });
    return () => this.scriptBinds.delete(key);
  }

  /** 在候选列表里找第一个命中的绑定 */
  lookup(candidates) {
    for (const c of candidates) {
      const s = this.scriptBinds.get(c);
      if (s) return { script: s, key: c };
      const b = this.map.get(c);
      if (b) return { bind: b, key: c };
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 键位面板用的描述                                                     */
/* ------------------------------------------------------------------ */

const GROUPS = [
  ['文件',     (c) => c === 'open-file' || c === 'loadfile' || c === 'open-network-stream'],
  ['播放控制', (c, a) => c === 'cycle' && a[0] === 'pause'],
  ['逐帧',     (c) => c === 'frame-step' || c === 'frame-back-step'],
  ['时间跳转', (c, a) => c === 'seek' || (c === 'add' && a[0] === 'chapter')],
  ['速度',     (c, a) => a[0] === 'speed'],
  ['音量',     (c, a) => a[0] === 'volume' || a[0] === 'mute'],
  ['轨道',     (c, a) => ['audio', 'video', 'sub', 'sub-visibility'].includes(a[0])],
  ['画面调整', (c, a) => ['contrast', 'brightness', 'gamma', 'saturation'].includes(a[0]) || c === 'reset-video-eq'],
  ['缩放旋转', (c, a) => String(a[0] || '').startsWith('video-') || c === 'reset-pan-zoom'],
  ['渲染管线', (c, a) => ['hwdec', 'deband', 'scaler', 'tone-mapping'].includes(a[0])],
  ['窗口',     (c, a) => ['fullscreen', 'ontop', 'window-scale'].includes(a[0])],
  ['界面',     (c) => c === 'toggle-theme'],
  ['截图',     (c) => c === 'screenshot' || c === 'screenshot-sequence'],
  ['循环',     (c, a) => c === 'ab-loop' || a[0] === 'loop-file'],
  ['播放列表', (c) => c.startsWith('playlist') || c === 'show-playlist'],
  ['信息显示', (c, a) => c === 'show-progress' || c === 'show-keymap' || ['stats', 'osd-level'].includes(a[0])],
  ['退出',     (c) => c.startsWith('quit')],
];

export function groupOf(bind) {
  const c = bind.command;
  const a = bind.args || [];
  for (const [title, match] of GROUPS) {
    try { if (match(c, a)) return title; } catch { /* 匹配器不该抛，兜底忽略 */ }
  }
  return '其他';
}

const PROP_NAMES = {
  pause: '暂停', volume: '音量', mute: '静音', speed: '速度',
  fullscreen: '全屏', ontop: '窗口置顶', 'window-scale': '窗口缩放',
  audio: '音轨', video: '视频轨', sub: '字幕', 'sub-visibility': '字幕显示',
  contrast: '对比度', brightness: '亮度', gamma: '伽马', saturation: '饱和度',
  'video-zoom': '缩放', 'video-pan-x': '水平平移', 'video-pan-y': '垂直平移',
  'video-rotate': '旋转', hwdec: '硬件解码', deband: '去色带',
  scaler: '缩放算法', 'tone-mapping': '色调映射', stats: '统计面板',
  'osd-level': 'OSD 级别', 'loop-file': '单文件循环', chapter: '章节',
  'sub-delay': '字幕延迟',
};

/** 把一条绑定翻成中文描述，供键位速查面板使用 */
export function describeBind(bind) {
  const a = bind.args || [];
  const p = PROP_NAMES[a[0]] || a[0] || '';

  switch (bind.command) {
    case 'cycle':
      if (a[0] === 'pause') return '播放 / 暂停';
      if (a[1] === 'down') return `上一条${p}`;
      return ['audio', 'video', 'sub'].includes(a[0]) ? `切换${p}` : `切换${p}`;
    case 'cycle-values':
      return `轮换${p}（${a.slice(1).join(' / ')}）`;
    case 'set':
      return `${p} 设为 ${a[1]}`;
    case 'add': {
      const n = Number(a[1]);
      if (a[0] === 'chapter') return n > 0 ? '下一章节' : '上一章节';
      return `${p} ${n > 0 ? '+' : ''}${a[1]}`;
    }
    case 'multiply': {
      const n = Number(a[1]);
      if (Math.abs(n - 1.1) < 1e-6) return '速度 +10%';
      if (Math.abs(n - 0.9091) < 1e-3) return '速度 −10%';
      return n > 1 ? `速度 ×${n}` : `速度 ÷${(1 / n).toFixed(1)}`;
    }
    case 'seek': {
      const n = Number(a[0]);
      if (a[1] && a[1].startsWith('absolute-percent')) return n === 0 ? '跳到开头' : '跳到结尾';
      if (a[1] === 'absolute') return `跳到 ${n} 秒`;
      const exact = a[1] === 'exact' ? '（精确）' : '';
      return `${n > 0 ? '快进' : '后退'} ${Math.abs(n)} 秒${exact}`;
    }
    case 'open-file': return '打开文件…';
    case 'open-network-stream': return '打开网络串流…';
    case 'show-keymap': return '键位速查';
    case 'frame-step': return '前进一帧';
    case 'frame-back-step': return '后退一帧';
    case 'screenshot': return a[0] === 'window' ? '截图（含界面）' : '截图';
  case 'screenshot-sequence': return '连拍截图';
    case 'quit': return '退出';
    case 'quit-watch-later': return '退出并记住进度';
    case 'ab-loop': return 'A-B 循环打点';
    case 'reset-video-eq': return '重置画面参数';
    case 'reset-pan-zoom': return '重置缩放平移';
    case 'show-progress': return '显示进度';
    case 'show-playlist': return '显示播放列表';
    case 'playlist-next': return '下一个文件';
    case 'playlist-prev': return '上一个文件';
    case 'script-binding': return `脚本：${a[0]}`;
    case 'toggle-theme': return '切换主题外观';
    case 'pip': return '画中画';
    case 'loop-mode-cycle': return '循环模式切换';
    default: return bind.raw ? bind.raw.replace(/^\S+\s+/, '') : bind.command;
  }
}
