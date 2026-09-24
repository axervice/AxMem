#!/usr/bin/env node
// PMM 统一 manifest(2026-09-14,codex review-20260914T015936Z 行动 2,Jax 批执行)
// 一次解析活体+归档六文件,产出每条目的结构化描述与取代图;回显/召回/退役/热度/淡忘
// 全部消费同一份,终结「多个脚本各自用正则解释同一格式」的漂移。
// 用法:
//   node pmm-manifest.cjs            人读摘要
//   node pmm-manifest.cjs --json     完整 JSON 到 stdout
//   node pmm-manifest.cjs --check    图不变量闸:BLOCKING 类问题存在 → exit 2
// 不变量(--check 拦截类,全确定性):
//   B1 Supersedes 目标在全库(含归档)无定义(悬空取代)
//   B2 取代图有环(head 追踪 ≤8 跳不收敛)
//   B3 Index 标记的取代者 ≠ 条目声明的取代者(记账自相矛盾)
// 报告类(不拦,列出):跨文件重复 tag(库内有「全文→同tag」双写惯例,不判死)、
//   非标格式取代标记(如「(superseded→澄清[…])」)。
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { resolveHome } = require('./pmm-recall-ledger.cjs');
const MEM = (process.env.PMM_MEM_DIR || resolveHome() + '/.claude/memory').replace(/\\/g, '/');
// B5 trigger path glob (2026-09-15 Jax 拍板加 glob;guards/specs/GLOB-TRIGGER-SPEC.md):这是**现役**
// 写入闸(pmm-entry-length-watch.sh --block 每次 Edit/Write 都会跑 `--check` 并把 ⛔ 行当拦截理由)。
// 9 条中段通配 trigger 今天正是因为这里从不校验星号位置/前缀长度才静默进库——星号语义唯一由
// pmm-trigger-recall.cjs 的 checkTriggerPathB5()/compileTriggerPath() 判断,这里不再自己写判断。
const { checkTriggerPathB5 } = require('./pmm-trigger-recall.cjs');
// R5-2 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md HIGH-2 /
// FABLE-2026-09-15-codex-cumulative-triage.md R5-2 requirement ②): this file's own trigger regex
// (formerly `TRIG_RE` below) accepted ANY string for `tool=` — `tool=([^;]+)` — and only ever
// validated the `path=` value via checkTriggerPathB5, never checking that `tool` is one of the
// controlled Edit|Write|MultiEdit|NotebookEdit values. A trigger corrupted to `tool=Edti` (e.g. by the
// write-gate's HIGH-2 fragment-edit bypass, independently fixed in pmm-trigger-write-gate.cjs) sailed
// through this — the CURRENT, live write-time gate — as a perfectly good trigger, while the recall
// engine's `tr.tools.includes(tool)` would never match it: a dead trigger the corpus itself reports as
// healthy. Converge on core.classifyTriggerLine — the SAME grammar parseFile()/the write gate use —
// so `tool` is controlled here too, and this file stops being a FOURTH private reimplementation of
// "what is a legal trigger comment".
const core = require('./pmm-core.cjs');

const FILES = ['decisions.md', 'lessons.md', 'standinginstructions.md', 'classes.md',
               'decisions-archive.md', 'lessons-archive.md', 'standinginstructions-archive.md'];
// B6 分类法(2026-09-14):每条 live 教训一行 `Class: [[class:x]]`,x 必须在 classes.md 定义;
// 2026-09-15 起新条目缺类=拦(旧条目 09-14 已全量补种,覆盖率进 canary/dream)。
const CLASS_RE = /^Class:\s*\[\[(class:[a-z0-9-]+)\]\]\s*$/;
const CLASS_REQUIRED_FROM = '2026-09-15';

const entries = [];          // {tag,file,line,title,date,soleRecord,trust,links,triggers,supersedes,archived}
const byTag = new Map();     // tag -> [entries]
const idxMarker = new Map(); // tag -> {to, raw, nonstandard}
// R8-2 fix (2026-09-15 round 8, guards/audits/OPUS-2026-09-15-round8-review.md MEDIUM-1): collected here
// (rather than pushed straight into `blocking`) because `blocking`/`report` aren't declared until AFTER
// this FILES loop runs — consumed just below their declaration.
const unclosedFences = []; // [{file, line}] — file ends with inFence still true

