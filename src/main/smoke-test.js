const { clamp } = require('./clamp');
/**
 * 冒烟测试(自包含模块)。
 * 从 index.js 拆出(2026-08):runSmokeTest 及其全部子测试块。
 * 依赖注入:teardown 由 index.js 传入(它持有全部资源引用)。
 */
const path = require('path');
const { app, dialog } = require('electron');

module.exports = {
  runSmokeTest,
  runDialogCancelTest,
  runOpenSettingsTest,
  runSettingsDblclickTest,
  runSettingsApplyTest,
  runKeymapTest,
  runFileAssocTest,
  runResumeTest,
  runPlaylistTest,
  runLoopModeTest,
};

async function runSmokeTest(win, deps = {}) {
  const teardown = deps.teardown;
  const pendingOpenFile = deps.pendingOpenFile;
  const currentInfo = deps.currentInfo;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalJs = (code) => win.webContents.executeJavaScript(code, true);
  const snap = () => evalJs('window.__lumen ? window.__lumen.snapshot() : null');
  const send = (args) => evalJs(`window.__lumen.run(${JSON.stringify(args)})`);

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`);
  };
  const skip = (name, detail) => {
    console.log(`  SKIP  ${name}${detail !== undefined ? '   ' + detail : ''}`);
  };

  console.log('\n=== Lumora 冒烟测试 ===');

  try {
    if (win.webContents.isLoading()) {
      await new Promise((res) => win.webContents.once('did-finish-load', res));
    }

    // ---- 1. 初始化 ----
    let s = null;
    for (let i = 0; i < 75; i++) {
      s = await snap();
      if (s && s.ready) break;
      await wait(200);
    }
    check('渲染端完成初始化', s && s.ready);
    if (!s || !s.ready) throw new Error('渲染端未在 15 秒内就绪');

    // 引擎模式决定断言语义：
    //   ffmpeg —— 帧经 WebSocket 进渲染端 WebGL2，renderedFrames/队列/像素回读有意义；
    //   mpv    —— mpv 直接在 videoWin 里渲染，渲染端无 WebGL 帧缓冲，
    //             probePixels() 返回 null，音频时钟也由 mpv 管理（渲染端 Web Audio 不参与）。
    const engine = s.engine;
    const ffmpegMode = engine === 'ffmpeg';

    if (s.voDisabled) {
      // 没 GPU 的环境（远程桌面、CI）不该判定为失败：这正是降级模式要覆盖的场景。
      // 但必须显式声明跳过了什么，否则一份"全绿"的报告会掩盖真相。
      console.log(`  SKIP  视频输出不可用，本轮跳过 GPU 相关检查（${s.voError}）`);
      check('无 GPU 时正确降级为纯音频模式', true);
    } else {
      check('WebGL2 上下文可用', !!(s.gl && s.gl.renderer), s.gl.renderer);
      check('浮点渲染目标可用（HDR 管线前提）', s.gl.floatFBO);
    }
    check('媒体流通道已连接', s.transport.connected);
    // ffmpeg 引擎的 AudioContext 是惰性创建（绕开 autoplay policy，需用户手势
    // 才以 running 态出生）。冒烟环境没有真实手势，先注入一次输入事件模拟，
    // 再判断音频是否就绪——证明"真实用户第一次点击后音频必然就绪"。
    if (s.engine === 'ffmpeg' && !s.audio.ready) {
      try {
        const wc = win.webContents;
        wc.sendInputEvent({ type: 'mouseDown', x: 400, y: 300, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: 400, y: 300, button: 'left', clickCount: 1 });
        await wait(800);
        s = await snap();
      } catch { /* 注入失败则按原状态判定 */ }
    }
    check('音频输出就绪', s.audio.ready, s.audio.state);
    check('键位表已载入', s.ui.keybinds > 0, `${s.ui.keybinds} 条`);
    check('用户脚本无加载错误', s.ui.scripts.every((x) => x.ok),
      s.ui.scripts.length ? s.ui.scripts.map((x) => x.name).join(',') : '无脚本');

    if (!pendingOpenFile) {
      console.log('  --  未指定媒体文件，跳过播放相关检查');
    } else {
    // ---- 2. 载入 ----
    // mpv 模式下 hasFile 与 duration 可能异步到达，等两者都就绪再断言。
    // 注意：hasFile/duration 来自 ffprobe（player:loaded 的 info），可能在 mpv
    // 真正 file-loaded 之前就绪。若此时就 break，紧接着的「播放推进」暂停重置
    // 会与渲染端 onLoaded 的 setProperty('pause', false)（载入即播放）发生
    // 竞态——executeJavaScript 可能插队，mpv 收到 pause=true 后被 onLoaded 的
    // pause=false 覆盖 → 播放一路狂奔、time-pos 超上限误报。等 idle-active=no
    //（mpv 离开 idle 态 = 文件已实际载入）再继续，onLoaded 早已执行完。
    // 注意：mpv JSON IPC 的布尔属性是 true/false，不是 'yes'/'no' 字符串。
    for (let i = 0; i < 60; i++) {
      s = await snap();
      if (s.hasFile && s.props.duration > 0
          && (ffmpegMode || s.props['idle-active'] === false)) break;
      await wait(250);
    }
    check('媒体文件载入成功', s.hasFile, s.props['media-title']);
    check('时长解析正确', s.props.duration > 0, `${s.props.duration.toFixed(2)}s`);

      // ---- 3. 播放 ----
      // 载入循环期间 mpv 已经在播（大文件 ffprobe 探测 + mpv 载入可能耗 10s+，
      // time-pos 已累积到几十秒）。先暂停把播放时钟归零，再重新开始计时，
      // 否则「播放推进」的上下界（<5.0s）对大文件必然误报。
      await send(['set', 'pause', true]);
      await wait(300);
      await send(['set', 'pause', false]);
      await wait(2500);
      const a = await snap();
      const hasVideo = !a.voDisabled && (!!a.video || a.stats.renderedFrames > 0);
      const hasFrames = a.stats.renderedFrames > 0;

      // 诊断：视频帧未渲染时输出详细状态，帮助定位是 ffmpeg 没发帧
      // 还是 renderer 没收到帧还是收到了但 upload/render 失败
      // （mpv 模式下 renderedFrames 恒为 0 属正常，无需诊断刷屏）
      if (!hasFrames && ffmpegMode) {
        console.log('  --  视频帧未渲染。诊断快照：', JSON.stringify({
          voDisabled: a.voDisabled,
          videoConfigured: a.videoConfigured,
          videoTrackInfo: a.videoTrackInfo,
          totalReceived: a.stats.totalReceived,
          queued: a.stats.queued,
          presented: a.stats.presented,
          dropped: a.stats.dropped,
          renderedFrames: a.stats.renderedFrames,
          epoch: a.transport.epoch,
          audioBuffered: a.audio.buffered.toFixed(2),
          feeding: a.audio.enabled,
        }));
      }

      // 上下界都要卡。只判断"在前进"会放过时钟失控 —— 背压失效时
      // 时间码能在 2.5 秒里冲到 18 秒，照样满足"大于 0.3"
      // ffmpeg 引擎：首帧 PTS 校正可能把时间码拉回关键帧位置（sdr-1080p
      // 关键帧在 0.27s），渲染帧流不受校正影响，作为兜底信号。
      const timeAdv = a.props['time-pos'] > 0.3 && a.props['time-pos'] < 5.0;
      const frameAdv = ffmpegMode && a.stats.renderedFrames > 15;
      check('播放推进（时间码前进）',
        timeAdv || frameAdv,
        `time-pos=${a.props['time-pos'].toFixed(3)}（预期 ≈2.5s） pause=${a.props.pause} idle-active=${JSON.stringify(a.props['idle-active'])}` +
        (frameAdv && !timeAdv ? `（帧流 ${a.stats.renderedFrames} 帧兜底）` : ''));
      check('音频缓冲未溢出（背压有效）', a.audio.overflow === 0,
        `丢 ${a.audio.overflow} 帧 / 设备缓冲 ${a.audio.worklet.toFixed(2)}s`);
      if (a.audio.enabled) {
        if (ffmpegMode) {
          // 冒烟环境用合成输入事件模拟手势激活 AudioContext，worklet 时钟
          // 启动与数据补发存在竞态（偶发 mediaTime=0）。最多重试 3 次
          //（每次等 1s），真实用户环境（真实点击、context 出生即 running）
          // 无此问题；仍失败时输出 worklet 快照便于定位。
          let mt = a.audio.mediaTime;
          let snapState = a.audio;
          for (let r = 0; r < 3 && (mt === null || mt <= 0.2); r++) {
            await wait(1000);
            snapState = (await snap()).audio;
            mt = snapState.mediaTime;
          }
          check('音频时钟在走', mt !== null && mt > 0.2,
            `audio=${mt === null ? 'n/a' : mt.toFixed(3)}` +
            (mt !== null && mt <= 0.2 ? ` hasBase=${snapState.hasBase} playing=${snapState.playing} consumed=${snapState.consumed}` : ''));
        } else {
          // mpv 模式：音频时钟由 mpv 进程管理，渲染端 Web Audio 引擎不参与，
          // mediaTime 恒为 null 属正常；播放进度已由上方「播放推进（时间码前进）」覆盖。
          skip('音频时钟在走（mpv 模式：音频时钟由 mpv 管理，渲染端 Web Audio 时钟不参与）');
        }
      } else {
        skip('音频时钟在走（该文件无音轨）');
      }

      if (hasFrames) {
        check('视频帧持续送达', a.stats.renderedFrames > 20,
          `${a.stats.renderedFrames} 帧 / 丢 ${a.stats.dropped}`);
        check('音画同步在 ±40ms 内', Math.abs(a.stats.avSync) < 0.04,
          `${(a.stats.avSync * 1000).toFixed(1)}ms`);
      } else if (!ffmpegMode) {
        skip('视频帧持续送达（mpv 模式：帧由 mpv 在 videoWin 内渲染，渲染端 renderedFrames 恒为 0）');
        skip('音画同步在 ±40ms 内（mpv 模式：avSync 由 mpv 进程管理）');
      }

      if (hasVideo) {
        check('像素格式已协商', !!a.video, a.video ? `${a.video.pixfmt} ${a.video.w}×${a.video.h}` : '');

        // mpv 模式下画面由 mpv 直接输出到 videoWin，渲染端没有 WebGL 帧缓冲，
        // probePixels() 返回 null —— 这种情况要跳过 GPU 回读断言，不能崩溃。
        const px = await evalJs('window.__lumen.probePixels()');
        if (!px) {
          const why = ffmpegMode
            ? '（probePixels 返回 null，渲染端 GL 不可用）'
            : '（mpv 模式：画面由 mpv 直接输出到 videoWin，渲染端无 WebGL 帧缓冲可供回读）';
          skip('画面非全黑（GPU 回读）' + why);
          skip('画面有内容变化（非纯色）' + why);
        } else {
          const lum = px.samples.map((c) => c[0] + c[1] + c[2]);
          check('画面非全黑（GPU 回读）', lum.some((v) => v > 24),
            `采样亮度 ${Math.min(...lum)}..${Math.max(...lum)}`);
          check('画面有内容变化（非纯色）',
            new Set(px.samples.map((c) => c.join(','))).size > 1,
            `${px.w}×${px.h}`);
        }
      }

      // ---- 4. 跳转 ----
      // 先暂停再跳。跳完还让它继续播的话，等待期间时间码自然往前走，
      // 断言测到的是"跳转 + 播放"的混合结果，落点精度根本无从判断
      const target = clamp(a.props.duration * 0.5, 1, 8);
      const epochBefore = a.transport.epoch;
      await send(['set', 'pause', true]);
      await wait(300);
      const paused = await snap();
      await send(['seek', target, 'absolute']);
      await wait(1200);
      const b = await snap();
    check('跳转到达目标位置', Math.abs(b.props['time-pos'] - target) < 0.6,
      `目标 ${target.toFixed(2)}s → 实到 ${b.props['time-pos'].toFixed(2)}s`);
    if (ffmpegMode) {
      check('跳转后代际号递增', b.transport.epoch > epochBefore,
        `${epochBefore} → ${b.transport.epoch}`);
    } else {
      skip('跳转后代际号递增（mpv 模式：mpv 内部处理 seek，渲染端 epoch 不递增）');
    }
    if (hasFrames) {
        // mpv 语义：暂停时跳转也要立刻把目标帧顶到屏幕上
        check('暂停态跳转已呈现目标帧',
          b.stats.renderedFrames > paused.stats.renderedFrames,
          `+${b.stats.renderedFrames - paused.stats.renderedFrames} 帧`);
      } else if (!ffmpegMode) {
        skip('暂停态跳转已呈现目标帧（mpv 模式：mpv 保证暂停跳转即时呈现目标帧，渲染端无帧计数）');
      }

      // 恢复播放，确认跳转之后整条管线真的重新跑起来了
      // 注意：8K 10bit 高码率素材 seek 后解码追赶可能超过 1.5s
      //（回跳几十秒 = demuxer 回退 + 解码管线重建，裸 mpv 实测 1.5s 仅恢复
      // 0.13s、4s 才回到正常速率），窗口给 4s 才对极限素材公平。
      await send(['set', 'pause', false]);
      let b2 = null;
      if (ffmpegMode) {
        // ffmpeg seek 是关键帧对齐（无 hr-seek）：恢复后首帧到达时可能触发
        // PTS 校正（时间码回退到实际关键帧位置）。时间码推进可能被校正
        // 打断，但渲染帧流是播放恢复的可靠信号（帧在持续渲染=管线在跑），
        // 两者满足其一即视为恢复。
        await wait(3000);
        const b1 = await snap();
        await wait(2000);
        b2 = await snap();
        const timeAdv = b2.props['time-pos'] > b1.props['time-pos'] + 0.2;
        const frameAdv = b2.stats.renderedFrames > b1.stats.renderedFrames + 5;
        check('跳转后播放恢复', timeAdv || frameAdv,
          `${b1.props['time-pos'].toFixed(2)}s → ${b2.props['time-pos'].toFixed(2)}s` +
          (frameAdv ? `（帧流 +${b2.stats.renderedFrames - b1.stats.renderedFrames}）` : ''));
      } else {
        await wait(4000);
        b2 = await snap();
        check('跳转后播放恢复',
          b2.props['time-pos'] > b.props['time-pos'] + 0.4,
          `${b.props['time-pos'].toFixed(2)}s → ${b2.props['time-pos'].toFixed(2)}s`);
      }
      if (hasFrames) {
        check('跳转后帧流恢复', b2.stats.renderedFrames > b.stats.renderedFrames);
      } else if (!ffmpegMode) {
        skip('跳转后帧流恢复（mpv 模式：帧流由 mpv 管理，渲染端无帧计数）');
      }

      // ---- 5. 命令总线 ----
      await send(['set', 'pause', true]);
      await wait(300);
      check('暂停命令生效', (await snap()).props.pause);

      await send(['add', 'volume', -15]);
      await send(['cycle', 'mute']);
      await send(['set', 'speed', 1.5]);
      await send(['cycle', 'deband']);
      // 8K profile 会强制 scale=bilinear（EWA Lanczos 在 8K 下 GPU 过载），
      // 所以 cycle 前的初始值不固定。断言轮换生效（值改变且在候选内）
      // 即可，不假设初始是 ewa_lanczos。
      const scalerBefore = (await snap()).props.scaler;
      await send(['cycle-values', 'scaler', 'bilinear', 'ewa_lanczos']);
      await send(['set', 'contrast', 12]);
      await wait(400);
      const c = await snap();
      check('音量属性可写', c.props.volume === 85, String(c.props.volume));
      check('静音开关可切', c.props.mute === true);
      check('倍速属性可写', c.props.speed === 1.5);
      check('去色带开关可切', c.props.deband === true);
      check('缩放算法可轮换',
        c.props.scaler !== scalerBefore && ['bilinear', 'ewa_lanczos'].includes(c.props.scaler),
        `${scalerBefore} → ${c.props.scaler}`);
      check('色彩均衡可写', c.props.contrast === 12);

      if (hasVideo) {
        const px2 = await evalJs('window.__lumen.probePixels()');
        if (!px2) {
          skip('切换渲染选项后画面仍正常（mpv 模式：渲染端无 WebGL 帧缓冲可回读）');
        } else {
          check('切换渲染选项后画面仍正常',
            px2.samples.some((cc) => cc[0] + cc[1] + cc[2] > 24));
        }
      }

      // ---- 6. 逐帧与章节 ----
      if (hasFrames) {
        // 先暂停，等队列填满，再逐帧 —— 避免播放→暂停瞬间队列恰好被掏空
        await send(['set', 'pause', true]);
        await wait(400);
        const pre = await snap();
        const before = pre.props['time-pos'];
        const qBefore = pre.stats.queued;
        await send(['frame-step']);
        await wait(600);
        const post = await snap();
        const after = post.props['time-pos'];
        check('逐帧前进一帧', after > before,
          `${before.toFixed(3)} → ${after.toFixed(3)}（队列 ${qBefore}→${post.stats.queued}）`);
      } else if (!ffmpegMode) {
        skip('逐帧前进一帧（mpv 模式：frame-step 由 mpv 命令总线处理，渲染端无帧计数）');
      }
      if (currentInfo && currentInfo.chapters.length > 1) {
        await send(['add', 'chapter', 1]);
        await wait(1200);
        const d = await snap();
        check('章节跳转可用', d.props.chapter >= 0, `chapter=${d.props.chapter}`);
      }

      // ---- 7. UI 浮层 ----
      await send(['cycle', 'stats']);
      await wait(300);
      check('统计面板可开启', (await snap()).ui.statsVisible);
      await send(['cycle', 'stats']);
    }
  } catch (err) {
    check('测试过程未抛异常', false, err.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.log('未通过：\n  - ' + failed.map((f) => f.name).join('\n  - '));
  }
  console.log('=== 冒烟测试结束 ===\n');

  smokeDone = true;
  const code = failed.length ? 1 : 0;

  // app.exit() 不触发 before-quit，得自己收尾
  teardown();

  // GPU 进程反复崩溃时（无显卡的 CI/远程会话），Chromium 的关闭流程
  // 可能卡死在等待 GPU 通道回收上，app.exit() 也拽不动它。
  // 给一个硬性兜底：结论已经打印完了，进程赖着不走没有任何意义。
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();

  app.exit(code);
}

/* ------------------------------------------------------------------ */
/* 对话框取消后黑屏专项测试                                              */
/* ------------------------------------------------------------------ */

async function runDialogCancelTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 对话框取消后黑屏专项测试 ===');

  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(500); // 等 idle 屏稳定

  // 500ms 后向当前活动窗口发送 Escape，取消文件对话框
  setTimeout(() => {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ESC}")';
    exec(`powershell -NoProfile -Command "${ps}"`, (err) => {
      if (err) console.error('[dialog-cancel-test] 发送 Escape 失败:', err.message);
    });
  }, 500);

  const res = await dialog.showOpenDialog(win, {
    title: '【自动测试】打开媒体文件',
    properties: ['openFile'],
    filters: [{ name: '全部文件', extensions: ['*'] }],
  });

  console.log(`[dialog-cancel-test] 对话框结果: canceled=${res.canceled}`);
  await wait(600); // 等 renderer 端恢复 + 任何重绘手段生效

  // 截图并判断是否为全黑
  const img = await win.webContents.capturePage();
  const bitmap = img.toBitmap();
  let blackPixels = 0;
  const total = bitmap.length / 4;
  for (let i = 0; i < bitmap.length; i += 4) {
    const r = bitmap[i], g = bitmap[i + 1], b = bitmap[i + 2];
    if (r < 10 && g < 10 && b < 10) blackPixels += 1;
  }
  const blackRatio = blackPixels / total;
  const passed = blackRatio < 0.85;
  console.log(`[dialog-cancel-test] 黑像素比例: ${(blackRatio * 100).toFixed(2)}%`);
  console.log(`[dialog-cancel-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 对话框取消后黑屏专项测试结束 ===\n');

  const code = passed ? 0 : 1;
  if (typeof teardown === 'function') teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}

/* ------------------------------------------------------------------ */
/* 设置窗口构建测试                                                    */
/* ------------------------------------------------------------------ */

async function runOpenSettingsTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 设置窗口构建测试 ===');

  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(800);

  const pageErrors = [];
  const onConsole = (_e, level, message) => { if (level === 3) pageErrors.push(message); };
  win.webContents.on('console-message', onConsole);

  const res = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.getElementById('tb-settings');
    if (!btn) return { ok: false, error: '找不到 tb-settings 按钮' };
    btn.click();
    await new Promise((r) => requestAnimationFrame(() => r()));
    return {
      ok: true,
      panelVisible: !document.getElementById('settings-panel').classList.contains('hidden'),
      sections: document.querySelectorAll('.settings-section').length,
      navItems: document.querySelectorAll('.settings-nav-item').length,
      rows: document.querySelectorAll('.set-row').length,
      selects: document.querySelectorAll('.set-select').length,
      toggles: document.querySelectorAll('.set-toggle').length,
      sliders: document.querySelectorAll('.set-slider').length,
      contentChildren: document.querySelector('#settings-content').children.length,
    };
  })()`);

  await wait(300);
  win.webContents.off('console-message', onConsole);

  const passed = res.ok && res.panelVisible && res.sections === 5 &&
    res.navItems === 5 && res.rows > 0 && pageErrors.length === 0;
  console.log('[open-settings-test]', JSON.stringify(res));
  if (pageErrors.length) console.log('[open-settings-test] 页面错误:', pageErrors.join(' | '));
  console.log(`[open-settings-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 设置窗口构建测试结束 ===\n');

  const code = passed ? 0 : 1;
  teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}

