'use strict';

/**
 * AI 助手模块测试 harness（纯 node，不依赖 Electron）
 * 覆盖：provider / profile / tools / assistant 的可测逻辑。
 * 运行：node tools/ai-tests.js
 */

const assert = require('assert');
const path = require('path');

const { createProvider, OpenAIProvider, StubProvider, normalizeOpenAIMessage } = require(path.join(__dirname, '..', 'src', 'ai', 'provider'));
const { createProfile } = require(path.join(__dirname, '..', 'src', 'ai', 'profile'));
const { createTools, executeTool, toOpenAITools, TOOL_DEFS } = require(path.join(__dirname, '..', 'src', 'ai', 'tools'));
const { createAssistant } = require(path.join(__dirname, '..', 'src', 'ai', 'assistant'));

let pass = 0;
let fail = 0;
const fails = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    fails.push(name + ': ' + e.message);
    console.log('  \u2717 ' + name + ' — ' + e.message);
  }
}

// 内存 storage（无需落盘）
function memStorage(initial) {
  let obj = initial || null;
  return { read: () => obj, write: (v) => { obj = v; } };
}

// ---------------------------------------------------------------------------
async function main() {
console.log('A. provider');
// A1 无 key → Stub
await test('A1 createProvider 无 key 回退 Stub', () => {
  const p = createProvider({});
  assert.ok(p instanceof StubProvider, '应为 StubProvider');
});
// A2 有 key → OpenAI
await test('A2 createProvider 有 key 用 OpenAI', () => {
  const p = createProvider({ apiKey: 'sk-test' });
  assert.ok(p instanceof OpenAIProvider, '应为 OpenAIProvider');
});
// A3 环境变量兜底
await test('A3 环境变量 LUMORA_AI_API_KEY 生效', () => {
  process.env.LUMORA_AI_API_KEY = 'sk-env';
  const p = createProvider({});
  assert.ok(p instanceof OpenAIProvider);
  delete process.env.LUMORA_AI_API_KEY;
});
// A4 baseUrl 去尾斜杠
await test('A4 OpenAIProvider baseUrl 去尾斜杠', () => {
  const p = new OpenAIProvider({ baseUrl: 'https://x.com/v1/', apiKey: 'k' });
  assert.strictEqual(p.baseUrl, 'https://x.com/v1');
});
// A5 normalizeOpenAIMessage 解析 tool_calls
await test('A5 normalizeOpenAIMessage 解析参数 JSON', () => {
  const m = normalizeOpenAIMessage({
    content: '',
    tool_calls: [{ id: 'c1', function: { name: 'auto_subtitle', arguments: '{"lang":"eng"}' } }],
  });
  assert.strictEqual(m.toolCalls[0].name, 'auto_subtitle');
  assert.strictEqual(m.toolCalls[0].arguments.lang, 'eng');
});
// A6 stub 路由：字幕
await test('A6 Stub 识别字幕意图→auto_subtitle', async () => {
  const p = new StubProvider();
  const r = await p.chat([{ role: 'user', content: '帮我加载字幕' }], { tools: toOpenAITools() });
  assert.strictEqual(r.toolCalls[0].name, 'auto_subtitle');
});
// A7 stub 路由：弹幕
await test('A7 Stub 识别弹幕意图→auto_danmaku', async () => {
  const p = new StubProvider();
  const r = await p.chat([{ role: 'user', content: '加载弹幕' }], { tools: toOpenAITools() });
  assert.strictEqual(r.toolCalls[0].name, 'auto_danmaku');
});
// A8 stub 路由：调试
await test('A8 Stub 识别调试意图→debug_player', async () => {
  const p = new StubProvider();
  const r = await p.chat([{ role: 'user', content: '帮我调试一下播放器' }], { tools: toOpenAITools() });
  assert.strictEqual(r.toolCalls[0].name, 'debug_player');
});
// A9 stub 纯文本
await test('A9 Stub 普通文本回声', async () => {
  const p = new StubProvider();
  const r = await p.chat([{ role: 'user', content: '你好' }], { tools: toOpenAITools() });
  assert.strictEqual(r.toolCalls.length, 0);
  assert.ok(r.content.includes('你好'));
});
// A10 stub 工具结果回合收敛（不死循环）
await test('A10 Stub 工具回合后文本收尾', async () => {
  const p = new StubProvider();
  const r = await p.chat(
    [
      { role: 'user', content: '加载字幕' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't', name: 'auto_subtitle', arguments: {} }] },
      { role: 'tool', tool_call_id: 't', content: '{"ok":true}' },
    ],
    { tools: toOpenAITools() }
  );
  assert.strictEqual(r.toolCalls.length, 0);
  assert.ok(r.content.includes('已执行工具'));
});

