import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTimeZone } from './util.mjs';
import { normalizeChannel } from './scheduler.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG = {
  server: { host: '0.0.0.0', port: 8088, publicDir: 'public' },
  timezone: 'Asia/Shanghai',
  webdav: {
    baseUrl: '',
    root: '',
    username: '',
    password: '',
    timeoutMs: 20000,
  },
  paths: {
    library: 'data/library.json',
    durations: 'data/durations.json',
  },
  stream: {
    // redirect = 302 直链（默认，最快，客户端直连 WebDAV）
    // proxy    = 后端代理（可注入鉴权头、可跨域，占用后端带宽）
    mode: 'redirect',
    // 自定义前端读取视频文件时的 URL 前缀；null 表示用 webdav.baseUrl
    urlPrefix: null,
    // 302 时是否把账号密码嵌进 URL（部分播放器/Docker 场景需要）
    embedCredentials: false,
    // 302/直链追加的查询串，例如 CDN 鉴权 token
    token: null,
    // proxy 模式下是否透传 Range（必须开，否则不能拖动进度）
    passRange: true,
    // 额外响应头
    headers: {},
  },
  library: {
    fallbackDurationMs: 24 * 60 * 1000,
  },
  // 字幕：外挂 .ass/.srt 会自动转 WebVTT 挂到 <track>；内挂轨道需要镜像里带 ffmpeg
  // 界面外观（播放页与管理页共用）
  ui: {
    // auto = 跟随系统；light = 白天；dark = 夜间
    mode: 'auto',
    // 主题色（十六进制），用于按钮/进度条/选中态
    accent: '#6b7688',
  },
  subtitles: {
    enabled: true,
    ffmpegPath: 'ffmpeg',
  },
  // 转封装：MKV → MP4（视频流直接 copy），解决 iOS/Safari 不支持 MKV 的问题
  remux: {
    enabled: true,
    maxBytes: 20 * 1024 ** 3, // 每集产物约几百 MB，0 = 不限制
    maxFiles: 0, // 本地缓存最多保留几集，0 = 不限制
    ffprobePath: 'ffprobe',
  },
  // 预封装：提前把「当前 + 下一集」转好，不再等客户端触发
  prefetch: {
    enabled: true,
    ahead: 1,
    intervalMs: 20000,
    channels: [],
  },
  // 兼容产物发布：local 只存本地；webdav 上传到（可与原片不同的）WebDAV，之后 302 直连
  compat: {
    publish: 'local',
    keepLocal: true,
    urlPrefix: '',
    maxFiles: 0, // 远端产物最多保留几集，0 = 不限制
    maxBytes: 0, // 远端产物总大小上限，0 = 不限制
    webdav: {
      baseUrl: '',
      root: 'compat',
      username: '',
      password: '',
      timeoutMs: 120000,
    },
  },
  // TMDB：用于节目封面 / 简介 / 播出信息（留空则纯本地模式）
  tmdb: {
    apiKey: '',
    readToken: '',
    language: 'zh-CN',
    // 国内访问 api.themoviedb.org 很慢时，可以换成自建反代/镜像
    baseUrl: 'https://api.themoviedb.org/3',
    concurrency: 4,
  },
  settings: {
    // 运行期设置文件（Web UI 保存到这里）；null = 默认 data/settings.json
    file: null,
  },
  channels: [],
};

