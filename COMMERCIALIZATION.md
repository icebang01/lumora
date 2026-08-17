# Lumora 商用化战略文档

> 目标：**全面商用化 · 仅 Windows · 四块齐做**（许可合规 / 技术架构 / 功能路线图 / 品牌设计）。
> 本文是路线图与决策依据，不是法律意见——涉及分发前请过一遍 IP  counsel。

---

## 0. 现状与最优先项

| 项 | 现状 | 商用风险 |
|---|---|---|
| 许可声明 | `package.json` 现为 `UNLICENSED`（原误写 `MIT` 已更正） | ✅ 闭源专有；但随附的 GPL 二进制仍需分别履行依赖义务 |
| 视频后端 | `bin/mpv.exe`（GPLv2+） | ⚠️ 分发即触发 GPL 义务 |
| 解码/探测 | `bin/ffmpeg.exe` `ffprobe.exe`（多含 GPL 组件） | ⚠️ 同上 |
| 依赖 | `ws`（MIT，OK）、`electron`（MIT/BSD，OK） | ✅ |
| UI | 原生 HTML/CSS/JS，设计完整 | ✅ 已沉淀为 DESIGN.md |
| 品牌资产 | 仅 logo SVG + 渐变，无商标检索 | ⚠️ "Lumora" 可能撞名 |

**第一优先级（不解决不能发安装包）**：许可合规（§1）。

---

## 1. 许可与合规（最高优先级）

### 1.1 当前冲突
- 项目以独立子进程方式调用 mpv（`--wid` 嵌入 + 命名管道 IPC），属"单纯聚合"（mere aggregation），你的主程序**不一定**因此被传染为 GPL。但这是有争议的灰色地带，且：
- **无论是否传染**，你分发了 mpv/ffmpeg 二进制，就必须对这两个程序本身履行 GPL/LGPL 义务：**提供对应源码、附许可证全文、公开你对它们的修改**。
- `package.json` 的 `"license": "MIT"` 是错误声明，会与事实冲突，必须先改。

### 1.2 三条可行路线（按"干净程度"排序）

**路线 A — 改用 Windows 系统解码器（推荐，最干净）**
- 解码走 **Media Foundation / DirectShow**（系统 codec），不再捆绑 mpv/ffmpeg 二进制。
- 好处：① 无 GPL 二进制，主程序可闭源商用；② H.264/AAC 等**专利责任落在微软**授权范围内；③ 安装包体积骤降。
- 代价：需重写解码/渲染后端（当前 mpv 后端约占一套子系统的工程量），并抽象出统一 "Engine" 接口以保住现有 UI/快捷键/流控。
- 适用：面向普通消费者的 Windows 播放器。

**路线 B — 保留 mpv，但合规聚合**
- 维持子进程调用，声明主程序许可证（如 `MIT` 或专有），但**必须**：在"关于/开源声明"里列出 mpv(GPLv2+)、ffmpeg(LGPL)、Electron 及全部依赖许可；提供 mpv/ffmpeg 源码与修改；ffmpeg 改用 **lgpl 构建**并允许重链接。
- 仍残留 **编解码器专利**风险（见 1.3）。
- 适用：愿意开源或接受聚合论、且愿承担专利风险。

**路线 C — 全开源（GPL/AGPL）**
- 整个产品 GPL 化，mpv 完全合规，但无法"闭源售卖"。除非商业模式是开源+服务，否则与"商用"目标冲突。

> 建议：**路线 A 为主，路线 B 作过渡**（短期先合规化 mpv 分发，长期切 Media Foundation）。

### 1.3 编解码器专利（路线 A 可规避，其余路线必有）
- H.264/AVC（Via LA / MPEG LA）、AAC（Via LA）、HEVC/H.265（Access Advance）等分发解码器需**专利许可**。
- 路线 A 借系统解码器规避；路线 B/C 需自行评估是否入专利池或承担风险。
- 对策：在 EULA 中明确"本软件使用系统编解码能力"，并把 HEVC/AV1 等付费格式设为可选项。

### 1.4 必须交付的合规件
- [x] 修正 `package.json` 许可证字段（现为 `UNLICENSED`，闭源专有；原误写 `MIT` 已纠正）
- [x] `THIRD_PARTY_LICENSES.md` / 应用内"开源声明"面板（Electron + mpv + ffmpeg + ws + 全部 npm 依赖）—— 文件已创建；面板早已实现（F1 / Ctrl+, / 设置→关于→查看开源声明）
- [~] 提供 mpv/ffmpeg 对应源码链接与修改说明（若走 B）—— 上游仓库链接已写入 `THIRD_PARTY_LICENSES.md`；具体版本号/commit 待发布构建时补；我们对 mpv/ffmpeg 仅命令行调用、未改源码已注明
- [ ] 商标检索 "Lumora" 并决定是否更名（见 §4）

