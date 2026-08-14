# DESIGN.md — Lumora 播放器设计系统（商用版）

> 基于现有 `src/renderer/style.css` 提炼的 9 章规范。播放器界面**强制暗色**（功能要求：亮色覆盖层会在暗场画面旁形成眩光，破坏瞳孔适应）。亮色主题仅用于设置/偏好/关于等独立窗口。所有数值精确到 HEX/rgba，可被 Cursor / Claude Code / Google Stitch 直接消费。

---

## 1. Visual Theme & Atmosphere

- **设计哲学**：沉浸优先。覆盖层默认隐形、需要时优雅浮出，永远不与画面争夺注意力。交互"干脆不突兀"。
- **视觉基调**：影院级暗色、科技感、克制的霓虹渐变。
- **核心特征关键词**：`暗色沉浸` · `毛玻璃浮层` · `青紫粉渐变` · `磁吸微交互` · `极简无边框`
- **光影质感**：半透明表面 + `backdrop-filter: blur(22px) saturate(160%)` 毛玻璃；细发丝边框（hairline）；极弱内高光（`inset 0 1px 0 rgba(255,255,255,.06)`）。无纯扁平、无重阴影。

---

## 2. Color Palette & Roles

### Dark Theme（主）
| 角色 | HEX / rgba | CSS 变量 | 使用场景 |
|---|---|---|---|
| Primary Accent | `#7c8cff` | `--accent` | 主强调、激活态、进度填充起点 |
| Accent Bright | `#9aa5ff` | `--accent-bright` | hover/激活文字、选中项 |
| Accent Cyan | `#6ee7ff` | `--accent-cyan` | 渐变起点、音量/进度高光 |
| Accent Pink | `#ff7ac6` | `--accent-pink` | 渐变终点、品牌点缀 |
| Accent Mid | `#8b7bff` | `--accent-mid` | 渐变中段紫（青→紫→粉）、选中描边 |
| Like Color | `#ff5d8f` | `--like-color` | 收藏/红心色（区别于品牌 Accent Pink） |
| Accent Glow | `rgba(124,140,255,.45)` | `--accent-glow` | 进度条/激活态外发光 |
| Surface 0 | `rgba(14,15,20,.72)` | `--surface-0` | 标题栏底渐变层 |
| Surface 1 | `rgba(22,24,32,.86)` | `--surface-1` | OSD 消息底 |
| Surface 2 | `rgba(32,35,46,.94)` | `--surface-2` | 弹层/统计面板底 |
| Hairline | `rgba(255,255,255,.09)` | `--hairline` | 默认分隔线/边框 |
| Hairline Strong | `rgba(255,255,255,.16)` | `--hairline-strong` | 分组分隔条/弹层边框 |
| Text 1 | `rgba(255,255,255,.96)` | `--text-1` | 主文字 |
| Text 2 | `rgba(255,255,255,.68)` | `--text-2` | 次级文字 |
| Text 3 | `rgba(255,255,255,.42)` | `--text-3` | 提示/占位/弱化 |
| Danger | `#e5484d` | `--danger` | 关闭按钮 hover、错误 |
| Warning | `#ffb454` | `--warning` | AB 循环、警告提示 |
| Base BG | `#0b0c12` | `--base-bg` | 空状态/空闲背景 |

### Light Theme（仅设置/关于窗口）
| 角色 | HEX / rgba | CSS 变量 |
|---|---|---|
| Surface 1 | `rgba(255,255,255,.86)` | `--surface-1` |
| Surface 2 | `rgba(248,249,252,.96)` | `--surface-2` |
| Hairline | `rgba(10,12,20,.10)` | `--hairline` |
| Text 1 | `rgba(18,20,28,.95)` | `--text-1` |
| Text 2 | `rgba(18,20,28,.64)` | `--text-2` |
| Text 3 | `rgba(18,20,28,.50)` | `--text-3` | 弱化/占位（≥3:1） |
| Base BG | `#f4f5f8` | `--base-bg` |

