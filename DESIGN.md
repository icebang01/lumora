# Lumora — Design System

> 桌面媒体播放器（Electron + 渲染端 WebGL/mpv）的视觉规范。本文件从 `src/renderer/style.css`、`
> index.html` 与组件代码**逐行抽取真实令牌**，可作为 AI 生成一致 UI 的单一事实来源。
>
> 核心铁律：**播放器界面必须是暗色。** 这不是审美偏好而是功能要求——任何亮色元素都会在暗场
> 画面旁形成眩光，破坏观看时的瞳孔适应。mpv / VLC / PotPlayer 无一例外，我们也一样。

---

## 1. Visual Theme · 视觉主题

Lumora 的界面语言是 **「悬浮的暗色玻璃 + 青紫粉极光」**：

- **暗色为基底，玻璃为表面。** 所有覆盖层默认隐形（透明），需要时优雅浮出，永远不与画面争夺注意力。
- **品牌极光（aurora）** 来自 logo 的青→紫→粉渐变，以低透明度径向光斑洒在深空底色（`#0b0c12`）上，营造「夜空中的霓虹」氛围，而非扁平的纯黑。
- **手感来自一条曲线。** 全界面统一 `cubic-bezier(0.16, 1, 0.3, 1)`（ease-out-expo 变体）：起步快、收尾极缓，交互干脆又不突兀。
- **圆角即品牌。** 主窗口 24px 大圆角（CSS 裁剪，因 Windows 透明分层窗口下原生 `roundedCorners` 失效），所有全窗口覆盖层自裁圆角，形成悬浮卡片观感。

---

## 2. Color Palette · 调色板

### 2.1 品牌色（`:root`）

| Token | Value | 用途 |
|---|---|---|
| `--accent` | `#7c8cff` | 主强调（靛蓝） |
| `--accent-bright` | `#9aa5ff` | 强调高亮态 |
| `--accent-cyan` | `#6ee7ff` | 渐变起点（青）/ 进度条冷端 |
| `--accent-pink` | `#ff7ac6` | 渐变终点（粉） |
| `--accent-mid` | `#8b7bff` | 渐变中段（紫），区别于 `--accent` |
| `--like-color` | `#ff5d8f` | 收藏红心，区别于品牌粉 |
| `--accent-glow` | `rgba(124,140,255,0.45)` | 辉光/选中光晕 |

### 2.2 中性色阶 · 表面（暗色默认）

| Token | Value |
|---|---|
| `--surface-0` | `rgba(14,15,20,0.72)` |
| `--surface-1` | `rgba(22,24,32,0.86)` |
| `--surface-2` | `rgba(32,35,46,0.94)` |
| `--hairline` | `rgba(255,255,255,0.09)` |
| `--hairline-strong` | `rgba(255,255,255,0.16)` |

### 2.3 文本（暗色默认）

| Token | Value | 语义 |
|---|---|---|
| `--text-1` | `rgba(255,255,255,0.96)` | 主文 / 标题 |
| `--text-2` | `rgba(255,255,255,0.68)` | 次级文 |
| `--text-3` | `rgba(255,255,255,0.42)` | 辅助 / 占位 |

### 2.4 控件表面令牌（暗色默认）

| Token | Value |
|---|---|
| `--control-bg` | `rgba(255,255,255,0.06)` |
| `--control-bg-strong` | `rgba(255,255,255,0.12)` |
| `--hover-bg` | `rgba(255,255,255,0.12)` |
| `--fill-track` | `rgba(255,255,255,0.14)` |
| `--scroll-thumb` | `rgba(255,255,255,0.18)` |
| `--surface-sidebar` | `rgba(0,0,0,0.22)` |

### 2.5 亮色主题覆盖（`.light-surface` / `[data-theme="light"] #idle-screen`）

**仅作用于独立窗口（设置 / 许可证）与 idle 落地页**；播放覆盖层（OSC / 播放列表 / 弹幕 / 弹层）**一律保持暗色，绝不进入此作用域**。

| Token | Light Value |
|---|---|
| `--surface-0/1/2` | `rgba(255,255,255,0.72)` / `0.86` / `rgba(248,249,252,0.96)` |
| `--hairline` / `--hairline-strong` | `rgba(10,12,20,0.10)` / `0.16` |
| `--text-1/2/3` | `rgba(18,20,28,0.95)` / `0.64` / `0.50` |
| `--base-bg` | `#f4f5f8` |
| `--shadow-color` | `rgba(20,24,40,0.18)` |
| `--control-bg` / `--control-bg-strong` | `rgba(10,12,20,0.05)` / `0.08` |
| `--hover-bg` / `--fill-track` / `--scroll-thumb` | `rgba(10,12,20,0.07)` / `0.12` / `0.16` |

