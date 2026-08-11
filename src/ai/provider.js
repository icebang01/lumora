'use strict';

/**
 * LLM Provider 抽象层
 * -------------------------------------------------------------
 * 设计目标：让 Lumora 的 AI 助手后端可插拔。
 *   - OpenAIProvider：调用 OpenAI 兼容的 /chat/completions
 *     （GPT / DeepSeek / 通义千问 / 智谱 等，仅 base_url + api_key 不同）。
 *   - StubProvider：离线桩，按关键词把用户意图路由到工具或文本应答，
 *     无任何网络依赖，便于开发期联调与单元测试。
 *   - createProvider(opts)：根据是否提供 apiKey 自动选择实现；
 *     未配置 key 时回退到离线桩，保证框架/工具/UI 全程可跑。
 *
 * 归一化输出形状（两种实现一致）：
 *   { role: 'assistant', content: string, toolCalls: [{ id, name, arguments }] }
 */

/**
 * 把 OpenAI 原始 message 归一化成统一形状。
 *
 * 注意：toolCalls 使用内部简化格式 {id, name, arguments}，
 * 在回灌到 messages 数组发回 API 前，必须通过 toWireToolCalls()
 * 转回 OpenAI 线格式（含 type + function 嵌套），否则 DeepSeek 等
 * 严格校验的 API 会报 "missing field 'type'" 错误。
 * @param {object} msg OpenAI choices[0].message
 * @returns {{role:string, content:string, toolCalls:Array}}
 */
function normalizeOpenAIMessage(msg) {
  const toolCalls = (msg.tool_calls || []).map((tc) => {
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      args = {};
    }
    // 内部格式：扁平的 {id, name, arguments}
    return { id: tc.id, name: tc.function.name, arguments: args };
  });
  return { role: 'assistant', content: msg.content || '', toolCalls };
}

/**
 * 将内部/线格式 toolCalls 统一转为 OpenAI 线格式（幂等：已是线格式则直接通过）。
 *
 * 内部格式：{ id, name, arguments: Object }
 * 线格式：  { id, type: 'function', function: { name, arguments: String } }
 */
function toWireToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => {
    // 已是线格式（有 type:'function' + function 嵌套）→ 直接返回，避免双重转换破坏结构
    if (tc.type === 'function' && tc.function && typeof tc.function.name === 'string') {
      // 确保 arguments 是字符串
      if (typeof tc.function.arguments !== 'string') {
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify(tc.function.arguments || {}) } };
      }
      return tc;
    }
    // 内部格式 → 转为线格式
    return {
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
      },
    };
  });
}

/**
 * 清洗消息数组，确保兼容 DeepSeek 等严格校验的 API。
 *
 * DeepSeek 要求：当 assistant 消息包含 tool_calls 时，
 *   content 必须是 null 或 [{type:'text', text:'...'}] 数组格式，
 *   不能是纯字符串，否则报 "missing field 'type'" 错误。
 *
 * 此函数在 provider 发送前统一处理，作为 assistant.js 修复之外的最终防线。
 * @param {Array} messages
 * @returns {Array} 清洗后的副本
 */
function sanitizeMessagesForStrictAPI(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    // 处理有 tool_calls 的 assistant 消息
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      let content = m.content;
      // DeepSeek 要求：content 必须是 null 或 [{type:'text',...}] 数组
      if (typeof content === 'string') {
        content = content ? [{ type: 'text', text: content }] : null;
      }
      // DeepSeek 要求：每个 tool_call 必须有 type:'function' + function 嵌套
      const toolCalls = toWireToolCalls(m.tool_calls);
      return { ...m, content, tool_calls: toolCalls };
    }
    return m;
  });
}

