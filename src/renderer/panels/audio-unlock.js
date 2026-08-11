/**
 * 自动播放策略兜底浮层。
 *
 * 某些 Chromium 环境（尤其远程桌面 / 特定组策略）对 AudioContext 自动播放
 * 硬性卡死：任何命令行开关、webPreferences.autoplayPolicy、程序化
 * resume() 都绕不过，必须有一次真实用户手势。表现为"首曲拖入即播放、
 * 时间码照走、但完全无声"，手动拖进度条（真实 pointerdown 手势）反而出声。
 *
 * 兜底逻辑：AudioOutput 检测到 context 被策略卡在 suspended 且无声音时，
 * 广播 lumen:audio-blocked；本模块显示一个轻量"点击启用声音"浮层。
 * 用户点击（真实手势）→ input.js 的 bindAudioUnlock 已在 window 上监听
 * pointerdown/click/keydown，自动 resumeContext(true) 解锁 → context running →
 * 广播 lumen:audio-unblocked → 浮层隐藏。浮层仅在被卡时出现，正常播放或已
 * 解锁后永不显示，且不干扰 mpv 视频路径（视频不走 WebAudio，不会触发 blocked）。
 *
 * 设计：DOM 动态创建并挂到 body，不依赖 index.html 预声明；样式复用全局
 * 设计令牌（accent 渐变 + 毛玻璃），符合整体 UI 审美。无障碍：role=dialog、
 * 卡片可聚焦、支持 Enter/Space 解锁、aria-live 播报。
 */

let CTX = {};
export function setupAudioUnlock(ctx) { CTX = ctx || {}; }

// player 全转发代理（与 input.js 同款，确保拿到活跃引擎的 audio）
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});

let overlayEl = null;
let cardEl = null;
let visible = false;

function ensureDom() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.className = 'audio-unlock-overlay';
  overlayEl.setAttribute('role', 'dialog');
  overlayEl.setAttribute('aria-modal', 'false');
  overlayEl.setAttribute('aria-label', '点击启用声音');
  overlayEl.setAttribute('aria-live', 'polite');
  overlayEl.innerHTML = `
    <div class="audio-unlock-card" tabindex="0" role="button" aria-label="点击启用声音">
      <div class="audio-unlock-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5 6 9H3v6h3l5 4V5z"/>
          <path d="M15.5 8.5a5 5 0 0 1 0 7"/>
          <path d="M18.5 5.5a9 9 0 0 1 0 13"/>
          <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="1.6" opacity=".6"/>
        </svg>
      </div>
      <div class="audio-unlock-title">点击任意位置启用声音</div>
      <div class="audio-unlock-sub">浏览器自动播放策略需要先一次点击才能开启音频输出</div>
    </div>`;
  cardEl = overlayEl.querySelector('.audio-unlock-card');

  // 真实手势内调用：resumeContext 会把 context 从 suspended 拉到 running。
  // 点击穿透到 overlay（卡片 pointer-events:none）统一由 overlay 处理；
  // 键盘用户聚焦卡片后按 Enter/Space 同样触发。
  const unlock = () => {
    try {
      if (player && player.audio && typeof player.audio.resumeContext === 'function') {
        player.audio.resumeContext(true);
      }
    } catch { /* 非 ffmpeg 引擎（如 mpv 视频）无 resumeContext，忽略 */ }
    hideOverlay(); // 乐观隐藏；unblocked 事件到达后再 ensure 隐藏
  };
  overlayEl.addEventListener('click', unlock);
  cardEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); unlock(); }
  });

  document.body.appendChild(overlayEl);
}

function showOverlay() {
  if (visible) return;
  ensureDom();
  visible = true;
  // 下一帧加 .show，触发 transition（避免首帧无过渡）
  requestAnimationFrame(() => overlayEl && overlayEl.classList.add('show'));
  if (cardEl) { try { cardEl.focus({ preventScroll: true }); } catch { /* 某些环境 focus 抛错 */ } }
}

function hideOverlay() {
  if (!visible || !overlayEl) return;
  visible = false;
  overlayEl.classList.remove('show');
}

/** 绑定浮层：监听 AudioOutput 广播的 blocked / unblocked 事件。 */
export function bindAudioUnlockOverlay() {
  ensureDom();
  window.addEventListener('lumen:audio-blocked', () => { showOverlay(); });
  window.addEventListener('lumen:audio-unblocked', () => { hideOverlay(); });
  // 安全兜底：若音频本身不可用（如无声卡），也确保浮层不残留
  window.addEventListener('lumen:audio-unavailable', () => { hideOverlay(); });
}
