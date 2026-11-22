/**
 * 编排引擎（v3：只有「时间网格」一种模式）
 * ------------------------------------------------------------------
 * 一个频道 = 一张按「整点 / 半点」对齐的节目表：
 *
 *   - 每天从 grid.start 开始，取 grid.perDay 部，每部 grid.episodes 集
 *   - 每集占用 ceil(时长 / slotMinutes) 个网格，剩余时间留空
 *   - grid.cycleDays > 0 时，每天部数 × 周期天数 = 固定名单；
 *     片池超出的影片排队，某个位置上的影片播完后由队列补位
 *   - 播出日由 channel.dayStart 决定（默认 00:00；设 06:00 就是 06:00 → 次日 06:00）
 *
 * 所有「随机」都使用确定性 PRNG，同一频道 + 同一天永远得到同一编排。
 */

import { localDayIndex, dayStartMs, parseClock } from './util.mjs';

const DAY_MS = 86400000;

/* ------------------------------------------------------------------ *
 * 频道归一化
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

/**
 * 把旧版（program + rule）配置迁移成网格参数，保证升级后频道还能播。
 * 只取第一个 grid 规则；没有就套用默认值。
 */
function gridFromLegacy(program) {
  const seg = (program || []).find((s) => s?.rule?.type === 'grid');
  const rule = seg?.rule || {};
  return {
    start: rule.start || '20:00',
    slotMinutes: rule.slotMinutes || 30,
    perDay: rule.seriesPerDay || 3,
    episodes: rule.episodesPerSeries || 2,
    cycleDays: rule.cycleDays ?? 7,
    loopEpisodes: rule.loopEpisodes === 'stop' ? 'stop' : 'wrap',
    pool: Array.isArray(rule.series) ? rule.series : undefined,
  };
}

export function normalizeChannel(def, tz = 'Asia/Shanghai') {
  if (!def || !def.id) throw new Error('频道定义缺少 id');
  const legacy = def.program || def.rules || [];
  const rawGrid = def.grid && typeof def.grid === 'object' ? def.grid : gridFromLegacy(legacy);
  const startSec = parseClock(rawGrid.start || '20:00');
  const dayStart = def.dayStart || '00:00';

  const ch = {
    id: String(def.id),
    name: def.name || def.id,
    description: def.description || '',
    dayStart,
    dayStartSec: parseClock(dayStart),
    anchorMs:
      def.anchorMs != null && Number.isFinite(Number(def.anchorMs))
        ? Number(def.anchorMs)
        : def.anchor
          ? Date.parse(def.anchor)
          : Date.parse(DEFAULT_ANCHOR),
    seed: def.seed ?? def.id,
    library: def.library || {},
    weights: def.weights || null,
    grid: {
      start: rawGrid.start || '20:00',
      startSec,
      slotMinutes: clamp(rawGrid.slotMinutes ?? 30, 5, 180, 30),
      perDay: clamp(rawGrid.perDay ?? 3, 1, 48, 3),
      episodes: clamp(rawGrid.episodes ?? 2, 1, 48, 2),
      cycleDays: clamp(rawGrid.cycleDays ?? 7, 0, 31, 7),
      loopEpisodes: rawGrid.loopEpisodes === 'stop' ? 'stop' : 'wrap',
      pool: Array.isArray(rawGrid.pool) && rawGrid.pool.length > 0 ? rawGrid.pool.map(String) : null,
    },
  };
  if (Number.isNaN(ch.anchorMs)) throw new Error(`频道 ${ch.id} 的 anchor 时间无法解析`);
  return ch;
}

/* ------------------------------------------------------------------ *
 * 选片
 * ------------------------------------------------------------------ */