// ---------------------------------------------------------------------------
console.log('B. profile');
// B1 默认值
await test('B1 默认画像含偏好默认值', () => {
  const pr = createProfile();
  assert.strictEqual(pr.getPreference('subtitleLang', 'chi'), 'chi');
  assert.strictEqual(pr.getPreference('missing', 7), 7);
});
// B2 写入+持久化到内存
await test('B2 setPreference 经 storage 持久化', () => {
  const st = memStorage();
  const pr = createProfile({ storage: st });
  pr.setPreference('subtitleLang', 'eng');
  assert.strictEqual(pr.getPreference('subtitleLang'), 'eng');
  // 重新加载应读到
  const pr2 = createProfile({ storage: st });
  assert.strictEqual(pr2.getPreference('subtitleLang'), 'eng');
});
// B3 recordAction 计数+history
await test('B3 recordAction 累加计数并截断 history', () => {
  const pr = createProfile({ maxHistory: 3 });
  pr.recordAction('subtitleLoads');
  pr.recordAction('subtitleLoads');
  assert.strictEqual(pr.data.stats.subtitleLoads, 2);
  assert.strictEqual(pr.data.history.length, 2);
  for (let i = 0; i < 10; i++) pr.recordAction('x');
  assert.strictEqual(pr.data.history.length, 3); // 截断
});
// B4 taught 标记
await test('B4 setPreference taught 记入 taught', () => {
  const pr = createProfile();
  pr.setPreference('danmakuSource', 'bilibili', { taught: true });
  assert.strictEqual(pr.data.taught.danmakuSource, 'bilibili');
});
// B5 summarize 含关键行
await test('B5 summarize 含偏好与统计', () => {
  const pr = createProfile();
  pr.setPreference('subtitleLang', 'jpn');
  pr.recordAction('danmakuLoads');
  const s = pr.summarize();
  assert.ok(s.includes('字幕语言偏好：jpn'));
  assert.ok(s.includes('弹幕加载 1 次'));
});
// B6 部分载入合并默认
await test('B6 部分载入与默认合并', () => {
  const st = memStorage({ preferences: { subtitleLang: 'fre' } });
  const pr = createProfile({ storage: st });
  assert.strictEqual(pr.getPreference('subtitleLang'), 'fre');
  assert.strictEqual(pr.getPreference('danmakuSource'), 'dandanplay'); // 默认补齐
});

