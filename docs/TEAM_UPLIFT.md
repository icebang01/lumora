# 团队技术能力提升与代码质量把控 —— 诊断与路线文档

- 状态：草案（待评审，2026-08-06 由 Senior Developer 起草）
- 适用范围：Lumora 播放器仓库全体协作成员（含跨 AI 助手）
- 关联：`AGENTS.md`（权威约定）· `docs/adr/0001-0004`（决策记录）· `MODULES.md`（模块地图）

---

## 0. 一句话结论

本团队**不缺规矩，缺的是"规矩落到工具链"和"质量可量化"**。约定文档（AGENTS.md + 4 份 ADR + MODULES.md）已是专业水准；但铁律在仓库里未被工具固化、没有本地门禁、没有覆盖率，导致"纸面纪律"与"实际提交"脱节。提升路线分三档：止血（护栏）→ 量化（覆盖率）→ 传承（带教体系）。

---

## 1. 现状诊断（全部基于仓库实测，非主观印象）

### 1.1 强项（务必保留，是后续提升的地基）

| 维度 | 实测情况 | 评价 |
|---|---|---|
| 约定文档 | AGENTS.md（铁律 + 流程 + 速查）、ADR-0001~0004、MODULES.md 齐全 | 超过 90% 团队 |
| 测试规模 | 单测 29 + opt 专项 68 + 冒烟 22 + GUI 13 ≈ **132 项** | 金字塔已成形 |
| CI 门禁 | `.github/workflows/ci.yml`：syntax→unit→opt→typecheck→gen-testmedia→smoke，windows-latest / node 22 | 真门禁，已挂 push+PR |
| 铁律 #3 | `grep -rn "node -e"` 全文零残留 | 执行干净 |

### 1.2 缺口（按严重度排序）

**缺口 #1 —— 铁律 #2 形同虚设（最伤纪律）**
- 实测：`od -c` 抽样 `src/main/index.js` 确认为纯 `\n`；全仓扫描 **78/78 个 `.js` 文件全部 LF，0 个 CRLF**；无 `.gitattributes`。
- AGENTS.md 铁律 #2 明文："源文件 CRLF 行尾"。现实与文档**完全相反**。
- 危害：写在文档却不执行，新人学到的潜规则是"规矩可以不算数"——这是纪律崩塌的起点。

**缺口 #2 —— 零本地门禁（检查只在 push 后才跑）**
- 实测：`.git/hooks/` 为空；`package.json` 无 husky / lint-staged / prettier / eslint；无任何 pre-commit 钩子。
- 讽刺点：仓库**已经写好**了 `tools/fix-crlf.js`、`tools/scan-reverse-leaks.js`、`tools/check-syntax.js`，却**没有接进任何提交流程**。
- 危害：新人可随手把不合规/会挂的代码推进共享分支，CI 才报警，而提交已扩散。

**缺口 #3 —— 质量不可量化（覆盖率缺失）**
- 实测：无任何覆盖率工具（c8/nyc/istanbul 均未安装）。
- 单测只覆盖 6 个文件：`config-parse`、`filename-parser`、`pixfmt-drift`、`protocol`、`subtitles-hash`、`window-sync`——全是小解析器。
- 核心逻辑（`src/main/media-pipeline.js` 流控、`src/renderer/core/clock.js` 音频主时钟、`player.js` 引擎、`mpv-backend.js`）仅靠冒烟/opt 做集成层覆盖，**单测层几乎为零**。
- 危害：重构核心模块时"心里没底"，无法用数字证明"没改坏"。

**缺口 #4 —— 无完成定义（DoD）与评审清单**
- 无 PR 模板、无 Senior 评审 rubric。
- 架构里的已知坑（ctx getter/setter 注入、音视频独立 throttle、GPU 降级）全靠老人脑记，无法稳定传给新人——这与 ADR-0001/0002 的"显式化依赖"精神相悖。

### 1.3 根因分析

