/**
 * 主题切换（播放器与管理界面共用）
 * 主题存在 localStorage，HTML 里提前引入本文件可避免刷新时闪白/闪紫。
 */
(function () {
  const KEY = 'rotator.theme';
  const DEFAULT = 'slate';
  const ALLOWED = ['slate', 'dark', 'light'];

  const read = () => {
    try {
      const t = localStorage.getItem(KEY);
      return ALLOWED.includes(t) ? t : DEFAULT;
    } catch {
      return DEFAULT;
    }
  };

  const apply = (theme) => {
    document.documentElement.dataset.theme = ALLOWED.includes(theme) ? theme : DEFAULT;
  };

  const current = read();
  apply(current);

  window.setTheme = (theme) => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* 忽略隐私模式写入失败 */
    }
    const sel = document.getElementById('themeSelect');
    if (sel && sel.value !== theme) sel.value = theme;
  };
  window.getTheme = () => document.documentElement.dataset.theme || DEFAULT;

  const bind = () => {
    const sel = document.getElementById('themeSelect');
    if (!sel) return;
    sel.value = window.getTheme();
    sel.addEventListener('change', () => window.setTheme(sel.value));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
