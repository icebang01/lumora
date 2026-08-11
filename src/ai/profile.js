'use strict';

/**
 * 习惯画像（Habit Profile）
 * -------------------------------------------------------------
 * 本地 JSON 持久化的用户画像，支撑"助手学习用户习惯"：
 *   - preferences：当前生效的偏好（字幕语言、弹幕源、是否自动加载等）
 *   - taught：用户显式教过的偏好（最高优先）
 *   - stats：行为计数（字幕/弹幕加载次数、设置变更次数等）
 *   - history：最近行为（环形截断，最多 maxHistory 条）
 *
 * storage 可注入：生产用 fs（userData/ai-profile.json），测试用内存对象，
 * 这样画像逻辑可脱离磁盘单测。所有写操作经过 persist()，无 storage 时纯内存。
 */

/** @returns {object} 默认画像骨架 */
function DEFAULT_PROFILE() {
  return {
    version: 1,
    preferences: {
      subtitleLang: 'chi',
      danmakuSource: 'dandanplay',
      autoLoadSubtitle: true,
      autoLoadDanmaku: true,
    },
    taught: {}, // 用户显式教的偏好：key -> value
    stats: { subtitleLoads: 0, danmakuLoads: 0, settingChanges: 0, commands: 0 },
    history: [], // [{ type, meta, at }]
  };
}

/**
 * 创建画像实例。
 * @param {object} [opts]
 * @param {object} [opts.storage] { read():object|null, write(obj):void }
 * @param {number} [opts.maxHistory]
 */
function createProfile({ storage, maxHistory = 100 } = {}) {
  let data = DEFAULT_PROFILE();
  if (storage) {
    const loaded = storage.read();
    if (loaded && typeof loaded === 'object') {
      // 浅合并，保证新增字段有默认值
      data = Object.assign(DEFAULT_PROFILE(), loaded);
      data.preferences = Object.assign(DEFAULT_PROFILE().preferences, loaded.preferences || {});
    }
  }

  function persist() {
    if (storage) storage.write(data);
  }

  return {
    /** 只读访问原始数据（测试/调试用） */
    get data() {
      return data;
    },

    /**
     * 读取偏好，未设置时返回 fallback。
     * @param {string} key
     * @param {*} [fallback]
     */
    getPreference(key, fallback) {
      const v = data.preferences[key];
      return v !== undefined ? v : fallback;
    },

    /**
     * 写入偏好。
     * @param {string} key
     * @param {*} value
     * @param {object} [opts]
     * @param {boolean} [opts.taught] 是否为用户显式教学（记入 taught）
     */
    setPreference(key, value, { taught = false } = {}) {
      data.preferences[key] = value;
      if (taught) data.taught[key] = value;
      persist();
    },

    /**
     * 记录一次行为并计数；同时维护环形 history。
     * @param {string} type 计数键（如 subtitleLoads）
     * @param {object} [meta]
     */
    recordAction(type, meta = {}) {
      data.stats[type] = (data.stats[type] || 0) + 1;
      data.history.unshift({ type, meta, at: Date.now() });
      if (data.history.length > maxHistory) data.history.length = maxHistory;
      persist();
    },

    /**
     * 把画像编译成系统提示片段，让 LLM "知道"用户习惯。
     * 这是"学习用户习惯"在提示工程上的落点。
     * @returns {string}
     */
    summarize() {
      const p = data.preferences;
      const lines = ['【用户习惯画像】'];
      lines.push('- 字幕语言偏好：' + (p.subtitleLang || '未设置'));
      lines.push('- 弹幕源偏好：' + (p.danmakuSource || '未设置'));
      lines.push('- 自动加载字幕：' + (p.autoLoadSubtitle ? '是' : '否'));
      lines.push('- 自动加载弹幕：' + (p.autoLoadDanmaku ? '是' : '否'));
      const taughtKeys = Object.keys(data.taught);
      if (taughtKeys.length) {
        lines.push('- 用户明确设定的偏好：' + taughtKeys.map((k) => k + '=' + JSON.stringify(data.taught[k])).join('，'));
      }
      lines.push(
        '- 累计行为：字幕加载 ' +
          data.stats.subtitleLoads +
          ' 次，弹幕加载 ' +
          data.stats.danmakuLoads +
          ' 次，设置变更 ' +
          data.stats.settingChanges +
          ' 次'
      );
      return lines.join('\n');
    },
  };
}

module.exports = { createProfile, DEFAULT_PROFILE };