### 2.6 品牌渐变（主强调填充）

```css
/* 三色主渐变（进度条、主按钮、强调条） */
background: linear-gradient(135deg, #6ee7ff, #8b7bff 55%, #ff7ac6);
/* 两色变体（标签/徽标） */
background: linear-gradient(135deg, #6ee7ff, #7c8cff);
```

### 2.7 环境极光背景（idle / 中央舞台）

```css
background:
  radial-gradient(62% 52% at 50% 40%, rgba(124,140,255,.10), transparent 70%),
  radial-gradient(42% 40% at 18% 64%, rgba(110,231,255,.055), transparent 62%),
  radial-gradient(42% 40% at 82% 64%, rgba(255,122,198,.055), transparent 62%),
  #0b0c12;                                  /* idle 落地页底色 */
  /* 中央舞台用 linear-gradient(180deg, #131521, #0b0d16) 收尾 */
```

---

## 3. Typography · 排版

| Token | Value |
|---|---|
| `--font` | `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Hiragino Sans GB", system-ui, sans-serif` |
| `--font-mono` | `"SF Mono", "Cascadia Mono", "JetBrains Mono", Consolas, monospace` |

- **基准字号**：`13px`，`line-height` 默认约 `1.4`。
- **抗锯齿**：`-webkit-font-smoothing: antialiased`。
- **层级（非严格 token，按场景）**：标题 `15–18px / 600–700`；正文 `13px`；辅助/标签 `11–12px / var(--text-3)`；等宽（版本号、时间码、键位）用 `--font-mono`。
- **对齐**：音乐舞台标题/歌词默认左对齐；窄窗（≤720）堆叠时居中。

---

## 4. Components · 组件

所有组件遵循：**半透明表面 + 1px 内嵌描边（hairline）+ 品牌渐变强调 + ease-out-expo 过渡**。

### 4.1 按钮（`.tb-btn` / `.mc-btn` / `.set-action`）
- 基础：`background: var(--control-bg)`；hover：`var(--hover-bg)` + `color: var(--text-1)`；过渡 `background/color .15–.18s var(--ease)`。
- 主按钮（强调）：品牌三色渐变填充 + `box-shadow: 0 6px 16px rgba(139,123,255,.35)`；文字色 `#0b0d14`（深色，保证对比）。
- 图标按钮圆角为 `50%`（圆形），文字按钮 `border-radius: 999px`（胶囊）。

### 4.2 卡片 / 面板（`.confirm-card` / `#resume-card` / 设置卡）
- 表面：`var(--surface-2)`；描边 `inset 0 0 0 1px rgba(255,255,255,.12)`；投影 `0 14px 38px rgba(0,0,0,.42)`。
- 圆角：`--radius-l`(16px) 或 `--window-radius`(24px)。
- 入场动画：`pop-in .26–.28s var(--ease) both`（`scale(.95)→1` + 淡入）。

### 4.3 输入 / 选择 / 滑块（`.set-input` / `.set-select` / `.set-slider`）
- 背景 `var(--control-bg-strong)`；聚焦：`box-shadow: inset 0 0 0 2px #7c8cff, 0 0 14px rgba(124,140,255,.3)`。
- 下拉浮层（`.set-select-fly`）：`min-width:150px; max-width:320px;`；玻璃 `blur(28px) saturate(190%)`；`pop-in .14s`。
- 滑块轨道 `var(--fill-track)`，已填充段用品牌渐变。

### 4.4 导航 / 侧栏
- 设置侧栏：竖向 `var(--surface-sidebar)`；≤640px 退化为顶部横排标签（`flex-direction:row; overflow-x:auto`）。
- 播放列表 / 侧 rail：`--playlist-panel-w: min(380px, 85vw)`。

### 4.5 弹层 / 浮窗（OSD、Toast、对话）
- 通用浮窗：`backdrop-filter: blur(28–30px) saturate(170–190%)`；`border-radius: var(--radius-l)`；`pop-in/fade-in`。
- 上下文菜单（`.ctx-menu`）：`min-width:200px; max-width:340px; max-height: min(62vh, calc(100vh - 8px))`；`z-index:60`。

### 4.6 OSC（屏幕控制器）
- 底部胶囊，高度 `--osc-h: 92px`；表面玻璃 `blur(22px) saturate(160%)`；`z-index:42`。
- 约 15 个控件 + 音量条；`#osc-inner` 内 `flex-wrap` 在中窄窗换行。

### 4.7 标题栏（Titlebar）
- 高度 `--titlebar-h: 34px`；`z-index:40`；整条为拖拽区（`-webkit-app-region: drag`）。
- **全屏 / 音乐模式下 `display:none`**；idle 模式下文字与按钮 `visibility:hidden`。

