# Lumora AI 助手 — 落地总览

为 Lumora 播放器注入**应用内 AI 助手**：自动搜索加载字幕、自动加载弹幕、学习用户习惯、一键设置/调试播放器。后端采用 **OpenAI 兼容接口**（GPT / DeepSeek / 通义 / 智谱 通吃），未填密钥时自动走**离线桩**，框架全程可跑可测。

## 架构

```
渲染端聊天侧栏              主进程桥                     能力层（既有）
┌────────────┐         ┌──────────────────┐        ┌─────────────────┐
│ ai-panel.js│─IPC──▶ │ ai-bridge.js     │───▶   │ subtitles.js   │
│ (聊天 UI)  │        │  hosted assistant│        │ danmaku.js     │
└────────────┘ ◀─event│  provider+tools  │        │ media-apply.js │
                player:ai-event          │  +profile        │ (灌入播放器)    │
                                         └──────────────────┘        └─────────────────┘
```

- **provider.js**：`OpenAIProvider`（真实 `/chat/completions`）+ `StubProvider`（离线桩，按关键词路由工具/文本）。`createProvider()` 按 `apiKey` 自动选；支持 `LUMORA_AI_*` 环境变量。
- **profile.js**：本地画像（`userData/ai-profile.json`），`summarize()` 把偏好编译进系统提示 → "学习用户习惯"。
- **tools.js**：`auto_subtitle / auto_danmaku / set_setting / debug_player / get_state / learn_preference`，依赖经 ctx 注入。
- **assistant.js**：ReAct 编排（system+画像 → chat → 工具调用 → 回灌 → 收尾），事件流 `user/tool/tool-result/assistant`，`maxToolRounds` 防呆。
- **media-apply.js**：从 `index.js` 抽出的字幕/弹幕"下载并灌入"胶水（mpv 走 `sub-add`，ffmpeg 走 cue 推送），原自动加载与 AI 工具共用。
- **ai-bridge.js**：主进程托管 assistant，注册 `player:ai:chat`（流式推 `player:ai-event`）/ `player:ai:reset` / `player:ai:status`。
- 渲染端：`ai-panel.js` + `index.html`(#btn-ai/#ai-panel) + `style.css`(玻璃拟态) + `app.js`(boot 调 initAiPanel)；`preload.js` 加 `player:ai-event` 白名单与 `aiChat/aiReset/aiStatus`。

## 新增/修改文件

| 文件 | 改动 |
|---|---|
| `src/ai/provider.js`、`profile.js`、`tools.js`、`assistant.js` | 新增：纯逻辑层（CJS，可 node 直测） |
| `src/main/media-apply.js` | 新增：字幕/弹幕应用胶水（抽出复用） |
| `src/main/ai-bridge.js` | 新增：主进程桥 + IPC |
| `src/main/index.js` | 自动加载改用 media-apply；bootstrap 调 initAiBridge |
| `src/main/config.js` | `ai-api-key`/`ai-base-url`/`ai-model` 进 DEFAULTS |
| `src/main/preload.js` | 加 AI 通道 |
| `src/renderer/ui/ai-panel.js`、`index.html`、`style.css`、`app.js` | 聊天侧栏 UI |
| `tools/ai-tests.js` | 新增：36 项无头测试 |

## 启用真实 AI

设置里填 `ai-api-key`（可选 `ai-base-url`/`ai-model`，默认 `gpt-4o-mini`）。未填则全程离线桩（仅按关键词路由，不联网）——便于开发联调。

## 测试

```
node tools/ai-tests.js   # 36/36 通过，退出码 0，stderr 空
```

覆盖 provider 选择与桩路由、画像读写与学习、工具执行与依赖注入、编排循环收敛与异常处理、media-apply 的 mpv/ffmpeg 双路径与逐源容错。

## 注意

- 渲染端 UI 与真机字幕/弹幕应用无法在沙箱（无 GPU/Electron）验证；逻辑层已单测。真机联调重点看 `player:ai-event` 流式渲染与 `media-apply` 灌入。
- 设置 UI 暂未加 AI 配置项（键已进 DEFAULTS，可后续在设置面板暴露）。
