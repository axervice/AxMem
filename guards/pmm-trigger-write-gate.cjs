#!/usr/bin/env node
// pmm-trigger-write-gate.cjs — PreToolUse write-time interceptor for trigger comments (2026-09-15).
// Fable HIGH-5 fix (guards/audits/FABLE-2026-09-15-glob-review-triage.md finding 5 /
// CODEX-2026-09-15-glob-spec-review.md finding 5): the ONLY existing enforcement of trigger-comment
// legality (B5) used to run at PostToolUse — by the time it fires, the Edit/Write/MultiEdit has
// ALREADY landed on disk; if the session is aborted or the error is ignored, a bad trigger stays in
// the live corpus. This hook validates the PROSPECTIVE new content of an Edit/Write/MultiEdit that
// targets a canonical memory file BEFORE the tool is allowed to run, using core.classifyTriggerLine()
// — the EXACT SAME judgment parseFile() applies at read time (extracted specifically so there is only
// ever one implementation of "what makes a trigger comment legal", never a second one here).
//
// fail-OPEN on anything that is not itself a confirmed illegal trigger (unreadable/unparseable stdin,
// no file_path, target outside the canonical memory dir, no trigger-shaped line in the prospective
// text) — this hook's matcher is Edit|Write|MultiEdit repo-wide, so a plumbing hiccup here must never
// block an unrelated file edit anywhere else in the tree. It fails CLOSED only for the one case this
// exists for: a trigger-comment-shaped COMPLETE line, outside a fenced code block, inside prospective
// content for one of core.ALL_FILES (the only files parseFile() ever treats as trigger-bearing
// corpus), that does not pass classifyTriggerLine.
//
// 2026-09-15 round 2 (Opus O-6/O-7, guards/audits/OPUS-2026-09-15-repair-review.md): the original
// scope was "any .md under the memory dir" — which caught non-corpus files (processes.md, dreams/*.md)
// that parseFile() never even looks at, and did not skip fenced-code-block examples, so writing
// documentation THAT DISCUSSES a bad trigger shape (fenced, or in a file pmm-core never parses) got
// denied. Separately, a RELATIVE file_path never matched the absolute `canonical` prefix and sailed
// through unchecked — the same gate was simultaneously too strict (O-6) and too permissive (O-7).
// Fixed: scope narrowed to core.ALL_FILES basenames only; fence-tracking skips code-block interiors
// (mirrors parseFile()'s own inFence handling); a fragment that isn't a complete line (the first/last
// segment of a multi-line new_string, or a single-segment new_string) is judged ONLY when it is
// self-contained (`<!-- trigger: ... -->` opens AND closes within that one segment) — never on a half
// line; relative file_path is resolved against the hook payload's own `cwd` before the scope check.
//
// Escape hatch (O-6 requirement: a recorded, deliberate way out — never a silent one): set
// PMM_TRIGGER_WRITE_GATE_DISABLE=1 in the environment the hook runs under to fail this hook open
// unconditionally. This is NOT a silent bypass — using it is a deliberate operator action, same spirit
// as PMM_CANONICAL_MEMORY overriding where "canonical" points.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
// part13 收口(2026-09-17):resolveHome() 是唯一被允许直读 HOME/USERPROFILE/os.homedir() 的解析器
// (pipe-gate-v2-acceptance.cjs self-check part13 逐行扫描——扫的是字面出现,不理解"这是安全兜底",
// 所以本文件不能在任何分支里再留一份 os.homedir()/HOME/USERPROFILE 字面读,连兜底路径也不行)。
// 这里单独 require 叶子模块本身(而不是等下面才 require 的 pmm-core.cjs),因为下面这段逃生口
// 特意排在全文件最前面尽早 fail-open,不该为了它去加载 pmm-core.cjs 那么重的模块。require 失败
// 时让下面调用 ledger.resolveHome() 自然抛出,被那段既有的 try/catch 接住(注释already says
// "logging must never itself block the deliberate fail-open path")——退化成"这次没记日志",
// 但逃生口本身(stderr 提示 + exit 0)照常生效,不新增一条直读兜底。
let ledger = null;
try { ledger = require(path.join(__dirname, 'pmm-recall-ledger.cjs')); } catch { /* ledger unresolved; the caller's own try/catch below degrades gracefully */ }

