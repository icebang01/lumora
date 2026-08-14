# Lumora — Design System

> 桌面媒体播放器（Electron + 渲染端 WebGL/mpv）的视觉规范。本文件从 `src/renderer/style.css`、
> `index.html` 与组件代码**逐行抽取真实令牌**，可作为 AI 生成一致 UI 的单一事实来源。
>
> 核心铁律：**播放器界面必须是暗色。** 这不是审美偏好而是功能要求——任何亮色元素都会在暗场
> 画面旁形成眩光，破坏观看时的瞳孔适应。mpv / VLC / PotPlayer 无一例外，我们也一样。

---

## 1. Visual Theme & Atmosphere · 视觉主题与氛围

- **设计哲学**：播放器界面是「暗场工具」，所有覆盖层默认隐形（透明），需要时优雅浮出，永远不与画面争夺注意力。
- **视觉基调**：暗色玻璃 + 夜空极光——深空底色（`#0b0c12`）上洒以低透明度青/紫/粉径向光斑，而非扁平纯黑。
- **核心视觉特征**：`悬浮玻璃` · `青紫粉极光` · `大圆角卡片` · `极简暗层` · `霓虹强调`
- **光影与质感**：毛玻璃（`backdrop-filter: blur() saturate()`）为主，抬升靠「内嵌 1px 白边 + 柔和外投影」；全窗口圆角层**只用内嵌阴影，禁止外投影**（外投影会把圆角四角染黑）。

---

## 2. Color Palette & Roles · 调色板与角色

### 2.1 Primary / Brand（主色与品牌色）

| Role | Token | HEX / rgba | 使用场景 |
|---|---|---|---|
| 主强调 | `--accent` | `#7c8cff` | 聚焦环、激活态、强调条 |
| 强调高亮 | `--accent-bright` | `#9aa5ff` | hover / 高亮态 |
| 渐变青 | `--accent-cyan` | `#6ee7ff` | 渐变起点、进度条冷端 |
| 渐变紫 | `--accent-mid` | `#8b7bff` | 渐变中段（区别于 `--accent`） |
| 渐变粉 | `--accent-pink` | `#ff7ac6` | 渐变终点 |
| 收藏红心 | `--like-color` | `#ff5d8f` | 红心 / 我喜欢 |
| 辉光 | `--accent-glow` | `rgba(124,140,255,0.45)` | 聚焦 / 选中光晕 |

### 2.2 Brand & Dark（品牌渐变与暗色表面）

```css
/* 三色主渐变（进度条 / 主按钮 / 强调条） */
background: linear-gradient(135deg, #6ee7ff, #8b7bff 55%, #ff7ac6);
/* 两色变体（标签 / 徽标） */
background: linear-gradient(135deg, #6ee7ff, #7c8cff);
```

| Role | Token | Value |
|---|---|---|
| 表面 0（轻浮层） | `--surface-0` | `rgba(14,15,20,0.72)` |
| 表面 1（面板） | `--surface-1` | `rgba(22,24,32,0.86)` |
| 表面 2（卡片/输入） | `--surface-2` | `rgba(32,35,46,0.94)` |
| 发丝边 | `--hairline` | `rgba(255,255,255,0.09)` |
| 强发丝边 | `--hairline-strong` | `rgba(255,255,255,0.16)` |

### 2.3 Neutral / Text（中性文本，暗色默认）

| Role | Token | Value |
|---|---|---|
| 主文 / 标题 | `--text-1` | `rgba(255,255,255,0.96)` |
| 次级文 | `--text-2` | `rgba(255,255,255,0.68)` |
| 辅助 / 占位 | `--text-3` | `rgba(255,255,255,0.42)` |

### 2.4 Control Surfaces（控件表面，暗色默认）

| Role | Token | Value |
|---|---|---|
| 控件底 | `--control-bg` | `rgba(255,255,255,0.06)` |
| 控件底（强） | `--control-bg-strong` | `rgba(255,255,255,0.12)` |
| 悬停底 | `--hover-bg` | `rgba(255,255,255,0.12)` |
| 进度轨 | `--fill-track` | `rgba(255,255,255,0.14)` |
| 滚动条 | `--scroll-thumb` | `rgba(255,255,255,0.18)` |
| 侧栏底 | `--surface-sidebar` | `rgba(0,0,0,0.22)` |

### 2.5 Semantic Colors（语义色：成功 / 警告 / 错误 / 信息）

> Lumora 无独立 success/info token；状态靠「暗红=错误、琥珀=警告、品牌色=信息/进行中」表达。

