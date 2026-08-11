# 投屏 v1（DLNA cast-out）— Block #5 实现总览

> 按用户"挨个进行"的顺序，投屏是最后一个真·功能缺口。本块只做 **DLNA 投出（cast-out）**，
> Chromecast（DIAL+castv2）与"投屏接收模式"本期不做，接口已留空（后续同构补 DIAL 分支即可）。

## 交付内容

把**本地文件 / 网络串流**投到局域网里的 DLNA 渲染器（智能电视 / 盒子）。

### 新增文件

| 文件 | 作用 |
| --- | --- |
| `src/main/cast/dlna.js` | DLNA/UPnP 控制点核心。SSDP M-SEARCH 发现 `MediaRenderer:1` + SOAP 控制 AVTransport / RenderingControl / ConnectionManager。**纯解析助手全部导出可单测**：`parseSsdpHeaders` / `isMediaRenderer` / `parseDeviceDescription` / `buildSoapRequest` / `parseSoapResponse` / `buildDidl` / `formatDuration` / `parseDuration`。`DlnaDiscovery`（DI 注入 `createSocket`）、`DlnaRenderer`（DI 注入 `httpRequest`）封装 play/pause/stop/seek/setVolume/setAvUri/getTransportInfo/getPositionInfo。`DlnaSoapError` 承载 SOAP fault。零三方依赖（仅 Node `dgram` + `http`）。 |
| `src/main/cast/file-server.js` | 投**本地文件**时，在局域网起一个临时静态服务（bind `0.0.0.0`，`getLanIp` 取局域网 IP），把文件暴露成 `http://<LAN IP>:<port>/cast`。正确 `Content-Type`（`resolveMime` 扩展名映射）+ `Accept-Ranges`（206 部分内容，拖动靠它）。**只服务当前这一个文件**，杜绝目录遍历 / 全盘暴露。 |
| `src/main/ipc-cast.js` | `CastManager`：发现 / 连接 / 投屏当前文件 / 投屏 URL / 暂停 / 继续 / 停止 / 跳转 / 音量 / 取状态。设备发现经 `sendToRenderer('cast:device')` 推渲染端，状态变更推 `cast:state`。`stopAll()` 供进程退出清理。遵循 `register-ipc` 模块化惯例。 |
| `src/renderer/panels/cast.js` | 渲染端投屏面板：设备发现列表 + 连接 + 投屏当前（本地文件走 `castPlayFile` / 网络 URL 走 `castPlayUrl`）+ 投屏任意 URL + 暂停/继续/停止/同步进度/电视音量/断开。复用 playlist 玻璃样式。 |
| `test/unit/dlna.test.js` | 16 项：SSDP/设备描述/SOAP/DIDL/duration 纯助手 + 注入假 socket 测 `DlnaDiscovery` + 注入假 http 测 `DlnaRenderer`。 |
| `test/unit/cast-file-server.test.js` | 6 项：MIME / LAN IP 选择 / Range 解析 + 真实 loopback 集成验证 200 / 206 / HEAD。 |

### 接线改造（沿用既有 ctx 注入 + 模块化惯例）

- `register-ipc.js`：引入 `castIpc` 并 `register(CTX)`。
- `index.js`：注入 `getManager`；`teardown()` 调 `m.stopAll()`（关发现 + 断连接 + 停文件服务）。
- `preload.js`：`cast*` 调用桥（`ipcRenderer.invoke('cast:*')`）+ 入站 `cast:device` / `cast:state` 加入白名单。
- `app.js` boot：`setupCast({ player, osd })` + `window.toggleCast` + 面板关闭/遮罩绑定。
- `context-menu.js`：右键菜单新增「投屏到设备…」入口。
- `index.html`：新增 `#cast-panel`（复用 playlist 玻璃骨架）。
- `style.css`：投屏面板控件样式 + `body.cast-open` 防穿透。

## 质量门禁

- 语法：改动 JS 逐文件 `node --check` 全 OK；渲染端 3 个 ESM 文件 `--input-type=module --check` 全 OK。
- 单测：**66/66**（原 44 → +22：dlna 16 + cast-file-server 6 + 历史 44）。
- typecheck：`tsc --noEmit` 干净（src/shared 契约层）。
- 冒烟：`test:smoke` 未在沙箱重跑（无 GPU / 测试窗需真实桌面会话，环境坑同前几块）。

## 提交与同步

- 本地 commit：`7cdff29`。
- 远端：13 个文件经 `tools/push-contents.js`（Contents API，孤儿仓库 + 443 不稳的可靠路径）推送，PUSH_RC=0。
- MEMORY.md：投屏从"完全缺失"改为"v1 完成"，新增 block#5 笔记，结论/单测计数同步；当日日志追加 block#5 段。

## 已知限制（v1）

1. **仅 DLNA 投出**：Chromecast / 接收模式未做（接口已抽象，后续按同构补 DIAL 分支）。
2. **本地文件投屏**要求 Lumora 与电视**同网段 LAN**，且渲染器支持 `http-get` 拉流（绝大多数 DLNA 电视满足）。
3. **无 GPU 沙箱无法自测真实画面**——代码与单测覆盖到 SOAP/发现/文件服务层，端到端需真机（电视）验证。

## 下一步建议

- 路线 A 合规：**Media Foundation 引擎**（去 GPL 二进制的前提，大工程，C++ N-API addon）。
- 或同构补 **Chromecast**（DIAL 发现 + castv2 加密通道），复用现有 `CastManager` 抽象。
