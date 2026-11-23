/**
 * 管理界面
 * ------------------------------------------------------------------
 * 纯原生实现，无构建步骤：
 *   - 配置（WebDAV / 取流 / 时区 / TMDB）
 *   - 媒体库（勾选参与编排的节目，封面/简介来自 TMDB）
 *   - 编排（频道 + 规则段编辑，含模板）
 *   - 预览（用未保存的草稿实时试算节目单）
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  state: null,
  draft: null,
  tab: 'overview',
  dirty: { config: false, series: false, channels: false },
  posters: new Map(),
  selected: new Set(),
  allSeries: [],
  filters: { yearFrom: '', yearTo: '', minVote: '0', genre: '', matched: '' },
  tmdbSyncTimer: null,
  allIds: [],
  activeChannel: null,
  preview: null,
  scanTimer: null,
  posterQueue: new Set(),
  posterTimer: null,
};



/* ------------------------------ 基础工具 ------------------------------ */

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

const fmtDur = (ms) => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
};

const fmtDay = (ms, tz) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return '';
  }
};

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    cache: 'no-store',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(msg, type = 'ok') {
  const box = $('#toast');
  box.textContent = msg;
  box.className = `toast ${type}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, type === 'err' ? 6000 : 3000);
}

const setStatusPill = (state) => {
  const pill = $('#statusPill');
  const lib = state.library;
  if (!state.configured) {
    pill.textContent = '未配置 WebDAV';
    pill.className = 'pill warn';
  } else if (!lib.loaded) {
    pill.textContent = '未扫描媒体库';
    pill.className = 'pill warn';
  } else if (state.scan.running) {
    pill.textContent = '扫描中…';
    pill.className = 'pill warn';
  } else {
    pill.textContent = `就绪 · ${lib.series} 部 / ${lib.episodes} 集`;
    pill.className = 'pill ok';
  }
};

/* ------------------------------ 状态加载 ------------------------------ */

function buildDraft(state) {
  const cfg = state.config;
  const st = state.settings || {};
  const channels = st.channels?.length
    ? clone(st.channels)
    : (state.channels || []).map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        dayStart: c.dayStart || '00:00',
        anchor: c.anchor,
        slots: clone(c.slots),
      }));
  return {
    webdav: {
      baseUrl: st.webdav?.baseUrl ?? cfg.webdav.baseUrl,
      root: st.webdav?.root ?? cfg.webdav.root,
      username: st.webdav?.username ?? cfg.webdav.username,
      password: '',
      timeoutMs: st.webdav?.timeoutMs ?? cfg.webdav.timeoutMs,
    },
    stream: {
      mode: st.stream?.mode ?? cfg.stream.mode,
      urlPrefix: st.stream?.urlPrefix ?? cfg.stream.urlPrefix ?? '',
      token: '',
      embedCredentials: st.stream?.embedCredentials ?? cfg.stream.embedCredentials,
    },
    timezone: st.timezone ?? cfg.timezone,
    tmdb: { apiKey: '', readToken: '', language: st.tmdb?.language ?? cfg.tmdb.language },
    subtitles: { enabled: st.subtitles?.enabled ?? cfg.subtitles?.enabled !== false },
    prefetch: {
      enabled: st.prefetch?.enabled ?? cfg.prefetch?.enabled !== false,
      ahead: st.prefetch?.ahead ?? cfg.prefetch?.ahead ?? 1,
      intervalMs: st.prefetch?.intervalMs ?? cfg.prefetch?.intervalMs ?? 20000,
    },
    remuxLimits: {
      maxFiles: st.remux?.maxFiles ?? cfg.remux?.maxFiles ?? 0,
      maxBytes: st.remux?.maxBytes ?? cfg.remux?.maxBytes ?? 0,
    },
    compat: {
      publish: st.compat?.publish ?? cfg.compat?.publish ?? 'local',
      keepLocal: st.compat?.keepLocal ?? cfg.compat?.keepLocal ?? true,
      urlPrefix: st.compat?.urlPrefix ?? cfg.compat?.urlPrefix ?? '',
      webdav: {
        baseUrl: st.compat?.webdav?.baseUrl ?? cfg.compat?.webdav?.baseUrl ?? '',
        root: st.compat?.webdav?.root ?? cfg.compat?.webdav?.root ?? 'compat',
        username: st.compat?.webdav?.username ?? cfg.compat?.webdav?.username ?? '',
        password: '',
      },
    },
    channels,
    selection: normalizeSelection(st.selection ?? state.selection),
  };
}

const normalizeSelection = (sel) => ({
  mode: sel?.mode === 'include' ? 'include' : 'all',
  series: Array.isArray(sel?.series) ? [...sel.series] : [],
});

async function loadState({ keepDraft = false } = {}) {
  const state = await api('/api/admin/state');
  S.state = state;
  if (!keepDraft) S.draft = buildDraft(state);
  S.activeChannel = S.draft.channels.some((c) => c.id === S.activeChannel)
    ? S.activeChannel
    : S.draft.channels[0]?.id || null;
  setStatusPill(state);
  return state;
}

/* ------------------------------ 概览 ------------------------------ */

function renderOverview() {
  const st = S.state;
  const lib = st.library;
  const tmdb = st.tmdb;
  const cards = [
    { k: '媒体库', v: `${lib.series} 部`, s: `${lib.episodes} 集 · ${fmtDur(lib.totalDurationMs)}` },
    { k: '频道', v: `${S.draft.channels.length} 个`, s: S.draft.channels.map((c) => c.name).join(' / ') || '—' },
    {
      k: '参与编排',
      v: S.draft.selection.mode === 'include' ? `已选 ${S.draft.selection.series.length} 部` : '全部节目',
      s: S.draft.selection.mode === 'include' ? '在「媒体库」里调整' : '取消勾选即可只播指定的节目',
    },
    {
      k: 'TMDB',
      v: tmdb.enabled ? '已启用' : '未配置',
      s: tmdb.enabled ? `语言 ${st.config.tmdb.language} · ${tmdb.mode}` : '填 API Key 后显示封面与简介',
    },
  ];
  const box = $('#overviewCards');
  box.innerHTML = '';
  for (const c of cards) {
    box.append(
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'k' }, c.k),
        el('div', { class: 'v' }, c.v),
        el('div', { class: 's' }, c.s || ''),
      ),
    );
  }
  renderNowPlaying();
  renderScan();
  renderTmdbIndex();
}

function renderTmdbIndex() {
  const idx = S.state.config.tmdb?.index || { total: 0, matched: 0 };
  const sync = S.state.config.tmdb?.sync || {};
  const pill = $('#tmdbIndexPill');
  if (pill) {
    pill.textContent = `已匹配 ${idx.matched || 0} / ${idx.total || 0}`;
    pill.className = 'pill' + (idx.matched > 0 ? ' ok' : '');
  }
  const bar = $('#tmdbBar');
  const hint = $('#tmdbSyncHint');
  const btn = $('#btnTmdbSync');
  if (!bar) return;
  if (sync.running) {
    const pct = sync.total ? Math.round((sync.done / sync.total) * 100) : 0;
    bar.style.width = pct + '%';
    bar.style.background = '';
    const elapsed = sync.startedAt ? (Date.now() - sync.startedAt) / 1000 : 0;
    const per = sync.done > 0 ? elapsed / sync.done : 0;
    const eta = per > 0 && sync.total > sync.done ? Math.round(((sync.total - sync.done) * per) / 10) * 10 : 0;
    if (hint) {
      hint.textContent = `同步中 ${sync.done}/${sync.total}（${pct}%）· ${sync.current || ''}${sync.failed ? ` · 失败 ${sync.failed}` : ''}${eta ? ` · 预计还需 ${eta >= 60 ? Math.round(eta / 60) + ' 分钟' : eta + ' 秒'}` : ''}`;
    }
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  } else {
    bar.style.width = idx.matched > 0 ? '100%' : '0';
    if (btn) { btn.disabled = false; btn.textContent = '同步 TMDB 信息'; }
    if (hint) {
      hint.textContent = !S.state.config.tmdb?.enabled
        ? '还没有配置 TMDB API Key：去「配置」里填一个，才能拉取年份/评分/类型。'
        : sync.error
          ? `上次同步失败：${sync.error}`
          : sync.finishedAt
            ? `上次同步完成：${new Date(sync.finishedAt).toLocaleString()}，已匹配 ${idx.matched} 部`
            : '同步后可按年份 / 评分 / 类型筛选节目，也能在编排里按 TMDB 条件选片。';
    }
  }
}

async function renderNowPlaying() {
  const box = $('#nowPlaying');
  if (!S.state.ready) {
    box.innerHTML = '';
    const reason = S.draft.channels.length === 0
      ? '还没有频道：先去「编排」新建一个，再回来这里看直播状态。'
      : !S.state.configured
        ? '还没配置 WebDAV：先在「配置」里填好地址，再点「开始扫描」。'
        : '媒体库还没索引：先在「概览」里点「开始扫描」。';
    box.append(el('span', {}, reason));
    return;
  }
  try {
    const data = await api(`/api/now?channel=${encodeURIComponent(S.draft.channels[0]?.id || 'main')}`);
    if (data.off || !data.now) {
      // 留空时段：显示下一档
      box.innerHTML = '';
      const next = (data.next || [])[0];
      box.append(
        el('span', { class: 'np-main' },
          el('div', { class: 'np-title' }, '留空时段（没有节目在播）'),
          el('div', { class: 'np-sub' }, next ? `下一档 ${next.startText} · ${next.series}` : '暂无后续节目'),
        ),
      );
      return;
    }
    const n = data.now;
    const poster = S.posters.get(n.seriesId)?.poster;
    box.innerHTML = '';
    if (poster) box.append(el('img', { class: 'np-poster', src: poster, alt: n.series }));
    box.append(
      el(
        'div',
        { class: 'np-main' },
        el('div', { class: 'np-title' }, `${n.series} · S${String(n.season).padStart(2, '0')}E${String(n.episode).padStart(2, '0')}`),
        el('div', { class: 'np-sub' }, n.title || n.name),
        el('div', { class: 'np-sub' }, `${n.startText} — ${n.endText} · 已播 ${Math.round(n.offsetMs / 1000)}s / 进度 ${(n.progress * 100).toFixed(1)}%`),
      ),
    );
  } catch (err) {
    box.textContent = `读取当前节目失败：${err.message}`;
  }
}

function renderScan() {
  const scan = S.state.scan;
  const bar = $('#scanBar');
  const status = $('#scanStatus');
  const btn = $('#btnScan');
  if (scan.running) {
    const total = scan.total || 0;
    const done = scan.done || 0;
    const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 3;
    bar.style.width = `${pct}%`;
    status.textContent = `扫描中：${scan.stage || ''} ${total ? `${done}/${total}（${pct}%）` : ''} ${scan.extra || ''}`;
    btn.disabled = true;
    btn.textContent = '扫描中…';
  } else {
    btn.disabled = false;
    btn.textContent = '开始扫描';
    if (scan.error) {
      bar.style.width = '100%';
      bar.style.background = 'var(--danger)';
      status.textContent = `扫描失败：${scan.error}`;
    } else if (scan.finishedAt) {
      bar.style.width = '100%';
      bar.style.background = 'linear-gradient(90deg, var(--accent), var(--accent-2))';
      status.textContent = `上次扫描：${new Date(scan.finishedAt).toLocaleString()} · ${scan.extra || ''}`;
    } else {
      bar.style.width = '0';
      status.textContent = S.state.library.loaded
        ? `已有索引：${S.state.library.series} 部 / ${S.state.library.episodes} 集（${new Date(S.state.library.scannedAt).toLocaleString()}）`
        : '尚未扫描';
    }
  }
}

async function startScan() {
  try {
    await api('/api/admin/scan', { method: 'POST', body: { probe: $('#scanProbe').checked } });
    toast('扫描已启动，进度会实时刷新');
    pollScan();
  } catch (err) {
    toast(`启动扫描失败：${err.message}`, 'err');
  }
}

function pollScan() {
  clearTimeout(S.scanTimer);
  S.scanTimer = setTimeout(async () => {
    try {
      const state = await api('/api/admin/state');
      S.state = state;
      setStatusPill(state);
      renderOverview();
      if (state.scan.running) pollScan();
      else if (!state.scan.error) {
        toast('扫描完成');
        await loadState();
        renderAll();
      }
    } catch {
      pollScan();
    }
  }, 2000);
}

/* ------------------------------ 配置 ------------------------------ */

function fillConfigForm() {
  const d = S.draft;
  $('#cfg-baseUrl').value = d.webdav.baseUrl || '';
  $('#cfg-root').value = d.webdav.root || '';
  $('#cfg-username').value = d.webdav.username || '';
  $('#cfg-password').value = '';
  $('#cfg-password').placeholder = S.state.config.webdav.passwordSet ? '已设置，留空则不修改' : '未设置';
  $('#cfg-timeout').value = d.webdav.timeoutMs || 20000;
  $('#cfg-mode').value = d.stream.mode || 'proxy';
  $('#cfg-prefix').value = d.stream.urlPrefix || '';
  $('#cfg-token').value = '';
  $('#cfg-token').placeholder = S.state.config.stream.tokenSet ? '已设置，留空则不修改' : '可选';
  $('#cfg-embed').checked = Boolean(d.stream.embedCredentials);
  $('#cfg-timezone').value = d.timezone || 'Asia/Shanghai';
  $('#cfg-tmdb-lang').value = d.tmdb.language || 'zh-CN';
  $('#cfg-subs').checked = S.draft.subtitles?.enabled !== false;
  const pf = S.draft.prefetch || {};
  $('#cfg-pf-enabled').checked = pf.enabled !== false;
  $('#cfg-pf-ahead').value = pf.ahead ?? 1;
  $('#cfg-pf-interval').value = Math.round((pf.intervalMs ?? 20000) / 1000);
  const rl = S.draft.remuxLimits || {};
  $('#cfg-remux-maxFiles').value = rl.maxFiles ?? 0;
  $('#cfg-remux-maxGB').value = Math.round((rl.maxBytes || 0) / 1024 ** 3);
  const compat = S.draft.compat || {};
  $('#cfg-compat-maxFiles').value = compat.maxFiles ?? 0;
  $('#cfg-compat-maxGB').value = Math.round((compat.maxBytes || 0) / 1024 ** 3);
  const prefetchHint = $('#prefetchHint');
  if (prefetchHint && S.state.config.prefetch) {
    const cfgPf = S.state.config.prefetch;
    const stats = cfgPf.stats;
    prefetchHint.textContent = stats
      ? `预封装运行中：每 ${Math.round(stats.intervalMs / 1000)} 秒检查一次，已排队 ${stats.queued} 集，跳过 ${stats.skipped} 次`
      : '服务端会按节目单提前把「正在播」和「下一集」转封装并上传，客户端打开即可播放。';
  }
  $('#cfg-compat-publish').value = compat.publish || 'local';
  $('#cfg-compat-root').value = S.state.settings?.compat?.webdav?.root || '';
  $('#cfg-compat-prefix').value = compat.urlPrefix || '';
  $('#cfg-compat-keeplocal').checked = compat.keepLocal !== false;
  $('#cfg-compat-baseUrl').value = compat.webdav?.baseUrl || '';
  $('#cfg-compat-username').value = compat.webdav?.username || '';
  $('#cfg-compat-password').value = '';
  $('#cfg-compat-password').placeholder = S.state.config.compat?.webdav?.passwordSet ? '已设置，留空则不修改' : '可选';
  const cHint = $('#compatHint');
  if (cHint && S.state.config.compat) {
    const c = S.state.config.compat;
    cHint.textContent = c.active
      ? `当前已启用：产物目录 ${c.store?.root || 'compat'}，302 前缀 ${c.store?.urlPrefix || '(未设置)'}；已发布 ${S.state.remux?.cache?.published ?? 0} 集`
      : '产物先落本地立即可播；选「上传到 WebDAV」后会在后台上传，完成后客户端 302 直连 CDN。';
  }
  const subsHint = $('#subsHint');
  if (subsHint && S.state.config.subtitles) {
    const ff = S.state.config.subtitles.ffmpeg;
    subsHint.innerHTML = ff
      ? '外挂 <code>.ass</code>/<code>.srt</code> 与 MKV 内挂字幕都会自动转成 WebVTT 加载（当前镜像已带 ffmpeg）。'
      : '外挂 <code>.ass</code>/<code>.srt</code> 会自动转成 WebVTT；MKV 内挂字幕需要换用带 ffmpeg 的镜像 <code>:latest-ffmpeg</code>。';
  }
  $('#cfg-tmdb-key').value = '';
  $('#cfg-tmdb-key').placeholder = S.state.config.tmdb.enabled ? '已设置，留空则不修改' : '未配置';
  $('#cfg-tmdb-token').value = '';
  updateSaveHints();
}

function bindConfigForm() {
  const read = () => {
    S.draft.webdav.baseUrl = $('#cfg-baseUrl').value.trim();
    S.draft.webdav.root = $('#cfg-root').value.trim();
    S.draft.webdav.username = $('#cfg-username').value.trim();
    S.draft.webdav.timeoutMs = Number($('#cfg-timeout').value) || 20000;
    S.draft.stream.mode = $('#cfg-mode').value;
    S.draft.stream.urlPrefix = $('#cfg-prefix').value.trim();
    S.draft.stream.embedCredentials = $('#cfg-embed').checked;
    S.draft.timezone = $('#cfg-timezone').value.trim() || 'Asia/Shanghai';
    S.draft.tmdb.language = $('#cfg-tmdb-lang').value;
    const pass = $('#cfg-password').value;
    if (pass) S.draft.webdav.password = pass;
    const token = $('#cfg-token').value;
    if (token) S.draft.stream.token = token;
    const key = $('#cfg-tmdb-key').value.trim();
    if (key) S.draft.tmdb.apiKey = key;
    const rt = $('#cfg-tmdb-token').value.trim();
    if (rt) S.draft.tmdb.readToken = rt;
    markDirty('config');
  };
  for (const id of ['cfg-baseUrl', 'cfg-root', 'cfg-username', 'cfg-password', 'cfg-timeout', 'cfg-mode', 'cfg-prefix', 'cfg-token', 'cfg-timezone', 'cfg-tmdb-lang', 'cfg-tmdb-key', 'cfg-tmdb-token']) {
    $(`#${id}`).addEventListener('input', read);
    $(`#${id}`).addEventListener('change', read);
  }
  $('#cfg-embed').addEventListener('change', read);
  $('#cfg-subs').addEventListener('change', (e) => {
    S.draft.subtitles = { enabled: e.target.checked };
    markDirty('config');
  });

  const readCompat = () => {
    S.draft.compat = {
      ...(S.draft.compat || {}),
      publish: $('#cfg-compat-publish').value,
      keepLocal: $('#cfg-compat-keeplocal').checked,
      urlPrefix: $('#cfg-compat-prefix').value.trim(),
      webdav: {
        ...(S.draft.compat?.webdav || {}),
        baseUrl: $('#cfg-compat-baseUrl').value.trim(),
        root: $('#cfg-compat-root').value.trim() || 'compat',
        username: $('#cfg-compat-username').value.trim(),
      },
    };
    const pass = $('#cfg-compat-password').value;
    if (pass) S.draft.compat.webdav.password = pass;
    markDirty('config');
  };
  for (const id of ['cfg-compat-publish', 'cfg-compat-root', 'cfg-compat-prefix', 'cfg-compat-baseUrl', 'cfg-compat-username', 'cfg-compat-password']) {
    $(`#${id}`).addEventListener('input', readCompat);
  }
  $('#cfg-compat-publish').addEventListener('change', readCompat);
  $('#cfg-compat-keeplocal').addEventListener('change', readCompat);

  const readPrefetch = () => {
    S.draft.prefetch = {
      enabled: $('#cfg-pf-enabled').checked,
      ahead: Math.max(0, Number($('#cfg-pf-ahead').value) || 0),
      intervalMs: Math.max(10000, (Number($('#cfg-pf-interval').value) || 20) * 1000),
    };
    S.draft.remuxLimits = {
      maxFiles: Math.max(0, Number($('#cfg-remux-maxFiles').value) || 0),
      maxBytes: Math.max(0, Number($('#cfg-remux-maxGB').value) || 0) * 1024 ** 3,
    };
    S.draft.compat = {
      ...(S.draft.compat || {}),
      maxFiles: Math.max(0, Number($('#cfg-compat-maxFiles').value) || 0),
      maxBytes: Math.max(0, Number($('#cfg-compat-maxGB').value) || 0) * 1024 ** 3,
    };
    markDirty('config');
  };
  for (const id of ['cfg-pf-ahead', 'cfg-pf-interval', 'cfg-remux-maxFiles', 'cfg-remux-maxGB', 'cfg-compat-maxFiles', 'cfg-compat-maxGB']) {
    $(`#${id}`).addEventListener('input', readPrefetch);
  }
  $('#cfg-pf-enabled').addEventListener('change', readPrefetch);

  $('#btnTmdbTest').addEventListener('click', async () => {
    const btn = $('#btnTmdbTest');
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const body = {};
      const key = $('#cfg-tmdb-key').value.trim();
      const rt = $('#cfg-tmdb-token').value.trim();
      if (key) body.apiKey = key;
      if (rt) body.readToken = rt;
      const r = await api('/api/admin/tmdb/test', { method: 'POST', body });
      $('#tmdbHint').textContent = r.ok ? '✓ TMDB 连接正常' : `✗ ${r.message}`;
      toast(r.ok ? 'TMDB 可用' : r.message, r.ok ? 'ok' : 'err');
    } catch (err) {
      toast(`测试失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试 TMDB';
    }
  });

  $('#btnScan').addEventListener('click', startScan);
}

/* ------------------------------ 媒体库 ------------------------------ */

async function loadFacets() {
  try {
    const f = await api('/api/admin/tmdb/facets');
    const sel = $('#flt-genre');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部类型</option>';
    for (const g of f.genres || []) {
      const opt = el('option', { value: g.name }, `${g.name} (${g.count})`);
      if (g.name === cur) opt.selected = true;
      sel.append(opt);
    }
  } catch {
    /* TMDB 未配置时忽略 */
  }
}

function buildSeriesQuery(q = '') {
  const f = S.filters || {};
  const p = new URLSearchParams({ limit: '500', q });
  if (f.yearFrom) p.set('yearFrom', f.yearFrom);
  if (f.yearTo) p.set('yearTo', f.yearTo);
  if (f.minVote && f.minVote !== '0') p.set('minVote', f.minVote);
  if (f.genre) p.set('genres', f.genre);
  if (f.matched) p.set('matched', f.matched);
  return p.toString();
}

async function loadSeries({ q = '' } = {}) {
  const data = await api(`/api/admin/series?${buildSeriesQuery(q)}`);
  S.allSeries = data.series;
  S.allIds = data.series.map((s) => s.id);
  const sel = normalizeSelection(S.draft.selection);
  S.selected = new Set(sel.mode === 'include' ? sel.series : data.series.map((s) => s.id));
  renderSeries();
  updateSelCount();
}

function renderSeries() {
  const grid = $('#seriesGrid');
  grid.innerHTML = '';
  if (S.allSeries.length === 0) {
    grid.append(el('div', { class: 'empty' }, '媒体库里还没有节目：先完成扫描。'));
    return;
  }
  for (const s of S.allSeries) {
    const selected = S.selected.has(s.id);
    const card = el(
      'div',
      {
        class: `series-card${selected ? ' selected' : ''}`,
        dataset: { id: s.id },
        onclick: () => toggleSeries(s.id),
        title: s.name,
      },
      el('div', { class: 'tick' }, '✓'),
      el('div', { class: 'poster-empty' }, '▶'),
      el(
        'div',
        { class: 'body' },
        el('div', { class: 'name' }, s.name),
        el(
          'div',
          { class: 'meta' },
          el('span', {}, `${s.episodes} 集`),
          el('span', {}, fmtDur(s.durationMs)),
        ),
        s.tmdb?.tmdbId
          ? el(
              'div',
              { class: 'meta' },
              el('span', {}, [s.tmdb.year, s.tmdb.vote ? `★${Number(s.tmdb.vote).toFixed(1)}` : null, (s.tmdb.genres || [])[0]].filter(Boolean).join(' · ')),
            )
          : null,
      ),
    );
    grid.append(card);
    const cached = S.posters.get(s.id);
    if (cached?.poster) applyPoster(card, cached);
  }
  observePosters();
}

function applyPoster(card, info) {
  if (!info?.poster) return;
  const img = card.querySelector('img.poster');
  if (img) return;
  const placeholder = card.querySelector('.poster-empty');
  const image = el('img', { class: 'poster', src: info.poster, alt: '', loading: 'lazy' });
  if (placeholder) placeholder.replaceWith(image);
  else card.prepend(image);
  if (info.source === 'auto') card.append(el('div', { class: 'badge auto' }, 'TMDB'));
  else if (info.source === 'tag' || info.source === 'manual') card.append(el('div', { class: 'badge' }, 'TMDB'));
}

function observePosters() {
  if (!S.posterObserver) {
    S.posterObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = e.target.dataset.id;
          if (id && !S.posters.has(id)) S.posterQueue.add(id);
          S.posterObserver.unobserve(e.target);
        }
        schedulePosterFetch();
      },
      { rootMargin: '200px' },
    );
  }
  for (const card of $$('.series-card')) S.posterObserver.observe(card);
}

function schedulePosterFetch() {
  clearTimeout(S.posterTimer);
  S.posterTimer = setTimeout(flushPosters, 200);
}

async function flushPosters() {
  const ids = [...S.posterQueue].slice(0, 24);
  if (ids.length === 0) return;
  for (const id of ids) S.posterQueue.delete(id);
  try {
    const data = await api(`/api/admin/posters?ids=${encodeURIComponent(ids.join(','))}`);
    for (const [id, info] of Object.entries(data.posters || {})) {
      S.posters.set(id, info);
      const card = $(`.series-card[data-id="${CSS.escape(id)}"]`);
      if (card) applyPoster(card, info);
    }
    if (!data.tmdb?.enabled) {
      const hint = $('#tmdbHint');
      if (hint && !hint.dataset.warned) {
        hint.textContent = '未配置 TMDB API Key：只显示本地信息，配置后自动补封面与简介。';
        hint.dataset.warned = '1';
      }
    }
  } catch (err) {
    console.warn('封面加载失败', err);
  }
  if (S.posterQueue.size > 0) schedulePosterFetch();
}

function toggleSeries(id) {
  if (S.draft.selection.mode === 'all') {
    // 从「全选」切换到「只选这些」：先全选再去掉一个
    S.draft.selection = { mode: 'include', series: [...S.allIds] };
  }
  const set = new Set(S.draft.selection.series);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  S.draft.selection = { mode: 'include', series: [...set] };
  S.selected = set;
  const card = $(`.series-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.toggle('selected', set.has(id));
  updateSelCount();
  markDirty('series');
}

function updateSelCount() {
  const total = S.allIds.length;
  const n = S.draft.selection.mode === 'include' ? S.draft.selection.series.length : total;
  $('#selCount').textContent = `参与编排：${n} / ${total} 部`;
}

/* ------------------------------ 编排 ------------------------------ */

function renderChannelList() {
  const box = $('#channelList');
  box.innerHTML = '';
  for (const ch of S.draft.channels) {
    const stats = S.state.channels.find((c) => c.id === ch.id)?.stats;
    const g = ch.grid || {};
    const sub = stats ? `${stats.dayEntries} 条/天 · 每天 ${g.perDay || '?'} 部` : '未生效';
    box.append(
      el(
        'button',
        {
          class: `channel-item${ch.id === S.activeChannel ? ' active' : ''}`,
          onclick: () => {
            S.activeChannel = ch.id;
            renderChannelList();
            renderChannelEditor();
          },
        },
        el('span', { class: 'cn' }, ch.name || ch.id),
        el('span', { class: 'cm' }, `时间网格 · ${sub}`),
      ),
    );
  }
}

/* ------------------------------ 编排（时间网格） ------------------------------ */

/** 新频道的默认网格 */
/* ------------------------------ 编排（时间网格 + 分时段） ------------------------------ */

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fieldLabel(text, control, hint) {
  return el('label', { class: 'field' }, text, control, hint ? el('span', { class: 'field-hint' }, hint) : null);
}

function newGrid(overrides = {}) {
  return {
    start: '20:00',
    slotMinutes: 30,
    perDay: 3,
    episodes: 2,
    cycleDays: 7,
    loopEpisodes: 'wrap',
    ...overrides,
  };
}

function newSlot(from = '18:00', to = '24:00', overrides = {}) {
  return {
    from,
    to,
    label: from + '-' + to,
    grid: newGrid(overrides),
    library: {},
  };
}

function fmtSlot(slot) {
  return slot.from + '-' + slot.to + (slot.label ? ' ' + slot.label : '');
}

function describeChannel(ch) {
  const slots = ch.slots || [];
  if (slots.length === 0) return '还没有时段：点「+ 添加时段」开始编排。';
  return slots
    .map((s) => {
      const g = s.grid || newGrid();
      const pool = Array.isArray(g.pool) ? g.pool.length : 0;
      const roster = g.cycleDays > 0 ? g.cycleDays + ' 天一轮（' + g.perDay * g.cycleDays + ' 个位置）' : '走完整池才回头';
      const queue = g.cycleDays > 0 && pool > g.perDay * g.cycleDays ? '，' + (pool - g.perDay * g.cycleDays) + ' 部排队' : '';
      return (
        '· ' + fmtSlot(s) + '：' + g.start + ' 起播 ' + g.perDay + ' 部 × ' + g.episodes + ' 集，' +
        roster + queue + '，' + g.slotMinutes + ' 分钟对齐' + (pool ? '，片池 ' + pool + ' 部' : '（按筛选条件取片）')
      );
    })
    .join('\n');
}

/** 时段卡片：网格参数 + 筛选条件 + 编排剧集列表 */
function renderSlotCard(ch, slot, si) {
  const g = slot.grid;
  const lib = (slot.library = slot.library || {});
  const tmdb = (lib.tmdb = lib.tmdb || {});
  const changed = () => {
    markDirty('channels');
    const box = $('#channelSummaryText');
    if (box) box.textContent = describeChannel(ch);
    const head = $('#poolCount' + si);
    if (head) head.textContent = (slot.grid.pool?.length || 0) + ' 部';
  };

  const timeInput = (key) =>
    el('input', {
      type: 'time',
      value: slot[key],
      onchange: (e) => {
        slot[key] = e.target.value || slot[key];
        changed();
      },
    });

  const num = (obj, key, min, max, fallback) =>
    el('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      value: obj[key] ?? fallback,
      oninput: (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) obj[key] = v;
        changed();
      },
    });

  const poolBox = el('div', { class: 'pool-box' }, el('div', { class: 'hint' }, '加载中…'));

  const card = el(
    'div',
    { class: 'slot-card' },
    el(
      'div',
      { class: 'slot-card-head' },
      timeInput('from'),
      el('span', { class: 'sep' }, '→'),
      timeInput('to'),
      el('input', { class: 'slot-label', value: slot.label || '', placeholder: '档位名', oninput: (e) => { slot.label = e.target.value; changed(); } }),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn ghost small danger', onclick: () => { ch.slots.splice(si, 1); markDirty('channels'); renderChannelEditor(); } }, '删除时段'),
    ),
    el(
      'div',
      { class: 'form-grid mt' },
      fieldLabel('网格开始时间', el('input', { type: 'time', value: g.start, onchange: (e) => { g.start = e.target.value || '20:00'; changed(); } }), '这个时段里第一集从这时开始'),
      fieldLabel('对齐网格（分钟）', el('select', { onchange: (e) => { g.slotMinutes = Number(e.target.value); changed(); } },
        [15, 30, 60].map((m) => el('option', { value: String(m), selected: Number(g.slotMinutes) === m }, m + ' 分钟'))), '节目按整点/半点开始'),
      fieldLabel('每天几部', num(g, 'perDay', 1, 48, 3)),
      fieldLabel('每部几集', num(g, 'episodes', 1, 48, 2)),
      fieldLabel('循环周期（天，0=不限）', num(g, 'cycleDays', 0, 31, 7), '0 = 走完整池才回头'),
      fieldLabel('集数用完后', el('select', { onchange: (e) => { g.loopEpisodes = e.target.value; changed(); } },
        el('option', { value: 'wrap', selected: g.loopEpisodes !== 'stop' }, '从头循环'),
        el('option', { value: 'stop', selected: g.loopEpisodes === 'stop' }, '不再播这一部'))),
    ),
    el(
      'div',
      { class: 'form-grid mt' },
      fieldLabel('筛选：年份 ≥', num(tmdb, 'yearFrom', 1950, 2100, '')),
      fieldLabel('筛选：年份 ≤', num(tmdb, 'yearTo', 1950, 2100, '')),
      fieldLabel('筛选：最低评分', num(tmdb, 'minVote', 0, 10, '')),
      fieldLabel('筛选：类型（逗号分隔）', el('input', { value: (tmdb.genres || []).join(','), placeholder: '动画,悬疑', oninput: (e) => { tmdb.genres = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); changed(); } })),
      fieldLabel('筛选：至少几集', num(lib, 'minEpisodes', 0, 999, '')),
    ),
    el('div', { class: 'slot-card-sub' }, '编排剧集 ', el('span', { id: 'poolCount' + si, class: 'pill tiny' }, (g.pool?.length || 0) + ' 部')),
    poolBox,
  );

  queueMicrotask(() => {
    fillPoolBox(ch, slot, si, poolBox);
  });
  return card;
}

