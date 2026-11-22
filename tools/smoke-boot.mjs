#!/usr/bin/env node
/**
 * 冷启动冒烟（CI 用）：不联网、无媒体库，验证「未配置也能起来并引导到 /admin」
 *
 *   node tools/smoke-boot.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rotator-boot-'));
const port = 18000 + Math.floor(Math.random() * 1000);

function writeConfig(channels) {
  const config = {
    server: { host: '127.0.0.1', port, publicDir: path.join(ROOT, 'public') },
    timezone: 'Asia/Shanghai',
    webdav: { baseUrl: '', root: '', username: '', password: '', timeoutMs: 5000 },
    paths: { library: path.join(tmp, 'library.json'), durations: path.join(tmp, 'durations.json') },
    stream: { mode: 'proxy' },
    channels,
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config, null, 2));
}
writeConfig([
  { id: 'main', name: '主线', anchor: '2026-11-23T00:00:00+08:00', slots: [{ from: '18:00', to: '24:00', label: '黄金档', grid: { start: '20:00', slotMinutes: 30, perDay: 3, episodes: 2, cycleDays: 7 } }] },
]);

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

const child = spawn(process.execPath, [path.join(ROOT, 'src/cli/serve.mjs'), '--config', path.join(tmp, 'config.json')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LOG_REQUESTS: '' },
});
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await wait(200);
  }
  return false;
}

try {
  const ready = await waitReady();
  check(ready, '服务能冷启动（未配置 WebDAV）', ready ? '' : stderr.slice(-300));

  if (ready) {
    const health = await (await fetch(base + '/api/health')).json();
    check(health.ok === true && health.ready === false && health.configured === false, '健康检查标记为未就绪', JSON.stringify({ ok: health.ok, ready: health.ready }));

    const admin = await fetch(base + '/admin/');
    check(admin.status === 200, '管理界面可访问', admin.status);

    const state = await (await fetch(base + '/api/admin/state')).json();
    check(state.ready === false && state.library.loaded === false, '管理状态提示未初始化');
    check(Array.isArray(state.channels) && state.channels.length > 0, '频道列表可用', state.channels.map((c) => c.id).join(','));

    const now = await fetch(base + '/api/now?channel=main');
    const nowJson = await now.json();
    check(now.status === 503 && nowJson.setup === true, '播放器接口返回引导标记', now.status);

    const scan = await fetch(base + '/api/admin/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check(scan.status === 400, '未配置时拒绝扫描', scan.status);

    const cfg = await (await fetch(base + '/api/config')).json();
    check(cfg.ready === false, '/api/config 暴露 ready=false');
  }
  // 第二个场景：0 个频道（默认状态）也应该能正常启动
  child.kill('SIGTERM');
  await wait(500);
  writeConfig([]);
  const child2 = spawn(process.execPath, [path.join(ROOT, 'src/cli/serve.mjs'), '--config', path.join(tmp, 'config.json')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr2 = '';
  child2.stderr.on('data', (d) => {
    stderr2 += d.toString();
  });
  const ready2 = await waitReady();
  check(ready2, '0 频道也能启动', ready2 ? '' : stderr2.slice(-200));
  if (ready2) {
    const st2 = await (await fetch(base + '/api/admin/state')).json();
    check(Array.isArray(st2.channels) && st2.channels.length === 0, '0 频道时管理状态为空列表');
    const now2 = await fetch(base + '/api/now');
    const nowJson2 = await now2.json();
    check(now2.status === 503 && nowJson2.setup === true, '0 频道时播放接口提示配置', now2.status);
    const admin2 = await fetch(base + '/admin/');
    check(admin2.status === 200, '0 频道时管理界面可访问', admin2.status);
  }
  child2.kill('SIGTERM');
  await wait(300);
  child2.kill('SIGKILL');
} finally {
  child.kill('SIGTERM');
  await wait(300);
  child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? '\n冷启动冒烟通过 ✓' : `\n${fails} 项失败 ✗`);
process.exit(fails ? 1 : 0);
