/**
 * 路径取基名（跨渲染模块共享，消除各文件抄写副本）。
 * 统一采用防御式 String(p || '') 以兼容 null / undefined 入参。
 */
export function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}