/** 填充「编排剧集」列表（显式列表 or 筛选结果） */
async function fillPoolBox(ch, slot, si, box) {
  const g = slot.grid;
  box.innerHTML = '';
  const list = el('div', { class: 'pool-list' });
  const bar = el(
    'div',
    { class: 'row-gap' },
    el('button', {
      class: 'btn ghost small',
      onclick: async () => {
        const names = await resolvePoolNames(ch, si);
        if (!names) return;
        g.pool = names;
        markDirty('channels');
        fillPoolBox(ch, slot, si, box);
        toast('已按筛选条件生成 ' + names.length + ' 部');
      },
    }, '按筛选条件生成列表'),
    el('button', {
      class: 'btn ghost small',
      onclick: () => {
        const input = el('input', { placeholder: '搜索媒体库…', class: 'pool-search' });
        const results = el('div', { class: 'pool-search-results' });
        const panel = el('div', { class: 'pool-search-panel' }, input, results);
        box.append(panel);
        let timer = null;
        const run = async () => {
          const q = input.value.trim();
          results.innerHTML = '';
          try {
            const data = await api('/api/admin/series?limit=20&q=' + encodeURIComponent(q));
            for (const s of data.series) {
              if ((g.pool || []).includes(s.name)) continue;
              results.append(
                el('button', {
                  class: 'pool-add',
                  onclick: () => {
                    const base = g.pool ? g.pool.slice() : (slot.__resolved || []).slice();
                    if (!base.includes(s.name)) base.push(s.name);
                    g.pool = base;
                    markDirty('channels');
                    panel.remove();
                    fillPoolBox(ch, slot, si, box);
                  },
                }, '+ ' + s.name),
              );
            }
            if (results.children.length === 0) results.append(el('span', { class: 'hint' }, '没有匹配的剧集'));
          } catch (err) {
            results.append(el('span', { class: 'hint' }, '搜索失败：' + err.message));
          }
        };
        input.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(run, 250);
        });
        run();
      },
    }, '+ 添加剧集'),
  );

  let names = g.pool;
  let explicit = Boolean(names);
  if (!names) {
    const resolved = await resolvePoolNames(ch, si);
    names = resolved || [];
    slot.__resolved = names;
  }
  const head = $('#poolCount' + si);
  if (head) head.textContent = names.length + ' 部';

  if (names.length === 0) {
    list.append(el('div', { class: 'hint' }, '没有可选剧集：检查筛选条件，或直接「+ 添加剧集」。'));
  } else {
    for (const name of names) {
      list.append(
        el('div', { class: 'pool-item' },
          el('span', { class: 'pool-name' }, name),
          el('button', {
            class: 'pool-del',
            title: '从编排中移除',
            onclick: () => {
              const base = g.pool ? g.pool.slice() : names.slice();
              g.pool = base.filter((x) => x !== name);
              markDirty('channels');
              fillPoolBox(ch, slot, si, box);
            },
          }, '×'),
        ),
      );
    }
  }

  box.append(
    el('div', { class: 'hint' }, explicit ? '当前为固定列表（按此顺序轮换）' : '当前由筛选条件生成，点「按筛选条件生成列表」后可逐部增删'),
    bar,
    list,
  );
}

