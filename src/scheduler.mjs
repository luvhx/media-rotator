/**
 * 编排引擎（v3.1：时间网格 + 分时段）
 * ------------------------------------------------------------------
 * 一个频道 = 若干「时段」，每个时段各自是一张按整点 / 半点对齐的网格表：
 *
 *   channel.slots[] = {
 *     from, to, label,              // 时段窗口（可跨零点，如 18:00 → 24:00）
 *     grid: { start, slotMinutes, perDay, episodes, cycleDays, loopEpisodes, pool },
 *     library: { ... }              // 该时段自己的选片条件（series/exclude/tmdb/...）
 *   }
 *
 * 排片规则：
 *   - 每集从整点 / 半点开始；占 ceil(时长 / slotMinutes) 个网格，放不下就顺延
 *   - 一个网格没用满 → 留白（播放器待机）
 *   - 节目活不过时段末尾 → 截断（电视台到点就切）
 *   - cycleDays > 0：perDay × cycleDays 是固定名额，片池超出的排队补位
 */

import { localDayIndex, dayStartMs, parseClock } from './util.mjs';

const DAY_MS = 86400000;

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

const DEFAULT_ANCHOR = '2024-01-01T00:00:00+08:00';

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function normalizeGrid(raw = {}) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const start = g.start || '20:00';
  return {
    start,
    startSec: parseClock(start),
    slotMinutes: clamp(g.slotMinutes ?? 30, 5, 180, 30),
    perDay: clamp(g.perDay ?? 3, 1, 48, 3),
    episodes: clamp(g.episodes ?? 2, 1, 48, 2),
    cycleDays: clamp(g.cycleDays ?? 7, 0, 31, 7),
    loopEpisodes: g.loopEpisodes === 'stop' ? 'stop' : 'wrap',
    pool: Array.isArray(g.pool) && g.pool.length > 0 ? g.pool.map(String) : null,
  };
}

function normalizeSlot(raw = {}, index = 0) {
  const from = String(raw.from || '00:00');
  const to = String(raw.to || '24:00');
  const fromSec = parseClock(from);
  const toSec = parseClock(to);
  let windowSec = toSec - fromSec;
  if (windowSec <= 0) windowSec += 86400;
  return {
    index,
    from,
    to,
    fromSec,
    toSec,
    windowSec,
    fullDay: windowSec >= 86400,
    label: raw.label || `时段 ${index + 1}`,
    grid: normalizeGrid(raw.grid),
    library: raw.library || {},
  };
}

/** 旧配置迁移：单网格 → 一个 00:00-24:00 的时段 */
function slotsFromLegacy(def) {
  const legacyProgram = def.program || def.rules || [];
  const seg = legacyProgram.find((s) => s?.rule?.type === 'grid');
  const rule = seg?.rule || {};
  const grid = def.grid || {
    start: rule.start || '20:00',
    slotMinutes: rule.slotMinutes || 30,
    perDay: rule.seriesPerDay || 3,
    episodes: rule.episodesPerSeries || 2,
    cycleDays: rule.cycleDays ?? 7,
    loopEpisodes: rule.loopEpisodes === 'stop' ? 'stop' : 'wrap',
    pool: Array.isArray(rule.series) ? rule.series : undefined,
  };
  return [{ from: '00:00', to: '24:00', label: '全天', grid, library: def.library || {} }];
}

export function normalizeChannel(def, tz = 'Asia/Shanghai') {
  if (!def || !def.id) throw new Error('频道定义缺少 id');
  const rawSlots = Array.isArray(def.slots) && def.slots.length > 0 ? def.slots : slotsFromLegacy(def);
  const dayStart = def.dayStart || '00:00';
  const anchorMs =
    def.anchorMs != null && Number.isFinite(Number(def.anchorMs))
      ? Number(def.anchorMs)
      : def.anchor
        ? Date.parse(def.anchor)
        : Date.parse(DEFAULT_ANCHOR);
  if (Number.isNaN(anchorMs)) throw new Error(`频道 ${def.id} 的 anchor 时间无法解析`);

  const slots = rawSlots.map((s, i) => normalizeSlot({ ...s, library: s.library || def.library || {} }, i));
  slots.forEach((s, i) => {
    if (s.label === `时段 ${i + 1}`) s.label = s.label;
  });

  return {
    id: String(def.id),
    name: def.name || def.id,
    description: def.description || '',
    dayStart,
    dayStartSec: parseClock(dayStart),
    anchorMs,
    seed: def.seed ?? def.id,
    slots,
  };
}

