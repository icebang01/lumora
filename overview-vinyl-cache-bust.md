# 经典黑胶模式棋盘格缓存根治

## 问题
上一版修复后用户仍看到棋盘格：Chromium 本地文件缓存继续持有旧透明 PNG，`?v=2` 未强制刷新。

## 修复（三重保险）
1. **文件重命名**：`base.png`→`base-v2.png`，`tonearm.png`→`tonearm-v2.png`，旧 URL 彻底失效。
2. **CSS 缓存 bump**：`style.css?v=46`→`?v=47`。
3. **背景色兜底**：给 `.ms-turntable-img`、`.ms-tonearm-img` 加 `background: #f0f4f8`，即使图片透明也看不到棋盘格。

## 辅助脚本
- `tools/restart-lumora.bat`
- `tools/restart-lumora.ps1`

一键：结束 Lumora 所有进程 → 清理 `%LOCALAPPDATA%\Lumora\Cache` 等缓存 → 启动 `dist\Lumora\Lumora.exe`。

## 提交
- 本地 commit：`61a843c`
- 远端：Contents API 推送成功（git push 因远端平行提交 stale info 失败）

## 门禁
lint:syntax 145/145、lint:imports、test:unit 111/111、typecheck、pre-commit 4/4 全过。

## 验证
运行 `tools/restart-lumora.ps1`（或 .bat）彻底重启并清缓存后查看效果。