class OpenAIProvider {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl 如 https://api.openai.com/v1
   * @param {string} opts.apiKey
   * @param {string} [opts.model]
   * @param {number} [opts.temperature]
   * @param {number} [opts.timeoutMs]
   */
  constructor({ baseUrl, apiKey, model, temperature = 0.3, timeoutMs = 30000 }) {
    // 去掉结尾斜杠，避免拼接出 //chat/completions
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model || 'gpt-4o-mini';
    this.temperature = temperature;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 一次非流式对话。
   * @param {Array} messages OpenAI messages
   * @param {object} [opts] { tools, toolChoice, signal, temperature }
   * @returns {Promise<{role:string, content:string, toolCalls:Array}>}
   */
  async chat(messages, { tools = [], toolChoice, signal, temperature } = {}) {
    const url = this.baseUrl + '/chat/completions';
    // DeepSeek 等严格 API 要求 assistant+tool_calls 消息的 content 必须是数组或 null
    const cleanMessages = sanitizeMessagesForStrictAPI(messages);
    console.log('[ai-provider] 请求:', url, 'model:', this.model,
      'messages:', cleanMessages.length, 'tools:', tools.length);

    const body = {
      model: this.model,
      messages: cleanMessages,
      temperature: temperature != null ? temperature : this.temperature,
    };
    if (tools && tools.length) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    let res;
    try {
      console.log('[ai-provider] fetch 发起...', 'timeoutMs:', this.timeoutMs);
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    console.log('[ai-provider] fetch 完成, status:', res ? res.status : 'no-res');

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      // 尝试从 OpenAI 兼容错误格式中提取人类可读消息，避免把原始 JSON 甩给用户
      let errMsg = 'LLM HTTP ' + res.status;
      let errDetail = '';
      try {
        const errObj = JSON.parse(txt);
        if (errObj.error && errObj.error.message) {
          errMsg = errObj.error.message;
        }
        // 保留原始响应体用于诊断（不含敏感 key）
        errDetail = txt.slice(0, 500);
      } catch { /* 非 JSON 错误体 */ errDetail = txt.slice(0, 500); }
      console.error('[ai-provider] HTTP 错误:', res.status, '消息:', errMsg, '响应体:', errDetail);
      const finalErr = new Error(errMsg);
      finalErr.status = res.status;
      finalErr.responseBody = errDetail;
      throw finalErr;
    }
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('LLM 响应缺少 choices[0].message');
    return normalizeOpenAIMessage(msg);
  }
}

class StubProvider {
  /**
   * 离线桩：不联网。
   *  - 若对话已进入"工具结果"回合（存在 role==='tool' 的消息），直接文本收尾，
   *    避免重复触发同一工具导致死循环。
   *  - 否则按最后一条用户消息的关键词，路由到对应工具或返回文本回声。
   * @param {object} [opts]
   */
  constructor({ model = 'stub', temperature = 0 } = {}) {
    this.model = model;
    this.temperature = temperature;
  }

  async chat(messages, { tools = [] } = {}) {
    // 工具结果回合：汇总上一次工具执行结果，文本收尾
    if (messages.some((m) => m.role === 'tool')) {
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
      let summary = '';
      try {
        summary = JSON.stringify(JSON.parse(lastTool.content));
      } catch {
        summary = lastTool.content;
      }
      return {
        role: 'assistant',
        content: '（离线桩）已执行工具，结果：' + summary.slice(0, 120),
        toolCalls: [],
      };
    }

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = (lastUser && (lastUser.content || '')) || '';
    const has = (name) => tools.some((t) => (t.function ? t.function.name : t.name) === name);

    const wantSub = /(字幕|subtitle|双语|翻译字幕|载字幕)/i.test(text);
    const wantDan = /(弹幕|danmaku|bullet|弹幕)/i.test(text);
    const wantSet = /(设置|调试|debug|settings|配置|亮度|音量|倍速|解码|改一下|调一下)/i.test(text);

    if (wantSub && has('auto_subtitle')) {
      return {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'stub-sub', name: 'auto_subtitle', arguments: { lang: 'chi' } }],
      };
    }
    if (wantDan && has('auto_danmaku')) {
      return {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'stub-dan', name: 'auto_danmaku', arguments: {} }],
      };
    }
    if (wantSet && has('debug_player')) {
      return {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'stub-dbg', name: 'debug_player', arguments: {} }],
      };
    }
    return {
      role: 'assistant',
      content: '（离线桩）已收到：' + text.slice(0, 80),
      toolCalls: [],
    };
  }
}

/**
 * 工厂：按 apiKey 是否存在决定实现。
 * 优先级：opts.apiKey → 环境变量 LUMORA_AI_API_KEY。
 * @param {object} [opts] { apiKey, baseUrl, model, temperature, timeoutMs }
 * @returns {OpenAIProvider|StubProvider}
 */
function createProvider(opts = {}) {
  const apiKey = opts.apiKey || process.env.LUMORA_AI_API_KEY || '';
  if (apiKey) {
    return new OpenAIProvider({
      baseUrl: opts.baseUrl || process.env.LUMORA_AI_BASE_URL || 'https://api.openai.com/v1',
      apiKey,
      model: opts.model || process.env.LUMORA_AI_MODEL || 'gpt-4o-mini',
      temperature: opts.temperature,
      timeoutMs: opts.timeoutMs,
    });
  }
  return new StubProvider(opts);
}

module.exports = { createProvider, OpenAIProvider, StubProvider, normalizeOpenAIMessage, toWireToolCalls, sanitizeMessagesForStrictAPI };
