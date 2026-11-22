/**
 * 编排引擎
 * ------------------------------------------------------------------
 * 概念：
 *   channel   一个频道（一条播出时间轴）
 *   program   编排规则列表，每段 (segment) 用一条规则生成一段节目
 *   entry     时间轴上的一个节目项（= 一个视频文件 + 时长 + 绝对起止时间）
 *
 * 时间轴有两种模式：
 *   loop   固定循环：从 anchor 起把 program 展开成一个「循环」，之后无限重复。
 *          位置 = (now - anchor) mod cycleLen，O(1) 定位，与时刻无关。
 *   daily  按自然日编排：每天 00:00 重新开始，program 填满 24 小时，跨零点节目被截断。
 *          适合「黄金档 / 深夜档」这类与墙上时钟绑定的规则。
 *
 * 所有「随机」都使用确定性 PRNG：同一频道 + 同一天/同一循环永远得到同一编排。
 */

import {
  rng,
  hash32,
  shuffleInPlace,
  localDayIndex,
  dayStartMs,
  localParts,
  parseClock,
  fmtDuration,
} from './util.mjs';

const DAY_MS = 86400000;
const DEFAULT_SEGMENT_COUNT = 12;

/* ------------------------------------------------------------------ *
 * 规则工厂
 * ------------------------------------------------------------------ */

function seriesOfEarly(library, channel, tmdbIndex = null) {
  const filter = channel.library || {};
  let list = library.series.slice();
  if (Array.isArray(filter.series) && filter.series.length > 0) {
    const picked = [];
    for (const sel of filter.series) picked.push(...library.resolve(sel));
    const uniq = new Map(picked.map((s) => [s.id, s]));
    list = [...uniq.values()];
  }
  if (Array.isArray(filter.exclude) && filter.exclude.length > 0) {
    const drop = new Set();
    for (const sel of filter.exclude) for (const s of library.resolve(sel)) drop.add(s.id);
    list = list.filter((s) => !drop.has(s.id));
  }
  if (filter.minEpisodes) list = list.filter((s) => s.episodes.length >= filter.minEpisodes);
  // 按 TMDB 元数据选片（年份/评分/类型）
  if (filter.tmdb && tmdbIndex) list = tmdbIndex.filterSeries(list, filter.tmdb);
  list = list.filter((s) => s.episodes.length > 0);
  return list;
}

function selectSeries(rule, ctx) {
  const base = ctx.series;
  if (!rule.series) return base.slice();
  const wanted = Array.isArray(rule.series) ? rule.series : [rule.series];
  const out = [];
  for (const sel of wanted) {
    const hits = ctx.library.resolve(sel);
    for (const s of hits) if (base.some((b) => b.id === s.id)) out.push(s);
  }
  return out;
}

function weightOf(ctx, series) {
  const w = ctx.channel.weights;
  if (!w) return 1;
  const v = w[series.displayName] ?? w[series.name] ?? w[series.id];
  return typeof v === 'number' && v > 0 ? v : 1;
}

/** 顺序：每部播完再下一部（binge 的行为）；order=shuffle 时先打散系列 */
function makeSequential(rule, ctx) {
  const order = rule.order || 'config';
  let list = selectSeries(rule, ctx);
  if (order === 'shuffle') list = shuffleInPlace(list.slice(), rng(hash32(ctx.seedPrefix + ':series')));
  if (order === 'name') list = list.slice().sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'));
  if (rule.shuffleEpisodes) {
    let si = 0;
    let cur = null;
    let curIdx = 0;
    return {
      endless: false,
      next() {
        while (si < list.length) {
          if (!cur) {
            cur = shuffleInPlace(
              ctx.library.episodesOf(list[si].id).slice(),
              rng(hash32(`${ctx.seedPrefix}:ep:${list[si].id}`)),
            );
            curIdx = 0;
            si++;
          }
          if (curIdx < cur.length) return cur[curIdx++];
          cur = null;
        }
        return null;
      },
    };
  }
  let si = 0;
  let ei = 0;
  return {
    endless: false,
    next() {
      while (si < list.length) {
        const eps = ctx.library.episodesOf(list[si].id);
        if (ei < eps.length) return eps[ei++];
        si++;
        ei = 0;
      }
      return null;
    },
  };
}

