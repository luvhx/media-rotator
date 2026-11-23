import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sha1 } from './util.mjs';

/**
 * 字幕服务
 * ------------------------------------------------------------------
 * 浏览器只认 WebVTT，而节目字幕多是 ASS/SRT（外挂）或封在 MKV 里（内挂），
 * 所以这里统一转成 WebVTT 再给 <track> 用：
 *
 *   外挂 .ass/.srt  → 从 WebDAV 读文本 → 转 VTT（纯 JS，零依赖）
 *   内挂轨道        → 调 ffmpeg 抽取（仅在带 ffmpeg 的镜像里可用）
 *
 * 转换结果按「文件指纹」缓存在 data/subs/ 下，重复播放不会重复转换。
 */

const ASS_TS = /^(\d+):(\d{2}):(\d{2})[.:](\d{1,3})$/;

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

/** ASS/SSA 时间戳 → WebVTT（H:MM:SS.cc → HH:MM:SS.mmm） */
export function assTimeToVtt(text) {
  const m = ASS_TS.exec(String(text).trim());
  if (!m) return null;
  const [, h, mi, s, frac] = m;
  const ms = frac.length === 2 ? Number(frac) * 10 : frac.length === 1 ? Number(frac) * 100 : Number(frac);
  return `${pad(Number(h))}:${mi}:${s}.${pad(ms, 3)}`;
}

/** 去掉 ASS 的行内覆盖标签、绘图指令，保留台词文本 */
export function cleanAssText(raw) {
  let text = String(raw || '');
  // 整段的绘图命令（\p1 之后的 m/l 路径）直接丢弃
  if (/^\s*\{[^}]*\\p\d[^}]*\}/.test(text)) return '';
  text = text.replace(/\{[^}]*\}/g, '');
  text = text.replace(/\\[Nn]/g, '\n');
  text = text.replace(/\\h/g, ' ');
  // 残留的绘图坐标
  const kept = text
    .split('\n')
    .filter((line) => !/^\s*[ml]\s+(-?\d+(\.\d+)?\s*)+$/i.test(line))
    .join('\n');
  return kept.replace(/\n{3,}/g, '\n\n').trim();
}

/** ASS/SSA → WebVTT */
export function assToVtt(input) {
  const lines = String(input).replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = ['WEBVTT', ''];
  let inEvents = false;
  let format = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      format = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const fmt = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const body = line.slice(line.indexOf(':') + 1);
    const idxStart = fmt.indexOf('start');
    const idxEnd = fmt.indexOf('end');
    const idxText = fmt.indexOf('text') >= 0 ? fmt.indexOf('text') : fmt.length - 1;

    const parts = [];
    let rest = body;
    for (let i = 0; i < idxText; i++) {
      const k = rest.indexOf(',');
      parts.push(k < 0 ? rest : rest.slice(0, k));
      rest = k < 0 ? '' : rest.slice(k + 1);
      if (rest === '' && i < idxText - 1) break;
    }
    parts.push(rest);

    const start = assTimeToVtt(parts[idxStart]);
    const end = assTimeToVtt(parts[idxEnd]);
    const text = cleanAssText(parts[idxText] ?? '');
    if (!start || !end || !text) continue;
    if (start >= end) continue;
    out.push(`${start} --> ${end}`, text.replace(/-->/g, '- - >'), '');
  }

  return out.join('\n');
}

/** SRT → WebVTT */
export function srtToVtt(input) {
  let text = String(input).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  // 去掉纯序号行
  text = text.replace(/^\d+[ \t]*\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s*-->)/gm, '');
  return `WEBVTT\n\n${text.trim()}\n`;
}

/** 已经是 WebVTT 就直接用 */
export function ensureVtt(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  return /^WEBVTT/.test(text.trimStart()) ? text : `WEBVTT\n\n${text.trim()}\n`;
}

/** 按扩展名转换 */
export function toVtt(content, ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'ass' || e === 'ssa') return assToVtt(content);
  if (e === 'srt' || e === 'sub') return srtToVtt(content);
  if (e === 'vtt') return ensureVtt(content);
  // 未知格式：按内容嗅探
  if (/^\[script info\]/i.test(String(content).trimStart())) return assToVtt(content);
  return ensureVtt(content);
}

