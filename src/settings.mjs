import fs from 'node:fs';
import path from 'node:path';
import { isValidTimeZone } from './util.mjs';
import { normalizeChannel } from './scheduler.mjs';

/**
 * 运行期设置（Web UI 可改）
 * ------------------------------------------------------------------
 * 优先级：默认值 → 配置文件 → 环境变量 → data/settings.json
 * 也就是说 UI 保存的值最终生效，环境变量只作为初始值/兜底。
 *
 * 只存「可编辑」的部分，路径、端口等仍由配置文件决定。
 */

export const SETTINGS_VERSION = 1;

const EDITABLE_WEBDAV = ['baseUrl', 'root', 'username', 'password', 'timeoutMs'];
const EDITABLE_STREAM = ['mode', 'urlPrefix', 'token', 'embedCredentials'];

export function loadSettings(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    throw new Error(`settings.json 解析失败：${err.message}`);
  }
}

export function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { ...settings, version: SETTINGS_VERSION, updatedAt: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
  return payload;
}

function pick(obj, keys) {
  const out = {};
  if (!obj) return out;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  return out;
}

/** 把 settings 叠加到基础配置上（返回新对象，不修改入参） */
export function applySettings(baseConfig, settings = {}) {
  const cfg = structuredClone(baseConfig);
  const webdav = pick(settings.webdav, EDITABLE_WEBDAV);
  if (Object.keys(webdav).length > 0) cfg.webdav = { ...cfg.webdav, ...webdav };
  const stream = pick(settings.stream, EDITABLE_STREAM);
  if (Object.keys(stream).length > 0) cfg.stream = { ...cfg.stream, ...stream };
  if (settings.timezone) cfg.timezone = settings.timezone;
  if (settings.tmdb) cfg.tmdb = { ...(cfg.tmdb || {}), ...pick(settings.tmdb, ['apiKey', 'readToken', 'language']) };
  if (settings.subtitles) cfg.subtitles = { ...(cfg.subtitles || {}), ...pick(settings.subtitles, ['enabled']) };
  if (settings.remux) cfg.remux = { ...(cfg.remux || {}), ...pick(settings.remux, ['maxFiles', 'maxBytes']) };
  if (settings.prefetch) cfg.prefetch = { ...(cfg.prefetch || {}), ...pick(settings.prefetch, ['enabled', 'ahead', 'intervalMs']) };
  if (settings.compat) {
    const compat = structuredClone(settings.compat);
    const webdav = pick(compat.webdav, ['baseUrl', 'root', 'username', 'password', 'timeoutMs']);
    cfg.compat = {
      ...(cfg.compat || {}),
      ...pick(compat, ['publish', 'keepLocal', 'urlPrefix', 'maxFiles', 'maxBytes']),
      webdav: { ...(cfg.compat?.webdav || {}), ...webdav },
    };
  }
  if (Array.isArray(settings.channels) && settings.channels.length > 0) cfg.channels = structuredClone(settings.channels);
  cfg.selection = normalizeSelection(settings.selection, cfg.selection);
  return cfg;
}

export function normalizeSelection(selection, fallback = { mode: 'all', series: [] }) {
  const sel = selection && typeof selection === 'object' ? selection : fallback;
  const mode = sel.mode === 'include' ? 'include' : 'all';
  const series = Array.isArray(sel.series) ? [...new Set(sel.series.filter((x) => typeof x === 'string' && x))] : [];
  return { mode, series };
}

/**
 * 把「全局选片」注入到每个频道：选中的节目才参与编排
 * 频道自己还写了 library.series 时取交集
 */
export function withSelection(channel, selection) {
  const sel = normalizeSelection(selection);
  if (sel.mode !== 'include' || sel.series.length === 0) return channel;
  const lib = { ...(channel.library || {}) };
  if (Array.isArray(lib.series) && lib.series.length > 0) {
    const allow = new Set(sel.series);
    lib.series = lib.series.filter((s) => allow.has(s));
  } else {
    lib.series = sel.series.slice();
  }
  return { ...channel, library: lib };
}

