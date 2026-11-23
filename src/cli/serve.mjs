#!/usr/bin/env node
/**
 * 启动轮播服务
 *   node src/cli/serve.mjs [--config config.json] [--port 8088] [--host 0.0.0.0]
 */
import fs from 'node:fs';
import { loadConfig } from '../config.mjs';
import { createApp } from '../server.mjs';
import { WebDavClient } from '../webdav.mjs';
import { fmtDuration } from '../util.mjs';

function parseArgs(argv) {
  const out = { config: null, port: null, host: null, mode: null, prefix: null, token: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') out.config = argv[++i];
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--prefix') out.prefix = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法: node src/cli/serve.mjs [--config 配置] [--port 8088] [--host 0.0.0.0] [--mode redirect|proxy] [--prefix URL]',
      );
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);

// 命令行覆盖，便于临时切流模式 / 换 CDN 前缀
if (args.mode) {
  if (!['redirect', 'proxy'].includes(args.mode)) {
    console.error(`--mode 只能是 redirect 或 proxy，收到 ${args.mode}`);
    process.exit(1);
  }
  config.stream.mode = args.mode;
}
if (args.prefix) config.stream.urlPrefix = args.prefix;
if (args.token) config.stream.token = args.token;

const port = args.port || config.server.port;
const host = args.host || config.server.host;

const { server, state } = createApp(config);

server.listen(port, host, () => {
  const lib = state.library;
  const cfg = state.config;
  console.log('');
  console.log('  Media Rotator 服务已启动');
  console.log(`  ├ 播放   http://127.0.0.1:${port}/`);
  console.log(`  ├ 管理   http://127.0.0.1:${port}/admin`);
  console.log(`  ├ 接口   http://127.0.0.1:${port}/api/now?channel=${cfg.channels[0]?.id || '(待配置)'}`);
  console.log(`  ├ 节目库 ${lib.series.length} 部 / ${lib.episodes.length} 集${lib.episodes.length ? ' / ' + fmtDuration(lib.episodes.reduce((a, e) => a + e.durationMs, 0)) : '（还没扫描）'}`);
  console.log(`  ├ 时区   ${cfg.timezone}`);
  console.log(`  ├ 取流   ${cfg.stream.mode === 'redirect' ? '302 直链' : '后端代理'} → ${cfg.stream.urlPrefix || '(未配置)'}`);
  console.log(`  └ 频道   ${cfg.channels.length ? cfg.channels.map((c) => `${c.id}(${c.slots?.[0]?.grid?.start || '20:00'} · ${c.slots?.[0]?.grid?.perDay || 3}部/天)`).join('  ') : '（还没有频道，打开 /admin 新建）'}`);
  if (!lib.episodes.length) {
    console.log('');
    console.log('  ⚠ 还没有媒体库索引：打开 /admin 填写 WebDAV 信息并点「开始扫描」');
  }
  console.log('');
  // 直链模式下探测一次：目标是否要求鉴权（浏览器 <video> 不会自动带 Basic 凭据）
  if (state.config.stream.mode === 'redirect' && state.config.webdav.baseUrl) {
    (async () => {
      try {
        const probe = new WebDavClient({ ...state.config.webdav, username: '', password: '', retries: 0, timeoutMs: 6000 });
        const res = await probe.open(state.config.webdav.root || '', { method: 'HEAD' });
        if (res.status === 401 || res.status === 403) {
          console.log('  ⚠ 直链目标需要鉴权：浏览器 <video> 不会自动携带 Basic 凭据');
          console.log('    播放器可能 401。可改用  npm start -- --mode proxy  由后端带凭据转发，');
          console.log('    或把 urlPrefix 指向会注入鉴权的反向代理 / 免鉴权 CDN。');
          console.log('');
        }
      } catch {
        /* 探测失败不影响启动 */
      }
    })();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