function extOf(p) {
  return (String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
}

/**
 * @typedef {{text: string, source: 'external'|'embedded', cached: boolean}} SubtitleResult
 */

export class SubtitleService {
  /**
   * @param {object} opts
   * @param {import('./webdav.mjs').WebDavClient} opts.dav
   * @param {string} opts.cacheDir
   * @param {string} [opts.ffmpegPath]
   * @param {boolean} [opts.enabled]
   */
  constructor({ dav, cacheDir, ffmpegPath = 'ffmpeg', enabled = true, extractTimeoutMs = 180000 }) {
    this.dav = dav;
    this.cacheDir = cacheDir;
    this.ffmpegPath = ffmpegPath;
    this.enabled = enabled;
    this.extractTimeoutMs = extractTimeoutMs;
    this.ffmpegAvailable = false;
    this.ffmpegChecked = false;
    this.inflight = new Map();
  }

  /** 探测 ffmpeg 是否可用（只跑一次） */
  async detectFfmpeg() {
    if (this.ffmpegChecked) return this.ffmpegAvailable;
    this.ffmpegChecked = true;
    this.ffmpegAvailable = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      try {
        const p = spawn(this.ffmpegPath, ['-hide_banner', '-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
        p.on('error', () => finish(false));
        p.on('close', (code) => finish(code === 0));
        setTimeout(() => finish(false), 4000);
      } catch {
        finish(false);
      }
    });
    return this.ffmpegAvailable;
  }

  cachePath(ep) {
    const key = sha1(`${ep.fileId}|${ep.relPath}|${ep.size}|2`);
    return path.join(this.cacheDir, `${key.slice(0, 20)}.vtt`);
  }

  /**
   * 取某集字幕的 WebVTT
   * @param {object} ep 库里的剧集对象
   * @returns {Promise<SubtitleResult|null>}
   */
  async get(ep) {
    if (!this.enabled || !ep) return null;
    const cacheFile = this.cachePath(ep);
    if (fs.existsSync(cacheFile)) {
      const text = fs.readFileSync(cacheFile, 'utf8');
      if (text.trim().length > 0) {
        const srcFile = `${cacheFile}.src`;
        const extFile = `${cacheFile}.ext`;
        const raw = fs.existsSync(srcFile) ? fs.readFileSync(srcFile, 'utf8') : null;
        const ext = fs.existsSync(extFile) ? fs.readFileSync(extFile, 'utf8').trim() : null;
        return { text, raw, ext, source: ep.subtitle ? 'external' : 'embedded', cached: true };
      }
    }
    if (this.inflight.has(cacheFile)) return this.inflight.get(cacheFile);

    const task = (async () => {
      const result = ep.subtitle ? await this.#fromExternal(ep) : await this.#fromEmbedded(ep);
      if (!result) return null;
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, result.text);
      fs.renameSync(tmp, cacheFile);
      if (result.raw) {
        const tmpRaw = `${cacheFile}.src.tmp`;
        fs.writeFileSync(tmpRaw, result.raw);
        fs.renameSync(tmpRaw, `${cacheFile}.src`);
        fs.writeFileSync(`${cacheFile}.ext`, result.ext || 'ass');
      }
      return { ...result, cached: false };
    })().finally(() => this.inflight.delete(cacheFile));

    this.inflight.set(cacheFile, task);
    return task;
  }

  /** 带样式的 cue 列表（ASS 保留样式，其余按纯文本） */
  async getCues(ep) {
    const result = await this.get(ep);
    if (!result) return null;
    const ext = String(result.ext || '').toLowerCase();
    const raw = result.raw || '';
    if ((ext === 'ass' || ext === 'ssa' || /^\[script info\]/i.test(raw.trim())) && raw) {
      const parsed = assToCues(raw);
      if (parsed.cues.length > 0) return { ...parsed, kind: 'ass', source: result.source };
    }
    const parsed = vttToCues(result.text);
    return { ...parsed, kind: 'vtt', source: result.source };
  }

  async #fromExternal(ep) {
    const ext = extOf(ep.subtitle);
    const res = await this.dav.open(ep.subtitle, { method: 'GET' });
    if (!res.ok) throw new Error(`读取外挂字幕失败 HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
    const text = toVtt(raw, ext);
    if (!/-->/.test(text)) return null;
    return { text, raw, ext, source: 'external' };
  }

  async #fromEmbedded(ep) {
    if (!(await this.detectFfmpeg())) return null;
    const raw = await this.#runFfmpeg(ep);
    if (!raw) return null;
    const text = toVtt(raw, 'ass');
    if (!/-->/.test(text)) return null;
    return { text, raw, ext: 'ass', source: 'embedded' };
  }

  #runFfmpeg(ep) {
    const url = this.dav.url(ep.relPath);
    const auth = this.dav.authHeader;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (auth) args.push('-headers', `Authorization: ${auth}\r\n`);
    args.push('-i', url, '-map', '0:s:0', '-c:s', 'ass', '-f', 'ass', 'pipe:1');

    return new Promise((resolve) => {
      const chunks = [];
      let finished = false;
      const done = (v) => {
        if (finished) return;
        finished = true;
        resolve(v);
      };
      let child;
      try {
        child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        return done(null);
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done(null);
      }, this.extractTimeoutMs);
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', () => {});
      child.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return done(null);
        done(Buffer.concat(chunks).toString('utf8'));
      });
    });
  }
}

/* ------------------------------------------------------------------ *
 * ASS 样式解析（输出带样式的 cue，供播放器自绘）
 * ------------------------------------------------------------------ */

const DEFAULT_STYLE_FMT = [
  'name', 'fontname', 'fontsize', 'primarycolour', 'secondarycolour', 'outlinecolour', 'backcolour',
  'bold', 'italic', 'underline', 'strikeout', 'scalex', 'scaley', 'spacing', 'angle',
  'borderstyle', 'outline', 'shadow', 'alignment', 'marginl', 'marginr', 'marginv', 'encoding',
];
const DEFAULT_EVENT_FMT = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

function assColor(raw) {
  const m = /&H([0-9a-fA-F]{1,8})/.exec(String(raw || ''));
  if (!m) return null;
  const hex = m[1].padStart(8, '0').slice(-6); // BBGGRR
  const r = hex.slice(4, 6);
  const g = hex.slice(2, 4);
  const b = hex.slice(0, 2);
  return '#' + r + g + b;
}

/** ASS 时间戳 → 毫秒 */
function assTimeMs(raw) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,2}))?$/.exec(String(raw || '').trim());
  if (!m) return NaN;
  const [, h, mi, se, cs] = m;
  const centi = cs ? Number(cs.padEnd(2, '0')) : 0;
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(se)) * 1000 + centi * 10;
}

function splitCsv(text, limit = Infinity) {
  const out = [];
  let rest = String(text);
  while (out.length < limit - 1) {
    const i = rest.indexOf(',');
    if (i < 0) break;
    out.push(rest.slice(0, i).trim());
    rest = rest.slice(i + 1);
  }
  out.push(rest.trim());
  return out;
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 解析一句 Dialogue 的内联标签，返回带 HTML 的 cue */
function parseAssInline(raw, base = {}) {
  const state = {
    italic: Boolean(base.italic),
    bold: Boolean(base.bold),
    underline: Boolean(base.underline),
    color: base.color || null,
    size: 0,
    align: Number(base.align) || 2,
    pos: null,
    drawing: false,
  };
  const runs = [];
  const re = /\{([^}]*)\}|([^{]+)/g;
  let m;
  while ((m = re.exec(raw))) {
    if (m[1] !== undefined) {
      for (const tag of m[1].split('\\').slice(1)) {
        const t = tag.trim();
        if (!t) continue;
        if (/^i1/i.test(t)) state.italic = true;
        else if (/^i0/i.test(t)) state.italic = false;
        else if (/^b[1-9]/.test(t)) state.bold = true;
        else if (/^b0/.test(t)) state.bold = false;
        else if (/^u1/i.test(t)) state.underline = true;
        else if (/^u0/i.test(t)) state.underline = false;
        else if (/^an[1-9]/.test(t)) state.align = Number(t[2]);
        else if (/^pos\(/.test(t)) {
          const p = /^pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(t);
          if (p) state.pos = { x: Number(p[1]), y: Number(p[2]) };
        } else if (/^(?:1c|c)&H[0-9a-fA-F]{1,8}&?/.test(t)) {
          state.color = assColor(t.slice(t.indexOf('&')));
        } else if (/^fs[\d.]+/.test(t)) {
          const fs = /^fs([\d.]+)/.exec(t);
          if (fs) state.size = Number(fs[1]);
        } else if (/^p\d/.test(t)) {
          state.drawing = Number(t.slice(1)) > 0;
        }
        // \k \kf \ko \K \fad \move \t 等特效标签忽略
      }
      continue;
    }
    if (state.drawing) continue;
    const text = m[2].replace(/\\N/gi, '\n').replace(/\\h/g, ' ');
    if (!text) continue;
    runs.push({ text, ...state, pos: undefined, drawing: undefined });
  }

  const pieces = [];
  for (const run of runs) {
    const lines = String(run.text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) pieces.push({ html: '<br>', style: null });
      if (!lines[i]) continue;
      let html = escHtml(lines[i]).replace(/ /g, '&#160;');
      if (run.italic) html = `<i>${html}</i>`;
      if (run.bold) html = `<b>${html}</b>`;
      if (run.underline) html = `<u>${html}</u>`;
      if (run.color) html = `<span style="color:${run.color}">${html}</span>`;
      if (run.size) html = `<span style="font-size:${run.size}px">${html}</span>`;
      pieces.push({ html, style: run });
    }
  }

  const html = pieces.map((p) => p.html.replace(/&#160;/g, ' ')).join('');
  if (!html.replace(/<[^>]+>/g, '').trim()) return null;
  return { html, align: state.align, pos: state.pos, size: state.size || Number(base.size) || 0 };
}

/** ASS → 带样式的 cue 列表 */
export function assToCues(input) {
  const lines = String(input).replace(/^\uFEFF/, '').split(/\r?\n/);
  const styles = new Map();
  let section = '';
  let styleFmt = null;
  let eventFmt = null;
  let playResX = 1280;
  let playResY = 720;
  const cues = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (/^\[.*\]$/.test(line)) {
      section = line.slice(1, -1).toLowerCase();
      continue;
    }
    if (section === 'script info') {
      const x = /^playresx\s*:\s*(\d+)/i.exec(line);
      const y = /^playresy\s*:\s*(\d+)/i.exec(line);
      if (x) playResX = Number(x[1]);
      if (y) playResY = Number(y[1]);
      continue;
    }
    if (section === 'v4+ styles' || section === 'v4 styles') {
      if (/^format\s*:/i.test(line)) {
        styleFmt = splitCsv(line.slice(line.indexOf(':') + 1)).map((s) => s.toLowerCase());
        continue;
      }
      if (!/^style\s*:/i.test(line)) continue;
      const fmt = styleFmt || DEFAULT_STYLE_FMT;
      const parts = splitCsv(line.slice(line.indexOf(':') + 1));
      const at = (k) => parts[fmt.indexOf(k)] ?? '';
      const name = at('name') || 'Default';
      styles.set(name, {
        font: at('fontname'),
        size: Number(at('fontsize')) || 0,
        color: assColor(at('primarycolour')),
        bold: Number(at('bold')) > 0,
        italic: Number(at('italic')) > 0,
        underline: Number(at('underline')) > 0,
        align: Number(at('alignment')) || 2,
      });
      continue;
    }
    if (section !== 'events') continue;
    if (/^format\s*:/i.test(line)) {
      eventFmt = splitCsv(line.slice(line.indexOf(':') + 1)).map((s) => s.toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;

    const fmt = eventFmt || DEFAULT_EVENT_FMT;
    const idxText = fmt.indexOf('text') >= 0 ? fmt.indexOf('text') : fmt.length - 1;
    const parts = splitCsv(line.slice(line.indexOf(':') + 1), fmt.length);
    const start = assTimeMs(parts[fmt.indexOf('start')]) / 1000;
    const end = assTimeMs(parts[fmt.indexOf('end')]) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const styleName = parts[fmt.indexOf('style')] || 'Default';
    const base = styles.get(styleName) || {};
    const parsed = parseAssInline(parts[idxText] ?? '', base);
    if (!parsed) continue;
    cues.push({ start, end, ...parsed });
  }

  cues.sort((a, b) => a.start - b.start);
  return { playResX, playResY, cues };
}

/** WebVTT → 纯文本 cue（没有样式，保持兼容） */
export function vttToCues(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
  const toSec = (h, m, s, ms) => (h ? Number(h) : 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const re = /(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/;
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const m = re.exec(lines[idx]);
    if (!m) continue;
    const body = lines.slice(idx + 1).join('\n').trim();
    if (!body) continue;
    cues.push({
      start: toSec(m[1], m[2], m[3], m[4]),
      end: toSec(m[5], m[6], m[7], m[8]),
      html: escHtml(body).replace(/\n/g, '<br>'),
      align: 2,
      pos: null,
      size: 0,
    });
  }
  return { playResX: 1280, playResY: 720, cues };
}
