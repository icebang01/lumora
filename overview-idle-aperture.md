# Idle 背景：右上光环改为动态光圈

## 改动
将 idle 首页右上角原本静止的双环，改成缓慢旋转 + 呼吸的「镜头光圈」效果：

- **外圈光圈**：顺时针旋转（48s/圈）+ 透明度/缩放呼吸；
- **内圈光圈**：逆时针旋转（32s/圈）+ 透明度呼吸；
- **中心辉点**：周期性缩放脉冲；
- **无障碍降级**：SVG 内加 `prefers-reduced-motion: reduce`，系统开启减少动画时所有运动停止。

## 实现方式
- 继续沿用 CSS `background-image` data URI，不引入 DOM `<svg>`，保持首页拖拽区修复有效。
- SVG 内部使用 `<style>` + CSS `@keyframes` 实现动画。
- `tools/gen-idle-bg.js` 增强：生成 base64 后自动写回 `src/renderer/style.css` 的 `.idle-tech-lines::before`。

## 验证
- lint:syntax 143/0
- lint:imports OK
- test:unit 111/111
- typecheck 0

## 提交
- 本地：`cc0c5c8`
- 远端（Contents API）：`src/renderer/style.css → c62189f`，`tools/gen-idle-bg.js → c7029a2`
