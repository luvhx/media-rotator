import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebDavClient } from './webdav.mjs';
import { Library, DurationCache, scanLibrary } from './library.mjs';
import { ChannelTimeline, episodeView } from './scheduler.mjs';
import { buildFileUrl, sendRedirect, proxyFile, sendFileWithRange } from './stream.mjs';
import { dayStartMs, localParts, fmtDuration, toMs, clamp, mapLimit } from './util.mjs';
import {
  applySettings,
  loadSettings,
  saveSettings,
  publicSettings,
  validateSettings,
  withSelection,
  normalizeSelection,
} from './settings.mjs';
import { settingsFromConfig, finalizeConfig } from './config.mjs';
import { TmdbClient } from './tmdb.mjs';
import { TmdbIndex } from './tmdb-index.mjs';
import { SubtitleService } from './subtitles.mjs';
import { RemuxService } from './remux.mjs';
import { CompatStore } from './compat-store.mjs';
import { PrefetchWorker } from './prefetch.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 构建应用
 * @param {object} baseConfig 已从文件 + 环境变量加载的配置（不含 UI 设置）
 */
export function createApp(baseConfig) {
  const state = {
    baseConfig,
    settingsFile: baseConfig.settings?.file || path.join(baseConfig.__root || '.', 'data', 'settings.json'),
    settings: {},
    config: null,
    dav: null,
    library: Library.empty(),
    timelines: new Map(),
    tmdb: null,
    tmdbIndex: null,
    tmdbSync: { running: false, done: 0, total: 0, failed: 0, error: null },
    tmdbResolved: new Map(),
    subs: null,
    remux: null,
    compat: null,
    prefetch: null,
    scan: { running: false, stage: null, done: 0, total: 0, extra: '', startedAt: null, finishedAt: null, error: null },
    error: null,
  };

  /* ------------------------- 运行时装配 ------------------------- */

  function rebuild({ reloadLibrary = true } = {}) {
    const settings = loadSettings(state.settingsFile);
    state.settings = settings;
    const merged = applySettings(state.baseConfig, settings);
    merged.channels = (merged.channels || []).map((ch) => withSelection(ch, merged.selection));
    const cfg = finalizeConfig(merged, state.baseConfig.__root, { allowIncomplete: true });
    cfg.settings.file = state.settingsFile;
    state.config = cfg;
    state.dav = new WebDavClient(cfg.webdav);
    state.tmdb = new TmdbClient({
      ...cfg.tmdb,
      cacheFile: path.join(path.dirname(cfg.paths.library), 'tmdb-cache.json'),
    });
    state.tmdbIndex = new TmdbIndex({
      file: path.join(path.dirname(cfg.paths.library), 'tmdb-index.json'),
      tmdb: state.tmdb,
    });
    state.tmdbResolved.clear();
    state.timelines.clear();
    state.subs = new SubtitleService({
      dav: state.dav,
      cacheDir: path.join(path.dirname(cfg.paths.library), 'subs'),
      ffmpegPath: cfg.subtitles?.ffmpegPath || 'ffmpeg',
      enabled: cfg.subtitles?.enabled !== false,
    });
    state.subs.detectFfmpeg();
    state.remux = new RemuxService({
      dav: state.dav,
      cacheDir: path.join(path.dirname(cfg.paths.library), 'remux'),
      ffmpegPath: cfg.subtitles?.ffmpegPath || 'ffmpeg',
      ffprobePath: cfg.remux?.ffprobePath || 'ffprobe',
      maxBytes: cfg.remux?.maxBytes ?? 20 * 1024 ** 3,
      maxFiles: cfg.remux?.maxFiles || 0,
      enabled: cfg.remux?.enabled !== false,
    });
    state.remux.detect();
    const compatCfg = cfg.compat || {};
    if (compatCfg.publish === 'webdav') {
      const compatDav = compatCfg.webdav?.baseUrl ? new WebDavClient(compatCfg.webdav) : state.dav;
      state.compat = new CompatStore({
        dav: compatDav,
        root: compatCfg.webdav?.root || 'compat',
        urlPrefix: compatCfg.urlPrefix || cfg.stream.urlPrefix || cfg.webdav.baseUrl,
        keepLocal: compatCfg.keepLocal !== false,
        maxFiles: compatCfg.maxFiles || 0,
        maxBytes: compatCfg.maxBytes || 0,
        indexFile: path.join(path.dirname(cfg.paths.library), 'compat-index.json'),
      });
    } else {
      state.compat = null;
    }
    if (state.remux) state.remux.setStore(state.compat);

    // 预封装：把每个频道的「当前 + 下一集」提前转好并上传
    state.prefetch?.stop();
    state.prefetch = null;
    const pf = cfg.prefetch || {};
    if (pf.enabled !== false && cfg.channels.length > 0) {
      const channelIds = Array.isArray(pf.channels) && pf.channels.length > 0 ? pf.channels : cfg.channels.map((c) => c.id);
      state.prefetch = new PrefetchWorker({
        channelIds: channelIds.filter((id) => cfg.channels.some((c) => c.id === id)),
        ahead: pf.ahead ?? 1,
        intervalMs: pf.intervalMs ?? 20000,
        needsWork: (ep) => state.remux.needsWork(ep),
        enqueue: (ep) => state.remux.start(ep),
        getNow: (channelId) => {
          const tl = getTimeline(channelId);
          const now = Date.now();
          const cur = tl.resolve(now);
          const upcoming = tl.schedule(now, now + 6 * 3600_000, 3).filter((i) => i.startsAt > now);
          return { current: { episode: cur.episode, startsAt: cur.startsAt }, upcoming: upcoming.map((i) => ({ episode: i.episode, startsAt: i.startsAt })) };
        },
        log: (msg) => {
          if (process.env.LOG_REQUESTS) console.log(`[prefetch] ${msg}`);
        },
      });
      state.prefetch.start();
    }
    if (reloadLibrary) {
      if (fs.existsSync(cfg.paths.library)) {
        try {
          state.library = Library.load(cfg.paths.library);
          state.error = null;
        } catch (err) {
          state.error = `索引加载失败：${err.message}`;
          state.library = Library.empty();
        }
      } else {
        state.library = Library.empty();
      }
    }
  }

  rebuild();

  const getConfig = () => state.config;
  const configured = () => Boolean(state.config.webdav.baseUrl);

  function defaultChannelId() {
    return state.config.channels[0]?.id || null;
  }

  function getTimeline(channelId) {
    if (!state.library.episodes.length) throw new HttpError(503, '媒体库还没有索引，请先在 /admin 里配置并扫描');
    const id = channelId || defaultChannelId();
    if (!id) throw new HttpError(503, '还没有配置频道，请先在 /admin 里编排');
    let tl = state.timelines.get(id);
    if (tl) return tl;
    const def = state.config.channels.find((c) => c.id === id);
    if (!def) throw new HttpError(404, `频道不存在：${id}`);
    tl = new ChannelTimeline({ channel: def, library: state.library, tz: state.config.timezone, tmdbIndex: state.tmdbIndex });
    state.timelines.set(id, tl);
    return tl;
  }

  function persistSettings(extra = {}) {
    state.settings = { ...state.settings, ...extra };
    saveSettings(state.settingsFile, state.settings);
  }

  /* ------------------------- 视图 ------------------------- */

  function directUrlOf(ep, prefixOverride) {
    const cfg = state.config;
    return buildFileUrl({
      prefix: prefixOverride || cfg.stream.urlPrefix || cfg.webdav.baseUrl,
      relPath: ep.relPath,
      root: cfg.webdav.root,
      token: cfg.stream.token,
      embedCredentials: cfg.stream.embedCredentials,
      dav: state.dav,
    });
  }

  function streamUrlOf(ep, opts = {}) {
    if (opts.preferDirect) return directUrlOf(ep, opts.prefix);
    return `/stream/${ep.fileId}`;
  }

  function clockText(ms) {
    const p = localParts(ms, state.config.timezone);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }

  function programView(item, opts = {}) {
    if (item.kind === 'gap' || !item.episode) {
      return {
        kind: 'gap',
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        durationMs: item.durationMs,
        durationText: fmtDuration(item.durationMs),
        startText: clockText(item.startsAt),
        endText: clockText(item.endsAt),
        segmentLabel: item.segmentLabel || '留空',
        episode: null,
      };
    }
    const ep = item.episode;
    const view = episodeView(ep);
    return {
      ...view,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      durationMs: item.durationMs,
      durationText: fmtDuration(item.durationMs),
      truncated: Boolean(item.truncated),
      segmentLabel: item.segmentLabel || null,
      startText: clockText(item.startsAt),
      endText: clockText(item.endsAt),
      streamUrl: streamUrlOf(ep, opts),
      directUrl: directUrlOf(ep, opts.prefix),
      mp4Url: `/stream/${ep.fileId}?format=mp4`,
      subtitleUrl: subtitleEnabled() && subtitleKindOf(ep) ? `/subtitle/${ep.fileId}` : null,
      subtitleJsonUrl: subtitleEnabled() && subtitleKindOf(ep) ? `/subtitle/${ep.fileId}?format=json` : null,
      subtitleKind: subtitleEnabled() ? subtitleKindOf(ep) : null,
    };
  }

  function subtitleEnabled() {
    return state.config.subtitles?.enabled !== false;
  }

  /** external = 同目录 .ass/.srt；embedded = MKV 内挂（需要 ffmpeg） */
  function subtitleKindOf(ep) {
    if (ep.subtitle) return 'external';
    if (state.subs?.ffmpegAvailable) return 'embedded';
    return null;
  }

  function channelSummary(def) {
    let stats = null;
    let error = null;
    try {
      stats = getTimeline(def.id).stats();
    } catch (err) {
      error = err.message;
    }
    let slots = [];
    try {
      const tl = getTimeline(def.id);
      slots = def.slots.map((slot, i) => {
        const pool = tl.poolOf(i);
        return {
          from: slot.from,
          to: slot.to,
          label: slot.label,
          grid: slot.grid,
          library: slot.library || {},
          explicit: Boolean(slot.grid.pool),
          poolCount: pool.length,
          poolNames: pool.map((s) => s.displayName),
        };
      });
    } catch {
      slots = (def.slots || []).map((slot) => ({
        from: slot.from,
        to: slot.to,
        label: slot.label,
        grid: slot.grid,
        library: slot.library || {},
        explicit: Boolean(slot.grid.pool),
        poolCount: 0,
        poolNames: [],
      }));
    }
    return {
      id: def.id,
      name: def.name,
      description: def.description || '',
      dayStart: def.dayStart || '00:00',
      anchor: new Date(def.anchorMs).toISOString(),
      slots,
      stats,
      error,
    };
  }

  /* ------------------------- 公共 API ------------------------- */

  function apiNow(url, res) {
    const cfg = state.config;
    if (!state.library.episodes.length) {
      return json(res, { error: '媒体库还没有索引', setup: true, hint: '打开 /admin 完成配置与扫描' }, 503);
    }
    if (!configured()) {
      return json(res, { error: '还没有配置 WebDAV', setup: true, hint: '打开 /admin 完成配置' }, 503);
    }
    const channelId = url.searchParams.get('channel') || defaultChannelId();
    if (!channelId) return json(res, { error: '还没有配置频道', setup: true, hint: '打开 /admin 新建一个频道' }, 503);
    const tl = getTimeline(channelId);
    const now = Date.now();
    const resolved = tl.resolve(now);
    const opts = { preferDirect: url.searchParams.get('mode') === 'direct', prefix: url.searchParams.get('prefix') || null };

    const upcoming = tl
      .schedule(now, now + 48 * 3600 * 1000, 60)
      .filter((i) => i.startsAt > now && i.episode)
      .map((i) => programView(i, opts));

    const channel = { id: tl.channel.id, name: tl.channel.name, description: tl.channel.description, mode: tl.channel.mode };
    if (resolved.off) {
      return json(res, {
        serverTime: now,
        timezone: cfg.timezone,
        channel,
        off: true,
        until: resolved.nextAt,
        now: null,
        next: upcoming.slice(0, 12),
        stream: { mode: cfg.stream.mode, urlPrefix: cfg.stream.urlPrefix },
      });
    }

    const current = programView(
      {
        episode: resolved.episode,
        startsAt: resolved.startsAt,
        endsAt: resolved.endsAt,
        durationMs: resolved.durationMs,
        truncated: resolved.truncated,
        segmentLabel: resolved.segmentLabel,
      },
      opts,
    );

    return json(res, {
      serverTime: now,
      timezone: cfg.timezone,
      channel,
      now: { ...current, offsetMs: resolved.offsetMs, remainingMs: resolved.remainingMs, progress: resolved.progress },
      next: upcoming.slice(0, 12),
      stream: { mode: cfg.stream.mode, urlPrefix: cfg.stream.urlPrefix },
    });
  }

  function apiSchedule(url, res) {
    const cfg = state.config;
    const channelId = url.searchParams.get('channel') || defaultChannelId();
    if (!channelId) throw new HttpError(503, '还没有配置频道');
    const tl = getTimeline(channelId);
    let from;
    let to;
    const date = url.searchParams.get('date');
    if (date) {
      const [y, m, d] = date.split('-').map(Number);
      if (!y || !m || !d) throw new HttpError(400, 'date 参数格式应为 YYYY-MM-DD');
      const dayIdx = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
      from = dayStartMs(dayIdx, cfg.timezone);
      to = from + 86400000;
    } else {
      from = url.searchParams.has('from') ? toMs(url.searchParams.get('from')) : Date.now();
      to = url.searchParams.has('to') ? toMs(url.searchParams.get('to')) : from + 6 * 3600 * 1000;
    }
    if (to <= from) throw new HttpError(400, 'to 必须晚于 from');
    if (to - from > 32 * 86400000) throw new HttpError(400, '时间窗口过大（最多 32 天）');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 40));
    const items = tl.schedule(from, to, limit);
    return json(res, {
      serverTime: Date.now(),
      timezone: cfg.timezone,
      channel: { id: tl.channel.id, name: tl.channel.name },
      from,
      to,
      count: items.length,
      items: items.map((i) => programView(i, { preferDirect: url.searchParams.get('mode') === 'direct' })),
    });
  }

  async function apiReportDuration(req, res) {
    const body = await readJson(req);
    const fileId = String(body.fileId || '');
    const durationMs = Number(body.durationMs);
    if (!fileId || !Number.isFinite(durationMs)) throw new HttpError(400, '需要 fileId 与 durationMs');
    if (durationMs < 30 * 1000 || durationMs > 12 * 3600 * 1000) throw new HttpError(400, 'durationMs 超出合理范围');
    const ep = state.library.getEpisode(fileId);
    if (!ep) throw new HttpError(404, `未知 fileId：${fileId}`);
    const suspicious = /estimate|series-median|unknown/.test(ep.durationSource || '');
    const ratio = ep.durationMs > 0 ? durationMs / ep.durationMs : 1;
    if (!suspicious && (ratio < 0.6 || ratio > 1.4)) {
      return json(res, { ok: false, ignored: true, reason: 'outlier', durationMs: ep.durationMs, reported: Math.round(durationMs) });
    }
    const diff = Math.abs(ep.durationMs - durationMs);
    ep.durationMs = Math.round(durationMs);
    ep.durationSource = 'client';
    const cache = new DurationCache(state.config.paths.durations);
    cache.set(ep.relPath, ep.size, { ms: ep.durationMs, source: 'client', container: ep.container });
    cache.save(true);
    if (diff > 3000) state.timelines.clear();
    return json(res, { ok: true, fileId, durationMs: ep.durationMs, corrected: diff > 1000, invalidated: diff > 3000 });
  }

  function apiLibrary(url, res) {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    const list = state.library.series
      .filter((s) => !q || s.displayName.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        name: s.displayName,
        tmdbId: s.tmdbId,
        episodes: s.episodes.length,
        seasons: [...new Set(s.episodes.map((e) => e.season))].sort((a, b) => a - b),
        durationMs: s.episodes.reduce((a, e) => a + e.durationMs, 0),
        size: s.episodes.reduce((a, e) => a + e.size, 0),
      }));
    return json(res, { total: state.library.series.length, matches: list.length, series: list });
  }

  function apiStream(req, res, url, fileId) {
    if (!configured()) throw new HttpError(503, '还没有配置 WebDAV');
    const cfg = state.config;
    const ep = state.library.getEpisode(fileId);
    if (!ep) throw new HttpError(404, `未知文件：${fileId}`);
    if (cfg.stream.mode === 'proxy') {
      return proxyFile(req, res, { dav: state.dav, relPath: ep.relPath, extraHeaders: cfg.stream.headers }).catch((err) => {
        if (!res.headersSent) json(res, { error: err.message }, 502);
        else res.destroy();
      });
    }
    const location = buildFileUrl({
      prefix: url.searchParams.get('prefix') || cfg.stream.urlPrefix || cfg.webdav.baseUrl,
      relPath: ep.relPath,
      root: cfg.webdav.root,
      token: cfg.stream.token,
      embedCredentials: cfg.stream.embedCredentials,
      dav: state.dav,
    });
    return sendRedirect(res, location);
  }

  /* ------------------------- 管理 API ------------------------- */

  function adminState() {
    const cfg = state.config;
    const lib = state.library;
    const totalMs = lib.episodes.reduce((a, e) => a + e.durationMs, 0);
    return {
      serverTime: Date.now(),
      ready: lib.episodes.length > 0 && configured() && state.config.channels.length > 0,
      configured: configured(),
      channels: state.config.channels.length,
      version: 1,
      config: {
        webdav: {
          baseUrl: cfg.webdav.baseUrl,
          root: cfg.webdav.root,
          username: cfg.webdav.username,
          passwordSet: Boolean(cfg.webdav.password),
          timeoutMs: cfg.webdav.timeoutMs,
        },
        stream: {
          mode: cfg.stream.mode,
          urlPrefix: cfg.stream.urlPrefix,
          tokenSet: Boolean(cfg.stream.token),
          embedCredentials: cfg.stream.embedCredentials,
        },
        timezone: cfg.timezone,
        tmdb: {
          language: cfg.tmdb.language,
          enabled: state.tmdb.enabled,
          mode: state.tmdb.mode,
          lastError: state.tmdb.lastError,
          index: state.tmdbIndex.stats(state.library.series.length),
          sync: state.tmdbSync,
        },
        subtitles: { enabled: cfg.subtitles?.enabled !== false, ffmpeg: Boolean(state.subs?.ffmpegAvailable) },
        remux: {
          enabled: cfg.remux?.enabled !== false,
          maxFiles: cfg.remux?.maxFiles || 0,
          maxBytes: cfg.remux?.maxBytes || 0,
          stats: state.remux?.stats() || null,
        },
        remux: { enabled: Boolean(state.remux?.ready), cache: state.remux?.stats() || null },
        prefetch: {
          enabled: cfg.prefetch?.enabled !== false,
          ahead: cfg.prefetch?.ahead ?? 1,
          intervalMs: cfg.prefetch?.intervalMs ?? 20000,
          stats: state.prefetch ? state.prefetch.stats() : null,
        },
        compat: {
          publish: cfg.compat?.publish || 'local',
          keepLocal: cfg.compat?.keepLocal !== false,
          maxFiles: cfg.compat?.maxFiles || 0,
          maxBytes: cfg.compat?.maxBytes || 0,
          urlPrefix: cfg.compat?.urlPrefix || '',
          webdav: {
            baseUrl: cfg.compat?.webdav?.baseUrl || '',
            root: cfg.compat?.webdav?.root || 'compat',
            username: cfg.compat?.webdav?.username || '',
            passwordSet: Boolean(cfg.compat?.webdav?.password),
            usingMain: !cfg.compat?.webdav?.baseUrl,
          },
          active: Boolean(state.compat),
          store: state.compat ? { root: state.compat.root, urlPrefix: state.compat.urlPrefix } : null,
        },
        paths: { library: cfg.paths.library, settings: state.settingsFile },
        library: { fallbackDurationMs: cfg.library.fallbackDurationMs },
      },
      settings: publicSettings(state.settings),
      defaults: publicSettings(settingsFromConfig(cfg)),
      channels: cfg.channels.map((ch) => channelSummary(ch)),
      selection: normalizeSelection(cfg.selection),
      library: {
        series: lib.series.length,
        episodes: lib.episodes.length,
        totalDurationMs: totalMs,
        totalSize: lib.episodes.reduce((a, e) => a + e.size, 0),
        scannedAt: lib.stats?.generatedAt || (fs.existsSync(cfg.paths.library) ? fs.statSync(cfg.paths.library).mtime.toISOString() : null),
        loaded: lib.episodes.length > 0,
        error: state.error,
      },
      scan: state.scan,
      tmdb: { enabled: state.tmdb.enabled, mode: state.tmdb.mode, lastError: state.tmdb.lastError },
    };
  }

  async function apiAdminSave(req, res) {
    const body = await readJson(req);
    const incoming = body.settings || body;
    try {
      validateSettings(incoming, { baseConfig: state.baseConfig, timezone: state.config.timezone });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (body.dryRun) return json(res, { ok: true, dryRun: true, valid: true });

    const cur = state.settings;
    const next = { ...cur, ...incoming };

    // 空密码 / 空 key 表示「保持不变」
    next.webdav = { ...(cur.webdav || {}), ...(incoming.webdav || {}) };
    if (!incoming.webdav?.password) {
      const keep = cur.webdav?.password || state.config.webdav.password;
      if (keep) next.webdav.password = keep;
      else delete next.webdav.password;
    }
    if (incoming.tmdb) {
      next.tmdb = { ...(cur.tmdb || {}), ...incoming.tmdb };
      if (!incoming.tmdb.apiKey) {
        if (cur.tmdb?.apiKey) next.tmdb.apiKey = cur.tmdb.apiKey;
        else delete next.tmdb.apiKey;
      }
      if (!incoming.tmdb.readToken) {
        if (cur.tmdb?.readToken) next.tmdb.readToken = cur.tmdb.readToken;
        else delete next.tmdb.readToken;
      }
    }
    if (incoming.stream && !incoming.stream.token) {
      const keep = cur.stream?.token;
      if (keep) next.stream = { ...(next.stream || {}), token: keep };
    }
    if (incoming.channels) next.channels = incoming.channels;
    if (incoming.subtitles) next.subtitles = { ...(cur.subtitles || {}), ...incoming.subtitles };
    if (incoming.remux) next.remux = { ...(cur.remux || {}), ...incoming.remux };
    if (incoming.prefetch) next.prefetch = { ...(cur.prefetch || {}), ...incoming.prefetch };
    if (incoming.compat) {
      next.compat = { ...(cur.compat || {}), ...incoming.compat };
      next.compat.webdav = { ...(cur.compat?.webdav || {}), ...(incoming.compat.webdav || {}) };
      if (!incoming.compat.webdav?.password) {
        const keep = cur.compat?.webdav?.password || state.config.compat?.webdav?.password;
        if (keep) next.compat.webdav.password = keep;
        else delete next.compat.webdav.password;
      }
    }

    const before = state.config.webdav;
    saveSettings(state.settingsFile, next);
    rebuild();
    const after = state.config.webdav;
    const endpointChanged =
      before.baseUrl !== after.baseUrl || before.root !== after.root || before.username !== after.username || before.password !== after.password;
    const needsScan = endpointChanged || !fs.existsSync(state.config.paths.library);

    return json(res, { ok: true, endpointChanged, needsScan, state: adminState() });
  }

  async function apiAdminScan(req, res) {
    const body = await readJson(req).catch(() => ({}));
    if (state.scan.running) throw new HttpError(409, '已有扫描任务在进行');
    if (!configured()) throw new HttpError(400, '请先在「配置」里填写 WebDAV 地址');
    runScan({ probe: body.probe !== false }).catch(() => {});
    return json(res, { ok: true, started: true, scan: state.scan });
  }

  async function runScan({ probe = true } = {}) {
    const cfg = state.config;
    Object.assign(state.scan, {
      running: true,
      stage: 'start',
      done: 0,
      total: 0,
      extra: '连接 WebDAV…',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    });
    try {
      const data = await scanLibrary({
        dav: state.dav,
        rootRel: cfg.webdav.root || '',
        durationsPath: cfg.paths.durations,
        concurrency: 8,
        probe,
        fallbackDurationMs: cfg.library.fallbackDurationMs,
        onProgress: (stage, done, total, extra) => {
          state.scan.stage = stage;
          state.scan.done = done;
          state.scan.total = total;
          state.scan.extra = extra || '';
        },
      });
      const tmp = `${cfg.paths.library}.tmp`;
      fs.mkdirSync(path.dirname(cfg.paths.library), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, cfg.paths.library);
      state.library = Library.load(cfg.paths.library);
      state.timelines.clear();
      state.scan.running = false;
      state.scan.finishedAt = Date.now();
      state.scan.stage = 'done';
      state.scan.extra = `完成：${data.stats.series} 部 / ${data.stats.episodes} 集`;
      persistSettings({
        lastScan: { at: new Date().toISOString(), series: data.stats.series, episodes: data.stats.episodes },
      });
      return data.stats;
    } catch (err) {
      state.scan.running = false;
      state.scan.finishedAt = Date.now();
      state.scan.error = err.message;
      throw err;
    }
  }

  function apiAdminResolvePool(body) {
    const draft = body && typeof body === 'object' ? body : {};
    const settingsDraft = { ...state.settings, ...(draft.settings || {}) };
    if (draft.channels) settingsDraft.channels = draft.channels;
    if (draft.selection) settingsDraft.selection = draft.selection;
    const merged = applySettings(state.baseConfig, settingsDraft);
    merged.channels = (merged.channels || []).map((ch) => withSelection(ch, merged.selection));
    const cfg = finalizeConfig(merged, state.baseConfig.__root, { allowIncomplete: true });
    const def = cfg.channels.find((c) => c.id === draft.channelId);
    if (!def) throw new HttpError(404, `频道不存在：${draft.channelId}`);
    const tl = new ChannelTimeline({ channel: def, library: state.library, tz: cfg.timezone, tmdbIndex: state.tmdbIndex });
    const idx = Math.max(0, Number(draft.slotIndex) || 0);
    const pool = tl.poolOf(idx);
    return {
      ok: true,
      slotIndex: idx,
      explicit: Boolean(def.slots[idx]?.grid?.pool),
      count: pool.length,
      series: pool.map((s) => ({ id: s.id, name: s.displayName, episodes: s.episodes.length })),
    };
  }

  function apiAdminPreview(body) {
    const draft = body && typeof body === 'object' ? body : {};
    const settingsDraft = { ...state.settings, ...(draft.settings || {}) };
    if (draft.channels) settingsDraft.channels = draft.channels;
    if (draft.selection) settingsDraft.selection = draft.selection;

    const merged = applySettings(state.baseConfig, settingsDraft);
    merged.channels = (merged.channels || []).map((ch) => withSelection(ch, merged.selection));
    let cfg;
    try {
      cfg = finalizeConfig(merged, state.baseConfig.__root, { allowIncomplete: true });
    } catch (err) {
      throw new HttpError(400, `编排无效：${err.message}`);
    }
    const channelId = draft.channel || cfg.channels[0]?.id;
    const def = cfg.channels.find((c) => c.id === channelId);
    if (!def) throw new HttpError(404, `频道不存在：${channelId}`);
    if (!state.library.episodes.length) throw new HttpError(503, '还没有扫描过媒体库');

    const hours = clamp(Number(draft.hours) || 12, 1, 336); // 最长 14 天
    const at = draft.at ? toMs(draft.at) : Date.now();
    let tl;
    try {
      tl = new ChannelTimeline({ channel: def, library: state.library, tz: cfg.timezone, tmdbIndex: state.tmdbIndex });
      const stats = tl.stats();
      const resolved = tl.resolve(at);
      const items = tl.schedule(at, at + hours * 3600_000, 3000);
      return {
        ok: true,
        channel: { id: def.id, name: def.name, mode: def.mode },
        timezone: cfg.timezone,
        at,
        hours,
        stats,
        now: resolved.off
          ? { off: true, nextAt: resolved.nextAt, startText: resolved.nextAt ? clockText(resolved.nextAt) : null }
          : {
              startsAt: resolved.startsAt,
              endsAt: resolved.endsAt,
              durationMs: resolved.durationMs,
              offsetMs: resolved.offsetMs,
              progress: resolved.progress,
              segmentLabel: resolved.segmentLabel,
              episode: episodeView(resolved.episode),
              startText: clockText(resolved.startsAt),
              endText: clockText(resolved.endsAt),
            },
        items: items.map((i) =>
          i.kind === 'gap' || !i.episode
            ? {
                kind: 'gap',
                startsAt: i.startsAt,
                endsAt: i.endsAt,
                durationMs: i.durationMs,
                durationText: fmtDuration(i.durationMs),
                segmentLabel: i.segmentLabel || '留空',
                startText: clockText(i.startsAt),
                endText: clockText(i.endsAt),
                episode: null,
              }
            : {
                ...episodeView(i.episode),
                startsAt: i.startsAt,
                endsAt: i.endsAt,
                durationMs: i.durationMs,
                truncated: Boolean(i.truncated),
                segmentLabel: i.segmentLabel || null,
                startText: clockText(i.startsAt),
                endText: clockText(i.endsAt),
              },
        ),
      };
    } catch (err) {
      throw new HttpError(400, `预览失败：${err.message}`);
    }
  }

  async function resolveTmdb(series) {
    if (!series) return null;
    const cacheKey = series.id;
    if (state.tmdbResolved.has(cacheKey)) return state.tmdbResolved.get(cacheKey);
    let out = { source: state.tmdb.enabled ? 'none' : 'disabled' };

    const override = state.settings.tmdbMatches?.[series.id];
    const knownId = override || series.tmdbId;
    if (knownId) {
      const details = await state.tmdb.tvDetails(knownId).catch(() => null);
      if (details) {
        out = { ...details, source: override ? 'manual' : 'tag', score: 1 };
      }
    }
    if (out.source === 'none' || out.source === 'disabled') {
      if (state.tmdb.enabled) {
        const match = await state.tmdb.matchSeries(series.displayName || series.name).catch((err) => ({ status: 'error', error: err.message }));
        if (match.status === 'matched') {
          out = { ...match.best, source: 'auto', score: match.best.score };
        } else if (match.status === 'low-confidence') {
          out = { ...match.best, source: 'low-confidence', score: match.best.score, candidates: match.candidates?.slice(0, 4) };
        } else if (match.status === 'error') {
          out = { source: 'error', error: match.error };
        }
      }
    }
    state.tmdbResolved.set(cacheKey, out);
    return out;
  }

  async function apiAdminPosters(url, res) {
    const ids = String(url.searchParams.get('ids') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 24);
    const posters = {};
    await mapLimit(ids, 3, async (id) => {
      const series = state.library.seriesById.get(id);
      if (!series) return;
      const info = await resolveTmdb(series);
      if (info?.id) {
        // 合并而不是覆盖：封面接口拿不到类型时不要冲掉同步得到的 genre
        const prev = state.tmdbIndex.get(series.id) || {};
        state.tmdbIndex.set(series.id, {
          ...prev,
          tmdbId: info.id,
          name: info.name || prev.name,
          year: info.year || prev.year,
          vote: info.vote || prev.vote,
          genres: info.genres?.length ? info.genres : prev.genres || [],
          status: info.status || prev.status,
          poster: info.poster || prev.poster,
          overview: info.overview || prev.overview,
          source: info.source || prev.source,
        });
        state.tmdbIndex.save();
      }
      posters[id] = info
        ? {
            tmdbId: info.id || null,
            poster: info.poster || null,
            name: info.name || null,
            originalName: info.originalName || null,
            year: info.year || null,
            vote: info.vote || 0,
            overview: info.overview || '',
            source: info.source,
            score: info.score ?? null,
          }
        : null;
    });
    if (state.tmdb.dirty) state.tmdb.save();
    return json(res, { posters, tmdb: { enabled: state.tmdb.enabled, mode: state.tmdb.mode } });
  }

  async function apiAdminSeriesList(url, res) {
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const sel = normalizeSelection(state.config.selection);
    const selected = new Set(sel.series);
    const all = state.library.series;
    let filtered = q ? all.filter((s) => s.displayName.toLowerCase().includes(q.toLowerCase())) : all;

    // TMDB 条件筛选
    const tmdbFilter = {
      yearFrom: Number(url.searchParams.get('yearFrom')) || 0,
      yearTo: Number(url.searchParams.get('yearTo')) || 0,
      minVote: Number(url.searchParams.get('minVote')) || 0,
      genres: (url.searchParams.get('genres') || '').split(',').map((x) => x.trim()).filter(Boolean),
      requireMatch: url.searchParams.get('matched') === '1',
    };
    if (url.searchParams.get('matched') === '0') {
      filtered = filtered.filter((s) => !state.tmdbIndex.get(s.id)?.tmdbId);
    } else {
      filtered = state.tmdbIndex.filterSeries(filtered, tmdbFilter);
    }

    const page = filtered.slice(offset, offset + limit).map((s) => {
      const t = state.tmdbIndex.get(s.id);
      return {
      id: s.id,
      name: s.displayName,
      tmdbId: s.tmdbId,
      episodes: s.episodes.length,
      seasons: [...new Set(s.episodes.map((e) => e.season))].sort((a, b) => a - b),
      durationMs: s.episodes.reduce((a, e) => a + e.durationMs, 0),
      size: s.episodes.reduce((a, e) => a + e.size, 0),
      selected: sel.mode === 'include' ? selected.has(s.id) : true,
        tmdb: t
          ? { tmdbId: t.tmdbId, year: t.year, vote: t.vote, genres: t.genres || [], poster: t.poster || null, source: t.source || null }
          : null,
      };
    });
    return json(res, {
      total: all.length,
      matches: filtered.length,
      offset,
      limit,
      selection: sel,
      selectedCount: sel.mode === 'include' ? sel.series.length : all.length,
      series: page,
    });
  }

  async function apiAdminSeriesDetail(url, res, seriesId) {
    const series = state.library.seriesById.get(decodeURIComponent(seriesId));
    if (!series) throw new HttpError(404, '系列不存在');
    const tmdb = await resolveTmdb(series);
    const seasons = [...new Set(series.episodes.map((e) => e.season))].sort((a, b) => a - b);
    let tmdbEpisodes = {};
    if (state.tmdb.enabled && tmdb?.id) {
      for (const season of seasons.slice(0, 4)) {
        try {
          const eps = await state.tmdb.seasonEpisodes(tmdb.id, season);
          for (const e of eps) tmdbEpisodes[`${season}-${e.episode}`] = e;
        } catch {
          /* 单季失败忽略 */
        }
      }
    }
    if (state.tmdb.dirty) state.tmdb.save();
    return json(res, {
      series: {
        id: series.id,
        name: series.displayName,
        tmdbId: series.tmdbId,
        episodes: series.episodes.length,
        seasons,
      },
      tmdb,
      tmdbEnabled: state.tmdb.enabled,
      episodes: series.__full.map((ep) => ({
        ...episodeView(ep),
        tmdb: tmdbEpisodes[`${ep.season}-${ep.episode}`] || null,
      })),
    });
  }

  async function apiAdminTmdbSync(req, res) {
    if (!state.tmdb.enabled) throw new HttpError(400, '还没有配置 TMDB API Key');
    const stale = state.tmdbSync.running && state.tmdbSync.startedAt && Date.now() - state.tmdbSync.startedAt > 15 * 60_000;
    if (stale) state.tmdbSync = { running: false, done: 0, total: 0, failed: 0, error: '上一次同步超时，已重置' };
    if (state.tmdbSync.running) throw new HttpError(409, 'TMDB 同步进行中');
    const body = await readJson(req).catch(() => ({}));
    const total = state.library.series.length;
    state.tmdbSync = { running: true, done: 0, total, failed: 0, current: null, startedAt: Date.now(), error: null, finishedAt: null };
    state.tmdbIndex
      .syncAll(state.library.series, {
        force: Boolean(body.force),
        concurrency: state.config.tmdb?.concurrency || 4,
        onProgress: (done, all, name, failed) => {
          Object.assign(state.tmdbSync, { done, total: all, current: name, failed });
        },
      })
      .then(() => {
        state.tmdbSync.running = false;
        state.tmdbSync.finishedAt = Date.now();
        state.timelines.clear();
      })
      .catch((err) => {
        state.tmdbSync.running = false;
        state.tmdbSync.error = err.message;
      });
    return json(res, { ok: true, started: true, total });
  }

  function apiAdminTmdbFacets(url, res) {
    return json(res, {
      ...state.tmdbIndex.facets(state.library.series),
      sync: state.tmdbSync,
      enabled: state.tmdb.enabled,
    });
  }

  async function apiAdminTmdbSearch(url, res) {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) throw new HttpError(400, '缺少查询词');
    if (!state.tmdb.enabled) throw new HttpError(400, '还没有配置 TMDB API Key');
    const results = await state.tmdb.searchTv(q);
    if (state.tmdb.dirty) state.tmdb.save();
    return json(res, { query: q, results });
  }

  async function apiAdminTmdbTest(req, res) {
    const body = await readJson(req).catch(() => ({}));
    const apiKey = body.apiKey || state.config.tmdb.apiKey;
    const readToken = body.readToken || state.config.tmdb.readToken;
    const client = new TmdbClient({ apiKey, readToken, language: state.config.tmdb.language });
    const result = await client.test();
    return json(res, result);
  }

  async function apiAdminSetMatch(req, res, seriesId) {
    const body = await readJson(req);
    const id = decodeURIComponent(seriesId);
    const series = state.library.seriesById.get(id);
    if (!series) throw new HttpError(404, '系列不存在');
    const matches = { ...(state.settings.tmdbMatches || {}) };
    const tmdbId = Number(body.tmdbId);
    if (!tmdbId) delete matches[id];
    else {
      const details = await state.tmdb.tvDetails(tmdbId);
      if (!details) throw new HttpError(400, 'TMDB 上找不到该 ID');
      matches[id] = tmdbId;
    }
    persistSettings({ tmdbMatches: matches });
    state.tmdbResolved.delete(id);
    return json(res, { ok: true, tmdbId: tmdbId || null });
  }

  /* ------------------------- 路由 ------------------------- */

  const adminPassword = process.env.ADMIN_PASSWORD || '';

  function adminAuthorized(req, res) {
    if (!adminPassword) return true;
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      if (pass === adminPassword) return true;
      void user;
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="media-rotator admin"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('需要管理员密码');
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/');

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Range,Authorization',
          'Access-Control-Max-Age': '86400',
        });
        return res.end();
      }

      if (isAdmin && !adminAuthorized(req, res)) return;

      /* ---- 公共接口 ---- */
      if (pathname === '/api/health') {
        return json(res, {
          ok: true,
          ready: state.library.episodes.length > 0 && configured(),
          configured: configured(),
          serverTime: Date.now(),
          library: {
            series: state.library.series.length,
            episodes: state.library.episodes.length,
            generatedAt: state.library.stats?.generatedAt || null,
            stats: state.library.stats,
          },
          channels: state.config.channels.map((c) => c.id),
          scan: { running: state.scan.running, stage: state.scan.stage, done: state.scan.done, total: state.scan.total },
          tmdb: { enabled: state.tmdb.enabled },
          subtitles: { enabled: subtitleEnabled(), ffmpeg: Boolean(state.subs?.ffmpegAvailable) },
          remux: { enabled: Boolean(state.remux?.ready), cache: state.remux?.stats() || null },
          prefetch: state.prefetch ? state.prefetch.stats() : null,
          compat: {
            publish: state.config.compat?.publish || 'local',
            store: state.compat ? { root: state.compat.root, urlPrefix: state.compat.urlPrefix } : null,
          },
        });
      }

      if (pathname === '/api/config') {
        return json(res, {
          serverTime: Date.now(),
          timezone: state.config.timezone,
          stream: { mode: state.config.stream.mode, urlPrefix: state.config.stream.urlPrefix },
          channels: state.config.channels.map((c) => channelSummary(c)),
          library: { series: state.library.series.length, episodes: state.library.episodes.length },
          ready: state.library.episodes.length > 0 && configured() && state.config.channels.length > 0,
        });
      }

      if (pathname === '/api/channels') {
        return json(res, { channels: state.config.channels.map(channelSummary) });
      }

      if (pathname === '/api/now') return apiNow(url, res);
      if (pathname === '/api/schedule') return apiSchedule(url, res);
      if (pathname === '/api/library') return apiLibrary(url, res);
      if (pathname === '/api/report-duration' && req.method === 'POST') return await apiReportDuration(req, res);

      if (pathname === '/api/reload' && req.method === 'POST') {
        if (!fs.existsSync(state.config.paths.library)) throw new HttpError(409, '索引文件不存在，请先执行扫描');
        state.library = Library.load(state.config.paths.library);
        state.timelines.clear();
        return json(res, { ok: true, series: state.library.series.length, episodes: state.library.episodes.length });
      }

      /* ---- 管理接口 ---- */
      if (pathname === '/api/admin/state') return json(res, adminState());
      if (pathname === '/api/admin/settings' && (req.method === 'PUT' || req.method === 'POST')) return await apiAdminSave(req, res);
      if (pathname === '/api/admin/scan' && req.method === 'POST') return await apiAdminScan(req, res);
      if (pathname === '/api/admin/preview' && req.method === 'POST') return json(res, apiAdminPreview(await readJson(req)));
      if (pathname === '/api/admin/resolve-pool' && req.method === 'POST') return json(res, apiAdminResolvePool(await readJson(req)));
      if (pathname === '/api/admin/series') return await apiAdminSeriesList(url, res);
      if (pathname === '/api/admin/posters') return await apiAdminPosters(url, res);
      if (pathname.startsWith('/api/admin/series/')) {
        const rest = pathname.slice('/api/admin/series/'.length);
        if (rest.endsWith('/tmdb') && req.method === 'POST') {
          return await apiAdminSetMatch(req, res, rest.slice(0, -'/tmdb'.length));
        }
        if (req.method === 'GET') return await apiAdminSeriesDetail(url, res, rest);
      }
      if (pathname === '/api/admin/tmdb/sync' && req.method === 'POST') return await apiAdminTmdbSync(req, res);
      if (pathname === '/api/admin/tmdb/facets') return apiAdminTmdbFacets(url, res);
      if (pathname === '/api/admin/tmdb/search') return await apiAdminTmdbSearch(url, res);
      if (pathname === '/api/admin/tmdb/test' && req.method === 'POST') return await apiAdminTmdbTest(req, res);

      /* ---- 字幕 ---- */
      if (pathname === '/api/fonts') {
        const dir = path.join(path.dirname(state.config.paths.library), 'fonts');
        const files = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((f) => /\.(woff2?|ttf|otf)$/i.test(f))
          : [];
        return json(res, { fonts: files.map((f) => ({ name: f, url: `/fonts/${encodeURIComponent(f)}` })) });
      }

      if (pathname.startsWith('/fonts/')) {
        const name = decodeURIComponent(pathname.slice('/fonts/'.length));
        if (!/^[\w.\-\u4e00-\u9fa5]+\.(woff2?|ttf|otf)$/i.test(name)) throw new HttpError(400, '字体名不合法');
        const dir = path.join(path.dirname(state.config.paths.library), 'fonts');
        const file = path.join(dir, name);
        if (!path.resolve(file).startsWith(path.resolve(dir))) throw new HttpError(400, '路径不合法');
        if (!fs.existsSync(file)) throw new HttpError(404, '字体不存在');
        const mime = /\.woff2$/i.test(name) ? 'font/woff2' : /\.woff$/i.test(name) ? 'font/woff' : /\.ttf$/i.test(name) ? 'font/ttf' : 'font/otf';
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=604800',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(fs.readFileSync(file));
      }

      if (pathname.startsWith('/subtitle/')) {
        if (!subtitleEnabled()) throw new HttpError(404, '字幕功能已关闭');
        const fileId = pathname.slice('/subtitle/'.length);
        const ep = state.library.getEpisode(fileId);
        if (!ep) throw new HttpError(404, `未知文件：${fileId}`);
        if (url.searchParams.get('format') === 'ass') {
          const raw = await state.subs.get(ep);
          if (!raw || !raw.raw || !/^\[script info\]/i.test(raw.raw.trim())) {
            throw new HttpError(404, '这一集没有 ASS 源字幕');
          }
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end(raw.raw);
        }

        if (url.searchParams.get('format') === 'json') {
          const cues = await state.subs.getCues(ep);
          if (!cues) {
            throw new HttpError(404, ep.subtitle ? '字幕转换失败' : '这一集没有外挂字幕，也没有可抽取的内挂字幕');
          }
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
            'X-Subtitle-Source': cues.source,
          });
          return res.end(JSON.stringify(cues));
        }
        const result = await state.subs.get(ep);
        if (!result) {
          throw new HttpError(404, ep.subtitle ? '字幕转换失败' : '这一集没有外挂字幕，也没有可抽取的内挂字幕');
        }
        res.writeHead(200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
          'X-Subtitle-Source': result.source,
        });
        return res.end(result.text);
      }

      /* ---- 视频流 ---- */
      if (pathname.startsWith('/stream/')) {
        const fileId0 = pathname.slice('/stream/'.length);
        if (url.searchParams.get('format') === 'mp4') {
          const ep = state.library.getEpisode(fileId0);
          if (!ep) throw new HttpError(404, `未知文件：${fileId0}`);
          await state.remux.refresh(ep);
          const st = state.remux.status(ep);
          const wantLocal = url.searchParams.get('local') === '1';

          // 已上传到 WebDAV：直接 302 走 CDN，后端零带宽
          if (st.state === 'published' && st.directUrl && !wantLocal) {
            return sendRedirect(res, st.directUrl);
          }
          // 本地有产物就本地发（上传中也可以播）
          if (st.playable) {
            const local = state.remux.fileFor(ep);
            if (fs.existsSync(local)) {
              return sendFileWithRange(req, res, local, { contentType: 'video/mp4' });
            }
            if (st.directUrl) return sendRedirect(res, st.directUrl);
          }
          if (st.state === 'published' && st.directUrl) return sendRedirect(res, st.directUrl);
          if (st.state === 'working' || st.state === 'idle' || st.state === 'uploading') {
            state.remux.start(ep);
            res.writeHead(202, { 'Retry-After': '5', 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ state: st.state, progress: st.progress || 0 }));
          }
          if (st.state === 'unavailable') throw new HttpError(501, st.reason || '当前镜像没有 ffmpeg，无法转封装');
          if (st.state === 'disabled') throw new HttpError(404, '转封装功能已关闭');
          throw new HttpError(500, st.error || '转封装失败');
        }
        return apiStream(req, res, url, fileId0);
      }

      /* ---- 转封装任务 ---- */
      if (pathname.startsWith('/api/remux/')) {
        const fileId = pathname.slice('/api/remux/'.length);
        const ep = state.library.getEpisode(fileId);
        if (!ep) throw new HttpError(404, `未知文件：${fileId}`);
        await state.remux.refresh(ep);
        if (req.method === 'POST') state.remux.start(ep);
        const st = state.remux.status(ep);
        return json(res, { fileId, ...st, cache: state.remux.stats() });
      }

      if (pathname.startsWith('/api/')) throw new HttpError(404, `未知接口：${pathname}`);

      /* ---- 静态资源 ---- */
      if (pathname === '/admin') {
        res.writeHead(302, { Location: '/admin/' });
        return res.end();
      }
      if (pathname === '/admin/' || pathname.startsWith('/admin/')) {
        return serveStatic(res, state.config.server.publicDir, '/admin.html');
      }
      return serveStatic(res, state.config.server.publicDir, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500 && !err.status) console.error(`[${req.method} ${pathname}]`, err);
      if (!res.headersSent) json(res, { error: err.message, status }, status);
      else res.destroy();
    } finally {
      if (process.env.LOG_REQUESTS) {
        console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  server.on('close', () => state.prefetch?.stop());

  return { server, state, rebuild, runScan, getTimeline };
}

/* ------------------------- 工具 ------------------------- */

function json(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4e6) reject(new HttpError(413, '请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, publicDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(publicDir, rel);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(publicDir))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

export { HttpError };
