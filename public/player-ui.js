/**
 * 自绘播放器控制条
 * ------------------------------------------------------------------
 * 不用浏览器原生 controls，自己画：
 *   播放/暂停、可拖进度、缓冲条、音量、静音、字幕开关、画中画、全屏
 *   支持键盘（空格 / ←→ / ↑↓ / M / F / C）与触摸/鼠标手势（双击左右 -/+10s）
 *   支持「回看」：拖动进度后进入回看状态，点「回到直播」回到时间轴位置
 */


/* ------------------------------ 图标 ------------------------------ */
const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  play: svg('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  volume: svg('<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  mute: svg('<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15 9.5l5 5M20 9.5l-5 5"/>'),
  cc: svg('<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M10.5 10.5a2 2 0 1 0 0 3"/><path d="M16 10.5a2 2 0 1 0 0 3"/>'),
  pip: svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12.5" y="11.5" width="7" height="6" rx="1.5" fill="currentColor" stroke="none"/>'),
  fullscreen: svg('<path d="M8.5 4H5a1 1 0 0 0-1 1v3.5"/><path d="M15.5 4H19a1 1 0 0 1 1 1v3.5"/><path d="M8.5 20H5a1 1 0 0 1-1-1v-3.5"/><path d="M15.5 20H19a1 1 0 0 0 1-1v-3.5"/>'),
  fullscreenExit: svg('<path d="M9.5 4v4.5H5"/><path d="M14.5 4v4.5H19"/><path d="M9.5 20v-4.5H5"/><path d="M14.5 20v-4.5H19"/>'),
};