---

## 2. 技术架构优化（商用就绪）

| 能力 | 方案 | 说明 |
|---|---|---|
| 自动更新 | `electron-updater` + 私有更新服务器（或 GitHub Releases） | 需代码签名；支持增量 |
| 崩溃上报 | Electron `crashReporter` + Sentry（自托管/云） | 隐私声明中告知 |
| 安装包 | `electron-builder`（NSIS）或 MSIX | 单文件/绿色版二选一 |
| 代码签名 | Authenticode（EV 证书优先，快速攒 SmartScreen 信誉） | 无签名必被 SmartScreen 拦截 |
| 遥测（可选） | 匿名使用统计，默认关闭，显式 opt-in | GDPR/个保法合规 |
| 配置化品牌 | 把产品名/logo/主色抽成 `brand.config.json` | 支持按客户换肤换名 |
| 引擎抽象 | `Engine` 接口隔离 mpv ↔ Media Foundation | UI/快捷键/流控零改动 |
| 可访问性 | 设置窗口加键盘导航 + 高对比 | 政企采购常要求 |

---

## 3. 功能路线图（商用必备，按优先级）

**P0（缺失即不像商用产品）**
- 播放列表 / 媒体库（当前仅单文件 + 基础 playlist 命令）
- 设置窗口（亮色主题，复用 DESIGN.md）+ 持久化
- 文件关联（双击 mp4/mkv 用 Lumora 打开）
- 继续观看（已支持 `save-position-on-quit`，需 UI 入口）

**P1（差异化）**
- 流媒体协议：HLS / DASH（需新增网络源管线）
- 字幕增强：外挂/内封切换、样式、在线字幕匹配（已有轨道入口）
- 画质面板：缩放/去带/HDR 映射（配置已支持，需 UI 暴露）
- 截图/片段导出（已有截图，需导出目录设置）

**P2（商业化加成）**
- 正版 DRM 接入（Widevine CDM，**仅做合规集成，不做破解**）
- 格式广度：ISO/BDMV、无损音频（FLAC/DSD）
- 投屏：DLNA / Chromecast
- 脚本/插件市场（已有 `scripts=yes` 基础）

---

## 4. 品牌与设计系统

- 设计系统已交付 → **`DESIGN.md`**（9 章：暗色沉浸主基调 + 亮色仅设置窗 + 完整字阶/阴影/层级/响应式 + AI 提示指南）。
- **商标**：上线前检索 "Lumora" 在软件类的注册情况（多家同名），建议注册或换名。
- 品牌资产待补齐：应用图标（`.ico`/任务栏）、安装包 banner、空状态插画规范、About 窗口版式。
- 设计语言原则（已写入 DESIGN.md §7）：毛玻璃浮层、青紫粉渐变、ease-out-expo 微交互、暗色优先。

---

## 5. 分阶段行动清单

**阶段 0 — 合规止血（1–2 周）**
1. [x] 修正 `package.json` license 字段（→ `UNLICENSED`）
2. [x] 加 `THIRD_PARTY_LICENSES.md` + 应用内开源声明面板
3. [~] ffmpeg 换 lgpl 构建；附 mpv/ffmpeg 源码与修改说明（链接已附，版本号待发布补；lgpl 构建开关待 `fetch-deps` 确认）
4. [ ] 商标检索 + 命名决策

**阶段 1 — 架构商用化（2–4 周）**
5. 接入 electron-builder + 代码签名（EV 证书）
6. electron-updater 自动更新
7. crashReporter + 崩溃上报
8. `brand.config.json` 配置化 + Engine 抽象层

**阶段 2 — 功能补齐（4–8 周）**
9. 播放列表 / 媒体库 / 设置窗口（亮色，用 DESIGN.md）
10. 文件关联 + 继续观看 UI
11. HLS/DASH + 字幕/画质面板

**阶段 3 — 后端切换（可选，长期）**
12. ~~实现 Media Foundation 引擎（路线 A 去 GPL）~~ —— 已移除：Lumora 现全程使用 mpv（GPLv2+ 二进制）以获得完整编解码 / 8K / Dolby Vision 支持，去 GPL 路线不再采用

---

## 6. 主要风险

- **法律风险**：GPL 二进制误用、编解码器专利——未解决前不要公开发布安装包。
- **SmartScreen 拦截**：新代码签名证书初始信誉低，需 EV 证书 + 下载量积累。
- **后端重写成本**：路线 A 的 Media Foundation 引擎是最大工程量，建议先 B 后 A。
- **商标冲突**："Lumora" 同名较多，尽早定名。