| 现象 | 根因 |
|---|---|
| 规矩纸面化 | 约定靠"人读 AGENTS.md"保证，无工具兜底；且规则本身（CRLF）与事实冲突，执行者无所适从 |
| 工具闲置 | 质量脚本写好了但没"接线"到 git 生命周期，缺少一个 install 入口 |
| 覆盖率空白 | 早期以"跑通"为目标，未把"覆盖到哪"纳入门禁 |
| 知识在老人脑中 | 缺评审清单 / onboarding 文档，ADR 讲了"决策"却没讲"怎么审" |

---

## 2. 三档提升路线

> 原则：**每一档都先产出可落地产物，再谈推广**；不一次性大改，避免打断现有节奏。

### 档 A —— 把规矩变成护栏（零依赖、当天见效）

目标：让铁律从"文档条款"变成"提交即拦截"，并了结 CRLF 矛盾。

**A1. 了结 CRLF 矛盾（决策点）**
- 推荐：**改为 LF 策略**。理由：78/78 文件已是 LF，逆向改回 CRLF 是一次无收益的大规模重写且跨平台易再漂移；LF + `.gitattributes * text=auto eol=lf` 对 Windows/Linux/macOS 协作者最稳。
- 动作：
  1. `AGENTS.md` 铁律 #2 改为"源文件 LF 行尾（由 `.gitattributes` 归一，禁止手工混用）"。
  2. 新增 `.gitattributes`：`* text=auto eol=lf`，并对二进制（exe/mp4/mkv…）显式 `* binary`。
  3. 删除 `tools/fix-crlf.js` 的 CRLF 语义（或保留为"强制 LF"模式），钩子里改用 `.gitattributes` 自动归一，不再手工跑。
- 若坚持 CRLF：则需 `git add --renormalize .` 全仓重写 + 钩子强制，成本更高。**需团队拍板，见第 4 节。**

**A2. 本地 pre-commit 护栏（零新增依赖）**
- 新增 `tools/hooks/pre-commit`（纯 shell，Git Bash 兼容），提交前串行跑：
  1. `node tools/check-syntax.js`（已存在）
  2. `node tools/scan-reverse-leaks.js <宿主> <全部模块>`（已存在，双向漏网扫描）
  3. 校验本次暂存文件无 `node -e`、无 CRLF 混入（铁律 #2/#3）
- 新增 `tools/install-hooks.js`（零依赖）：把 `tools/hooks/` 复制到 `.git/hooks/` 并置可执行；`package.json` 加 `"prepare"` 脚本自动安装（CI 下 `prepare` 默认跳过，安全）。
- 预期效果：铁律在"提交那一刻"就拦住，而非等 CI 报警。

**A3. 配套**
- README / AGENTS.md 加一句"首次 clone 后 `npm install` 会自动装钩子"，消除"新人不知道有钩子"。

### 档 B —— 让质量可量化（覆盖率门禁）

目标：把"测试够不够"从感觉变成数字，并补核心模块单测。

**B1. 引入 c8（零配置，兼容 node:test）**
- `npm i -D c8`，加脚本：
  - `"test:cov": "c8 --reporter=text --reporter=lcov node --test test/unit/*.test.js"`
  - `"test:cov:report": "c8 --reporter=html --all --include='src/**/*.js' node --test test/unit/*.test.js"`
- 注意：`--all` 会暴露真实覆盖基线（预计核心模块很低），这是**预期内的起点**，不是失败。

**B2. 阈值策略（ratchet，只升不降）**
- 第一步只设"不回归"底线：在 `c8` 配置里对 **已有单测覆盖的 6 个文件**设 `--100%` 守门，其余目录暂不卡阈值。
- 每补一批核心单测，就把对应目录纳入阈值并抬升基线。避免"一上来卡全仓 80%"导致永远过不了。

**B3. 优先补单测的核心模块（按风险排序）**
1. `src/renderer/core/clock.js`（音频主时钟——历史 bug #1 时钟飞跑的根源）
2. `src/main/media-pipeline.js`（音视频独立 throttle——历史 bug #7/#8 的根源）
3. `src/main/mpv-backend.js`（启动/降级路径）
4. `src/renderer/core/player.js`（命令总线聚合）