for (const f of FILES) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  const lines = s.split(/\r?\n/);
  let cur = null;
  let inFence = false; // R5-2 fix: fence state for trigger-line judgment below (parseFile-consistent)
  let fenceStartLine = null; // R8-2 fix: the fence's OPENING line, so an unclosed-fence diagnostic can
                             // point at where to fix it (EOF is never useful) — mirrors core.parseFile's
                             // own fenceStartLine bookkeeping (pmm-core.cjs, the B32 diagnostic).
  const flush = (endIdx) => {
    if (!cur) return;
    cur.endLine = endIdx;
    cur.blockHash = crypto.createHash('sha256').update(cur._body.join('\n')).digest('hex').slice(0, 16);
    delete cur._body;
    entries.push(cur);
    if (!byTag.has(cur.tag)) byTag.set(cur.tag, []);
    byTag.get(cur.tag).push(cur);
    cur = null;
  };
  lines.forEach((line, i) => {
    const wasFence = inFence;
    if (core.FENCE_RE.test(line)) { inFence = !inFence; if (inFence) fenceStartLine = i + 1; }
    // R7-2 fix (2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md MEDIUM-1 /
    // FABLE-2026-09-15-codex-cumulative-triage.md R5-... ): `wasFence` used to gate ONLY the trigger-
    // line classification below (:98 as it was) — every OTHER construct this loop recognizes (entry
    // headers, `## ` section flushes, Index `- 20` bullets, Class:, Supersedes:, and [[link]] scanning)
    // was fence-BLIND, even though the top-of-file comment on the trigger branch claimed this file
    // "mirrors core.parseFile()'s wasFence skip" — that claim was only ever true for triggers. A fenced
    // DOCUMENTATION EXAMPLE showing what a well-formed entry looks like (entry header + a Class: line +
    // a Supersedes: line, inside a ``` block, e.g. illustrating "教训该长什么样") was parsed by this
    // file as a REAL entry — producing spurious B1 (dangling Supersedes target)/B4 (Index/entry
    // mismatch, ×2: the fenced tag has no real Index row, AND its real title/entry may itself now look
    // duplicated)/B6 (Class target undefined) blocking failures on a --check run that core.parseFile()
    // itself sees as perfectly clean (repro: pmm-manifest-fence-repro.cjs). Gate all six remaining
    // constructs the exact same way the trigger branch already was — full parity with parseFile's own
    // fence handling, not just for the one construct that happened to get it first.
    const h = !wasFence && line.match(/^\*\*((20[0-9-]{8})[^*]*)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
    if (h) {
      flush(i);
      cur = { tag: h[3], file: f, line: i + 1, endLine: null, title: h[1].slice(0, 60), date: h[2],
              soleRecord: line.includes('[sole-record]'),
              trust: (line.match(/\[trust:([a-z-]+)\]/) || [])[1] || null,
              links: [], triggers: [], badTriggers: [], classes: [], badClass: [], supersedes: [], archived: f.includes('-archive'),
              _body: [line] };
      return;
    }
    if (!wasFence && /^## /.test(line)) flush(i);
    if (!wasFence && line.startsWith('- 20')) {
      // 注意:POSIX 的 [^][] 在 JS 里含义完全不同([^]=任意字符)——必须写 [^\]\[]
      const own = line.match(/^- 20[^\]\[]*\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
      if (own && /superseded→/.test(line)) {
        const std = line.match(/superseded→\[([A-Za-z0-9:._-]+)\]/);
        if (std) {
          let to = std[1];
          if (!to.includes(':')) to = own[1].split(':')[0] + ':' + to;
          idxMarker.set(own[1], { to, nonstandard: false });
        } else {
          idxMarker.set(own[1], { to: null, nonstandard: true, raw: line.slice(0, 80) });
        }
      }
      return;
    }
    if (!cur) return;
    cur._body.push(line);
    // R5-2 fix (2026-09-15 round 5, requirement ②): converge on core.classifyTriggerLine instead of a
    // private TRIG_RE that accepted ANY string for `tool=` — see the top-of-file comment for the full
    // repro. Fence-aware: a trigger-shaped line inside a fenced doc example is not evidence of
    // anything, live or dead (this was the ONE construct this file already gated by `wasFence` before
    // round 7 — see the comment above the `wasFence`/`inFence` toggle for the other six).
    if (!wasFence) {
      let trigRes = null;
      try { trigRes = core.classifyTriggerLine(line); } catch { trigRes = null; }
      if (trigRes) {
        if (trigRes.ok) {
          const tr = trigRes.trigger;
          if (tr.kind === 'path') {
            // B5(2026-09-14 自查,2026-09-15 补 glob 前缀策略):trigger 注释写错格式 = 静默死触发。
            // 当天 4 条新种的 trigger 全是 `path=…; path=…` 形态,推送端 matched=0 且无人报;09-15 又
            // 实证 9 条中段通配 trigger 同样静默死(星号语义写时从不校验)——两类都得在写入时拦下。
            const b5 = checkTriggerPathB5(tr.path);
            if (b5.ok) cur.triggers.push({ tools: tr.tools.join('|'), repo: tr.repo, path: tr.path });
            else cur.badTriggers.push(line.trim().slice(0, 80) + '  — ' + b5.reason);
          } else if (tr.kind === 'cmd') {
            // cmd-form (tool=Bash; repo=; cmd=): classifyTriggerLine already enforces the repo=* exe
            // denylist — a legal cmd-form trigger is not this engine's concern (path-based recall only)
            // but must not be misreported as bad either.
            cur.triggers.push({ tools: tr.tools.join('|'), repo: tr.repo, cmd: tr.exe + (tr.sub ? ' ' + tr.sub : '') });
          }
          // 2026-09-17: kind==='none' (核心决策 [memory:trigger-plant-at-write-fine-grained] 的显式
          // 「判断过、答不出确定性判据、故意不种」逃生口——已在真实 lessons.md 里出现,见
          // [tooling:edit-tool-read-state-lost-after-compaction]) 既不是可推送的 path/cmd trigger,
          // 也不是格式错误——不进 cur.triggers(它不该被当真 trigger 推送),也不进 cur.badTriggers
          // (它是合法的、有记录理由的弃权,不该报 B5)。之前这里是 if/else 二选一,把 kind==='none'
          // 误当 cmd-form 处理,在 tr.tools 上炸(TypeError:kind==='none' 没有 tools 字段)——
          // 这个分支本身之前从未被走到过(旧语法下 `trigger: none` 还没被 classifyTriggerLine 认成
          // 合法,一直落在下面的 else trigRes.ok===false 分支里报 B5),核心语法一放开就立刻暴露。
        } else {
          cur.badTriggers.push(line.trim().slice(0, 80) + '  — ' + trigRes.reason);
        }
      }
    }
    // R7-2 fix: Class:/Supersedes:/[[link]] scanning gated the same way — see the comment above the
    // `wasFence`/`inFence` toggle.
    if (!wasFence) {
      const cm = line.match(CLASS_RE);
      if (cm) cur.classes.push(cm[1]);
      else if (/^\s*Class:/i.test(line)) cur.badClass.push(line.trim().slice(0, 80));
      if (/^\s*Supersedes:/.test(line))
        for (const m of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) cur.supersedes.push(m[1]);
      else
        for (const m of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) if (!cur.links.includes(m[1])) cur.links.push(m[1]);
    }
  });
  flush(lines.length);
  // R8-2 fix (2026-09-15 round 8, guards/audits/OPUS-2026-09-15-round8-review.md MEDIUM-1): the six
  // `!wasFence` gates round 7 added correctly SKIP an in-fence construct, but core.parseFile() pairs
  // that skip with a closing-side check this file never copied — B32 (file ends with `inFence` still
  // true ⇒ blocking; grep for `B32` across this file before this fix returned zero hits, while
  // pmm-core.cjs's parseFile() has carried it since round... see pmm-core.cjs's own B32 comment).
  // Without this, a forgotten closing ``` doesn't just hide the one fenced example (as before round
  // 7) — it makes EVERY REAL ENTRY after it in the file invisible to B1/B4/B5/B6/B23 too, since
  // `wasFence` stays true for the rest of the file. That is a STRICTLY LARGER blind spot than the one
  // R7-2 closed, and this is the CURRENT, live write gate (pmm-entry-length-watch.sh:172 treats this
  // file's `⛔` count as its blocking signal) — silently swallowing every later entry's B-checks on a
  // typo'd fence is worse than the fenced-example false positive R7-2 fixed. Record it per-file here;
  // pushed into `blocking` once that array exists (declared after this whole FILES loop), below.
  if (inFence) unclosedFences.push({ file: f, line: fenceStartLine });
}

// ── 取代图 ──
const supDecl = new Map(); // old -> Set(new)(条目声明,权威)
for (const e of entries) for (const old of e.supersedes) {
  if (!supDecl.has(old)) supDecl.set(old, new Set());
  supDecl.get(old).add(e.tag);
}
const supNext = new Map(); // 声明 ∪ 标记(供 head 追踪)
for (const [k, v] of supDecl) supNext.set(k, new Set(v));
for (const [old, m] of idxMarker) if (m.to) {
  if (!supNext.has(old)) supNext.set(old, new Set());
  supNext.get(old).add(m.to);
}

const blocking = [], report = [];
// B32(2026-09-15 round 8,R8-2 修法,guards/audits/OPUS-2026-09-15-round8-review.md MEDIUM-1):文件末尾
// 未闭合围栏 ⇒ 阻断,与 pmm-core.cjs 的 parseFile() 对齐(见上面 FILES 循环末尾 unclosedFences 的收集
// 注释)。诊断指向围栏的**起始行**(不是 EOF),方便定位去补 ```。
for (const uf of unclosedFences)
  blocking.push(`B32 ${uf.file}:${uf.line} 文件末尾未闭合围栏(起于第 ${uf.line} 行),其后全部条目(Index/Class/Supersedes/trigger/链)对本闸不可见——先补闭合围栏再看其余诊断`);
// B1 悬空取代目标
for (const e of entries) for (const old of e.supersedes)
  if (!byTag.has(old)) blocking.push(`B1 ${e.file}:${e.line} [${e.tag}] Supersedes 悬空目标 [[${old}]](全库无定义)`);
// B3 标记/声明矛盾:标记指向的取代者不在任何条目的声明集里(声明是权威;标记只是记账)
for (const [old, mk] of idxMarker) {
  if (!mk.to) continue;
  const decl = supDecl.get(old);
  if (decl && decl.size > 0 && !decl.has(mk.to))
    blocking.push(`B3 [${old}] Index 标记指 [${mk.to}] 但条目声明的取代者是 [${[...decl].join(',')}](记账矛盾)`);
}
// B2 环:head 追踪
function headOf(tag) {
  let t = tag; const seen = new Set();
  for (let i = 0; i < 8; i++) {
    if (seen.has(t)) return { head: null, cycle: true };
    seen.add(t);
    const nx = supNext.get(t);
    if (!nx || nx.size === 0) return { head: t, cycle: false };
    t = [...nx].sort().pop(); // 多分叉取字典序最新——分叉本身进 report
    if (nx.size > 1) report.push(`FORK [${[...seen].pop() || tag}] 有多个取代者:${[...nx].join(',')}`);
  }
  return { head: t, cycle: false };
}
const heads = {};
for (const old of supNext.keys()) {
  const r = headOf(old);
  if (r.cycle) blocking.push(`B2 [${old}] 取代链成环`);
  else heads[old] = r.head;
}
// 报告类
// attribution 族命名空间(system:/user:/agent:)是"谁写的"不是"这条是谁",旧归档大量复用,不算重复身份
// B4 双射(2026-09-14 fab 进化1):奇偶只数行数——给新条配任意 `- 20` 行即平账。
// 升级为集合相等:decisions/lessons 各自的 Index own-tag 集 == live 条目身份集。
for (const f of ['decisions.md', 'lessons.md']) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  const idxTags = new Set(), entTags = new Set();
  let inIdx = false;
  for (const line of s.split(/\r?\n/)) {
    if (/^## Index/.test(line)) { inIdx = true; continue; }
    if (/^## Entries/.test(line)) { inIdx = false; continue; }
    if (inIdx) {
      const m = line.match(/^- 20[^\]\[]*\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
      if (m) idxTags.add(m[1]);
    }
  }
  for (const e of entries) if (e.file === f) entTags.add(e.tag);
  const missIdx = [...entTags].filter(t => !idxTags.has(t));
  const missEnt = [...idxTags].filter(t => !entTags.has(t));
  for (const t of missIdx) blocking.push(`B4 ${f} 条目 [${t}] 没有自己的 Index 行(数数平账≠双射)`);
  for (const t of missEnt) blocking.push(`B4 ${f} Index 行 [${t}] 没有对应条目`);
}
// B5 trigger 格式 + glob 前缀策略(唯一实现见 pmm-trigger-recall.cjs 的 checkTriggerPathB5/
// compileTriggerPath;§GLOB-TRIGGER-SPEC.md):形态须合 tool=;repo=;path=|cmd= 三段,且 path 须能
// 通过 compileTriggerPath 编译、首个 `*` 前字面前缀 ≥3 字节且不以 `/` 起。
for (const e of entries) if (!e.archived) for (const raw of e.badTriggers)
  blocking.push(`B5 ${e.file} [${e.tag}] trigger 不合法(格式或 §GLOB-TRIGGER-SPEC 前缀规则),推送端会跳过/静默失效:${raw}`);
// B6 分类法:Class 形态严格、目标必须在 classes.md、一条只一类;lessons.md 新条目(≥ CLASS_REQUIRED_FROM)必须有类
const classDefs = new Set(entries.filter(e => e.file === 'classes.md').map(e => e.tag));
let unclassifiedLessons = 0;
for (const e of entries) {
  if (e.archived || e.file === 'classes.md') continue;
  for (const raw of e.badClass) blocking.push(`B6 ${e.file} [${e.tag}] Class 行非标形态(唯一合法:Class: [[class:<id>]]):${raw}`);
  for (const c of e.classes) if (!classDefs.has(c)) blocking.push(`B6 ${e.file} [${e.tag}] Class 目标 [${c}] 未在 classes.md 定义(受控词表,先加类再引用)`);
  if (e.classes.length > 1) blocking.push(`B6 ${e.file} [${e.tag}] 多于一个 Class 行(一条一主类,次类走 [[链]])`);
  if (e.file === 'lessons.md' && e.classes.length === 0) {
    unclassifiedLessons++;
    if (e.date >= CLASS_REQUIRED_FROM) blocking.push(`B6 lessons.md [${e.tag}] 新教训缺 Class: 行(从 classes.md 选类,没有合适的就同笔加类)`);
    else report.push(`UNCLASSIFIED lessons.md [${e.tag}] 旧教训尚未归类`);
  }
}

const ATTR_NS = new Set(['system', 'user', 'agent']);
for (const [tag, arr] of byTag) {
  if (ATTR_NS.has(tag.split(':')[0])) continue;
  if (arr.length > 1 && new Set(arr.map(a => a.file.replace('-archive', ''))).size > 1)
    report.push(`DUP [${tag}] 定义于 ${arr.map(a => a.file + ':' + a.line).join(' 与 ')}(库内双写惯例,自查是否都该在)`);
}
for (const [tag, m] of idxMarker) if (m.nonstandard) report.push(`NONSTD [${tag}] 取代标记非标格式:${m.raw}`);

const out = {
  asOf: new Date().toISOString().slice(0, 10),
  counts: { entries: entries.length, live: entries.filter(e => !e.archived).length, archived: entries.filter(e => e.archived).length, supersedeEdges: supNext.size,
            classes: classDefs.size, unclassifiedLessons },
  heads, blocking, report,
  entries,
};

if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(out)); process.exit(blocking.length ? 2 : 0); }
console.log(`pmm-manifest as-of ${out.asOf}: entries=${out.counts.entries}(live ${out.counts.live}/arch ${out.counts.archived}) 取代边=${out.counts.supersedeEdges}`);
for (const b of blocking) console.log('  ⛔ ' + b);
for (const r of report.slice(0, 20)) console.log('  ℹ️ ' + r);
if (process.argv.includes('--check')) process.exit(blocking.length ? 2 : 0);
