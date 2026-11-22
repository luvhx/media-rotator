#!/usr/bin/env node
/**
 * 编排引擎自检（v3：只有时间网格）
 *
 *   node tools/selftest.mjs
 *
 * 校验：网格对齐、留白、每集占格、名单 + 排队补位、日切点、待机定位、节目单。
 */
import { Library } from '../src/library.mjs';
import { ChannelTimeline, normalizeChannel } from '../src/scheduler.mjs';
import { localParts } from '../src/util.mjs';

const TZ = 'Asia/Shanghai';
const MIN = 60 * 1000;
const DAY = 86400000;
let failures = 0;

function check(ok, msg, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

/* ------------------------- 合成片库 ------------------------- */

const epOf = (series, n, minutes) => ({
  fileId: `${series}${n}`,
  season: 1,
  episode: n,
  title: `第 ${n} 话`,
  name: `${series} - S01E0${n}.mkv`,
  relPath: `动画/${series}/Season 1/${series} - S01E0${n}.mkv`,
  size: 1000 * n,
  lastModified: 0,
  subtitle: null,
  container: 'matroska',
  durationMs: minutes * MIN,
  durationSource: 'mkv-info',
});

function seriesOf(name, count, minutes) {
  return {
    id: `/动画/${name}`,
    dir: `动画/${name}`,
    name,
    displayName: name,
    tmdbId: null,
    episodes: Array.from({ length: count }, (_, i) => epOf(name, i + 1, minutes)),
  };
}

// A 2 集（24min）、B 6 集（24min）、C 2 集、D 2 集、E 2 集、F 2 集；G 是长集（48min）
const library = new Library({
  version: 1,
  series: [
    seriesOf('A', 2, 24),
    seriesOf('B', 6, 24),
    seriesOf('C', 2, 24),
    seriesOf('D', 2, 24),
    seriesOf('E', 2, 24),
    seriesOf('F', 2, 24),
    seriesOf('G', 2, 48),
  ],
  stats: {},
});

const ANCHOR = '2026-11-23T00:00:00+08:00'; // 周一
const at = (iso) => Date.parse(iso);

function makeTimeline(grid, extra = {}) {
  return new ChannelTimeline({
    channel: { id: 'ch', name: '频道', anchor: ANCHOR, slots: [{ from: '00:00', to: '24:00', label: '全天', grid }], ...extra },
    library,
    tz: TZ,
  });
}

function makeSlots(slots, extra = {}) {
  return new ChannelTimeline({
    channel: { id: 'ch', name: '频道', anchor: ANCHOR, slots, ...extra },
    library,
    tz: TZ,
  });
}

const dayPlan = (tl, iso) => tl.dayPlan(tl.dayIndexOf(at(iso)));
const starts = (plan) => plan.entries.map((e) => localParts(plan.dayStart + e.relStart, TZ));

/* ------------------------- 归一化 ------------------------- */

{
  const ch = normalizeChannel({ id: 'x', name: 'x', grid: { start: '20:00', perDay: 3, episodes: 2 } });
  check(ch.slots.length === 1 && ch.slots[0].grid.start === '20:00' && ch.slots[0].grid.slotMinutes === 30, '单网格迁移成一个全天时段', JSON.stringify(ch.slots[0].grid).slice(0, 80));
  check(ch.dayStart === '00:00' && ch.dayStartSec === 0, '默认日切 00:00');

  // 旧配置（program + grid 规则）自动迁移
  const legacy = normalizeChannel({
    id: 'old',
    program: [{ fill: true, rule: { type: 'grid', start: '21:00', slotMinutes: 60, seriesPerDay: 2, episodesPerSeries: 3, cycleDays: 0 } }],
  });
  const lg = legacy.slots[0].grid;
  check(lg.start === '21:00' && lg.perDay === 2 && lg.episodes === 3 && lg.cycleDays === 0, '旧 program 配置迁移', JSON.stringify(lg).slice(0, 80));

  let threw = false;
  try {
    normalizeChannel({ id: 'bad', grid: { start: '99:99' } });
  } catch {
    threw = true;
  }
  check(threw, '非法时间被拒绝');
}

/* ------------------------- 对齐与留白 ------------------------- */

{
  const tl = makeTimeline({ start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0, pool: ['A', 'B'] });
  const plan = dayPlan(tl, '2026-11-23T12:00:00+08:00');

  check(plan.entries.length === 4, '每天 2 部 × 2 集', `${plan.entries.length} 条`);

  const aligned = starts(plan).every((p) => p.minute === 0 || p.minute === 30);
  check(aligned, '每集从整点或半点开始', starts(plan).map((p) => `${p.hour}:${String(p.minute).padStart(2, '0')}`).join(' '));

  const first = plan.entries[0];
  const p0 = localParts(plan.dayStart + first.relStart, TZ);
  check(p0.hour === 20 && p0.minute === 0, '首档正好 20:00');

  // 24 分钟的集占一格，后面留空 6 分钟
  const gap = plan.entries[1].relStart - (first.relStart + first.durationMs);
  check(gap === 6 * MIN, '不足一格的时间留空', `${gap / MIN} 分钟`);

  // 长集占两格
  const tl2 = makeTimeline({ start: '20:00', slotMinutes: 30, perDay: 1, episodes: 2, cycleDays: 0, pool: ['G'] });
  const plan2 = dayPlan(tl2, '2026-11-23T12:00:00+08:00');
  const secondStart = plan2.entries[1].relStart;
  const secondP = localParts(plan2.dayStart + secondStart, TZ);
  check(secondP.hour === 21 && secondP.minute === 0, '长集占两格后顺延到 21:00', `${secondP.hour}:${String(secondP.minute).padStart(2, '0')}`);
}

/* ------------------------- 名单 + 排队 ------------------------- */

{
  // 名单 = 2 部/天 × 2 天 = 4 个位置：A B C D，排队 E F
  const tl = makeTimeline({ start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 2, pool: ['A', 'B', 'C', 'D', 'E', 'F'] });
  const names = (iso) => dayPlan(tl, iso).entries.map((e) => e.episode.seriesName + 'E' + e.episode.episode);

  check(names('2026-11-23T12:00:00+08:00').join(',') === 'AE1,AE2,BE1,BE2', '第 1 天用名单前 2 部', names('2026-11-23T12:00:00+08:00').join(','));
  check(names('2026-11-24T12:00:00+08:00').join(',') === 'CE1,CE2,DE1,DE2', '第 2 天用名单后 2 部', names('2026-11-24T12:00:00+08:00').join(','));
  check(names('2026-11-25T12:00:00+08:00').join(',') === 'EE1,EE2,BE3,BE4', 'A 播完被排队 E 顶替，B 继续第 3、4 集', names('2026-11-25T12:00:00+08:00').join(','));
  check(names('2026-11-27T12:00:00+08:00').includes('BE5'), '长片按周继续', names('2026-11-27T12:00:00+08:00').join(','));
}

/* ------------------------- 不设周期 ------------------------- */

{
  const tl = makeTimeline({ start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0, pool: ['A', 'B', 'C', 'D'] });
  const names = (iso) => dayPlan(tl, iso).entries.map((e) => e.episode.seriesName + 'E' + e.episode.episode);
  check(names('2026-11-23T12:00:00+08:00').join(',') === 'AE1,AE2,BE1,BE2', '不设周期：第 1 天 A/B');
  check(names('2026-11-24T12:00:00+08:00').join(',') === 'CE1,CE2,DE1,DE2', '不设周期：第 2 天 C/D');
  // A 只有 2 集，回头时已播完 → 从头循环；B 有 6 集 → 继续第 5、6 集
  check(names('2026-11-27T12:00:00+08:00').join(',') === 'AE1,AE2,BE5,BE6', '不设周期：走完池子回头，集数各自推进', names('2026-11-27T12:00:00+08:00').join(','));
}

/* ------------------------- 日切点 ------------------------- */

{
  const tl = makeTimeline({ start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0, pool: ['A', 'B'] }, { dayStart: '06:00' });
  const plan = dayPlan(tl, '2026-11-24T03:00:00+08:00');
  const p = localParts(plan.dayStart, TZ);
  check(p.hour === 6 && p.minute === 0, '日切 06:00：03:00 属于前一播出日', `${p.hour}:${String(p.minute).padStart(2, '0')}`);
}

/* ------------------------- 定位与待机 ------------------------- */

{
  const tl = makeTimeline({ start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0, pool: ['A', 'B'] });

  const r = tl.resolve(at('2026-11-23T20:05:00+08:00'));
  check(!r.off && r.episode && r.startsAt === at('2026-11-23T20:00:00+08:00'), '节目内定位', r.episode?.seriesName);
  check(Math.abs(r.offsetMs - 5 * MIN) < 1000, '进度偏移正确', `${Math.round(r.offsetMs / 1000)}s`);

  const off = tl.resolve(at('2026-11-23T23:40:00+08:00'));
  check(off.off === true, '留空返回待机');
  check(off.nextAt === at('2026-11-24T20:00:00+08:00'), '待机时给出下一档', off.nextAt ? new Date(off.nextAt).toISOString() : 'null');
}

/* ------------------------- 节目单 ------------------------- */

{
  const tl = makeTimeline({ start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0, pool: ['A', 'B'] });
  const from = at('2026-11-23T19:00:00+08:00');
  const to = at('2026-11-24T01:00:00+08:00');
  const items = tl.schedule(from, to, 100);
  check(items.some((i) => i.kind === 'gap'), '节目单包含留空行');
  check(items.every((i) => i.startsAt >= from && i.endsAt <= to), '节目单不越界');
  const eps = items.filter((i) => i.kind !== 'gap');
  check(eps.length === 4, '节目单节目数正确', `${eps.length} 条`);
  check(items.every((i, idx) => idx === 0 || i.startsAt >= items[idx - 1].endsAt), '节目单时间单调递增');

  const stats = tl.stats();
  check(stats.mode === 'daily' && stats.slotCount === 1 && stats.slots[0].pool === 2, 'stats 可用', JSON.stringify(stats.slots));
}


/* ------------------------- 分时段 ------------------------- */

{
  // 两个时段：白天 2 部，黄金档 2 部；每个时段自己的片池
  const tl = makeSlots([
    { from: '00:00', to: '12:00', label: '白天', grid: { start: '08:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0, pool: ['A', 'B'] } },
    { from: '18:00', to: '24:00', label: '黄金档', grid: { start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0, pool: ['C', 'D'] } },
  ]);
  const plan = dayPlan(tl, '2026-11-23T12:00:00+08:00');
  const labels = plan.entries.map((e) => e.segmentLabel);
  check(labels.includes('白天') && labels.includes('黄金档'), '分时段：两个时段都参与', labels.join(','));

  const day = plan.entries.filter((e) => e.segmentLabel === '白天');
  const gold = plan.entries.filter((e) => e.segmentLabel === '黄金档');
  check(day.length === 4 && gold.length === 4, '分时段：每段各 2 部 × 2 集', `${day.length}/${gold.length}`);

  const daySeries = new Set(day.map((e) => e.episode.seriesName));
  const goldSeries = new Set(gold.map((e) => e.episode.seriesName));
  check([...daySeries].every((x) => ['A', 'B'].includes(x)), '分时段：白天用自己的片池', [...daySeries].join(','));
  check([...goldSeries].every((x) => ['C', 'D'].includes(x)), '分时段：黄金档用自己的片池', [...goldSeries].join(','));

  const p = localParts(plan.dayStart + gold[0].relStart, TZ);
  check(p.hour === 20 && p.minute === 0, '分时段：黄金档 20:00 开始', `${p.hour}:${String(p.minute).padStart(2, '0')}`);

  // 时段末尾截断：跨到 24:00 的不允许
  const last = plan.entries[plan.entries.length - 1];
  check(plan.dayStart + last.relStart + last.durationMs <= plan.dayStart + 86400000, '分时段：不越过当天末尾');
}

{
  // 时段筛选条件：pool 为空时用 library 过滤
  const pooled = new ChannelTimeline({
    channel: { id: 'f', name: 'f', anchor: ANCHOR, slots: [
      { from: '00:00', to: '24:00', label: '全部', grid: { start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0 }, library: { series: ['A', 'C'] } },
    ] },
    library,
    tz: TZ,
  });
  const names = new Set(dayPlan(pooled, '2026-11-23T12:00:00+08:00').entries.map((e) => e.episode.seriesName));
  check([...names].every((x) => ['A', 'C'].includes(x)) && names.size === 2, '时段筛选条件生效', [...names].join(','));
}

/* ------------------------- 时段内的剧集列表 ------------------------- */

{
  const tl = makeSlots([
    { from: '00:00', to: '24:00', label: '全部', grid: { start: '20:00', slotMinutes: 30, perDay: 2, episodes: 2, cycleDays: 0, pool: ['B', 'E'] } },
  ]);
  check(tl.poolOf(0).map((s) => s.displayName).join(',') === 'B,E', '编排剧集列表按给定顺序', tl.poolOf(0).map((s) => s.displayName).join(','));
}

console.log(failures === 0 ? '\n自检全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures ? 1 : 0);
