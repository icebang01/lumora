# 第三方许可与义务（THIRD_PARTY_LICENSES）

> 本文件是 Lumora 随附第三方组件的**完整许可汇总**。
> 应用内「开源声明」面板（F1 / Ctrl+, / 设置 → 关于 → 查看开源声明）仅列要点，完整版以本文件为准。
> 本文件**不是法律意见**；公开发布安装包前请过一遍 IP counsel。

---

## 0. Lumora 主程序许可

- `package.json` 的 `"license"` 字段为 `UNLICENSED`（保留所有权利，闭源专有分发）。
- 主程序以**独立子进程**方式调用 mpv / FFmpeg（`--wid` 嵌入 + 命名管道 / IPC），属"单纯聚合"（mere aggregation）。
- 主程序因此**不一定**被 GPL 传染；但无论是否传染，凡是随安装包分发的第三方二进制，都必须对该二进制本身履行其许可证义务（见下）。

---

## 1. mpv — 视频后端（独立进程）

| 项 | 内容 |
|---|---|
| 许可证 | **GPL v2-or-later**（部分源文件为 LGPL，但分发二进制因链接 GPL 版 FFmpeg 整体按 GPLv2+ 对待） |
| 当前随附版本 | **v0.41.0**（2026-08 打包构建） |
| 上游源码 | https://github.com/mpv-player/mpv |
| 对应源码（精确版本） | https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz |
| 官网 / 文档 | https://mpv.io |
| 完整许可证文本 | https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt |

**GPLv2 义务（分发即触发）：**
1. 随附本许可证全文（上方链接）。
2. 提供**对应版本的完整对应源码**（Corresponding Source）。
3. 若对 mpv 有任何修改，须公开修改并允许他人获取。
4. 不得对 mpv 施加额外的限制（如禁止反向工程用于调试）。

**我们对 mpv 的修改：**
- 未修改 mpv 源码，亦未重新编译 mpv。
- 仅以**命令行参数**调用：`--wid`（嵌入 Electron 窗口）、`--input-ipc-server`（JSON IPC）、`--hwdec=auto`（硬件解码）等。
- 因此 GPLv2 第 3 条（公开修改）在本项目中**无修改可公开**；第 2 条（提供对应源码）通过上方上游链接满足。

---

## 2. FFmpeg / ffprobe — 解封装与探测（独立进程 · 发布须为 LGPL 构建）

| 项 | 内容 |
|---|---|
| 许可证 | **LGPL v2.1 或 v3**（BtbN 发布构建含 `--enable-version3` → 实际为 **LGPLv3**；无 `--enable-gpl`、且 `--disable-libx264/265/xvid` 确认不含 GPL 编码器，故**不构成 GPLv2+**） |
| 目标构建 | **BtbN `ffmpeg-master-latest-win64-lgpl`**（见 `tools/fetch-ffmpeg.js`，`npm run fetch-deps` 拉取并自检；已验证：无 `--enable-gpl`、libx264/265/xvid 为 disabled） |
| 上游源码 | https://github.com/FFmpeg/FFmpeg |
| 完整许可证文本 | https://www.gnu.org/licenses/lgpl-3.0.txt（v3）/ https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt（v2.1） |

> ⚠️ **发布阻断项**：`bin/` 已被 `.gitignore` 忽略，仓库本身**不**随附任何 ffmpeg 二进制；但本地若未运行 `npm run fetch-deps`，工作树的 `bin/ffmpeg.exe` 可能仍是 gyan.dev **GPL** 构建（含 `--enable-gpl` 与 libx264/265/xvid 等 GPL 编码器），打包即触发完整 GPLv2+ 义务。
> 发布 / CI 打包前**必须**执行 `npm run fetch-deps`：脚本下载 BtbN LGPL 构建并覆盖 `bin/ffmpeg.exe` / `ffprobe.exe`，且会自检确认无 `--enable-gpl`、无 GPL 编码器后才算合格；替换确认后再 `electron-builder` 打包。