### Semantic Colors
| 语义 | HEX | 变量 | 用途 |
|---|---|---|---|
| Success | `#5ee6a8` | `--sem-success` | 统计面板"good"值 |
| Warning | `#ffb454` | `--sem-warning` | 统计"warn"、缓冲警告 |
| Error | `#ff6b6b` | `--sem-error` | 统计"bad"、加载失败 |
| Info | `#6ee7ff` | `--sem-info` | 提示性信息 |

### Shadow Colors
| 变量 | rgba |
|---|---|
| `--shadow-color` | `rgba(0,0,0,.65)` |
| `--shadow-color-soft` | `rgba(0,0,0,.45)` |

---

## 3. Typography Rules

- **Font Family**：`-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Hiragino Sans GB", system-ui, sans-serif`
- **Mono**：`"SF Mono", "Cascadia Mono", "JetBrains Mono", Consolas, monospace`（统计面板/时间戳）
- **设计哲学**：无衬线系统字体栈，零加载成本、跨平台原生观感。数字一律 `font-variant-numeric: tabular-nums` 避免跳动。字距收紧（`letter-spacing: -.02em`）用于大标题。

### Type Scale
| 级别 | Size | Weight | Line Height | Letter Spacing | 用途 |
|---|---|---|---|---|---|
| Display XL | 34px | 600 | 1.1 | -.02em | 关于窗口大标题 |
| Display | 30px | 600 | 1.15 | -.02em | 空状态产品名 |
| H1 | 22px | 600 | 1.25 | -.01em | 设置区块标题 |
| H2 | 18px | 600 | 1.3 | 0 | 面板标题 |
| Body | 13px | 400 | 1.5 | 0 | 默认正文 |
| Small | 12.5px | 500 | 1.45 | 0 | OSC 时间/控制文字 |
| Caption | 11px | 400 | 1.6 | 0 | 统计面板/tooltip |
| Nano | 10px | 700 | 1.2 | .07em | 区块小标题（uppercase） |

---

## 4. Component Stylings

### Buttons
```css
/* 基础控制按钮（OSC） */
.ctl-btn {
  width: 36px; height: 36px;
  background: none; border: none; border-radius: 9px;
  color: var(--text-1);
  transition: background .16s var(--ease), transform .22s var(--ease), color .16s var(--ease);
}
.ctl-btn:hover { background: rgba(255,255,255,.12); transform: translateY(-1px) scale(1.06); }
.ctl-btn:active { transform: translateY(0) scale(.94); transition-duration: .08s; }

/* 主按钮（播放/暂停），放大版 */
.ctl-primary { width: 42px; height: 42px; }
.ctl-primary:hover {
  background: rgba(124,140,255,.22); color: var(--accent-bright);
  box-shadow: 0 0 0 1px rgba(124,140,255,.25), 0 4px 18px rgba(124,140,255,.22);
}
/* 文本按钮（速度显示） */
.ctl-text { min-width: 54px; padding: 0 10px; font-size: 12px; font-weight: 600; }

/* 幽灵按钮（设置/弹层关闭） */
.ghost-btn {
  padding: 5px 12px; background: rgba(255,255,255,.07);
  border: 1px solid var(--hairline); border-radius: 7px;
  color: var(--text-2); font-size: 11.5px;
}
.ghost-btn:hover { background: rgba(255,255,255,.13); color: var(--text-1); }
```

### Cards
```css
/* 空状态卡片 / OSC 胶囊 */
.idle-inner, #osc-inner {
  padding: 14px 18px;
  background: rgba(255,255,255,.025); /* idle */  /* OSC 用 rgba(14,14,20,.78) */
  border: 0.5px solid var(--hairline);
  border-radius: 18px;
  box-shadow: 0 1px 0 rgba(255,255,255,.04) inset,
              0 18px 50px -10px var(--shadow-color),
              0 4px 16px -4px var(--shadow-color-soft);
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
}
```

### Inputs（滑块）
```css
.pop-slider {
  -webkit-appearance: none; width: 100%; height: 4px;
  background: rgba(255,255,255,.16); border-radius: 4px; outline: none;
}
.pop-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px;
  background: #fff; border-radius: 50%;
  box-shadow: 0 1px 5px rgba(0,0,0,.55);
  transition: transform .16s var(--ease);
}
.pop-slider::-webkit-slider-thumb:hover { transform: scale(1.22); }
```

