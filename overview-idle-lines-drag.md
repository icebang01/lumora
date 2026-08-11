# Idle 首页修复：恢复科技线条 + 真正解决窗口拖拽

## 问题
用户反馈 idle 首页：
1. 科技感发光线条背景消失；
2. 整窗无法拖动。

## 根因
1. **线条消失**：上一版把 SVG 内联改为 CSS `background-image` data URI 时，SVG 根元素缺少 `xmlns="http://www.w3.org/2000/svg"`。作为独立 SVG 文档的 data URI 必须有命名空间，否则 Chromium 不渲染。
2. **窗口拖不动**：真正原因并非 SVG。`#idle-screen` 的拖拽区被自己的子元素全部挖空：
   - `.idle-card` 整列设为 `-webkit-app-region: no-drag`，中央列无法拖动；
   - `.idle-side` 作为 grid item 默认 stretch 铺满左右 2fr 列，且自身 `no-drag`，导致左右大半窗口也无法拖动。

## 改动
- `tools/gen-idle-bg.js`：SVG 根元素补上 `xmlns`。
- `src/renderer/style.css`：
  - 用带 `xmlns` 的 SVG 重新生成 base64 data URI；
  - `.idle-card` 移除 `no-drag`（内部按钮仍单独 `no-drag`），中央列恢复可拖动；
  - `.idle-side` 加 `align-self: center; justify-self: center;` 收缩到内容大小，周围网格留白回到父级 drag 区。

## 验证
- lint:syntax 143/0
- lint:imports OK
- test:unit 111/111
- typecheck 0

## 提交
- 本地：`895bc3f`
- 远端（Contents API）：`src/renderer/style.css → dacd2f9`，`tools/gen-idle-bg.js → e3d2bc1`