if (process.env.PMM_TRIGGER_WRITE_GATE_DISABLE === '1') {
  // R-5 fix (2026-09-15 round 3, guards/audits/OPUS-2026-09-15-round2-review.md "R-5"): this used to
  // exit(0) before reading stdin with NO stdout/stderr/log output at all (confirmed: raw output on
  // this path was the empty string) — directly contradicting the comment above ("This is NOT a silent
  // bypass"). "Deliberate" (the operator had to explicitly set the env var) is not the same as
  // "observable" (nothing anywhere records that it fired): once this variable lands in settings.json's
  // `env` or a profile, the gate goes permanently and invisibly dark — the same unobservability class
  // O-5 named for a different guard ("造好没通电"). Fix: always write one line to stderr (visible in
  // hook logs/transcripts) AND append one line to the SAME trigger-log the recall engine already
  // writes to (pmm-trigger-recall.cjs's LOG convention — one shared file, reviewed monthly per spec
  // §3.1's dream step) so the escape hatch shows up there too. Log path is overridable via
  // PMM_TRIGGER_LOG (same env var pmm-trigger-recall.cjs honors) so self-tests stay hermetic.
  // MEDIUM-N1 (2026-09-17/18, Opus 增量核冻结 cb70d64): the default here used to be the FROZEN legacy
  // path (memory/dreams/trigger-log-<mach>.tsv) -- that file is a committed historical artifact as of
  // the ledger migration (see its own header / memory/dreams/trigger-log-<host>.contaminated-keys.txt)
  // and nothing should write to it going forward (guard-canary.sh's own
  // check_trigger_log_legacy_not_recontaminated treats ANY growth there as contamination). This hook
  // was the one remaining writer still defaulting there. pmm-trigger-recall.cjs's own migrated LOG
  // convention is `ledger.resolveRoot() + '/trigger-log-' + mach + '.tsv'` -- match it exactly (same
  // resolver, same join, so a future root override affects both writers identically) rather than
  // re-deriving a path from resolveHome().
  try {
    const mach = (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
    const root = String((ledger && ledger.resolveRoot()) || '').replace(/\\/g, '/');
    const logPath = (process.env.PMM_TRIGGER_LOG || (root + '/trigger-log-' + mach + '.tsv')).replace(/\\/g, '/');
    const line = [new Date().toISOString(), '-', 'write-gate-disabled', '-', '-', '-', '-', 'PMM_TRIGGER_WRITE_GATE_DISABLE=1'].join('\t') + '\n';
    fs.appendFileSync(logPath, line);
  } catch { /* logging must never itself block the deliberate fail-open path */ }
  process.stderr.write('pmm-trigger-write-gate: PMM_TRIGGER_WRITE_GATE_DISABLE=1 —— 本次写入跳过了 trigger 写时闸判断(逃生口生效,已记入本机 trigger-log,非静默)\n');
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0); // the JSON payload IS the decision (matches guards/model-guard.sh's convention) — exit 0 either way
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
if (!raw) process.exit(0);
let data;
try { data = JSON.parse(raw); } catch { process.exit(0); }

const ti = data.tool_input || {};
let fp = String(ti.file_path || '');
if (!fp) process.exit(0);
let core;
try {
  core = require(path.join(__dirname, 'pmm-core.cjs'));
} catch {
  // AxMem Pro module (guards/pmm-core.cjs) is not part of the free/open-core tier this file ships
  // in -- see README's "guards/ is legacy/reference" section for what is and is not wired into
  // bin/axmem. This guard is a no-op in this install BY DESIGN, not a silent accident -- print that
  // once so anyone running this file standalone sees why, instead of it just doing nothing.
  process.stderr.write('[pmm-trigger-write-gate] AxMem Pro module guards/pmm-core.cjs not present in this (free-tier) install -- no-op.\n');
  process.exit(0);
}
// HIGH-2 fix (2026-09-17, fab 盲攻 + Opus 复现): strip a Windows device-namespace prefix
// (`\\?\` / `\\.\`) FIRST, before path.resolve/any other processing — path.resolve and
// path.win32.normalize both MANGLE a raw `\\?\C:\…` string into garbage if it reaches them with the
// marker still attached (confirmed: `path.resolve('\\\\?\\C:\\x')` → `C:\\?C:x`, losing the directory
// structure entirely), and fs.readFileSync on a forward-slash-converted `//?/C:/…` does not resolve
// to the real file either. Doing this once, up front, means every later use of `fp` (scope check,
// basename, fs.readFileSync) operates on a normal, comparable path — not three different mangled
// forms depending on which line touches it first.
// MEDIUM-N3 (2026-09-17/18, Opus 增量核冻结 cb70d64): widened from just the device-namespace strip
// to the FULL shared pipeline (core.normalizeWin32PathForCompare) — a trailing `.`/` ` on the last
// path segment (`lessons.md.`/`lessons.md `, Windows silently strips these for real I/O) and a
// `\\?\UNC\<localhost>\<letter>$\…` administrative-share device path (equivalent to `<letter>:\…`)
// both used to reach `fp.slice(fp.lastIndexOf('/') + 1)` below UNCHANGED, so `basename` came out as
// something core.ALL_FILES does not literally contain even though the ACTUAL on-disk write (performed
// entirely outside this gate, by Windows itself) lands in the real canonical file — out-of-scope
// exit(0) on a write that is, in reality, in scope. Same up-front rationale as above: do it once, so
// scope check/basename/fs.readFileSync all see the one already-canonicalized form.
fp = core.normalizeWin32PathForCompare(fp);
// O-7: resolve a relative file_path against the hook payload's own `cwd` BEFORE the scope check —
// previously a relative path never matched the absolute `canonical` prefix and exited 0 unconditionally
// (silent full bypass), regardless of what it actually pointed at.
try {
  if (!path.isAbsolute(fp)) fp = path.resolve(String(data.cwd || process.cwd()), fp);
} catch { process.exit(0); }

// HIGH-2 fix (2026-09-17, fab 盲攻 + Opus 复现): the old `\→/` + drive-letter-lowercase + string
// prefix/equality compare below let `\\?\C:\…` (Windows device-namespace prefix), `C://Users/…`
// (doubled slashes), and a `.` segment embedded inside what should be the canonical prefix all fail
// the prefix match and exit 0 (silently out-of-scope, i.e. unchecked) even though each one genuinely
// resolves to a file inside the canonical memory dir. Replaced with core.matchCanonical(), built on the
// same resolveCanonicalMatch() pmm-entry-length-watch.sh's own scope pre-filter helper calls via
// core.isUnderCanonical() — one shared judgment, not two — see that function's header comment in
// pmm-core.cjs for the vendored path-is-inside / normalize-path provenance.
//
// M-2 root cause (c) fix (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md M-2; confirmed —
// `//?/UNC/localhost/c$/…` and 4 other admin-share/device-namespace spellings ALLOWed via the Edit path
// specifically): this used to re-derive `fp` for the basename/read-path by hand
// (`fp.replace(/\\/g,'/').replace(/\/{2,}/g,'/')`) AFTER the scope check already passed — that manual
// collapse treated a UNC path's REQUIRED leading `\\` as "just more redundant slashes" and squashed it
// to a single `\`, so the write correctly passed scope but then fs.readFileSync() below failed
// (ENOENT on the now-malformed path), the reconstruction ran against an empty "current" file, and
// there was nothing left to judge — a scope-check PASS that silently became a no-op ALLOW. matchCanonical()'s
// `resolvedPath` is already the win32-normalized, fixed-point-stabilized, UNC-safe form — used
// directly below, no second hand-rolled collapse.
//
// L-4 fix (guards/audits/OPUS-2026-09-23-a2-a5-review.md L-4; confirmed — a hard link, `mklink /H`, no
// elevation required, pointing AT a canonical file but named something else entirely was judged
// out-of-scope and ALLOWed, because the old basename came from the LEXICAL `fp` only): matchCanonical()'s
// basename resolves through realpath/hard-link identity too, so a reparse point or hard link whose OWN
// name differs from the canonical file it targets is still judged as that canonical file.
const canonical = process.env.PMM_CANONICAL_MEMORY || (core.homeDir() + '/.claude/memory');
const match = core.matchCanonical(fp, canonical);
if (!match.inScope) process.exit(0); // not a canonical memory file — out of scope
fp = match.resolvedPath;
const basename = match.basename;
// O-6: scope narrowed from "any .md" to exactly the 7 files parseFile()/classifyTriggerLine's caller
// (core.ALL_FILES) ever treats as trigger-bearing corpus — processes.md, memory.md, dreams/*.md etc.
// are never parsed for triggers at read time, so denying a write to them was pure false-positive risk.
if (!core.ALL_FILES.includes(basename)) process.exit(0);

// R5-2 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md HIGH-2 /
// FABLE-2026-09-15-codex-cumulative-triage.md R5-2, requirement ①): the previous implementation
// judged each Edit/Write/MultiEdit `new_string`/`content` PART in isolation, never reconstructing what
// the file's actual resulting bytes would be — an edge fragment that did not itself look like a
// complete/self-contained trigger line was skipped entirely (`isEdge && !looksSelfContainedTrigger`).
// Confirmed repro: a corpus file already has a legal line `<!-- trigger: tool=Edit; repo=home;
// path=... -->`; submit `old_string:"Edit", new_string:"Edti"` — neither string looks trigger-shaped
// on its own, the whole edit is a single self-contained segment that fails looksSelfContainedTrigger,
// so it was never judged, and the tool call was silently allowed even though it turns a legal trigger
// line into `tool=Edti` — a dead trigger accepted by pmm-manifest.cjs's loose regex (R5-2 also fixed
// separately below) and never matched by the recall engine's `tools.includes()`.
//
// Fix: stop judging fragments at all. Read the file's CURRENT on-disk bytes, apply this exact
// Edit/MultiEdit/Write the same way the real tool would (sequential old_string→new_string replacement,
// or Write's full-content replacement), and run the reconstructed PROSPECTIVE FULL FILE through
// core.parseFile() — the SAME authoritative, fence-aware parser read-time trigger enforcement and the
// recall engine are supposed to agree with (R5-7 below closes the recall engine's own gap against this
// same authority). A local edit that corrupts an existing legal trigger line elsewhere in the file is
// now caught because the reconstructed full line is what gets classified, not an isolated fragment.
function reconstructProspective(currentRaw, ti) {
  if (typeof ti.content === 'string') return Buffer.from(ti.content, 'utf8'); // Write: replaces the whole file
  let text = currentRaw.toString('utf8');
  const editList = Array.isArray(ti.edits) ? ti.edits
    : (typeof ti.old_string === 'string' ? [{ old_string: ti.old_string, new_string: ti.new_string, replace_all: ti.replace_all }] : []);
  for (const e of editList) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || e.old_string === '') continue;
    if (e.replace_all) { text = text.split(e.old_string).join(e.new_string); continue; }
    const idx = text.indexOf(e.old_string);
    if (idx === -1) continue; // can't locate this old_string — the real tool call would itself fail here; nothing to reconstruct
    text = text.slice(0, idx) + e.new_string + text.slice(idx + e.old_string.length);
  }
  return Buffer.from(text, 'utf8');
}

