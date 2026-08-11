'use strict';

/**
 * AI 助手编排循环（Orchestration）
 * -------------------------------------------------------------
 * 把 provider（LLM）+ tools（工具）+ profile（习惯）串成一个 ReAct 风格循环：
 *   system(含画像) → user → LLM → 若有 tool_calls：执行 → 回灌 tool 结果 → 再问 LLM
 *   → 直到 LLM 返回纯文本 → 收尾。
 *
 * 通过 emit(type, payload) 暴露事件流，渲染端可据此做流式 UI：
 *   'user'        { text }
 *   'assistant'   { text }           最终文本（或桩的回合文本）
 *   'tool'        { name, args }     即将执行某工具
 *   'tool-result' { name, result }   工具执行结果
 *   'error'       { message }
 *
 * 防呆：maxToolRounds 限制工具轮数，避免模型反复调工具不收尾。
 */

const SYSTEM_PROMPT = `你是 Lumora 播放器内置的 AI 助手。你的职责：
1. 帮用户自动搜索并加载匹配的字幕；
2. 帮用户自动匹配并加载弹幕；
3. 学习并记住用户的习惯偏好；
4. 用自然语言帮用户一键设置或调试播放器（亮度、音量、倍速、解码模式等）。

行为准则：
- 当用户明确要求字幕/弹幕/设置/调试时，优先调用对应工具，而不是只说"好的"。
- 需要播放/暂停/跳转/音量/倍速/切轨/截图/播放列表/画面调节等直接控制时，用 player_command 工具（mpv 风格命令），而不是只口头答应。
- 调用工具前先确认有正在播放的文件；没有则直接说明。
- 用中文、简洁、口语化地回复。不要输出长篇大论。
- 用户教你的偏好要立刻用 learn_preference 记住。`;

/**
 * 创建助手实例。
 * @param {object} opts
 * @param {object} opts.provider  provider 实例（OpenAI/Stub）
 * @param {object} opts.tools     createTools() 的产物
 * @param {object} opts.profile   createProfile() 的产物
 * @param {Function} opts.buildCtx 返回工具执行 ctx 的函数（每次工具调用前构造，保证拿到最新状态）
 * @param {number} [opts.maxToolRounds]
 */
function createAssistant({ provider, tools, profile, buildCtx, maxToolRounds = 5 }) {
  let messages = [];
  const listeners = [];

  function on(fn) {
    listeners.push(fn);
    // 返回取消订阅函数，便于桥接层按对话生命周期挂载/卸载监听
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
  function emit(type, payload) {
    for (const fn of listeners) {
      try {
        fn(type, payload);
      } catch {
        /* 监听器异常不影响主流程 */
      }
    }
  }

  function systemMessage() {
    // 每次都重新编译画像，保证习惯学习实时生效
    return { role: 'system', content: SYSTEM_PROMPT + '\n\n' + profile.summarize() };
  }

  /**
   * 发送一条用户消息并跑完整编排循环。
   * @param {string} userText
   * @returns {Promise<{text:string, messages:Array, rounds:number}>}
   */
  async function send(userText) {
    messages.push({ role: 'user', content: userText });
    emit('user', { text: userText });

    let rounds = 0;
    while (rounds < maxToolRounds) {
      rounds++;
      let reply;
      try {
        reply = await provider.chat([systemMessage(), ...messages], { tools: tools.openaiTools });
      } catch (e) {
        // 如果错误与 tools / function_calling / tool_calls 相关（部分模型不支持），降级为无工具模式重试一次
        const msg = (e.message || '').toLowerCase();
        const isToolError = (msg.includes('tool') || msg.includes('function') ||
          msg.includes('parameter') || msg.includes('tool_calls'));
        console.error('[ai] provider.chat 异常 (round ' + rounds + '):', e.message,
          e.stack ? '\n' + e.stack.split('\n').slice(0, 5).join('\n') : '');
        if (isToolError && tools.openaiTools.length > 0) {
          console.log('[ai] tools 不受支持，降级为无工具模式重试');
          try {
            reply = await provider.chat([systemMessage(), ...messages], {});
            // 降级成功后通知用户工具暂时不可用
            emit('assistant', { text: '⚠️ 当前模型不支持工具调用，我可以用文字回复你，但无法执行加载字幕/弹幕/控制播放器等操作。' });
          } catch (e2) {
            console.error('[ai] 降级重试也失败:', e2.message);
            emit('error', { message: e2.message, detail: '降级重试失败: ' + (e2.stack || '') });
            const errText = '（AI 后端调用失败：' + e2.message + '）';
            emit('assistant', { text: errText });
            return { text: errText, messages, rounds };
          }
        } else {
          emit('error', { message: e.message, detail: e.stack || '' });
          const errText = '（AI 后端调用失败：' + e.message + '）';
          emit('assistant', { text: errText });
          return { text: errText, messages, rounds };
        }
      }

      // 有工具调用 → 执行并回灌，继续循环
      if (reply.toolCalls && reply.toolCalls.length) {
        // OpenAI 标准要求 assistant 消息带上 tool_calls 才能接 tool 消息。
        //
        // DeepSeek 等严格 API 要求两条格式规则（缺一报 "missing field 'type'"）：
        //   ① content + tool_calls 共存时，content 必须是
        //      [{type:'text', text:'...'}] 数组或 null（不能是纯字符串）
        //   ② tool_calls 每项必须有 type:'function' + function:{name,arguments}
        //      （不能是内部简化格式 {id,name,arguments}）
        const assistContent = reply.content
          ? (typeof reply.content === 'string'
              ? [{ type: 'text', text: reply.content }]
              : reply.content)
          : null;
        // 转为 OpenAI 线格式（type + function 嵌套），供 API 直接序列化
        const wireToolCalls = (reply.toolCalls || []).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
          },
        }));
        messages.push({ role: 'assistant', content: assistContent, tool_calls: wireToolCalls });
        const ctx = buildCtx();
        for (const tc of reply.toolCalls) {
          emit('tool', { name: tc.name, args: tc.arguments });
          let result;
          try {
            result = await tools.call(tc.name, tc.arguments, ctx);
          } catch (e) {
            console.error('[ai] 工具执行失败:', tc.name, e.message, e.stack || '');
            result = { ok: false, error: e.message };
          }
          emit('tool-result', { name: tc.name, result });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue;
      }

      // 纯文本收尾
      messages.push({ role: 'assistant', content: reply.content || '' });
      emit('assistant', { text: reply.content || '' });
      return { text: reply.content || '', messages, rounds };
    }

    const fallback = '（已达工具调用上限，请简化请求或分步进行）';
    emit('assistant', { text: fallback });
    return { text: fallback, messages, rounds };
  }

  /** 清空对话上下文（保留画像/工具） */
  function reset() {
    messages = [];
  }

  return {
    send,
    reset,
    on,
    /**
     * 热替换底层 provider（如用户在设置里改了 API Key / 模型后重新加载）。
     * 对话上下文 messages 保留，仅切换 LLM 后端。
     * @param {object} p 新的 provider 实例（需实现 chat(messages, opts)）
     */
    setProvider(p) { provider = p; },
    get messages() {
      return messages;
    },
  };
}

module.exports = { createAssistant, SYSTEM_PROMPT };
