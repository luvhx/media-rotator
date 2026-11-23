/**
 * 前端播放器
 * ------------------------------------------------------------------
 * 直播模型：时间轴由后端唯一决定。
 *   1. 拉 /api/now 得到「当前节目 + 起止时间 + 已播进度」；
 *   2. video.src 指向 /stream/<fileId>（后端 302 到直链，或直接代理）；
 *   3. 用「结束时间 - 现在」反推播放位置，自动 seek 对齐（不依赖时长估算精度）；
 *   4. 每秒校正一次漂移，每 10 秒刷新节目单。
 */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PREFIX_OVERRIDE = params.get('prefix');

const state = {
  channelId: params.get('channel') || localStorage.getItem('rotator.channel') || null,
  channels: [],
  tz: 'Asia/Shanghai',
  now: null,
  clockOffset: 0,
  started: false,
  userPaused: false,
  activeFileId: null,
  drift: null,
  justLoaded: true,
  switching: false,
  lastSeekAt: 0,
  subtitleOn: localStorage.getItem('rotator.subtitles') !== '0',
  subSize: Number(localStorage.getItem('rotator.sub.size') || 1),
  subAlign: Number(localStorage.getItem('rotator.sub.align') || 0),
  subMargin: Number(localStorage.getItem('rotator.sub.margin') || 8),
  subBg: localStorage.getItem('rotator.sub.bg') === '1',
  subAss:
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('ass')
      ? new URLSearchParams(location.search).get('ass') !== '0'
      : localStorage.getItem('rotator.sub.ass') === '1',
  jassub: null,
  assFor: null,
  cues: null,
  cuesFor: null,
  cuesMeta: null,
  cueKey: '',
  shifting: false,
  liveOffset: null,
  ui: null,
  subtitleFor: null,
  prefetchedSub: null,
  forceCompat: false,
  compatJob: null,
  loadStartedAt: 0,
  watchdogFired: false,
  autoplay: null,
  setup: false,
  fetchTimer: null,
  fetchPending: false,
  errors: 0,
};

import { mountPlayerUI } from './player-ui.js';

const player = $('player');

/* iOS / iPadOS 上所有浏览器都不支持 MKV 容器，需要走转封装 */
const IS_APPLE_MOBILE =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);

/* ------------------------------ 时间 ------------------------------ */

const serverNow = () => Date.now() + state.clockOffset;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtClock(ms) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleTimeString();
  }
}

function fmtHHMM(ms) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

/* ------------------------------ 网络 ------------------------------ */

async function getNow() {
  const q = new URLSearchParams({ channel: state.channelId });
  if (PREFIX_OVERRIDE) {
    q.set('prefix', PREFIX_OVERRIDE);
    q.set('mode', 'direct');
  }
  const res = await fetch(`/api/now?${q}`, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.setup = Boolean(data.setup);
    throw err;
  }
  return data;
}

async function refreshNow(force = false) {
  if (state.fetchPending && !force) return;
  state.fetchPending = true;
  try {
    const data = await getNow();
    state.errors = 0;
    state.clockOffset = data.serverTime - Date.now();
    state.tz = data.timezone || state.tz;
    const prevId = state.now?.now?.fileId;
    state.now = data;
    hideError();
    applyNow(prevId);
  } catch (err) {
    if (err.setup) {
      showSetup();
      return;
    }
    state.errors++;
    showError(`无法连接后端：${err.message}（第 ${state.errors} 次，稍后自动重试）`);
    setStatus(`后端连接失败：${err.message}`);
    scheduleFetch(3000);
  } finally {
    state.fetchPending = false;
  }
}

function scheduleFetch(delay = 10000) {
  clearTimeout(state.fetchTimer);
  state.fetchTimer = setTimeout(() => refreshNow(), delay);
}

/* ------------------------------ 应用状态 ------------------------------ */

