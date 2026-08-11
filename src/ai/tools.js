'use strict';

/**
 * AI 助手工具注册表（Tool Registry）
 * -------------------------------------------------------------
 * 每个工具 = 元数据(名称/描述/JSON Schema) + 执行逻辑。
 * 执行依赖通过 ctx 注入（getCurrentFile / downloadSubtitle / autoMatchDanmaku /
 * setSetting / getState / getDiagnostics / profile / sendNotice），
 * 因此生产环境接真实模块、测试环境传 mock，互不污染。
 *
 * 工具清单（对应用户要的四大能力）：
 *   auto_subtitle   自动搜索+加载最匹配字幕        → "自动搜索加载对应的字幕"
 *   auto_danmaku    自动匹配+加载弹幕              → "自动加载弹幕"
 *   set_setting     修改播放器设置/一键调试         → "一键设置调试播放器"
 *   learn_preference 显式教助手一个偏好            → "学习自己的习惯"
 *   debug_player    播放器诊断                     → 一键调试的支撑
 *   get_state       取当前播放状态                 → 助手自我感知
 *   player_command  直接对播放器下发命令           → "把功能权限都开放给 AI"（开放全部播放控制）
 *
 * ctx 额外注入：runCommand(args) —— 转发到渲染端命令总线（pause/seek/volume/speed/切轨/截图...）
 */

/** @type {Array} 工具元数据（OpenAI tool 格式的来源） */
const TOOL_DEFS = [
  {
    name: 'auto_subtitle',
    description: '为当前播放的视频自动搜索并加载最匹配的字幕（按用户语言偏好挑选）。',
    parameters: {
      type: 'object',
      properties: {
        lang: { type: 'string', description: '字幕语言，如 chi/eng/jpn，缺省用用户偏好' },
      },
      required: [],
    },
  },
  {
    name: 'auto_danmaku',
    description: '为当前视频自动匹配并加载弹幕（弹弹play / Bilibili）。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '弹幕源 dandanplay|bilibili，缺省自动' },
      },
      required: [],
    },
  },
  {
    name: 'set_setting',
    description: '修改播放器设置项（如亮度、音量、倍速、解码模式），用于一键设置/调试。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '设置键名' },
        value: { type: 'string', description: '设置值' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'debug_player',
    description: '运行播放器诊断，返回当前文件、轨道、帧率、缓冲、近期错误等状态，用于一键调试。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_state',
    description: '获取当前播放状态（时间、暂停、倍速、音视频轨）。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'learn_preference',
    description: '让用户显式教助手一个偏好（如"以后字幕默认英文"），助手会记住并在后续使用。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '偏好键，如 subtitleLang / danmakuSource' },
        value: { type: 'string', description: '偏好值' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'player_command',
    description:
      '直接对播放器下发命令，开放全部播放控制能力（mpv 风格命令语法）。' +
      'command 为命令名，args 为参数数组（字符串）。常用命令：' +
      '暂停/播放：set pause yes|no、cycle pause；' +
      '跳转：seek <秒> (相对)、seek <秒> absolute、seek <百分比> absolute-percent、frame-step、frame-back-step；' +
      '音量：set volume <0-100>、add volume <±n>、cycle mute；' +
      '倍速：set speed <n>、multiply speed <n>；' +
      '音视频/字幕轨：cycle audio、cycle sub、set aid <idx>、set sid <idx>、set sub-visibility yes|no；' +
      '画面均衡：set brightness|contrast|saturation|gamma <±100>、reset-video-eq；' +
      '缩放平移：set video-zoom <n>、reset-pan-zoom；' +
      '全屏/置顶：cycle fullscreen、cycle ontop；' +
      '播放列表：playlist-next、playlist-prev、show-playlist；' +
      '截图：screenshot (参数为 video|window|subtitles)；' +
      'AB 循环：ab-loop；显示文字：show-text <文本>。' +
      '不需要返回值的控制类命令优先用它；查询状态请用 get_state。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令名，如 set / add / cycle / seek / screenshot / playlist-next 等' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数列表，按顺序拼接在命令名之后，如 ["volume","80"]',
        },
      },
      required: ['command'],
    },
  },
];

/**
 * 执行单个工具。失败也返回结构化结果（不抛），由编排层决定如何回灌。
 * @param {string} name
 * @param {object} args
 * @param {object} ctx 注入的执行上下文
 * @returns {Promise<object>} { ok, ... }
 */
async function executeTool(name, args, ctx) {
  args = args || {};
  switch (name) {
    case 'auto_subtitle': {
      const lang = args.lang || ctx.profile.getPreference('subtitleLang', 'chi');
      const file = ctx.getCurrentFile && ctx.getCurrentFile();
      if (!file) return { ok: false, error: '没有正在播放的文件' };
      const res = await ctx.downloadSubtitle(file, lang);
      ctx.profile.recordAction('subtitleLoads');
      ctx.profile.setPreference('subtitleLang', lang);
      return { ok: true, lang, ...res };
    }
    case 'auto_danmaku': {
      const source = args.source || ctx.profile.getPreference('danmakuSource', 'dandanplay');
      const file = ctx.getCurrentFile && ctx.getCurrentFile();
      if (!file) return { ok: false, error: '没有正在播放的文件' };
      const res = await ctx.autoMatchDanmaku(file, source);
      ctx.profile.recordAction('danmakuLoads');
      ctx.profile.setPreference('danmakuSource', source);
      return { ok: true, source, ...res };
    }
    case 'set_setting': {
      if (!args.key) return { ok: false, error: '缺少 key' };
      ctx.setSetting(args.key, args.value);
      ctx.profile.recordAction('settingChanges');
      return { ok: true, key: args.key, value: args.value };
    }
    case 'debug_player': {
      const diag = ctx.getDiagnostics ? ctx.getDiagnostics() : ctx.getState();
      return { ok: true, diagnostics: diag };
    }
    case 'get_state': {
      return { ok: true, state: ctx.getState() };
    }
    case 'learn_preference': {
      if (!args.key) return { ok: false, error: '缺少 key' };
      ctx.profile.setPreference(args.key, args.value, { taught: true });
      return { ok: true, key: args.key, value: args.value, taught: true };
    }
    case 'player_command': {
      if (!args.command) return { ok: false, error: '缺少 command' };
      // args 统一转为字符串数组，交给渲染端命令总线（player.command 内部会按需 Number 化）
      const cmdArgs = [String(args.command)].concat(
        Array.isArray(args.args) ? args.args.map((a) => String(a)) : []
      );
      if (!ctx.runCommand) return { ok: false, error: '运行环境未提供 runCommand' };
      ctx.runCommand(cmdArgs);
      ctx.profile.recordAction('playerCommands');
      return { ok: true, command: cmdArgs.join(' ') };
    }
    default:
      return { ok: false, error: '未知工具: ' + name };
  }
}

/**
 * 转 OpenAI tools 格式（type:'function' 包裹）。
 * @returns {Array}
 */
function toOpenAITools() {
  return TOOL_DEFS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * 创建工具集。
 * @returns {{defs:Array, openaiTools:Array, call:Function}}
 */
function createTools() {
  return {
    defs: TOOL_DEFS,
    openaiTools: toOpenAITools(),
    /**
     * @param {string} name
     * @param {object} args
     * @param {object} ctx
     */
    async call(name, args, ctx) {
      return executeTool(name, args, ctx);
    },
  };
}

module.exports = { createTools, toOpenAITools, TOOL_DEFS, executeTool };