/** 轮播：每个系列轮流各出一集（A 第1集 → B 第1集 → C 第1集 → A 第2集 …） */
function makeInterleave(rule, ctx) {
  const list = selectSeries(rule, ctx);
  let round = 0;
  let pos = 0;
  return {
    endless: false,
    next() {
      if (list.length === 0) return null;
      let guard = 0;
      while (guard++ <= list.length + 1) {
        if (pos >= list.length) {
          pos = 0;
          round++;
        }
        const eps = ctx.library.episodesOf(list[pos].id);
        if (round >= eps.length) {
          // 该系列本季已播完，看这一轮还有没有别的系列可播
          const anyLeft = list.some((s) => ctx.library.episodesOf(s.id).length > round);
          if (!anyLeft) return null;
          pos++;
          continue;
        }
        const ep = eps[round];
        pos++;
        return ep;
      }
      return null;
    },
  };
}

/** 随机：整库（或指定系列）全集打散，播完一轮即结束（由编排引擎决定是否重来） */
function makeShuffle(rule, ctx) {
  const pool = selectSeries(rule, ctx).flatMap((s) => ctx.library.episodesOf(s.id));
  const random = rng(hash32(`${ctx.seedPrefix}:shuffle`));
  const deck = shuffleInPlace(pool.slice(), random);
  let cursor = 0;
  return {
    endless: false,
    next() {
      if (pool.length === 0) return null;
      if (cursor >= deck.length) return null;
      return deck[cursor++];
    },
  };
}

/** 加权随机：系列权重 × 集，可无限抽取 */
function makeWeighted(rule, ctx) {
  const list = selectSeries(rule, ctx);
  const weights = list.map((s) => weightOf(ctx, s));
  const total = weights.reduce((a, b) => a + b, 0);
  const random = rng(hash32(`${ctx.seedPrefix}:weighted`));
  const pickSeries = () => {
    let x = random() * total;
    for (let i = 0; i < list.length; i++) {
      x -= weights[i];
      if (x <= 0) return list[i];
    }
    return list[list.length - 1];
  };
  return {
    endless: true,
    next() {
      if (list.length === 0) return null;
      const s = pickSeries();
      const eps = ctx.library.episodesOf(s.id);
      if (eps.length === 0) return null;
      return eps[Math.floor(random() * eps.length)];
    },
  };
}

/** 日切：每天（本地日）换一部系列，集序当天随机 */
function makeDaily(rule, ctx) {
  const list = selectSeries(rule, ctx);
  const random = rng(hash32(`${ctx.seedPrefix}:daily`));
  let curDay = -1;
  let deck = [];
  let idx = 0;
  return {
    endless: true,
    next(cursorMs) {
      if (list.length === 0) return null;
      const day = localDayIndex(cursorMs, ctx.tz);
      if (day !== curDay) {
        curDay = day;
        const dayRng = rng(hash32(`${ctx.seedPrefix}:day:${day}`));
        const series = list[Math.floor(dayRng() * list.length)];
        deck = shuffleInPlace(ctx.library.episodesOf(series.id).slice(), dayRng);
        idx = 0;
      }
      if (deck.length === 0) return null;
      if (idx >= deck.length) deck = shuffleInPlace(deck.slice(), random), (idx = 0);
      return deck[idx++];
    },
  };
}

