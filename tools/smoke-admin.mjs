#!/usr/bin/env node
/**
 * 管理接口冒烟（需要服务已启动；只读 + dryRun，不会改动任何配置）
 *
 *   node tools/smoke-admin.mjs
 *   BASE_URL=http://host:8088 node tools/smoke-admin.mjs
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8088';

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    cache: 'no-store',
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/* ------------------------------ 检查 ------------------------------ */

const state = await api('/api/admin/state');
check(state.status === 200, 'GET /api/admin/state', state.status);
const st = state.data;
check(typeof st.ready === 'boolean' && typeof st.configured === 'boolean', '状态字段齐全');
check(Array.isArray(st.channels) && st.channels.length > 0, '频道列表', st.channels.map((c) => c.id).join(','));
check(Boolean(st.channels[0].grid) && st.channels[0].grid.start, '频道带时间网格配置', JSON.stringify(st.channels[0].grid || {}).slice(0, 60));
check(!('password' in (st.config.webdav || {})), '接口不回报 WebDAV 密码');
check(!('apiKey' in (st.config.tmdb || {})), '接口不回报 TMDB Key');

const lib = st.library;
if (lib.loaded) {
  check(lib.series > 0 && lib.episodes > 0, '媒体库已加载', `${lib.series} 部 / ${lib.episodes} 集`);

  const series = await api('/api/admin/series?limit=10');
  check(series.status === 200 && series.data.series.length > 0, 'GET /api/admin/series', `${series.data.total} 部`);
  const first = series.data.series[0];
  check(typeof first.selected === 'boolean', '系列带选中状态');

  const posters = await api(`/api/admin/posters?ids=${encodeURIComponent(first.id)}`);
  check(posters.status === 200 && first.id in (posters.data.posters || {}), 'GET /api/admin/posters（编码 id）');

  const detail = await api(`/api/admin/series/${encodeURIComponent(first.id)}`);
  check(detail.status === 200 && Array.isArray(detail.data.episodes) && detail.data.episodes.length > 0, 'GET /api/admin/series/:id', `${detail.data.episodes.length} 集`);

  const channel = st.channels[0];
  const preview = await api('/api/admin/preview', { method: 'POST', body: { channel: channel.id, hours: 6 } });
  check(preview.status === 200 && Array.isArray(preview.data.items) && preview.data.items.length > 0, 'POST /api/admin/preview', `${preview.data?.items?.length} 条`);
  const contiguous = (preview.data.items || []).every((it, i, arr) => i === 0 || it.startsAt === arr[i - 1].endsAt);
  check(contiguous, '预览节目单首尾相接');
  check(Boolean(preview.data.items[0].segmentLabel), '节目带档位标签', preview.data.items[0].segmentLabel);

  // 非法编排必须被拒绝
  const bad = await api('/api/admin/preview', {
    method: 'POST',
    body: { channel: channel.id, hours: 6, settings: { channels: [{ ...channel, anchor: channel.anchor, grid: { ...(channel.grid || {}), start: '99:99' } }] } },
  });
  check(bad.status === 400, '未知规则类型被拒绝', bad.data?.error?.slice(0, 40));
}

// 字幕：找一集带外挂字幕的，验证 /subtitle 转码
if (lib.loaded) {
  const list = await api('/api/admin/series?limit=12');
  let target = null;
  for (const item of list.data.series) {
    const detail = await api(`/api/admin/series/${encodeURIComponent(item.id)}`);
    const ep = (detail.data.episodes || []).find((e) => e.subtitle);
    if (ep) {
      target = ep;
      break;
    }
  }
  if (target) {
    const res = await fetch(`${BASE}/subtitle/${target.fileId}`);
    const text = await res.text();
    const cues = (text.match(/-->/g) || []).length;
    check(
      res.status === 200 && (res.headers.get('content-type') || '').includes('text/vtt') && cues > 0,
      '外挂字幕转 WebVTT',
      `${cues} 条 · ${res.headers.get('x-subtitle-source')}`,
    );
  } else {
    console.log('• 跳过字幕检查（样例里没有带外挂字幕的剧集）');
  }
}

// 设置校验（dryRun，不落盘）
const dry = await api('/api/admin/settings', {
  method: 'PUT',
  body: { dryRun: true, webdav: { baseUrl: st.config.webdav.baseUrl || 'http://example.com/dav' }, channels: st.channels.map((c) => ({ id: c.id, name: c.name, anchor: c.anchor, grid: c.grid })) },
});
check(dry.status === 200 && dry.data.dryRun === true, 'POST /api/admin/settings?dryRun 校验通过');

const badUrl = await api('/api/admin/settings', { method: 'PUT', body: { dryRun: true, webdav: { baseUrl: 'not-a-url' } } });
check(badUrl.status === 400, '非法 WebDAV 地址被拒绝', badUrl.data?.error?.slice(0, 40));

const badTz = await api('/api/admin/settings', { method: 'PUT', body: { dryRun: true, timezone: 'Mars/Base' } });
check(badTz.status === 400, '非法时区被拒绝', badTz.data?.error?.slice(0, 40));

const badGrid = await api('/api/admin/settings', {
  method: 'PUT',
  body: { dryRun: true, channels: [{ id: 'x', name: 'x', anchor: new Date().toISOString(), grid: { start: '20:00', slotMinutes: 999, perDay: 3, episodes: 2, cycleDays: 7 } }] },
});
check(badGrid.status === 400, '非法网格参数被拒绝', badGrid.data?.error?.slice(0, 40));

const noGrid = await api('/api/admin/settings', {
  method: 'PUT',
  body: { dryRun: true, channels: [{ id: 'y', name: 'y', anchor: new Date().toISOString() }] },
});
check(noGrid.status === 400, '缺网格配置被拒绝', noGrid.data?.error?.slice(0, 40));

// 页面可访问
for (const p of ['/admin/', '/admin.css', '/admin.js']) {
  const r = await fetch(BASE + p);
  check(r.status === 200, `静态资源 ${p}`, r.headers.get('content-type'));
}
const redirect = await fetch(BASE + '/admin', { redirect: 'manual' });
check(redirect.status === 302 && redirect.headers.get('location') === '/admin/', '/admin 重定向到 /admin/');

console.log(fails === 0 ? '\n管理接口冒烟通过 ✓' : `\n${fails} 项失败 ✗`);
process.exit(fails ? 1 : 0);