### 4.8 音乐舞台（Music Stage）
- 纯音频时的沉浸式界面（`#music-stage`，`z-index:20`），替代黑画面。
- **6 种样式变体**（经 `.style-{cover|lyrics|vinyl|square|glass|lyrics-min}` 切换）：大封面居中 / 歌词优先 / 旋转黑胶 / 方形极简 / 透明彩胶 / 纵向大圆角。
- **黑胶唱机**（`.style-vinyl` / `.style-glass`）：纯 CSS 方壳唱机——银色转盘 + 黑胶盘 + 唱臂（支点在右上角，`transform-origin` 校准落点），播放态 `animation: ms-vinyl-spin 9s linear infinite`。封面为独立子元素避免被底座 `display:none` 吞掉。
- 真实 FFT 频谱 Canvas 叠在封面底部（vinyl 样式下隐藏，保持清爽）。
- 歌词：Apple Music 风格逐字高亮，原文 + 翻译（译默认开），可 ±5s / ±0.5s 偏移 + 自动校准。

### 4.9 idle 落地页（Landing）
- 中央舞台 `grid-template-columns: 2fr 1fr 2fr`（音乐 / 品牌 / 视频三模块拼成同一窗口，靠 2px 渐变光束接缝区分，无独立面板、无悬浮阴影）。
- 整体为拖拽区；仅交互元素设 `no-drag`。

---

## 5. Layout · 布局

- **窗口圆角**：`--window-radius: 24px`（定义在 `body`），所有全窗口覆盖层自裁 `border-radius` + `overflow:hidden`，圆角外三角透出透明窗口 → 桌面，形成悬浮卡片。
- **间距体系**：无独立 spacing token，按场景用 `gap: 6 / 8 / 12 / 18 / 22 / 28px`；内边距常用 `10–18px`。
- **关键尺寸常量**：`--playlist-panel-w: min(380px,85vw)`（≤480 → `100vw`）；`--osc-h: 92px`；`--titlebar-h: 34px`。
- **层级（z-index）**——严格不可颠倒：

  | Layer | z-index | 元素 |
  |---|---|---|
  | 视频画布 | 0 | `#video-canvas`（ffmpeg WebGL）/ mpv HWND 透出层 |
  | 视频空态底 | 1 | `#video-idle-bg` |
  | 弹幕 | 5 | `#danmaku-canvas` |
  | 字幕 | 6 | `#subtitle-overlay(-2)` |
  | 音乐舞台 | 20 | `#music-stage` |
  | idle 落地页 | 30 | `#idle-screen` |
  | 标题栏 | 40 | `#titlebar` |
  | OSC | 42 | `#osc` |
  | 上下文菜单 | 60 | `.ctx-menu` |
  | 下拉浮层 | 70 | `.set-select-fly` |
  | 拖放遮罩 | 200 | `#drag-overlay` |

- **渲染架构**：mpv 视频经 `--wid` 在窗口 HWND 内渲染，HTML 层透明，画面从底下透上来；ffmpeg 视频由渲染端 WebGL2 直接绘到 `#video-canvas`。两者都不依赖额外的 DOM 包裹层（避免破坏 `-webkit-app-region` 拖拽）。

---

## 6. Depth · 深度（玻璃 / 阴影 / 抬升）

- **玻璃（backdrop-filter）取值谱系**：`4px`（极轻）→ `8px`（拖放遮罩）→ `14–18px`（小元件）→ `20px`（resume 卡）→ `22px`（OSC，标准）→ `28px`（设置/菜单）→ `30px`（Toast/弹层）。常配 `saturate(140–190%)`。**标准覆盖层 = `blur(22px) saturate(160%)`。**
- **抬升阴影**：`0 14px 38px rgba(0,0,0,.42)` + `inset 0 0 0 1px rgba(255,255,255,.12)`。
- **聚焦环**：`0 0 0 2px rgba(124,140,255,.85), 0 0 38px rgba(124,140,255,.35)`（或 inset 版 `inset 0 0 0 2px #7c8cff, 0 0 14px ...`）。
- **idle 屏幕专用**：仅内嵌阴影 `inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 0 60px rgba(124,140,255,0.04)`，**故意不加外投影**——全窗口圆角层加外投影会把圆角四角染黑（曾踩坑，已移除）。
- **滚动性能红线**：滚动时避免昂贵的外 `box-shadow` 重绘；只保留 inset 描边（如播放列表 hover）。
- **环境光深度**：大面积低透明度径向渐变（见 2.7）模拟夜空极光，而非用实色块分层。

---

## 7. Guidelines & Anti-patterns · 规范禁忌

