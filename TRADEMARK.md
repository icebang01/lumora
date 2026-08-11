# 商标检索与更名报告：Lumen → Lumora

> 检索日期：2026-08-04 · 范围：USPTO（美国）为主，兼看通用名称冲突。
> 本文为检索摘要与风险提示，非法律意见；正式使用前请过 IP counsel。

---

## 1. 原始冲突（旧名 "Lumen"）

"Lumen" 作为软件 / 媒体播放器名称存在**高侵权风险**。

- **LUMEN**（USPTO Reg. #7408852，Serial 90047130，**Class 9**，注册于 2024-06-04，所有者 CenturyLink Communications, LLC / Lumen Technologies, Inc.）
  - 商品 / 服务范围明确包含：**"Downloadable software for internet access, streaming media and content delivery"**、"Downloadable software for delivering content, including ... video, audio, data and streaming media over the internet..." —— 与媒体播放器**直接重叠**。
- **LUMEN TECHNOLOGIES**（Reg. #6958110，Class 38 通信服务）、**LUMEN**（88642330）、**LUMEN WAND** 等衍生注册。
- **所有人背景**：Lumen Technologies（原 CenturyLink，纳斯达克 `LUMN`）是大型上市电信公司，品牌资产重、法务资源强，对同名 / 近似商标维权概率高。

## 2. 决策：更名为 "Lumora"

为规避上述冲突，产品名由 **"Lumen" 更名为 "Lumora"**（保留 `Lum-` 词根，延续现有品牌识别与 `DESIGN.md` 视觉体系：暗色沉浸、青紫粉渐变、光 / 影像语义）。

### 2.1 二次检索（候选名，Class 9 软件 / 媒体口径）

| 候选 | Class 9 结论 | 说明 |
|---|---|---|
| Lumina | ❌ 冲突 | 多枚 Class 9 软件注册（Sorenson #7458398、Lumenuity 待审、Align Technology 待审） |
| Cinevia | ❌ 避免 | "Cinavia" 是 Verance 的 DRM 商标；且已有同名媒体 App |
| Auralis | ❌ 冲突 | Class 9 软件标记（EU #019204067、AU #2473788） |
| Vyra | ⚠️ 弱 | 制药 Class 5 等已注册，调性不符 |
| Halora | ✅ 可用 | Class 9 无冲突（仅有照明 Class 11、化妆品 Class 3 等异类） |
| **Lumora** | ✅ **选定** | Class 9 无冲突：现有标记均为烟草（#98719851）、制药（#99077344）、珠宝（#99118498）、医疗服务（#98129531）等异类，无软件 / 媒体冲突 |

### 2.2 已落地

- 产品展示名：`src/renderer/index.html`（`<title>`、idle 标题）、`app.js`（关于页、开源声明正文）、`index.js`（窗口标题、错误框、降级提示、文件关联 ProgID `Lumora.MediaFile` 与显示名）、`style.css` 头注等。
- 包标识：`package.json` 的 `name` → `lumora`、`productName` → `Lumora`、`appId` → `com.lumora.player`；截图默认名 `lumora-%F-%P`。
- 文档：`COMMERCIALIZATION.md` / `DESIGN.md` / `THIRD_PARTY_LICENSES.md` / `MEDIAFOUNDATION_ENGINE.md` 品牌名同步。

### 2.3 内部标识符保留（非商标载体，改名有破坏风险）

以下**保持不变**：`window.lumen` / `window.__lumen` IPC 桥、`lumen-audio` AudioWorklet、 `lumen-mpv` 命名管道、`lumen-socket` 示例、`LUMEN_PROP_MAP`、`[lumen]` 日志前缀。属内部 API 命名，消费者不可见，不影响商标 clearance（类比 Chromium 内部命名 ≠ Chrome 品牌）。

## 3. 待办

- [x] 商标检索 "Lumen"：确认 Class 9 高冲突 → 决定更名
- [x] 选定 "Lumora" 并完成二次检索（Class 9 无冲突）
- [x] 产品名 / 包标识 / 文档全局替换为 Lumora
- [ ] **正式提交 "Lumora" 商标申请**（中 / 美 / EU）—— 本检索基于第三方聚合，非穷尽专业 clearance，发布前建议做完整检索 + 申请
- [ ] 旧名历史文档（`overview-*.md`）保留 "Lumen" 作为交接记录，不回溯修改

---

> 关联文档：`COMMERCIALIZATION.md` §4 品牌 / §5 阶段 0；`THIRD_PARTY_LICENSES.md` 合规清单。
