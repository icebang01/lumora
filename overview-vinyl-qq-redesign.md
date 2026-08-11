# style-vinyl 黑胶模式按 QQ Music 参考图重绘

## 完成内容
- 完全放弃 ImageGen PNG 渲染图路线（水印、透明棋盘格、缓存失效无法根治）。
- 按用户提供的 QQ Music 参考图，用纯 CSS/SVG 重绘经典黑胶唱机：
  - 白色圆角方形底座 + 柔和投影
  - 凹陷银色金属转盘
  - 中心 52% 圆形专辑封面
  - 固定中心轴孔
  - 右上角银色唱臂（暂停 `rotate(26deg)`，播放 `rotate(48deg)` 落针到唱片标签区）
  - 薄荷渐变背景
  - 右侧歌词高亮改为青绿渐变

## 改动文件
- `src/renderer/index.html`：替换 `<img>` 为 `.ms-turntable-base` / `.ms-platter` / `.ms-cover` / `.ms-spindle` / `.ms-tonearm`；CSS 缓存 `?v=48`。
- `src/renderer/style.css`：重写 `#music-stage.style-vinyl` 全部唱机样式与歌词高亮色。
- 删除 `src/renderer/assets/turntable/base-v2.png` 与 `tonearm-v2.png`。

## 提交
- `2697993` feat(style-vinyl): 纯 CSS/SVG 重绘 QQ Music 同款白色唱机
- `67933fc` chore(assets): 删除废弃的 PNG 唱机/唱臂素材，改用纯 CSS/SVG 绘制

## 门禁
- lint:syntax 145/145
- test:unit 111/111
- typecheck 通过
- lint:imports 通过
- pre-commit 4/4 通过

## 推送
- 首次 push 被远端平行提交拒绝；fetch 后以本地为准 force-with-lease 推送成功；删除素材的 commit 正常 fast-forward 推送。

## 验证
- 请彻底杀掉 Lumora 所有进程（含托盘），再启动以刷到 `style.css?v=48`。
- 如唱臂角度、转盘金属感、封面大小仍需微调，直接截图即可继续迭代。
