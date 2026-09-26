#!/usr/bin/env node
// AxMem fade — the forgetting shadow-window reporter. (P1 third pass)
// NEVER moves files. Eligibility (all deterministic): live non-head entry
// whose supersession edge entered git >= min_age days ago AND has zero
// resolved-heat in 30 days — with telemetry coverage under 30 days rendering
// every candidate UNKNOWN (absence of evidence is not zero; audited rule).
// V1 exclusions: standinginstructions entirely, trigger-bearing entries,
// entries still linked by live non-supersession wiki-links, user-ratified,
// duplicate tags, entries referenced by pending receipts.
'use strict';
const fs = require('fs');
const cp = require('child_process');
const ctx = require('../lib/prelude.cjs');
const MEM = ctx.MEMORY_DIR;
const MIN_AGE = Number(process.env.AXMEM_FADE_MIN_AGE_DAYS || ctx.cfgGet('fade.min_age_days', 30));
const ASSUME_COV = process.env.AXMEM_FADE_ASSUME_COVERAGE === '1';

const mf = JSON.parse(cp.execFileSync('node', [__dirname + '/manifest.cjs', '--json'],
  { env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
if (mf.blocking.length) { console.log('BLOCKED: fix the supersession graph first:'); mf.blocking.forEach(b => console.log('  ' + b)); process.exit(2); }

const live = mf.entries.filter(e => !e.archived);
const liveByTag = new Map(live.map(e => [e.tag, e]));
const linkedBy = new Set();
for (const e of live) for (const l of e.links) linkedBy.add(l);
let pendingText = '';
try {
  const rd = MEM + '/receipts';
  let covered = '';
  for (const f of fs.readdirSync(rd)) {
    if (f.startsWith('spool-')) pendingText += fs.readFileSync(rd + '/' + f, 'utf8');
    if (f.startsWith('covered-')) covered += fs.readFileSync(rd + '/' + f, 'utf8');
  }
  const cov = new Set(covered.split('\n').map(l => l.split('\t')[0]).filter(Boolean));
  pendingText = pendingText.split('\n').filter(l => l && !cov.has(l.split('\t')[0])).join('\n');
} catch {}
let covStart = null, resolvedRecent = '';
try {
  const tdir = MEM + '/telemetry';
  const now = Date.now();
  const cutoff = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(tdir)) if (f.startsWith('heat-resolved-')) {
    const s = fs.readFileSync(tdir + '/' + f, 'utf8');
    const first = s.split('\n').find(Boolean);
    if (first) { const d = first.slice(0, 10); if (!covStart || d < covStart) covStart = d; }
    resolvedRecent += s.split('\n').filter(l => l.slice(0, 10) >= cutoff).join('\n') + '\n';
  }
} catch {}
const covDays = covStart ? Math.floor((Date.now() - Date.parse(covStart)) / 86400000) : 0;
const coverageOK = ASSUME_COV || covDays >= 30;

function edgeAgeDays(oldTag) {
  try {
    const outp = cp.execFileSync('git', ['-C', MEM, 'log', '--reverse', '--format=%ct', '-S', 'Supersedes: [[' + oldTag + ']]', '--', '.'],
      { encoding: 'utf8', timeout: 20000 });
    const ct = Number(outp.split('\n').find(Boolean));
    return ct ? Math.floor((Date.now() - ct * 1000) / 86400000) : null;
  } catch { return null; }
}

const eligible = [], unknown = [], excluded = [];
for (const [oldTag, headTag] of Object.entries(mf.heads)) {
  if (oldTag === headTag) continue;
  const e = liveByTag.get(oldTag);
  if (!e) continue;
  const skip = (r) => excluded.push(`[${oldTag}] ${r}`);
  if (e.file === 'standinginstructions.md') { skip('standing excluded'); continue; }
  if (e.triggers.length) { skip('carries triggers (redirect entry point)'); continue; }
  if (e.trust === 'user-ratified') { skip('user-ratified'); continue; }
  if (live.filter(x => x.tag === oldTag).length > 1) { skip('duplicate tag'); continue; }
  if (linkedBy.has(oldTag)) { skip('still linked by live entries'); continue; }
  if (pendingText.includes(oldTag)) { skip('referenced by pending receipts'); continue; }
  const age = edgeAgeDays(oldTag);
  if (age === null) { unknown.push(`[${oldTag}] supersession-edge commit time unknown`); continue; }
  if (age < MIN_AGE) { skip(`edge age ${age}d < ${MIN_AGE}d`); continue; }
  if (!coverageOK) { unknown.push(`[${oldTag}] edge ${age}d ok, telemetry coverage ${covDays}d < 30 -> UNKNOWN`); continue; }
  if (resolvedRecent.includes('\t' + oldTag)) { skip('resolved heat within 30d'); continue; }
  eligible.push(`[${oldTag}] -> head [${headTag}] (edge ${age}d, zero resolved heat 30d)`);
}
console.log(`axmem fade dry-run as-of ${new Date().toISOString().slice(0, 10)} (shadow window; this tool never moves files)`);
console.log(`telemetry coverage: since ${covStart || 'never'} (${covDays}d${coverageOK ? '' : ' -> all candidates UNKNOWN'})`);
console.log(`ELIGIBLE=${eligible.length}`); eligible.forEach(x => console.log('  + ' + x));
console.log(`UNKNOWN=${unknown.length}`); unknown.forEach(x => console.log('  ? ' + x));
console.log(`EXCLUDED=${excluded.length}`); excluded.slice(0, 15).forEach(x => console.log('  - ' + x));