/** 校验（抛错信息直接展示给用户） */
export function validateSettings(settings, { baseConfig, timezone } = {}) {
  if (!settings || typeof settings !== 'object') throw new Error('设置内容为空');

  if (settings.webdav) {
    const w = settings.webdav;
    if (w.baseUrl !== undefined) {
      const u = String(w.baseUrl).trim();
      if (!u) throw new Error('WebDAV 地址不能为空');
      let parsed;
      try {
        parsed = new URL(u);
      } catch {
        throw new Error(`WebDAV 地址不是合法 URL：${u}`);
      }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('WebDAV 地址必须以 http:// 或 https:// 开头');
    }
    if (w.timeoutMs !== undefined && (!Number.isFinite(Number(w.timeoutMs)) || Number(w.timeoutMs) < 1000)) {
      throw new Error('超时时间需大于 1000ms');
    }
  }

  if (settings.stream) {
    if (settings.stream.mode && !['redirect', 'proxy'].includes(settings.stream.mode)) {
      throw new Error('取流方式只能是 redirect 或 proxy');
    }
    const prefix = settings.stream.urlPrefix;
    if (prefix) {
      try {
        // 允许站内相对路径
        if (!/^\//.test(String(prefix))) new URL(String(prefix));
      } catch {
        throw new Error(`URL 前缀不合法：${prefix}`);
      }
    }
  }

  if (settings.timezone && !isValidTimeZone(settings.timezone)) {
    throw new Error(`无效时区：${settings.timezone}`);
  }

  const tz = settings.timezone || timezone || 'Asia/Shanghai';
  if (settings.subtitles && settings.subtitles.enabled !== undefined && typeof settings.subtitles.enabled !== 'boolean') {
    throw new Error('subtitles.enabled 必须是布尔值');
  }

  if (settings.remux && settings.remux.maxBytes !== undefined && Number(settings.remux.maxBytes) < 0) {
    throw new Error('remux.maxBytes 不能为负数（0 表示不限制）');
  }
  if (settings.prefetch && settings.prefetch.ahead !== undefined && Number(settings.prefetch.ahead) < 0) {
    throw new Error('prefetch.ahead 不能为负数');
  }
  if (settings.compat) {
    const c = settings.compat;
    if (c.publish && !['local', 'webdav'].includes(c.publish)) throw new Error('compat.publish 只能是 local 或 webdav');
    if (c.webdav?.baseUrl) {
      try {
        new URL(String(c.webdav.baseUrl));
      } catch {
        throw new Error(`兼容产物的 WebDAV 地址不合法：${c.webdav.baseUrl}`);
      }
    }
    if (c.urlPrefix) {
      try {
        if (!/^\//.test(String(c.urlPrefix))) new URL(String(c.urlPrefix));
      } catch {
        throw new Error(`兼容产物 302 前缀不合法：${c.urlPrefix}`);
      }
    }
  }

  if (settings.selection) {
    if (settings.selection.mode && !['all', 'include'].includes(settings.selection.mode)) {
      throw new Error('选片模式只能是 all 或 include');
    }
  }

  if (settings.channels) {
    if (!Array.isArray(settings.channels)) throw new Error('channels 必须是数组');
    const ids = new Set();
    for (const ch of settings.channels) {
      if (!ch || !ch.id) throw new Error('频道缺少 id');
      if (ids.has(ch.id)) throw new Error('频道 id 重复：' + ch.id);
      ids.add(ch.id);
      const label = '频道「' + (ch.name || ch.id) + '」';
      const g = ch.grid;
      if (!g || typeof g !== 'object') throw new Error(label + ' 缺少时间网格配置');
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(String(g.start || ''))) {
        throw new Error(label + ' 的开始时间格式应为 HH:MM');
      }
      const num = (key, min, max, fallback) => {
        if (g[key] === undefined || g[key] === null || g[key] === '') return fallback;
        const v = Number(g[key]);
        if (!Number.isFinite(v) || v < min || v > max) {
          throw new Error(label + ' 的 ' + key + ' 需在 ' + min + '~' + max + ' 之间');
        }
        return v;
      };
      num('slotMinutes', 5, 180, 30);
      num('perDay', 1, 48, 3);
      num('episodes', 1, 48, 2);
      num('cycleDays', 0, 31, 7);
      if (g.pool !== undefined && g.pool !== null && !Array.isArray(g.pool)) {
        throw new Error(label + ' 的片池必须是数组');
      }
      // 借 normalizeChannel 校验日切、锚点与结构
      normalizeChannel(ch, tz);
    }
  }
  return true;
}


/** 给前端看的设置（去掉密码 / token 等敏感字段） */
export function publicSettings(settings = {}) {
  const out = structuredClone(settings);
  if (out.webdav) {
    const hasPassword = Boolean(out.webdav.password);
    delete out.webdav.password;
    out.webdav.passwordSet = hasPassword;
  }
  if (out.tmdb) {
    out.tmdb.apiKeySet = Boolean(out.tmdb.apiKey);
    out.tmdb.readTokenSet = Boolean(out.tmdb.readToken);
    delete out.tmdb.apiKey;
    delete out.tmdb.readToken;
  }
  if (out.compat?.webdav?.password) {
    out.compat.webdav.passwordSet = true;
    delete out.compat.webdav.password;
  }
  if (out.stream?.token) {
    out.stream.tokenSet = true;
    delete out.stream.token;
  }
  return out;
}
