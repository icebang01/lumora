# 移除音乐播放器样式深色底

## 改动
- `src/renderer/style.css`
  - 删除全局 `#music-stage::after` 底部提亮层，消除所有样式底部的额外暗色叠加。
  - `.ms-backdrop` 压暗从 `brightness(.65)` 提升到 `brightness(1.0)`，封面/无封面背景都明显变通透。
  - 无封面 fallback 背景从深蓝黑 `#14162a → #0a0b14` 改为更亮的 `#3a3e50 → #2a2d3a`，并提高氛围光斑不透明度。
  - `#music-stage` 兜底背景从 `#0a0a0f` 改为 `#1a1c26`，避免加载瞬间死黑。
  - `style-lyrics` 删除 `.ms-backdrop::after` 暗色渐变遮罩，仅保留清晰图片放大效果。
  - `.ms-ambient` 氛围光层 opacity 从 `.55` 降到 `.3`，减少暗色叠加。
- `src/renderer/index.html`
  - CSS 版本号 `?v=52 → ?v=53`，强制浏览器刷新样式表。

## 影响范围
- 受影响的样式：`style-default`、`style-cover`、`style-lyrics`、`style-minimal`、`style-square`、`style-lyrics-min`。
- 不受影响：`style-vinyl`、`style-glass`（原本就是浅色背景，已关闭 backdrop/ambient）。

## 验证
- `npm run lint:syntax`：154/154 通过
- `npm run test:unit`：120/120 通过
- `npm run typecheck`：通过

## 注意
Electron 源码模式（`npm start`）下，Chromium 会缓存 `file://` 协议的 HTML/CSS。若界面仍无变化，请彻底关闭进程后重新运行启动脚本。