| Role | HEX | 使用场景 |
|---|---|---|
| 错误 / Error | `#ff8585`（文字） / `#e5484d`（实心按钮/指示条） | 更新失败、网络错误、冲突条 |
| 危险 / Danger | `#ff8a8e`（文字） / `#ff5e5e`·`#ffadad`（渐变填充） | 删除/断开操作的确认按钮 |
| 警告 / Warning | `#ffb454`（琥珀） | idle 警告、键位冲突、AI 离线徽标 |
| 信息 / Info | `--accent-cyan` `#6ee7ff` | 进行中、连接态（无独立 token，借品牌青） |

### 2.6 Shadow Colors（阴影色）

| Role | rgba | 使用场景 |
|---|---|---|
| 暗投影 | `rgba(0,0,0,.42)` | 标准抬升卡 |
| 深投影 | `rgba(0,0,0,.55~.72)` | 模态 / 浮层 |
| 内嵌白边 | `rgba(255,255,255,.12)` | 所有浮层描边 |
| 品牌辉光 | `rgba(124,140,255,.3~.44)` | 强调卡 / 焦点 |

### 2.7 Light Theme Overrides（`.light-surface` / `[data-theme="light"] #idle-screen`）

**仅作用于独立窗口（设置 / 许可证）与 idle 落地页**；播放覆盖层（OSC / 播放列表 / 书签 / 弹幕 / 弹层 / **投屏面板**）**一律保持暗色**（投屏面板 `rgba(12,13,18,.94)` 硬编暗玻璃，不进 `.light-surface` 作用域）。

| Token | Light Value |
|---|---|
| `--surface-0/1/2` | `rgba(255,255,255,0.72)` / `0.86` / `rgba(248,249,252,0.96)` |
| `--hairline` / `--hairline-strong` | `rgba(10,12,20,0.10)` / `0.16` |
| `--text-1/2/3` | `rgba(18,20,28,0.95)` / `0.64` / `0.50` |
| `--base-bg` | `#f4f5f8` |
| `--shadow-color` | `rgba(20,24,40,0.18)` |
| `--control-bg` / `--control-bg-strong` | `rgba(10,12,20,0.05)` / `0.08` |
| `--hover-bg` / `--fill-track` / `--scroll-thumb` | `rgba(10,12,20,0.07)` / `0.12` / `0.16` |

### 2.8 Ambient Aurora（环境极光背景，idle / 中央舞台）

```css
background:
  radial-gradient(62% 52% at 50% 40%, rgba(124,140,255,.10), transparent 70%),
  radial-gradient(42% 40% at 18% 64%, rgba(110,231,255,.055), transparent 62%),
  radial-gradient(42% 40% at 82% 64%, rgba(255,122,198,.055), transparent 62%),
  #0b0c12;                                  /* idle 落地页底色 */
  /* 中央舞台收尾用 linear-gradient(180deg, #131521, #0b0d16) */
```

---

## 3. Typography Rules · 排版规则

- **Font Family**：`--font` = `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Hiragino Sans GB", system-ui, sans-serif`；等宽 `--font-mono` = `"SF Mono", "Cascadia Mono", "JetBrains Mono", Consolas, monospace`。
- **基准**：`font-size: 13px`，`-webkit-font-smoothing: antialiased`，行高约 `1.4`。
- **设计哲学**：字号以 **px 固定阶梯**为主（非 fluid rem），保证跨分辨率一致；层级靠字号 + 字重（400 正文 / 600–700 标题）+ 文字色透明度（text-1/2/3）三轴区分，而非堆砌边框。等宽仅用于版本号、时间码、键位。

### Type Scale（从 Display Hero → Nano）

| Name | Size | Weight | Line-Height | Letter-Spacing | 用途 |
|---|---|---|---|---|---|
| Display Hero | 42–60px | 700 | 1.0 | -0.02em | idle 品牌字标、大数字 |
| Title L | 24–26px | 600 | 1.1 | -0.01em | 面板主标题 |
| Title M | 18–20px | 600 | 1.2 | 0 | 区块标题、歌词标题 |
| Title S | 15–16px | 600 | 1.3 | 0 | 卡片标题、控制条曲名 |
| Body L | 14px | 400 | 1.45 | 0 | 正文、设置描述 |
| Body | 13px | 400 | 1.45 | 0 | **基准正文** |
| Caption | 12px | 400 | 1.4 | 0 | 次级说明（text-2） |
| Caption S | 11px | 400 | 1.35 | 0 | 标签、时间戳（text-3） |
| Nano | 9–10px | 500 | 1.3 | 0 | 徽标、极细注脚（text-3） |

---

## 4. Component Stylings · 组件样式

所有组件遵循：**半透明表面 + 1px 内嵌描边（hairline）+ 品牌渐变强调 + ease-out-expo 过渡**。

### 4.1 Buttons（按钮）

