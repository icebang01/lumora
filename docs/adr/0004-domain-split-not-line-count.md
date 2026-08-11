# ADR-0004：按领域拆分模块，而非按行数

- 状态：已接受（2026-08，模块化收官）

## 背景

index.js 从 3119 行拆到 587 行、app.js 从 3590 行拆到 606 行。拆分过程中的原则问题：什么该拆、什么不该拆？如果目标是"每个文件 <300 行"，smoke-test.js（885 行）、settings.js（877 行）、mpv-backend.js（559 行）都"超标"——但它们全是单职责模块，内部已按函数/区块组织，拆了只有搬运成本没有结构收益。

## 决策

- **拆分的单位是领域/职责，不是行数**。
- 已拆：windows（窗口管理）、register-ipc → ipc-player/media/window/app（IPC 按域）、play-control（播放控制）、mpv-launch（mpv 启动）、media-pipeline（ffmpeg 编排）、input/app-events/app-diagnostics（渲染端输入/事件/诊断）……
- 不拆：smoke-test/settings/mpv-backend/subtitles/config/decoder——单职责大文件，函数级组织已清晰。
- 硬边界：**共享可变状态必须走 ctx（ADR-0001/0002）；模块间不允许循环依赖**（直接 import 时人工保证，lint 未自动化）。

## 权衡

- 代价：领域边界有主观性；跨域调用要跨文件跳转。
- 收益：每个文件职责一句话能说清；新人按文件定位功能；大手术（如引擎替换）影响面可控。

## 后果

- MODULES.md 作为模块地图维护；新增领域照此模式落地，**最好的拆分是"代码从一开始就按域长"**。
- 拆分手术脚本（tools/split-*.js）保留作方法论模板。