> 这些模块用 ctx 注入，单测可直接注入 mock ctx，正好呼应 ADR-0001"可测试"收益。

### 档 C —— 团队带教体系（知识传承）

目标：把"老人脑里的坑"变成新人能照着做的清单与路径。

**C1. Senior 代码评审清单（PR 模板 / DoD）**
- 新增 `.github/pull_request_template.md`，评审项直接锚定本仓库真实风险：
  - [ ] 共享可变状态是否走 ctx getter/setter（ADR-0001/0002），**有无传值引用**（历史头号 bug 类）
  - [ ] 音视频 throttle 是否保持**独立**水位（bug #7/#8 教训）
  - [ ] 新增 WebGL2 / 原生能力是否有 try/catch 降级（GPU 会话崩溃历史）
  - [ ] 新模块是否跑了 `scan-reverse-leaks`（未导出/未导入双向漏网）
  - [ ] 行尾 LF、无 `node -e`、改完跑了 `lint:syntax`+`test:unit`
  - [ ] 涉及播放/IPC/窗口的改动是否补了冒烟回归
**C2. 新人 onboarding 路径文档**
- 新增 `docs/ONBOARDING.md`：从"跑通门禁"→"读 ADR-0001/0002 理解 ctx"→"跟一个核心模块单测"→"跟一次 Senior 评审"的四步路径，每步给具体文件与时间盒。
**C3. 月度架构深潜**
- 固定每月一次，主题轮转：流控模型 / 音频主时钟 / GPU 降级 / IPC 四域编排。材料沉淀进 `docs/`，复用 ADR 框架。

---

## 3. 成功度量（DoD 级指标）

| 指标 | 现状 | 档 A 后 | 档 B 后 | 档 C 后 |
|---|---|---|---|---|
| 铁律本地拦截 | 0（仅 CI） | ✅ 提交即拦 | ✅ | ✅ |
| CRLF 矛盾 | 文档≠现实 | ✅ 已对齐 | ✅ | ✅ |
| 覆盖率数字 | 无 | 无 | ✅ 有基线 | ✅ 有基线+阈值 |
| 核心模块单测 | ~0 | ~0 | ✅ 4 模块 | ✅ |
| 评审清单 | 无 | 无 | 无 | ✅ PR 模板 |
| 新人上手时长 | 靠口授 | 靠口授 | 靠口授 | ✅ 有路径文档 |

---

## 4. 需要团队拍板的两件事

1. **CRLF 策略**：采纳本文推荐的 **LF + `.gitattributes`**，还是坚持 CRLF（需全仓 renormalize）？——影响 A1。
2. **档 B 是否引入 c8 依赖**：c8 是零配置轻量依赖，但仍是新增 devDependency，需确认放行。

其余档 A（护栏）、档 C（清单/文档）均为零依赖、纯仓库内改动，风险极低，可在拍板后立即执行。

---

## 5. 建议节奏（不阻塞现有开发）

- 第 1 周：拍板第 4 节两件事 → 执行档 A（钩子 + CRLF 对齐）→ 全仓跑一次 `scan-reverse-leaks` 自检。
- 第 2–3 周：执行档 B（c8 基线 + 补 clock/media-pipeline 单测）。
- 第 4 周起：执行档 C（PR 模板 + onboarding + 首月架构深潜），并固化"每月一次"。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 钩子拖慢提交（scan-reverse-leaks 全仓扫） | 钩子只扫**本次暂存**文件，不全仓；耗时秒级 |
| 新人抵触"多一道关卡" | 钩子报错即给明确修复命令，且 `npm install` 自动装，零配置摩擦 |
| 覆盖率基线过低打击士气 | 用 ratchet 策略，只卡"不Regression"，不一次性卡全仓 |
| CRLF 全仓重写引发大 diff | 采用 LF 策略则**无需重写**（文件已是 LF），仅声明归一规则 |