| Variant | 背景 | 文字 | 边框 / 圆角 | Hover |
|---|---|---|---|---|
| **Primary**（强调） | `linear-gradient(135deg,#6ee7ff,#8b7bff 55%,#ff7ac6)` | `#0b0d14` | `radius 8–12px` | `filter/.14s` 提亮 |
| **Secondary**（默认） | `var(--control-bg)` | `var(--text-1)` | `inset 0 0 0 1px hairline` | `var(--hover-bg)` |
| **Ghost** | 透明 | `var(--text-2)` | 无 | `var(--hover-bg)` + text-1 |
| **Danger** | `rgba(229,72,77,.16)`（hover） | `#ff8a8e` / `#e5484d` | `border 1px rgba(229,72,77,.4)` | `rgba(255,80,80,.2)` |

- 图标按钮圆角 `50%`（圆形）；文字按钮 `border-radius: 999px`（胶囊）；过渡 `background/color .15–.18s var(--ease)`。

### 4.2 Cards / Panels（卡片 / 面板）

```css
background: var(--surface-2);
border-radius: var(--radius-l);            /* 16px，或 --window-radius 24px */
box-shadow: 0 14px 38px rgba(0,0,0,.42), inset 0 0 0 1px rgba(124,140,255,.12);
/* 入场：pop-in .26–.28s var(--ease) both  (scale .95→1 + 淡入) */
```

### 4.3 Inputs / Select / Slider（输入）

- 背景 `var(--control-bg-strong)`；**聚焦**：`border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow)`（无 outline）。
- 下拉浮层（`.set-select-fly`）：`min-width:150px; max-width:320px;`；玻璃 `blur(28px) saturate(190%)`；`pop-in .14s`。
- 滑块轨道 `var(--fill-track)`，已填充段用品牌渐变。

### 4.4 Navigation / Sidebar（导航 / 侧栏）

- 设置侧栏：竖向 `var(--surface-sidebar)`；**≤640px 退化为顶部横排标签**（`flex-direction:row; overflow-x:auto`）。
- 播放列表 / 侧 rail：`--playlist-panel-w: min(380px, 85vw)`。
- 标题栏（Titlebar）：高 `--titlebar-h:34px`，整条拖拽区；**全屏 / 音乐模式 `display:none`**。

### 4.5 Badges / Tags（徽标 / 标签）

- 状态徽标（如 AI off）：`color:#ffb454; border:1px rgba(255,180,84,.35); background:rgba(255,180,84,.10)`；圆角 `999px`；字号 11–12px。
- 质量徽标（分辨率/HDR/杜比）：`max-width: calc(100vw - 24px)`，窄窗自收敛。

### 4.6 Modals / Dialogs（模态 / 对话）

- 遮罩（`.settings-backdrop` 等）：`position:fixed; inset:0; background: rgba(0,0,0,.5~.55)`；内容卡 `blur(28px) saturate(170%)` + `0 18px 52px rgba(0,0,0,.68), 0 0 0 1px rgba(0,0,0,.35)`；`pop-in .26s`；`z-index:50+`。
- 上下文菜单（`.ctx-menu`）：`min-width:200px; max-width:340px; max-height: min(62vh, calc(100vh - 8px))`；`z-index:60`。

### 4.7 OSC（屏幕控制器）

- 底部胶囊，高 `--osc-h:92px`；玻璃 `blur(22px) saturate(160%)`；`z-index:42`；约 15 控件，中窄窗 `flex-wrap` 居中。

### 4.8 Music Stage（音乐舞台）

- 纯音频沉浸式界面（`#music-stage`，`z-index:20`），**6 种样式变体**（`.style-{cover|lyrics|vinyl|square|glass|lyrics-min}`）：大封面居中 / 歌词优先 / 旋转黑胶 / 方形极简 / 透明彩胶 / 纵向大圆角。
- **黑胶唱机**（vinyl/glass）：纯 CSS 方壳——银色转盘 + 黑胶盘 + 唱臂（支点右上角，`transform-origin` 校准落点），播放态 `ms-vinyl-spin 9s linear infinite`。封面为独立子元素避免被底座 `display:none` 吞掉。
- 真实 FFT 频谱 Canvas 叠封面底部（vinyl 隐藏）；歌词 Apple Music 风格逐字高亮（原文 + 翻译可关，±5s/±0.5s 偏移 + 自动校准）。

### 4.9 Idle Landing（落地页）

- 中央舞台 `grid-template-columns: 2fr 1fr 2fr`（音乐 / 品牌 / 视频三模块拼同一窗口，靠 2px 渐变光束接缝区分，无独立面板、无悬浮阴影）；整体拖拽区，仅交互元素 `no-drag`。

### 4.10 Cast Panel（投屏面板）· v2 = DLNA + Chromecast + DIAL

