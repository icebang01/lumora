'use strict';

/**
 * AI 助手聊天面板（渲染端）
 * -------------------------------------------------------------
 * 纯 UI：把一个输入框 + 消息流接到主进程的 player:ai:* IPC。
 * 事件流：主进程在对话期间持续 push 'player:ai-event'，本模块据此渲染
 *   用户气泡 / 助手气泡 / 工具执行笔记（加载字幕·弹幕·设置·诊断）。
 *
 * 设计为自包含：initAiPanel() 同时接管 #btn-ai 的点击与面板开合，
 * app.js 只需 import 并在 boot() 里调一次。
 */

const $ = (id) => document.getElementById(id);

const TOOL_LABELS = {
  auto_subtitle: '加载字幕',
  auto_danmaku: '加载弹幕',
  set_setting: '设置',
  debug_player: '诊断播放器',
  get_state: '读取状态',
  learn_preference: '记住偏好',
};

function makeEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function initAiPanel() {
  const panel = $('ai-panel');
  const box = $('ai-messages');
  const input = $('ai-input');
  const sendBtn = $('ai-send');
  const closeBtn = $('ai-close');
  const resetBtn = $('ai-reset');
  const thinking = $('ai-thinking');
  const btnAi = $('btn-ai');

  if (!panel || !box) return; // 容错：缺少 DOM 时不致命

  let eventOff = null;
  let busy = false;
  let pendingNote = null; // 当前"进行中"的工具笔记，待结果回灌

  function toggle(force) {
    const open = force != null ? force : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !open);
    document.body.classList.toggle('ai-open', open);  /* 让 side-rail 知道右面板已开 */
    if (open && input) setTimeout(() => input.focus(), 60);
  }
  // 暴露给全局，方便其他入口（快捷键等）复用
  window.toggleAiPanel = toggle;

  function scrollDown() {
    box.scrollTop = box.scrollHeight;
  }

  function addBubble(role, text) {
    const wrap = makeEl('div', 'ai-msg ai-' + role);
    wrap.appendChild(makeEl('div', 'ai-bubble', text));
    box.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function setThinking(on) {
    if (thinking) thinking.classList.toggle('hidden', !on);
  }

  function onEvent(ev) {
    const { type, payload } = ev || {};
    if (type === 'tool') {
      // 标记"进行中"，等待 tool-result 回灌
      pendingNote = makeEl('div', 'ai-msg ai-tool');
      pendingNote.appendChild(makeEl('div', 'ai-tool-note', '⏳ ' + (TOOL_LABELS[payload.name] || payload.name) + '…'));
      box.appendChild(pendingNote);
      scrollDown();
    } else if (type === 'tool-result') {
      const ok = payload.result && payload.result.ok;
      const label = TOOL_LABELS[payload.name] || payload.name;
      const detail = ok ? '' : payload.result && payload.result.error ? '（' + payload.result.error + '）' : '';
      const text = (ok ? '✓ ' : '✗ ') + label + ' ' + detail;
      if (pendingNote) {
        pendingNote.querySelector('.ai-tool-note').textContent = text;
        pendingNote = null;
      } else {
        const wrap = makeEl('div', 'ai-msg ai-tool');
        wrap.appendChild(makeEl('div', 'ai-tool-note', text));
        box.appendChild(wrap);
      }
      scrollDown();
    } else if (type === 'assistant') {
      if (payload.text) addBubble('assistant', payload.text);
    } else if (type === 'error') {
      // 错误必须显式渲染——不能只靠 catch 兜底，因为某些异常路径可能只 emit error
      const msg = (payload && payload.message) || '未知错误';
      const detail = (payload && payload.detail) || '';
      // 对常见错误给中文友好提示
      let display = '⚠️ ' + msg;
      if (/model_not_found|invalid model|model name/i.test(msg)) {
        display = '⚠️ 模型名称不正确。\n\n' +
          'API 返回：' + msg.replace(/["{}]/g, '') + '\n\n' +
          '请到「设置 → AI 助手 → 模型名称」修改为正确的模型 ID。\n' +
          '常见示例：deepseek-chat / deepseek-v4 / gpt-4o-mini / qwen-plus';
      } else if (/api.?key|auth|401|403/i.test(msg)) {
        display = '⚠️ API Key 无效或已过期。\n\n请检查「设置 → AI 助手 → API Key」是否正确。';
      } else if (/timeout|abort/i.test(msg)) {
        display = '⚠️ 请求超时，AI 后端响应太慢或不可达。';
      } else if (/tool_calls|tool/i.test(msg)) {
        // tool_calls 相关错误通常是模型不支持 function calling
        display = '⚠️ 当前模型（' + (msg.slice(0, 80)) + '）可能不支持工具调用。\n\n' +
          '建议：\n' +
          '1. 尝试更换模型（如 deepseek-chat / gpt-4o-mini）\n' +
          '2. 或在「设置 → AI 助手」检查 API 地址和模型名是否正确';
      }
      if (detail) display += '\n\n[诊断信息]\n' + detail.slice(0, 300);
      addBubble('assistant', display);
    }
    // 'user' 不打点（由本端自己渲染）
  }

  function send() {
    const text = (input.value || '').trim();
    if (!text || busy) return;
    input.value = '';
    addBubble('user', text);
    setThinking(true);
    busy = true;

    // 本次对话临时订阅事件流，结束后卸载，避免监听器堆积
    eventOff = window.lumen.on('player:ai-event', onEvent);

    window.lumen
      .aiChat(text)
      .then((res) => {
        setThinking(false);
        busy = false;
        if (eventOff) { eventOff(); eventOff = null; }
        if (!res || !res.ok) addBubble('assistant', '（出错了：' + ((res && res.error) || '未知') + '）');
      })
      .catch((e) => {
        setThinking(false);
        busy = false;
        if (eventOff) { eventOff(); eventOff = null; }
        addBubble('assistant', '（请求失败：' + (e && e.message ? e.message : e) + '）');
      });
  }

  function reset() {
    window.lumen.aiReset().then(() => {
      box.innerHTML = '';
      addBubble('assistant', '对话已清空。试着说"加载字幕""加载弹幕"或"帮我调试"，也可以让我记住你的偏好（如"以后字幕默认英文"）。');
    });
  }

  if (sendBtn) sendBtn.addEventListener('click', send);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  if (closeBtn) closeBtn.addEventListener('click', () => toggle(false));
  if (resetBtn) resetBtn.addEventListener('click', reset);
  if (btnAi) btnAi.addEventListener('click', () => toggle());

  // 初始问候
  addBubble('assistant', '你好，我是 Lumora AI 助手。说"加载字幕""加载弹幕"或"帮我调试"试试，也可以让我记住你的习惯。');
}
