# Lumen 播放器 — 全屏与键位面板修复

## 修复内容

### 1. F 键全屏后无法退出

**问题**：按 `F` 可进入全屏，再按一次无法退出全屏。

**根因**：
- 底层 `videoWin`（mpv 宿主窗口）默认可接收焦点，进入全屏后被放大到整屏，可能抢走 HTML UI 层的键盘焦点。
- `window:state` 事件回调会再次调用 `windowCommand('fullscreen')`，存在冗余窗口指令往返。

**修复**：
- `src/main/index.js`：`videoWin` 创建时设置 `focusable: false`，并在全屏切换后主动 `win.focus()` 把焦点抢回 UI 层。
- `src/renderer/core/player.js` 与 `src/renderer/core/mpv-player.js`：`setProperty('fullscreen')` 在 `silent=true` 时不再重复调用 `window.lumen.windowCommand`。

### 2. 键位速查面板无法拖动/关闭

**问题**：按 `?` 打开键位速查面板后，面板无法拖动，关闭按钮点不动。

**根因**：`#idle-screen` 设置了 `-webkit-app-region: drag`，但 `#keymap-panel` 及其内部元素没有声明 `-webkit-app-region: no-drag`，导致整个面板被操作系统当作窗口拖动区处理。

**修复**：
- `src/renderer/index.html`：键位面板改为 `.keymap-backdrop` + `.keymap-window` 结构，头部加 `draggable` 类。
- `src/renderer/style.css`：面板整体脱离 drag 区域；加背景遮罩、拖拽光标、窗口 resize 自动居中/边界约束。
- `src/renderer/ui/keymap.js`：新增拖拽逻辑、遮罩点击关闭、`onHide` 回调。
- `src/renderer/app.js`：新增 `toggleKeymap()` 管理 `body.keymap-open` 类；与 licenses/settings 面板互斥；Esc 关闭走统一入口。
- `src/main/index.js`：新增 `--test-keymap` 自动化回归测试。

## 修改文件

| 文件 | 改动 |
|------|------|
| `src/main/index.js` | videoWin `focusable: false`；全屏切换后 focus UI；新增 `--test-keymap` |
| `src/renderer/core/player.js` | `setProperty('fullscreen')` silent 时不调 windowCommand |
| `src/renderer/core/mpv-player.js` | 同上 |
| `src/renderer/index.html` | 键位面板结构改为 backdrop + window |
| `src/renderer/style.css` | 键位面板 no-drag、draggable、resize 约束 |
| `src/renderer/ui/keymap.js` | 拖拽、关闭、onHide 回调 |
| `src/renderer/app.js` | toggleKeymap()、互斥、Esc 处理 |

## 测试结果

```
=== 键位速查面板测试 ===
[keymap-test] {"ok":true,"panelVisible":false,"bodyHasClass":true,"rowCount":73,"groupCount":17,"closed":true,"bodyClassAfterClose":false}
[keymap-test] 结果: PASS
```

回归测试：
- `--test-open-settings` PASS
- `--test-dialog-cancel` PASS
- `--test-settings-dblclick` PASS
- `--test-settings-apply` PASS

已重启 Lumen 供真机验证全屏退出与键位面板交互。
