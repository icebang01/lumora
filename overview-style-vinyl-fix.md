# 经典黑胶模式渲染修复（Task #256）

## 完成内容
- 修复了用户截图中「经典黑胶」模式变成"黑饼+铁丝唱臂"的问题。
- 唱片重构成"外圈黑胶纹路盘 + 中心圆形封面标签"：
  - 外圈用深色径向渐变 + repeating-radial-gradient 同心纹路，单独旋转。
  - 中心 `.ms-cover` 只占 36%，有封面时显示封面，无封面时显示 Lumora logo。
  - 保留顶部中心轴孔。
- 唱臂 PNG 放大到 44%，支点与角度重新对准底座右上角旋钮：
  - 暂停时 `rotate(34deg)`（托架位）。
  - 播放时 `rotate(-20deg)`（唱头搭到唱片外圈）。

## 修改文件
- `src/renderer/index.html`
  - 把 `.ms-note` 移入 `.ms-cover`。
  - 新增 `.ms-grooves` 旋转纹路层。
  - CSS 缓存 `?v=44`→`?v=45`。
- `src/renderer/style.css`
  - 重写 `#music-stage.style-vinyl` 下唱片、封面、唱臂的样式。

## 验证
- lint:syntax 145/145 OK
- lint:imports OK
- test:unit 111/111 pass
- typecheck 退出 0
- pre-commit 4/4 通过

## 提交与推送
- 本地 commit：`ff12a9c`
- github.com:443 不通，改用 Contents API 推送：`index.html`→`57add1f`，`style.css`→`75b64f1`
- 用户需杀干净 Lumora 所有进程（含托盘）后重启，才能看到 `?v=45` 新效果。