const hasEditableInput = typeof ti.content === 'string' || typeof ti.old_string === 'string' || Array.isArray(ti.edits);
if (!hasEditableInput) process.exit(0);

let currentRaw;
try {
  const onDisk = fs.readFileSync(fp);
  currentRaw = core.stripBOM(onDisk).buf;
} catch { currentRaw = Buffer.alloc(0); } // file doesn't exist yet (e.g. a Write creating it) — empty "current" is fine

const prospective = reconstructProspective(currentRaw, ti);
let parsed;
try { parsed = core.parseFile(basename, prospective); } catch { process.exit(0); } // never fail-closed on a parser quirk
// B5 = the illegal-trigger diagnostic itself. B32 (unclosed fence at EOF) is also blocked here: ground
// truth is now available (the reconstructed FULL file, not a fragment), so if this exact write leaves
// a fence genuinely open through EOF, parseFile's OWN comment says why that matters — "其后内容可能被
// 静默吞掉" — which silently hides everything after it (trigger comments included) from BOTH this
// gate's future judgments and the read-time parser alike. Refusing it here is strictly stronger than
// the old fragment-based approach's conservative "judge when in doubt", now backed by certainty
// instead of a guess.
const bad = (parsed.diagnostics || []).filter((d) => d.code === 'B5' || d.code === 'B32');
if (bad.length > 0) {
  deny(
    `pmm-trigger-write-gate:本次写入(重建拼接后的完整文件,经 core.parseFile 权威解析)含 ${bad.length} 处问题(B5 非法 trigger / B32 未闭合围栏,写时拦截,` +
    `guards/audits/FABLE-2026-09-15-glob-review-triage.md HIGH-5;R5-2 片段拼回修正见 ` +
    `guards/audits/CODEX-2026-09-15-cumulative-review.md HIGH-2)——修正后再写(误拦可设 ` +
    `PMM_TRIGGER_WRITE_GATE_DISABLE=1 逃生,但须记录原因):\n` +
    bad.slice(0, 5).map((d) => `  - [${d.code}] L${d.line}: ${(d.raw || '').slice(0, 160)} —— ${d.reason}`).join('\n')
  );
}

