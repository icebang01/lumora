# 🎬 Lumora

> GPU 加速、键盘驱动的现代化媒体播放器 —— 基于 mpv（系统 / 硬件解码）+ Electron + WebGL2 渲染界面。

![platform](https://img.shields.io/badge/platform-Windows-blue)
![license](https://img.shields.io/badge/license-UNLICENSED-red)
![build](https://img.shields.io/badge/build-electron--builder-9cf)
![electron](https://img.shields.io/badge/electron-33-2b2b2b)

**Lumora** 是一台为「看得爽」而生的桌面播放器：把 mpv 的硬核解码能力、WebGL2 的丝滑界面，以及一套精致通透的设计语言（青→紫→粉渐变、毛玻璃）装进同一个窗口。面向影视、番剧、音乐与本地媒体库做了大量打磨，并内置自动更新。

## 📸 界面截图

> 以下图片是按 Lumora 设计语言（暗色、毛玻璃、青→紫→粉渐变）生成的示意预览；正式对外前建议替换为真实运行截图。

| 视频播放主界面 | 音乐黑胶模式 | 设置 / 均衡器 |
|---|---|---|
| ![video playback](./docs/screenshots/player.png) | ![music vinyl](./docs/screenshots/music.png) | ![settings eq](./docs/screenshots/settings.png) |

## ✨ 功能特性

- **全格式播放**：`mp4` `mkv` `webm` `mov` `ts` `m2ts` `flv` `wmv` `avi` … 以及 `mp3` `flac` `aac` `wav` `ogg` `opus` 等音轨；通过文件关联一键打开。
- **硬解与画质**：硬件解码（hwdec）、HDR、ICC 色彩管理、滤镜与色调映射、去色带。
- **精准控制**：播放 / 暂停 / seek / 倍速 / 音量、A-V 音画同步、帧步进、章节与书签。
- **双引擎切换**：音乐模式走 ffmpeg 纯音频管线，视频模式懒启动 mpv；根据内容自动选择最合适的后端。
- **弹幕**：弹弹 play / B 站 / 聚合代理，开箱自动匹配。
- **投屏**：DLNA v1 + Chromecast（CASTV2 / mDNS）投屏到局域网设备。
- **字幕**：双字幕轨 + 同步。
- **截图**：单张 / 序列截图。
- **画中画 & 全屏**：原生 PiP，沉浸式全屏。
- **网络串流**：直接打开 URL 播放。
- **鼠标手势 & 快捷键**：`F1` 内置键位速查。
- **专业媒体信息面板**：文件 / 显示 / 帧时间 / 视频 / 音频 / 渲染管线 / 传输 / 环境全量统计。
- **自动更新**：打包版启动后静默检查 GitHub Releases，后台下载，就绪后弹窗确认重启安装（不打断观影）。

> 实验性：MediaFoundation 引擎（Windows 原生解码）在演进中；DLNA 接收端（DMR）暂未实现。

## 🚀 快速开始

```bash
git clone https://github.com/icebang01/lumora.git
cd lumora
npm install
npm run fetch-deps   # 拉取 ffmpeg 到 bin/（首次运行需要）
npm start            # 或 npm run dev 进入开发模式
```

> 需要本机已安装 mpv（系统解码后端）。开发模式下「自动更新」不可用，属预期行为。

## ⌨️ 常用快捷键

| 按键 | 功能 |
|---|---|
| `空格` | 播放 / 暂停 |
| `←` `→` | 快退 / 快进 |
| `↑` `↓` | 音量 |
| `f` | 全屏 |
| `,` `.` | 上一帧 / 下一帧 |
| `i` | 媒体信息面板 |
| `F1` | 键位速查 |

> 以上为常用键位（大致遵循 mpv 习惯），完整与可自定义键位请在播放器内按 `F1` 查看。

## 🛠️ 开发脚本

| 命令 | 说明 |
|---|---|
| `npm start` | 启动应用 |
| `npm run dev` | 开发模式（含调试） |
| `npm test` | 语法 + 单测 + 可选测试 + 类型检查 + 冒烟 |
| `npm run test:unit` | 单元测试（node:test） |
| `npm run test:smoke` | 冒烟测试 |
| `npm run test:gui` | GUI 自动化测试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run fetch-deps` | 拉取 ffmpeg 到 bin/ |
| `npm run dist` | 构建安装包（不发布） |
| `npm run release` | 构建并发布到 GitHub Releases |

## 📦 构建与发布

```bash
npm run dist     # 本地构建 NSIS 安装包
npm run release  # 构建并发布到 GitHub Releases
```

发布流程：打 `v*` tag 推送 → GitHub Actions 自动构建并发布（需要仓库 `GH_TOKEN` 且具备 `contents:write`）。

## 🧱 技术架构

- **Electron 33** 承载主进程与渲染进程
- **mpv** 作为解码 / 渲染后端（系统或 GPU 解码），通过本地 WebSocket 二进制通道传输帧与音频
- **WebGL2 + AudioWorklet** 负责界面合成与音频处理
- **electron-updater** 实现自动更新
- 主进程采用 `setCtx` 注入式共享状态，单一事实源留在宿主模块

## 🎨 设计语言

暗色沉浸界面，品牌主色 `#7c8cff`，青→紫→粉渐变，毛玻璃（`blur(22px)`）质感，圆角与 `cubic-bezier(0.16,1,0.3,1)` 缓动。

## 📁 项目结构（节选）

```
src/main/        主进程：窗口、解码编排、IPC、自动更新
src/renderer/    渲染进程：界面、OSC、面板、输入
src/shared/      主渲共享契约（protocol / 类型）
test/            单元 / 冒烟 / GUI 测试
```

## 📜 许可证

版权所有 © ICE Bang! —— **保留所有权利（UNLICENSED）**，当前未开放源码许可。

第三方组件按其各自许可分发：mpv（GPLv2+，聚合分发）、ffmpeg（LGPLv3，经 `fetch-deps` 获取 BtbN 构建）、electron-updater（MIT）等。

---

品牌：**ICE Bang!** · 为创作者而生的播放器
