# Lumora 交互 / 流畅性测试报告（UX Bench）

> 生成时间：2026-08-06 · 沙箱 headless 环境（无 GPU）
> 配套交付：`tools/ux-bench.js`（自动化探针）、`docs/UX_TEST_CHECKLIST.md`（人工真机清单）

## 一、做了什么

按"使用与交互体验 + 流畅性"维度，新增了两样东西，补齐功能门禁覆盖不到的体验层：

1. **自动化探针 `tools/ux-bench.js`** —— 复用渲染端 `snapshot()` + 命令总线 `window.__lumen.run()`，自动采集延迟类/计数类指标并出分级评语。
2. **人工体验清单 `docs/UX_TEST_CHECKLIST.md`** —— 覆盖必须真机（GPU+音频+显示器）才能判断的项：真·60fps 画面流畅度、动画丝滑度、听感、HDR。

## 二、自动化探针结果（沙箱 headless 可测部分，真实数据）

| 指标 | 实测 | 评语 |
|---|---|---|
| 交互延迟 · 暂停 | 2 ms | 跟手 |
| 交互延迟 · 音量 +5 | 2 ms | 跟手 |
| 交互延迟 · 倍速 | 2 ms | 跟手 |
| 交互延迟 · 静音 | 3 ms | 跟手 |
| seek 命令延迟 →5s | 2 ms | 跟手 |
| seek 命令延迟 →10s | 4 ms | 跟手 |
| seek 命令延迟 →15s | 3 ms | 跟手 |
| JS 堆增长（60 次暂停切换） | +0.00 MB | 稳定，无泄漏信号 |
| 丢帧率 / avSync / 渲染 fps | N/A | mpv 模式无 WebGL → 需真机 ffmpeg 模式 |

**结论**：命令总线跟手度极佳（全部 <5ms，远低于「可接受」阈值 50ms）；交互压力下 JS 堆零增长，无内存泄漏信号。丢帧/音画同步/渲染吞吐三项因 mpv 模式无 GL，正确降级为 N/A。

## 三、探针自身修掉的两处 harness 缺陷（非产品 bug）

| 现象 | 根因 | 修法 |
|---|---|---|
| `cycle speed` 超时 | mpv `cycle speed` 是 no-op（`speed` 无 choice list）；UI 倍速按钮走的是另一套机制 | 探针改用 `set speed` |
| 三个 `seek` 超时 | 无 GPU 时 mpv 基于显示的 `time-pos` 冻结，无法观测 seek 生效 | 改绝对 seek + 冻结时钟检测，超时项标 `N/A(headless)` |

> 这两处最初会被误读成"产品 bug"，实则是测试命令写法和 headless 环境限制所致。

## 四、需真机复测的项（清单已覆盖）

- 真·画面帧率（ffmpeg+WebGL 模式 60fps 流畅度）
- seek 出首帧耗时（命令延迟已测，真·出帧渲染延迟需真机）
- OSC/设置面板过渡动画丝滑度、毛玻璃渲染开销
- 听感：音画同步主观对齐、倍速/seek 后无爆音、audio-only 降级
- HDR（HDR10/HLG）色调映射、长时间播放 RSS/堆增长稳态

## 五、建议下一步

1. **在你机器复跑**：`npm run lint:syntax && node tools/ux-bench.js <你的片源>`（加 `--ffmpeg` 或切 ffmpeg 模式可拿到丢帧/avSync/渲染 fps 真实值）。
2. **按 `docs/UX_TEST_CHECKLIST.md` 点着测** 上面第四项。
3. 可选：把冒烟「播放推进」断言由"单次采样"改为"轮询至 time-pos>0.3"增强抗抖动；补字幕模块单测（覆盖率短板）。