/** 时段：按「当前节目起始时刻」的墙上时间选择子规则 */
function makeDaypart(rule, ctx) {
  const slots = (rule.slots || [])
    .map((s) => ({ ...s, fromSec: parseClock(s.from), toSec: parseClock(s.to) }))
    .sort((a, b) => a.fromSec - b.fromSec);
  if (slots.length === 0) throw new Error('daypart 规则需要至少一个 slots 项');
  const engines = new Map();
  const engineFor = (i) => {
    if (!engines.has(i)) {
      engines.set(
        i,
        makeRule(slots[i].rule || { type: 'sequential' }, {
          ...ctx,
          seedPrefix: `${ctx.seedPrefix}:slot${i}`,
          slot: { fromSec: slots[i].fromSec, toSec: slots[i].toSec, index: i },
        }),
      );
    }
    return engines.get(i);
  };
  const secOf = (ms) => {
    const p = localParts(ms, ctx.tz);
    return p.hour * 3600 + p.minute * 60 + p.second;
  };

  /** 当前时刻落在哪个时段；落在时段之间的空档返回 -1 */
  const pickSlot = (cursorMs) => {
    const sec = secOf(cursorMs);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.fromSec <= s.toSec) {
        if (sec >= s.fromSec && sec < s.toSec) return i;
      } else if (sec >= s.fromSec || sec < s.toSec) return i;
    }
    return -1;
  };

  /** 距离下一个时段开始还有多久（空档里跳过） */
  const msToNextSlot = (cursorMs) => {
    const sec = secOf(cursorMs);
    let best = 86400;
    for (const s of slots) {
      let d = s.fromSec - sec;
      if (d <= 0) d += 86400;
      if (d < best) best = d;
    }
    return best * 1000;
  };
  /** 距离当前时段结束还有多久 */
  const msToSlotEnd = (cursorMs, slot) => {
    const p = localParts(cursorMs, ctx.tz);
    const sec = p.hour * 3600 + p.minute * 60 + p.second;
    let delta = slot.toSec - sec;
    if (delta <= 0) delta += 86400;
    return delta * 1000;
  };

  return {
    endless: true,
    next(cursorMs) {
      const i = pickSlot(cursorMs);
      if (i < 0) {
        // 时段之间的空档：留空到下一个时段开始
        const gap = msToNextSlot(cursorMs);
        return gap > 0 ? { gapMs: gap } : null;
      }
      const ep = engineFor(i).next(cursorMs);
      if (!ep) {
        // 该时段的规则播完了：留空到时段结束，让下一个时段接手
        const gap = msToSlotEnd(cursorMs, slots[i]);
        return gap > 0 ? { gapMs: gap } : null;
      }
      // 节目活不过时段末尾：截断（电视台到点就切）
      if (typeof ep.durationMs === 'number' && !ep.gapMs) {
        const left = msToSlotEnd(cursorMs, slots[i]);
        if (left > 0 && ep.durationMs > left) {
          const cut = { ...ep, durationMs: left, __truncated: true };
          if (slots[i].label) cut.__segmentLabel = slots[i].label;
          return cut;
        }
      }
      if (slots[i].label) return { ...ep, __segmentLabel: slots[i].label };
      return ep;
    },
  };
}

/** 手动：显式节目单 */
function makeManual(rule, ctx) {
  const items = (rule.items || []).map((it) => {
    if (it.fileId) return ctx.library.getEpisode(it.fileId);
    if (it.episode) {
      const series = ctx.library.resolve(it.series)[0];
      if (!series) return null;
      return ctx.library.episodesOf(series.id).find((e) => e.season === (it.season || 1) && e.episode === it.episode) || null;
    }
    return null;
  });
  const list = items.filter(Boolean);
  let i = 0;
  return {
    endless: false,
    next() {
      if (i >= list.length) return null;
      return list[i++];
    },
  };
}

/**
 * 时间网格（grid）
 * ------------------------------------------------------------------
 * 按「整点 / 半点」对齐排片，节目之间留空。
 *
 *   { "type": "grid", "start": "20:00", "slotMinutes": 30,
 *     "seriesPerDay": 3, "episodesPerSeries": 2 }
 *
 * 规则：
 *   - 每天从 start 开始，取 seriesPerDay 部（按天轮换片池），每部 episodesPerSeries 集
 *   - 每集占用 ceil(时长 / slotMinutes) 个网格；多余的时间留空
 *   - 下一集从下一个网格点开始（时长不足一个网格也不会提前开始）
 *   - 片池按 seriesPerDay 步长逐日推进：池子 6 部、每天 3 部 → 周一 A/B/C、周二 D/E/F、周三 A/B/C…
 */
