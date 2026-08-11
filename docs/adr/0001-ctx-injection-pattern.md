# ADR-0001：共享状态用 ctx 注入（setCtx getter/setter），而非直接 import

- 状态：已接受（2026-08，模块化拆分期间确立）
- 适用范围：主进程与渲染端所有领域模块

## 背景

拆分前，index.js（3119 行）持有全部共享状态（`win`/`videoWin`/`config`/`mpvBackend`/`pipeline`/`lastKnownTime`/`idleState`…）。拆分时每个模块都需要访问其中一部分。直接 `require` 宿主会形成循环依赖（宿主 require 模块、模块 require 宿主），且模块拿到的是**值快照**——`setPlaylist` 整体替换数组引用后旧引用即失效。

## 决策

- 每个模块导出 `setCtx(ctx)`（renderer 为 `setupXxx(ctx)`），bootstrap/boot 一次性注入。
- **共享可变状态一律 getter/setter**：`getWin()`/`setWin(v)`——单一事实源永远留在宿主，模块不持有副本。
- **纯函数依赖直接 require**：play-control/pip/windows/stores 等模块间直接 import，不走 ctx。
- 模块内用 `function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }` 访问器包裹，handler 代码保持可读。

## 权衡

- 代价：每个模块 ~15 行访问器样板；IDE 跳转/重构在 ctx 模式下失效；拼错 ctx 键运行时才炸（无类型系统）。
- 收益：无循环依赖；可测试（单测注入 mock ctx）；依赖显式化；状态生命周期清晰。
- 缓解：`src/shared/types.d.ts` 的 `IpcCtx` 接口文档化契约；未来渐进接 @ts-check 可让拼错键在编译期暴露。

## 后果

- 拆出的 15+ 主进程模块、13 个渲染端模块全部遵循此模式。
- 新模块按此模式写；**访问器读 `CTX.getX()` 则注入必须传 getter**（传值引用是已知坑，见 ADR-0002）。