> 真实结构见 `index.html:#cast-panel` + `style.css:3692–3812` + `panels/cast.js`。居中玻璃浮层，`z-index:50`，**恒为暗色**（不随 app 主题切换，与 §2.7 亮色作用域互斥）。

- **遮罩** `.cast-backdrop`：`position:absolute; inset:0; background:rgba(0,0,0,.45)`；`fade-in .2s`。
- **窗口** `.cast-window`：`width:min(420px,90vw); max-width:calc(100vw - 40px); max-height:calc(100vh - 60px)`；`background:rgba(12,13,18,.94)`；`backdrop-filter:blur(30px) saturate(180%)`；`border:1px solid var(--hairline-strong)`；`border-radius:var(--radius-l)`；`box-shadow:0 26px 70px rgba(0,0,0,.72)`；`pop-in .26s`；`pointer-events:auto`。
- **头部** `.panel-head.draggable`：「投屏到设备」+ `.playlist-close`（26×26，`hover`→`#e5484d`）；`border-bottom:1px hairline`。
- **状态条** `.cast-status`：`padding:10px 16px; font-size:12px; color:var(--text-3)`；连接态 `.connected`→`color:#7ee0a8`（绿，实时显示 `设备名 · 状态 · 进度/时长`）。
- **设备行** `.cast-device`：`display:flex; gap:12px; padding:10px 12px; border-radius:11px`；连接态 `.connected`→`box-shadow:inset 2px 0 0 var(--accent-mid); background:rgba(124,140,255,.10)`。
  - 名称 `.cast-device-name`：`font-size:13px; color:var(--text-1)`；型号 `.cast-device-model`：`font-size:11px; color:var(--text-3)`。
  - **类型徽章** `.cast-device-type`（圆角 `999px`，`font-size:10px`，`padding:2px 7px`）——三协议配色：
    | 协议 | class | 文字色 | 边框 | 背景 |
    |---|---|---|---|---|
    | DLNA | `.type-dlna` | `#7fd0a8` | `rgba(127,208,168,.45)` | `rgba(127,208,168,.10)` |
    | Chromecast | `.type-chromecast` | `#f4b400` | `rgba(244,180,0,.5)` | `rgba(244,180,0,.10)` |
    | **DIAL** | `.type-dial` | `#8ab4ff` | `rgba(138,180,255,.45)` | `rgba(138,180,255,.10)` |
    > DIAL 为 v2 新增协议（SSDP `ST=urn:dial-multiscreen-org:service:dial:1`），仅能 launch 应用自身拉取 URL，无通用 pause/seek/volume；类型徽章 `#8ab4ff` 蓝与 Chromecast 金黄、DLNA 绿区分。
  - **连接按钮** `.cast-connect-btn`：`padding:6px 14px; border:1px solid rgba(124,140,255,.4); border-radius:9px; background:rgba(124,140,255,.12); color:#dfe2ff`；`hover:not(:disabled)`→`background:rgba(124,140,255,.24)`；已连接→`disabled`（`opacity:.5`）。
- **控制区** `#cast-controls`（连接后显示，`border-top:1px hairline; padding:12px 14px; gap:12px`）：
  - 主操作 `.cast-action-btn.primary`：「投屏当前内容」→`linear-gradient(90deg,rgba(124,140,255,.32),rgba(110,231,255,.22)); border-color:rgba(124,140,255,.5); color:#fff`。
  - 串流行 `.cast-url-row` + `.cast-url-input`（聚焦 `border-color:var(--accent)`）+「投屏」按钮。
  - 传输网格 `.cast-transport`：`grid-template-columns:repeat(4,1fr); gap:7px`；`.cast-tbtn`：暂停 / 继续 / 停止 / 同步进度。
  - 电视音量 `.cast-vol-row` + `.cast-vol`（`accent-color:var(--accent)`）+ 数值 `.cast-vol-val`（`tabular-nums`）。
  - 断开 `.cast-action-btn.danger`：「断开连接」→`border-color:rgba(229,72,77,.4); color:#ff8a8e; hover:rgba(229,72,77,.16)`。

---

## 5. Layout Principles · 布局原则

- **Spacing System（间距基数）**：以 **4px** 为最小单位、8px 为常用步长；实际 `gap` 取值 `2 / 4 / 6 / 8 / 10 / 12 / 18 / 22 / 28px`，内边距常用 `10–18px`。无独立 spacing token，按场景就近取 4 的倍数。
- **Grid System**：idle 中央舞台 `2fr 1fr 2fr` 三列等比；设置 `侧栏 + 内容` 两栏（窄窗转上下）；音乐舞台双栏（窄窗转堆叠）。
- **Container / Max-width**：播放列表面板 `min(380px,85vw)`（≤480→`100vw`）；设置窗口 `92vw × calc(100vh - 40px)`；浮窗通用 `min(<设计宽>px, <vw>%)` + `max-width: calc(100vw - 40px)`，杜绝贴边。
- **Section Spacing**：区块间 `gap: 18–28px`；卡片内 `padding: 14–18px`。
- **留白哲学**：暗场工具重「呼吸感」——覆盖层浮出时四周留透明边，靠圆角 + 玻璃与画面分隔，而非实色块挤压。