/* ------------------------------------------------------------------ *
 * 选片
 * ------------------------------------------------------------------ */

function resolvePool(library, filter = {}, tmdbIndex = null) {
  let list = library.series;
  if (Array.isArray(filter.series) && filter.series.length > 0) {
    const picked = [];
    for (const sel of filter.series) picked.push(...library.resolve(sel));
    list = [...new Map(picked.map((s) => [s.id, s])).values()];
  }
  if (Array.isArray(filter.exclude) && filter.exclude.length > 0) {
    const drop = new Set();
    for (const sel of filter.exclude) for (const s of library.resolve(sel)) drop.add(s.id);
    list = list.filter((s) => !drop.has(s.id));
  }
  if (filter.minEpisodes) list = list.filter((s) => s.episodes.length >= filter.minEpisodes);
  if (filter.tmdb && tmdbIndex) list = tmdbIndex.filterSeries(list, filter.tmdb);
  return list.filter((s) => s.episodes.length > 0);
}

/* ------------------------------------------------------------------ *
 * 时间轴
 * ------------------------------------------------------------------ */

export class ChannelTimeline {
  constructor({ channel, library, tz = 'Asia/Shanghai', tmdbIndex = null }) {
    this.channel = normalizeChannel(channel, tz);
    this.library = library;
    this.tz = tz;
    this.dayOffsetMs = (this.channel.dayStartSec || 0) * 1000;
    this._dayCache = new Map();
    this._pools = new Map();
    this._rosters = new Map();
    this._tmdbIndex = tmdbIndex;
  }

  get anchorMs() {
    return this.channel.anchorMs;
  }

  get anchorDay() {
    if (this._anchorDay == null) this._anchorDay = localDayIndex(this.channel.anchorMs, this.tz);
    return this._anchorDay;
  }

  dayIndexOf(ms) {
    return localDayIndex(ms - this.dayOffsetMs, this.tz);
  }

  dayStartOf(dayIndex) {
    return dayStartMs(dayIndex, this.tz) + this.dayOffsetMs;
  }

  /** 某个时段的片池（显式列表优先，否则按该时段的选片条件解析） */
  poolOf(slotIndex) {
    if (this._pools.has(slotIndex)) return this._pools.get(slotIndex);
    const slot = this.channel.slots[slotIndex];
    let list = resolvePool(this.library, slot.library || {}, this._tmdbIndex);
    const wanted = slot.grid.pool;
    if (wanted && wanted.length > 0) {
      const byId = new Map(list.map((s) => [s.id, s]));
      const picked = [];
      for (const sel of wanted) {
        for (const s of this.library.resolve(sel)) if (byId.has(s.id)) picked.push(s);
      }
      if (picked.length > 0) list = [...new Map(picked.map((s) => [s.id, s])).values()];
    }
    this._pools.set(slotIndex, list);
    return list;
  }

