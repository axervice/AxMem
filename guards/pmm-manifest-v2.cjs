#!/usr/bin/env node
// pmm-manifest-v2.cjs — thin CLI shell over pmm-core.cjs (PMM v3, C0 build).
// C0 = SHADOW ONLY: this binary never writes to ~/.claude/memory and is not wired into any hook.
// Usage:
//   node pmm-manifest-v2.cjs [--from worktree|HEAD|:0] [--as-of YYYY-MM-DD] --json
//   node pmm-manifest-v2.cjs [--from ...] --check              (exit 2 if any blocking)
//   node pmm-manifest-v2.cjs [--from ...] --index [--as-of D] [--cold] [--legacy]
//   node pmm-manifest-v2.cjs --diff <viewA> <viewB>              (e.g. --diff HEAD :0)
//   node pmm-manifest-v2.cjs [--from ...] --ledger
//   node pmm-manifest-v2.cjs (no flags)                          human summary
'use strict';
const core = require('./pmm-core.cjs');

function argVal(args, name, def) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return def;
  return args[i + 1];
}

// Opus B-4: any core failure (git show, bad ref, missing/unreadable file, empty snapshot) must
// surface as `PMM-CORE-ERROR <reason>` + non-zero exit — never "blocking=0 exit 0" or empty output.
function dieCoreError(e) {
  if (e instanceof core.PmmCoreError) {
    console.error(`PMM-CORE-ERROR ${e.message}`);
    process.exit(2);
  }
  throw e;
}

function main() {
  const args = process.argv.slice(2);
  const from = argVal(args, '--from', 'worktree');
  const asOf = argVal(args, '--as-of', core.today());

  if (args.includes('--diff')) {
    const i = args.indexOf('--diff');
    const viewA = args[i + 1], viewB = args[i + 2];
    if (!viewA || !viewB) { console.error('用法: --diff <viewA> <viewB>'); process.exit(1); }
    const snapA = core.snapshot(viewA);
    const snapB = core.snapshot(viewB);
    const outA = core.analyze(snapA, { asOf });
    const outB = core.analyze(snapB, { asOf });
    const idsA = new Map(outA.entries.filter(e => e.id && !e.archived).map(e => [e.id, e]));
    const idsB = new Map(outB.entries.filter(e => e.id && !e.archived).map(e => [e.id, e]));
    const archB = new Set(outB.entries.filter(e => e.archived).map(e => e.blockHash64));
    const retired = [], newEntries = [], identityChanged = [], limitViolations = [];
    for (const [id, e] of idsA) if (!idsB.has(id)) retired.push({ id, file: e.file, line: e.lineRange[0] });
    for (const [id, e] of idsB) if (!idsA.has(id)) newEntries.push({ id, file: e.file, line: e.lineRange[0] });
    const result = { viewA, viewB, asOf, retired, newEntries, blockingA: outA.blocking, blockingB: outB.blocking };
    if (args.includes('--json')) { process.stdout.write(JSON.stringify(result)); process.exit(0); }
    console.log(`pmm-manifest-v2 --diff ${viewA} ${viewB} (as-of ${asOf}):`);
    console.log(`  retired candidates (in ${viewA} live, absent from ${viewB} live): ${retired.length}`);
    for (const r of retired) console.log(`    F' ${r.file}:${r.line} [${r.id}]`);
    console.log(`  new entries (in ${viewB} live, absent from ${viewA} live): ${newEntries.length}`);
    for (const n of newEntries) console.log(`    + ${n.file}:${n.line} [${n.id}]`);
    process.exit(0);
  }

  const snap = core.snapshot(from);
  const out = core.analyze(snap, { asOf, cutover: args.includes('--cutover') });

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(out));
    process.exit(out.blocking.length ? 2 : 0);
  }
  if (args.includes('--check')) {
    console.log(`pmm-manifest-v2 --check --from ${from} as-of ${asOf}: blocking=${out.blocking.length} report=${out.report.length}`);
    for (const b of out.blocking) console.log('  ⛔ ' + b);
    for (const r of out.report.slice(0, 40)) console.log('  ℹ️ ' + r);
    process.exit(out.blocking.length ? 2 : 0);
  }
  if (args.includes('--index')) {
    const parsed = core.parseAll(snap);
    core.attachLegacyIndex(parsed, snap);
    const graph = core.buildGraph(parsed.entries);
    const legacy = args.includes('--legacy');
    const idx = core.renderIndex(parsed, graph, { asOf, cold: args.includes('--cold'), legacy });
    if (legacy) {
      for (const f of Object.keys(idx)) {
        console.log(`## ${f}`);
        if (idx[f].legacy) console.log(idx[f].text);
        else console.log(idx[f].rows.join('\n'));
      }
    } else {
      console.log(core.renderIndexText(idx));
    }
    process.exit(0);
  }
  if (args.includes('--ledger')) {
    const parsed = core.parseAll(snap);
    const graph = core.buildGraph(parsed.entries);
    const l = core.ledger(parsed, graph);
    if (args.includes('--json')) { process.stdout.write(JSON.stringify(l)); process.exit(0); }
    console.log(`pmm-core --ledger --from ${from}: live orphans=${l.liveOrphans} (ratified orphans=${l.ratifiedOrphans})`);
    for (const r of l.rows.filter(r => r.orphan)) console.log(`  孤儿 [${r.id}] ${r.file}`);
    process.exit(0);
  }

  console.log(`pmm-manifest-v2 as-of ${asOf} (--from ${from}): entries=${out.entries.length} live=${out.entries.filter(e => !e.archived).length} archived=${out.entries.filter(e => e.archived).length}`);
  console.log(`  blocking=${out.blocking.length} report=${out.report.length}`);
  for (const b of out.blocking.slice(0, 30)) console.log('  ⛔ ' + b);
  process.exit(out.blocking.length ? 2 : 0);
}

try { main(); } catch (e) { dieCoreError(e); }