---

## 6. Depth & Elevation · 深度与层级

### 6.1 Shadow System（命名阴影，从代码实测值归纳）

| Name | box-shadow | 用途 |
|---|---|---|
| `shadow-xs` | `0 1px 3px rgba(0,0,0,.3)` | 细发丝层（标签/小件） |
| `shadow-s` | `0 2px 8px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.14)` | 工具提示 / 悬浮小卡 |
| `shadow-m` | `0 14px 38px rgba(0,0,0,.42), inset 0 0 0 1px rgba(124,140,255,.12)` | **标准抬升卡** |
| `shadow-l` | `0 18px 52px rgba(0,0,0,.68), 0 0 0 1px rgba(0,0,0,.35)` | 模态 / 大浮层 |
| `shadow-xl` | `0 26px 70px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.04)` | 全屏级浮层 |
| `shadow-glow` | `0 6px 18px rgba(139,123,255,.4)` | 品牌强调卡 |
| `focus-ring` | `0 0 0 3px var(--accent-glow)` | 输入 / 控件聚焦 |

### 6.2 Surface Layers（表面层级）

`透明画布(0)` → `surface-0(轻浮层)` → `surface-1(面板)` → `surface-2(卡片/输入)` → `elevated(模态/浮层)` → `overlay(拖放遮罩 200)`。

### 6.3 Z-index Scale（层级数值）

| Layer | z-index | 元素 |
|---|---|---|
| 视频画布 | 0 | `#video-canvas` / mpv HWND 透出 |
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

### 6.4 Backdrop Effects（毛玻璃）

`blur()` 取值谱系 `4 → 8 → 14 → 18 → 20 → 22 → 28 → 30px`，常配 `saturate(140–190%)`。**标准覆盖层 = `blur(22px) saturate(160%)`**；设置/菜单 `28px`；Toast/弹层 `30px`；拖放遮罩 `8px`。

---

## 7. Do's and Don'ts · 设计规范与禁忌

**DO ✅**
1. 播放相关覆盖层永远暗色；亮色仅限独立设置/许可证窗口与 idle 落地页（加 `.light-surface`）。
2. 用 CSS 变量（token）而非硬编码颜色；新增颜色先问是否已有 token。
3. 过渡统一 `var(--ease)`；入场套 `pop-in` / `fade-in` / `fade-up`。
4. 全窗口圆角层自裁 `border-radius` + `overflow:hidden`，配 inset 白边勾轮廓。
5. 拖拽区语义：父层设 `drag`，仅按钮/输入/链接设 `no-drag`。
6. 尊重 `prefers-reduced-motion: reduce`（全局动画/过渡压到 `.01ms`）。
7. 状态色用语义色表（错误暗红 / 警告琥珀 / 信息借品牌青）。

**DON'T ❌**
1. ❌ 让播放 UI 进入亮色主题（眩光破坏瞳孔适应）。
2. ❌ 给铺满窗口的圆角覆盖层加**外投影**——圆角四角会发黑（idle 已踩坑移除）。
3. ❌ 在滚动容器保留昂贵的外 `box-shadow`，引发掉帧（只留 inset 描边）。
4. ❌ 用纯色实块分层制造「深度感」；用玻璃 + 极光径向渐变。
5. ❌ 依赖原生窗口圆角（Windows 透明分层窗口下失效）；必须 CSS 裁剪。
6. ❌ 在非交互大块设 `no-drag` 挖空父级拖拽区，导致整窗无法拖动。
7. ❌ 硬编码字体栈；始终 `var(--font)` / `var(--font-mono)`。

---

## 8. Responsive Behavior · 响应式行为

### 8.1 Breakpoints（断点）

| 设备 | 断点 | 行为 |
|---|---|---|
| Wide / Desktop | `>900px` | 全功能 OSC（单行）、idle 三列、设置侧栏竖排 |
| Tablet / 中窄 | `≤900px` | OSC：隐藏数字时间 + spacer，控件 `flex-wrap` 居中 |
| `≤860px` | idle 舞台三列 → 单列垂直堆叠，隐藏 `.idle-stage-bg` |
| `≤720px` 或 `≤560px`（高） | 音乐舞台双栏 → 上下堆叠；glass 唱机取消绝对定位置于文字上方 |
| Mobile | `≤640px` | 设置侧栏→顶部横排标签；keymap 单列；stats 占满；AI/播放列表开时隐藏侧 rail；OSC 收窄内边距；字幕/弹幕工具条换行 |
| `≤480px` | 隐藏弹幕按钮 + 分隔线；播放列表面板 `100vw`；idle 进一步收敛 |
| Short | `≤420px`（高） | OSC 顶部留白收紧；隐藏 `.aside-shorts` |
| Motion | `prefers-reduced-motion` | 全部动画/过渡 `.01ms` |