function makeGrid(rule, ctx) {
  const slotMs = Math.max(5, Math.min(180, Number(rule.slotMinutes) || 30)) * 60000;
  const startSec = parseClock(rule.start || '20:00');
  const perDay = Math.max(1, Math.min(24, Number(rule.seriesPerDay) || 3));
  const perSeries = Math.max(1, Math.min(48, Number(rule.episodesPerSeries) || 2));
  const pool = selectSeries(rule, ctx);
  if (pool.length === 0) throw new Error('grid 规则：片池为空，请检查 series 或频道的选片条件');

  const dayStartSec = Number(ctx.dayStartSec) || 0;
  // start 按「墙上时钟」解释，换算成相对播出日起点的偏移
  let offsetSec = (((startSec - dayStartSec) % 86400) + 86400) % 86400;
  // 计划内游标：独立使用时相对播出日，嵌在「分时段」时相对时段起点
  let t = offsetSec * 1000;
  let windowMs = null;
  if (ctx.slot) {
    let win = ctx.slot.toSec - ctx.slot.fromSec;
    if (win <= 0) win += 86400;
    windowMs = win * 1000;
    const rel = (((startSec - ctx.slot.fromSec) % 86400) + 86400) % 86400;
    const inSlot = rel < win ? rel : 0; // start 不在时段内就从时段起点开始
    offsetSec = (((ctx.slot.fromSec - dayStartSec + inSlot) % 86400) + 86400) % 86400;
    t = inSlot * 1000;
  }
  // 轮换以频道锚点当天为第 0 天，保证锚点当天从片池第一部、第一集开始
  const anchorDay = localDayIndex(Number(ctx.channel.anchorMs) || 0, ctx.tz);
  const day = (Number(ctx.dayIndex) || 0) - anchorDay;
  const dayStartMs = Number(ctx.dayStartMs) || 0;

  const plan = [];
  const targetStartAbs = dayStartMs + offsetSec * 1000; // 首档的绝对开始时间
  let firstPull = true;

  // 循环周期（天）：片池大于「每天部数 × 周期天数」时启用
  //   固定名单 = 每天部数 × 周期天数 个位置；多出来的影片排队
  //   某个位置上的影片播完最后一集后，队列里的下一部补上，从第 1 集开始
  const cycleDays = Math.max(0, Math.min(31, Number(rule.cycleDays) || 0));
  const slots = perDay * cycleDays;
  const useRoster = cycleDays > 0 && slots > 0 && pool.length > slots;

  const episodesOfCache = new Map();
  const epsOf = (id) => {
    if (!episodesOfCache.has(id)) episodesOfCache.set(id, ctx.library.episodesOf(id) || []);
    return episodesOfCache.get(id);
  };
  const runCycles = (series) => Math.max(1, Math.ceil(epsOf(series.id).length / perSeries));

  let roster = null;
  if (useRoster) {
    const cache = ctx.gridCache.get(ctx.cacheKey) || { rows: [], queue: pool.slice(slots), qpos: 0 };
    ctx.gridCache.set(ctx.cacheKey, cache);

    const dequeue = (inRoster) => {
      let guard = 0;
      while (guard++ < pool.length * 3) {
        if (cache.qpos >= cache.queue.length) {
          cache.queue = pool.slice(); // 队列用完，从片池重新排一轮
          cache.qpos = 0;
        }
        const s = cache.queue[cache.qpos++];
        if (!inRoster.has(s.id)) return s;
      }
      return null;
    };

    roster = (c) => {
      while (cache.rows.length <= c) {
        const cur = cache.rows.length;
        if (cur === 0) {
          cache.rows.push(pool.slice(0, slots).map((series) => ({ series, start: 0, airing: 0 })));
          continue;
        }
        const prev = cache.rows[cur - 1];
        const inRoster = new Set(prev.map((x) => x.series.id));
        const row = prev.map((seat) => {
          if (cur - seat.start < runCycles(seat.series)) return { ...seat, airing: cur - seat.start };
          const next = dequeue(inRoster);
          if (!next) return { ...seat, airing: cur - seat.start };
          inRoster.delete(seat.series.id);
          inRoster.add(next.id);
          return { series: next, start: cur, airing: 0 };
        });
        cache.rows.push(row);
      }
      return cache.rows[c];
    };
  }

  const cycleDay = useRoster ? ((day % cycleDays) + cycleDays) % cycleDays : 0;
  const cycleIndex = useRoster ? Math.floor(day / cycleDays) : 0;

  for (let j = 0; j < perDay; j++) {
    let series;
    let occurrence;
    if (useRoster) {
      const seat = roster(Math.max(0, cycleIndex))[cycleDay * perDay + j];
      series = seat.series;
      occurrence = seat.airing;
    } else {
      const slotIdx = ((day * perDay + j) % pool.length + pool.length) % pool.length;
      series = pool[slotIdx];
      occurrence = Math.floor((day * perDay + j) / pool.length);
    }
    const all = epsOf(series.id);
    if (!all || all.length === 0) continue;

    // 锚点之前的日期 occurrence 会是负数：按周期折算回来，避免取到 undefined
    const totalOccurrences = Math.max(1, Math.ceil(all.length / perSeries));
    const cycle = rule.loopEpisodes === 'stop' ? Math.max(0, occurrence) : ((occurrence % totalOccurrences) + totalOccurrences) % totalOccurrences;

    const picked = [];
    const usedThisRun = new Set();
    for (let k = 0; k < perSeries; k++) {
      let idx = cycle * perSeries + k;
      if (idx < 0) continue;
      if (idx >= all.length) {
        if (rule.loopEpisodes === 'stop') break;
        idx %= all.length;
      }
      // 同一档里不重复播同一集（集数不够 perSeries 时，跳过剩余的格）
      if (usedThisRun.has(idx)) break;
      usedThisRun.add(idx);
      picked.push(all[idx]);
    }

    for (const ep of picked) {
      if (windowMs !== null && t + ep.durationMs > windowMs) break; // 放不下就留空到时段结束
      plan.push({ ep });
      const endMs = dayStartMs + t + ep.durationMs;
      // 向上对齐到网格端点（epoch 对齐，整点/半点在时区里同样成立）
      const slotEnd = Math.ceil(endMs / slotMs) * slotMs;
      const gap = Math.max(0, slotEnd - endMs);
      t += ep.durationMs;
      if (gap > 0) {
        plan.push({ gapMs: gap });
        t += gap;
      }
    }
  }

  let i = 0;
  return {
    endless: false,
    noRestart: true, // 日计划：播完就留白，不要重来
    next(cursorMs) {
      // 首档对齐到绝对时刻（20:00 就是 20:00，不受前一个时段结束时刻影响）
      if (firstPull) {
        firstPull = false;
        const gap = targetStartAbs - (Number(cursorMs) || targetStartAbs);
        if (gap > 1000) return { gapMs: gap };
      }
      while (i < plan.length) {
        const item = plan[i++];
        if (item.gapMs) return { gapMs: item.gapMs };
        return item.ep;
      }
      return null;
    },
  };
}