/** 用当前草稿解析某个时段的片池 */
async function resolvePoolNames(ch, si) {
  try {
    const data = await api('/api/admin/resolve-pool', {
      method: 'POST',
      body: { channels: clone(S.draft.channels), channelId: ch.id, slotIndex: si },
    });
    return (data.series || []).map((s) => s.name);
  } catch (err) {
    toast('解析片池失败：' + err.message, 'err');
    return null;
  }
}

function renderChannelEditor() {
  const box = $('#channelEditor');
  const ch = S.draft.channels.find((c) => c.id === S.activeChannel);
  if (!ch) {
    box.innerHTML = '';
    box.append(el('p', { class: 'hint' }, '还没有频道，点左侧「+ 新建」。'));
    return;
  }
  if (!Array.isArray(ch.slots) || ch.slots.length === 0) {
    ch.slots = [{ from: '18:00', to: '24:00', label: '黄金档', grid: newGrid(), library: {} }];
  }
  ch.slots.forEach((s) => {
    s.grid = s.grid || newGrid();
    s.library = s.library || {};
  });
  box.innerHTML = '';

  const head = el(
    'div',
    { class: 'editor-head' },
    el('input', {
      class: 'ch-title',
      value: ch.name || '',
      placeholder: '频道名称',
      oninput: (e) => {
        ch.name = e.target.value;
        renderChannelList();
        markDirty('channels');
      },
    }),
    el('span', { class: 'hint' }, ch.id),
    el('span', { class: 'grow' }),
    el('button', { class: 'btn ghost small', onclick: () => gotoPreview(ch.id) }, '预览节目单'),
    el('button', { class: 'btn ghost small danger', onclick: () => removeChannel(ch) }, '删除频道'),
  );

  const base = el(
    'div',
    { class: 'form-grid' },
    fieldLabel('描述', el('input', { value: ch.description || '', placeholder: '可选', oninput: (e) => { ch.description = e.target.value; markDirty('channels'); } })),
    fieldLabel('播出日切', el('input', { type: 'time', value: ch.dayStart || '00:00', onchange: (e) => { ch.dayStart = e.target.value || '00:00'; markDirty('channels'); } }), '节目单在这个时刻重排'),
    fieldLabel('锚点（轮换第 0 天）', el('input', { type: 'datetime-local', value: toLocalInput(ch.anchor), onchange: (e) => { ch.anchor = e.target.value ? new Date(e.target.value).toISOString() : ch.anchor; markDirty('channels'); } }), '决定从哪天开始算第一轮'),
  );

  box.append(
    head,
    el('div', { class: 'panel-inner' }, el('div', { class: 'seg-params-title' }, '基础'), base),
    el('div', { class: 'panel-inner' }, el('div', { class: 'seg-params-title' }, '时段'), ...ch.slots.map((slot, si) => renderSlotCard(ch, slot, si))),
    el('div', { class: 'row-gap mt' },
      el('button', {
        class: 'btn ghost small',
        onclick: () => {
          ch.slots.push(newSlot('20:00', '24:00'));
          markDirty('channels');
          renderChannelEditor();
        },
      }, '+ 添加时段')),
    el('div', { class: 'grid-summary', id: 'channelSummaryText' }, describeChannel(ch)),
    el('p', { class: 'hint' }, '同一时刻只播一个频道；「留空」时段播放器会显示待机。改完记得点右上角「保存设置」。'),
  );
}

