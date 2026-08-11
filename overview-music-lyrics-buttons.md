# 音乐模式歌词/按钮修复（c25db47）

## 修改文件
- `src/renderer/style.css`
- `src/renderer/ui/music-stage.js`

## 三个问题 → 修复方案

### 1. 高亮歌词放大不够（用户要≈2倍）
- `.ms-lyric-line.active` 放大 `scale(1.18) → scale(1.9)`（约翻倍，避开 `scale(2)` 长句横向裁切），保留 `font-weight:700` + 辉光。

### 2. 已唱歌词上色「不丝滑」
- 根因不是采样频率（mpv `time-pos` 逐帧推送已够频繁），而是**逐字离散点亮 + 尾随过渡**的台阶感。
- 改为**整行连续渐变擦除**：
  - CSS 弃用 `.ms-lyric-char.sung` 离散上色，改 `.ms-lyric-line.lit` 整行 `background-clip:text` 青→紫→粉渐变，靠 `--prog`(0~1) 的硬 stops 表达亮/暗分界 → 连续扫光。
  - JS 新增 `_startLyricRAF/_stopLyricRAF`：在两次 `time-pos` 采样之间按墙钟时间 + 倍速线性插值推进 active 行 `--prog`，采样间隔再大也丝滑；暂停冻结并重置基准防恢复跳变。

### 3. 右上角最小/关闭按钮「还是没有」
- 经核查规则 `body.audio-mode .ms-win-btn{opacity:1}` 与按钮绑定（minimize/close → `windowCommand`）早已正确，属**视觉太弱**（透明底+暗图标在封面/渐变背景上不可见）。
- 改为毛玻璃常驻：`background:rgba(18,20,38,.55)` + `backdrop-filter:blur(10px)` + 实色图标 + 描边阴影，任意背景清晰可辨。
- ⚠️ 若仍看不到，几乎确定是跑了旧构建：请**硬刷新 / 重新 build 启动**再测。

## 验证
syntax 126/0 · imports clean · reverse-leaks pass · unit 74/74 · pre-commit 4/4 ✓
推送：`git push --force-with-lease`（897d0a7…c25db47 forced update），远端 tip `c25db47`，`HEAD…origin/main = 0 0`。
