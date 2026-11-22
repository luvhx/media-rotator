/**
 * API 端到端检查（需要服务已启动）
 *   node tools/smoke-api.mjs
 *   BASE_URL=http://host:8088 node tools/smoke-api.mjs
 *
 * 编排 v3 只有「时间网格」：节目按整点/半点开始，允许留空，所以不再假设首尾相接。
 */
const base = process.env.BASE_URL || 'http://127.0.0.1:8088';
const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
};
let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

const cfg = await get('/api/config');
check(cfg.status === 200 && cfg.json.channels.length === 3, '/api/config', `${cfg.json.channels.map((c) => c.id).join(',')} / ${cfg.json.stream.mode}`);

// 当前节目：可能正在播，也可能处于留空时段
const a = (await get('/api/now?channel=main')).json;
await new Promise((r) => setTimeout(r, 5000));
const b = (await get('/api/now?channel=main')).json;

if (b.off) {
  check(typeof b.until === 'number' && b.until > b.serverTime, '留空时段返回下一档时间', new Date(b.until).toISOString());
  check(Array.isArray(b.next) && b.next.length > 0, '留空时段仍然给出后续节目', `${b.next?.length} 条`);
} else {
  const itemA = a.now;
  const itemB = b.now;
  if (itemA && itemA.fileId === itemB.fileId) {
    const drift = Math.abs(b.serverTime - a.serverTime - (itemB.offsetMs - itemA.offsetMs));
    check(drift < 1500, '进度推进与真实时间一致', `Δserver=${b.serverTime - a.serverTime}ms Δoffset=${(itemB.offsetMs - itemA.offsetMs).toFixed(0)}ms`);
  } else {
    check(true, '5s 内跨集（跳过推进校验）');
  }
  check(b.next[0].startsAt >= b.now.endsAt, '下一档不早于当前节目结束');
}

// 未来节目时间单调递增、互不重叠
const future = b.next || [];
let mono = true;
for (let i = 1; i < future.length; i++) if (future[i].startsAt < future[i - 1].endsAt) mono = false;
check(mono, '接下来 12 条时间单调不重叠');

// 节目单：允许留空，但必须按时间递增且落在窗口内
const sch = await get('/api/schedule?channel=daily&date=2026-11-16&limit=500');
const items = sch.json.items || [];
check(sch.status === 200 && items.length > 0, '/api/schedule?date 有节目', `${items.length} 条`);
const dayStart = new Date('2026-11-16T00:00:00+08:00').getTime();
check(items.every((it, i) => i === 0 || it.startsAt >= items[i - 1].endsAt), '当天节目单按时间递增且不重叠');
const lastEnd = items[items.length - 1].endsAt;
check(lastEnd <= dayStart + 86400000, '当天节目单不超过 24:00', `${((lastEnd - dayStart) / 3600000).toFixed(2)}h`);
const eps = items.filter((i) => i.kind !== 'gap');
check(eps.length > 0 && eps.every((i) => i.episode && i.fileId), '节目项都带 fileId');
check(items.some((i) => i.kind === 'gap') || eps.length === items.length, '留空以 gap 行表示（允许没有）');

// 视频流
const fid = (b.now || future[0])?.fileId;
if (!fid) {
  check(false, '拿不到可播放的 fileId');
} else {
  const head = await fetch(`${base}/stream/${fid}`, { method: 'HEAD' });
  check(head.status === 200 && head.headers.get('content-type')?.startsWith('video/'), '视频流 HEAD', head.headers.get('content-type'));
  const rng = await fetch(`${base}/stream/${fid}`, { headers: { Range: 'bytes=0-2047' } });
  const buf = Buffer.from(await rng.arrayBuffer());
  check(rng.status === 206 && buf.length === 2048, '视频流 Range 206', `bytes=${buf.length} magic=${buf.subarray(0, 4).toString('hex')}`);
  check(buf.subarray(0, 4).toString('hex') === '1a45dfa3', '返回的确是对应 MKV 文件');

  // 异常时长上报：与容器解析值差异过大必须被拒绝
  const rep = await fetch(base + '/api/report-duration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: fid, durationMs: 1000 * 60 * 60 }),
  });
  const repJson = await rep.json();
  check(rep.status === 200 && repJson.ignored === true, '异常时长上报被拒绝', JSON.stringify(repJson).slice(0, 80));
}

// 前端资源
for (const p of ['/', '/app.js', '/style.css']) {
  const r = await fetch(base + p);
  check(r.status === 200, `静态资源 ${p}`, r.headers.get('content-type'));
}

// 未知资源
check((await fetch(base + '/stream/deadbeef')).status === 404, '未知 fileId → 404');
check((await fetch(base + '/api/now?channel=nope')).status === 404, '未知频道 → 404');

console.log(fails === 0 ? '\n端到端全部通过 ✓' : `\n${fails} 项失败 ✗`);
process.exit(fails ? 1 : 0);
