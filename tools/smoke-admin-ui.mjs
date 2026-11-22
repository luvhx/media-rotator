#!/usr/bin/env node
/**
 * 管理界面冒烟（无浏览器）
 *
 * 用最小 DOM 桩加载 public/admin.js，验证「加载状态 → 渲染概览 → 切到媒体库 → 切到编排」
 * 这条链路没有运行时错误。
 *
 *   node tools/smoke-admin-ui.mjs
 *   BASE_URL=http://host:8088 node tools/smoke-admin-ui.mjs
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8088';
const errors = [];
process.on('unhandledRejection', (e) => errors.push(`unhandledRejection: ${e?.message || e}`));
process.on('uncaughtException', (e) => errors.push(`uncaughtException: ${e?.message || e}`));

/* ------------------------------ DOM 桩 ------------------------------ */

class ClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  add(...c) {
    for (const x of c) this.set.add(x);
    this.sync();
  }
  remove(...c) {
    for (const x of c) this.set.delete(x);
    this.sync();
  }
  contains(c) {
    return this.set.has(c);
  }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : force;
    on ? this.set.add(c) : this.set.delete(c);
    this.sync();
    return on;
  }
  sync() {
    this.el.className = [...this.set].join(' ');
  }
}

function parseSelector(sel) {
  const parts = { tag: null, id: null, classes: [], attrs: [] };
  let rest = String(sel).trim();
  const attrRe = /\[([a-zA-Z-]+)="([^"]*)"\]/g;
  rest = rest.replace(attrRe, (_, k, v) => {
    parts.attrs.push([k, v]);
    return '';
  });
  const m = /^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/.exec(rest);
  if (!m) return parts;
  if (m[1]) parts.tag = m[1].toUpperCase();
  for (const tok of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (tok[0] === '.') parts.classes.push(tok.slice(1));
    else parts.id = tok.slice(1);
  }
  return parts;
}

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList(this);
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.placeholder = '';
    this.type = '';
    this.src = '';
    this.alt = '';
    this.title = '';
    this._text = '';
    this.children = [];
    this.parent = null;
    this.handlers = new Map();
    this.attrs = new Map();
  }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => (c instanceof El ? c.textContent : String(c))).join('');
  }
  set textContent(v) {
    this._text = String(v ?? '');
    this.children = [];
  }
  get innerHTML() {
    return this._html || '';
  }
  set innerHTML(v) {
    this._html = String(v ?? '');
    // 浏览器里赋空字符串会清空子节点，桩里同步一下
    if (this._html === '') this.children = [];
  }
  get className() {
    return [...this.classList.set].join(' ');
  }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  setAttribute(k, v) {
    this.attrs.set(k, v);
    if (k === 'class') this.className = v;
    if (k.startsWith('data-')) this.dataset[k.slice(5)] = v;
    if (k === 'value') this.value = v;
    if (k === 'checked') this.checked = true;
  }
  getAttribute(k) {
    return this.attrs.get(k) ?? null;
  }
  append(...nodes) {
    for (const n of nodes.flat()) {
      if (n === null || n === undefined || n === false) continue;
      if (typeof n === 'string' || typeof n === 'number') {
        const t = new El('#text');
        t.textContent = String(n);
        t.parent = this;
        this.children.push(t);
        continue;
      }
      if (!(n instanceof El)) continue;
      n.parent = this;
      this.children.push(n);
    }
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  prepend(n) {
    n.parent = this;
    this.children.unshift(n);
  }
  replaceWith(n) {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i < 0) return;
    n.parent = this.parent;
    this.parent.children[i] = n;
  }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  dispatch(type, evt = {}) {
    for (const fn of this.handlers.get(type) || []) fn({ type, target: this, ...evt });
  }
  matches(sel) {
    const p = parseSelector(sel);
    if (p.tag && this.tagName !== p.tag) return false;
    if (p.id && this.id !== p.id) return false;
    for (const c of p.classes) if (!this.classList.contains(c)) return false;
    for (const [k, v] of p.attrs) {
      const actual = k.startsWith('data-') ? this.dataset[k.slice(5)] : this.getAttribute(k);
      if (String(actual) !== v) return false;
    }
    return true;
  }
  *walk() {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
  querySelectorAll(sel) {
    return [...this.walk()].filter((n) => n.matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

const registry = new Map();
const body = new El('body');
const tabNames = ['overview', 'config', 'series', 'channels', 'preview'];
const tabs = tabNames.map((t) => {
  const b = new El('button');
  b.classList.add('tab');
  b.dataset.tab = t;
  return b;
});
const views = tabNames.map((t) => {
  const v = new El('section');
  v.classList.add('view');
  v.dataset.view = t;
  return v;
});
const html = await (await fetch(BASE + '/admin/')).text();
for (const m of html.matchAll(/id="([^"]+)"/g)) {
  const node = new El('div', m[1]);
  registry.set(m[1], node);
}
body.append(...tabs, ...views, ...[...registry.values()]);

const document = {
  body,
  documentElement: body,
  createElement: (tag) => new El(tag),
  createTextNode: (text) => {
    const n = new El('#text');
    n.textContent = text;
    return n;
  },
  getElementById: (id) => registry.get(id) || null,
  querySelector: (sel) => body.querySelector(sel),
  querySelectorAll: (sel) => body.querySelectorAll(sel),
  addEventListener: () => {},
  visibilityState: 'visible',
};

globalThis.Node = El;
globalThis.document = document;
globalThis.window = globalThis;
globalThis.location = { origin: BASE, href: BASE + '/admin/', search: '' };
globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
globalThis.IntersectionObserver = class {
  constructor(cb) {
    this.cb = cb;
  }
  observe(el) {
    setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 10);
  }
  unobserve() {}
  disconnect() {}
};
globalThis.prompt = () => 'ch-test';
globalThis.confirm = () => true;
globalThis.alert = () => {};

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url).startsWith('http') ? url : BASE + url, init);

