# 新人上手路径（Lumora）

> 目标：让新成员在两个迭代内从"能跑门禁"到"能独立改核心模块并被 Senior 评审通过"。
> 每步都给具体文件与时间盒，别只靠口授。

## 第 0 步：环境（30 分钟）
1. `git clone` 后 `npm install`（会自动跑 `prepare` → 安装 pre-commit 钩子，铁律从此提交即拦）。
2. 读 `AGENTS.md`（铁律 + 改动流程 + 速查）与 `MODULES.md`（模块地图）。
3. `npm run lint:syntax && npm run test:unit && npm run typecheck` 跑通快速门禁。

## 第 1 步：理解 ctx 注入模式（半天，核心中的核心）
- 读 `docs/adr/0001-ctx-injection-pattern.md` 与 `0002-single-source-of-truth.md`。
- 关键心智模型：**共享可变状态一律 getter/setter，单一事实源留在宿主，模块不持有副本；传值引用是已知 bug**。
- 实操：挑一个模块（如 `src/main/playlist-store.js`），画出它的 `setCtx` 注入了什么、访问器怎么取。

## 第 2 步：跟一个核心模块单测（1 天）
- 读已有单测 `test/unit/`（config-parse / filename-parser / protocol / window-sync）找手感。
- 给 `src/renderer/core/clock.js`（音频主时钟）或 `src/main/media-pipeline.js`（流控）补一个单测：注入 mock ctx，断言关键分支。**这正是 ADR-0001 宣称的"可测试"收益落地**。
- 跑 `npm run test:cov:report` 看 c8 报告，确认覆盖数字在涨。

## 第 3 步：跟一次 Senior 评审（1 天）
- 用自己的改动，对照 `.github/pull_request_template.md` 的评审清单自评。
- 重点自查：ctx 有无传值引用、throttle 是否独立、GPU 能力有无降级、新模块有无跑漏网扫描。
- 提交 MR，请 Senior 走同一份清单评审。

## 常见坑速查
- 改完发现测试头打印后 ~3 秒 exit 0、渲染端零输出 → 多半是 userData 锁（你正开着播放器），用 `tools/run-smoke.js` 独立 profile 重试。
- 提交被 pre-commit 拦 → 看提示修（通常是 CRLF 或语法），或用 `node tools/fix-crlf.js <文件>` 归一。
- 不确定动哪个文件 → 先 `pwd` 确认在 `D:\IDEA\videos`（不是 `D:\IDEA\player` 那个 C++ 工程）。
