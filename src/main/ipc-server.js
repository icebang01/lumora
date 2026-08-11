'use strict';
/**
 * JSON IPC 服务 —— 让外部程序能遥控播放器。
 *
 * 协议与 mpv 的 --input-ipc-server 保持一致：换行分隔的 JSON，
 * 请求形如 {"command": ["set_property", "pause", true], "request_id": 1}，
 * 响应形如 {"error": "success", "data": ..., "request_id": 1}，
 * 事件形如 {"event": "property-change", "name": "time-pos", "data": 12.3}。
 *
 * 这意味着为 mpv 写的脚本（比如 Plex/Jellyfin 的遥控插件、
 * 各种 Stream Deck 集成）稍作改路径就能直接用。
 *
 * Windows 走命名管道，Unix 走域套接字，Node 的 net 模块两者同一套 API。
 */

const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');

class IpcJsonServer extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = normalizePath(socketPath);
    this.server = null;
    this.clients = new Set();
  }

  async start() {
    // Unix 域套接字文件残留会导致 EADDRINUSE，先清理
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); } catch { /* 可能是别的进程正在用 */ }
    }

    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      socket.setEncoding('utf8');

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        // 防御：客户端发了超长无换行的垃圾，别让内存无限涨
        if (buffer.length > 1024 * 1024) {
          socket.write(JSON.stringify({ error: 'request too large' }) + '\n');
          buffer = '';
          return;
        }
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          this._handleLine(line, socket);
        }
      });

      socket.on('error', () => { /* 客户端断开由 close 处理 */ });
      socket.on('close', () => this.clients.delete(socket));
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  _handleLine(line, socket) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      socket.write(JSON.stringify({ error: 'invalid json' }) + '\n');
      return;
    }

    if (!msg.command || !Array.isArray(msg.command)) {
      socket.write(JSON.stringify({
        error: 'invalid command', request_id: msg.request_id,
      }) + '\n');
      return;
    }

    this.emit('command', msg, (response) => {
      try {
        socket.write(JSON.stringify(response) + '\n');
      } catch { /* 客户端可能已经断开 */ }
    });
  }

  /** 属性变化 / 播放事件广播给所有连接的客户端 */
  broadcast(payload) {
    const line = JSON.stringify(payload) + '\n';
    for (const c of this.clients) {
      try { c.write(line); } catch { this.clients.delete(c); }
    }
  }

  stop() {
    for (const c of this.clients) {
      try { c.destroy(); } catch { /* 已断开 */ }
    }
    this.clients.clear();
    if (this.server) {
      try { this.server.close(); } catch { /* 已关闭 */ }
      this.server = null;
    }
    if (process.platform !== 'win32' && this.socketPath && fs.existsSync(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); } catch { /* 忽略 */ }
    }
  }
}

/**
 * Windows 的命名管道必须以 \\.\pipe\ 开头，
 * 用户在配置里只写个名字时帮他补全。
 */
function normalizePath(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\.\\pipe\\') || p.startsWith('//./pipe/')) return p;
  return '\\\\.\\pipe\\' + p.replace(/[\\/:]/g, '-');
}

module.exports = { IpcJsonServer };
