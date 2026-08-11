# B：播放列表拖拽排序 + 缩略图

已按"先做 B 再做 A"的顺序完成 B 部分。

## 交付内容
- **缩略图生成**（`src/main/ffmpeg/thumbnail.js`，新建）：ffmpeg 抽帧 → base64 JPEG，按 `路径|大小|修改时间` 哈希落盘缓存到 `userData/thumbs/`，纯音频/无视频流返回音频占位标记。
- **IPC**：`preload.js` 暴露 `getThumbnail`；`index.js` 注册 `app:thumbnail` handler。
- **拖拽重排 + 缩略图渲染**（`src/renderer/app.js`）：播放列表条目可拖拽排序，重排后修正当前播放索引并持久化；单击/双击播放；"最近播放"列表同步显示缩略图。
- **样式**（`src/renderer/style.css`）：封面图、抓取光标、插入指示线、最近播放缩略图，沿用 DESIGN.md 的毛玻璃 + 青紫粉渐变。
- **提示**（`src/renderer/index.html`）：播放列表区加"拖动条目可调整播放顺序"tooltip。

## 验证
- `node --check` 全部通过（主进程 3 个 CJS 文件 + 渲染端 ESM 复制为 .mjs）。
- 同步 `.cache/app.mjs`（项目镜像约定）。
- 未跑真机 Electron 测试（沙箱起 Electron 会留孤儿进程，用户此前已抱怨），UI 交互行为需真机确认。

## 待做（下一步 A）
- ffmpeg 换 lgpl 构建，或切 Windows Media Foundation 解码后端（路线 A），以彻底去除 GPL 二进制并规避编解码器专利。
