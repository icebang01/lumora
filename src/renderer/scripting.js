/**
 * 脚本扩展与外部 IPC。
 *
 * 两件事共用同一套底层：都是"拿到一个命令数组，交给 player 执行"。
 * 脚本 API 刻意做成 mpv 的 mp.* 形状，为 mpv 写的小脚本（自动跳过
 * 片头、按文件名调整画面、外接硬件控制…）改动极小就能跑起来。
 *
 * 安全边界：脚本跑在渲染进程里，只能碰到我们喂给它的 mp 对象，
 * 拿不到 Node、拿不到 require，也拿不到 window.lumen。想读写磁盘
 * 只能通过播放器已有的命令，这是刻意的。
 */

const EVENTS = ['file-loaded', 'end-file', 'seek', 'playback-restart', 'pause', 'unpause', 'shutdown'];

export class ScriptHost {
  /**
   * @param dispatch app.js 的命令总线。脚本和外部 IPC 走它而不是直接
   *   走 player.command，这样 open-file / show-keymap 这类界面级命令
   *   对五个入口一视同仁。
   */
  constructor(player, osd, keybinds, dispatch) {
    this.player = player;
    this.osd = osd;
    this.keybinds = keybinds;
    this.dispatch = dispatch || ((args) => player.command(args));
    this.scripts = [];
    this.eventHandlers = new Map();  // event → Set<fn>
    this.timers = new Set();
    this.ipcObservers = new Map();   // observe id → { name, unobserve }
    this._nextClientId = 1;

    this._bindPlayerEvents();
  }

  /* ================= 用户脚本 ================= */

  async loadUserScripts() {
    let list = [];
    try {
      list = await window.lumen.listScripts();
    } catch {
      return [];
    }

    for (const s of list) {
      try {
        this._run(s.name, s.source);
        this.scripts.push({ name: s.name, ok: true });
      } catch (err) {
        console.error(`[script] ${s.name} 执行失败:`, err);
        this.scripts.push({ name: s.name, ok: false, error: err.message });
        this.osd.message('脚本出错', s.name, { duration: 4000, force: true });
      }
    }
    return this.scripts;
  }

  _run(name, source) {
    const mp = this._makeApi(name);
    // 不传 window/document，脚本只能通过 mp 说话
    const fn = new Function('mp', 'console', `"use strict";\n${source}\n`);
    fn(mp, makeLogger(name));
  }

  _makeApi(scriptName) {
    const p = this.player;
    const self = this;

    const api = {
      /** mp.command("seek 10") */
      command(str) {
        return self.dispatch(String(str).split(/\s+/).filter(Boolean));
      },
      /** mp.commandv("seek", 10, "absolute") */
      commandv(...args) { return self.dispatch(args.map(String)); },
      command_native(arr) {
        return self.dispatch(Array.isArray(arr) ? arr.map(String) : [String(arr)]);
      },

      get_property(name, def) {
        const v = p.getProperty(name);
        return v === undefined ? def : v;
      },
      get_property_string(name, def) {
        const v = p.getProperty(name);
        return v === undefined ? def : String(v);
      },
      get_property_number(name, def) {
        const v = Number(p.getProperty(name));
        return Number.isFinite(v) ? v : def;
      },
      get_property_bool(name, def) {
        const v = p.getProperty(name);
        return typeof v === 'boolean' ? v : def;
      },

      set_property(name, value) { p.setProperty(name, value); },
      set_property_number(name, value) { p.setProperty(name, Number(value)); },
      set_property_bool(name, value) { p.setProperty(name, !!value); },

      /** mpv 的签名是 (name, type, fn)，type 我们忽略但保留位置 */
      observe_property(name, type, fn) {
        const cb = typeof type === 'function' ? type : fn;
        if (typeof cb !== 'function') return;
        return p.observeProperty(name, (v) => cb(name, v));
      },

      add_key_binding(key, name, fn) {
        if (typeof name === 'function') { fn = name; name = `${scriptName}:${key}`; }
        return self.keybinds.addScriptBinding(key, name, fn);
      },
      add_forced_key_binding(key, name, fn) { return api.add_key_binding(key, name, fn); },

      register_event(name, fn) {
        if (!EVENTS.includes(name)) return;
        if (!self.eventHandlers.has(name)) self.eventHandlers.set(name, new Set());
        self.eventHandlers.get(name).add(fn);
      },

      /** script-binding <name> 触发的回调 */
      register_script_binding(name, fn) {
        return self.keybinds.addScriptBinding(`@${name}`, name, fn);
      },

      osd_message(text, duration) {
        self.osd.message(String(text), undefined, { duration: (duration || 1.5) * 1000, force: true });
      },

      add_timeout(sec, fn) {
        const id = setTimeout(() => { self.timers.delete(id); fn(); }, sec * 1000);
        self.timers.add(id);
        return id;
      },
      add_periodic_timer(sec, fn) {
        const id = setInterval(fn, sec * 1000);
        self.timers.add(id);
        return { kill: () => { clearInterval(id); self.timers.delete(id); } };
      },

      get_time() { return performance.now() / 1000; },
      get_script_name() { return scriptName; },

      msg: makeLogger(scriptName),
    };

    return api;
  }

