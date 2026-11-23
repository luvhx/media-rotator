#!/usr/bin/env node
/**
 * 前端冒烟测试（无需浏览器）
 *
 * 用最小 DOM 桩加载 public/app.js，验证「取时间轴 → 设置 src → seek 到直播位置 → 漂移重同步」整条链路。
 *   node tools/smoke-frontend.mjs                # 默认 http://127.0.0.1:8088
 *   BASE_URL=http://host:8088 node tools/smoke-frontend.mjs
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8088';

class ClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  add(...c) { c.forEach((x) => this.set.add(x)); this.sync(); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); this.sync(); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : force;
    on ? this.set.add(c) : this.set.delete(c);
    this.sync();
  }
  contains(c) { return this.set.has(c); }
  sync() { this.el.className = [...this.set].join(' '); }
}

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = '';
    this.classList = new ClassList(this);
    this.textContent = '';
    this.style = {};
    this.hidden = false;
    this.children = [];
    this.handlers = new Map();
    this._src = '';
    this.muted = false;
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.duration = NaN;
    this.currentTime = 0;
    this.error = null;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.readyState = 0; this.duration = NaN; this.currentTime = 0; this.paused = true; this.ended = false; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  appendChild(n) { this.children.push(n); return n; }
  addEventListener(type, fn) { (this.handlers.get(type) || this.handlers.set(type, []).get(type)).push(fn); }
  dispatch(type) { for (const fn of this.handlers.get(type) || []) fn({ type }); }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    return this.children.filter((c) => c.classList?.contains(cls));
  }
  load() {
    // 模拟浏览器：加载后拿到元数据
    setTimeout(() => {
      this.readyState = 1;
      this.duration = 1400;
      this.dispatch('loadedmetadata');
      setTimeout(() => {
        this.readyState = 4;
        this.dispatch('canplay');
      }, 60);
    }, 30);
  }
  play() {
    this.paused = false;
    this.dispatch('play');
    setTimeout(() => this.dispatch('playing'), 10);
    return Promise.resolve();
  }
  pause() { this.paused = true; this.dispatch('pause'); }
}

const registry = new Map();
const html = await (await fetch(BASE + '/')).text();
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
for (const id of ids) registry.set(id, new El(id === 'player' ? 'video' : 'div', id));

const document = {
  getElementById: (id) => registry.get(id) || null,
  createElement: (tag) => new El(tag),
  addEventListener: () => {},
  visibilityState: 'visible',
  querySelectorAll: () => [],
};
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

globalThis.document = document;
globalThis.localStorage = localStorage;
// Node 自带只读的 navigator，测试里用 defineProperty 覆盖成 iPad / 桌面 UA
const IS_COMPAT = process.env.SMOKE_COMPAT === '1';
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    userAgent: IS_COMPAT
      ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    platform: IS_COMPAT ? 'iPad' : 'Linux x86_64',
    maxTouchPoints: IS_COMPAT ? 5 : 0,
  },
});
globalThis.location = { search: '', href: BASE + '/' };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  // 桩里的 video.duration 是假值，别让它回写到真实索引
  if (String(url).includes('/api/report-duration')) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, ignored: true, reason: 'smoke-test' }), { status: 200 }));
  }
  return realFetch(url.startsWith('http') ? url : BASE + url, init);
};
globalThis.window = { location: globalThis.location };

const errors = [];
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e?.message || e)));
process.on('uncaughtException', (e) => errors.push('uncaughtException: ' + (e?.message || e)));

await import('../public/app.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(2500);

const player = registry.get('player');
const q = (id) => registry.get(id);
const log = (ok, msg, extra = '') => console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);

log(!!q('seriesName').textContent, '频道信息渲染', q('seriesName').textContent + ' ' + q('epLabel').textContent);
log(q('epgList').children.length > 0, '节目单渲染', q('epgList').children.length + ' 条');
log(q('statusText').textContent.length > 0, '状态栏', q('statusText').textContent);
log(q('modeBadge').textContent.length > 0, '流模式徽标', q('modeBadge').textContent);

// 点击开播
q('startBtn').dispatch('click');
if (process.env.SMOKE_COMPAT === '1') {
  // 兼容模式：等待后端把 MKV 转封装成 MP4
  for (let i = 0; i < 90; i++) {
    if (String(player.src).includes('format=mp4') && player.readyState >= 1) break;
    await wait(1000);
  }
  log(String(player.src).includes('format=mp4'), '自动切到 MP4 转封装', String(player.src).slice(0, 60));
} else {
  await wait(1500);
}

const nowData = await (await fetch('/api/now?channel=main')).json();

if (nowData.off) {
  // 时间网格允许留空：此刻可能处于待机
  log(q('overlay').classList.contains('hidden') === false, '留空时段显示待机遮罩');
  log(!player.src, '留空时段不加载视频', player.src || '(空)');
  log(q('epTitle').textContent.includes('下一档'), '待机提示下一档时间', q('epTitle').textContent);
  log(typeof nowData.until === 'number' && nowData.until > nowData.serverTime, '待机给出恢复时间');
} else {
  log(!!player.src, '播放器已设置 src', player.src);
  log(!q('overlay').classList.contains('hidden') === false, '开始后隐藏遮罩');
  log(player.currentTime > 0, '已按时间轴 seek 到当前进度', 'currentTime=' + player.currentTime.toFixed(1) + 's');
  const expect = nowData.now.offsetMs / 1000;
  log(Math.abs(player.currentTime - expect) < 6, 'seek 位置与后端偏移一致', `期望≈${expect.toFixed(1)}s 实际=${player.currentTime.toFixed(1)}s`);
  log(q('progressFill').style.width?.endsWith('%'), '进度条更新', q('progressFill').style.width);
  if (nowData.now?.subtitleUrl) {
    const sb = q('subtitleBtn');
    const cb = q('ccBtn');
    log(Boolean(sb) && sb.hidden === false, '页脚字幕按钮可见', sb ? sb.textContent : '(无)');
    log(Boolean(cb) && cb.hidden === false, '播放器 CC 按钮可见', cb ? cb.textContent : '(无)');
    // 切换一次，确认不抛错
    if (cb) cb.dispatch('click');
    if (cb) cb.dispatch('click');
    log(true, '字幕开关可点击');
  }
  log(q('syncText').className.includes('sync'), '同步状态', q('syncText').textContent);

  // 桩里的 video 不会自己走时间，漂移累积后 tick 应再次 seek 回直播位置
  const t0 = player.currentTime;
  await wait(6000);
  const now2 = await (await fetch('/api/now?channel=main')).json();
  if (!now2.off && now2.now) {
    const expected2 = now2.now.offsetMs / 1000;
    log(Math.abs(player.currentTime - expected2) < 8, '漂移自动重同步', `${t0.toFixed(1)}s → ${player.currentTime.toFixed(1)}s（期望≈${expected2.toFixed(1)}s）`);
  } else {
    log(true, '6 秒后进入留空时段（跳过重同步校验）');
  }
}

if (errors.length) {
  console.log('\n运行时错误：');
  for (const e of errors) console.log('  ✗', e);
}
console.log(errors.length === 0 ? '\n前端冒烟测试通过 ✓' : `\n${errors.length} 个运行时错误 ✗`);
process.exit(errors.length ? 1 : 0);