const RULE_FACTORIES = {
  sequential: makeSequential,
  binge: makeSequential,
  interleave: makeInterleave,
  shuffle: makeShuffle,
  weighted: makeWeighted,
  daily: makeDaily,
  daypart: makeDaypart,
  manual: makeManual,
  grid: makeGrid,
};

export const RULE_TYPES = Object.keys(RULE_FACTORIES);

function makeRule(rule, ctx) {
  const type = rule?.type || 'sequential';
  const factory = RULE_FACTORIES[type];
  if (!factory) throw new Error(`未知的编排规则类型："${type}"（可用：${RULE_TYPES.join(', ')}）`);
  return factory({ ...rule, type }, ctx);
}

/* ------------------------------------------------------------------ *
 * 时间轴
 * ------------------------------------------------------------------ */

export class ChannelTimeline {
  /**
   * @param {object} opts
   * @param {object} opts.channel  频道定义
   * @param {import('./library.mjs').Library} opts.library
   * @param {string} opts.tz
   */
  constructor({ channel, library, tz = 'Asia/Shanghai', tmdbIndex = null }) {
    this.channel = normalizeChannel(channel);
    this.library = library;
    this.tz = tz;
    this.mode = this.channel.mode;
    // 日编排的「日切时间」（秒）：默认 00:00；设成 06:00 就是一个 06:00 → 次日 06:00 的播出日
    this.dayOffsetMs = (this.channel.dayStartSec || 0) * 1000;
    this._cycle = null;
    this._dayCache = new Map();
    this._tmdbIndex = tmdbIndex;
    this._series = seriesOfEarly(library, this.channel, tmdbIndex);
  }

  get anchorMs() {
    return this.channel.anchorMs;
  }

  /** 某一时刻所属的「播出日」序号（按日切时间对齐） */
  dayIndexOf(ms) {
    return localDayIndex(ms - this.dayOffsetMs, this.tz);
  }

  /** 某个播出日的起点（毫秒） */
  dayStartOf(dayIndex) {
    return dayStartMs(dayIndex, this.tz) + this.dayOffsetMs;
  }

