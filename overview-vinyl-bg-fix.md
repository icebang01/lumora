# 经典黑胶模式渲染图素材背景修复

## 问题
用户截图显示 `style-vinyl` 模式下，唱机底座和唱臂 PNG 素材带有透明棋盘格背景，与浅色舞台背景严重不融合，看起来像「没抠图」。

## 根因
ImageGen 生成的 `base.png` / `tonearm.png` 保留了透明 alpha 通道，在 Electron 本地文件缓存下透明区域显示为棋盘格。

## 修复
1. 用 `tools/fill-bg.py` 把两张 PNG 的透明区域 alpha 合成到应用同款浅灰背景 `#f0f4f8`，输出为无 alpha 的 RGB PNG。
2. `src/renderer/index.html`：
   - 素材 URL 加 `?v=2` 强制刷新缓存；
   - CSS 缓存 `?v=45`→`?v=46`。

## 提交
- 本地 commit：`10562b7`
- 远端：Contents API 推送成功（github.com:443 不通）

## 门禁
lint:syntax 145/145、lint:imports OK、test:unit 111/111、typecheck 退出 0、pre-commit 4/4 全过。

## 验证
请彻底杀掉 Lumora 所有进程（含托盘）后重新启动，以刷到 `?v=46` 和新素材 `?v=2`。