function applyNow(prevFileId) {
  const data = state.now;
  if (data.off) return applyOff();
  const item = data.now;
  if (!item) return;

  if (item.fileId !== state.activeFileId) {
    loadItem(item, item.fileId !== prevFileId && prevFileId !== undefined);
  } else if (state.subtitleFor !== item.fileId) {
    applySubtitle(item);
  }

  $('seriesName').textContent = item.series;
  $('epLabel').textContent = `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
  $('epTitle').textContent = item.title || item.name || '';
  $('segLabel').textContent = item.segmentLabel || '';
  $('segLabel').style.display = item.segmentLabel ? '' : 'none';
  $('directLink').href = item.directUrl || item.streamUrl;
  $('directLink').title = item.relPath;

  $('epgSub').textContent = `${fmtHHMM(item.startsAt)} - ${fmtHHMM(item.endsAt)}`;

  renderEpg();
  updateUi();
  setStatus(
    `${data.channel.name} · 时间网格${data.channel.description ? ' · ' + data.channel.description : ''}`,
  );
  scheduleFetch(10000);
}

/** 留空时段：停播并显示下一档 */
function applyOff() {
  const data = state.now;
  if (state.activeFileId) {
    try {
      player.pause();
    } catch {
      /* ignore */
    }
    state.activeFileId = null;
  }
  const overlay = $('overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = '';
  const next = data.next?.[0];
  const title = document.createElement('p');
  title.className = 'off-title';
  title.textContent = '暂停播出';
  const when = document.createElement('p');
  when.className = 'off-time';
  when.textContent = next ? `下一档 ${fmtHHMM(next.startsAt)} · ${next.series}` : '暂无后续节目';
  const tip = document.createElement('p');
  tip.className = 'hint';
  tip.textContent = '节目单按整点 / 半点对齐，空出来的时段留白。';
  overlay.append(title, when, tip);

  $('seriesName').textContent = '暂停播出';
  $('epLabel').textContent = '';
  $('epTitle').textContent = next ? `下一档 ${fmtHHMM(next.startsAt)}` : '';
  $('segLabel').style.display = 'none';
  try {
    const link = $('directLink');
    if (link && typeof link.removeAttribute === 'function') link.removeAttribute('href');
  } catch {
    /* 忽略：待机时链接不可用 */
  }
  $('epgSub').textContent = next ? `— 至 ${fmtHHMM(next.startsAt)}` : '—';
  renderEpg();
  setStatus(`${data.channel.name} · 留空时段`);

  const wait = data.until ? Math.max(3000, Math.min(60000, data.until - (Date.now() + state.clockOffset) + 800)) : 15000;
  scheduleFetch(wait);
}

function loadItem(item, announce) {
  state.activeFileId = item.fileId;
  state.justLoaded = true;
  state.switching = true;
  state.drift = null;
  const url = item.streamUrl || `/stream/${item.fileId}`;
  if (announce) setStatus(`切换节目：${item.series} S${item.season}E${item.episode}`);
  state.subtitleFor = null;
  applySubtitle(item);
  state.loadStartedAt = Date.now();
  state.watchdogFired = false;

  // 兼容模式（iOS/Safari 等不支持 MKV）：直接走转封装，避免先拉一次注定失败的 MKV
  if (state.forceCompat) {
    state.switching = false;
    startCompat(item);
    return;
  }

  player.src = url;
  player.load();
  setTimeout(() => {
    state.switching = false;
  }, 2000);

  // 已经在播：换源后继续播（保持静音状态）；还没开始：保留「开始收看」按钮
  if (state.started) {
    hideOverlay();
    tryPlay();
  } else {
    showStartOverlay();
  }
}

/* ---------------- 兼容模式：MKV → MP4 转封装 ---------------- */

function showCompat(progress, text) {
  const panel = $('compatPanel');
  if (!panel) return;
  panel.hidden = false;
  const bar = $('compatBar');
  if (bar) bar.style.width = `${Math.round((progress || 0) * 100)}%`;
  const sub = $('compatSub');
  if (sub && text) sub.textContent = text;
}

function hideCompat() {
  const panel = $('compatPanel');
  if (panel) panel.hidden = true;
}

/**
 * 请求后端把这集转封装成 MP4 并等待就绪。
 * 只做容器转换（视频流 copy、音频转 AAC），不重新编码，通常几十秒。
 */
async function startCompat(item) {
  if (!item) return;
  if (state.compatJob && state.compatJob.fileId === item.fileId) return;
  state.compatJob = { fileId: item.fileId };
  hideOverlay();
  showCompat(0, '正在准备兼容格式（MKV → MP4，服务端预封装）…');

  const applyReady = () => {
    hideCompat();
    player.src = `/stream/${item.fileId}?format=mp4`;
    player.load();
    state.justLoaded = true;
    state.loadStartedAt = Date.now();
    if (!state.started) autoStartMuted();
    else tryPlay();
  };

  try {
    // 预封装由服务端后台负责：这里只查询状态，不再触发转封装
    let st = await fetch(`/api/remux/${item.fileId}`).then((r) => r.json());
    if (st.playable) return applyReady();
    if (st.state === 'unavailable' || st.state === 'disabled') {
      hideCompat();
      showError(`无法转封装：${st.reason || '当前镜像没有 ffmpeg，请使用 :latest-ffmpeg 镜像'}`);
      return;
    }
    if (st.state === 'error') {
      hideCompat();
      showError(`转封装失败：${st.error || '未知错误'}`);
      return;
    }

    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      st = await fetch(`/api/remux/${item.fileId}`).then((r) => r.json());
      if (st.playable) return applyReady();
      if (st.state === 'error') {
        hideCompat();
        showError(`转封装失败：${st.error || '未知错误'}`);
        return;
      }
      const pct = Math.round((st.progress || 0) * 100);
      showCompat(st.progress || 0, `等待预封装… ${pct}%（服务端正在准备这一集）`);
    }
    hideCompat();
    showError('转封装超时，请稍后重试');
  } catch (err) {
    hideCompat();
    showError(`转封装请求失败：${err.message}`);
  } finally {
    state.compatJob = null;
  }
}

/**
 * 挂载字幕：后端把 .ass/.srt/内挂轨道统一转成 WebVTT，
 * 这里只需要一个 <track>，浏览器会自己按时间轴显示。
 */
/** 解析 WebVTT（后端已经处理过 ASS/SRT 转换） */
function parseVtt(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
  const toSec = (h, m, sec, ms) => (h ? Number(String(h).replace(':', '')) : 0) * 3600 + Number(m) * 60 + Number(sec) + Number(ms) / 1000;
  const re = /(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/;
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const m = re.exec(lines[idx]);
    if (!m) continue;
    const body = lines
      .slice(idx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!body) continue;
    cues.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** 按当前播放时间渲染字幕（不依赖 <track>，跨域视频也能显示） */
/** 视频画面在容器里的真实矩形（扣除上下/左右黑边） */
function videoContentRect() {
  const wrap = $('videoWrap');
  const vw = player.videoWidth;
  const vh = player.videoHeight;
  if (!wrap || !vw || !vh) return null;
  const cw = wrap.clientWidth;
  const ch = wrap.clientHeight;
  if (!cw || !ch) return null;
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h };
}

function renderCue() {
  const layer = $('subtitleLayer');
  if (!layer) return;
  if (state.jassub) {
    layer.innerHTML = '';
    layer.classList.remove('show');
    return;
  }
  const cues = state.cues;
  if (!state.subtitleOn || !cues || cues.length === 0) {
    if (state.cueKey !== 'off') {
      layer.innerHTML = '';
      layer.classList.remove('show');
      state.cueKey = 'off';
    }
    return;
  }
  const t = player.currentTime || 0;
  const active = cues.filter((c) => t >= c.start && t < c.end);
  const key = active.map((c) => c.start + '|' + c.html + '|' + (c.pos ? c.pos.x + ',' + c.pos.y : c.align)).join('##') + '|' + state.subAlign + '|' + state.subSize + '|' + state.subMargin;
  if (key === state.cueKey) return;
  state.cueKey = key;
  layer.innerHTML = '';
  if (active.length === 0) {
    layer.classList.remove('show');
    return;
  }

  layer.style.setProperty('--sub-bg', state.subBg ? 'rgba(0, 0, 0, 0.58)' : 'transparent');

  // 字幕层贴住视频画面（宽银幕片源的黑边不再影响字幕位置）
  const rect = videoContentRect();
  if (rect) {
    layer.style.inset = 'auto';
    layer.style.left = rect.left + 'px';
    layer.style.top = rect.top + 'px';
    layer.style.width = rect.width + 'px';
    layer.style.height = rect.height + 'px';
  } else {
    layer.style.inset = '0';
  }
  const wrap = $('videoWrap');
  const stageH = (rect && rect.height) || (wrap && wrap.clientHeight) || player.clientHeight || 720;
  const meta = state.cuesMeta || { playResX: 1280, playResY: 720 };

  const makeEl = (c) => {
    const node = document.createElement('div');
    node.className = 'cue';
    node.innerHTML = c.html;
    if (c.size) node.style.fontSize = Math.max(12, ((c.size / meta.playResY) * stageH * state.subSize) | 0) + 'px';
    else node.style.fontSize = Math.round(26 * state.subSize) + 'px';
    return node;
  };

  // 位置：0 = 跟随字幕自带对齐；否则面板强制统一位置（\pos 除外）
  const free = active.filter((c) => !c.pos);
  const groups2 = new Map();
  for (const c of free) {
    const key2 = state.subAlign === 0 ? (c.align <= 3 ? 'bottom' : c.align <= 6 ? 'middle' : 'top') : state.subAlign <= 3 ? 'bottom' : state.subAlign <= 6 ? 'middle' : 'top';
    if (!groups2.has(key2)) groups2.set(key2, []);
    groups2.get(key2).push(c);
  }
  for (const [anchor, list] of groups2) {
    const box = document.createElement('div');
    box.className = 'cue-group ' + anchor;
    if (anchor === 'bottom') box.style.bottom = state.subMargin + '%';
    else if (anchor === 'top') box.style.top = state.subMargin + '%';
    for (const c of list) box.append(makeEl(c));
    layer.append(box);
  }
  for (const c of active.filter((c) => c.pos)) {
    const node = makeEl(c);
    node.classList.add('positioned');
    node.style.left = (c.pos.x / meta.playResX) * 100 + '%';
    node.style.top = (c.pos.y / meta.playResY) * 100 + '%';
    node.style.transform = 'translate(-50%, -50%)';
    layer.append(node);
  }
  layer.classList.add('show');
}


/** 完整 ASS 渲染（libass/wasm）：开启时用画布渲染，关闭时回到 DOM 渲染 */
async function ensureAssRenderer(item) {
  if (!state.subAss || !item?.subtitleUrl) return false;
  if (typeof location === 'undefined' || typeof Worker === 'undefined') return false;
  if (state.jassub && state.assFor === item.fileId) return true;
  const canvas = $('assCanvas');
  if (!canvas) return false;
  try {
    const { default: JASSUB } = await import('./vendor/jassub/jassub.js');
    let fonts = [];
    try {
      const list = await (await fetch('/api/fonts')).json();
      fonts = (list.fonts || []).map((f) => f.url);
    } catch {
      /* 没有字体列表也能跑，只是中文可能缺字 */
    }
    if (state.jassub) {
      try { state.jassub.destroy(); } catch { /* ignore */ }
      state.jassub = null;
    }
    canvas.hidden = false;
    const base = new URL('.', location.href).href;
    const builtinFonts = {
      'noto sans sc': base + 'vendor/jassub/fonts/noto-sans-sc.woff2',
      'noto sans jp': base + 'vendor/jassub/fonts/noto-sans-jp.woff2',
    };
    const availableFonts = { ...builtinFonts };
    for (const url of fonts) {
      const name = decodeURIComponent(url.split('/').pop() || '').replace(/\.(woff2?|ttf|otf)$/i, '').replace(/[-_]+/g, ' ').toLowerCase();
      if (name) availableFonts[name] = url;
    }
    state.jassub = new JASSUB({
      video: player,
      canvas,
      subUrl: new URL(`/subtitle/${item.fileId}?format=ass`, location.href).href,
      workerUrl: base + 'vendor/jassub/worker.js',
      wasmUrl: base + 'vendor/jassub/wasm/jassub-worker.wasm',
      modernWasmUrl: base + 'vendor/jassub/wasm/jassub-worker-modern.wasm',
      wasmWorkerUrl: base + 'vendor/jassub/wasm/jassub-worker.js',
      modernWasmWorkerUrl: base + 'vendor/jassub/wasm/jassub-worker-modern.js',
      fonts: [builtinFonts['noto sans sc'], builtinFonts['noto sans jp'], ...fonts],
      availableFonts,
      defaultFont: 'noto sans sc',
      prescaleHeightLimit: 1080,
      maxRenderHeight: 2160,
    });
    state.assFor = item.fileId;
    await state.jassub.ready;
    $('subtitleLayer').classList.remove('show');
    $('subtitleLayer').innerHTML = '';
    setStatus(fonts.length ? '完整 ASS 渲染已启用' : '完整 ASS 渲染已启用（未找到字体，中文可能不显示）');
    return true;
  } catch (err) {
    setStatus('完整 ASS 渲染失败：' + err.message);
    canvas.hidden = true;
    state.jassub = null;
    state.assFor = null;
    return false;
  }
}

function disableAssRenderer() {
  if (state.jassub) {
    try { state.jassub.destroy(); } catch { /* ignore */ }
  }
  state.jassub = null;
  state.assFor = null;
  const canvas = $('assCanvas');
  if (canvas) canvas.hidden = true;
}

async function loadCues(item) {
  if (state.cuesFor === item.fileId) return;
  state.cuesFor = item.fileId;
  state.cues = null;
  state.cueKey = '';
  state.cuesMeta = null;
  if (await ensureAssRenderer(item)) return;
  disableAssRenderer();
  try {
    const target = item.subtitleJsonUrl || item.subtitleUrl;
    const url = new URL(target, typeof location !== 'undefined' ? location.href : 'http://localhost/');
    if (!item.subtitleJsonUrl) url.searchParams.set('format', 'json');
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.cues = (data.cues || []).map((c) => ({ ...c, start: Number(c.start), end: Number(c.end) }));
    state.cuesMeta = { playResX: data.playResX || 1280, playResY: data.playResY || 720, kind: data.kind };
    if (state.cues.length === 0) setStatus('这一集的字幕是空的');
    else renderCue();
  } catch (err) {
    state.cues = null;
    setStatus('字幕加载失败：' + err.message);
    renderCue();
  }
}

/** 同步字幕面板的显示状态 */
function syncSubtitlePanel(item) {
  const has = Boolean(item && item.subtitleUrl);
  const panel = $('subPanel');
  if (panel) panel.classList.toggle('disabled', !has);
  const enabled = $('subEnabled');
  if (enabled) {
    enabled.checked = state.subtitleOn && has;
    enabled.disabled = !has;
  }
  const stateEl = $('subState');
  if (stateEl) {
    stateEl.textContent = !has
      ? '本集无字幕'
      : state.subtitleOn
        ? `已加载（${item.subtitleKind === 'embedded' ? '内挂' : '外挂'}）`
        : '已关闭';
  }
}

function applySubtitle(item) {
  const layer = $('subtitleLayer');
  if (layer) {
    layer.classList.remove('show');
    layer.innerHTML = '';
  }
  if (!item || !item.subtitleUrl) {
    disableAssRenderer();
    syncSubtitlePanel(null);
    state.subtitleFor = item?.fileId || null;
    state.cues = null;
    state.cuesFor = null;
    return;
  }
  syncSubtitlePanel(item);
  state.subtitleFor = item.fileId;
  if (state.subtitleOn) loadCues(item);
}

function hideOverlay() {
  $('overlay').classList.add('hidden');
}

function showStartOverlay(msg) {
  if (state.setup) return;
  const overlay = $('overlay');
  overlay.classList.remove('hidden');
  const btn = $('startBtn');
  if (btn) btn.textContent = msg || '▶ 开始收看';
}

/** 提前把下一集字幕拉进后端缓存，切集时不用等 */
function prefetchNextSubtitle() {
  const next = state.now?.next?.[0];
  if (!next || !next.subtitleUrl || state.prefetchedSub === next.fileId) return;
  state.prefetchedSub = next.fileId;
  fetch(next.subtitleUrl).catch(() => {});
}

// 右上角的静音提示已移除：改由播放器自带的音量按钮控制
function showUnmuteHint() {}
function hideUnmuteHint() {}

/**
 * 首屏先静音自动播放：浏览器允许静音自动播放，用户点一下即可取消静音。
 * 这样打开页面就能看到画面在动，而不是停在第一帧。
 */
async function autoStartMuted() {
  if (state.started || state.setup) return;
  player.muted = true;
  try {
    await player.play();
    state.started = true;
    state.userPaused = false;
    state.autoplay = 'muted';
    hideOverlay();
    showUnmuteHint();
    setStatus('静音播放中 · 用播放器的音量按钮取消静音');
  } catch {
    state.autoplay = 'blocked';
    showStartOverlay('▶ 点击开始（浏览器需要一次点击）');
  }
}

function tryPlay() {
  const p = player.play();
  if (p && typeof p.catch === 'function') {
    p.catch((err) => {
      if (err && err.name === 'NotAllowedError') {
        state.started = false;
        showStartOverlay('▶ 浏览器阻止了自动播放，点一下开始');
      }
    });
  }
}

/* ------------------------------ 同步 ------------------------------ */

/** 目标播放位置（秒）。优先用「真实时长 - 剩余时间」，这样时长估算不准也能对齐。 */
function targetTime(item, nowMs) {
  const remaining = (item.endsAt - nowMs) / 1000;
  const d = player.duration;
  const hasDuration = Number.isFinite(d) && d > 5;
  const durMatches = hasDuration && Math.abs(d * 1000 - item.durationMs) < 10000;

  if (durMatches) {
    return clamp(d - remaining, 0, d - 0.4);
  }
  const byOffset = (nowMs - item.startsAt) / 1000;
  return clamp(byOffset, 0, hasDuration ? d - 0.4 : byOffset);
}

/** 用户拖动进度 / 双击快进：进入回看状态，暂停自动纠偏 */
function enterShift() {
  if (!state.started) return;
  state.shifting = true;
  setStatus('回看中 · 点「回到直播」恢复');
}

/** 回到直播位置 */
function goLive() {
  state.shifting = false;
  state.justLoaded = true;
  state.lastSeekAt = 0;
  const item = state.now?.now;
  if (item) {
    const target = targetTime(item, serverNow());
    try {
      player.currentTime = target;
    } catch {
      /* ignore */
    }
  }
  setStatus('已回到直播');
}

function tick() {
  renderCue();
  const item = state.now?.now;
  if (!item) return;
  const nowMs = serverNow();
  const remainingMs = item.endsAt - nowMs;

  // 载入 12 秒还没有任何可播数据：多半是容器/编码不支持（典型：iOS 上的 MKV）
  if (
    !state.watchdogFired &&
    !state.forceCompat &&
    state.activeFileId &&
    player.readyState < 2 &&
    nowMs - state.loadStartedAt > 12000
  ) {
    state.watchdogFired = true;
    if (IS_APPLE_MOBILE) {
      state.forceCompat = true;
      $('compatBtn')?.classList.add('on');
      startCompat(item);
    } else {
      showError('这个文件在当前浏览器放不了（MKV / HEVC 常见）。点底栏「兼容模式」转成 MP4 再试。');
    }
  }

  // 快播完时预取下一集字幕（内挂字幕首次需要抽取，提前预热）
  if (remainingMs < 180000) prefetchNextSubtitle();

  if (remainingMs <= 250) {
    // 本集要结束了，立刻取下一个节目
    scheduleFetch(0);
    return;
  }

  // 自绘控制条：更新进度/直播标记/回看状态
  const liveOffset = targetTime(item, nowMs);
  state.liveOffset = liveOffset;
  const shiftSeconds = player.currentTime - liveOffset;
  state.ui?.update({
    liveOffset,
    shifting: state.shifting,
    shiftSeconds,
    hasCC: Boolean(item.subtitleUrl),
    ccOn: state.subtitleOn,
  });

  if (state.started && player.readyState >= 1 && !state.userPaused && !state.shifting) {
    const target = targetTime(item, nowMs);
    const drift = player.currentTime - target;
    state.drift = drift;
    const threshold = state.justLoaded ? 2.5 : 4;
    // 首次对齐只要元数据就绪即可；之后的纠偏要等缓冲够、且 3 秒内不重复 seek，
    // 否则会陷入「反复跳转 → 永远缓冲 → 画面不动」
    const canSeek =
      !player.seeking &&
      (state.justLoaded ? player.readyState >= 1 : player.readyState >= 2 && nowMs - state.lastSeekAt > 3000);
    if (Math.abs(drift) > threshold && canSeek) {
      state.lastSeekAt = nowMs;
      try {
        player.currentTime = target;
      } catch {
        /* 元数据未就绪 */
      }
      state.justLoaded = false;
    } else if (Math.abs(drift) <= threshold) {
      state.justLoaded = false;
    }
    if (player.paused && !player.ended) tryPlay();
  }

  updateUi();
}

/* ------------------------------ 渲染 ------------------------------ */

function updateUi() {
  const item = state.now?.now;
  if (!item) return;
  const nowMs = serverNow();
  const elapsed = clamp(nowMs - item.startsAt, 0, item.durationMs);
  const progress = item.durationMs > 0 ? elapsed / item.durationMs : 0;

  $('progressFill').style.width = `${(progress * 100).toFixed(2)}%`;
  $('posText').textContent = `${fmtHHMM(item.startsAt)} · ${fmtDur(elapsed)} / ${fmtDur(item.durationMs)}`;
  $('endText').textContent = `${fmtHHMM(item.endsAt)} 结束`;
  $('clock').textContent = fmtClock(nowMs);

  const sync = $('syncText');
  if (!state.started) {
    sync.textContent = '待开播';
    sync.className = 'sync';
  } else if (state.drift == null) {
    sync.textContent = '同步中…';
    sync.className = 'sync';
  } else if (player.readyState < 2) {
    sync.textContent = '缓冲中…';
    sync.className = 'sync warn';
  } else {
    const a = Math.abs(state.drift);
    if (a < 1) {
      sync.textContent = '已同步';
      sync.className = 'sync ok';
    } else if (a < 4) {
      sync.textContent = `偏差 ${state.drift > 0 ? '+' : ''}${state.drift.toFixed(1)}s`;
      sync.className = 'sync warn';
    } else {
      sync.textContent = `校正 ${state.drift > 0 ? '+' : ''}${state.drift.toFixed(1)}s`;
      sync.className = 'sync bad';
    }
  }
  $('endText').textContent = `${fmtHHMM(item.endsAt)} 结束`;
}

function renderEpg() {
  const data = state.now;
  if (!data) return;
  const list = $('epgList');
  const items = [data.now, ...(data.next || [])].filter(Boolean).slice(0, 14);
  list.textContent = '';
  items.forEach((item, idx) => {
    const isNow = !data.off && idx === 0;
    const li = document.createElement('li');
    li.className = 'epg-item' + (isNow ? ' current' : '');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = isNow ? 'NOW' : fmtHHMM(item.startsAt);
    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${item.series} S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [item.title, item.segmentLabel, item.truncated ? '跨零点截断' : null].filter(Boolean);
    meta.textContent = bits.join(' · ') || item.name;
    body.append(name, meta);
    li.append(t, body);
    list.append(li);
  });
}

function setStatus(text) {
  $('statusText').textContent = text;
}

function showError(msg) {
  const el = $('errorText');
  el.hidden = false;
  el.textContent = msg;
  $('overlay').classList.remove('hidden');
}

function hideError() {
  const el = $('errorText');
  el.hidden = true;
  el.textContent = '';
}

/* ------------------------------ 频道 ------------------------------ */

async function loadConfig() {
  const res = await fetch('/api/config', { cache: 'no-store' });
  const data = await res.json();
  state.tz = data.timezone || state.tz;
  state.channels = data.channels || [];
  if (!state.channelId || !state.channels.some((c) => c.id === state.channelId)) {
    state.channelId = state.channels[0]?.id || 'main';
  }
  $('modeBadge').textContent = PREFIX_OVERRIDE
    ? '直链前缀覆盖'
    : data.stream?.mode === 'proxy'
      ? '后端代理'
      : '302 直链';
  $('tzLabel').textContent = state.tz;
  renderChannels();
  if (data.ready === false) {
    showSetup();
    return false;
  }
  if (data.library) {
    $('libraryInfo').textContent = `库内 ${data.library.series} 部 / ${data.library.episodes} 集 · 前缀 ${
      PREFIX_OVERRIDE || data.stream?.urlPrefix || ''
    }`;
  }
  return true;
}

function showSetup() {
  state.setup = true;
  const overlay = $('overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = '';
  const link = document.createElement('a');
  link.className = 'start-btn';
  link.href = '/admin';
  link.textContent = '⚙ 打开管理界面';
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = '还没有就绪：在管理界面填写 WebDAV、扫描媒体库，并新建一个频道。';
  overlay.append(link, p);
  setStatus('未初始化：请先打开 /admin 完成配置');
  $('seriesName').textContent = '尚未配置';
  $('epLabel').textContent = '';
  $('epTitle').textContent = '';
}

function renderChannels() {
  const nav = $('channels');
  nav.textContent = '';
  for (const ch of state.channels) {
    const btn = document.createElement('button');
    btn.className = 'channel' + (ch.id === state.channelId ? ' active' : '');
    btn.textContent = ch.name;
    btn.title = ch.description || ch.name;
    btn.addEventListener('click', () => {
      if (ch.id === state.channelId) return;
      state.channelId = ch.id;
      localStorage.setItem('rotator.channel', ch.id);
      state.activeFileId = null;
      state.now = null;
      state.drift = null;
      state.justLoaded = true;
      for (const b of nav.querySelectorAll('.channel')) b.classList.toggle('active', b === btn);
      setStatus(`切换频道：${ch.name}`);
      refreshNow(true);
    });
    nav.append(btn);
  }
}


/* ------------------------------ 字幕面板 ------------------------------ */

(function bindSubtitlePanel() {
  const sizeEl = $('subSize');
  const alignEl = $('subAlign');
  const marginEl = $('subMargin');
  const marginVal = $('subMarginVal');
  const bgEl = $('subBg');
  const enabledEl = $('subEnabled');
  const resetEl = $('subReset');
  const assEl = $('subAss');

  const persist = () => {
    localStorage.setItem('rotator.sub.size', String(state.subSize));
    localStorage.setItem('rotator.sub.align', String(state.subAlign));
    localStorage.setItem('rotator.sub.margin', String(state.subMargin));
    localStorage.setItem('rotator.sub.bg', state.subBg ? '1' : '0');
  };
  const redraw = () => {
    state.cueKey = '';
    renderCue();
  };
  const sync = () => {
    if (assEl) assEl.checked = state.subAss;
    if (sizeEl) sizeEl.value = String(state.subSize);
    if (alignEl) alignEl.value = String(state.subAlign);
    if (marginEl) marginEl.value = String(state.subMargin);
    if (marginVal) marginVal.textContent = state.subMargin + '%';
    if (bgEl) bgEl.checked = state.subBg;
    syncSubtitlePanel(state.now?.now);
  };

  sizeEl?.addEventListener('change', () => { state.subSize = Number(sizeEl.value) || 1; persist(); redraw(); });
  alignEl?.addEventListener('change', () => { state.subAlign = Number(alignEl.value) || 2; persist(); redraw(); });
  marginEl?.addEventListener('input', () => {
    state.subMargin = Number(marginEl.value) || 0;
    if (marginVal) marginVal.textContent = state.subMargin + '%';
    persist();
    redraw();
  });
  assEl?.addEventListener('change', async () => {
    state.subAss = assEl.checked;
    localStorage.setItem('rotator.sub.ass', state.subAss ? '1' : '0');
    const item = state.now?.now;
    if (state.subAss) {
      if (!(await ensureAssRenderer(item))) {
        assEl.checked = false;
        state.subAss = false;
        localStorage.setItem('rotator.sub.ass', '0');
        state.cueKey = '';
        renderCue();
      }
    } else {
      disableAssRenderer();
      state.cueKey = '';
      renderCue();
    }
  });
  bgEl?.addEventListener('change', () => { state.subBg = bgEl.checked; persist(); redraw(); });
  enabledEl?.addEventListener('change', () => toggleSubtitles(enabledEl.checked));
  resetEl?.addEventListener('click', () => {
    state.subSize = 1;
    state.subAlign = 0;
    state.subMargin = 8;
    state.subBg = false;
    state.subtitleOn = true;
    localStorage.setItem('rotator.subtitles', '1');
    persist();
    sync();
    redraw();
  });

  sync();
})();

/* ------------------------------ 事件 ------------------------------ */

// 自绘播放器（?native=1 时保留原生控件）
const USE_NATIVE_UI = typeof location !== 'undefined' && new URLSearchParams(location.search).has('native');
if (!USE_NATIVE_UI) {
  try {
    state.ui = mountPlayerUI({
      player,
      videoWrap: $('videoWrap'),
      state,
      hooks: {
        onSeek: () => enterShift(),
        onGoLive: () => goLive(),
        onToggleCC: () => toggleSubtitles(),
        onStatus: (msg) => setStatus(msg),
        onUserPauseChange: (paused) => {
          if (!paused) state.userPaused = false;
        },
      },
    });
  } catch (err) {
    console.warn('自定义控制条加载失败，退回原生控件', err);
    player.controls = true;
  }
} else {
  player.controls = true;
  $('playerUi')?.classList.add('hidden-ui');
}


// 原生「全屏视频」会把 DOM 覆盖层挡掉：改成全屏整个播放器容器
const videoWrap = $('videoWrap');
document.addEventListener('fullscreenchange', async () => {
  if (document.fullscreenElement === player && videoWrap && videoWrap.requestFullscreen) {
    try {
      await document.exitFullscreen();
      await videoWrap.requestFullscreen();
    } catch {
      /* 忽略 */
    }
  }
  renderCue();
});
document.addEventListener('webkitfullscreenchange', renderCue);
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('resize', () => {
    state.cueKey = '';
    renderCue();
  });
}




$('startBtn').addEventListener('click', () => {
  state.started = true;
  state.userPaused = false;
  state.autoplay = 'user';
  player.muted = false;
  hideUnmuteHint();
  hideOverlay();
  refreshNow(true);
  tryPlay();
});

player.addEventListener('loadedmetadata', () => {
  state.justLoaded = true;
  if (!state.started) autoStartMuted();
  const cur = state.now?.now;
  if (cur && state.started) {
    try {
      player.currentTime = targetTime(cur, serverNow());
    } catch {
      /* ignore */
    }
  }
  const item = state.now?.now;
  if (item && Number.isFinite(player.duration) && player.duration > 5) {
    const actual = Math.round(player.duration * 1000);
    // 真实时长与索引差异较大时回写后端，逐步把时间轴校准到准确值
    if (Math.abs(actual - item.durationMs) > 3000) {
      fetch('/api/report-duration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: item.fileId, durationMs: actual }),
      }).catch(() => {});
    }
  }
});

player.addEventListener('play', () => {
  state.userPaused = false;
  state.switching = false;
  $('liveTag').style.opacity = '0.92';
});

player.addEventListener('timeupdate', renderCue);
player.addEventListener('seeked', renderCue);

player.addEventListener('playing', () => {
  state.switching = false;
});

player.addEventListener('pause', () => {
  if (player.ended || state.switching) return;
  state.userPaused = true;
  $('liveTag').style.opacity = '0.4';
});

player.addEventListener('ended', () => scheduleFetch(0));

// 不再拦截点击：取消静音交给播放器自带的音量按钮

// 调试面板：?debug=1 显示播放器内部状态
if (new URLSearchParams(location.search).get('debug') === '1') {
  const panel = $('debugPanel');
  if (panel) {
    panel.hidden = false;
    setInterval(() => {
      const b = player.buffered;
      const buffered = b && b.length ? `${b.start(0).toFixed(0)}-${b.end(b.length - 1).toFixed(0)}s` : '-';
      panel.textContent = [
        `src       ${String(player.currentSrc || player.src).slice(0, 90)}`,
        `paused    ${player.paused}   muted ${player.muted}   started ${state.started}`,
        `readyState ${player.readyState}   networkState ${player.networkState}`,
        `current   ${player.currentTime.toFixed(1)}   duration ${Number.isFinite(player.duration) ? player.duration.toFixed(1) : player.duration}`,
        `buffered  ${buffered}`,
        `drift     ${state.drift === null ? '-' : state.drift.toFixed(1)}`,
        `error     ${player.error ? player.error.code + ' ' + (player.error.message || '') : '-'}`,
      ].join('\n');
    }, 500);
  }
}

player.addEventListener('error', () => {
  const code = player.error?.code;
  const map = {
    1: '播放被终止',
    2: '网络错误（无法连接视频源）',
    3: '解码失败（容器/编码不受支持）',
    4: '视频源不可用（可能 401/404）',
  };
  showError(`播放失败：${map[code] || '未知错误'}${code ? ` (code ${code})` : ''}${code === 3 || code === 4 ? '　→ 试试底栏「兼容模式」' : ''}`);
});

function toggleSubtitles(force) {
  state.subtitleOn = typeof force === 'boolean' ? force : !state.subtitleOn;
  localStorage.setItem('rotator.subtitles', state.subtitleOn ? '1' : '0');
  syncSubtitlePanel(state.now?.now);
  if (state.subtitleOn && state.now?.now?.subtitleUrl) loadCues(state.now.now);
  renderCue();
}

$('compatBtn')?.addEventListener('click', () => {
  state.forceCompat = !state.forceCompat;
  localStorage.setItem('rotator.compat', state.forceCompat ? '1' : '0');
  $('compatBtn').classList.toggle('on', state.forceCompat);
  state.compatJob = null;
  setStatus(state.forceCompat ? '兼容模式：MKV 转为 MP4' : '兼容模式已关闭');
  const item = state.now?.now;
  if (item) {
    if (state.forceCompat) startCompat(item);
    else {
      hideCompat();
      player.src = item.streamUrl || `/stream/${item.fileId}`;
      player.load();
    }
  }
});

$('resyncBtn').addEventListener('click', () => {
  state.justLoaded = true;
  state.userPaused = false;
  refreshNow(true).then(() => {
    const item = state.now?.now;
    if (item && Number.isFinite(player.duration)) {
      try {
        player.currentTime = targetTime(item, serverNow());
      } catch {
        /* ignore */
      }
    }
    tryPlay();
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    state.justLoaded = true;
    refreshNow(true);
  }
});

/* ------------------------------ 启动 ------------------------------ */

// 便于远程排查：控制台里可以直接看播放器状态
globalThis.__appState = state;

(async function boot() {
  try {
    state.forceCompat =
      new URLSearchParams(location.search).get('compat') === '1' ||
      localStorage.getItem('rotator.compat') === '1' ||
      IS_APPLE_MOBILE;
    if (state.forceCompat) {
      const btn = $('compatBtn');
      if (btn) btn.classList.add('on');
    }
    const ready = await loadConfig();
    if (ready === false) return;
    await refreshNow(true);
    setInterval(tick, 1000);
  } catch (err) {
    showError(`启动失败：${err.message}`);
    setStatus('启动失败，请检查后端与节目库索引');
  }
})();