// ── trigger-presence gate (2026-09-17,the maintainer 派活;决策 [memory:trigger-plant-at-write-fine-grained]
// 「写教训须同笔种 trigger,答不出确定性判据的可不种」——现状写时只有纪律没有在场闸,规则自己在
// 衰减:lessons.md 239 条只 34 条带 trigger,同一天新增 40+ 条零 trigger。上面的 B5/B32 只校验 trigger
// 注释的语法合不合法,从不检查一条**新**条目里到底有没有 trigger 注释——这段补那道闸。
//
// 判「新增」:比较这次重建出的 prospective 与磁盘上的 current 两次 core.parseFile() 结果,用标题字段
// (dateISO+dateRaw+title+tail 拼串)当 key——同一条目在两次解析里由同一算法拼出同一个 key,足够当
// 「是不是同一条」的判据,不需要真实 identity tag(很多条目没有)。出现在 prospective 但不在 current
// 里的条目 = 这次写入新增的;只对这些条目生效。**存量条目不追溯**——哪怕这次编辑改写了某条存量条目
// 的整段正文,只要它的标题行没变,就不在此列(the maintainer 原话要求,否则这道闸一上线就会堵住所有对旧条目的
// 日常编辑)。范围只到 lessons.md/decisions.md/standinginstructions.md(LIVE_FILES 减 classes.md)——
// B5/B32 的 ALL_FILES 范围更宽(还含 archive 与 classes.md),但「写教训该种 trigger」这条规矩本就不
// 适用于分类表和已封存归档,没有 the maintainer 点名要求就不越权去管。
//
// 「在场」= 该条目里存在至少一行合法 trigger(core.classifyTriggerLine 判过、kind=path/cmd,即
// entry.triggers.length>0),或存在一行显式的 `<!-- trigger: none; 理由=<非空> -->`(kind=none,即
// entry.triggerNone 非空——core.classifyTriggerLine 里理由为空的 none 已经在语法层被当非法 trigger
// 由上面的 B5 挡掉,不会漏到这里)。两者都没有 ⇒ 拦。
//
// fail-open 原则与上面 B5/B32 一致:解析磁盘上 current 文件失败(极端情况,如文件在两次读取之间被
// 别的进程改动)不拦——唯一会拦的是「确认新增且确认两种在场形式都没有」这一种情况,绝不在不确定时
// 拦一次不相关的编辑。
const PRESENCE_FILES = new Set(['lessons.md', 'decisions.md', 'standinginstructions.md']);
function titleKey(e) { return [e.dateISO, e.dateRaw, e.title, e.tail].join('\u0000'); }
if (PRESENCE_FILES.has(basename)) {
  try {
    const currentParsed = core.parseFile(basename, currentRaw);
    const existingKeys = new Set(currentParsed.entries.map(titleKey));
    const missing = parsed.entries.filter((e) => {
      if (existingKeys.has(titleKey(e))) return false; // 存量条目,不追溯
      const hasLegal = Array.isArray(e.triggers) && e.triggers.length > 0;
      const hasNone = !!e.triggerNone;
      return !hasLegal && !hasNone;
    });
    if (missing.length > 0) {
      deny(
        `pmm-trigger-presence-gate:本次写入新增了 ${missing.length} 条条目,缺 <!-- trigger: ... --> 行` +
        `(2026-09-13 the maintainer [memory:trigger-plant-at-write-fine-grained]「写教训同笔种 trigger」——只管新增条目,存量不追溯)。` +
        `修法:在该条目 attribution 注释之后、正文之前补一行合法 trigger(tool=;repo=;path=|cmd= 形态),` +
        `或答不出确定性判据时显式写 <!-- trigger: none; 理由=<非空说明> -->:\n` +
        missing.slice(0, 5).map((e) => `  - [${e.dateISO}${e.dateRaw} — ${e.title}]`).join('\n')
      );
    }
  } catch { /* 解析磁盘上 current 文件失败——fail-open,不拦(与上面 B5/B32 同一纪律) */ }
}

process.exit(0);
