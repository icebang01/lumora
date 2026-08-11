# Lumora 自动更新功能（概述）

> 更新源：GitHub Releases ｜ 行为：发现后自动下载，就绪后弹窗确认重启安装

## 一、做了什么

为 Lumora 接入 `electron-updater`，实现「未来发布版本自动获取并安装」的能力。整套改动遵循现有主进程 ctx 注入 + IPC 域拆分的架构，未触碰任何既有播放/解码逻辑。

### 新增 / 修改文件

| 文件 | 改动 |
|---|---|
| `src/main/updater.js` | **新增**。封装 `electron-updater`：`setup()` / `checkForUpdates()` / `installUpdate()` / `getState()`。dev 模式（`app.isPackaged===false`）自动禁用并通知渲染端；打包版启动 3s 后静默检查一次；`autoDownload=true`、`autoInstallOnAppQuit=false`（下载后等用户确认）。 |
| `src/main/ipc-updater.js` | **新增**。注册 `updater:get-state` / `updater:check` / `updater:install` 三个 IPC handler。 |
| `src/main/register-ipc.js` | 编排器引入并注册 `updaterIpc`。 |
| `src/main/index.js` | bootstrap 中 `updater.setCtx({getWin, sendToRenderer})` + `updater.setup()`。 |
| `src/main/preload.js` | `INBOUND` 白名单加 `updater:status` / `updater:progress`；`lumen` 暴露 `checkForUpdates` / `installUpdate` / `getUpdateState`。 |
| `src/renderer/panels/settings.js` | 「关于」分区新增「软件更新」行：检查更新按钮 + 状态文本；下载完成按钮变「重启并安装」；打开面板时拉取当前状态；全局监听 `updater:status`/`updater:progress` 实时刷新。 |
| `src/renderer/style.css` | `.update-status` 状态文字样式（busy/ok/error/muted）。 |
| `package.json` | dependencies 加 `electron-updater`；devDependencies 加 `electron-builder`；scripts 加 `dist` / `release`；`build.publish:[{provider:"github"}]`；`build.files` 加 `node_modules/**/*`（否则运行时依赖不会被打包）。 |
| `.github/workflows/release.yml` | **新增**。tag `v*` 触发，windows-latest 构建 NSIS 并发布到 GitHub Releases。 |

### 数据流

```
主进程 updater.js ──autoUpdater 事件──▶ sendToRenderer('updater:status'|'updater:progress')
        │                                         │
        ▼ (ipcRenderer.invoke)                    ▼ (preload INBOUND → window.lumen.on)
ipc-updater.js ◀── updater:check / install ── 设置面板「软件更新」行
```

## 二、用户看到的交互

- **打包版启动后**：后台自动检查一次；有更新则静默下载。
- **下载完成**：设置 → 关于 → 「软件更新」显示「vX 已下载，可重启安装」，按钮变「重启并安装」；同时观影中弹一次 OSC 提示（不打断）。
- **手动检查**：设置 → 关于 → 点「检查更新」，状态行实时显示「检查中… / 发现新版本… / 已是最新 / 出错」。
- **开发模式**（`electron .`）：更新不可用，状态行固定显示「开发模式，更新不可用」——属预期。

## 三、你需要补的两件事（发布前置）

1. **GitHub Token**：仓库 `Settings → Secrets → Actions` 加 `GH_TOKEN`，权限 `contents:write`。CI 用它把安装包发布到 Releases。
2. **（可选）代码签名**：Windows 无签名也能更新（仅 SmartScreen 警告）；若想无警告，配 `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` 两个 Secrets（仓库 Secrets）并在 `release.yml` 去掉对应注释。macOS 必须有 Developer ID 证书，否则 updater 拒装。

## 四、怎么发一个版本

```bash
# 本地
npm run dist          # 仅打包，不发布（用于自测安装包）
# 发布：改 version → 提交 → 打 tag → 推送
npm version patch     # 0.1.0 → 0.1.1
git push && git push --tags
# CI 自动构建 NSIS 安装包并发布到 GitHub Releases，
# 老用户下次启动会自动检测到并下载安装
```

> 注：electron-builder 据本地 git remote 推断 Releases 的 owner/repo，确保 `git remote -v` 指向正确的 GitHub 仓库即可。

## 五、验证状态

- `lint:syntax`：全文件 OK（沙箱里退出码偶发 1，非真实失败）。
- `lint:imports`：通过，无漏 require。
- `test:unit`：57/57 通过。
- `typecheck`：通过。
- `test:smoke`：**22/22 通过**（首跑因一个未落盘的模块级 `let` 声明报 ReferenceError，补回声明后通过）。
- **未提交**：本地改动堆积，孤儿仓库需 `git push --force-with-lease origin main`，待你确认后执行。
