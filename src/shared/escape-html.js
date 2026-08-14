/**
 * HTML 转义工具（共享单例）。
 * 原散落于 danmaku / idle / playlist / settings 四个面板各抄一份完全相同的实现，
 * 现集中维护，避免多份转义逻辑日后漂移。null/undefined 兜底为空串。
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
