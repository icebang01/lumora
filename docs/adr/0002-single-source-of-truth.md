# ADR-0002：单一事实源——共享可变状态留在宿主，模块只拿 getter/setter

- 状态：已接受（2026-08）
- 关联：ADR-0001

## 背景

`win`/`videoWin`/`mpvBackend`/`pipeline`/`lastKnownTime`/`idleState` 是宿主（index.js）的模块级变量，被 sendToRenderer/register-ipc/mpv 后端/播放控制多处直接引用。若模块各自复制一份引用，出现两份"真相"，同步即地狱。

实测反例：`setPlaylist()` 整体替换数组引用——任何持有旧引用的模块在替换后读到的是过期数组（app-events.js 拆分时踩中，必须走 getter 代理）。

## 决策

- 可变共享状态**只在宿主声明**，模块通过 `getXxx()`/`setXxx(v)` 访问。
- 宿主 `setCtx` 里传箭头函数闭包宿主变量：`setMpvBackend: (v) => { mpvBackend = v; }`。
- 渲染端同规则：`playlist`/`playlistIndex`/`danmakuRenderer` 走 getter；player/osd 等代理对象除外（见 ADR-0001 的 Proxy 约定）。

## 权衡

- 代价：每次访问多一层函数调用（可忽略）；模块读代码时要回宿主查 setCtx 才知道状态从哪来。
- 收益：任何时刻只有一个真相；teardown/resync 等跨模块流程不需要同步多份引用；测试注入可控。

## 后果

- windows.js / register-ipc / ipc-* / play-control / mpv-launch / media-pipeline 全部遵循。
- 错误形态（已踩）：访问器写 `CTX.getKeybinds ? CTX.getKeybinds()` 而注入传了**值**（`keybinds: keybinds`）→ 运行时 `CTX.getKeybinds` 为 undefined → 返回 null → TypeError。注入必须与访问器一致。