/* ------------------------------------------------------------------ */
/* 设置窗口双击穿透测试                                                */
/* ------------------------------------------------------------------ */

async function runSettingsDblclickTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 设置窗口双击穿透测试 ===');

  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(800);

  const res = await win.webContents.executeJavaScript(`(async () => {
    // 打开设置面板
    document.getElementById('tb-settings').click();
    await new Promise((r) => requestAnimationFrame(() => r()));

    const panel = document.getElementById('settings-panel');
    if (!panel || panel.classList.contains('hidden')) {
      return { ok: false, error: '设置面板未打开' };
    }

    // 拦截 openDialog：如果双击穿透到 idle 背景，它会调用此方法
    let openDialogCalled = false;
    const orig = window.lumen.openDialog;
    window.lumen.openDialog = async () => { openDialogCalled = true; return { canceled: true }; };

    try {
      const settingsWin = document.querySelector('.settings-window');
      const rect = settingsWin.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // 模拟在设置窗口中央双击
      const dbl = new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
      });
      settingsWin.dispatchEvent(dbl);

      // 给事件处理留出时间
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      window.lumen.openDialog = orig;
    }

    return {
      ok: true,
      openDialogCalled,
      settingsOpen: document.body.classList.contains('settings-open'),
      panelVisible: !panel.classList.contains('hidden'),
    };
  })()`);

  const passed = res.ok && !res.openDialogCalled && res.settingsOpen && res.panelVisible;
  console.log('[settings-dblclick-test]', JSON.stringify(res));
  console.log(`[settings-dblclick-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 设置窗口双击穿透测试结束 ===\n');

  const code = passed ? 0 : 1;
  teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}

/* ------------------------------------------------------------------ */
/* 设置项即时生效测试                                                  */
/* ------------------------------------------------------------------ */

async function runSettingsApplyTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 设置项即时生效测试 ===');

  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(800);

  const res = await win.webContents.executeJavaScript(`(async () => {
    // 打开设置面板并确保已构建
    document.getElementById('tb-settings').click();
    await new Promise((r) => requestAnimationFrame(() => r()));

    const panel = document.getElementById('settings-panel');
    if (!panel || panel.classList.contains('hidden')) {
      return { ok: false, error: '设置面板未打开' };
    }

    // 找到"显示控制条"开关，验证每次点击都会翻转 body 的 no-osc 类
    const oscToggle = document.querySelector('.set-toggle[data-key="osc"]');
    if (!oscToggle) return { ok: false, error: '找不到 osc 开关' };

    const state0 = document.body.classList.contains('no-osc');
    oscToggle.click();
    await new Promise((r) => setTimeout(r, 50));
    const state1 = document.body.classList.contains('no-osc');

    oscToggle.click();
    await new Promise((r) => setTimeout(r, 50));
    const state2 = document.body.classList.contains('no-osc');

    return {
      ok: true,
      state0,
      state1,
      state2,
      invertedOnce: state1 !== state0,
      restored: state2 === state0,
    };
  })()`);

  const passed = res.ok && res.invertedOnce && res.restored;
  console.log('[settings-apply-test]', JSON.stringify(res));
  console.log(`[settings-apply-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 设置项即时生效测试结束 ===\n');

  const code = passed ? 0 : 1;
  teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}

/* ------------------------------------------------------------------ */
/* 键位速查面板测试                                                    */
/* ------------------------------------------------------------------ */

async function runKeymapTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 键位速查面板测试 ===');

  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(800);

  const res = await win.webContents.executeJavaScript(`(async () => {
    // 通过命令总线打开键位面板
    window.__lumen.run(['show-keymap']);
    await new Promise((r) => requestAnimationFrame(() => r()));

    const panel = document.getElementById('keymap-panel');
    if (!panel) return { ok: false, error: '找不到 keymap-panel' };
    if (panel.classList.contains('hidden')) {
      return { ok: false, error: '键位面板未打开' };
    }

    const windowEl = document.querySelector('.keymap-window');
    const bodyHasClass = document.body.classList.contains('keymap-open');
    const rowCount = document.querySelectorAll('#keymap-body .km-row').length;
    const groupCount = document.querySelectorAll('#keymap-body .km-group').length;

    // 点击关闭按钮
    document.getElementById('keymap-close').click();
    await new Promise((r) => requestAnimationFrame(() => r()));

    return {
      ok: true,
      panelVisible: !panel.classList.contains('hidden'),
      bodyHasClass,
      rowCount,
      groupCount,
      closed: panel.classList.contains('hidden'),
      bodyClassAfterClose: document.body.classList.contains('keymap-open'),
    };
  })()`);

  const passed = res.ok && res.bodyHasClass && res.rowCount > 0 && res.groupCount > 0 && res.closed && !res.bodyClassAfterClose;
  console.log('[keymap-test]', JSON.stringify(res));
  console.log(`[keymap-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 键位速查面板测试结束 ===\n');

  const code = passed ? 0 : 1;
  teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}

/* ------------------------------------------------------------------ */
/* 文件关联测试                                                        */
/* ------------------------------------------------------------------ */

async function runFileAssocTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 文件关联测试 ===');
  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(800);

  // 与本测试启动命令里传入的虚拟路径保持一致（__dirname 为 src/main）
  const dummy = path.resolve(__dirname, '..', '..', 'assoc-dummy.mp4');

  // 1) 命令行参数提取：双击文件启动时应被解析为待播文件
  const pending = await win.webContents.executeJavaScript('window.__pendingFile || null');

  // 2) IPC 链路：主进程转发 app:open-file，渲染端应记录
  win.webContents.send('app:open-file', { path: dummy });
  await wait(200);
  const received = await win.webContents.executeJavaScript('window.__test_openFile || null');

  const pendingOk = pending === dummy;
  const receivedOk = received === dummy;
  const passed = pendingOk && receivedOk;
  console.log('[file-assoc-test]', JSON.stringify({ expected: dummy, pending, received, pendingOk, receivedOk }));
  console.log(`[file-assoc-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 文件关联测试结束 ===\n');

  const code = passed ? 0 : 1;
  teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}

/* ------------------------------------------------------------------ */
/* 续播 UI 测试                                                        */
/* ------------------------------------------------------------------ */

async function runResumeTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 续播 UI 测试 ===');
  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(800);

  const seed = {
    path: path.resolve(__dirname, '..', 'resume-seed.mkv'),
    time: 750,        // 12:30
    duration: 6000,   // 1:40:00
    title: '测试影片',
    savedAt: Date.now(),
  };
  // 模拟"上次退出时"留下的续播点
  saveResume(seed);

  // 刷新卡片（正常情况下随 idle 进入自动刷新；测试里手动触发保证确定性）
  await win.webContents.executeJavaScript('window.__lumen.refreshResumeCard()');
  await wait(300);

  const res = await win.webContents.executeJavaScript(`(async () => {
    const card = document.getElementById('resume-card');
    const visible = !!(card && !card.classList.contains('hidden'));
    const title = card ? card.querySelector('.resume-title').textContent : '';
    const meta = card ? card.querySelector('.resume-meta').textContent : '';
    const btn = document.getElementById('resume-play');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 100));
    return { visible, title, meta, clicked: window.__test_resumeClicked || null };
  })()`);

  const passed = res.visible && res.title === seed.title && /12:30/.test(res.meta) && res.clicked === seed.path;
  console.log('[resume-test]', JSON.stringify(res));
  console.log(`[resume-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 续播 UI 测试结束 ===\n');

  const code = passed ? 0 : 1;
  teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}

/* ------------------------------------------------------------------ */
/* 播放列表测试                                                        */
/* ------------------------------------------------------------------ */

async function runPlaylistTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 播放列表测试 ===');
  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(800);

  // 使用真实存在的测试媒体文件
  const mediaA = path.resolve(__dirname, '..', '..', 'testmedia', 'sdr-1080p.mp4');
  const mediaB = path.resolve(__dirname, '..', '..', 'testmedia', 'chapters.mkv');
  const files = [mediaA, mediaB];

  // 1) 模拟多选打开：调用渲染端 setPlaylist
  await win.webContents.executeJavaScript(`(async () => {
    window.__lumen.__setPlaylist(${JSON.stringify(files)}, 0);
    return { count: window.__lumen.__getPlaylistLength() };
  })()`);
  await wait(200);

  const state1 = await win.webContents.executeJavaScript(`(() => ({
    count: window.__lumen.__getPlaylistLength(),
    index: window.__lumen.__getPlaylistIndex(),
    panelVisible: window.__lumen.__isPlaylistPanelVisible(),
  }))()`);

  // 2) 打开面板，检查渲染
  await win.webContents.executeJavaScript(`window.__lumen.__togglePlaylistPanel()`);
  await wait(200);

  const state2 = await win.webContents.executeJavaScript(`(() => {
    const items = document.querySelectorAll('#playlist-list .playlist-item');
    const active = document.querySelector('#playlist-list .playlist-item.active');
    return {
      panelVisible: window.__lumen.__isPlaylistPanelVisible(),
      itemCount: items.length,
      activeIndex: active ? Array.from(items).indexOf(active) : null,
    };
  })()`);

  // 3) 测试 goto(1)
  await win.webContents.executeJavaScript(`window.__lumen.__playlistGoto(1)`);
  await wait(100);
  const state3 = await win.webContents.executeJavaScript(`(() => ({
    index: window.__lumen.__getPlaylistIndex(),
  }))()`);

  // 4) 测试 prev → 回到 0
  await win.webContents.executeJavaScript(`window.__lumen.__playlistJump(-1)`);
  await wait(100);
  const state4 = await win.webContents.executeJavaScript(`(() => ({
    index: window.__lumen.__getPlaylistIndex(),
  }))()`);

  // 5) 测试 remove(1) → 列表变 1 项
  await win.webContents.executeJavaScript(`window.__lumen.__playlistRemove(1)`);
  await wait(100);
  const state5 = await win.webContents.executeJavaScript(`(() => ({
    count: window.__lumen.__getPlaylistLength(),
  }))()`);

  // 6) 关闭面板
  await win.webContents.executeJavaScript(`window.__lumen.__closePlaylistPanel()`);
  await wait(100);
  const state6 = await win.webContents.executeJavaScript(`(() => ({
    panelVisible: window.__lumen.__isPlaylistPanelVisible(),
  }))()`);

  const checks = {
    setPlaylist: state1.count === 2 && state1.index === 0,
    panelRender: state2.panelVisible === true && state2.itemCount === 2 && state2.activeIndex === 0,
    goto: state3.index === 1,
    prev: state4.index === 0,
    remove: state5.count === 1,
    closePanel: state6.panelVisible === false,
  };
  const passed = Object.values(checks).every(Boolean);
  console.log('[playlist-test]', JSON.stringify({ state1, state2, state3, state4, state5, state6, checks }));
  console.log(`[playlist-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 播放列表测试结束 ===\n');

  const code = passed ? 0 : 1;
  teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}

async function runLoopModeTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n=== 循环模式测试 ===');
  if (win.webContents.isLoading()) {
    await new Promise((res) => win.webContents.once('did-finish-load', res));
  }
  await wait(800);

  const mediaA = path.resolve(__dirname, '..', '..', 'testmedia', 'sdr-1080p.mp4');
  const mediaB = path.resolve(__dirname, '..', '..', 'testmedia', 'chapters.mkv');
  const files = [mediaA, mediaB];

  // 设置播放列表（2 项），用于测试 random 选位
  await win.webContents.executeJavaScript(`window.__lumen.__setPlaylist(${JSON.stringify(files)}, 0)`);
  await wait(100);

  // 1) cycleLoopMode 四态顺序: off → list → file → random → off
  const cyc = await win.webContents.executeJavaScript(`(() => {
    const seq = [];
    seq.push(window.__lumen.loopMode());
    window.__lumen.cycleLoopMode(); seq.push(window.__lumen.loopMode());
    window.__lumen.cycleLoopMode(); seq.push(window.__lumen.loopMode());
    window.__lumen.cycleLoopMode(); seq.push(window.__lumen.loopMode());
    window.__lumen.cycleLoopMode(); seq.push(window.__lumen.loopMode());
    return seq;
  })()`);

  // 2) random 模式: 列表仅 2 项时，每次 playlistJump 必跳到与当前不同的位置
  const rnd = await win.webContents.executeJavaScript(`(() => {
    window.__lumen.__setLoopMode('random');
    window.__lumen.__setPlaylist(${JSON.stringify(files)}, 0);
    let ok = true;
    for (let i = 0; i < 20; i++) {
      const before = window.__lumen.__getPlaylistIndex();
      window.__lumen.__playlistJump(1);
      const after = window.__lumen.__getPlaylistIndex();
      if (before === after || after < 0 || after >= 2) { ok = false; break; }
    }
    return { ok };
  })()`);

  // 3) 复位，避免污染其他状态
  await win.webContents.executeJavaScript(`window.__lumen.__setLoopMode('off')`);

  const checks = {
    cycleOrder: JSON.stringify(cyc) === JSON.stringify(['off', 'list', 'file', 'random', 'off']),
    randomAlwaysMoves: rnd.ok === true,
  };
  const passed = Object.values(checks).every(Boolean);
  console.log('[loopmode-test]', JSON.stringify({ cyc, rnd, checks }));
  console.log(`[loopmode-test] 结果: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('=== 循环模式测试结束 ===\n');

  const code = passed ? 0 : 1;
  teardown();
  const bail = setTimeout(() => process.exit(code), 3000);
  bail.unref();
  app.exit(code);
}