### 8.2 Touch Targets（触摸目标）

- 图标按钮最小 `22–34px`（音乐迷你控制 `22px`、通用图标 `34px`）；主控制条控件宽 `≥34px`、高 `≥34px`。
- 上下文菜单项 / 浮层最小宽 `200px`；列表项点击区纵向 `≥32px`。
- 桌面优先（非触屏），以上为窄窗 / 触控屏下限参考。

### 8.3 Collapse Strategy（折叠策略）

宽→窄逐级收敛：单行控件 → 隐藏次要读数 + 换行 → 侧栏转顶部标签 → 双栏转堆叠 → 面板占满视口。浮窗宽度 `min(Xpx, Yvw)` + `max-width: calc(100vw - 40px)` 防溢出。

### 8.4 Font Scaling（字体缩放）

字号以 **px 固定阶梯**（见 §3 Type Scale），不随视口 fluid 缩放；窄窗靠「容器收窄 + 控件换行」而非缩字。歌词/曲名在窄窗可下移或隐藏（`mc-track-info` 在 ≤560 隐藏）。`prefers-reduced-motion` 下仅压动画，不改字号。

---

## 9. Agent Prompt Guide · AI 代理提示指南

### 9.1 Quick Reference（快速参考）

- 暗色优先；亮色仅 `.light-surface` 独立窗口。
- 颜色全用 `:root` token；品牌强调 `linear-gradient(135deg,#6ee7ff,#8b7bff 55%,#ff7ac6)`。
- 玻璃 `blur(22px) saturate(160%)` + `inset 0 0 0 1px rgba(255,255,255,.12)`；**禁外投影**于圆角全窗口层。
- 缓动 `var(--ease)`；圆角 `24px` 自裁；z-index 按 §6.3。
- 字体 `var(--font)` 基准 13px；状态用语义色（§2.5）。

### 9.2 Component Prompts（可直接复制的组件生成 Prompt）

1. **主按钮**：「生成一个 Lumora 主按钮：背景 `linear-gradient(135deg,#6ee7ff,#8b7bff 55%,#ff7ac6)`，文字 `#0b0d14`，圆角 10px，hover 提亮 + `transition .14s var(--ease)`，按下微缩 `scale(.97)`。」
2. **玻璃卡片**：「做一个浮层卡片：表面 `var(--surface-2)`，`border-radius:16px`，`backdrop-filter: blur(22px) saturate(160%)`，`box-shadow: 0 14px 38px rgba(0,0,0,.42), inset 0 0 0 1px rgba(124,140,255,.12)`，入场 `pop-in .26s var(--ease)`。」
3. **文本输入**：「写一个输入框：背景 `var(--control-bg-strong)`，圆角 8px，聚焦 `border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-glow)`，无 outline，过渡 `border-color/box-shadow .14s var(--ease)`。」
4. **危险按钮**：「做一个 Danger 按钮：默认透明文字 `#ff8a8e`、边框 `1px rgba(229,72,77,.4)`，hover `background:rgba(255,80,80,.2)`，圆角 8px。」
5. **状态徽标**：「生成一个状态徽标：文字 `#ffb454`，边框 `1px rgba(255,180,84,.35)`，背景 `rgba(255,180,84,.10)`，圆角 999px，字号 11px，padding `4px 10px`。」
6. **模态遮罩**：「做一个模态：遮罩 `fixed inset:0; background:rgba(0,0,0,.55)`，内容卡 `blur(28px) saturate(170%)` + `0 18px 52px rgba(0,0,0,.68), 0 0 0 1px rgba(0,0,0,.35)`，`pop-in .26s`，`z-index:50`。」
7. **投屏面板**：「做一个投屏面板浮层：`z-index:50`；遮罩 `rgba(0,0,0,.45)`；窗口 `width:min(420px,90vw); background:rgba(12,13,18,.94); backdrop-filter:blur(30px) saturate(180%); border:1px solid var(--hairline-strong); border-radius:16px; box-shadow:0 26px 70px rgba(0,0,0,.72)`。设备行含类型徽章（DLNA 绿 `#7fd0a8` / Chromecast 金 `#f4b400` / DIAL 蓝 `#8ab4ff`），连接态 `inset 2px 0 0 var(--accent-mid)`；控制区含「投屏当前内容」主按钮 + 串流输入 + 4 格传输（暂停/继续/停止/同步进度）+ 电视音量滑块 + 断开（danger）。恒暗色，不进 `.light-surface`。」