function addChannel() {
  const id = prompt('频道 id（英文字母/数字/短横线）', 'ch' + (S.draft.channels.length + 1));
  if (!id) return;
  if (S.draft.channels.some((c) => c.id === id)) {
    toast('频道 id 已存在', 'err');
    return;
  }
  S.draft.channels.push({
    id,
    name: id,
    description: '',
    dayStart: '00:00',
    anchor: new Date().toISOString(),
    slots: [{ from: '18:00', to: '24:00', label: '黄金档', grid: newGrid(), library: {} }],
  });
  S.activeChannel = id;
  markDirty('channels');
  renderChannelList();
  renderChannelEditor();
}

function removeChannel(ch) {
  if (S.draft.channels.length <= 1) {
    toast('至少保留一个频道', 'err');
    return;
  }
  if (!confirm(`删除频道「${ch.name || ch.id}」？`)) return;
  S.draft.channels = S.draft.channels.filter((c) => c.id !== ch.id);
  S.activeChannel = S.draft.channels[0]?.id || null;
  markDirty('channels');
  renderChannelList();
  renderChannelEditor();
}

/* ------------------------------ 预览 ------------------------------ */

function gotoPreview(channelId) {
  switchTab('preview');
  if (channelId) $('#previewChannel').value = channelId;
  runPreview();
}

