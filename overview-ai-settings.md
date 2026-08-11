# 设置面板加入 AI 配置（Lumora）

## 用户需求

> "现在我需要你帮我在设置里加入 AI 的配置功能，让我可以通过 api 添加想加的 ai 来控制播放器"

即在「设置」里暴露 AI 后端配置（API Key / Base URL / 模型名），让用户能接任意 OpenAI 兼容大模型来控制播放器，并即时生效。

## 做了什么

在「设置」新增 **AI 助手** 分区，含三项配置输入 + 状态徽标 + 两个动作按钮：

| 控件                      | 绑定配置          | 说明                                                 |
| ----------------------- | ------------- | -------------------------------------------------- |
| API Key（`password`）     | `ai-api-key`  | 填了 → 调真实模型；不填 → 离线桩                                |
| API 地址 Base URL（`text`） | `ai-base-url` | 默认 `https://api.openai.com/v1`，可填 DeepSeek / 硅基流动等 |
| 模型名称（`text`）            | `ai-model`    | 默认 `gpt-4o-mini`                                   |
| 当前后端（状态徽标）              | —             | 「在线模型 · xxx」/「离线桩（未配置 Key）」                        |
| 重新加载 AI 后端（按钮）          | —             | 保存后点一下，热重载后端，无需重启                                  |
| 清空 AI 对话（按钮）            | —             | 重置对话上下文，保留已学习惯                                     |

## 关键设计：热重载（不重启、不丢对话）

原 AI 桥接在进程启动时就把 provider 烤死了，设置里改 Key 不会生效。本次改为：

- `assistant.js` 新增 `setProvider(p)` —— 仅切换底层 LLM，对话上下文 `messages` 保留。
- `ai-bridge.js`：provider 提到模块级 + 抽出 `buildProvider()`；新增 `reloadProvider()` 与 IPC `player:ai:reload`（重读 ai-* 配置 → 建新 provider → 替换 → 返回状态）。
- `preload.js` 暴露 `aiReload()`。
- 编辑任一 `ai-` 配置后自动 `reloadAiFromSettings()`；状态徽标在打开设置、构建面板、热重载后都会刷新。

## 5改动文件

- `src/renderer/app.js`：新增 AI 分区 + `ai-status` 渲染分支 + `refreshAiStatus()` / `reloadAiFromSettings()` + set-text 自动重载。
- `src/ai/assistant.js`：`setProvider()`。
- `src/main/ai-bridge.js`：模块级 provider + `reloadProvider()` + `player:ai:reload`。
- `src/main/preload.js`：`aiReload`。
- `src/renderer/style.css`：`.ai-status-badge`（on/off 双态）。
- `tools/ai-tests.js`：新增 D5，现 **37/37 通过**。

## 验证

- `node --check` 通过：assistant.js / ai-bridge.js / preload.js（CJS）+ app.js（按 ESM 校验）。
- `node tools/ai-tests.js` → 37/37 通过。
- 沙箱无 GPU/Electron，UI 交互（面板渲染、徽标刷新、热重载生效）需真机联调确认。

## 使用方式

打开设置（F2）→ AI 助手 → 填 API Key / 地址 / 模型 → 点「重新加载 AI 后端」→ 状态显示「在线模型」即生效。此后点 OSC 上 ✨ 按钮即可用自然语言让 AI 加载字幕/弹幕/调设置/调试。