function seriesOfEarly(library, channel, tmdbIndex) {
  const filter = channel.library || {};
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
    this._rosterRows = new Map(); // 按周期缓存名单
    this._pool = null;
    this._tmdbIndex = tmdbIndex;
  }

  /** 选片后的片池（懒加载） */
  get pool() {
    if (!this._pool) {
      let list = seriesOfEarly(this.library, this.channel, this._tmdbIndex);
      const wanted = this.channel.grid.pool;
      if (wanted && wanted.length > 0) {
        const byId = new Map(list.map((s) => [s.id, s]));
        const picked = [];
        for (const sel of wanted) {
          for (const s of this.library.resolve(sel)) if (byId.has(s.id)) picked.push(s);
        }
        if (picked.length > 0) list = [...new Map(picked.map((s) => [s.id, s])).values()];
      }
      this._pool = list;
    }
    return this._pool;
  }

  get anchorMs() {
    return this.channel.anchorMs;
  }

  get anchorDay() {
    if (this._anchorDay == null) this._anchorDay = localDayIndex(this.channel.anchorMs, this.tz);
    return this._anchorDay;
  }

  /** 某一时刻所属的「播出日」序号 */
  dayIndexOf(ms) {
    return localDayIndex(ms - this.dayOffsetMs, this.tz);
  }

  /** 某个播出日的起点 */
  dayStartOf(dayIndex) {
    return dayStartMs(dayIndex, this.tz) + this.dayOffsetMs;
  }

  #episodesOf(id) {
    return this.library.episodesOf(id) || [];
  }

  #runCycles(series) {
    const n = this.#episodesOf(series.id).length;
    return Math.max(1, Math.ceil(n / this.channel.grid.episodes));
  }

  /** 名单模式：第 cycle 轮每个位置由哪部、播第几轮集（总是从第 0 轮推进，保证确定性） */
  #rosterRow(cycle) {
    const target = Math.min(cycle, 5200);
    if (this._rosterRows.has(target)) return this._rosterRows.get(target);

    const g = this.channel.grid;
    const pool = this.pool;
    const slots = g.perDay * g.cycleDays;
    const queue = pool.slice(slots);
    let qpos = 0;
    let row = pool.slice(0, slots).map((series) => ({ series, start: 0 }));
    this._rosterRows.set(0, row);

    for (let c = 1; c <= target; c++) {
      const inRoster = new Set(row.map((x) => x.series.id));
      row = row.map((seat) => {
        if (c - seat.start < this.#runCycles(seat.series)) return seat;
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
      this._rosterRows.set(c, row);
    }
    return row;
  }

  /** 某一天的排片（含留白） */
  #buildDay(dayIndex) {
    const g = this.channel.grid;
    const pool = this.pool;
    const day = dayIndex - this.anchorDay;
    const slots = g.perDay * g.cycleDays;
    const useRoster = g.cycleDays > 0 && slots > 0 && pool.length > slots;

    const cycleDay = useRoster ? mod(day, g.cycleDays) : 0;
    const cycleIndex = useRoster ? Math.max(0, Math.floor(day / g.cycleDays)) : 0;
    const rosterRow = useRoster ? this.#rosterRow(cycleIndex) : null;

    const dayStart = this.dayStartOf(dayIndex);
    const gStart = g.startSec;
    const offsetSec = mod(gStart - this.channel.dayStartSec, 86400);
    const entries = [];
    let t = offsetSec * 1000; // 相对播出日起点

    for (let j = 0; j < g.perDay && pool.length > 0; j++) {
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

        entries.push({
          episode: ep,
          relStart: t,
          durationMs: ep.durationMs,
          truncated: false,
          segmentLabel: series.displayName,
        });
        t += ep.durationMs;
        // 对齐到下一个网格点，剩下的时间留白
        const absEnd = dayStart + t;
        const nextSlot = Math.ceil(absEnd / (g.slotMinutes * 60000)) * g.slotMinutes * 60000;
        t = nextSlot - dayStart;
      }
    }

    const last = entries[entries.length - 1];
    return {
      dayIndex,
      dayStart,
      entries,
      totalMs: last ? last.relStart + last.durationMs : 0,
    };
  }

  dayPlan(dayIndex) {
    const hit = this._dayCache.get(dayIndex);
    if (hit) return hit;
    const plan = this.#buildDay(dayIndex);
    if (this._dayCache.size > 32) this._dayCache.delete(this._dayCache.keys().next().value);
    this._dayCache.set(dayIndex, plan);
    return plan;
  }

  /** 定位某个时刻在播什么；留空时段返回 { off: true } */
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

  #findEntry(plan, nowMs) {
    for (const e of plan.entries) {
      const abs = plan.dayStart + e.relStart;
      if (nowMs >= abs && nowMs < abs + e.durationMs) return e;
    }
    return null;
  }

  /** 节目单：从 fromMs 起，最多 limit 条或到 toMs 为止（含留空行） */
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
      poolSeries: this.pool.length,
      poolEpisodes: this.pool.reduce((a, s) => a + s.episodes.length, 0),
      grid: this.channel.grid,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 解析结果
 * ------------------------------------------------------------------ */

function makeResolved(tl, plan, entry, nowMs) {
  const absStart = plan.dayStart + entry.relStart;
  const endsAt = absStart + entry.durationMs;
  return {
    entry,
    episode: entry.episode,
    startsAt: absStart,
    endsAt,
    durationMs: entry.durationMs,
    offsetMs: Math.max(0, Math.min(entry.durationMs, nowMs - absStart)),
    remainingMs: Math.max(0, endsAt - nowMs),
    progress: entry.durationMs > 0 ? Math.max(0, Math.min(1, (nowMs - absStart) / entry.durationMs)) : 0,
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

/** 复用已解析的剧集对象 */
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
