# style-vinyl 黑胶唱机质感精修

## 问题
用户反馈经典黑胶模式「不太好看」：底座太平、转盘不像黑胶唱片、唱臂像细线、右侧文字对比度低。

## 改动

### 1. 结构拆分：`银色转盘外框 + 黑胶唱片 + 中心封面`
- `src/renderer/index.html`：新增 `.ms-vinyl` 黑胶唱片层，嵌套在 `.ms-platter` 内，与 `.ms-cover` 分离。
- `src/renderer/style.css`：
  - `.ms-platter`：银色金属凹陷外环，不再旋转。
  - `.ms-vinyl`：带同心纹路的高光黑胶唱片，单独旋转。
  - `.ms-cover`：中心圆形专辑封面标签，占唱片 46%。

### 2. 底座立体感
- 加径向高光 + 内凹阴影，避免「一块扁平白块」的感觉。

### 3. 唱臂金属化
- 高度从 3px 加到 10px，使用金属渐变。
- 增加支点圆盘和唱头细节。
- 暂停 `rotate(22deg)`，播放 `rotate(42deg)` 落针到唱片外圈。

### 4. 右侧文字对比度
- 标题：颜色 `#111827`，加粗。
- 歌手/专辑：不透明度提升。
- 歌词默认/高亮/翻译：颜色更深，易读性更好。

### 5. 缓存
- CSS 缓存 `?v=49` → `?v=50`。

## 推送
- 提交：`d19b704`
- github.com:443 不通，走 Contents API 推送成功：
  - `src/renderer/index.html` → b95c996
  - `src/renderer/style.css` → a3e0a9d

## 门禁
- lint:syntax 145/145
- lint:imports OK
- test:unit 111/111
- typecheck 通过
- pre-commit 4/4

## 验证
彻底杀进程重启 Lumora，切到「经典黑胶」模式查看。如唱臂角度/封面大小/金属感仍有偏差，可继续截图微调。
