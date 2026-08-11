# AGENTS.md — Lumora 播放器（D:\IDEA\videos）

本文件是**所有 AI 助手**（Claude Code / Codex / Cursor / Copilot / Hermes 等）在本仓库工作的**唯一权威约定**。
各助手在仓库根目录打开会话时会自动读取本文件——用户无需每次提醒。
约定变更时：**先改本文件**，再改代码。

## 项目身份

- **Lumora**：Electron + mpv 视频播放器（package.json name/productName 均为 Lumora）。
- **不是** D:\IDEA\player（那是 C++ 的 Lumen.exe，另一个工程）——先 `pwd` 确认，跑错工程会让所有诊断静默失效。
- 用户是 3D 建模师（Blender/ZBrush/SP/Marmoset），品牌名 ICE Bang!。
- 架构地图：`MODULES.md`（模块职责/行数/入口速查）· `docs/adr/0001-0004`（关键决策与理由）· `src/shared/types.d.ts`（IpcCtx 契约）· 技能 `lumora-player-dev`（Hermes 侧详细排障经验）。

## 铁律（违反 = 返工）

1. **共享可变状态一律 ctx 注入 getter/setter**（`setCtx`/`setupXxx`），单一事实源留在宿主（win/videoWin/mpvBackend/pipeline/lastKnownTime/idleState/playlist…）。访问器写 `CTX.getX()` 就必须注入 getter，**传值引用是已知 bug**（ADR-0001/0002）。
2. **源文件 LF 行尾**（由根目录 `.gitattributes` 统一归一，禁止手工混用 CRLF）。新建/编辑后若混入 CRLF，用 `node tools/fix-crlf.js <文件>` 归一为 LF。本地 pre-commit 钩子会自动校验，无需手工跑。
3. **禁用 `node -e` / `node -c` 内联脚本**（会卡审批）——一律写成脚本文件再执行。
4. **测试启动必须用 `tools/run-smoke.js` / `tools/run-gui-test.js`**（内置独立 `--user-data-dir`）。用户可能正开着播放器，共享 profile 会假失败（ADR-0003）。
5. **不提交**：bin/、config/、testmedia*/、node_modules/、smoke-result.txt（.gitignore 已覆盖）。不读取/不打印 .env 与密钥。
6. **动手前先重核文件状态**：用户可能并行修改代码与 MODULES.md/本文件。以磁盘为准，不以上次会话记忆为准。

## 改动流程（每次必须）

1. 先读相关文件 + MODULES.md 对应章节，再动手。
2. 改完跑快速门禁：`npm run lint:syntax && npm run lint:imports && npm run test:unit && npm run typecheck`（几秒）。
3. 涉及播放/IPC/窗口的改动：再跑 `npm run test:smoke`（22 项，约 2 分钟）。UI 交互改动：加跑 `npm run test:gui`（13 项）。
4. 小步提交：`git add -A && git commit -m "<主题>" && git push`（GitHub Actions CI 会自动再跑全部门禁）。
5. 改模块结构 → 同步更新 MODULES.md；改约定 → 更新本文件或新增 ADR。

## 测试命令速查

| 命令 | 内容 | 耗时 |
|---|---|---|
| `npm test` | lint:syntax + lint:imports + test:unit(66) + typecheck + test:smoke(22) | ~3 分钟 |
| `npm run test:gui` | GUI 自动化 13 项（CDP 驱动，需桌面会话） | ~2 分钟 |
| `node tools/scan-reverse-leaks.js <宿主> <全部模块>` | 双向漏网扫描（跨模块 未导出/未导入） | 秒级 |
| `node tools/audit-imports.js` | 全仓漏导入/漏 require 审计（含内建模块漏 require、ESM import 名缺失 export） | 秒级 |

冒烟/单测失败先查是不是 userData 锁（用户播放器在跑）——症状：测试头打印后 ~3 秒 exit 0、渲染端零输出。

## 常用位置速查

- 主进程入口 `src/main/index.js`（bootstrap ctx 装配）；IPC = `register-ipc.js` 编排 → `ipc-player/media/window/app` 四域
- 窗口管理 `windows.js` · mpv 启动 `mpv-launch.js` · 解码编排 `media-pipeline.js` · 播放控制 `play-control.js` · 双窗口几何 `window-sync.js`
- 渲染端入口 `src/renderer/app.js` · 输入 `input.js` · 主进程事件 `app-events.js` · 诊断 `app-diagnostics.js` · 面板 `panels/`（settings 877 行最大）
- 协议契约 `src/shared/protocol.js`（已 @ts-check）+ `types.d.ts`；测试 `test/unit/`（node:test）

## 拆分新模块（如需要）

按 ADR-0004：**按领域拆，不按行数**。单职责大文件（smoke-test/settings/mpv-backend）不拆。
`tools/split-*-extract.js` 是手术脚本模板（块边界断言 + 代码区词法器替换 + 裸标识符自检）；
拆完必跑 `tools/scan-reverse-leaks.js` 双向扫描 + 冒烟回归。

## 协作风格

- 用户偏好：给推荐方案后**直接执行**，用户会打断纠正；不要反复确认。
- UI 审美要求高：渐变/通透/精致，拒绝纯色块；UI 先出 HTML 原型确认再落地。
- 音视频听感类验证必须由用户试听确认（准备好对照选项再问）。