### 9.3 Iteration Guide（AI 生成 UI 的迭代建议）

1. 先锁定 `:root` token，再写组件；任何新色先查 §2 是否已有。
2. 暗色覆盖层绝不加 `.light-surface`；亮色只用于设置/许可证/idle。
3. 圆角全窗口层一律 `overflow:hidden` + inset 描边，外投影只在非铺满浮层用。
4. 玻璃 `saturate()` 必带（140–190%），否则发灰不通透。
5. 过渡 / 动画统一 `var(--ease)`，入场用 `pop-in/fade-in`，勿混 cubic-bezier。
6. 间距取 4 的倍数（8/12/18/28），勿出现 5/7/13 等离群值。
7. 字号走 §3 固定阶梯，窄窗改容器不改字。
8. z-index 严格按 §6.3，勿自创层级（尤其勿压过 OSC 42 / 菜单 60 / 拖放 200）。
9. 新增组件先想「它该隐形还是浮出」——默认隐形，需要时优雅浮出。
10. 任何偏离都应在 PR 说明，并优先沉淀为新的 `:root` 变量。

---

## 附录 A · 界面清单 / Screen Inventory

### A.1 设计交付件（`design/` 目录，令牌 1:1 还原 `style.css`，零源码改动）

> 中心枢纽：`design/index.html`；规范自检：`design/DESIGN_PREVIEW.html`（令牌总览 + 暗↔亮 + 响应式模拟器）。

| 交付件 | 文件 | 类型 | 主题 | 要点 |
|---|---|---|---|---|
| 设计令牌总览 | `DESIGN_PREVIEW.html` | TOKENS | 暗/亮 | 色板/表面/语义色/排版阶梯/组件/阴影 + 主题与响应式切换 |
| 设置面板 | `SETTINGS_MOCK.html` | SCREEN | 亮 | `.light-surface` 侧栏→顶栏（≤640）、开关/下拉/渐变滑块/键位 |
| 音乐播放器 | `MUSIC_STAGE_MOCK.html` | SCREEN | 暗 | 极光背景 + CSS 黑胶唱盘 + 逐字歌词 + FFT 频谱 + 控制条 |
| 空闲落地页 | `IDLE_SCREEN_MOCK.html` | SCREEN | 暗/亮 | 2:1:2 三栏舞台、旋转光圈入口、胶囊主操作、≤860 堆叠 |
| 播放列表面板 | `PLAYLIST_MOCK.html` | PANEL | 暗/亮 | 右侧滑入玻璃、曲目卡（播放中/红心/删除）、active 渐变态 |
| 网络串流弹窗 | `NETWORK_STREAM_MOCK.html` | DIALOG | 暗 | 居中玻璃、等宽地址输入（聚焦 accent 光环）、错误态 |
| 投屏面板 | `CAST_PANEL_MOCK.html` | PANEL | 暗/亮 | 设备列表（DLNA/Chromecast/DIAL 徽章）+ 连接后控制区；DIAL 置顶展示 v2 新协议 |
| 响应式模拟器 | `DESIGN_PREVIEW.html#responsive` | TOOL | — | 拖拽模拟窗口宽度，观察 OSC 换行（≤900）/ 音乐堆叠（≤720·≤560h） |

### A.2 真实界面 · 交付（mock）状态总览

> 渲染进程全部 UI 表面盘点（2026-08-14 审计）。✅ = 已有 `design/` mock；❌ = 真实界面但尚无 mock。
> 主程序 chrome（OSC / 设置 / 播放列表 / 音乐 / 空闲 / 投屏 / EQ / 统计 / 弹幕 / 右键菜单 等）**零硬编码颜色**，已全量令牌化（见 A.3）。