**LGPL v2.1 义务（相对 GPL 更轻）：**
1. 随附 LGPL 许可证全文。
2. 提供 FFmpeg 的**源码要约**（可指向官方仓库 + 你所用提交/版本）。
3. 须允许用户**替换**所链接的 FFmpeg 库（提供重链接所需信息 / 目标文件）。
4. 未修改 FFmpeg 源码、未静态链接其代码（以独立子进程 + 文件管道方式调用）→ 义务更轻。

**注意事项：**
- 若未来为支持某格式而启用 GPL 编解码器（如某些滤镜、libx264 的 GPL 变体），FFmpeg 部分将整体升为 **GPLv2+**，届时须按 §1 的 GPL 义务履行，而不能仅按 LGPL 处理。
- 拉取方式：`npm run fetch-deps`（见 `tools/fetch-ffmpeg.js`），须确保所下载构建为 **lgpl** 变体。

---

## 3. Electron — 应用框架

| 项 | 内容 |
|---|---|
| 许可证 | **MIT** |
| 上游源码 | https://github.com/electron/electron |
| 完整许可证文本 | https://opensource.org/licenses/MIT |

Electron 运行时同时捆绑以下组件，其许可随附保留：
- **Chromium**（BSD-style / 多许可，含 Google 专利授予条款）
- **Node.js**（MIT）
- **V8**（BSD）

均通过 Electron 发行包一并随附，无需单独额外动作（MIT/BSD 仅需保留版权与许可声明）。

---

## 4. ws — WebSocket 库（运行时依赖）

| 项 | 内容 |
|---|---|
| 许可证 | **MIT** |
| 上游源码 | https://github.com/websockets/ws |
| 完整许可证文本 | https://opensource.org/licenses/MIT |

---

## 5. 其他 npm 依赖

| 包 | 用途 | 许可证 |
|---|---|---|
| `electron`（devDependency） | 开发/打包 | MIT（见 §3） |
| `ws`（dependency） | WebSocket | MIT（见 §4） |

> 打包时 `electron-builder` 可能引入额外传递依赖；发布前请以 `npm ls` 输出重新核对并补充本表。

---

## 6. 编解码器专利（GPL/LGPL 均不覆盖）

GPL/LGPL 解决**代码版权**，不解决**专利**。以下格式的解码器在部分司法辖区分发需专利许可：

- **H.264 / AVC** — Via LA / MPEG LA 专利池
- **AAC** — Via LA
- **HEVC / H.265** — Access Advance（HEVC Advance）专利池
- **AV1** — 免专利费（AOMedia），但仍建议确认

**Lumora 的对策：**
- 当前路线（聚合 mpv/FFmpeg）**自带解码器**，因此**你**承担上述专利风险。
- 长期路线：迁移到 **Windows Media Foundation / DirectShow**（系统编解码器），将专利责任落在微软授权范围内，并彻底移除 GPL 二进制（见 `COMMERCIALIZATION.md` §1 路线 A）。
- 在 EULA 中明确"本软件调用系统/第三方编解码能力"，并将 HEVC 等付费格式设为可选项。

---

## 7. 合规清单（发布前必须勾选）

- [x] `package.json` license 字段修正为 `UNLICENSED`（闭源专有）
- [x] 应用内「开源声明」面板（F1 / Ctrl+, / 工具栏「开源声明」按钮）
- [x] 本文件 `THIRD_PARTY_LICENSES.md`
- [x] mpv 版本锁定 **v0.41.0**（GPLv2+）；精确源码见 §1
- [x] **[发布阻断 · 已执行]** `npm run fetch-deps` 已将 `bin/ffmpeg.exe`/`ffprobe.exe` 由 gyan **GPL** 构建（8.1.1）替换为 **BtbN LGPLv3** 构建（自检无 `--enable-gpl`、libx264/265/xvid 为 disabled）。⚠️ 该替换**仅在工作树**；仓库提交内仍是 GPL 占位构建，故**干净克隆 / CI 打包前必须再跑一次 `npm run fetch-deps`**，切勿直接打包提交的 GPL 二进制。
- [x] 提供 mpv / FFmpeg 的**对应源码链接与版本号**（见 §1 / §2）
- [ ] 商标 "Lumora" 检索与命名决策（见 `COMMERCIALIZATION.md` §4）
- [ ] EULA 中编解码器专利声明
- [ ] 过 IP counsel 复核
