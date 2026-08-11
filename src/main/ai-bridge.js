'use strict';

/**
 * AI 助手主进程桥接（ai-bridge）
 * -------------------------------------------------------------
 * 在 main 进程托管 assistant（provider + tools + profile），
 * 并通过 IPC 与渲染端聊天面板通信：
 *   player:ai:chat    渲染端发来用户消息 → 跑编排循环 → 期间用
 *                     sendToRenderer('player:ai-event', {type,payload}) 流式推事件
 *   player:ai:reset   清空对话上下文（保留画像）
 *   player:ai:status  上报当前 provider / 是否已配置 key
 *
 * 后端鉴权：读 config 的 ai-api-key / ai-base-url / ai-model，
 * 未配置 key 时 provider 自动回退离线桩（见 provider.createProvider）。
 *
 * 依赖通过 deps 注入，便于将来替换或测试；本文件自身不直接 require 渲染端。
 */

const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const { createProvider } = require('../ai/provider');
const { createProfile } = require('../ai/profile');
const { createTools } = require('../ai/tools');
const { createAssistant } = require('../ai/assistant');
const { autoLoadSubtitle, autoLoadDanmaku } = require('./media-apply');

let assistant = null;
let profile = null;
let provider = null; // 模块级持有，便于热重载与状态上报读最新实例

/**
 * 画像持久化到 userData/ai-profile.json；electron 不可用时退化为内存画像。
 * @returns {object} profile 实例
 */
function makeProfile() {
  let store = null;
  try {
    const dir = app.getPath('userData');
    const file = path.join(dir, 'ai-profile.json');
    store = {
      read: () => {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          return null;
        }
      },
      write: (obj) => {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify(obj, null, 2));
        } catch {
          /* 落盘失败不影响运行 */
        }
      },
    };
  } catch {
    store = null;
  }
  return createProfile({ storage: store });
}

/**
 * 初始化桥接。
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.Subtitles
 * @param {object} deps.Danmaku
 * @param {Function} deps.sendToRenderer
 * @param {Function} deps.getCurrentInfo 返回当前媒体信息（含 path）
 * @param {Function} deps.getState 返回播放状态快照
 * @param {boolean} deps.useMpv
 * @param {Function} deps.subAdd mpv 加载外部字幕路径
 */
function initAiBridge(deps) {
  const { config, Subtitles, Danmaku, sendToRenderer, getCurrentInfo, getState, useMpv, subAdd } = deps;

  profile = makeProfile();

  // 从配置构造 provider；抽成函数便于用户在设置里改 Key 后热重载。
  function buildProvider() {
    const rawKey = config.get('ai-api-key') || '';
    return createProvider({
      apiKey: typeof rawKey === 'string' ? rawKey.trim() : rawKey,
      baseUrl: (config.get('ai-base-url') || '').trim(),
      model: (config.get('ai-model') || '').trim(),
    });
  }
  provider = buildProvider();

  const mediaDeps = { Subtitles, Danmaku, sendToRenderer, config, useMpv, subAdd };

  const tools = createTools();

  assistant = createAssistant({
    provider,
    tools,
    profile,
    buildCtx: () => ({
      profile,
      getCurrentFile: () => (getCurrentInfo() && getCurrentInfo().path) || null,
      // 字幕/弹幕工具复用 media-apply（与设置里的自动加载同源）
      downloadSubtitle: (file, lang) => autoLoadSubtitle(getCurrentInfo(), mediaDeps, { lang }),
      autoMatchDanmaku: (file, source) => autoLoadDanmaku(getCurrentInfo(), mediaDeps),
      setSetting: (key, value) => {
        config.set(key, value);
        sendToRenderer('player:setting-changed', { key, value });
      },
      getState,
      getDiagnostics: getState,
      // 把命令转发到渲染端命令总线（runCommand → player.command），开放全部播放控制
      runCommand: (args) => sendToRenderer('player:command', args),
      sendNotice: (t) => sendToRenderer('osd', { text: t }),
    }),
  });

  /**
   * 热重载 provider：重新读取 ai-* 配置并替换底层 LLM 后端。
   * 对话上下文保留（仅切换后端）；返回新 provider 的元信息供渲染端刷新状态。
   * @returns {{ok:boolean, provider:string, hasKey:boolean, model:string}}
   */
  function reloadProvider() {
    provider = buildProvider();
    console.log('[lumen][ai] provider 重载:', provider.constructor.name,
      'model:', config.get('ai-model'), 'hasKey:', !!config.get('ai-api-key'));
    if (assistant && assistant.setProvider) assistant.setProvider(provider);
    const hasKey = !!config.get('ai-api-key');
    return {
      ok: true,
      provider: provider.constructor.name,
      hasKey,
      model: config.get('ai-model') || (provider.apiKey ? provider.model : 'stub'),
    };
  }

  ipcMain.handle('player:ai:reload', async () => reloadProvider());

  ipcMain.handle('player:ai:chat', async (_e, { text } = {}) => {
    if (!text) return { ok: false, error: 'empty' };
    console.log('[lumen][ai] chat 收到消息:', text.slice(0, 80));
    // 本次对话临时挂载监听，结束后卸载，避免监听器堆积
    const off = assistant.on((type, payload) => {
      console.log('[lumen][ai] event:', type, JSON.stringify(payload).slice(0, 120));
      sendToRenderer('player:ai-event', { type, payload });
    });
    try {
      const res = await assistant.send(text);
      console.log('[lumen][ai] chat 完成, rounds:', res.rounds, 'text:', (res.text || '').slice(0, 80));
      return { ok: true, text: res.text, rounds: res.rounds };
    } catch (e) {
      console.error('[lumen][ai] chat 异常:', e.message);
      return { ok: false, error: e.message };
    } finally {
      off();
    }
  });

  ipcMain.handle('player:ai:reset', async () => {
    assistant.reset();
    return { ok: true };
  });

  ipcMain.handle('player:ai:status', async () => ({
    ok: true,
    provider: provider.constructor.name,
    hasKey: !!config.get('ai-api-key'),
    model: (config.get('ai-model') || '').trim() || (provider.apiKey ? provider.model : 'stub'),
  }));

  /**
   * 获取可用模型列表：调用 OpenAI 兼容的 /v1/models 端点。
   * 返回 {ok, models:[{id}], error}；models 为按 id 排序的模型 ID 数组。
   */
  ipcMain.handle('player:ai:fetch-models', async () => {
    const apiKey = (config.get('ai-api-key') || '').trim();
    const baseUrl = (config.get('ai-base-url') || '').trim();
    if (!apiKey) return { ok: false, error: '未配置 API Key，请先填写' };
    if (!baseUrl) return { ok: false, error: '未配置 API 地址 (Base URL)' };

    // 拼接 models 端点：去掉末尾斜杠，追加 /models
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        let errMsg = `HTTP ${res.status}`;
        try { const j = JSON.parse(txt); if (j.error && j.error.message) errMsg = j.error.message; } catch {}
        return { ok: false, error: errMsg };
      }
      const data = await res.json();
      // OpenAI 格式：{ data: [{ id, ... }, ...] }
      const raw = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      const models = raw
        .map((m) => (typeof m === 'string' ? m : m && m.id ? m.id : null))
        .filter(Boolean)
        .sort(); // 字典序排列方便查找
      if (!models.length) return { ok: false, error: '接口返回了空的模型列表' };
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  console.log('[lumen][ai] bridge ready, provider=' + provider.constructor.name);
}

module.exports = { initAiBridge };
