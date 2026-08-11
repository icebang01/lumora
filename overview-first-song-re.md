# 首曲播放结束修复说明

## 问题
首次启动 Lumora 后拖入第一首音乐，立刻显示「播放结束」并弹回主页；第二首起正常。

## 根因演变
1. `d8343b2` 在 `bufferedSeconds` 计入 `_pending`（推模型补丁），但首曲 AudioContext 就绪前回压信号仍迟到，ffmpeg 以 ~200x 实时速度 dump 完整文件 → stdout 抽空 → EOS。
2. `7c968ed` 尝试改成拉模型（spawn 即 pause stdout），但 **Windows 上 `child_process.stdout.pause()` / `readable+手动 read` 均无法阻塞 ffmpeg 写入端**，ffmpeg 3 秒内仍把整文件解完并积压在 Node 内部缓冲，一 resume 即瞬间 EOS。

## 最终修复（`f62475c`）
改用 ffmpeg `-re` 选项限制音频输出速度：
- 仅对**音乐文件主声部**（`audioOnly=true && voice===0`）在 `-i` 前加 `-re`。
- 副声部（交叉淡入淡出预滚）不加，避免预滚过慢。
- 视频兜底路径（`audioOnly=false`）不加。
- 回退 media-server 默认掐住与 `reapplyThrottle()`，恢复推模型。

这样首曲时 ffmpeg 按实时速度输出，给渲染端足够时间创建 AudioContext、建立背压，不会瞬间 EOS。

## 验证
- Node 隔离复现：未加 `-re` 3s 内 ~100MB 并 exit=0；加 `-re` 后 6s 仅 ~5s 音频量，无 EOS。
- 门禁：lint:syntax 137/0、lint:imports OK、test:unit 111/111、typecheck 0、pre-commit 4/4。

## 提交
- 本地 commit：`f62475c`
- 远端：因 `github.com:443` reset，通过 `tools/push-contents.js` 把三文件镜像到 `main`。

## 复测注意
**必须彻底结束所有 Lumora/Electron 进程后再启动**，否则 Electron 单实例锁会让旧代码继续处理新文件，修复看不到。