function fillPreviewChannels() {
  const sel = $('#previewChannel');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const ch of S.draft.channels) {
    sel.append(el('option', { value: ch.id, selected: ch.id === (cur || S.activeChannel) }, ch.name || ch.id));
  }
}

async function runPreview() {
  const body = $('#previewBody');
  body.innerHTML = '';
  if (S.draft.channels.length === 0) {
    body.append(el('div', { class: 'empty' }, '还没有频道，先去「编排」新建一个。'));
    return;
  }
  body.append(el('div', { class: 'empty' }, '计算中…'));
  try {
    const data = await api('/api/admin/preview', {
      method: 'POST',
      body: {
        channel: $('#previewChannel').value,
        hours: Number($('#previewRange').value),
        at: $('#previewStart')?.value ? new Date($('#previewStart').value).toISOString() : undefined,
        settings: { channels: S.draft.channels, selection: S.draft.selection, timezone: S.draft.timezone },
      },
    });
    S.preview = data;
    renderPreview(data);
  } catch (err) {
    body.innerHTML = '';
    body.append(el('div', { class: 'empty' }, `预览失败：${err.message}`));
  }
}

function renderPreview(data) {
  const meta = $('#previewMeta');
  meta.innerHTML = '';
  const st = data.stats;
  const statsText = `时间网格 · 每天 ${st.dayEntries} 条 · 片池 ${st.poolSeries} 部`;
  meta.append(
    el('span', { class: 'pill ok' }, `${data.channel.name} · ${statsText}`),
    el('span', { class: 'pill' }, `选片池 ${st.poolSeries} 部 / ${st.poolEpisodes} 集`),
    el('span', { class: 'pill' }, `当前：${data.now.startText} — ${data.now.endText}`),
  );

  const tz = data.timezone;
  const table = el(
    'table',
    { class: 'epg' },
    el('thead', {}, el('tr', {}, el('th', {}, '时间'), el('th', {}, '节目'), el('th', {}, '档位'), el('th', {}, '时长'))),
  );
  const tbody = el('tbody', {});
  const nowMs = Date.now();
  let lastDay = '';
  for (const item of data.items) {
    const dayKey = fmtDay(item.startsAt, tz);
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      tbody.append(el('tr', { class: 'day-sep' }, el('td', { colspan: '4' }, dayKey)));
    }
    if (item.kind === 'gap') {
      tbody.append(
        el('tr', { class: 'gap-row' },
          el('td', { class: 'time' }, `${fmtDay(item.startsAt, tz)} ${item.startText}`),
          el('td', {}, el('span', { class: 'gap-tag' }, '留空')),
          el('td', {}, ''),
          el('td', { class: 'time' }, `${Math.round(item.durationMs / 60000)} 分`),
        ),
      );
      continue;
    }
    const live = nowMs >= item.startsAt && nowMs < item.endsAt;
    tbody.append(
      el(
        'tr',
        { class: live ? 'live' : '' },
        el('td', { class: 'time' }, `${fmtDay(item.startsAt, tz)} ${item.startText}`),
        el(
          'td',
          {},
          el('div', { class: 'name' }, `${item.series} · S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`),
          el('div', { class: 'sub' }, item.title || item.name),
        ),
        el('td', {}, el('span', { class: 'seg-tag' }, item.segmentLabel || '—')),
        el('td', { class: 'time' }, `${Math.round(item.durationMs / 60000)} 分${item.truncated ? '（截断）' : ''}`),
      ),
    );
  }
  table.append(tbody);
  const body = $('#previewBody');
  body.innerHTML = '';
  body.append(table);
  if (data.items.length === 0) body.append(el('div', { class: 'empty' }, '这个时间窗口没有节目'));
}