  /**
   * 展开 program，得到相对 startMs 的节目条目。
   *
   * 关键点：段 (segment) 的目标（count / hours）是「每一轮」的配额，
   * 规则本身的状态会一直延续到跑完为止。于是「2 小时随机 + 6 集轮播」
   * 的含义是：每轮 2 小时随机 + 6 集轮播，反复交替，直到所有规则都播完
   * 整个片库——一个循环 = 整库播一遍，之后才回到开头。
   */
  expand(startMs) {
    const entries = [];
    let cursor = 0; // 相对 startMs 的毫秒
    const dayLimit = this.mode === 'daily' ? DAY_MS : Number.POSITIVE_INFINITY;
    const program = this.channel.program;
    // daily 模式下把「日」编进随机种子，保证每天编排不同但可复现
    const dayTag = this.mode === 'daily' ? '/d' + localDayIndex(startMs, this.tz) : '';

    const units = program.map((seg, segIndex) => {
      const ctx = {
        library: this.library,
        series: this._series,
        channel: this.channel,
        tz: this.tz,
        seedPrefix: `${this.channel.id}/${segIndex}/${this.channel.seed}${dayTag}`,
        dayIndex: localDayIndex(startMs, this.tz),
        dayStartMs: startMs,
        dayStartSec: this.channel.dayStartSec || 0,
        cacheKey: segIndex,
        gridCache: (this._gridCache ||= new Map()),
      };
      const engine = makeRule(seg.rule, ctx);
      return {
        seg,
        segIndex,
        ctx,
        engine,
        target: resolveTarget(seg, engine),
        label: seg.label || seg.rule?.type || `规则 ${segIndex + 1}`,
        done: false,
        restarts: 0,
      };
    });

    let rounds = 0;
    const MAX_ENTRIES = 200000;
    while (rounds++ < 100000 && entries.length < MAX_ENTRIES && cursor < dayLimit) {
      let progressed = false;
      for (const u of units) {
        if (u.done) continue;
        if (cursor >= dayLimit) {
          u.done = true;
          continue;
        }
        let pulled = 0;
        let pulledMs = 0;
        for (;;) {
          if (entries.length >= MAX_ENTRIES || cursor >= dayLimit) {
            u.done = true;
            break;
          }
          if (u.target.kind === 'count' && u.target.value !== Infinity && pulled >= u.target.value) break;
          if (u.target.kind === 'ms' && pulledMs >= u.target.value) break;
          let ep = u.engine.next(startMs + cursor);
          if (!ep) {
            // 规则播完一轮：fill 段（按日编排）或显式 loop 段换新种子重来
            const canRestart = (u.seg.loop || u.target.kind === 'fill') && !u.engine.noRestart;
            if (canRestart && u.restarts < 12) {
              u.restarts++;
              u.engine = makeRule(u.seg.rule, { ...u.ctx, seedPrefix: `${u.ctx.seedPrefix}#r${u.restarts}` });
              ep = u.engine.next(startMs + cursor);
            }
            if (!ep) {
              u.done = true;
              break;
            }
          }
          // 留空标记：只推进游标，不产生节目
          if (ep && typeof ep.gapMs === "number" && ep.gapMs > 0) {
            cursor = Math.min(dayLimit, cursor + ep.gapMs);
            progressed = true;
            continue;
          }
          entries.push({
            episode: ep,
            relStart: cursor,
            durationMs: ep.durationMs,
            truncated: Boolean(ep.__truncated),
            segmentIndex: u.segIndex,
            segmentLabel: ep.__segmentLabel || u.label,
          });
          cursor += ep.durationMs;
          pulled++;
          pulledMs += ep.durationMs;
          progressed = true;
        }
      }
      if (!progressed) break;
      if (this.mode === 'daily') break; // 日编排只展开一轮，剩余部分交给 dayPlan 截断
      const finite = units.filter((u) => !u.engine.endless);
      if (finite.length === 0) break; // 全是无限规则，只展开一轮避免死循环
      if (finite.every((u) => u.done)) break; // 有限规则全部播完 → 循环结束
    }

    if (entries.length === 0) {
      throw new Error(
        `频道「${this.channel.name}」的编排没有产出任何节目：请检查 library 过滤条件与 program 规则（库内共 ${this.library.series.length} 部 / ${this.library.episodes.length} 集）`,
      );
    }
    return { entries, totalMs: cursor };
  }

  /** loop 模式：固定循环 */
  cycle() {
    if (!this._cycle) {
      const { entries } = this.expand(this.anchorMs);
      let totalMs = 0;
      for (const e of entries) {
        e.absStart = this.anchorMs + e.relStart;
        totalMs = Math.max(totalMs, e.relStart + e.durationMs);
      }
      this._cycle = { entries, totalMs };
    }
    return this._cycle;
  }

  /** daily 模式：某本地日的节目表（跨零点截断） */
  dayPlan(dayIndex) {
    const cached = this._dayCache.get(dayIndex);
    if (cached) return cached;
    const start = this.dayStartOf(dayIndex);
    const { entries } = this.expand(start);
    const out = [];
    for (const e of entries) {
      if (e.relStart >= DAY_MS) break;
      const room = DAY_MS - e.relStart;
      const dur = Math.min(e.durationMs, room);
      if (dur <= 0) break;
      out.push({
        ...e,
        absStart: start + e.relStart,
        durationMs: dur,
        truncated: Boolean(e.truncated) || dur < e.durationMs,
      });
    }
    const last = out[out.length - 1];
    const totalMs = last ? last.absStart + last.durationMs - start : 0;
    const plan = { dayIndex, dayStart: start, entries: out, totalMs };
    if (this._dayCache.size > 16) this._dayCache.delete(this._dayCache.keys().next().value);
    this._dayCache.set(dayIndex, plan);
    return plan;
  }