const FMT = (s) => {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export function mountPlayerUI({ player, videoWrap, state, hooks = {} }) {
  const $ = (id) => document.getElementById(id);
  const ui = $('playerUi');
  if (!ui) return null;

  const el = {
    play: $('puPlay'),
    track: $('puTrack'),
    played: $('puPlayed'),
    buffer: $('puBuffer'),
    knob: $('puKnob'),
    live: $('puLiveMark'),
    time: $('puTime'),
    mute: $('puMute'),
    vol: $('puVol'),
    cc: $('puCC'),
    pip: $('puPip'),
    fs: $('puFs'),
    shift: $('puShift'),
    shiftText: $('puShiftText'),
    goLive: $('puGoLive'),
    center: $('puCenter'),
    spinner: $('puSpinner'),
  };

  if (typeof player.controls === 'boolean') player.controls = false;
  // 统一图标风格（线性 SVG）
  if (el.play) el.play.innerHTML = ICONS.play;
  if (el.mute) el.mute.innerHTML = ICONS.volume;
  if (el.cc) el.cc.innerHTML = ICONS.cc;
  if (el.pip) el.pip.innerHTML = ICONS.pip;
  if (el.fs) el.fs.innerHTML = ICONS.fullscreen;
  ui.classList.remove('hidden-ui');

  const persistUi = typeof location !== 'undefined' && new URLSearchParams(location.search).has('ui');
  let hideTimer = null;
  let lastVolume = 1;
  let dragging = false;

  const show = (autoHide = true) => {
    ui.classList.add('show');
    clearTimeout(hideTimer);
    if (autoHide && !persistUi) hideTimer = setTimeout(() => ui.classList.remove('show'), 2600);
  };
  const hide = () => {
    if (persistUi) return;
    clearTimeout(hideTimer);
    ui.classList.remove('show');
  };
  const flashCenter = (icon) => {
    if (!el.center) return;
    el.center.textContent = icon;
    el.center.classList.add('flash');
    setTimeout(() => el.center.classList.remove('flash'), 450);
  };

  /* ------------------------------ 播放/暂停 ------------------------------ */
  const togglePlay = async () => {
    if (player.paused) {
      state.userPaused = false;
      state.ignorePauseUntil = 0;
      try {
        await player.play();
      } catch (err) {
        hooks.onStatus?.('播放失败：' + (err.message || err.name));
      }
      flashCenter('▶');
    } else {
      player.pause();
      state.userPaused = true;
      flashCenter('⏸');
    }
    hooks.onUserPauseChange?.(player.paused);
    show();
  };
  el.play?.addEventListener('click', togglePlay);

  /* ------------------------------- 进度条 ------------------------------- */
  const seekTo = (ratio) => {
    const d = player.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const target = Math.max(0, Math.min(d - 0.3, ratio * d));
    player.currentTime = target;
    hooks.onSeek?.(target, true);
    show();
  };
  const ratioFromEvent = (e) => {
    const rect = el.track.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  };
  el.track?.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.track.setPointerCapture?.(e.pointerId);
    seekTo(ratioFromEvent(e));
  });
  el.track?.addEventListener('pointermove', (e) => {
    if (dragging) seekTo(ratioFromEvent(e));
  });
  el.track?.addEventListener('pointerup', () => {
    dragging = false;
  });
  el.track?.addEventListener('pointercancel', () => {
    dragging = false;
  });

  /* ------------------------------- 音量 -------------------------------- */
  const syncVolume = () => {
    if (el.mute) el.mute.innerHTML = player.muted || player.volume === 0 ? ICONS.mute : ICONS.volume;
    if (el.vol) el.vol.value = String(player.muted ? 0 : player.volume);
  };
  /**
   * 有些浏览器（尤其 iOS/Safari）对「静音自动播放」的视频解除静音会立刻暂停，
   * 这里解除静音后补一次 play()，并把这次暂停标记为「非用户暂停」。
   */
  const resumeAfterUnmute = () => {
    state.ignorePauseUntil = Date.now() + 600;
    if (player.paused && state.started) {
      player.play().catch(() => {});
    }
  };
  el.mute?.addEventListener('click', () => {
    player.muted = !player.muted;
    if (!player.muted && player.volume === 0) player.volume = 1;
    if (!player.muted) resumeAfterUnmute();
    syncVolume();
    show();
  });
  el.vol?.addEventListener('input', () => {
    const v = Number(el.vol.value);
    player.volume = v;
    player.muted = v === 0;
    if (!player.muted) resumeAfterUnmute();
    syncVolume();
    show();
  });

  /* --------------------------- 字幕 / 画中画 / 全屏 --------------------------- */
  el.cc?.addEventListener('click', () => {
    hooks.onToggleCC?.();
    show();
  });
  el.pip?.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await player.requestPictureInPicture();
    } catch {
      /* 不支持就算了 */
    }
    show();
  });
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (videoWrap?.requestFullscreen) await videoWrap.requestFullscreen();
    } catch (err) {
      hooks.onStatus?.('全屏不可用：' + err.message);
    }
    show();
  };
  el.fs?.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    if (el.fs) el.fs.innerHTML = document.fullscreenElement ? ICONS.fullscreenExit : ICONS.fullscreen;
  });

  /* ------------------------------- 回看 -------------------------------- */
  el.goLive?.addEventListener('click', () => {
    hooks.onGoLive?.();
    show();
  });

  /* ---------------------------- 手势与快捷键 ---------------------------- */
  // 单击画面不再暂停（避免误触）；双击左/右两侧快退、快进 10 秒
  videoWrap?.addEventListener('dblclick', (e) => {
    if (e.target.closest('.player-ui') || e.target.closest('.cc-btn')) return;
    const rect = videoWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const delta = x < rect.width / 2 ? -10 : 10;
    const d = player.duration;
    if (!Number.isFinite(d)) return;
    player.currentTime = Math.max(0, Math.min(d - 0.3, player.currentTime + delta));
    hooks.onSeek?.(player.currentTime, true);
    flashCenter(delta > 0 ? '+10s' : '-10s');
    show();
  });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const d = player.duration;
    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (Number.isFinite(d)) {
          player.currentTime = Math.max(0, player.currentTime - 10);
          hooks.onSeek?.(player.currentTime, true);
        }
        show();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (Number.isFinite(d)) {
          player.currentTime = Math.min(d - 0.3, player.currentTime + 10);
          hooks.onSeek?.(player.currentTime, true);
        }
        show();
        break;
      case 'ArrowUp':
        e.preventDefault();
        player.muted = false;
        player.volume = Math.min(1, player.volume + 0.1);
        syncVolume();
        show();
        break;
      case 'ArrowDown':
        e.preventDefault();
        player.volume = Math.max(0, player.volume - 0.1);
        player.muted = player.volume === 0;
        syncVolume();
        show();
        break;
      case 'm':
        player.muted = !player.muted;
        syncVolume();
        show();
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'c':
        hooks.onToggleCC?.();
        show();
        break;
      default:
        break;
    }
  });

  /* ---------------------------- 自动隐藏 ---------------------------- */
  for (const evt of ['mousemove', 'pointerdown', 'touchstart', 'focusin']) {
    videoWrap?.addEventListener(evt, () => show(), { passive: true });
  }
  videoWrap?.addEventListener('mouseleave', () => hide());
  if (persistUi) ui.classList.add('show');
  player.addEventListener('pause', () => show(false));
  player.addEventListener('play', () => show());
  player.addEventListener('waiting', () => {
    if (el.spinner) el.spinner.hidden = false;
  });
  player.addEventListener('playing', () => {
    if (el.spinner) el.spinner.hidden = true;
  });
  player.addEventListener('canplay', () => {
    if (el.spinner) el.spinner.hidden = true;
  });
  player.addEventListener('volumechange', syncVolume);

  if ('pictureInPictureEnabled' in document && el.pip) {
    el.pip.hidden = !document.pictureInPictureEnabled;
  } else if (el.pip) {
    el.pip.hidden = true;
  }

  syncVolume();
  show();

  /* ---------------------------- 每帧更新 ---------------------------- */
  return {
    show,
    hide,
    /** @param {{liveOffset?:number, shifting?:boolean, shiftSeconds?:number, hasCC?:boolean, ccOn?:boolean}} info */
    update(info = {}) {
      const d = player.duration;
      const t = player.currentTime || 0;
      const ratio = Number.isFinite(d) && d > 0 ? t / d : 0;
      if (el.played) el.played.style.width = (ratio * 100).toFixed(2) + '%';
      if (el.knob) el.knob.style.left = (ratio * 100).toFixed(2) + '%';
      if (el.buffer && player.buffered && player.buffered.length) {
        const end = player.buffered.end(player.buffered.length - 1);
        el.buffer.style.width = (Number.isFinite(d) && d > 0 ? (end / d) * 100 : 0).toFixed(2) + '%';
      }
      if (el.time) el.time.textContent = `${FMT(t)} / ${FMT(d)}`;

      // 直播位置标记
      if (el.live) {
        const live = Number(info.liveOffset);
        if (Number.isFinite(live) && Number.isFinite(d) && d > 0 && live >= 0) {
          el.live.style.left = Math.min(100, (live / d) * 100) + '%';
          el.live.classList.add('show');
        } else {
          el.live.classList.remove('show');
        }
      }

      if (el.shift) {
        el.shift.hidden = !info.shifting;
        if (info.shifting && el.shiftText) {
          const s = Math.abs(info.shiftSeconds || 0);
          el.shiftText.textContent = `回看中 · 落后直播 ${FMT(s)}`;
        }
      }
      if (info.hasCC !== undefined && el.cc) {
        el.cc.hidden = !info.hasCC;
        el.cc.classList.toggle('on', Boolean(info.ccOn));
      }
      if (el.play) el.play.innerHTML = player.paused ? ICONS.play : ICONS.pause;
      if (el.spinner) el.spinner.hidden = player.readyState >= 2 || player.paused;
    },
    setSpinner(visible) {
      if (el.spinner) el.spinner.hidden = !visible;
    },
  };
}
