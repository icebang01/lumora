#!/usr/bin/env node
/**
 * Lumora GUI 自动化测试「自动启动器」
 *
 * 一条命令完成:启动 Electron(隔离 userData + CDP 调试端口) → 轮询发现
 * Lumora 主页面目标 → 跑 tools/gui-test.js 的 13 项断言 → 关闭进程清理。
 * 无需手动先开播放器,可直接接进 CI(见 .github/workflows/ci.yml 的 gui job)。
 *
 * 用法:
 *   node tools/run-gui-test.js [媒体文件]
 * 环境变量:
 *   GUI_CDP_PORT   CDP 端口(默认 9222)
 *   GUI_DISCOVER_TIMEOUT 等待目标出现的毫秒数(默认 90000)
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { connect, runGuiTests } = require('./gui-test.js');

const APP_ROOT = path.join(__dirname, '..');
const electron = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = process.env.GUI_CDP_PORT || 9222;
const DISCOVER_TIMEOUT = Number(process.env.GUI_DISCOVER_TIMEOUT) || 90000;
const MEDIA = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(APP_ROOT, 'testmedia', 'sdr-1080p.mp4');

// 隔离 userData:避免与用户正开着的播放器争抢 Chromium 缓存目录锁
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumora-gui-'));
// 隔离 config-dir:源码运行时 config 是仓库 config/(共享),测试必须同时隔离,
// 否则续播恢复会加载用户真实历史文件干扰被测流程(与 ADR-0003 同源问题)
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumora-gui-cfg-'));
const args = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--force-renderer-accessibility',
  `--user-data-dir=${userData}`,
  `--config-dir=${configDir}`,
  APP_ROOT,
];

const env = { ...process.env };
// 清掉 ELECTRON_RUN_AS_NODE,否则 electron.exe 会以纯 Node 模式运行
delete env.ELECTRON_RUN_AS_NODE;
env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

let child = null;
let cleaned = false;

function cleanup(code) {
  if (cleaned) return;
  cleaned = true;
  try { if (child && !child.killed) child.kill('SIGTERM'); } catch { /* ignore */ }
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(code);
}

function discoverTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`);
        const targets = await res.json();
        const page = targets.find(
          (t) => t.type === 'page' && t.title === 'Lumora' && t.url.includes('index.html')
        );
        if (page) { resolve(page); return; }
      } catch { /* 端口还没起,稍后重试 */ }
      if (Date.now() > deadline) {
        reject(new Error(`等待 Lumora CDP 目标超时(${timeoutMs}ms) — 检查 Electron 是否正常启动/有显示器`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function main() {
  console.log('[gui-runner] 启动 Electron:', electron);
  console.log('[gui-runner] media:', MEDIA);

  child = spawn(electron, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (err) => {
    console.error('[gui-runner] spawn error:', err.message);
    cleanup(1);
  });
  // 进程异常退出(非我们主动 kill)→ 视为失败
  child.on('close', (code) => {
    if (!cleaned) {
      console.error(`[gui-runner] Electron 提前退出 code=${code}`);
      cleanup(1);
    }
  });

  let page;
  try {
    page = await discoverTarget(DISCOVER_TIMEOUT);
  } catch (e) {
    console.error('[gui-runner]', e.message);
    cleanup(1);
    return;
  }

  console.log('[gui-runner] 发现目标:', page.webSocketDebuggerUrl);
  try {
    await connect(page.webSocketDebuggerUrl);
    const summary = await runGuiTests(MEDIA);
    console.log(`\n[gui-runner] 结果: ${summary.passed}/${summary.total} 项通过`);
    cleanup(summary.passed === summary.total ? 0 : 1);
  } catch (e) {
    console.error('[gui-runner] 测试异常:', e.message);
    cleanup(1);
  }
}

main();