  /** 定位：给定时刻返回当前节目 + 进度 */
  resolve(nowMs) {
    if (this.mode === 'daily') {
      const day = this.dayIndexOf(nowMs);
      let plan = this.dayPlan(day);
      let offset = nowMs - plan.dayStart;
      if (offset < 0 || offset >= DAY_MS) {
        plan = this.dayPlan(day + 1);
        offset = nowMs - plan.dayStart;
      }
      const hit = findEntryByTime(plan.entries, nowMs, 'absStart');
      if (hit) return makeResolved(this, hit.entry, hit.entry.absStart, nowMs, hit.entry.truncated);
      // 留空时段：给出下一档，播放器进入待机
      const next = plan.entries.find((e) => e.absStart > nowMs);
      if (next) return makeOff(this, next.absStart, next);
      const nextPlan = this.dayPlan(day + 1);
      const first = nextPlan.entries[0];
      if (!first) return makeOff(this, null, null);
      return makeOff(this, first.absStart, first);
    }

    const { entries, totalMs } = this.cycle();
    const delta = nowMs - this.anchorMs;
    const k = Math.floor(delta / totalMs);
    const pos = delta - k * totalMs;
    const hit = findEntryByTime(entries, pos, 'relStart');
    if (hit) {
      const startsAt = this.anchorMs + k * totalMs + hit.entry.relStart;
      return makeResolved(this, hit.entry, startsAt, nowMs, false);
    }
    const nextUp = entries.find((e) => e.relStart > pos);
    if (nextUp) return makeOff(this, this.anchorMs + k * totalMs + nextUp.relStart, nextUp);
    const firstEntry = entries[0];
    return makeOff(this, this.anchorMs + (k + 1) * totalMs + firstEntry.relStart, firstEntry);
  }

  /**
   * 节目单：从 fromMs 起，最多 limit 条或到 toMs 为止
   */
  schedule(fromMs, toMs, limit = 50) {
    const out = [];
    const pushGap = (from, to) => {
      if (to <= from || out.length >= limit) return;
      out.push({ kind: 'gap', startsAt: from, endsAt: to, durationMs: to - from, truncated: false, segmentLabel: '留空', episode: null });
    };
    if (this.mode === 'daily') {
      let day = this.dayIndexOf(fromMs);
      let guard = 0;
      let cursor = fromMs;
      while (out.length < limit && guard++ < 400) {
        const plan = this.dayPlan(day);
        for (const e of plan.entries) {
          const ends = e.absStart + e.durationMs;
          if (ends <= fromMs) continue;
          if (e.absStart >= toMs) {
            pushGap(cursor, toMs);
            return out;
          }
          if (e.absStart > cursor) pushGap(cursor, e.absStart);
          if (out.length >= limit) break;
          out.push(toProgramItem(e, e.absStart, e.durationMs, e.truncated));
          cursor = ends;
          if (ends >= toMs) return out;
        }
        day++;
        if (this.dayStartOf(day) > toMs) break;
      }
      return out;
    }

    const { entries, totalMs } = this.cycle();
    const delta = fromMs - this.anchorMs;
    let k = Math.floor(delta / totalMs);
    let pos = delta - k * totalMs;
    let guard = 0;
    let idx = entries.findIndex((e) => pos >= e.relStart && pos < e.relStart + e.durationMs);
    if (idx < 0) idx = entries.findIndex((e) => e.relStart > pos);
    if (idx < 0) idx = 0;
    let cursor = fromMs;
    while (out.length < limit && guard++ < 100000) {
      const e = entries[idx];
      const startsAt = this.anchorMs + k * totalMs + e.relStart;
      if (startsAt >= toMs) {
        pushGap(cursor, toMs);
        break;
      }
      if (startsAt > cursor) pushGap(cursor, startsAt);
      out.push(toProgramItem(e, startsAt, e.durationMs, false));
      cursor = startsAt + e.durationMs;
      idx++;
      if (idx >= entries.length) {
        idx = 0;
        k++;
      }
    }
    return out;
  }