/* ------------------------------ 保存 ------------------------------ */

function markDirty(area) {
  S.dirty[area] = true;
  updateSaveHints();
}

function updateSaveHints() {
  const map = [
    ['#saveState', 'config'],
    ['#seriesState', 'series'],
    ['#channelState', 'channels'],
  ];
  for (const [sel, area] of map) {
    const node = $(sel);
    if (!node) continue;
    node.textContent = S.dirty[area] ? '有未保存的修改' : '未修改';
    node.className = S.dirty[area] ? 'pill warn' : 'hint';
  }
  $('#btnSave').textContent = S.dirty.config ? '保存设置 *' : '保存设置';
  $('#btnSaveSeries').textContent = S.dirty.series ? '保存选片 *' : '保存选片';
  $('#btnSaveChannels').textContent = S.dirty.channels ? '保存编排 *' : '保存编排';
}

async function saveAll() {
  const payload = {
    webdav: {
      baseUrl: S.draft.webdav.baseUrl,
      root: S.draft.webdav.root,
      username: S.draft.webdav.username,
      timeoutMs: S.draft.webdav.timeoutMs,
    },
    stream: {
      mode: S.draft.stream.mode,
      urlPrefix: S.draft.stream.urlPrefix || '',
      embedCredentials: Boolean(S.draft.stream.embedCredentials),
    },
    timezone: S.draft.timezone,
    tmdb: { language: S.draft.tmdb.language },
    subtitles: { enabled: S.draft.subtitles?.enabled !== false },
    compat: S.draft.compat,
    prefetch: S.draft.prefetch,
    remux: { maxFiles: S.draft.remuxLimits?.maxFiles || 0, maxBytes: S.draft.remuxLimits?.maxBytes || 0 },
    channels: S.draft.channels,
    selection: S.draft.selection,
  };
  if (S.draft.webdav.password) payload.webdav.password = S.draft.webdav.password;
  if (S.draft.stream.token) payload.stream.token = S.draft.stream.token;
  if (S.draft.tmdb.apiKey) payload.tmdb.apiKey = S.draft.tmdb.apiKey;
  if (S.draft.tmdb.readToken) payload.tmdb.readToken = S.draft.tmdb.readToken;

  const buttons = [$('#btnSave'), $('#btnSaveSeries'), $('#btnSaveChannels')];
  for (const b of buttons) b.disabled = true;
  try {
    const resp = await api('/api/admin/settings', { method: 'PUT', body: payload });
    S.state = resp.state;
    S.dirty = { config: false, series: false, channels: false };
    $('#cfg-password').value = '';
    $('#cfg-token').value = '';
    $('#cfg-tmdb-key').value = '';
    $('#cfg-tmdb-token').value = '';
    await loadState();
    renderAll();
    setStatusPill(S.state);
    if (resp.needsScan) {
      toast('已保存。WebDAV 有变化，建议重新扫描媒体库。', 'ok');
    } else {
      toast('已保存');
    }
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  } finally {
    for (const b of buttons) b.disabled = false;
    updateSaveHints();
  }
}

