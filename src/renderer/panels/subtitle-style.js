/**
 * 字幕覆盖层样式应用（渲染端 / ffmpeg 引擎专用）。
 *
 * mpv 引擎由 mpv 自身渲染字幕，这里的 #subtitle-overlay 永远隐藏，
 * 但本模块照常调用（无害），避免对引擎做分支判断。
 *
 * 样式来源是 player.props 里的 sub-* 配置键，保证「设置面板」即时预览
 * 与「播放中」实际渲染用同一套值。
 */
const $ = (id) => document.getElementById(id);

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string') return `rgba(0,0,0,${alpha})`;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 把字幕样式写到覆盖层元素内联样式。
 * @param {object} props player.props（含 sub-* 键）
 * @param {HTMLElement=} primaryEl 主字幕层（默认 #subtitle-overlay）
 * @param {HTMLElement=} secondaryEl 第二字幕层（默认 #subtitle-overlay-2）
 */
export function applySubtitleStyle(props = {}, primaryEl, secondaryEl) {
  const p = primaryEl || $('subtitle-overlay');
  const s = secondaryEl || $('subtitle-overlay-2');
  const els = [p, s].filter(Boolean);
  if (!els.length) return;

  const size = Number(props['sub-font-size'] || 0);
  const color = props['sub-color'] || '#FFFFFF';
  const bold = props['sub-bold'] ? '700' : '600';
  const fontFamily = props['sub-font-family'] || '';
  const outlineSize = Number(props['sub-outline-size'] || 0);
  const outlineColor = props['sub-outline-color'] || '#000000';
  const shadowSize = Number(props['sub-shadow-size'] || 0);
  const bgOn = !!props['sub-bg'];
  const bgColor = props['sub-bg-color'] || '#000000';
  const bgOpacity = Math.max(0, Math.min(100, Number(props['sub-bg-opacity'] != null ? props['sub-bg-opacity'] : 50))) / 100;
  const pos = Math.max(5, Math.min(95, Number(props['sub-pos'] != null ? props['sub-pos'] : 88)));

  // sub-pos：0=顶部，100=底部；覆盖层用 bottom 百分比表达（pos=88 → 距底 12%）
  const primaryBottom = 100 - pos;

  const shadowParts = [];
  if (shadowSize > 0) shadowParts.push(`0 ${shadowSize}px ${shadowSize * 2}px rgba(0,0,0,.9)`);
  const textShadow = shadowParts.length ? shadowParts.join(', ') : '0 1px 2px rgba(0,0,0,.95)';

  els.forEach((el, idx) => {
    const isSecondary = idx === 1;
    const effSize = size ? Math.round(size * (isSecondary ? 0.85 : 1)) : 0;
    if (effSize) el.style.fontSize = effSize + 'px';
    el.style.color = color;
    el.style.fontWeight = bold;
    if (fontFamily) el.style.fontFamily = fontFamily;

    if (outlineSize > 0) {
      el.style.webkitTextStroke = `${outlineSize}px ${outlineColor}`;
      el.style.paintOrder = 'stroke fill';
    } else {
      el.style.webkitTextStroke = '';
      el.style.paintOrder = '';
    }
    el.style.textShadow = textShadow;

    if (bgOn) {
      el.style.background = hexToRgba(bgColor, bgOpacity);
      el.style.padding = '0.18em 0.55em';
      el.style.borderRadius = '0.45em';
      el.style.boxDecorationBreak = 'clone';
      el.style.webkitBoxDecorationBreak = 'clone';
    } else {
      el.style.background = '';
      el.style.padding = '';
      el.style.borderRadius = '';
      el.style.boxDecorationBreak = '';
      el.style.webkitBoxDecorationBreak = '';
    }

    // 第二字幕层抬高一截，避免与主字幕重叠
    const bottom = isSecondary ? primaryBottom + 7 : primaryBottom;
    el.style.bottom = Math.max(2, bottom) + '%';
  });
}