| 真实界面 | 源文件 | 类型 | Mock | 备注 |
|---|---|---|---|---|
| OSC 控制条 | `ui/osc.js` | OVERLAY | ✅ | `OSC_MOCK.html`（核心控制层：播放头/缓冲条/进度辉光/音量渐变/弹幕激活态） |
| 视频画面/WebGL | `player/video-player.js` `gl/renderer.js` | CANVAS | — | 视频本身，非面板，无需 mock |
| 设置面板 | `panels/settings.js` | PANEL | ✅ | `SETTINGS_MOCK.html` |
| 音乐舞台 | `ui/music-stage.js` | SCREEN | ✅ | `MUSIC_STAGE_MOCK.html`（含迷你播放器） |
| 空闲落地页 | `panels/idle.js` | SCREEN | ✅ | `IDLE_SCREEN_MOCK.html` |
| 播放列表 | `panels/playlist.js` | PANEL | ✅ | `PLAYLIST_MOCK.html` |
| 网络串流 | `panels/`（dialog） | DIALOG | ✅ | `NETWORK_STREAM_MOCK.html` |
| 投屏面板 | `panels/cast.js` | PANEL | ✅ | `CAST_PANEL_MOCK.html` |
| EQ 均衡器 | `panels/eq.js` | PANEL | ✅ | `EQ_MOCK.html`（10 段图示 + 预设 + 跨引擎共享状态） |
| 统计面板 | `ui/stats.js` | PANEL | ✅ | `STATS_MOCK.html`（仿 mpv stats.lua 分区 + 帧时间图） |
| 字幕样式 | `panels/subtitle-style.js` | PANEL | ✅ | `SUBTITLE_STYLE_MOCK.html`（设置面板字幕外观 + 实时预览） |
| 字幕 | `panels/subtitles.js` | OVERLAY | ✅ | `SUBTITLE_MOCK.html`（双轨字幕渲染层 + 在线字幕搜索：来源彩色标签 + 第二字幕「副」按钮） |
| 歌词搜索 | `panels/lyrics-search.js` | DIALOG | ✅ | `LYRICS_SEARCH_MOCK.html`（LRCLIB 候选 + 同步/纯文本 + 自适应主题） |
| 键位编辑器 | `ui/keybind-editor.js` | DIALOG | ✅ | `KEYBIND_MOCK.html`（重绑定 / changed·removed·conflict 三态 / 即时搜索，`7e6f092` 修复转义） |
| AI 面板 | `ui/ai-panel.js` | PANEL | ✅ | `AI_PANEL_MOCK.html`（右侧玻璃抽屉 + player:ai:* 事件流渲染 + 错误中文诊断） |
| 右键菜单 | `panels/context-menu.js` | OVERLAY | ✅ | `CONTEXT_MENU_MOCK.html`（分层 + 子菜单 + 选中态） |
| 弹幕 | `panels/danmaku.js` `core/danmaku-renderer.js` | OVERLAY | ✅ | `DANMAKU_MOCK.html`（搜索/匹配面板 + 实时弹幕层） |
| 许可证 | `panels/licenses.js` | DIALOG | ❌ | 第三方许可证（`24b2202` 令牌化） |
| 画中画 | `pip.html` `pip-preload.js` | FLOATING | ❌ | 独立浮动视频窗（见 A.3 漂移） |
| 桌面歌词 | `desktop-lyrics.html` | FLOATING | ❌ | 独立浮动歌词窗（见 A.3 漂移） |
| 音频解锁 | `panels/audio-unlock.js` | OVERLAY | ❌ | 无音卡环境解锁浮层 |
| 设计令牌/响应式 | `design/DESIGN_PREVIEW.html` | TOOL | ✅ | 规范自检入口 |

### A.3 已知设计漂移（Known Drift，2026-08-14 审计）

- **浮动窗独立调色板**（桌面歌词 `desktop-lyrics.html`、画中画 `pip.html`）：定义**局部 accent 令牌**而非引用全局 `--accent`：
  - `--dl-accent: #4d8dff` 偏离品牌 `--accent: #7c8cff`（已部分一致：`--dl-accent-b: #7c8cff`、hover `rgba(124,140,255,…)` 即 `#7c8cff`）。
  - 暗色玻璃背景 `rgba(14,16,28,.86)` / `rgba(18,20,32,.6)` 与投屏面板 `rgba(12,13,18,.94)` 近似但未统一。
  - 大量 `rgba(255,255,255,α)` 文本色属浮动窗叠加桌面场景的合理选择，非严格令牌化；如需 100% 合规可改引 `--text-1/2/3`。
  - **建议**：将 `--dl-accent` 对齐 `#7c8cff`、背景统一到 `rgba(12,13,18,.94)` 体系，或文档明示「浮动窗允许独立调色板」为有意设计。
- **字幕样式非漂移**：`subtitle-style.js` 的 `#FFFFFF`/`#000000` 默认与生成 `rgba(0,0,0,α)` 是**用户可配置字幕外观**（内容层），不属 UI 令牌，正确无需改。
- **主程序 chrome 全量令牌化**：上述 ❌ 面板中 EQ/统计/右键菜单/许可证/键位/OSC 等实测零硬编码颜色，符合本规范，无需返工。

**投屏协议支持（v2）**：DLNA（UPnP/AVTransport，完整 pause/seek/volume）· Chromecast（CAstV2 + mDNS，标准 Cast 客户端证书需用户自备）· **DIAL**（SSDP `ST=urn:dial-multiscreen-org:service:dial:1`，仅 launch 应用自身拉取 URL，无通用传输控制）。类型徽章配色见 §4.10。