  stats() {
    if (this.mode === 'daily') {
      const today = this.dayIndexOf(Date.now());
      const plan = this.dayPlan(today);
      return {
        mode: 'daily',
        dayEntries: plan.entries.length,
        dayDurationMs: plan.totalMs,
        poolSeries: this._series.length,
        poolEpisodes: this._series.reduce((a, s) => a + s.episodes.length, 0),
      };
    }
    const { entries, totalMs } = this.cycle();
    return {
      mode: 'loop',
      cycleEntries: entries.length,
      cycleDurationMs: totalMs,
      poolSeries: this._series.length,
      poolEpisodes: this._series.reduce((a, s) => a + s.episodes.length, 0),
      cycleDays: totalMs / DAY_MS,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function resolveTarget(seg, engine) {
  if (seg.count != null) return { kind: 'count', value: Math.max(1, Math.floor(seg.count)) };
  if (seg.fill) return { kind: 'fill', value: 0 };
  if (seg.hours != null) return { kind: 'ms', value: seg.hours * 3600000 };
  if (seg.minutes != null) return { kind: 'ms', value: seg.minutes * 60000 };
  if (seg.durationMs != null) return { kind: 'ms', value: seg.durationMs };
  if (seg.all) return { kind: 'count', value: Number.POSITIVE_INFINITY };
  // 未指定：有限规则播完一轮；无限规则给个默认段长
  if (engine.endless) return { kind: 'count', value: DEFAULT_SEGMENT_COUNT };
  return { kind: 'count', value: Number.POSITIVE_INFINITY };
}

function findEntryByTime(entries, t, key) {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid];
    const start = e[key];
    if (t < start) hi = mid - 1;
    else if (t >= start + e.durationMs) lo = mid + 1;
    else return { entry: e, index: mid };
  }
  return null;
}

function makeResolved(tl, entry, startsAt, nowMs, truncated) {
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
    truncated: Boolean(truncated),
    segmentLabel: entry.segmentLabel,
    channel: tl.channel,
  };
}

/** 留空时段：没有节目在播，next 表示下一档 */
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

function toProgramItem(entry, startsAt, durationMs, truncated) {
  return {
    startsAt,
    endsAt: startsAt + durationMs,
    durationMs,
    truncated: Boolean(truncated),
    segmentLabel: entry.segmentLabel,
    episode: entry.episode,
  };
}

/** 复用已解析的剧集对象，避免每次重新 bind */
export function episodeView(ep) {
  return {
    fileId: ep.fileId,
    seriesId: ep.seriesId,
    series: ep.seriesName,
    season: ep.season,
    episode: ep.episode,
    title: ep.title,
    name: ep.name,
    relPath: ep.relPath,
    size: ep.size,
    durationMs: ep.durationMs,
    durationText: fmtDuration(ep.durationMs),
    subtitle: ep.subtitle || null,
    container: ep.container,
  };
}

/* ------------------------------------------------------------------ *
 * 频道定义归一化
 * ------------------------------------------------------------------ */

export function normalizeChannel(def, tz = 'Asia/Shanghai') {
  if (!def || !def.id) throw new Error('频道定义缺少 id');
  const program = def.program || def.rules || [];
  const norm = {
    id: String(def.id),
    name: def.name || def.id,
    description: def.description || '',
    mode: def.mode === 'daily' ? 'daily' : 'loop',
    dayStart: def.dayStart || '00:00',
    dayStartSec: def.dayStart ? parseClock(def.dayStart) : 0,
    seed: def.seed ?? def.id,
    library: def.library || {},
    weights: def.weights || null,
    // 已经归一化过的频道只有 anchorMs（没有 anchor 字符串），必须优先沿用，
    // 否则每次重新归一化都会被重置成默认锚点
    anchorMs: Number.isFinite(Number(def.anchorMs))
      ? Number(def.anchorMs)
      : def.anchor
        ? Date.parse(def.anchor)
        : Date.parse('2024-01-01T00:00:00+08:00'),
    program: program.length > 0 ? program : [{ rule: { type: 'sequential' } }],
  };
  if (Number.isNaN(norm.anchorMs)) throw new Error(`频道 ${norm.id} 的 anchor 时间无法解析：${def.anchor}`);
  norm.program = norm.program.map((seg, i) => {
    if (!seg || !seg.rule) throw new Error(`频道 ${norm.id} 第 ${i + 1} 段缺少 rule`);
    return seg;
  });
  return norm;
}
