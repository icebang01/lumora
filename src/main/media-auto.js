/**
 * 字幕/弹幕自动加载(自包含模块,ctx 注入模式)。
 * 从 index.js 拆出(2026-08):ffmpegExtractSubtitles/parseSrt/extractAndSendSubtitles/
 * maybeAutoLoadOnlineSubtitle/maybeAutoLoadDanmaku。
 * 用法:mediaAuto.setCtx({ CTX.sendToRenderer, CTX.Subtitles, CTX.Danmaku, CTX.MediaApply, ffmpegPath, spawn });
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { resolveBinary } = require('./ffmpeg/binaries');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }

/* ------------------------------------------------------------------ */
/* 字幕提取（ffmpeg 引擎）                                              */
/* ------------------------------------------------------------------ */

/**
 * 把指定字幕轨 dump 成 SRT 文本（仅文本字幕；图形字幕 PGS/DVD 由解码器
 * 标记 graphic，这里直接跳过）。用 -f srt 让 ffmpeg 把 ASS/WebVTT 等
 * 统一转成 SRT 纯文本，省去渲染端再认识多种格式。
 */
function ffmpegExtractSubtitles(filePath, index) {
  return new Promise((resolve, reject) => {
    const bin = resolveBinary('ffmpeg', (CTX.getConfig ? CTX.getConfig().get('ffmpeg-dir') : null) || null);
    if (!bin) return reject(new Error('找不到 ffmpeg'));
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', filePath,
      '-map', `0:s:${index}`,
      '-f', 'srt',
      '-',
    ];
    let out = '';
    let err = '';
    const proc = spawn(bin, args, { windowsHide: true });
    // ffmpeg stdout/stderr: raw buffer → UTF-8 解码
    proc.stdout.on('data', (d) => { out += typeof d === 'string' ? d : d.toString('utf8'); });
    proc.stderr.on('data', (d) => { err += typeof d === 'string' ? d : d.toString('utf8'); });
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      if (!out.trim()) {
        console.error('[lumen][sub] ffmpeg 无 stdout (code=' + code + ') stderr=' + err.slice(0, 300));
        return reject(new Error('字幕提取为空（可能是图形字幕或该轨无文本）'));
      }
      try {
        resolve(parseSrt(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** 解析 SRT 文本为 [{ start, end, text }]（单位：秒） */
function parseSrt(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length);
    if (lines.length < 2) continue;
    // 找带 --> 的时间轴行（可能带 index 行在前）
    let timeLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/-->/.test(lines[i])) { timeLine = i; break; }
    }
    if (timeLine < 0) continue;
    const m = lines[timeLine].match(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
    );
    if (!m) continue;
    const toSec = (h, mi, s, ms) => (+h) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    const txt = lines.slice(timeLine + 1).join('\n');
    // 去掉 ASS 残留的样式标签：花括号 {\an8} 与尖括号 <font ...>/<b> 等，
    // 否则这些标签会被当普通文字渲染成满屏乱码（"字幕无法显示"的真正元凶）
    const clean = txt.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (clean) cues.push({ start, end, text: clean });
  }
  return cues;
}

/** 提取并发送给渲染端；无字幕/图形字幕走降级路径。secondary=true 时作为第二字幕轨发送 */
function extractAndSendSubtitles(index, secondary = false) {
  const subs = (CTX.getCurrentInfo ? CTX.getCurrentInfo() : null && CTX.getCurrentInfo ? CTX.getCurrentInfo() : null.subtitle) || [];
  console.log('[lumen][sub] extractAndSendSubtitles index=' + index + (secondary ? ' [副]' : '') + ' 总轨数=' + subs.length);
  if (!subs.length || index == null || index < 0 || !subs[index]) {
    CTX.sendToRenderer('player:subtitles', { index: -1, cues: [], graphic: false, secondary });
    return;
  }
  const track = subs[index];
  if (track.graphic) {
    CTX.sendToRenderer('player:subtitles', { index, cues: [], graphic: true, secondary });
    return;
  }
  ffmpegExtractSubtitles(CTX.getCurrentInfo ? CTX.getCurrentInfo() : null.path, index)
    .then((cues) => {
      console.log('[lumen][sub] 提取成功 index=' + index + (secondary ? ' [副]' : '') + ' cues=' + cues.length);
      CTX.sendToRenderer('player:subtitles', { index, cues, graphic: false, secondary });
    })
    .catch((err) => {
      console.error('[lumen][sub] 提取失败:', err.message);
      CTX.sendToRenderer('player:subtitles', { index, cues: [], error: err.message, secondary });
    });
}

/**
 * 在线字幕自动匹配（设置 subtitles-autoload=yes 时触发）。
 * 行为委托给 media-apply.autoLoadSubtitle（与 AI 助手同源，保持 mpv/ffmpeg 两条应用路径一致）。
 */
async function maybeAutoLoadOnlineSubtitle(info) {
  try {
    const r = await CTX.MediaApply.autoLoadSubtitle(info, {
      Subtitles: CTX.Subtitles,
      Danmaku: CTX.Danmaku,
      sendToRenderer: CTX.sendToRenderer,
      config: CTX.getConfig ? CTX.getConfig() : null,
      useMpv: CTX.useMpv,
      subAdd: (p) => {
        if (CTX.useMpv && CTX.mpvBackend && CTX.mpvBackend.ready) {
          CTX.mpvBackend.command('sub-add', p, 'select').catch((e) => console.warn('[lumen][sub] sub-add 失败:', e.message));
        }
      },
    });
    if (r.ok) console.log('[lumen][sub] 自动匹配完成：' + r.name);
    else console.log('[lumen][sub] 自动匹配：' + (r.error || '无结果'));
  } catch (e) {
    console.warn('[lumen][sub] 自动加载在线字幕失败:', e.message);
  }
}

/**
 * 弹幕自动加载（设置 danmaku-autoload=yes 且有弹弹凭据/代理时触发）。
 * 行为委托给 media-apply.autoLoadDanmaku（与 AI 助手同源）。
 */
async function maybeAutoLoadDanmaku(info) {
  try {
    const r = await CTX.MediaApply.autoLoadDanmaku(info, { Subtitles: CTX.Subtitles, Danmaku: CTX.Danmaku, sendToRenderer: CTX.sendToRenderer });
    if (r.ok) console.log('[lumen][danmaku] 自动加载完成：' + r.count + ' 条');
    else console.log('[lumen][danmaku] 自动匹配：无候选源' + (r.errors && r.errors.length ? (' (errors: ' + r.errors.join('; ') + ')') : ''));
  } catch (e) {
    console.warn('[lumen][danmaku] 自动加载失败:', e.message);
  }
}

/* IPC 处理                                                            */
/* ------------------------------------------------------------------ */

module.exports = { setCtx, ffmpegExtractSubtitles, parseSrt, extractAndSendSubtitles, maybeAutoLoadOnlineSubtitle, maybeAutoLoadDanmaku };
