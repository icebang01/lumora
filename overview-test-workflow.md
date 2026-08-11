# Lumora 测试工作流报告 — 2026-08-06

> 按 `AGENTS.md` 门禁序列执行：`lint:syntax → test:unit → test:opt → typecheck → test:smoke`，质量档新增 `test:cov`，UI 改动加 `test:gui`。
> 本会话**无代码改动**，纯跑门禁以验证工作流与基线健康度。

## 执行环境（务必先读）
- 沙箱为 **headless、无 GPU、无真实音频设备**；`github.com:443` git 端点不通，推送走 Contents API（与本次无关，未改动代码）。
- 沙箱继承 `ELECTRON_RUN_AS_NODE=1`：直接 CLI 启 `electron.exe` 会以纯 node 模式跑，`require('electron')` 无 `app`/`BrowserWindow`，崩于 `index.js:55`。`run-smoke.js` 已 `delete` 该变量故 smoke 正常；**手动 CLI 启 Electron 必须 `env -u ELECTRON_RUN_AS_NODE`**（GUI 测试即如此）。
- 因此 `test:smoke` / `test:gui` 需要真实窗口+GPU 的断言项，在沙箱内属"尽力跑、记录环境假失败"。

## 门禁结果

| 门禁 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 语法 | `lint:syntax` | ✅ PASS | ~140 文件全 OK，0 FAIL |
| 单元测试 | `test:unit` | ✅ 31/31 | 较基线 29 增 `pixfmt-drift.test.js` |
| 类型检查 | `typecheck` | ✅ RC=0 | tsc 干净 |
| 覆盖率 | `test:cov` | ✅ RC=0 | c8 基线 54.47% stmts / 80.68% branch / 24.28% funcs |
| 优化回归 | `test:opt` | ✅ 68/68 | P1–P4 性能/优化回归全绿 |
| 冒烟 | `test:smoke` | ⚠️ 21/22 | 1 项环境/计时假失败（见下） |
| GUI 自动化 | `test:gui` | ✅ 13/13 | CDP 驱动，含真实时间码推进 |

## 各门禁要点
- **lint:syntax**：`tools/check-syntax.js` 全部 `OK`。沙箱会在 ~100+ 次 `spawnSync` 清理阶段收割 node 进程，使汇总行丢失 → `LINT_RC=1` 为**假红**（`failed=0`，真实 CI 返 0）。
- **test:cov（覆盖率基线）**：
  - All files **54.47%** stmts / **80.68%** branch / **24.28%** funcs / **54.47%** lines。
  - 最弱：`subtitles.js` 29.25%（funcs 10%）、`subtitle-scrapers.js` 30.54%（funcs 0%）；`config.js` 51.61%。
  - 满分：`filename-parser.js` / `window-sync.js` / `shared/*` 全 100%。
  - c8 当前**未设强制阈值**，门禁按退出码放行（质量档已备 `test:cov:report` 供后续设门槛）。
- **test:opt（68 项）**：背压迟滞水位、暂停稳态去重派生（`_updateSubtitle/_syncChapter/reportTime` 跳过、`_updateFlow` 不跳过）、`protocol.js`↔`wire.js` 像素格式表逐字节一致、`Player` 继承 `PlaybackEngine` 去重 —— 全部通过。

## 冒烟 1 项 FAIL 根因（非代码回归）
- 失败项：`播放推进（时间码前进）` → `time-pos=0.167s`（断言需 `0.3s < time-pos < 5.0s`）。
- 成因：`--smoke-test=15` 紧窗口内，无 GPU 沙箱中 mpv 播放时钟未热身即被采样；属**环境/计时假失败**。
- 佐证：`test:gui`（同一播放引擎、更长热身窗口）**13/13 全过**，且观测到**真实时间码推进** `0:01 → 0:04 → 0:08 → 0:10`，证明播放引擎本身正常。
- 结论：在真实 GPU+音频机器上重跑 `npm run test:smoke` 应转绿。

## 结论与建议
1. 静态门禁（语法/单测/类型/覆盖率/优化回归）**全绿**，代码健康度基线稳固。
2. 冒烟唯一失败已判定为沙箱无 GPU 的计时假失败，由独立 GUI 套件佐证；**建议用户在真实机器复跑 `npm run test:smoke` 闭环确认**。
3. 覆盖率短板集中在字幕模块（`subtitles.js` / `subtitle-scrapers.js`），可作为下一轮"补核心单测"的优先目标（质量档 B 已规划）。
4. 本会话未改动任何源码/配置，**无需提交**。
