# DESIGN-AI.md — Lumora AI 内容识别（本地模型优先）扩展规范

> 本文件是 `DESIGN.md`（暗色沉浸播放器）的**功能扩展**，仅补充 AI 内容识别面板所需的设计令牌与组件。所有未覆盖的基调、色板、字体、缓动、毛玻璃参数**一律继承 `DESIGN.md`**，不得另立体系。
> 功能范围（据 #73 决策）：**本地模型优先**的「内容标签 + 简介 + 元数据」自动识别，离线可用、隐私不出本机。

---

## 1. AI 面板专属色彩（复用主色，新增语义角色）

| 角色 | HEX / rgba | CSS 变量 | 使用场景 |
|---|---|---|---|
| 本地模型徽标底 | `rgba(94,230,168,.12)` | `--ai-local-bg` | "本地模型"badge 底色 |
| 本地模型徽标字 | `#5ee6a8` | `--sem-success`（复用） | badge 文字 + 脉冲圆点 |
| 标签·类型 | `linear-gradient(135deg,rgba(124,140,255,.22),rgba(110,231,255,.14))` | `--ai-tag-genre-bg` | genre/剧情类标签（accent→cyan） |
| 标签·情绪 | `rgba(255,122,198,.14)` | `--ai-tag-mood-bg` | mood/情绪类标签（pink） |
| 标签·场景 | `rgba(110,231,255,.12)` | `--ai-tag-scene-bg` | scene/场景类标签（cyan） |
| 置信度条填充 | `linear-gradient(90deg,#6ee7ff,#7c8cff,#ff7ac6)` | 复用主渐变 | 识别置信度进度条（含 glow） |

> 规则：AI 面板不引入任何新主色。类型标签用青紫渐变、情绪用粉、场景用青——三者区分靠**色相**而非新增颜色，保持调色板单点可控。

## 2. 触发入口（OSC 新增按钮）

- 位置：右上角 `top:46px; right:18px`，与标题栏/OSC 同侧；`z-index:42`（与 osc 同级）。
- 形态：毛玻璃胶囊 `blur(22px) saturate(160%)`，内含 sparkle 图标（12 点放射 + 中心圆，stroke `currentColor`）+ 文案「AI 识别」。
- 交互：hover 变 `rgba(124,140,255,.18)`，文字转 `--accent-bright`，`translateY(-1px)` + 紫色辉光描边，统一 `--ease`。

## 3. 面板组件（popover 体系，z-index 48）

继承 `DESIGN.md §4 Modals` 的 `.popover` 毛玻璃参数：`blur(28px) saturate(190%)`、`surface-2` 底、`hairline-strong` 边框、`pop-in` 动画（`.22s`）。仅补充结构：

