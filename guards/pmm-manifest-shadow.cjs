#!/usr/bin/env node
// pmm-manifest-shadow.cjs — v1 vs v2 shadow comparator (C0, read-only, real corpus).
// Compares identity sets, Supersedes edge sets, and blocking summaries between the legacy
// pmm-manifest.cjs and the new pmm-core.cjs-backed pmm-manifest-v2.cjs. Every difference is
// classified against known, structurally-explainable categories; anything left over is an
// unexplained red (exit 2). See guards/specs/PMM-V3-FINAL-SPEC.md §5 C0 allowlist.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const core = require('./pmm-core.cjs');

const G = __dirname;

function runJSON(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 64 });
    return JSON.parse(out.toString('utf8'));
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout.toString('utf8'));
    throw e;
  }
}

function main() {
  const v1 = runJSON('node', [path.join(G, 'pmm-manifest.cjs'), '--json']);
  const v2 = runJSON('node', [path.join(G, 'pmm-manifest-v2.cjs'), '--json', '--from', 'worktree']);

  const report = [];
  const explained = [];
  const unexplained = [];

  // ── identity sets (live, valid-tag only) ────────────────────────────────────────────────────
  const v1LiveTags = new Set((v1.entries || []).filter(e => !e.archived).map(e => e.tag));
  const v2LiveIds = new Set(v2.entries.filter(e => !e.archived && e.id).map(e => e.id));
  const onlyV1 = [...v1LiveTags].filter(t => !v2LiveIds.has(t));
  const onlyV2 = [...v2LiveIds].filter(t => !v1LiveTags.has(t));

  // v2-only identities (Opus H-5/H-9): this is the DANGEROUS direction — v2 claiming an identity v1
  // never saw at all is exactly what could smuggle a spurious/mis-parsed identity through C0's shadow
  // period unnoticed. Never unconditionally "explained" — only accept a narrow, checkable category:
  // v1 parsed SOMETHING at the exact same (file, dateISO) but grabbed a different bracket as its tag
  // (a genuine, auditable bracket-priority/regex difference on the SAME entry, not a phantom new one).
  // Anything else — v1 has nothing at all at that (file, dateISO) — stays unexplained/red.
  const v2ByFileLine = new Map(v2.entries.map(e => [e.id, e]));
  for (const t of onlyV2) {
    const e = v2ByFileLine.get(t);
    const v1SameSpot = e ? (v1.entries || []).find(v1e => !v1e.archived && v1e.file === e.file && v1e.date === e.dateISO) : null;
    if (v1SameSpot) {
      explained.push(`身份仅 v2 识别 [${t}]（${e.file}:${e.lineRange[0]}）—— v1 在同一 (file,date) 识别到了不同的 tag [${v1SameSpot.tag}](bracket 优先级/正则差异,同一条目而非 v2 凭空新增;需人工确认两者是否应视为同一身份)`);
    } else {
      unexplained.push(`身份仅 v2 识别 [${t}]（${e ? e.file + ':' + e.lineRange[0] : '?'}）—— v1 在该 (file,date) 找不到任何条目,v2 凭空多识别一个身份,属危险方向,不予自动解释`);
    }
  }
  // v1-only identities: usually v1 accepted something v2's stricter ATTR/format rules reject —
  // classify by re-checking against v2's own diagnostics for that tag.
  for (const t of onlyV1) {
    const nsOfT = t.split(':')[0];
    const diag = v2.diagnostics.find(d => d.tag === t);
    if (diag && (diag.code === 'B8b' || diag.code === 'B8c')) {
      explained.push(`身份仅 v1 识别 [${t}] —— v2 判定 ${diag.code}（${diag.reason}），v3 语法正确拒绝把它当身份`);
    } else if (core.ATTR_NS.has(nsOfT)) {
      explained.push(`身份仅 v1 识别 [${t}] —— ns=${nsOfT} 属于 attribution 命名空间，v2 正确排除（B8b 家族)`);
    } else {
      unexplained.push(`身份仅 v1 识别 [${t}]，v2 未能解释原因(v2 diagnostics 未命中该 tag)`);
    }
  }

  // ── Supersedes edge sets (live only) ────────────────────────────────────────────────────────
  const v1Edges = new Set();
  for (const e of (v1.entries || [])) if (!e.archived) for (const s of (e.supersedes || [])) v1Edges.add(`${s}=>${e.tag}`);
  const v2Edges = new Set(v2.edges.supersedes.map(x => `${x.from}=>${x.to}`));
  const edgesOnlyV1 = [...v1Edges].filter(x => !v2Edges.has(x));
  const edgesOnlyV2 = [...v2Edges].filter(x => !v1Edges.has(x));

  // B23 diagnostics tell us exactly which malformed Supersedes lines v2 (correctly) refuses to turn
  // into edges — cross-reference every v1-only edge against that set instead of assuming a fixed count.
  const b23 = v2.diagnostics.filter(d => d.code === 'B23');
  for (const edge of edgesOnlyV1) {
    const [from, to] = edge.split('=>');
    const owner = b23.find(d => d.tag === to && (d.raw.includes(`[${from}]`) || d.raw.includes(`[[${from}]]`)));
    if (owner) {
      const isClarify = /澄清|部分取代/.test(owner.raw);
      explained.push(`边仅 v1 有 [${from}]=>[${to}] —— 源行 B23(${owner.file}:${owner.line}):"${owner.raw}"；${isClarify ? '⑧ 有意删除(owner 裁定:参见链,不建边)' : '单括号/说明文字形态,v3 语法正确拒绝(C1 待归一)'}`);
    } else {
      unexplained.push(`边仅 v1 有 [${from}]=>[${to}]，v2 diagnostics 未找到对应 B23 记录解释原因`);
    }
  }
  for (const edge of edgesOnlyV2) unexplained.push(`边仅 v2 有 ${edge}（不应该出现：v2 应是 v1 边集的子集减去 B23 剔除项）`);

  // ── archive comparison (Opus H-5/H-9): v1's tag regex requires a valid [ns:tag] to create ANY
  // entry at all (even in an *-archive.md file) — a legacy archive block with no closing `**`/no tag
  // is completely invisible to v1 (not even counted), while v2 §1.4 cuts blocks tag-independently and
  // keeps them with id=null. This is the entire source of the archived-count gap; every archive entry
  // must be accounted for, not just totals. §1.5's permanent archive identity is `archive-sha256:` —
  // v1's `blockHash` uses a DIFFERENT algorithm (sha256 of body lines re-joined by '\n', 16 hex) than
  // v2's blockHash64 (sha256 of the exact original bytes incl. CRLF/BOM-exclusive, 64 hex, fence-aware
  // cut) — the two are not directly comparable by value, so archive identity here is matched by
  // (file, tag) for entries v1 CAN see, and any v2 archive entry with id=null is a structurally
  // explained category (v1 cannot represent a tagless entry) rather than left uncounted.
  const v1ArchTags = new Set((v1.entries || []).filter(e => e.archived).map(e => e.file + '::' + e.tag));
  const v2ArchWithTag = v2.entries.filter(e => e.archived && e.id);
  const v2ArchNoTag = v2.entries.filter(e => e.archived && !e.id);
  const v2ArchTagKeys = new Set(v2ArchWithTag.map(e => e.file + '::' + e.id));
  const archOnlyV1 = [...v1ArchTags].filter(k => !v2ArchTagKeys.has(k));
  const archOnlyV2 = [...v2ArchTagKeys].filter(k => !v1ArchTags.has(k));
  // Per FINAL-SPEC §5 C0 allowlist: for ARCHIVES the only allowed onlyV2 category is "v2 newly
  // recognizes an unclosed-`**` (tagless) entry" (handled separately below via v2ArchNoTag) — a
  // TAGGED archive entry v1 doesn't have at the same (file,tag) is NOT on that allowlist and stays red.
  for (const k of archOnlyV2) unexplained.push(`归档身份仅 v2 识别(带 tag)[${k}]，v1 同 (file,tag) 无对应条目 —— 不在 §5 allowlist 内(allowlist 只许无 tag 的新识别条目)`);
  for (const k of archOnlyV1) {
    // same category as the LIVE onlyV1 case: v1 has no ATTR_NS concept at all, so it happily takes
    // [user:*]/[agent:*]/[system:*]-shaped brackets as archive tags too; v2 correctly excludes them
    // from `id` everywhere (archived or not) — B8b itself is suppressed as a DIAGNOSTIC for archives
    // (§1.5, Opus H-6), but the underlying ns-exclusion rule is unchanged, so the explanation still is.
    const tagPart = k.split('::')[1] || '';
    const nsOfT = tagPart.split(':')[0];
    if (core.ATTR_NS.has(nsOfT)) {
      explained.push(`归档身份仅 v1 识别 [${k}] —— ns=${nsOfT} 属于 attribution 命名空间，v2 在归档里同样正确排除(§1.5 只免 B8b 诊断,不改变 id 判定规则)`);
    } else {
      unexplained.push(`归档身份仅 v1 识别 [${k}]，v2 同 (file,tag) 无对应条目(v2 应是 v1 归档 tag 集的超集,不应丢)`);
    }
  }
  if (v2ArchNoTag.length) {
    explained.push(`归档条目仅 v2 识别且无 tag(共 ${v2ArchNoTag.length} 条,§1.5 允许 tag 可缺,§5 allowlist 明确许可)—— v1 的正则要求闭 ** 后已有合法 [ns:tag] 才成条目,这些历史归档块(多为未闭合 ** 的旧记录)对 v1 完全不可见,不是 v2 凭空新增：${v2ArchNoTag.slice(0, 10).map(e => e.file + ':' + e.lineRange[0]).join(', ')}${v2ArchNoTag.length > 10 ? ' …' : ''}`);
  }

  // ── blocking summaries (different invariant sets by design — v2 has strictly more; report side
  //    by side, not a line-by-line diff. Flag only if v2 finds FEWER live-corpus problems than v1
  //    reported for the shared invariant families B1/B2.) ───────────────────────────────────────
  const v1B1 = (v1.blocking || []).filter(b => b.startsWith('B1 ')).length;
  const v1B2 = (v1.blocking || []).filter(b => b.startsWith('B2 ')).length;
  const v2B1 = v2.blocking.filter(b => b.startsWith('B1 ')).length;
  const v2B2prime = v2.blocking.filter(b => b.startsWith("B2' ")).length;
  if (v2B1 < v1B1) unexplained.push(`B1(悬空 Supersedes/Cause/Follows)v2 发现数(${v2B1}) < v1(${v1B1})——可能漏检`);
  if (v2B2prime < v1B2) unexplained.push(`B2/B2'(取代环)v2 发现数(${v2B2prime}) < v1(${v1B2})——可能漏检`);

  // ── summary ──────────────────────────────────────────────────────────────────────────────────
  console.log('pmm-manifest-shadow (v1 vs v2, real corpus, worktree):');
  console.log(`  v1: live=${v1.counts.live} archived=${v1.counts.archived} supersedeEdges=${v1.counts.supersedeEdges} blocking=${(v1.blocking || []).length}`);
  console.log(`  v2: live=${v2.entries.filter(e => !e.archived).length} archived=${v2.entries.filter(e => e.archived).length} supersedeEdges=${v2Edges.size} blocking=${v2.blocking.length} report=${v2.report.length}`);
  console.log(`  identity: onlyV1=${onlyV1.length} onlyV2=${onlyV2.length}`);
  console.log(`  edges: onlyV1=${edgesOnlyV1.length} onlyV2=${edgesOnlyV2.length}`);
  console.log(`  archive: v1 tagged=${v1ArchTags.size} v2 tagged=${v2ArchTagKeys.size}(onlyV1=${archOnlyV1.length} onlyV2=${archOnlyV2.length}) v2 无tag=${v2ArchNoTag.length}`);
  console.log('');
  console.log(`  解释清楚的差异（${explained.length}）:`);
  for (const e of explained) console.log('    ' + e);
  console.log('');
  if (unexplained.length) {
    console.log(`  ⛔ 未解释的差异（${unexplained.length}）——真正的红:`);
    for (const u of unexplained) console.log('    ' + u);
    console.log('');
    console.log(`✖ shadow 对照:${unexplained.length} 条意外差异`);
    process.exit(2);
  }
  console.log(`✅ shadow 对照零意外差异（identity onlyV1=${onlyV1.length} onlyV2=${onlyV2.length} / edges onlyV1=${edgesOnlyV1.length} onlyV2=${edgesOnlyV2.length}，全部可解释)`);
  process.exit(0);
}

main();