### Navigation（标题栏）
```css
#titlebar {
  position: fixed; top: 0; left: 0; right: 0; height: 34px;
  display: flex; align-items: center; justify-content: space-between;
  padding-left: 14px; -webkit-app-region: drag;
  background: linear-gradient(to bottom, rgba(0,0,0,.62), rgba(0,0,0,0));
  opacity: 0; transform: translateY(-6px);
  transition: opacity .32s var(--ease), transform .32s var(--ease);
}
body.ui-visible #titlebar { opacity: 1; transform: none; }
```

### Badges / Tags
```css
.kbd {
  display: inline-grid; place-items: center;
  min-width: 22px; height: 22px; padding: 0 6px;
  font-family: var(--font); font-size: 11px; font-weight: 500;
  color: var(--text-2);
  background: rgba(255,255,255,.055);
  border: 1px solid var(--hairline); border-bottom-color: rgba(255,255,255,.04);
  border-radius: 5px; box-shadow: 0 1px 0 rgba(0,0,0,.4);
}
```

### Modals / Dialogs（弹层）
```css
.popover {
  min-width: 210px; max-width: 340px; max-height: 62vh; overflow-y: auto;
  padding: 6px;
  background: var(--surface-2);
  backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid var(--hairline-strong); border-radius: 12px;
  box-shadow: 0 18px 52px var(--shadow-color), 0 0 0 1px rgba(0,0,0,.35);
  animation: pop-in .2s var(--ease) both;
}
@keyframes pop-in { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
```

---

## 5. Layout Principles

- **Spacing System**：基数 `4px`，倍数序列 `4 / 8 / 12 / 16 / 24 / 32`。OSC 内边距 `12px 16px 10px`，屏边距 `28px`。
- **Grid System**：OSC 胶囊 `width: min(960px, 100%)` 居中；统计面板固定 `330px`；键位面板 `min(760px, 88vw)` 两栏。
- **Container**：播放区占满视口；浮层统一 `z-index` 层级（见 §6）；OSC 距底 `26px`。
- **Section Spacing**：空状态卡片 `padding: 32px 38px 30px`；弹层条目 `8px 10px`；分组间距 `6px`。
- **留白哲学**：功能浮层"贴边但不贴死"，靠毛玻璃与微弱投影浮于画面上；非播放态才允许大留白落地页。

---

## 6. Depth & Elevation

### Shadow System
```css
--shadow-xs:  0 1px 0 rgba(255,255,255,.04) inset;
--shadow-s:   0 2px 8px rgba(0,0,0,.6);
--shadow-m:   0 8px 26px rgba(0,0,0,.55);
--shadow-l:   0 18px 50px -10px rgba(0,0,0,.65), 0 4px 16px -4px rgba(0,0,0,.45);
--shadow-xl:  0 18px 52px rgba(0,0,0,.68), 0 0 0 1px rgba(0,0,0,.35);
--shadow-2xl: 0 26px 70px rgba(0,0,0,.72);
```

### Surface Layers
`背景(透明/mpv 画面)` → `surface-0/1/2（毛玻璃浮层）` → `elevated（弹层/统计面板）` → `overlay（键位速查/模态）`

### Z-index Scale
| 层级 | 值 | 元素 |
|---|---|---|
| idle | 30 | 空闲落地页 |
| loading | 35 | 载入中 |
| titlebar | 40 | 标题栏 |
| osc | 42 | 控制条 |
| osd-center | 44 | 中央反馈 |
| osd | 45 | 左上提示 |
| stats | 46 | 统计面板 |
| ab-status | 47 | AB 循环浮窗 |
| popover | 48 | 弹层 |
| keymap | 49 | 键位速查（普通内容弹层最高） |
| ctx-menu | 60/61 | 右键上下文菜单（高于普通弹层） |
| settings | 70 | 设置窗口 |
| ai-panel | 90 | AI 助手面板 |
| root-overlay | 100 | 根级浮层顶 |
| modal-critical | 9000 | 关键模态（解锁/确认，全局最高） |

### Backdrop Effects
统一 `backdrop-filter: blur(22px) saturate(160%)`（OSC）/ `blur(28px) saturate(190%)`（弹层）/ `blur(30px) saturate(180%)`（键位面板）。

