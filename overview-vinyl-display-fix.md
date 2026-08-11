# 修复经典黑胶模式内容完全空白

## 问题
切换到「经典黑胶」播放器样式后，界面只剩薄荷色背景和控制条：
- 没有白色唱机底座
- 没有银色转盘/唱片
- 没有右上角唱臂
- 右侧也没有曲目信息和歌词

## 根因
为了让黑胶元素不影响其它播放器样式，通用 CSS 写了：

```css
.ms-turntable-base,
.ms-tonearm { display: none; }
```

但 `#music-stage.style-vinyl` 下的覆盖规则只设置了定位、背景、阴影等属性，**没有显式覆盖 `display`**。因此黑胶样式下唱机底座和唱臂仍然被 `display: none` 隐藏，子元素（转盘、封面标签、中心轴孔）也一起消失。

## 修复
在 `src/renderer/style.css` 中给两个黑胶专属规则补上 `display: block;`：

```css
#music-stage.style-vinyl .ms-turntable-base { display: block; ... }
#music-stage.style-vinyl .ms-tonearm { display: block; ... }
```

同时把 `src/renderer/index.html` 的 CSS 缓存版本从 `?v=48` 升到 `?v=49`。

## 提交
- `4359412` fix(style-vinyl): 显式覆盖 .ms-turntable-base/.ms-tonearm 的 display:none，恢复唱机显示

## 推送
github.com:443 不通，走 Contents API 推送：
- `index.html` → `7460a33`
- `style.css` → `4ac3571`

## 门禁结果
- lint:syntax：145/145 通过
- lint:imports：通过
- test:unit：111/111 通过
- typecheck：通过
- pre-commit：4/4 通过

## 验证
彻底杀掉 Lumora 所有进程（含托盘）后重新启动，切换到经典黑胶样式，应能看到：
- 左侧白色圆角方形唱机底座
- 中心银色转盘 + 圆形封面标签
- 右上角银色唱臂（播放时落到唱片上）
- 右侧曲目信息 + 歌词

如果右侧文字区域仍为空，通常是因为当前没有载入带元数据的曲目；唱机部分应该已经恢复。
