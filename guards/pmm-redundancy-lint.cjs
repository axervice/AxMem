#!/usr/bin/env node
// 冗余闸(2026-09-14,the maintainer「允许豁免但必须在不失真前提下精简用词」)
// 诚实边界:「重复意思」是判断题(机器判=判死的那类自动化);本闸只做四道**数数题**:
//   R1 条目内重复片段:同一 ≥12 字符片段在正文出现 ≥2 次(重复用词/句)
//   R2 库内抄写:正文与库中**其他**条目共享 ≥40 字符连续片段(写入纪律③:同一事实已在
//      他文件 → 引用 [[tag]] 不复写)——对所有新条目生效
//   R3 填充词:the maintainer 偏好里禁掉的口水词(首先/其次/综上所述/不难发现/值得注意的是…)
//   R4 压缩率:gzip(正文)/len 低于校准阈值 = 高冗余(语言无关的重复度代理)
// 阻断范围:R2/R3 → 全部新条目;R1/R4 → 带 [sole-record] 的条目(既要豁免长度,先证明精简)。
// 用法:node pmm-redundancy-lint.cjs [--report] [--json];退出码 2 = 有阻断类命中(基线语义
//   由调用方 entry-length-watch 负责:只拦净增)。
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { resolveHome } = require('./pmm-recall-ledger.cjs');
const MEM = (process.env.PMM_MEM_DIR || resolveHome() + '/.claude/memory').replace(/\\/g, '/');
const R1_MIN = Number(process.env.PMM_R1_MIN || 12);
const R1_HAN = Number(process.env.PMM_R1_HAN || 8);  // 窗口内至少多少个汉字才算"短语"(校准见下)
const R2_MIN = Number(process.env.PMM_R2_MIN || 40);
const R4_MAX = Number(process.env.PMM_R4_MAX || 0.62); // 校准见 --report;正文 gzip 比高于此视为正常
const FILLER = ['首先,', '其次,', '综上所述', '不难发现', '值得注意的是', '总而言之', '众所周知', '毋庸置疑', '换句话说,', '需要指出的是'];