```css
.ai-panel{ position:fixed; top:46px; right:18px; width:min(380px,calc(100vw - 36px));
  max-height:78vh; overflow-y:auto; padding:14px; border-radius:14px;
  background:var(--surface-2);
  backdrop-filter:blur(28px) saturate(190%); -webkit-backdrop-filter:blur(28px) saturate(190%);
  border:1px solid var(--hairline-strong);
  box-shadow:0 18px 52px var(--shadow-color), 0 0 0 1px rgba(0,0,0,.35);
  animation:pop-in .22s var(--ease) both; z-index:48; }

/* 头部：标题 + 本地模型徽标 + 关闭 */
.ai-title{ font-size:15px; font-weight:600; display:flex; align-items:center; gap:8px; }
.ai-title svg{ width:18px; height:18px; color:var(--accent-bright); }
.ai-badge{ display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:7px;
  font-size:10.5px; font-weight:700; letter-spacing:.04em; color:var(--sem-success);
  background:var(--ai-local-bg); border:1px solid rgba(94,230,168,.25); }
.ai-badge .dot{ width:6px; height:6px; border-radius:50%; background:var(--sem-success);
  box-shadow:0 0 8px var(--sem-success); }

/* 识别标题/元信息 */
.ai-media{ font-size:18px; font-weight:600; line-height:1.3; letter-spacing:-.01em; }
.ai-meta{ font-size:11px; color:var(--text-3); margin-bottom:12px; }

/* 区块小标题（复用 §3 Nano：10px/700/.07em uppercase） */
.ai-section-h{ font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
  color:var(--text-3); margin:14px 0 8px; }

/* 简介正文：Body 13px / line-height 1.6 / text-2 */
.ai-synopsis{ font-size:13px; line-height:1.6; color:var(--text-2); }

/* 标签（三色按类别） */
.ai-tags{ display:flex; flex-wrap:wrap; gap:7px; }
.ai-tag{ padding:4px 10px; border-radius:8px; font-size:11.5px; font-weight:500;
  background:rgba(255,255,255,.055); border:1px solid var(--hairline); color:var(--text-2);
  transition:background .16s var(--ease), color .16s var(--ease), transform .16s var(--ease); }
.ai-tag:hover{ background:rgba(124,140,255,.16); color:var(--accent-bright); transform:translateY(-1px); }
.ai-tag.cat-genre{ background:var(--ai-tag-genre-bg); border-color:rgba(124,140,255,.3); color:#cdd4ff; }
.ai-tag.cat-mood { background:var(--ai-tag-mood-bg);  border-color:rgba(255,122,198,.28); color:#ffb8e3; }
.ai-tag.cat-scene{ background:var(--ai-tag-scene-bg); border-color:rgba(110,231,255,.26); color:#aef0ff; }

/* 置信度条（复用主渐变 + glow） */
.ai-confidence{ margin-top:14px; display:flex; align-items:center; gap:10px; }
.ai-bar{ flex:1; height:4px; border-radius:4px; background:rgba(255,255,255,.14); overflow:hidden; }
.ai-bar > i{ display:block; height:100%; width:var(--conf,82%);
  background:linear-gradient(90deg,var(--accent-cyan),var(--accent),var(--accent-pink));
  box-shadow:0 0 10px var(--accent-glow); border-radius:4px; }
.ai-conf-val{ font-family:var(--mono); font-size:11px; color:var(--text-2); font-variant-numeric:tabular-nums; }

/* 操作按钮（复用 §4 按钮语义：ghost + primary 渐变） */
.ai-actions{ display:flex; gap:8px; margin-top:16px; }
.ai-btn{ flex:1; padding:9px 12px; border-radius:9px; font-size:12px; font-weight:600; cursor:pointer;
  border:1px solid var(--hairline); background:rgba(255,255,255,.06); color:var(--text-2);
  transition:background .16s var(--ease), color .16s var(--ease), transform .16s var(--ease); }
.ai-btn:hover{ background:rgba(255,255,255,.12); color:var(--text-1); }
.ai-btn.primary{ background:linear-gradient(135deg,rgba(124,140,255,.9),rgba(110,231,255,.85));
  border-color:transparent; color:#0b0c12; }
.ai-btn.primary:hover{ transform:translateY(-1px); box-shadow:0 6px 20px rgba(124,140,255,.32); }

/* 加载态：旋转环（accent 顶色）+ 提示 */
.ai-loading{ display:flex; flex-direction:column; align-items:center; gap:14px; padding:30px 10px; }
.ai-spinner{ width:34px; height:34px; border-radius:50%;
  border:3px solid rgba(255,255,255,.12); border-top-color:var(--accent);
  animation:spin .9s linear infinite; }
@keyframes spin{ to{ transform:rotate(360deg); } }
```

## 4. 层级与折叠（补充 `DESIGN.md §6/§8`）

| 层级 | 值 | 元素 |
|---|---|---|
| ai-trigger | 42 | 右上角 AI 识别入口（与 osc 同级） |
| ai-panel | 48 | AI 内容识别面板（popover 体系，低于 keymap 49） |

- 折叠：`≤640px` 时面板 `width:calc(100vw - 36px)`（已用 `min()` 内建）；标签区自动换行，不压缩字号。
- 动画：面板 `pop-in .22s var(--ease)`；标签 hover `.16s`；旋转环 `.9s linear`。尊重 `prefers-reduced-motion` 时关闭 spin 与 pop-in。

## 5. 内容与空态规范

- **识别标题**：优先用模型给的影片名（可「应用为标题」回写 `player.props.title`）；无把握时显示文件名。
- **简介**：≤160 字，纯文本，strip 换行合并为空格；空时显示「未能生成简介」。
- **标签上限**：默认展示前 12 个；分类三色（genre/mood/scene）由主进程模型输出携带 `cat` 字段决定。
- **置信度**：取模型整体信心分 0–100%，低于 40% 时徽标降级为「低置信度」(`--warning` 色)，不展示"本地模型"绿色态。

## 6. Agent Prompt Guide（AI 面板专属）

- "生成 Lumora AI 识别面板的加载态：blur(28px) popover + accent 旋转环 + '本地分析媒体' 文案"
- "做内容标签三色 chip：genre 用青紫渐变、mood 用粉、scene 用青，hover 上浮 1px"
- "写 AI 面板头部：标题 + 本地模型绿色徽标（脉动圆点）+ 关闭按钮"
- "置信度条用主渐变 cyan→accent→pink + glow，宽度由 --conf 变量控制"
- "AI 识别触发按钮：右上角毛玻璃胶囊，sparkle 图标 + 'AI 识别'，hover 紫色辉光"