---

## 7. Do's and Don'ts

**Do's**
1. 覆盖层一律用毛玻璃 + 半透明，绝不用不透明实色盖住画面。
2. 进度/音量填充用 `linear-gradient(90deg, cyan, accent)` + 微弱 glow。
3. 交互用 `cubic-bezier(0.16,1,0.3,1)`（ease-out-expo），起步快收尾缓。
4. 数字用 `tabular-nums`，避免跳动。
5. 尊重 `prefers-reduced-motion`，关闭动画时归零时长。
6. 激活态用小圆点 / 发光描边，不用粗边框。
7. 深色界面为主；亮色仅限独立设置窗口。

**Don'ts**
1. 不要在播放界面引入任何亮色背景或亮色面板（眩光）。
2. 不要给按钮加重投影或大描边（破坏"轻"感）。
3. 不要用纯扁平无层次（至少保留 hairline + 内高光）。
4. 不要把 OSC 做成常驻不隐藏（沉浸感靠自动隐藏）。
5. 不要在大标题用正字距（应保持收紧 -.02em）。
6. 不要引入第三方字体文件（系统字体栈零成本、原生观感）。

---

## 8. Responsive Behavior

- **Breakpoints**：`≤720px`（窄窗）/ `≤560px 高`（横屏小窗）/ 默认桌面。音乐舞台、设置、迷你播放器等均按此断点退化为堆叠/适配。
- **Touch Targets**：控制按钮 `36×36px`（主按钮 `42×42px`），满足最小触控区。
- **折叠策略**：
  - `≤720px`：音乐舞台（黑胶/方封面）退化为上下堆叠；设置侧栏→顶部标签；OSC 收窄、隐藏部分按钮；键位面板改单栏；统计面板 `width: min(560px, calc(100vw - 32px))`；EQ 面板 `min(420px, calc(100vw - 40px))`。
  - `≤560px 高`：音乐舞台堆叠；OSC 上移。
- **Font Scaling**：字号随系统；不单独做 rem 缩放，保持 px 精确控制。

---

## 9. Agent Prompt Guide

**Quick Reference**：暗色沉浸播放器；accent `#7c8cff`；渐变青`#6ee7ff`→紫`#7c8cff`→粉`#ff7ac6`；毛玻璃 `blur(22px) saturate(160%)`；圆角 `8/12/18px`；缓动 `cubic-bezier(0.16,1,0.3,1)`。

**Component Prompts**
- "生成符合 Lumora DESIGN.md 的播放/暂停主按钮（42px 圆形，hover 紫色辉光）"
- "做一个毛玻璃 OSC 控制条胶囊，含进度条 + 播放/音量/字幕组，间距 6px"
- "写空闲落地页：居中卡片 + 青紫粉渐变 logo + 快捷键提示 kbd"
- "实现 AB 循环状态浮窗，右下角，accent 描边 + 脉冲圆点"
- "做设置弹层 popover：毛玻璃 blur(28px)，条目 hover 高亮，选中态 accent"
- "统计面板：右上角 fixed，mono 字体，good/warn/bad 三色值 + 帧时间柱状图"

**Iteration Guide**
1. 先锁定暗色基调，再调 accent 渐变，不要反过来。
2. 任何新浮层必须带 `backdrop-filter` 毛玻璃，否则违和。
3. 阴影只从 `--shadow-*` 取，不要手写新 rgba。
4. 微交互动效时长 0.16–0.34s，统一用 `--ease`；窗口入场/转场可放宽至 .4–.8s（如 `window-in` .8s、主题切换 .35s、AI 面板滑入 .28s）。
5. 新增颜色先加 CSS 变量，再使用，保持单点修改。
6. 大标题字距 -.02em，正文 0。
7. 普通内容弹层 z-index 遵循 §6 分级（课件层 ≤49）；特殊模态（解锁/确认）与根浮层可突破，但不得高于 `modal-critical`(9000)。
8. 改完在 `≤640px` 与 `≤420px 高` 下各验一次折叠。
9. 涉及播放区视觉必须透明背景，让 mpv 画面透出。
10. 提交前过一遍 §7 Do's/Don'ts 清单。