/* ------------------------------ 模板 ------------------------------ */

const PRESETS = [
  {
    name: '黄金档 3 部',
    desc: '18:00-24:00，20:00 起播 3 部 × 2 集，7 天一轮',
    slot: { from: '18:00', to: '24:00', label: '黄金档', grid: { start: '20:00', slotMinutes: 30, perDay: 3, episodes: 2, cycleDays: 7 } },
  },
  {
    name: '全天双时段',
    desc: '白天 08:00 起 2 部，黄金档 20:00 起 3 部',
    slots: [
      { from: '06:00', to: '18:00', label: '白天', grid: { start: '08:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 7 } },
      { from: '18:00', to: '24:00', label: '黄金档', grid: { start: '20:00', slotMinutes: 30, perDay: 3, episodes: 2, cycleDays: 7 } },
    ],
  },
  {
    name: '不设周期',
    desc: '每天往后取 3 部，走完整池才回头',
    slot: { from: '18:00', to: '24:00', label: '黄金档', grid: { start: '20:00', slotMinutes: 30, perDay: 3, episodes: 2, cycleDays: 0 } },
  },
];

function openPresets() {
  const layer = el(
    'div',
    { class: 'toast', style: 'right:20px;left:20px;max-width:none;bottom:20px;padding:16px' },
    el('div', { style: 'font-weight:700;margin-bottom:8px' }, '选择编排模板'),
    el(
      'div',
      { class: 'preset-grid' },
      ...PRESETS.map((p) =>
        el(
          'button',
          {
            class: 'preset',
            onclick: () => {
              const ch = S.draft.channels.find((c) => c.id === S.activeChannel);
              if (!ch) return;
              if (p.slots) ch.slots = clone(p.slots);
              else if (p.slot) ch.slots = [clone(p.slot)];
              markDirty('channels');
              renderChannelList();
              renderChannelEditor();
              layer.remove();
              toast('已套用模板：' + p.name);
            },
          },
          el('div', { class: 'pt' }, p.name),
          el('div', { class: 'pd' }, p.desc),
        ),
      ),
    ),
    el('div', { class: 'row-gap mt' }, el('button', { class: 'btn ghost small', onclick: () => layer.remove() }, '取消')),
  );
  document.body.append(layer);
}

/* ------------------------------ 渲染调度 ------------------------------ */

function switchTab(tab, { updateHash = true } = {}) {
  S.tab = tab;
  if (updateHash && typeof location !== 'undefined') {
    try {
      history.replaceState(null, '', '#' + tab);
    } catch {
      /* 忽略 */
    }
  }
  for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const v of $$('.view')) v.classList.toggle('active', v.dataset.view === tab);
  if (tab === 'series') {
    loadFacets();
    loadSeries({ q: $('#seriesSearch').value });
  }
  if (tab === 'channels') {
    renderChannelList();
    renderChannelEditor();
  }
  if (tab === 'preview') {
    fillPreviewChannels();
    runPreview();
  }
  if (tab === 'overview') renderOverview();
}

function renderAll() {
  fillConfigForm();
  renderOverview();
  if (S.tab === 'series') loadSeries({ q: $('#seriesSearch').value });
  if (S.tab === 'channels') {
    renderChannelList();
    renderChannelEditor();
  }
  fillPreviewChannels();
  updateSaveHints();
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  try {
    await loadState();
  } catch (err) {
    document.body.innerHTML = `<div class="empty">加载失败：${err.message}</div>`;
    return;
  }
  bindConfigForm();
  for (const b of $$('.tab')) b.addEventListener('click', () => switchTab(b.dataset.tab));
  $('#btnSave').addEventListener('click', saveAll);
  $('#btnSaveSeries').addEventListener('click', saveAll);
  $('#btnSaveChannels').addEventListener('click', saveAll);
  $('#btnAddChannel').addEventListener('click', addChannel);
  $('#btnPreset').addEventListener('click', openPresets);
  $('#btnPreview').addEventListener('click', runPreview);
  $('#previewChannel').addEventListener('change', runPreview);
  $('#previewRange').addEventListener('change', runPreview);
  $('#selAll').addEventListener('click', () => {
    S.draft.selection = { mode: 'all', series: [] };
    S.selected = new Set(S.allIds);
    for (const card of $$('.series-card')) card.classList.add('selected');
    updateSelCount();
    markDirty('series');
  });
  $('#selNone').addEventListener('click', () => {
    S.draft.selection = { mode: 'include', series: [] };
    S.selected = new Set();
    for (const card of $$('.series-card')) card.classList.remove('selected');
    updateSelCount();
    markDirty('series');
  });
  $('#selFiltered').addEventListener('click', () => {
    const ids = new Set(S.draft.selection.mode === 'include' ? S.draft.selection.series : S.allIds);
    for (const s of S.allSeries) ids.add(s.id);
    S.draft.selection = { mode: 'include', series: [...ids] };
    S.selected = ids;
    for (const card of $$('.series-card')) card.classList.add('selected');
    updateSelCount();
    markDirty('series');
  });
  let searchTimer = null;
  const reloadSeries = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadSeries({ q: $('#seriesSearch').value.trim() }), 200);
  };
  $('#seriesSearch').addEventListener('input', reloadSeries);
  const readFilters = () => {
    S.filters = {
      yearFrom: $('#flt-yearFrom').value.trim(),
      yearTo: $('#flt-yearTo').value.trim(),
      minVote: $('#flt-minVote').value,
      genre: $('#flt-genre').value,
      matched: $('#flt-matched').value,
    };
    reloadSeries();
  };
  for (const id of ['flt-yearFrom', 'flt-yearTo', 'flt-minVote', 'flt-genre', 'flt-matched']) {
    $(`#${id}`).addEventListener('input', readFilters);
    $(`#${id}`).addEventListener('change', readFilters);
  }
  $('#flt-reset').addEventListener('click', () => {
    S.filters = { yearFrom: '', yearTo: '', minVote: '0', genre: '', matched: '' };
    $('#flt-yearFrom').value = '';
    $('#flt-yearTo').value = '';
    $('#flt-minVote').value = '0';
    $('#flt-genre').value = '';
    $('#flt-matched').value = '';
    reloadSeries();
  });
  renderAll();
  if (S.state.scan.running) pollScan();

  // 支持 #channels / #preview 之类的深链
  const hashTab = (typeof location !== 'undefined' ? location.hash : '').replace('#', '');
  if (hashTab && hashTab !== S.tab) switchTab(hashTab);
}

boot();