  #episodesOf(id) {
    return this.library.episodesOf(id) || [];
  }

  #runCycles(series, perSlotEpisodes) {
    const n = this.#episodesOf(series.id).length;
    return Math.max(1, Math.ceil(n / perSlotEpisodes));
  }

  /** 某时段的名单：第 cycle 轮每个位置由哪部、播第几轮集 */
  #rosterRow(slotIndex, cycle) {
    const target = Math.min(cycle, 5200);
    if (!this._rosters.has(slotIndex)) this._rosters.set(slotIndex, new Map());
    const cache = this._rosters.get(slotIndex);
    if (cache.has(target)) return cache.get(target);

    const slot = this.channel.slots[slotIndex];
    const g = slot.grid;
    const pool = this.poolOf(slotIndex);
    const slots = g.perDay * g.cycleDays;
    const queue = pool.slice(slots);
    let qpos = 0;
    let row = pool.slice(0, slots).map((series) => ({ series, start: 0 }));
    cache.set(0, row);

    for (let c = 1; c <= target; c++) {
      const inRoster = new Set(row.map((x) => x.series.id));
      row = row.map((seat) => {
        if (c - seat.start < this.#runCycles(seat.series, g.episodes)) return seat;
        let next = null;
        for (let guard = 0; guard < pool.length * 3; guard++) {
          if (qpos >= queue.length) qpos = 0;
          const cand = queue[qpos++];
          if (!inRoster.has(cand.id)) {
            next = cand;
            break;
          }
        }
        if (!next) return seat;
        inRoster.delete(seat.series.id);
        inRoster.add(next.id);
        return { series: next, start: c };
      });
      cache.set(c, row);
    }
    return row;
  }

  /** 某一天每个时段排了什么（含留白由 relStart 间隔体现） */
  #buildDay(dayIndex) {
    const dayStart = this.dayStartOf(dayIndex);
    const day = dayIndex - this.anchorDay;
    const entries = [];

    for (const slot of this.channel.slots) {
      const pool = this.poolOf(slot.index);
      if (pool.length === 0) continue;

      const g = slot.grid;
      const fromOffsetSec = slot.fullDay ? 0 : mod(slot.fromSec - this.channel.dayStartSec, 86400);
      const windowSec = slot.fullDay ? 86400 : slot.windowSec;
      const windowMs = windowSec * 1000;
      const slotStartAbs = dayStart + fromOffsetSec * 1000;
      const slotEndAbs = slotStartAbs + windowMs;
      // 网格开始时间按「墙上时钟」换算到播出日内偏移；落在时段外就从时段起点开始
      const startOffsetSec = mod(g.startSec - this.channel.dayStartSec, 86400);
      const rel = startOffsetSec - fromOffsetSec;
      const inSlot = rel >= 0 && rel < windowSec ? rel : 0;
      let cursor = slotStartAbs + inSlot * 1000;

      const slotsCount = g.perDay * g.cycleDays;
      const useRoster = g.cycleDays > 0 && slotsCount > 0 && pool.length > slotsCount;
      const cycleDay = useRoster ? mod(day, g.cycleDays) : 0;
      const cycleIndex = useRoster ? Math.max(0, Math.floor(day / g.cycleDays)) : 0;
      const rosterRow = useRoster ? this.#rosterRow(slot.index, cycleIndex) : null;

      for (let j = 0; j < g.perDay; j++) {
        let series;
        let occurrence;
        if (useRoster) {
          const seat = rosterRow[cycleDay * g.perDay + j];
          if (!seat) continue;
          series = seat.series;
          occurrence = cycleIndex - seat.start;
        } else {
          const idx = day * g.perDay + j;
          series = pool[mod(idx, pool.length)];
          occurrence = Math.floor(idx / pool.length);
        }
        const all = this.#episodesOf(series.id);
        if (all.length === 0) continue;

        const totalOcc = Math.max(1, Math.ceil(all.length / g.episodes));
        const airing = g.loopEpisodes === 'stop' ? Math.max(0, occurrence) : mod(occurrence, totalOcc);

        const used = new Set();
        for (let k = 0; k < g.episodes; k++) {
          let idx = airing * g.episodes + k;
          if (idx >= all.length) {
            if (g.loopEpisodes === 'stop') break;
            idx %= all.length;
          }
          if (used.has(idx)) break;
          used.add(idx);
          const ep = all[idx];
          if (cursor >= slotEndAbs) break;

          // 活不过时段末尾 → 截断
          const room = slotEndAbs - cursor;
          const dur = Math.min(ep.durationMs, room);
          entries.push({
            slotIndex: slot.index,
            episode: ep,
            relStart: cursor - dayStart,
            durationMs: dur,
            truncated: dur < ep.durationMs,
            segmentLabel: slot.label,
            seriesName: series.displayName,
          });
          cursor += dur;
          if (dur < ep.durationMs) break;

          // 对齐到下一个网格点
          const slotMs = g.slotMinutes * 60000;
          const nextSlot = Math.ceil(cursor / slotMs) * slotMs;
          cursor = nextSlot;
        }
      }
    }

    entries.sort((a, b) => a.relStart - b.relStart);
    const last = entries[entries.length - 1];
    return { dayIndex, dayStart, entries, totalMs: last ? last.relStart + last.durationMs : 0 };
  }

  dayPlan(dayIndex) {
    const hit = this._dayCache.get(dayIndex);
    if (hit) return hit;
    const plan = this.#buildDay(dayIndex);
    if (this._dayCache.size > 32) this._dayCache.delete(this._dayCache.keys().next().value);
    this._dayCache.set(dayIndex, plan);
    return plan;
  }

  #findEntry(plan, nowMs) {
    for (const e of plan.entries) {
      const abs = plan.dayStart + e.relStart;
      if (nowMs >= abs && nowMs < abs + e.durationMs) return e;
    }
    return null;
  }

  resolve(nowMs) {
    const day = this.dayIndexOf(nowMs);
    const plan = this.dayPlan(day);
    const hit = this.#findEntry(plan, nowMs);
    if (hit) return makeResolved(this, plan, hit, nowMs);

    const next = plan.entries.find((e) => plan.dayStart + e.relStart > nowMs);
    if (next) return makeOff(this, plan.dayStart + next.relStart, next);
    const nextDay = this.dayPlan(day + 1);
    const first = nextDay.entries[0];
    if (!first) return makeOff(this, null, null);
    return makeOff(this, nextDay.dayStart + first.relStart, first);
  }

  schedule(fromMs, toMs, limit = 50) {
    const out = [];
    const pushGap = (from, to) => {
      if (to <= from || out.length >= limit) return;
      out.push({ kind: 'gap', startsAt: from, endsAt: to, durationMs: to - from, truncated: false, segmentLabel: '留空', episode: null });
    };
    let day = this.dayIndexOf(fromMs);
    let guard = 0;
    let cursor = fromMs;
    while (out.length < limit && guard++ < 400) {
      const plan = this.dayPlan(day);
      for (const e of plan.entries) {
        const start = plan.dayStart + e.relStart;
        const ends = start + e.durationMs;
        if (ends <= fromMs) continue;
        if (start >= toMs) {
          pushGap(cursor, toMs);
          return out;
        }
        if (start > cursor) pushGap(cursor, start);
        if (out.length >= limit) break;
        out.push({
          startsAt: start,
          endsAt: ends,
          durationMs: e.durationMs,
          truncated: Boolean(e.truncated),
          segmentLabel: e.segmentLabel,
          episode: e.episode,
        });
        cursor = ends;
        if (ends >= toMs) return out;
      }
      day++;
      if (this.dayStartOf(day) > toMs) break;
    }
    return out;
  }

  stats() {
    const today = this.dayIndexOf(Date.now());
    const plan = this.dayPlan(today);
    return {
      mode: 'daily',
      dayEntries: plan.entries.length,
      dayDurationMs: plan.totalMs,
      slotCount: this.channel.slots.length,
      slots: this.channel.slots.map((s) => ({ label: s.label, from: s.from, to: s.to, pool: this.poolOf(s.index).length })),
      grid: this.channel.slots[0]?.grid || null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

function makeResolved(tl, plan, entry, nowMs) {
  const startsAt = plan.dayStart + entry.relStart;
  const endsAt = startsAt + entry.durationMs;
  return {
    entry,
    episode: entry.episode,
    startsAt,
    endsAt,
    durationMs: entry.durationMs,
    offsetMs: Math.max(0, Math.min(entry.durationMs, nowMs - startsAt)),
    remainingMs: Math.max(0, endsAt - nowMs),
    progress: entry.durationMs > 0 ? Math.max(0, Math.min(1, (nowMs - startsAt) / entry.durationMs)) : 0,
    truncated: Boolean(entry.truncated),
    segmentLabel: entry.segmentLabel,
    channel: tl.channel,
  };
}

function makeOff(tl, nextAt, entry) {
  return {
    off: true,
    nextAt,
    next: entry
      ? {
          startsAt: nextAt,
          endsAt: nextAt + entry.durationMs,
          durationMs: entry.durationMs,
          segmentLabel: entry.segmentLabel,
          episode: entry.episode,
        }
      : null,
    channel: tl.channel,
  };
}

export function episodeView(ep) {
  return {
    fileId: ep.fileId,
    series: ep.seriesName,
    season: ep.season,
    episode: ep.episode,
    title: ep.title || ep.name,
    name: ep.name,
    relPath: ep.relPath,
    size: ep.size,
    durationMs: ep.durationMs,
    subtitle: ep.subtitle || null,
  };
}