**DO ✅**
- 播放相关覆盖层永远暗色；亮色仅限独立设置/许可证窗口与 idle 落地页。
- 用 CSS 变量（token）而非硬编码颜色；新增颜色先问是否已有 token。
- 过渡统一 `var(--ease)`；入场用 `pop-in` / `fade-in` / `fade-up`。
- 全窗口圆角层自裁 `border-radius` + `overflow:hidden`，配合 `inset` 白边勾轮廓。
- 拖拽区语义：父层设 `drag`，仅按钮/输入/链接设 `no-drag`。
- 尊重 `prefers-reduced-motion: reduce`（全局把动画/过渡压到 `.01ms`）。

**DON'T ❌**
- ❌ 让播放 UI 进入亮色主题（眩光破坏瞳孔适应）。
- ❌ 给铺满窗口的圆角覆盖层加**外投影**——圆角四角会发黑。
- ❌ 在滚动容器中保留昂贵的外 `box-shadow`，引发掉帧。
- ❌ 用纯色实块分层制造「深度感」；用玻璃 + 极光径向渐变。
- ❌ 依赖原生窗口圆角（Windows 透明分层窗口下失效）；必须用 CSS 裁剪。
- ❌ 在非交互大块上设 `no-drag` 挖空父级拖拽区，导致整窗无法拖动。
- ❌ 硬编码字体栈；始终 `var(--font)` / `var(--font-mono)`。

---

## 8. Responsive · 响应式

统一断点（`@media`），从宽到窄逐级收敛：

| 断点 | 行为 |
|---|---|
| `≤900px` | OSC：隐藏数字时间读数 + 弹性 spacer，控件 `flex-wrap` 居中（解决 480–900 溢出） |
| `≤860px` | idle 舞台：三列 `2fr 1fr 2fr` → 单列 `1fr` 垂直堆叠，隐藏 `.idle-stage-bg` |
| `≤720px` 或 `≤560px`（高） | 音乐舞台：双栏 → 上下堆叠；glass 样式唱机取消绝对定位、置于文字上方并旋转 |
| `≤640px` | 设置侧栏 → 顶部横排标签；keymap 单列；stats 占满；AI/播放列表打开时隐藏侧 rail；OSC 收窄内边距；字幕/弹幕工具条换行 |
| `≤480px` | 隐藏弹幕按钮 + 分隔线；播放列表面板 `100vw`；idle 进一步收敛（卡片 `22px` 圆角、环 `100px`） |
| `≤420px`（高） | OSC 顶部留白收紧；隐藏 `.aside-shorts` |
| `prefers-reduced-motion` | 全部动画/过渡 `.01ms`，仅保留最终态 |

- 浮窗宽度惯例：`min(<设计宽>px, <视口占比>vw)` 且 `max-width: calc(100vw - 40px)`，杜绝贴边/溢出（如 EQ 面板、stats、cast、AI、弹幕搜索等）。

---

## 9. AI Prompt Guide · AI 提示指南

让 AI（或协作者）生成与 Lumora 一致的 UI 时，请植入以下约束：

1. **暗色优先**：「所有播放器覆盖层使用暗色令牌（`--surface-1/2`、`--text-1/2/3`），不要切换亮色主题；亮色仅用于独立设置窗口并加 `.light-surface` 类。」
2. **用 token，不硬编码**：「颜色一律引用 `:root` 变量（`--accent`、`--surface-2`、`--text-2`…），品牌强调用 `linear-gradient(135deg,#6ee7ff,#8b7bff 55%,#ff7ac6)`。」
3. **玻璃 + 饱和**：「浮层用 `backdrop-filter: blur(22px) saturate(160%)` + `inset 0 0 0 1px rgba(255,255,255,.12)` 描边，不要纯色实块。」
4. **手感曲线**：「所有 `transition`/`animation` 的缓动用 `var(--ease)`（cubic-bezier(0.16,1,0.3,1)），入场动画套 `pop-in` / `fade-in`。」
5. **圆角与层级**：「全窗口层自裁 `border-radius: var(--window-radius)`（`24px`）且 `overflow:hidden`；按第 5 章 z-index 表摆放层级，不要颠倒。」
6. **禁止外投影**：「铺满窗口的圆角覆盖层只加 inset 描边，禁止外 `box-shadow`（会染黑圆角）。」
7. **响应式**：「用第 8 章断点收敛；浮窗宽度用 `min(Xpx, Yvw)` + `max-width: calc(100vw - 40px)`。」
8. **字体**：「始终 `font-family: var(--font)`，等宽文本用 `var(--font-mono)`，基准 13px。」

> 任何偏离上述令牌的新颜色/圆角/阴影，都应在 PR 中说明意图，并优先沉淀为新的 `:root` 变量。
