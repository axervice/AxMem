#!/usr/bin/env node
// 自动淡忘 dry-run 报告器(2026-09-14;codex 判 直跑 NO-GO / dry-run GO,the maintainer 批执行)
// **本工具永不移动文件**——只产候选报告。影子窗:连续 30 天候选零误报后才讨论自动移动。
// 资格(全确定性):live 非链头(已被取代)∧ Supersedes 边入 master ≥MIN_AGE 天
//   ∧ 30 天 resolved 热度为零(遥测覆盖不足 → UNKNOWN,绝不当零)
// V1 排除(codex 清单):standinginstructions 全文件 · 带 trigger 的条目 · 被 live 非取代
//   双链引用 · 被未清收据文本引用 · 重复 tag/图异常 · [trust:user-ratified] Kernel 类。
'use strict';
const fs = require('fs');
const cp = require('child_process');
const { resolveHome } = require('./pmm-recall-ledger.cjs');
const MEM = (process.env.PMM_MEM_DIR || resolveHome() + '/.claude/memory').replace(/\\/g, '/');
const GIT = (process.env.PMM_GIT_DIR || resolveHome()).replace(/\\/g, '/');
const MIN_AGE = Number(process.env.PMM_FADE_MIN_AGE_DAYS || 30);
const ASSUME_COV = process.env.PMM_FADE_ASSUME_COVERAGE === '1';

const mfRaw = cp.execFileSync('node', [__dirname + '/pmm-manifest.cjs', '--json'],
  { env: { ...process.env, PMM_MEM_DIR: MEM }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const mf = JSON.parse(mfRaw);
if (mf.blocking.length) { console.log('⛔ 取代图有阻断类问题,先修图再谈淡忘:'); mf.blocking.forEach(b => console.log('  ' + b)); process.exit(2); }

const live = mf.entries.filter(e => !e.archived);
const liveByTag = new Map(live.map(e => [e.tag, e]));
// live 非取代链引用(反向)
const linkedBy = new Set();
for (const e of live) for (const l of e.links) linkedBy.add(l);
// 未清收据文本
let pendingText = '';
try {
  const rd = MEM + '/receipts';
  for (const f of fs.readdirSync(rd)) if (f.startsWith('spool-')) pendingText += fs.readFileSync(rd + '/' + f, 'utf8');
  let covered = '';
  for (const f of fs.readdirSync(rd)) if (f.startsWith('covered-')) covered += fs.readFileSync(rd + '/' + f, 'utf8');
  const cov = new Set(covered.split('\n').map(l => l.split('\t')[0]).filter(Boolean));
  pendingText = pendingText.split('\n').filter(l => l && !cov.has(l.split('\t')[0])).join('\n');
} catch {}
// 热度覆盖:resolved 分片里最早一行的日期决定覆盖起点
let covStart = null;
try {
  const dr = MEM + '/dreams';
  for (const f of fs.readdirSync(dr)) if (f.startsWith('heat-resolved-')) {
    const first = fs.readFileSync(dr + '/' + f, 'utf8').split('\n').find(Boolean);
    if (first) { const d = first.slice(0, 10); if (!covStart || d < covStart) covStart = d; }
  }
} catch {}
const now = Date.now();
const covDays = covStart ? Math.floor((now - Date.parse(covStart)) / 86400000) : 0;
const coverageOK = ASSUME_COV || covDays >= 30;
let resolvedRecent = '';
try {
  const dr = MEM + '/dreams';
  const cutoff = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dr)) if (f.startsWith('heat-resolved-'))
    resolvedRecent += fs.readFileSync(dr + '/' + f, 'utf8').split('\n').filter(l => l.slice(0, 10) >= cutoff).join('\n') + '\n';
} catch {}

function edgeAgeDays(oldTag) {
  try {
    const outp = cp.execFileSync('git', ['-C', GIT, 'log', '--reverse', '--format=%ct', '-S', 'Supersedes: [[' + oldTag + ']]', '--',
      '.claude/memory/decisions.md', '.claude/memory/lessons.md', '.claude/memory/standinginstructions.md'],
      { encoding: 'utf8', timeout: 20000 });
    const ct = Number(outp.split('\n').find(Boolean));
    if (!ct) return null;
    return Math.floor((now - ct * 1000) / 86400000);
  } catch { return null; }
}

const eligible = [], unknown = [], excluded = [];
for (const [oldTag, headTag] of Object.entries(mf.heads)) {
  if (oldTag === headTag) continue;
  const e = liveByTag.get(oldTag);
  if (!e) continue; // 已归档,无事可做
  const skip = (r) => excluded.push(`[${oldTag}] ${r}`);
  if (e.file === 'standinginstructions.md') { skip('standing 全文件排除'); continue; }
  if (e.triggers.length) { skip('带 trigger(redirect 入口,归 manifest/redirect 台账批)'); continue; }
  if (e.trust === 'user-ratified') { skip('user-ratified'); continue; }
  if ((mf.entries.filter(x => x.tag === oldTag && !x.archived)).length > 1) { skip('重复 tag'); continue; }
  if (linkedBy.has(oldTag)) { skip('被 live 条目双链引用(仍在联想网服役)'); continue; }
  if (pendingText.includes(oldTag)) { skip('被未清收据引用'); continue; }
  const age = edgeAgeDays(oldTag);
  if (age === null) { unknown.push(`[${oldTag}] 取代边入库时间不可考`); continue; }
  if (age < MIN_AGE) { skip(`边龄 ${age}d < ${MIN_AGE}d`); continue; }
  if (!coverageOK) { unknown.push(`[${oldTag}] 边龄 ${age}d 达标,但热度遥测覆盖仅 ${covDays}d(<30)→ UNKNOWN`); continue; }
  if (resolvedRecent.includes('\t' + oldTag) || resolvedRecent.includes(oldTag + '\n')) { skip('30d 内有 resolved 热度'); continue; }
  eligible.push(`[${oldTag}] → 链头 [${headTag}](边龄 ${age}d,30d 零 resolved 热度)`);
}

console.log(`pmm-fade dry-run as-of ${new Date().toISOString().slice(0, 10)}(影子窗;本工具不移动任何文件)`);
console.log(`遥测覆盖:resolved 起点=${covStart || '无'}(${covDays}d${coverageOK ? '' : ',<30 → 一切候选记 UNKNOWN'})`);
console.log(`ELIGIBLE=${eligible.length}`); eligible.forEach(x => console.log('  ✅ ' + x));
console.log(`UNKNOWN=${unknown.length}`); unknown.forEach(x => console.log('  ❓ ' + x));
console.log(`EXCLUDED=${excluded.length}`); excluded.slice(0, 15).forEach(x => console.log('  ⏸ ' + x));
