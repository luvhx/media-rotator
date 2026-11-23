#!/usr/bin/env node
/**
 * 字幕转换自检（不联网）
 *   node tools/selftest-subtitles.mjs
 */
import { assToVtt, srtToVtt, toVtt, assTimeToVtt, cleanAssText , assToCues, vttToCues } from '../src/subtitles.mjs';

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

/* ---------------- ASS ---------------- */
const ass = `[Script Info]
Title: test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}Hello, world
Dialogue: 0,0:00:04.20,0:00:06.00,Default,,0,0,0,,line one\\Nline two
Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,被注释掉的
Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 l 100 100{\\p0}
Dialogue: 0,0:10:00.50,0:10:05.00,Default,,0,0,0,,长时段
`;

const vtt = assToVtt(ass);
check(vtt.startsWith('WEBVTT'), 'ASS → 输出 WEBVTT 头');
check(vtt.includes('00:00:01.000 --> 00:00:03.500'), 'ASS 时间戳转 VTT');
check(vtt.includes('Hello, world') && !vtt.includes('\\an8'), '去掉 {\\an8} 标签');
check(vtt.includes('line one\nline two'), '\\N 转换为换行');
check(!vtt.includes('被注释掉的'), '跳过 Comment 行');
check(!vtt.includes('l 100 100'), '丢弃绘图指令');
check(vtt.includes('00:10:00.500 --> 00:10:05.000'), '支持 10 分钟以上的时间');
const badTs = [...vtt.matchAll(/^([\d:.]+) --> ([\d:.]+)$/gm)].filter((m) => !/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(m[1]));
check(badTs.length === 0, '所有时间戳均为 HH:MM:SS.mmm');

check(assTimeToVtt('0:00:01.5') === '00:00:01.500', 'ans 单小数位补零', assTimeToVtt('0:00:01.5'));
check(assTimeToVtt('1:02:03.04') === '01:02:03.040', 'ans 两位小数', assTimeToVtt('1:02:03.04'));
check(cleanAssText('{\\i1}斜体{\\i0}') === '斜体', '去掉行内样式');

// 不同 Format 顺序（Marked 在第一列）
const ass2 = `[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:02.00,0:00:04.00,Default,,0,0,0,,另一种格式
`;
check(assToVtt(ass2).includes('另一种格式'), '兼容 Marked 开头的 Format');

/* ---------------- SRT ---------------- */
const srt = `1
00:00:01,000 --> 00:00:03,000
第一行

2
00:00:04,500 --> 00:00:06,000
second
`;
const svtt = srtToVtt(srt);
check(svtt.startsWith('WEBVTT'), 'SRT → WEBVTT 头');
check(svtt.includes('00:00:01.000 --> 00:00:03.000'), 'SRT 逗号毫秒转点');
check(!/^\d+$/m.test(svtt.replace(/^WEBVTT\n\n/, '')), '去掉 SRT 序号行');
check(svtt.includes('第一行') && svtt.includes('second'), '保留正文');

/* ---------------- 透传 / 嗅探 ---------------- */
check(toVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n', 'vtt').startsWith('WEBVTT'), 'VTT 原样透传');
check(toVtt(ass, '').includes('Hello'), '无扩展名时按内容嗅探 ASS');
check(toVtt(srt, 'txt').startsWith('WEBVTT'), '未知扩展名兜底为 VTT');

/* ---------------- 空输入 ---------------- */
check(assToVtt('').trim() === 'WEBVTT', '空 ASS 不炸');
check(srtToVtt('').trim() === 'WEBVTT', '空 SRT 不炸');

/* ---------------- ASS 样式（assToCues） ---------------- */

const styledAss = `[Script Info]
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,1,2,10,10,40,1
Style: Top,Yu Gothic,64,&H0000FFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,1,8,10,10,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\i1}斜体{\\i0} 正常
Dialogue: 0,0:00:05.00,0:00:08.00,Top,,0,0,0,,顶部标题
Dialogue: 0,0:00:09.00,0:00:12.00,Default,,0,0,0,,{\\pos(960,900)\\c&H0000FF&}红字定位
Dialogue: 0,0:00:13.00,0:00:16.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}画完了
`;

const styled = assToCues(styledAss);
check(styled.playResX === 1920 && styled.playResY === 1080, 'ASS：解析分辨率', styled.playResX + 'x' + styled.playResY);
check(styled.cues.length === 4, 'ASS：cue 数', styled.cues.length);

const c1 = styled.cues[0];
check(c1.html.includes('<i>斜体</i>'), 'ASS：斜体保留');
check(c1.size === 72, 'ASS：样式字号', c1.size);
check(c1.html.includes('color:#FFFFFF'), 'ASS：默认颜色');

const c2 = styled.cues[1];
check(c2.align === 8, 'ASS：\\an 对齐', c2.align);
check(c2.html.includes('<b>'), 'ASS：样式粗体');

const c3 = styled.cues[2];
check(c3.pos && c3.pos.x === 960 && c3.pos.y === 900, 'ASS：\\pos 定位', JSON.stringify(c3.pos));
check(c3.html.includes('#FF0000'), 'ASS：内联颜色', c3.html.match(/color:[^"]+/)?.[0]);

const c4 = styled.cues[3];
check(!/\bm 0 0\b/.test(c4.html) && c4.html.includes('画完了'), 'ASS：丢弃矢量绘图保留文字', c4.html);

const plain = vttToCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n纯文本\n');
check(plain.cues.length === 1 && plain.cues[0].html === '纯文本', 'VTT → cue 兜底');

console.log(fails === 0 ? '\n字幕转换自检通过 ✓' : `\n${fails} 项失败 ✗`);
process.exit(fails ? 1 : 0);