// ---------------------------------------------------------------------------
console.log('C. tools');
function baseCtx(over = {}) {
  const profile = createProfile();
  const settings = {};
  return Object.assign(
    {
      profile,
      getCurrentFile: () => '/movies/foo.mkv',
      downloadSubtitle: async (file, lang) => ({ path: '/cache/foo.' + lang + '.srt', found: true }),
      autoMatchDanmaku: async (file, source) => ({ count: 42, source }),
      setSetting: (k, v) => { settings[k] = v; },
      getState: () => ({ time: 10, pause: false }),
      getDiagnostics: () => ({ state: 'ok' }),
      settings,
    },
    over
  );
}
// C1 auto_subtitle 调 downloadSubtitle + 记偏好
await test('C1 auto_subtitle 调用下载并学语言', async () => {
  let called = null;
  const ctx = baseCtx({ downloadSubtitle: async (f, lang) => { called = { f, lang }; return { path: 'p', found: true }; } });
  const r = await executeTool('auto_subtitle', { lang: 'eng' }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(called.lang, 'eng');
  assert.strictEqual(ctx.profile.getPreference('subtitleLang'), 'eng');
  assert.strictEqual(ctx.profile.data.stats.subtitleLoads, 1);
});
// C2 auto_subtitle 无文件报错
await test('C2 auto_subtitle 无播放文件→失败', async () => {
  const ctx = baseCtx({ getCurrentFile: () => null });
  const r = await executeTool('auto_subtitle', {}, ctx);
  assert.strictEqual(r.ok, false);
});
// C3 auto_danmaku 默认源
await test('C3 auto_danmaku 默认源 dandanplay', async () => {
  let src = null;
  const ctx = baseCtx({ autoMatchDanmaku: async (f, s) => { src = s; return { count: 5 }; } });
  const r = await executeTool('auto_danmaku', {}, ctx);
  assert.ok(r.ok);
  assert.strictEqual(src, 'dandanplay');
  assert.strictEqual(ctx.profile.data.stats.danmakuLoads, 1);
});
// C4 set_setting
await test('C4 set_setting 调 setSetting 并计数', async () => {
  const ctx = baseCtx();
  const r = await executeTool('set_setting', { key: 'volume', value: '80' }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(ctx.settings.volume, '80');
  assert.strictEqual(ctx.profile.data.stats.settingChanges, 1);
});
// C5 learn_preference 标记 taught
await test('C5 learn_preference 写入 taught', async () => {
  const ctx = baseCtx();
  const r = await executeTool('learn_preference', { key: 'subtitleLang', value: 'kor' }, ctx);
  assert.ok(r.ok && r.taught);
  assert.strictEqual(ctx.profile.data.taught.subtitleLang, 'kor');
});
// C6 debug_player 走 getDiagnostics
await test('C6 debug_player 返回诊断', async () => {
  const ctx = baseCtx();
  const r = await executeTool('debug_player', {}, ctx);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.diagnostics, { state: 'ok' });
});
// C7 未知工具
await test('C7 未知工具→ok:false', async () => {
  const r = await executeTool('nope', {}, baseCtx());
  assert.strictEqual(r.ok, false);
});
// C8 toOpenAITools 形状
await test('C8 toOpenAITools 覆盖全部工具且格式正确', () => {
  const t = toOpenAITools();
  assert.strictEqual(t.length, TOOL_DEFS.length);
  assert.ok(t.every((x) => x.type === 'function' && x.function && x.function.name));
  assert.ok(t.some((x) => x.function.name === 'player_command'));
});
// C9 player_command 转发到 runCommand（参数统一字符串化 + 计数）
await test('C9 player_command 转发命令到 runCommand', async () => {
  let captured = null;
  const ctx = baseCtx({ runCommand: (args) => { captured = args; } });
  const r = await executeTool('player_command', { command: 'seek', args: [30, 'absolute'] }, ctx);
  assert.ok(r.ok);
  assert.deepStrictEqual(captured, ['seek', '30', 'absolute']); // 数字 30 → 字符串
  assert.strictEqual(r.command, 'seek 30 absolute');
  assert.strictEqual(ctx.profile.data.stats.playerCommands, 1);
});
await test('C9b player_command 缺 command→失败', async () => {
  const ctx = baseCtx({ runCommand: () => {} });
  const r = await executeTool('player_command', {}, ctx);
  assert.strictEqual(r.ok, false);
});

// ---------------------------------------------------------------------------
console.log('D. assistant 编排');
await test('D1 字幕意图→工具事件→文本收尾，且循环收敛', async () => {
  const profile = createProfile();
  const settings = {};
  const ctx = {
    profile,
    getCurrentFile: () => '/movies/foo.mkv',
    downloadSubtitle: async () => ({ path: 'p', found: true }),
    autoMatchDanmaku: async () => ({ count: 1 }),
    setSetting: (k, v) => { settings[k] = v; },
    getState: () => ({ time: 1 }),
    getDiagnostics: () => ({ state: 'ok' }),
  };
  const provider = createProvider({}); // stub
  const tools = createTools();
  const assistant = createAssistant({ provider, tools, profile, buildCtx: () => ctx });

  const events = [];
  assistant.on((type, payload) => events.push({ type, payload }));
  const res = await assistant.send('帮我加载字幕');

  assert.strictEqual(res.rounds, 2, '应恰好 2 轮（工具+收尾）');
  assert.ok(events.some((e) => e.type === 'tool' && e.payload.name === 'auto_subtitle'), '应触发 auto_subtitle');
  assert.ok(events.some((e) => e.type === 'tool-result' && e.payload.result.ok), '应有成功的工具结果');
  assert.ok(events.some((e) => e.type === 'assistant' && e.payload.text.includes('已执行工具')), '最终文本应收尾');
  assert.strictEqual(profile.data.stats.subtitleLoads, 1);
});
await test('D2 普通文本无工具调用', async () => {
  const profile = createProfile();
  const assistant = createAssistant({
    provider: createProvider({}),
    tools: createTools(),
    profile,
    buildCtx: () => baseCtx(),
  });
  const events = [];
  assistant.on((type, payload) => events.push({ type, payload }));
  const res = await assistant.send('今天天气不错');
  assert.strictEqual(res.rounds, 1);
  assert.ok(!events.some((e) => e.type === 'tool'), '不应触发工具');
  assert.ok(events.some((e) => e.type === 'assistant' && e.payload.text.includes('今天天气不错')));
});
await test('D3 调试意图→debug_player，reset 清空上下文', async () => {
  const profile = createProfile();
  const assistant = createAssistant({
    provider: createProvider({}),
    tools: createTools(),
    profile,
    buildCtx: () => baseCtx(),
  });
  const events = [];
  assistant.on((type, payload) => events.push({ type, payload }));
  await assistant.send('帮我调试一下');
  assert.ok(events.some((e) => e.type === 'tool' && e.payload.name === 'debug_player'));
  assistant.reset();
  assert.strictEqual(assistant.messages.length, 0);
});
await test('D4 后端异常→error 事件且返回兜底文本', async () => {
  const provider = { chat: async () => { throw new Error('boom'); } };
  const assistant = createAssistant({
    provider,
    tools: createTools(),
    profile: createProfile(),
    buildCtx: () => baseCtx(),
  });
  const events = [];
  assistant.on((type, payload) => events.push({ type, payload }));
  const res = await assistant.send('hi');
  assert.ok(events.some((e) => e.type === 'error'));
  assert.ok(res.text.includes('boom'));
});
await test('D5 setProvider 热替换后端，上下文保留', async () => {
  const profile = createProfile();
  const assistant = createAssistant({
    provider: { chat: async () => ({ role: 'assistant', content: 'A', toolCalls: [] }) },
    tools: createTools(),
    profile,
    buildCtx: () => baseCtx(),
  });
  const events = [];
  assistant.on((type, payload) => events.push({ type, payload }));
  await assistant.send('先用 A');
  assert.ok(events.some((e) => e.type === 'assistant' && e.payload.text === 'A'), '应先使用 provider A');

  // 热替换成 B，并断言后续 send 走 B（messages 上下文保留）
  assistant.setProvider({ chat: async () => ({ role: 'assistant', content: 'B', toolCalls: [] }) });
  const before = assistant.messages.length;
  events.length = 0;
  await assistant.send('再用 B');
  assert.ok(events.some((e) => e.type === 'assistant' && e.payload.text === 'B'), '替换后应改用 provider B');
  assert.ok(assistant.messages.length > before, '对话上下文应保留（未清空）');
});
await test('D6 OpenAI 线格式 tool_calls 两轮循环不抛 ReferenceError', async () => {
  /* 模拟真机场景：provider 返回 OpenAI 线格式 tool_calls（type:function + function 嵌套），
     assistant 转为 wire 格式推入 messages，第二轮 chat 时 sanitizeMessagesForStrictAPI
     再次处理已为 wire 格式的 tool_calls —— 验证不会抛 "tool_calls is not defined" */
  let callCount = 0;
  const mockProvider = {
    chat: async (msgs) => {
      callCount++;
      if (callCount === 1) {
        // 第一轮：返回线格式 tool_calls（与真实 DeepSeek API 一致）
        return {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'get_state', arguments: {} },
          ],
        };
      }
      // 第二轮：纯文本收尾
      return { role: 'assistant', content: '当前状态正常', toolCalls: [] };
    },
  };
  const profile = createProfile();
  const tools = createTools();
  const ctx = {
    profile,
    getCurrentFile: () => '/test/foo.mkv',
    downloadSubtitle: async () => ({ path: '/test/sub.srt', found: true }),
    autoMatchDanmaku: async () => ({ count: 0 }),
    setSetting: () => {},
    getState: () => ({ time: 10, pause: false }),
    getDiagnostics: () => ({ ok: true }),
    runCommand: () => {},
    sendNotice: () => {},
  };
  const assistant = createAssistant({ provider: mockProvider, tools, profile, buildCtx: () => ctx });
  const events = [];
  assistant.on((type, payload) => { events.push({ type, payload }); });

  // 不应抛出任何异常（尤其是 ReferenceError: tool_calls is not defined）
  const res = await assistant.send('查看状态');

  assert.strictEqual(res.rounds, 2, '应恰好 2 轮');
  assert.ok(!events.some((e) => e.type === 'error'), '不应有 error 事件，实际: ' +
    JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.ok(events.some((e) => e.type === 'tool' && e.payload.name === 'get_state'), '应触发 get_state');
  assert.ok(events.some((e) => e.type === 'assistant' && e.payload.text.includes('当前状态正常')), '应有最终文本');

  // 验证 messages 数组中 assistant 消息的 tool_calls 是合法的 wire 格式
  const assistMsgs = assistant.messages.filter((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistMsgs.length > 0, 'messages 中应有带 tool_calls 的 assistant 消息');
  for (const m of assistMsgs) {
    assert.ok(Array.isArray(m.tool_calls), 'tool_calls 应为数组');
    for (const tc of m.tool_calls) {
      assert.strictEqual(tc.type, 'function', '每项必须有 type:function');
      assert.ok(tc.function, '每项必须有 function 对象');
      assert.ok(typeof tc.function.name === 'string', 'function.name 应为字符串');
      assert.ok(typeof tc.function.arguments === 'string', 'function.arguments 应为字符串');
    }
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log('E. media-apply');
const { autoLoadSubtitle, autoLoadDanmaku, langToIso } = require(path.join(__dirname, '..', 'src', 'main', 'media-apply'));

await test('E1 langToIso 映射', () => {
  assert.strictEqual(langToIso('chi'), 'zh');
  assert.strictEqual(langToIso('eng'), 'en');
  assert.strictEqual(langToIso('jpn'), 'ja');
  assert.strictEqual(langToIso('fr'), 'fr');
  assert.strictEqual(langToIso(null), null);
});
await test('E2 autoLoadSubtitle ffmpeg 走 cue 推送', async () => {
  const sent = [];
  const Subtitles = {
    guessSearchQueryForSubtitle: () => 'My Movie',
    computeMovieHash: () => 'abc',
    search: async () => [{ lang: 'zh', fileId: 'f1', base: 'official' }],
    download: async () => ({ path: '/c/f.srt', cues: [1, 2], name: 'f.srt' }),
  };
  const r = await autoLoadSubtitle({ path: '/m/f.mkv' }, { Subtitles, sendToRenderer: (c, p) => sent.push({ c, p }), useMpv: false, subAdd: null });
  assert.ok(r.ok);
  assert.strictEqual(r.count, 2);
  const sub = sent.find((s) => s.c === 'player:subtitles');
  assert.ok(sub, '应推送 player:subtitles');
  assert.deepStrictEqual(sub.p, { index: -2, cues: [1, 2], external: true });
});
await test('E3 autoLoadSubtitle mpv 走 sub-add', async () => {
  const sent = [];
  let added = null;
  const Subtitles = {
    guessSearchQueryForSubtitle: () => 'M',
    computeMovieHash: () => 'h',
    search: async () => [{ lang: 'zh', fileId: 'f', base: 'b' }],
    download: async () => ({ path: '/c/f.srt', cues: [], name: 'f.srt' }),
  };
  const r = await autoLoadSubtitle({ path: '/m/f.mkv' }, { Subtitles, sendToRenderer: (c, p) => sent.push({ c, p }), useMpv: true, subAdd: (p) => { added = p; } });
  assert.ok(r.ok);
  assert.strictEqual(added, '/c/f.srt');
  assert.ok(sent.find((s) => s.c === 'osd'));
  assert.ok(!sent.find((s) => s.c === 'player:subtitles'));
});
await test('E4 autoLoadSubtitle 偏好 eng 优先选 en', async () => {
  const Subtitles = {
    guessSearchQueryForSubtitle: () => 'M',
    computeMovieHash: () => 'h',
    search: async ({ languages }) => (languages.includes('en') ? [{ lang: 'en', fileId: 'e', base: 'b' }] : [{ lang: 'zh', fileId: 'z', base: 'b' }]),
    download: async () => ({ path: 'p', cues: [], name: 'n' }),
  };
  const r = await autoLoadSubtitle({ path: '/m/f.mkv' }, { Subtitles, sendToRenderer: () => {}, useMpv: false }, { lang: 'eng' });
  assert.ok(r.ok);
  assert.strictEqual(r.lang, 'en');
});
await test('E5 autoLoadSubtitle 无结果→失败', async () => {
  const Subtitles = { guessSearchQueryForSubtitle: () => 'M', computeMovieHash: () => 'h', search: async () => [], download: async () => ({}) };
  const r = await autoLoadSubtitle({ path: '/m/f.mkv' }, { Subtitles, sendToRenderer: () => {}, useMpv: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_subtitle');
});
await test('E6 autoLoadDanmaku 成功推送 player:danmaku', async () => {
  const sent = [];
  const Subtitles = { computeMovieHash: () => 'h' };
  const Danmaku = {
    autoMatch: async () => ({ sources: [{ source: 'dandanplay', confidence: 1 }] }),
    load: async () => ({ count: 10, comments: [{ t: 1, text: 'x' }], source: 'dandanplay' }),
  };
  const r = await autoLoadDanmaku({ path: '/m/f.mkv' }, { Subtitles, Danmaku, sendToRenderer: (c, p) => sent.push({ c, p }) });
  assert.ok(r.ok);
  assert.strictEqual(r.count, 10);
  const d = sent.find((s) => s.c === 'player:danmaku');
  assert.ok(d);
  assert.strictEqual(d.p.count, 10);
});
await test('E7 autoLoadDanmaku 无源→失败', async () => {
  const Subtitles = { computeMovieHash: () => 'h' };
  const Danmaku = { autoMatch: async () => ({ sources: [] }) };
  const r = await autoLoadDanmaku({ path: '/m/f.mkv' }, { Subtitles, Danmaku, sendToRenderer: () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_source');
});
await test('E8 autoLoadDanmaku 逐源容错', async () => {
  const Subtitles = { computeMovieHash: () => 'h' };
  let loadCalls = 0;
  const Danmaku = {
    // 高置信源 a 故意失败，应回退到低置信源 b
    autoMatch: async () => ({ sources: [{ source: 'a', confidence: 1 }, { source: 'b', confidence: 0 }] }),
    load: async (s) => { loadCalls++; if (s.source === 'a') throw new Error('fail'); return { count: 3, comments: [], source: 'b' }; },
  };
  const r = await autoLoadDanmaku({ path: '/m/f.mkv' }, { Subtitles, Danmaku, sendToRenderer: () => {} });
  assert.ok(r.ok);
  assert.strictEqual(r.source, 'b');
  assert.strictEqual(loadCalls, 2);
});

console.log('\n========================================');
console.log('AI 测试：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) {
  console.log('失败项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('全部通过 \u2714');
  process.exit(0);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
