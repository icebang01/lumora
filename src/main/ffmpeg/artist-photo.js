'use strict';
/**
 * 艺人写真照片获取。
 *
 * 用于「歌词优先」等需要艺人照片做背景的场景。策略：
 *   1. 本地缓存/用户目录：%APPDATA%/Lumora/artist-photos/<safe-artist>.jpg
 *   2. 网易云音乐艺人搜索自动下载（对华语艺人覆盖较好）
 *   3. 都没找到时返回 null，调用方回退到专辑封面
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

const NETEASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NETEASE_TIMEOUT_MS = 8000;

function artistPhotosDir() {
  const dir = path.join(app.getPath('userData'), 'artist-photos');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  return dir;
}

function safeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'unknown';
}

function localPath(artist) {
  return path.join(artistPhotosDir(), safeName(artist) + '.jpg');
}

function fileToDataUrl(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (!buf.length) return null;
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch { return null; }
}

function neteaseGetJson(path) {
  return new Promise((resolve) => {
    const url = `https://music.163.com${path}`;
    let req;
    try {
      req = https.get(new URL(url), {
        timeout: NETEASE_TIMEOUT_MS,
        headers: {
          'User-Agent': NETEASE_UA,
          'Referer': 'https://music.163.com/',
          'Accept': 'application/json, text/plain, */*',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          } else { resolve(null); }
        });
      });
    } catch { resolve(null); return; }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve(null); });
  });
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function pickNeteaseArtist(artists, artist) {
  if (!Array.isArray(artists) || !artists.length) return null;
  const target = normalizeText(artist);
  if (!target) return artists[0];
  // 优先精确匹配
  for (const a of artists) {
    if (normalizeText(a.name) === target) return a;
  }
  // 次优包含匹配
  for (const a of artists) {
    const n = normalizeText(a.name);
    if (n.includes(target) || target.includes(n)) return a;
  }
  return artists[0];
}

function downloadImage(url) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(new URL(url), {
        timeout: NETEASE_TIMEOUT_MS,
        headers: {
          'User-Agent': NETEASE_UA,
          'Referer': 'https://music.163.com/',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(downloadImage(res.headers.location));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(buf.length > 200 ? buf : null);
        });
      });
    } catch { resolve(null); return; }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve(null); });
  });
}

/**
 * 按艺人名获取写真照片。
 * @param {string} artist
 * @returns {Promise<{ok:true, dataUrl:string, source:'local'|'netease'}|{ok:false, error?:string}>}
 */
async function getArtistPhoto(artist) {
  const a = String(artist || '').trim();
  if (!a) return { ok: false, error: 'no artist' };

  // 1. 本地缓存/用户目录
  const local = localPath(a);
  if (fs.existsSync(local)) {
    const dataUrl = fileToDataUrl(local);
    if (dataUrl) return { ok: true, dataUrl, source: 'local' };
  }

  // 2. 网易云音乐搜索艺人
  const data = await neteaseGetJson(`/api/search/get/web?csrf_token=&s=${encodeURIComponent(a)}&type=100&offset=0&total=true&limit=10`);
  const artists = data && data.result && Array.isArray(data.result.artists) ? data.result.artists : [];
  const match = pickNeteaseArtist(artists, a);
  const picUrl = match && (match.picUrl || match.img1v1Url);
  if (!picUrl) return { ok: false, error: 'no artist image found' };

  // 下载并缓存（使用原图尺寸，去掉可能的缩放参数）
  const cleanUrl = picUrl.replace(/\?.*$/, '');
  const buf = await downloadImage(cleanUrl);
  if (!buf) return { ok: false, error: 'download failed' };

  try { fs.writeFileSync(local, buf); } catch { /* 缓存失败不影响本次返回 */ }
  return { ok: true, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, source: 'netease' };
}

module.exports = { getArtistPhoto, artistPhotosDir, safeName };