  /** 由 app.js 在收到 script-binding 命令时调用 */
  triggerBinding(name) {
    const hit = [...this.keybinds.scriptBinds.values()].find((b) => b.name === name);
    if (hit) {
      try { hit.handler(); } catch (e) { console.error('[script] 绑定执行失败:', e); }
      return true;
    }
    return false;
  }

  /* ================= 事件广播 ================= */

  _bindPlayerEvents() {
    const p = this.player;

    p.addEventListener('loaded', () => this.emit('file-loaded'));
    p.addEventListener('eof', () => this.emit('end-file'));
    p.observeProperty('pause', (v) => this.emit(v ? 'pause' : 'unpause'));
  }

  emit(name, data) {
    const set = this.eventHandlers.get(name);
    if (set) {
      for (const fn of set) {
        try { fn(data || { event: name }); } catch (e) { console.error('[script] 事件处理出错:', e); }
      }
    }
    // 同步广播给外部 IPC 客户端
    this._ipcSend({ event: name, ...(data || {}) });
  }

  /* ================= 外部 JSON IPC ================= */

  attachIpc() {
    window.lumen.on('ipc:command', (msg) => this._handleIpc(msg));
  }

  _ipcSend(payload) {
    try { window.lumen.emitIpcEvent(payload); } catch { /* IPC 没开就静默丢弃 */ }
  }

  _handleIpc(msg) {
    const [cmd, ...args] = msg.command || [];
    const rid = msg.request_id;
    const reply = (data, error = 'success') => {
      this._ipcSend({ request_id: rid, error, data: data === undefined ? null : data });
    };

    try {
      switch (cmd) {
        case 'get_property':
        case 'get_property_string': {
          const v = this.player.getProperty(args[0]);
          if (v === undefined) return reply(null, 'property not found');
          return reply(cmd === 'get_property_string' ? String(v) : v);
        }

        case 'set_property':
        case 'set_property_string':
          this.player.setProperty(args[0], args[1]);
          return reply(null);

        case 'observe_property':
        case 'observe_property_string': {
          const id = Number(args[0]);
          const name = args[1];
          const un = this.player.observeProperty(name, (v) => {
            this._ipcSend({ event: 'property-change', id, name, data: v });
          });
          this.ipcObservers.set(id, { name, unobserve: un });
          return reply(null);
        }

        case 'unobserve_property': {
          const id = Number(args[0]);
          const o = this.ipcObservers.get(id);
          if (o) { o.unobserve(); this.ipcObservers.delete(id); }
          return reply(null);
        }

        case 'client_name':
          return reply(`lumen/${this._nextClientId++}`);

        case 'get_version':
          return reply(0x20000);

        case 'request_log_messages':
        case 'enable_event':
        case 'disable_event':
          return reply(null);

        default: {
          const ok = this.dispatch([cmd, ...args]);
          return reply(null, ok === false ? 'invalid command' : 'success');
        }
      }
    } catch (err) {
      return reply(null, err.message || 'error');
    }
  }
}

function makeLogger(tag) {
  const wrap = (level) => (...a) => console[level](`[${tag}]`, ...a);
  return {
    log: wrap('log'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    debug: wrap('debug'),
    verbose: wrap('debug'),
    fatal: wrap('error'),
  };
}