/* ------------------------------ 运行 ------------------------------ */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

const APP_PATH = new URL('../public/admin.js', import.meta.url).href;
await import(APP_PATH).catch((e) => errors.push('import: ' + e.message));
await wait(1500);

const q = (id) => registry.get(id);
check(q('statusPill').textContent.length > 0, '顶栏状态', q('statusPill').textContent);
check(q('overviewCards').children.length >= 4, '概览卡片渲染', `${q('overviewCards').children.length} 张`);
check(q('cfg-baseUrl').value.length > 0, '配置表单已填充', q('cfg-baseUrl').value.slice(0, 40));

// 切到媒体库
tabs[2].dispatch('click');
await wait(1200);
check(q('seriesGrid').children.length > 0, '节目卡片渲染', `${q('seriesGrid').children.length} 张`);
check(q('selCount').textContent.includes('参与编排'), '选片计数显示', q('selCount').textContent);
const firstCard = q('seriesGrid').children[0];
check(Boolean(firstCard), '第一张卡片存在');
if (firstCard) {
  const before = q('selCount').textContent;
  firstCard.dispatch('click');
  await wait(50);
  check(q('selCount').textContent !== before, '点击卡片切换选中', `${before} → ${q('selCount').textContent}`);
}

// 切到编排
tabs[3].dispatch('click');
await wait(300);
check(q('channelList').children.length > 0, '频道列表渲染', `${q('channelList').children.length} 个`);
check(q('channelEditor').children.length > 0, '编排编辑器渲染', `${q('channelEditor').children.length} 个区块`);
check(q('btnAddChannel') !== null, '新建频道按钮存在');

// 编排段：摘要 + 时间网格参数区
const summary0 = q('channelEditor').querySelector('.seg-summary');
check(Boolean(summary0) && summary0.textContent.length > 5, '编排段显示摘要', summary0 ? summary0.textContent.slice(0, 30) : '(无)');

const segBox = q('channelEditor').querySelector('.seg');
const typeSel = segBox ? segBox.querySelector('select') : null;
if (typeSel) {
  typeSel.value = 'grid';
  typeSel.dispatch('change');
  await wait(300);
  const params = q('channelEditor').querySelector('.seg-params');
  check(Boolean(params), '时间网格：参数区分组显示');
  const sum = q('channelEditor').querySelector('.seg-summary');
  const text = sum ? sum.textContent : '';
  check(text.includes('每天') && text.includes('对齐'), '时间网格：摘要可读', text.slice(0, 46));

  // 分时段 + 时间网格：子规则参数区（注意桩不支持后代选择器，逐层取）
  const segBox2 = q('channelEditor').querySelector('.seg');
  const typeSel2 = segBox2 ? segBox2.querySelector('select') : null;
  if (typeSel2) {
    typeSel2.value = 'daypart';
    typeSel2.dispatch('change');
    await wait(300);
    const rows = q('channelEditor').querySelectorAll('.slot-row');
    check(rows.length > 0, '分时段：时段行渲染', rows.length + ' 行');
    const slotSel = rows[0] ? rows[0].querySelector('select') : null;
    if (slotSel) {
      slotSel.value = 'grid';
      slotSel.dispatch('change');
      await wait(300);
      const slotParams = q('channelEditor').querySelector('.slot-params');
      check(Boolean(slotParams), '分时段：子规则选时间网格后出现参数区');
      const inputs = slotParams ? slotParams.querySelectorAll('input').length + slotParams.querySelectorAll('select').length + slotParams.querySelectorAll('textarea').length : 0;
      check(inputs >= 5, '分时段：时间网格参数齐全', inputs + ' 个控件');
    }
  }
}

// 切到预览
tabs[4].dispatch('click');
await wait(1500);
check(q('previewBody').children.length > 0, '预览渲染', `${q('previewBody').children.length} 个区块`);
const table = q('previewBody').querySelector('table.epg');
check(Boolean(table) && table.querySelectorAll('tr').length > 1, '节目单表格有数据', table ? `${table.querySelectorAll('tr').length} 行` : '');

if (errors.length) {
  console.log('\n运行时错误：');
  for (const e of errors) console.log('  ✗', e);
}
console.log(errors.length === 0 && fails === 0 ? '\n管理界面冒烟通过 ✓' : `\n失败：${fails + errors.length} 项 ✗`);
process.exit(errors.length === 0 && fails === 0 ? 0 : 1);
