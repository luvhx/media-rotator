/**
 * 界面主题
 * ------------------------------------------------------------------
 * 模式：auto（跟随系统）/ light（白天）/ dark（夜间）
 * 主题色：任意 #RRGGBB，用于按钮、进度条、选中态
 *
 * 配置存在服务端（配置页），本地用 localStorage 缓存一份，
 * 这样首屏能立刻上色，不会先闪一下再变。
 */
(function () {
  const CACHE_KEY = 'rotator.ui';
  const DEFAULT = { mode: 'auto', accent: '#6b7688' };
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  let state = { ...DEFAULT };

  const readCache = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (raw && typeof raw === 'object') return { ...DEFAULT, ...raw };
    } catch {
      /* ignore */
    }
    return null;
  };

  const writeCache = (ui) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(ui));
    } catch {
      /* ignore */
    }
  };

  /** auto 模式下解析成实际主题 */
  const resolve = (mode) => {
    if (mode === 'light' || mode === 'dark') return mode;
    return media && media.matches ? 'dark' : 'light';
  };

  const apply = (ui, { persist = false } = {}) => {
    state = { ...DEFAULT, ...ui };
    const root = document.documentElement;
    root.dataset.theme = resolve(state.mode);
    root.dataset.themeMode = state.mode;
    root.style.setProperty('--accent-user', state.accent);
    if (persist) writeCache(state);
    window.dispatchEvent(new CustomEvent('themechange', { detail: { ...state } }));
  };

  /* 首屏：先用缓存（避免闪烁），随后拉服务端配置 */
  const cached = readCache();
  apply(cached || DEFAULT);

  const syncFromServer = async () => {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ui && (data.ui.mode !== state.mode || data.ui.accent !== state.accent)) {
        apply(data.ui, { persist: true });
      }
    } catch {
      /* 离线时用缓存 */
    }
  };

  /* 系统主题变化（仅在 auto 模式跟随） */
  if (media) {
    const onChange = () => {
      if (state.mode === 'auto') apply(state, { persist: false });
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  window.getUiTheme = () => ({ ...state });
  /** 立即应用（不写服务端），用于配置页预览 */
  window.previewUiTheme = (ui) => apply({ ...state, ...ui }, { persist: true });
  /** 保存到服务端配置 */
  window.saveUiTheme = async (ui) => {
    apply({ ...state, ...ui }, { persist: true });
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ui: window.getUiTheme() } }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `保存失败 HTTP ${res.status}`);
    }
    return res.json();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncFromServer);
  } else {
    syncFromServer();
  }
})();
