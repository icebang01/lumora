'use strict';
// AI Provider 单测：严格 API 清洗与消息归一化
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeMessagesForStrictAPI, normalizeOpenAIMessage, toWireToolCalls } = require('../../src/ai/provider');

test('sanitizeMessagesForStrictAPI：无 tool_calls 的消息原样通过', () => {
  const messages = [
    { role: 'system', content: '你是一名助手' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！' },
  ];
  assert.deepEqual(sanitizeMessagesForStrictAPI(messages), messages);
});

test('sanitizeMessagesForStrictAPI：assistant+tool_calls 字符串 content 转成数组', () => {
  const messages = [
    { role: 'user', content: '帮我加载字幕' },
    {
      role: 'assistant',
      content: '好的，我来加载字幕。',
      tool_calls: [{ id: 'tc1', name: 'auto_subtitle', arguments: { lang: 'chi' } }],
    },
  ];
  const out = sanitizeMessagesForStrictAPI(messages);
  assert.equal(out[1].role, 'assistant');
  assert.deepEqual(out[1].content, [{ type: 'text', text: '好的，我来加载字幕。' }]);
  assert.deepEqual(out[1].tool_calls, [
    {
      id: 'tc1',
      type: 'function',
      function: { name: 'auto_subtitle', arguments: '{"lang":"chi"}' },
    },
  ]);
});

test('sanitizeMessagesForStrictAPI：空字符串 content 转成 null', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', name: 'auto_subtitle', arguments: {} }],
    },
  ];
  const out = sanitizeMessagesForStrictAPI(messages);
  assert.strictEqual(out[0].content, null);
  assert.equal(out[0].tool_calls.length, 1);
});

test('normalizeOpenAIMessage：把 OpenAI 线格式 tool_calls 转成内部格式', () => {
  const msg = {
    role: 'assistant',
    content: '加载完成',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'auto_subtitle', arguments: '{"lang":"chi"}' },
      },
    ],
  };
  const out = normalizeOpenAIMessage(msg);
  assert.equal(out.role, 'assistant');
  assert.equal(out.content, '加载完成');
  assert.deepEqual(out.toolCalls, [{ id: 'call_1', name: 'auto_subtitle', arguments: { lang: 'chi' } }]);
});

test('toWireToolCalls：幂等——已是线格式时直接通过', () => {
  const wire = [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'auto_subtitle', arguments: '{"lang":"chi"}' },
    },
  ];
  assert.deepEqual(toWireToolCalls(wire), wire);
});