const files = ['decisions.md', 'lessons.md', 'standinginstructions.md'];
const entries = [];
for (const f of files) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  let cur = null;
  const flush = () => { if (cur) { entries.push(cur); cur = null; } };
  for (const line of s.split(/\r?\n/)) {
    const h = line.match(/^\*\*(20[^*]+)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
    if (h) { flush(); cur = { tag: h[2], file: f, sole: line.includes('[sole-record]'), ok: line.includes('[redundancy-ok]'), body: [] }; continue; }
    if (/^## /.test(line)) flush();
    if (!cur) continue;
    if (/^\s*(<!--|Ratified by:|Supersedes:|Superseded by:|Scope:|Reason:)/.test(line)) continue;
    if (line.startsWith('- 20')) continue;
    cur.body.push(line);
  }
  flush();
}
// 校准(2026-09-14 首跑 82 命中):R2 的"共享片段"几乎全是指针/tag/路径/反引号——那是引用,
// 正是纪律③鼓励的形态;R1 的"重复片段"是技术名词二现。比对前剥掉引用形态,只留散文。
function prose(t) {
  return t
    .replace(/\[\[[^\]]+\]\]/g, ' ')            // 双链
    .replace(/\[[a-z][a-z0-9-]*:[A-Za-z0-9._-]+\]/g, ' ') // 单括号 tag
    .replace(/`[^`]*`/g, ' ')                   // 反引号 span
    .replace(/https?:\/\/\S+/g, ' ')            // URL
    .replace(/[→←][^。;;\n]*/g, ' ')            // 箭头指针整段(→ docs/x.md@sha 等)
    .replace(/[~\w./\\-]*\/[\w./\\-]+/g, ' ')   // 路径样 token
    .replace(/\b[A-Za-z_][A-Za-z0-9_.]{5,}\b/g, ' ') // 长 ASCII 标识符
    .replace(/\s+/g, ' ').trim();
}
// R2 只比"纯散文行":含指针形态(反引号路径/[[链]]/→/URL/迁移戳)的行是引用行,引用行被
// 标准化复用正是纪律③要的形态(校准第二轮:剩下 4 条命中全是「全文已迁 `…`」同一枚戳)。
const POINTERISH = /`[^`]*[\/\\.][^`]*`|\[\[|→|https?:\/\/|全文已迁/;
for (const e of entries) {
  e.text = prose(e.body.join('\n'));
  e.proseOnly = prose(e.body.filter(l => !POINTERISH.test(l)).join('\n'));
}

// R1:条目内重复片段(滑窗 n-gram,只报最长一次)
function selfRepeat(t) {
  if (t.length < R1_MIN * 2) return null;
  const seen = new Map();
  for (let i = 0; i + R1_MIN <= t.length; i++) {
    const g = t.slice(i, i + R1_MIN);
    if (/^[\s\p{P}]+$/u.test(g)) continue;
    // 只认含 ≥8 个中文字的片段=重复**短语**;标识符/英文词二现不算冗余
    if ((g.match(/\p{Script=Han}/gu) || []).length < R1_HAN) continue;
    if (seen.has(g) && i - seen.get(g) >= R1_MIN) return g;
    if (!seen.has(g)) seen.set(g, i);
  }
  return null;
}
// R2:库内抄写(与其他条目共享 ≥R2_MIN 片段)——索引其他条目的 R2_MIN-gram
const gramOwner = new Map();
for (const e of entries) {
  const t = e.proseOnly;
  for (let i = 0; i + R2_MIN <= t.length; i += 8) { // 步进 8,粗筛
    const g = t.slice(i, i + R2_MIN);
    if (!gramOwner.has(g)) gramOwner.set(g, e.tag);
  }
}
function corpusCopy(e) {
  const t = e.proseOnly;
  for (let i = 0; i + R2_MIN <= t.length; i++) {
    const g = t.slice(i, i + R2_MIN);
    const o = gramOwner.get(g);
    if (o && o !== e.tag) return { owner: o, frag: g };
  }
  return null;
}
const gz = (t) => t.length ? zlib.gzipSync(Buffer.from(t, 'utf8')).length / Buffer.byteLength(t, 'utf8') : 1;

const hits = [], ratios = [];
for (const e of entries) {
  if (!e.text) continue;
  const r = gz(e.text); ratios.push(r);
  const f1 = selfRepeat(e.text), f2 = corpusCopy(e), f3 = FILLER.find(w => e.text.includes(w)), f4 = r < R4_MAX && Buffer.byteLength(e.text, 'utf8') > 300;
  const items = [];
  if (f2) items.push({ rule: 'R2', block: true, note: `与 [${f2.owner}] 共享 ≥${R2_MIN} 字符原文「${f2.frag.slice(0, 24)}…」→ 引用不复写` });
  if (f3) items.push({ rule: 'R3', block: true, note: `填充词「${f3}」` });
  if (f1) items.push({ rule: 'R1', block: e.sole, note: `条目内重复片段「${f1}」` });
  if (f4) items.push({ rule: 'R4', block: e.sole, note: `gzip 比 ${r.toFixed(2)} < ${R4_MAX}(高冗余)` });
  // 逃生口(the maintainer 2026-09-14「精简到最简仍有重复,守卫一直不给过怎么办」):标题带 [redundancy-ok]
  // → 命中降为 ℹ️ 不拦;标记本身进月度豁免审计④(记账+月审,与 sole-record 同待遇)。闸不许死锁。
  if (e.ok) for (const i of items) i.block = false;
  if (items.length) hits.push({ tag: e.tag, file: e.file, sole: e.sole, ok: e.ok, items });
}
const blocking = hits.filter(h => h.items.some(i => i.block));
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify({ hits, blocking: blocking.length, entries: entries.length })); process.exit(blocking.length ? 2 : 0); }
const sorted = [...ratios].sort((a, b) => a - b);
const pct = (p) => sorted.length ? sorted[Math.floor(p * (sorted.length - 1))].toFixed(2) : '-';
console.log(`pmm-redundancy-lint:条目 ${entries.length}(sole-record ${entries.filter(e => e.sole).length});gzip 比分布 p5=${pct(0.05)} p50=${pct(0.5)} p95=${pct(0.95)};命中 ${hits.length},阻断类 ${blocking.length}`);
for (const h of hits.slice(0, 40)) for (const i of h.items) console.log(`  ${i.block ? '⛔' : 'ℹ️'} ${i.rule} ${h.file} [${h.tag}]${h.sole ? ' (sole-record)' : ''}${h.ok ? ' (redundancy-ok)' : ''} ${i.note}`);
if (blocking.length) console.log('  修法只有三种,都不失真:删掉第二份原文 / 改成「同上」「前述」回指 / 换成 [[tag]] 引用。不许换同义词。实在必须重复:标题加 [redundancy-ok](进月审)。');
if (!process.argv.includes('--report')) process.exit(blocking.length ? 2 : 0);