function deepMerge(base, patch) {
  if (patch == null) return base;
  if (Array.isArray(patch)) return patch.slice();
  if (typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * 环境变量覆盖：容器化部署时无需改动配置文件即可注入地址与账号
 *
 *   CONFIG_PATH / PORT / HOST / TIMEZONE
 *   WEBDAV_BASE_URL / WEBDAV_ROOT / WEBDAV_USERNAME / WEBDAV_PASSWORD
 *   STREAM_MODE / STREAM_URL_PREFIX / STREAM_TOKEN / STREAM_EMBED_CREDENTIALS
 *   LIBRARY_PATH / DURATIONS_PATH
 */
export function applyEnvOverrides(config, env = process.env) {
  const truthy = (v) => v === '1' || /^(true|yes|on)$/i.test(String(v));
  if (env.PORT) config.server.port = Number(env.PORT);
  if (env.HOST) config.server.host = env.HOST;
  if (env.TIMEZONE) config.timezone = env.TIMEZONE;
  if (env.WEBDAV_BASE_URL) {
    const prevBase = config.webdav.baseUrl;
    config.webdav.baseUrl = env.WEBDAV_BASE_URL;
    // 前缀若还是旧 baseUrl 的默认值，跟着一起改
    if (!env.STREAM_URL_PREFIX && (!config.stream.urlPrefix || config.stream.urlPrefix === prevBase)) {
      config.stream.urlPrefix = env.WEBDAV_BASE_URL;
    }
  }
  if (env.WEBDAV_ROOT != null && env.WEBDAV_ROOT !== '') config.webdav.root = env.WEBDAV_ROOT;
  if (env.WEBDAV_USERNAME != null) config.webdav.username = env.WEBDAV_USERNAME;
  if (env.WEBDAV_PASSWORD != null) config.webdav.password = env.WEBDAV_PASSWORD;
  if (env.WEBDAV_TIMEOUT_MS) config.webdav.timeoutMs = Number(env.WEBDAV_TIMEOUT_MS);
  if (env.STREAM_MODE) config.stream.mode = env.STREAM_MODE;
  if (env.STREAM_URL_PREFIX) config.stream.urlPrefix = env.STREAM_URL_PREFIX;
  if (env.STREAM_TOKEN) config.stream.token = env.STREAM_TOKEN;
  if (env.STREAM_EMBED_CREDENTIALS != null) config.stream.embedCredentials = truthy(env.STREAM_EMBED_CREDENTIALS);
  if (env.LIBRARY_PATH) config.paths.library = env.LIBRARY_PATH;
  if (env.DURATIONS_PATH) config.paths.durations = env.DURATIONS_PATH;
  return config;
}

export function resolvePath(p, root = PROJECT_ROOT) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

/**
 * 读取并校验配置
 * @param {string} [file]
 */
export function loadConfig(file) {
  // 配置文件查找顺序：显式参数 → CONFIG_PATH → config.json → config.example.json（容器内可用环境变量完全接管）
  const explicit = file || process.env.CONFIG_PATH;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(PROJECT_ROOT, 'config.json'), path.join(PROJECT_ROOT, 'config.example.json')];
  const configPath = candidates.find((p) => fs.existsSync(p));
  if (!configPath) {
    throw new Error(`找不到配置文件（尝试过：${candidates.join(', ')}），可复制 config.example.json 后修改`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = deepMerge(DEFAULT_CONFIG, raw);
  applyEnvOverrides(config);
  config.__file = configPath;
  config.__root = path.dirname(configPath);
  // allowIncomplete：首次启动允许 WebDAV 未配置，交给 Web UI 完成初始化
  return finalizeConfig(config, config.__root, { allowIncomplete: true });
}

/**
 * 校验 + 归一化（可重复调用：应用 UI 设置后再跑一遍）
 * @param {object} config 已合并的配置对象（会被原地修改并返回）
 * @param {string} root   相对路径的基准目录
 */
export function finalizeConfig(config, root = PROJECT_ROOT, { allowIncomplete = false } = {}) {
  if (!config.tmdb) config.tmdb = { ...DEFAULT_CONFIG.tmdb };
  config.paths.library = resolvePath(config.paths.library, root);
  config.paths.durations = resolvePath(config.paths.durations, root);
  config.server.publicDir = resolvePath(config.server.publicDir, root);
  config.__root = root;

  if (!config.webdav.baseUrl) {
    if (!allowIncomplete) {
      throw new Error('webdav.baseUrl 不能为空（可在 Web UI 里配置，或设置环境变量 WEBDAV_BASE_URL）');
    }
    config.__incomplete = true;
  }
  if (!isValidTimeZone(config.timezone)) throw new Error(`无效时区：${config.timezone}`);

  // 界面主题
  config.ui = config.ui || {};
  if (!['auto', 'light', 'dark'].includes(config.ui.mode)) config.ui.mode = 'auto';
  if (!/^#[0-9a-fA-F]{6}$/.test(String(config.ui.accent || ''))) config.ui.accent = '#6b7688';
  config.ui.accent = String(config.ui.accent).toLowerCase();

  // 频道：允许值简写为单个对象
  const channels = Array.isArray(config.channels) ? config.channels : config.channels ? [config.channels] : [];
  const ids = new Set();
  config.channels = channels.map((def) => {
    const ch = normalizeChannel(def, config.timezone);
    if (ids.has(ch.id)) throw new Error(`频道 id 重复：${ch.id}`);
    ids.add(ch.id);
    return ch;
  });
  // 频道完全由用户创建：不做默认补全，0 个频道是合法状态

  // 默认流前缀 = WebDAV 根地址
  if (!config.stream.urlPrefix) config.stream.urlPrefix = config.webdav.baseUrl || null;
  if (!['redirect', 'proxy'].includes(config.stream.mode)) {
    throw new Error(`stream.mode 只能是 redirect 或 proxy，收到：${config.stream.mode}`);
  }
  return config;
}

/** 从配置推导出可编辑设置（首次打开 Web UI 时的初始值） */
export function settingsFromConfig(config) {
  return {
    webdav: {
      baseUrl: config.webdav.baseUrl,
      root: config.webdav.root,
      username: config.webdav.username,
      password: config.webdav.password,
      timeoutMs: config.webdav.timeoutMs,
    },
    stream: {
      mode: config.stream.mode,
      urlPrefix: config.stream.urlPrefix,
      token: config.stream.token,
      embedCredentials: config.stream.embedCredentials,
    },
    timezone: config.timezone,
    tmdb: { ...DEFAULT_CONFIG.tmdb, ...(config.tmdb || {}) },
    channels: structuredClone(config.channels),
    selection: { mode: 'all', series: [] },
  };
}
