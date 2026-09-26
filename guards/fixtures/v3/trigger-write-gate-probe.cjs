#!/usr/bin/env node
// trigger-write-gate-probe.cjs — self-test driver for pmm-trigger-write-gate.sh --self-test (HIGH-5,
// 2026-09-15; R5-2 fix rewrite, 2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md
// HIGH-2 / FABLE-2026-09-15-codex-cumulative-triage.md R5-2). Constructs hook JSON payloads ENTIRELY
// in JS source (JSON.stringify, execFileSync's `input`, never a shell string) per
// [tooling:hook-fixture-must-carry-producer-escaping] — a payload built via Bash string interpolation
// gets its backslashes folded in half and never exercises the real production escaping shape.
//
// R5-2 rewrite note: the gate no longer judges Edit/MultiEdit `new_string` fragments in isolation — it
// now reads the CURRENT on-disk file, reconstructs the PROSPECTIVE FULL FILE by applying old_string→
// new_string exactly like the real tool would, and runs that through core.parseFile(). That means this
// probe's payloads must supply an `old_string` that ACTUALLY EXISTS in the seeded file (the real Edit
// tool would itself fail to locate a nonexistent old_string) — each test below gets its OWN fresh,
// isolated memory dir (mkMem) seeded with exactly the anchor text that test's old_string targets, so
// no test's fence/trigger state can leak into another's reconstruction.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const GATE = path.join(__dirname, '..', '..', 'pmm-trigger-write-gate.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'trg-write-gate-'));

let pass = 0, fail = 0, skip = 0, nTest = 0;
function mkMem(seeds) {
  nTest++;
  const dir = (ROOT + '/mem' + nTest).replace(/\\/g, '/');
  fs.mkdirSync(dir, { recursive: true });
  const defaults = { 'decisions.md': '', 'lessons.md': '', 'standinginstructions.md': '', 'classes.md': '' };
  const all = Object.assign({}, defaults, seeds || {});
  for (const [name, content] of Object.entries(all)) fs.writeFileSync(dir + '/' + name, content);
  return dir;
}
function run(payload, mem) {
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [GATE], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, { PMM_CANONICAL_MEMORY: mem }),
      encoding: 'utf8',
      timeout: 15000,
    });
  } catch (e) {
    code = e.status === undefined ? -1 : e.status;
    out = (e.stdout || '') + (e.stderr || '');
  }
  return { out, code };
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  ✖ FAIL - ' + name + (detail ? ' — ' + detail : '')); }
}
// L-2 fix (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md L-2; confirmed — with PATH's
// cmd.exe swapped for a failing stub, the two junction cases below already printed "SKIP" but never
// incremented anything the final summary line or exit code read, so the roster line went from 46/46 to
// 44/44 and rc stayed 0 — a coverage gap that reads exactly like a clean pass to anything checking rc
// alone): skipTest() tracks every SKIP in its own counter, printed in the summary and folded into the
// exit code below (see the bottom of this file) so a SKIP can never again be silently indistinguishable
// from "ran and passed".
function skipTest(name, reason) { skip++; console.log('  SKIP - ' + name + ' — ' + reason); }
function isDenied(out) {
  if (!out.trim()) return false;
  let j; try { j = JSON.parse(out); } catch { return false; }
  return !!(j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny');
}
function winPath(memDir, base) { return memDir.replace(/\//g, '\\') + '\\' + base; }

// self-check ([tooling:hook-fixture-must-carry-producer-escaping]): every payload below embeds a
// Windows file_path built with JS-source `\\` — confirm at least one, when JSON.stringify'd, actually
// carries the doubled-backslash production shape (`\\\\` in the JSON text) BEFORE trusting any result
// below. If this is ever false, the payloads were built some other way (e.g. shell string
// interpolation) that silently folds backslashes in half and this whole probe stops proving anything.
{
  const canary = JSON.stringify({ file_path: 'C:\\x\\y' });
  if (!canary.includes('\\\\')) { console.log('✖ FAIL - producer-escaping self-check: payloads are NOT carrying doubled backslashes — probe results below are meaningless'); process.exitCode = 1; }
}

// 1. Edit, malformed trigger comment (missing tool=/repo=) on a canonical memory file — must DENY.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's1', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-01 — n** [test:bad]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('Edit + 缺 tool=/repo= 的 trigger → DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 2. Edit, well-formed trigger comment on a canonical memory file — must NOT deny.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's2', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-02 — n** [test:good]\n<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->\nbody\n',
    },
  }, mem);
  ok('Edit + 合法 trigger → 不 DENY', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 3. Edit, well-formed multi-token glob trigger (the live src/lib/**/*lock* shape) — must NOT deny;
//    positive control proving the write gate doesn't false-positive on the legitimate glob feature.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's3', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-03 — n** [test:glob-ok]\n<!-- trigger: tool=Edit|Write; repo=example-project; path=src/lib/**/*lock* -->\nbody\n',
    },
  }, mem);
  ok('Edit + 合法多 token glob trigger → 不 DENY', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 4. Edit, malformed trigger targeting a file OUTSIDE the canonical memory dir — must NOT deny
//    (out-of-scope; the gate's matcher is Edit|Write|MultiEdit repo-wide, so it must never false-
//    positive block an unrelated file edit elsewhere in the tree).
{
  const mem = mkMem({});
  const r = run({
    session_id: 's4', tool_name: 'Edit',
    tool_input: {
      file_path: 'C:\\Users\\<user>\\Desktop\\example-project\\src\\lib\\scheduling\\resource.ts',
      old_string: 'x',
      new_string: '// <!-- trigger: path=.claude/guards/ -->\n',
    },
  }, mem);
  ok('Edit(域外文件) + 貌似 trigger 的注释 → 不 DENY(越权范围之外)', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 5. MultiEdit, malformed trigger in edits[1].new_string — must DENY (not just edits[0]).
{
  const mem = mkMem({ 'decisions.md': 'ANCHOR_A\nANCHOR_B\n' });
  const r = run({
    session_id: 's5', tool_name: 'MultiEdit',
    tool_input: {
      file_path: winPath(mem, 'decisions.md'),
      edits: [
        { old_string: 'ANCHOR_A', new_string: 'harmless first edit' },
        { old_string: 'ANCHOR_B', new_string: '**2026-01-04 — n** [test:bad2]\n<!-- trigger: tool=Edit; repo=*; path=* -->\nbody\n' },
      ],
    },
  }, mem);
  ok('MultiEdit + 第二处编辑含非法 trigger(path=*)→ DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 6. Write, malformed trigger in content — must DENY.
{
  const mem = mkMem({});
  const r = run({
    session_id: 's6', tool_name: 'Write',
    tool_input: {
      file_path: winPath(mem, 'standinginstructions.md'),
      content: '**2026-01-05 — n** [test:bad3]\n<!-- trigger: tool=Bash; repo=*; cmd=git -->\nbody\n',
    },
  }, mem);
  ok('Write + repo=* 配拒绝 exe(git)的 cmd trigger → DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 7. Bad/empty stdin — must fail OPEN (no deny, no crash).
{
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [GATE], { input: 'not-json', encoding: 'utf8', timeout: 15000 });
  } catch (e) { code = e.status === undefined ? -1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }
  ok('坏 JSON stdin → fail-open(不 DENY,不崩)', !isDenied(out) && code === 0, 'code=' + code + ' out=' + out.slice(0, 200));
}

// ── round-2 hardening (2026-09-15, guards/audits/OPUS-2026-09-15-repair-review.md O-6/O-7) ─────────

// 8. O-6: bad trigger referenced INSIDE processes.md — not one of core.ALL_FILES (pmm-core never
//    parses it for triggers) — must NOT deny, even though the path is under the canonical memory dir.
{
  const mem = mkMem({});
  fs.writeFileSync(mem + '/processes.md', 'ANCHOR\n');
  const r = run({
    session_id: 's8', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'processes.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n反面示例说明如下:\n<!-- trigger: path=.claude/guards/ -->\n以上是非法形态,仅作举例\n',
    },
  }, mem);
  ok('Edit + processes.md(非 core.ALL_FILES)含反面示例 → 不 DENY(域外文件)', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 9. O-6: bad trigger INSIDE a fenced code block within lessons.md — fence-aware, must NOT deny.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's9', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      // 2026-09-17 presence-gate 上线后补一行围栏外的合法 trigger(否则这条新增条目会被presence
      // 闸——而不是这条测试本来要测的 fence-awareness——正当拦下,测试意图就被新闸的副作用掩盖了)。
      new_string: 'ANCHOR\n**2026-01-06 — n** [test:fenced]\n<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->\n说明如下:\n```\n<!-- trigger: path=.claude/guards/ -->\n```\nbody\n',
    },
  }, mem);
  ok('Edit + lessons.md 围栏代码块内的反面示例 → 不 DENY(fence-aware,基于重建后完整文件判定)', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 10. R5-2 (round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md HIGH-2): the confirmed
//     repro — lessons.md already has a COMPLETE, legal trigger line; the edit only touches a FRAGMENT
//     of it (old_string:"tool=Edit; repo=home", new_string:"tool=Edti; repo=home") — neither string is
//     itself trigger-shaped, and under the OLD per-fragment judgment this sailed through untouched
//     (test 10 used to assert exactly this as "不 DENY", i.e. it had locked the bypass in as expected
//     behavior). Now that the gate reconstructs the full file and re-parses it, the RESULT — a line
//     reading `tool=Edti` — is what gets judged, and `Edti` is not in the tool=Edit|Write|MultiEdit|
//     NotebookEdit alternation, so this must DENY.
{
  const mem = mkMem({
    'lessons.md': '**2026-02-01 — 既有合法 trigger 条目** [test:r5-2-existing]\n<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->\nbody\n',
  });
  const r = run({
    session_id: 's10', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'tool=Edit; repo=home',
      new_string: 'tool=Edti; repo=home',
    },
  }, mem);
  ok('[R5-2] Edit 只改既有合法 trigger 行的一个片段(Edit→Edti)→ DENY(此前:片段不判,静默把活 trigger 改死)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 11. O-7: a RELATIVE file_path (resolved against the hook payload's own `cwd`) pointing at a
//     canonical-memory file with a malformed trigger — must DENY (previously: unconditional bypass).
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const cwdParent = path.dirname(mem); // mem's own parent, so 'mem<N>/lessons.md' resolves to mem/lessons.md
  const r = run({
    session_id: 's11', tool_name: 'Edit',
    tool_input: {
      file_path: path.basename(mem) + '\\lessons.md', // relative, backslash form (production shape)
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-07 — n** [test:relpath-bad]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
    cwd: cwdParent,
  }, mem);
  ok('Edit + 相对路径(带 cwd)指向记忆文件的非法 trigger → DENY(此前无条件放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 12. O-6 escape hatch: PMM_TRIGGER_WRITE_GATE_DISABLE=1 must fail this hook open unconditionally,
//     even for a payload that would otherwise be denied — recorded, deliberate bypass, never silent
//     (the caller has to explicitly set the env var; this just proves the switch actually works).
// R-5 fix (round-3, 2026-09-15): also assert it leaves a TRACE — non-empty stderr AND an appended
// trigger-log line — not just that it fails open. The pre-fix hatch produced empty output on stdout
// AND stderr AND touched no log file at all, contradicting its own "NOT a silent bypass" comment.
// Uses spawnSync (not execFileSync) so stderr is captured regardless of the (here: zero) exit code.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const gateLog = (ROOT + '/gate-disable-log.tsv').replace(/\\/g, '/');
  const res = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({
      session_id: 's12', tool_name: 'Edit',
      tool_input: {
        file_path: winPath(mem, 'lessons.md'),
        old_string: 'ANCHOR',
        new_string: 'ANCHOR\n**2026-01-08 — n** [test:escape]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
      },
    }),
    env: Object.assign({}, process.env, { PMM_CANONICAL_MEMORY: mem, PMM_TRIGGER_WRITE_GATE_DISABLE: '1', PMM_TRIGGER_LOG: gateLog }),
    encoding: 'utf8', timeout: 15000,
  });
  const out = res.stdout || '', errOut = res.stderr || '', code = res.status;
  ok('PMM_TRIGGER_WRITE_GATE_DISABLE=1 → 对本会拒绝的载荷仍不 DENY(逃生口生效)', !isDenied(out) && code === 0, 'code=' + code + ' out=' + out.slice(0, 200));
  ok('R-5: 逃生口生效时 stderr 必须非空(留痕,而非完全静默)', errOut.trim().length > 0, 'stderr=' + JSON.stringify(errOut.slice(0, 200)));
  let logContent = '';
  try { logContent = fs.readFileSync(gateLog, 'utf8'); } catch {}
  ok('R-5: 逃生口生效时必须追加一行到 trigger-log(本机可查,非静默)', /write-gate-disabled/.test(logContent), 'logContent=' + JSON.stringify(logContent.slice(0, 300)));
}

// ── round-3 hardening (2026-09-15, guards/audits/OPUS-2026-09-15-round2-review.md R-3), re-verified
// under the R5-2 full-reconstruction model (2026-09-15 round 5) ────────────────────────────────────
// These reproduce the audit's [A]/[B2]/[B3] gap: a genuinely-illegal COMPLETED line must be caught
// regardless of how many segments/fragments the edit that produces it happens to be split across.
// Under full-file reconstruction there is no more "fragment uncertainty" — parseFile sees the actual
// resulting file, so these are now plain positive/negative controls on that ground truth.

// 13. [B3]: a single new_string containing a complete `<!-- trigger: ... -->` construct with TRAILING
//     TEXT on the same line after the closing `-->`. TRIG_P_RE is `^...$`-anchored, so trailing text
//     after `-->` fails it; TRIGGERISH_RE still matches the `<!-- trigger:` prefix ⇒ B5. Must DENY.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's13', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-12 — n** [test:trailing-garbage]\n<!-- trigger: tool=Edit; repo=home; path=/a --> trailing garbage after close\n',
    },
  }, mem);
  ok('[B3] Edit + 单段 trigger 注释后带尾随文本(同一行)→ DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 14. [B2]: same shape as [B3] but as the FIRST line of a multi-line new_string (a harmless second
//     line follows) — the trailing-text line must still be judged and denied.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's14', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-13 — n** [test:trailing-garbage2]\n<!-- trigger: tool=Edit; repo=home; path=/a --> trailing garbage\nharmless second line\n',
    },
  }, mem);
  ok('[B2] Edit + 多段 new_string 的首段是 trigger 注释+尾随文本 → DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 15. [A] re-scoped for full reconstruction: new_string OPENS a fence (```) and writes a bad trigger
//     comment after it, with NOTHING following in the file (EOF right after — no accidental close from
//     unrelated later content). Ground truth (the reconstructed full file) shows the fence genuinely
//     never closes: core.parseFile reports B32 (unclosed fence at EOF) for exactly this reason ("其后
//     内容可能被静默吞掉"), and the bad trigger line inside it is invisible to the grammar (never B5).
//     The write gate blocks on B32 too — an operator leaving a trailing fence open silently swallows
//     everything after it from BOTH write-time and read-time trigger parsing alike, which is exactly
//     the kind of corpus-integrity break this gate exists to catch before it lands.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's15', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR\n',
      new_string: 'ANCHOR\n**2026-01-09 — n** [test:openfence-bad]\n```\n<!-- trigger: path=.claude/guards/ -->\n',
    },
  }, mem);
  ok('[A] Edit + 只开围栏未闭合(至 EOF 仍未闭合)→ DENY(B32,重建后可判定真相,不再是猜测)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 16. [A] control: a fence that OPENS AND CLOSES within the same new_string still correctly protects
//     its interior — positive control proving the fix didn't just make the gate deny everything after
//     any fence marker.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's16', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      // 2026-09-17 presence-gate 上线后补一行围栏外的合法 trigger(理由同上一条:否则新增条目的
      // presence 检查会先行拦下,盖过这条测试本来要测的「围栏开闭在同一 new_string 内」这件事)。
      new_string: 'ANCHOR\n**2026-01-10 — n** [test:closedfence-ok]\n<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->\n```\n<!-- trigger: path=.claude/guards/ -->\n```\nbody\n',
    },
  }, mem);
  ok('[A控制] Edit + 围栏在同一 new_string 内开且闭 → 不 DENY(围栏内仍受保护,未过度收紧)', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// ── R5-2 additional coverage (round 5): MultiEdit sequential application, and Write full-content
// replacement, must also go through the reconstruct-then-parse path (not just single-Edit).

// 17. MultiEdit whose SECOND edit's old_string only exists after the FIRST edit has been applied
//     (sequential reconstruction) — and that second edit corrupts an existing legal trigger line's
//     fragment. Proves edits[] are applied in order against the cumulative result, not independently
//     against the original file.
{
  const mem = mkMem({
    'decisions.md': 'STEP1\n**2026-02-02 — n** [test:r5-2-multiedit]\n<!-- trigger: tool=Write; repo=home; path=.claude/guards/* -->\nbody\n',
  });
  const r = run({
    session_id: 's17', tool_name: 'MultiEdit',
    tool_input: {
      file_path: winPath(mem, 'decisions.md'),
      edits: [
        { old_string: 'STEP1', new_string: 'STEP1-DONE' }, // harmless, unlocks nothing by itself
        { old_string: 'tool=Write', new_string: 'tool=Wrtie' }, // corrupts the existing trigger's tool= value
      ],
    },
  }, mem);
  ok('[R5-2] MultiEdit 第二处编辑把既有合法 trigger 的片段改死(Write→Wrtie)→ DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 18. Write full-content replacement that (by construction) turns a would-be-legal trigger line into
//     an illegal one — content-based reconstruction has no "current file" dependency at all, so this
//     is a direct content check, included for completeness of the Write path under the new code path.
{
  const mem = mkMem({});
  const r = run({
    session_id: 's18', tool_name: 'Write',
    tool_input: {
      file_path: winPath(mem, 'classes.md'),
      content: '**2026-01-11 — n** [test:write-bad]\n<!-- trigger: tool=Edti; repo=home; path=.claude/guards/* -->\nbody\n',
    },
  }, mem);
  ok('[R5-2] Write content 直接含死 trigger(tool=Edti)→ DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// ── trigger-presence gate (2026-09-17, the maintainer 派活;决策 [memory:trigger-plant-at-write-fine-grained])
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 只管「新增条目」(标题行在 current 里不存在),存量不追溯。5 例:红/绿/绿/红/绿。

// 19. RED — brand-new entry (title not in current file at all), has an attribution comment but ZERO
//     trigger line of any kind → must DENY.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's19', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-03-01 — presence-missing** [test:presence-missing]\n<!-- attribution: the maintainer 2026-03-01 -->\nbody,完全没有 trigger 行\n',
    },
  }, mem);
  ok('[presence 红] 新增条目缺 trigger(有 attribution 无 trigger)→ DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 20. GREEN — brand-new entry with a legal trigger (existing grammar) → must NOT deny.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's20', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-03-02 — presence-legal** [test:presence-legal]\n<!-- attribution: the maintainer 2026-03-02 -->\n<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->\nbody\n',
    },
  }, mem);
  ok('[presence 绿] 新增条目带合法 trigger → 不 DENY', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 21. GREEN — brand-new entry with an explicit `<!-- trigger: none; 理由=... -->` (non-empty reason)
//     sentinel — the deliberate "judged it, no determinable trigger" opt-out → must NOT deny.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's21', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-03-03 — presence-none** [test:presence-none]\n<!-- attribution: the maintainer 2026-03-03 -->\n<!-- trigger: none; 理由=纯记账性质决策,答不出确定性复现判据 -->\nbody\n',
    },
  }, mem);
  ok('[presence 绿] 新增条目带 <!-- trigger: none; 理由=非空 --> → 不 DENY', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 22. RED — `<!-- trigger: none; -->` with NO 理由 — an empty/placeholder opt-out is still an illegal
//     trigger comment at the grammar layer (core.classifyTriggerLine rejects it before this entry ever
//     reaches the presence check) → must DENY either way.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's22', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-03-04 — presence-none-empty** [test:presence-none-empty]\n<!-- attribution: the maintainer 2026-03-04 -->\n<!-- trigger: none; 理由= -->\nbody\n',
    },
  }, mem);
  ok('[presence 红] 新增条目 <!-- trigger: none; --> 理由为空 → DENY', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 23. GREEN — the edit only rewrites the BODY of an EXISTING entry (title line unchanged, so it is not
//     a "new" entry by the title-key diff) and that entry itself carries no trigger at all — presence
//     check must skip it entirely (存量不追溯) → must NOT deny.
{
  const mem = mkMem({
    'lessons.md': '**2026-02-20 — 既有条目,从无 trigger** [test:presence-preexisting]\n旧正文占位\n',
  });
  const r = run({
    session_id: 's23', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md'),
      old_string: '旧正文占位',
      new_string: '重写后的新正文,依旧没有 trigger,但这不是新增条目',
    },
  }, mem);
  ok('[presence 绿] 只改存量条目正文(标题不变,不算新增)→ 不 DENY', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// ── HIGH-2 hardening (2026-09-17, fab 盲攻 + Opus 复现): the scope check ("is this file_path inside
// canonical memory?") used to be a hand-rolled `\→/` + drive-letter-lowercase + string prefix/equality
// compare. Three shapes made it fail the match and exit 0 (silently OUT of scope, unchecked) even
// though each genuinely resolves to a file inside canonical: a Windows device-namespace prefix
// (`\\?\`), doubled slashes, and a `.` segment embedded partway through what should be the canonical
// prefix. Now routed through core.isUnderCanonical() (vendored path-is-inside + normalize-path prefix
// handling) — these three must all DENY like any other malformed-trigger write inside canonical.

// 24. `\\?\` Windows device-namespace/extended-length prefix on an otherwise-normal canonical path.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const uncPath = '\\\\?\\' + mem.replace(/\//g, '\\') + '\\lessons.md';
  const r = run({
    session_id: 's24', tool_name: 'Edit',
    tool_input: {
      file_path: uncPath,
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-04-01 — n** [test:unc-bypass]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[HIGH-2 UNC] Edit + \\\\?\\ 扩展前缀路径的非法 trigger → DENY(此前:前缀字符串比对失配,静默放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 25. Doubled slash right after the drive letter (`C://Users/…` shape).
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const dblPath = mem.replace(/^([A-Za-z]):\//, '$1://') + '/lessons.md';
  const r = run({
    session_id: 's25', tool_name: 'Edit',
    tool_input: {
      file_path: dblPath,
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-04-02 — n** [test:dblslash-bypass]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[HIGH-2 双斜杠] Edit + C://Users/… 双斜杠路径的非法 trigger → DENY(此前:前缀字符串比对失配,静默放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 26. A `.` segment embedded partway through the canonical directory's own path (not merely appended
//     after it — that shape would still satisfy a naive startsWith(canonical) check; the bypass needs
//     the `.` to land BEFORE where the literal comparison would diverge).
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const segs = mem.split('/');
  const mid = Math.max(1, Math.floor(segs.length / 2));
  const dottedMem = segs.slice(0, mid).concat(['.']).concat(segs.slice(mid)).join('/');
  const dotPath = dottedMem + '/lessons.md';
  const r = run({
    session_id: 's26', tool_name: 'Edit',
    tool_input: {
      file_path: dotPath,
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-04-03 — n** [test:dotprefix-bypass]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[HIGH-2 前缀内嵌.] Edit + canonical 路径中段插入 /./ 的非法 trigger → DENY(此前:前缀字符串比对失配,静默放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// ── MEDIUM-N1 (2026-09-17/18, Opus 增量核冻结 cb70d64): 逃生口默认日志路径 ─────────────────────
// 27/28. 不设 PMM_TRIGGER_LOG 时,逃生口日志必须落在 ledger.resolveRoot() 下(与 pmm-trigger-recall.cjs
//     迁移后的 LOG 同址),不再默认落进已冻结的旧位置 memory/dreams/trigger-log-<host>.tsv。
//
// MEDIUM-P3 fix (2026-09-23, guards/audits/OPUS-2026-09-17-pipe-gate-v2-build-acceptance.md「v2.25
// erratum 2 + 2026-09-23 canary-red fixes on b1a74c2」§MEDIUM-P3 — that doc's own numbering "探针
// #27/#28" refers to this block's two ok() assertions, which sat at overall positions #27/#28 when
// that doc was written; three test blocks were inserted earlier in this file since then, so they are
// now #29/#30 in file order, but it is the SAME two assertions): this test's whole point is to catch a
// REGRESSION where ledger.resolveRoot() stops honoring PMM_RECALL_ROOT and the escape hatch falls back
// to a path built off the REAL os.homedir() — but until this fix, that fallback (if it ever fired)
// landed on the REAL frozen legacy trigger-log, because only PMM_RECALL_ROOT was redirected here, never
// HOME/USERPROFILE. A test whose ONLY way of detecting "the fallback fired" is a before/after sha diff
// on a real committed artifact corrupts production data at the exact moment it proves its own reason
// for existing — "这个探针在它本该变红的那一刻,会先把一行写进它守护的审计文物" per that doc.
// Fixed: HOME/USERPROFILE now redirect to this test's own isolated ROOT for the spawned gate
// subprocess (resolveRoot() still takes the PMM_RECALL_ROOT branch unconditionally when it is set —
// confirmed by reading pmm-recall-ledger.cjs:103-106 — so this redirect changes NOTHING about the
// current, non-regressed code path; it only becomes load-bearing exactly if defaultRoot()/resolveHome()
// ever gets reached, which is the regression this test exists to catch). The "old/legacy" location this
// test's primary assertion checks is now the SAME-SHAPED path under that fake home
// (…/n1-fake-home/.claude/memory/dreams/trigger-log-<mach>.tsv) — a copy (副本) seeded with stand-in
// content, never the real file — so even a genuine regression can only ever write into ROOT. The real
// frozen file's sha is still read before/after as a redundant sanity re-check, but purely read-only and
// no longer the mechanism this test relies on to catch the regression.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const recallRoot = (ROOT + '/n1-recall-root').replace(/\\/g, '/');
  fs.mkdirSync(recallRoot, { recursive: true });
  const mach = (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
  const fakeHome = (ROOT + '/n1-fake-home').replace(/\\/g, '/');
  const legacyFrozenCopy = fakeHome + '/.claude/memory/dreams/trigger-log-' + mach + '.tsv';
  fs.mkdirSync(path.dirname(legacyFrozenCopy), { recursive: true });
  fs.writeFileSync(legacyFrozenCopy, 'stand-in frozen-log copy — not the real committed artifact\n');
  const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
  const realFrozen = os.homedir().replace(/\\/g, '/') + '/.claude/memory/dreams/trigger-log-' + mach + '.tsv';
  const realBeforeSha = sha(realFrozen); // read-only sanity re-check only — never this test's primary assertion (see header note)
  const beforeSha = sha(legacyFrozenCopy);
  const res = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({
      session_id: 's27', tool_name: 'Edit',
      tool_input: {
        file_path: winPath(mem, 'lessons.md'),
        old_string: 'ANCHOR',
        new_string: 'ANCHOR\n**2026-01-14 — n** [test:n1-default-log]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
      },
    }),
    // 刻意不设 PMM_TRIGGER_LOG,专测默认路径分支;PMM_RECALL_ROOT 重定向保证隔离(主路径,不受下面
    // 的 HOME 重定向影响——见上方注释)。HOME/USERPROFILE 重定向到 fakeHome 是 MEDIUM-P3 的安全网:
    // 只在 resolveRoot() 真的回归、落到 defaultRoot()/resolveHome() 时才会被读到。
    // L-1 fix (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md L-1; confirmed — with a
    // caller-exported PMM_HOME in the ambient environment, this block's own HOME/USERPROFILE redirect
    // did nothing, because resolveHome()'s priority is PMM_HOME > USERPROFILE > HOME — the simulated
    // regression's fallback still wrote into whatever PMM_HOME pointed at, standing in for the real
    // frozen file, exactly the "HOME-only redirect" trap guards/pmm-home-split-probe.sh:36 already
    // requires every isolation env to close): PMM_HOME must be pinned to fakeHome too, not just left to
    // inherit from process.env. PMM_GIT_HOME is a SEPARATE override (core.homeDir()'s git-repo-location
    // knob, unrelated to resolveHome()) — cleared here so it can't leak a caller-exported value into
    // any git-backed snapshot path this same env might touch.
    env: Object.assign({}, process.env, {
      PMM_CANONICAL_MEMORY: mem, PMM_TRIGGER_WRITE_GATE_DISABLE: '1', PMM_RECALL_ROOT: recallRoot,
      HOME: fakeHome, USERPROFILE: fakeHome, PMM_HOME: fakeHome, PMM_GIT_HOME: '',
    }),
    encoding: 'utf8', timeout: 15000,
  });
  const expectedLog = recallRoot + '/trigger-log-' + mach + '.tsv';
  let newLogContent = '';
  try { newLogContent = fs.readFileSync(expectedLog, 'utf8'); } catch {}
  ok('[MEDIUM-N1] 逃生口默认日志路径落在 resolveRoot() 下(未设 PMM_TRIGGER_LOG)', /write-gate-disabled/.test(newLogContent), 'expectedLog=' + expectedLog + ' content=' + JSON.stringify(newLogContent.slice(0, 200)) + ' code=' + res.status);
  const afterSha = sha(legacyFrozenCopy);
  ok('[MEDIUM-N1/MEDIUM-P3] 冻结旧位置 trigger-log sha 不变(默认路径不再写它;断言用副本,不碰真文件)', beforeSha === afterSha, 'before=' + beforeSha + ' after=' + afterSha);
  const realAfterSha = sha(realFrozen);
  ok('[MEDIUM-P3] 真实冻结文件 sha 只读复核未变(仅安全网,不是本测主断言)', realBeforeSha === realAfterSha, 'realBefore=' + realBeforeSha + ' realAfter=' + realAfterSha);
}

// ── MEDIUM-N3 (2026-09-17/18, Opus 增量核冻结 cb70d64): 文件名尾随 ./空格 与 UNC 长形态 ────────
// 28. Windows 会静默剥除最后一段路径名尾随的 '.'/' '(`lessons.md.` 实写 `lessons.md`)——此前
//     scope 检查/basename 提取都看不穿,新增条目按"域外文件"放行,而实际磁盘写入落进真记忆文件。
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const dotSuffixPath = winPath(mem, 'lessons.md.');
  const r = run({
    session_id: 's28', tool_name: 'Edit',
    tool_input: {
      file_path: dotSuffixPath,
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-15 — n** [test:trailing-dot-bypass]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[MEDIUM-N3 尾随点] Edit + lessons.md. (Windows 静默剥点)的非法 trigger → DENY(此前:basename 对不上,域外放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 29. 同上,尾随空格(`lessons.md `,Windows 同样静默剥除)。
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const spaceSuffixPath = winPath(mem, 'lessons.md ');
  const r = run({
    session_id: 's29', tool_name: 'Edit',
    tool_input: {
      file_path: spaceSuffixPath,
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-16 — n** [test:trailing-space-bypass]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[MEDIUM-N3 尾随空格] Edit + "lessons.md "(Windows 静默剥空格)的非法 trigger → DENY(此前:basename 对不上,域外放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 30. `\\?\UNC\<本机>\<盘符>$\...` 设备命名空间形态的管理共享路径,等价于 `<盘符>:\...`(本机场景)。
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const driveLetter = mem.slice(0, 1).toUpperCase();
  const rel = mem.slice(2).replace(/\//g, '\\'); // drop "C:" prefix, keep the rest, backslash form
  const uncLongPath = '\\\\?\\UNC\\localhost\\' + driveLetter.toLowerCase() + '$' + rel + '\\lessons.md';
  const r = run({
    session_id: 's30', tool_name: 'Edit',
    tool_input: {
      file_path: uncLongPath,
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-01-17 — n** [test:unc-admin-share-bypass]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[MEDIUM-N3 UNC 长形态] Edit + \\\\?\\UNC\\localhost\\<盘符>$\\... 管理共享路径的非法 trigger → DENY(此前:前缀字符串比对失配,静默放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// ── codex#8 / fab H-2 / MEDIUM-1 / MEDIUM-2 (2026-09-23, guards/audits/OPUS-2026-09-23-codex-final-
// triage.md #8 + guards/audits/OPUS-2026-09-23-fab-delta-triage.md HIGH-2/MEDIUM-1/MEDIUM-2) ─────────
// Four more "same file, different spelling" bypass classes confirmed by both audits: a basename case
// variant, an NTFS junction/reparse point, the plain (non-device-namespace) UNC admin-share spelling,
// and the default NTFS data-stream suffix all reached the exact same real canonical file while the old
// checks (byte-for-byte ALL_FILES.includes, pure-lexical isUnderCanonical, the original `\\?\UNC\...`-
// only regex) judged them out of scope and let the write through unexamined. Fixed via
// pmm-trigger-write-gate.cjs's basename.toLowerCase() + core.pmm-core.cjs's realpathForCompare()/
// normalizeWin32UncAdminShare()/stripWin32AdsSuffix() — see those files' own header comments for the
// mechanism. Each DENY case below was run against the pre-fix code (guards/pmm-core.cjs +
// guards/pmm-trigger-write-gate.cjs at HEAD, before this batch) and confirmed red (fell through as
// out-of-scope, i.e. NOT denied) before being fixed.

// 31/32. codex#8: a basename that differs from core.ALL_FILES only by case (`LESSONS.MD`/`Lessons.md`)
//        reaches the exact same on-disk file as `lessons.md` on a case-insensitive filesystem.
for (const variant of ['LESSONS.MD', 'Lessons.md']) {
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's31-' + variant, tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, variant),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-05-01 — n** [test:casefold-' + variant + ']\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[codex#8 大小写] Edit + ' + variant + ' 非法 trigger → DENY(此前:byte-for-byte ALL_FILES 比对不认,域外放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 33. fab H-2: the case-variant bypass isn't just a B5-syntax gap — the trigger-PRESENCE gate (§ above,
//     PRESENCE_FILES.has(basename)) only exists in THIS hook (fab confirmed manifest/precommit/
//     length-watch have no equivalent check), so a brand-new entry written through a case-variant path
//     with ZERO trigger of any kind must also be caught here, not just malformed-trigger syntax.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's33', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'Lessons.md'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-05-02 — presence-casefold** [test:casefold-presence]\n<!-- attribution: the maintainer 2026-05-02 -->\nbody,完全没有 trigger 行\n',
    },
  }, mem);
  ok('[fab H-2 在场性] Edit + Lessons.md 新增条目零 trigger → DENY(presence 闸也必须认得出大小写变体)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 34/35. codex#8: an NTFS junction (`mklink /J`, no elevation required) whose LINK sits OUTSIDE
//        canonical but whose REPARSE TARGET is canonical must DENY (the real write lands in the real
//        canonical file); a junction whose target is a DIFFERENT, non-memory directory is the negative
//        control and must stay ALLOW. Skips (not fails) when mklink /J genuinely can't run on this
//        host — never silently treated as pass.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const outside = (ROOT + '/junction-outside').replace(/\\/g, '/');
  fs.mkdirSync(outside, { recursive: true });
  const link = (outside + '/memlink').replace(/\//g, '\\');
  const mkIn = spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, mem.replace(/\//g, '\\')], { encoding: 'utf8' });
  if (mkIn.status !== 0) {
    skipTest('[codex#8 junction] canonical 外 junction 指向 canonical 内 → DENY', 'mklink /J 不可用(status=' + mkIn.status + ' stderr=' + (mkIn.stderr || '').slice(0, 160) + ')');
  } else {
    const r = run({
      session_id: 's34', tool_name: 'Edit',
      tool_input: {
        file_path: link + '\\lessons.md',
        old_string: 'ANCHOR',
        new_string: 'ANCHOR\n**2026-05-03 — n** [test:junction-in]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
      },
    }, mem);
    ok('[codex#8 junction] canonical 外 junction 的 reparse 目标在 canonical 内 → DENY(此前:纯词法比对看不见 reparse point,域外放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
  }
  const notmem = (ROOT + '/junction-notmem').replace(/\\/g, '/');
  fs.mkdirSync(notmem, { recursive: true });
  fs.writeFileSync(notmem + '/lessons.md', 'ANCHOR\n');
  const link2 = (outside + '/memlink-control').replace(/\//g, '\\');
  const mkOut = spawnSync('cmd.exe', ['/c', 'mklink', '/J', link2, notmem.replace(/\//g, '\\')], { encoding: 'utf8' });
  if (mkOut.status !== 0) {
    skipTest('[对照 codex#8 junction] 指向非 memory 目录 → 不 DENY', 'mklink /J 不可用(status=' + mkOut.status + ' stderr=' + (mkOut.stderr || '').slice(0, 160) + ')');
  } else {
    const r2 = run({
      session_id: 's35', tool_name: 'Edit',
      tool_input: {
        file_path: link2 + '\\lessons.md',
        old_string: 'ANCHOR',
        new_string: 'ANCHOR\n**2026-05-04 — n** [test:junction-control]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
      },
    }, mem);
    ok('[对照 codex#8 junction] 指向非 memory 目录的 junction → 不 DENY(reparse 目标真的在域外,未过度收紧)', !isDenied(r2.out), 'code=' + r2.code + ' out=' + r2.out.slice(0, 200));
  }
}

// 36/37/38. fab MEDIUM-1: the PLAIN (non-device-namespace) admin-share spelling of THIS machine's own
//           drive — `\\localhost\C$\...`, `\\127.0.0.1\C$\...`, and the forward-slash form
//           `//localhost/C$/...` — all reach the same local file as `C:\...` but only the
//           `\\?\UNC\...` device-namespace spelling was recognized before this batch.
for (const hostForm of ['\\\\localhost\\', '\\\\127.0.0.1\\', '//localhost/']) {
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const driveLetter = mem.slice(0, 1).toUpperCase();
  const isFwd = hostForm.indexOf('/') !== -1;
  const rel = isFwd ? mem.slice(2) : mem.slice(2).replace(/\//g, '\\');
  const sep = isFwd ? '/' : '\\';
  const uncPath = hostForm + driveLetter.toLowerCase() + '$' + rel + sep + 'lessons.md';
  const r = run({
    session_id: 's36-' + hostForm.replace(/[^a-z0-9.]/gi, ''), tool_name: 'Edit',
    tool_input: {
      file_path: uncPath,
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-05-05 — n** [test:unc-plain]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[fab MEDIUM-1 普通 UNC admin share] Edit + ' + JSON.stringify(uncPath) + ' 的非法 trigger → DENY(此前:只认 \\\\?\\UNC\\... 一种拼法,域外放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 39. control: `\\otherhost\C$\...` — a GENUINELY remote host's admin share is a different machine's
//     filesystem and must stay untouched/ALLOW (this proves the fix only rewrites THIS machine's own
//     aliases, not every admin-share-shaped path).
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const driveLetter = mem.slice(0, 1).toUpperCase();
  const rel = mem.slice(2).replace(/\//g, '\\');
  const uncPath = '\\\\otherhost\\' + driveLetter.toLowerCase() + '$' + rel + '\\lessons.md';
  const r = run({
    session_id: 's39', tool_name: 'Edit',
    tool_input: {
      file_path: uncPath,
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-05-06 — n** [test:unc-otherhost]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[对照 fab MEDIUM-1] Edit + \\\\otherhost\\C$\\... 远程主机 admin share → 不 DENY(远程主机不改写,未过度收紧)', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 40/41. fab MEDIUM-2: `<file>::$DATA`/`<file>::$data` (the DEFAULT, unnamed NTFS data stream) address
//        the exact same bytes as `<file>` with no suffix at all.
for (const suffix of ['::$DATA', '::$data']) {
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's40-' + suffix.replace(/[^a-z]/gi, ''), tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md' + suffix),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-05-07 — n** [test:ads-default]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[fab MEDIUM-2 默认数据流] Edit + lessons.md' + suffix + ' 的非法 trigger → DENY(默认数据流=同一份字节,此前:basename 对不上,域外放行)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// 42. control: `lessons.md:foo` — a GENUINE named alternate stream is DIFFERENT content living
//     alongside the file, not an alias for it; must stay ALLOW (proves the fix doesn't treat every
//     colon-suffixed basename as the bare file).
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const r = run({
    session_id: 's42', tool_name: 'Edit',
    tool_input: {
      file_path: winPath(mem, 'lessons.md:foo'),
      old_string: 'ANCHOR',
      new_string: 'ANCHOR\n**2026-05-08 — n** [test:ads-named]\n<!-- trigger: path=.claude/guards/ -->\nbody\n',
    },
  }, mem);
  ok('[对照 fab MEDIUM-2] Edit + lessons.md:foo(命名流)→ 不 DENY(域外,未过度收紧)', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// ── M-2 (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md M-2; confirmed — 5 more spellings
// of "this machine's own admin share" ALLOWed and LANDED in canonical): isLocalHost()'s expanded
// alias set (any 127.0.0.0/8 address, the IPv6 loopback UNC literal, every address actually bound to a
// real interface on this host, an os.hostname() differing only by case/FQDN) plus the widened
// `\\.\UNC\...` device-namespace regex plus the fixed-point normalization loop together close all 5.
{
  const ifaces = os.networkInterfaces() || {};
  let lanIp = null;
  for (const name of Object.keys(ifaces)) for (const info of ifaces[name] || []) if (info.family === 'IPv4' && !info.internal) lanIp = info.address;

  const m2Cases = [
    ['ipv6-literal 回环', (mem) => { const d = mem.slice(0, 1).toUpperCase(); const rel = mem.slice(2).replace(/\//g, '\\'); return '\\\\0--1.ipv6-literal.net\\' + d.toLowerCase() + '$' + rel + '\\lessons.md'; }],
    ['\\\\.\\UNC\\localhost', (mem) => { const d = mem.slice(0, 1).toUpperCase(); const rel = mem.slice(2).replace(/\//g, '\\'); return '\\\\.\\UNC\\localhost\\' + d.toLowerCase() + '$' + rel + '\\lessons.md'; }],
    ['//?/UNC/localhost(正斜杠设备命名空间)', (mem) => { const d = mem.slice(0, 1).toUpperCase(); const rel = mem.slice(2); return '//?/UNC/localhost/' + d.toLowerCase() + '$' + rel + '/lessons.md'; }],
    ['//./UNC/localhost(正斜杠设备命名空间)', (mem) => { const d = mem.slice(0, 1).toUpperCase(); const rel = mem.slice(2); return '//./UNC/localhost/' + d.toLowerCase() + '$' + rel + '/lessons.md'; }],
  ];
  if (lanIp) m2Cases.push(['本机 LAN IP ' + lanIp, (mem) => { const d = mem.slice(0, 1).toUpperCase(); const rel = mem.slice(2).replace(/\//g, '\\'); return '\\\\' + lanIp + '\\' + d.toLowerCase() + '$' + rel + '\\lessons.md'; }]);

  for (const [label, buildFp] of m2Cases) {
    const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
    const fp = buildFp(mem);
    const r = run({
      session_id: 's-m2-' + label.replace(/[^a-z0-9]/gi, ''), tool_name: 'Edit',
      tool_input: { file_path: fp, old_string: 'ANCHOR', new_string: 'ANCHOR\n**2026-06-01 — n** [test:m2]\n<!-- trigger: path=.claude/guards/ -->\nbody\n' },
    }, mem);
    ok('[M-2] Edit + ' + label + ' 的非法 trigger → DENY(此前:5 种拼法之一,域外放行)', isDenied(r.out), 'fp=' + JSON.stringify(fp) + ' code=' + r.code + ' out=' + r.out.slice(0, 200));
  }
}
// control: a GENUINELY remote host must stay ALLOW (proves M-2's fix only rewrites THIS machine's own
// aliases — the expanded isLocalHost() set, not "any address-shaped host").
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const d = mem.slice(0, 1).toUpperCase();
  const rel = mem.slice(2).replace(/\//g, '\\');
  const fp = '\\\\10.0.0.99\\' + d.toLowerCase() + '$' + rel + '\\lessons.md';
  const r = run({
    session_id: 's-m2-control', tool_name: 'Edit',
    tool_input: { file_path: fp, old_string: 'ANCHOR', new_string: 'ANCHOR\n**2026-06-02 — n** [test:m2-control]\n<!-- trigger: path=.claude/guards/ -->\nbody\n' },
  }, mem);
  ok('[对照 M-2] Edit + \\\\10.0.0.99\\C$\\... 远程主机 → 不 DENY(远程主机不改写,未过度收紧)', !isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
}

// ── L-4 (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md L-4; confirmed — a hard link,
// `mklink /H`, no elevation required, pointing AT lessons.md but named something else entirely was
// judged out of scope and ALLOWed, because the old basename came from the LEXICAL fp only): the write
// gate's basename now resolves through matchCanonical()'s (dev, ino) identity check when the lexical
// name alone wouldn't be in core.ALL_FILES. SKIPs (does not silently pass) when mklink /H can't run.
{
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const hardlinkDir = (ROOT + '/l4-hardlink').replace(/\\/g, '/');
  fs.mkdirSync(hardlinkDir, { recursive: true });
  const hardlinkPath = (hardlinkDir + '/not-a-corpus-name.md').replace(/\//g, '\\');
  const target = (mem + '/lessons.md').replace(/\//g, '\\');
  const mk = spawnSync('cmd.exe', ['/c', 'mklink', '/H', hardlinkPath, target], { encoding: 'utf8' });
  if (mk.status !== 0) {
    skipTest('[L-4 硬链接] Edit + 硬链接指向 lessons.md,自身文件名不在 ALL_FILES 内 → DENY', 'mklink /H 不可用(status=' + mk.status + ' stderr=' + (mk.stderr || '').slice(0, 160) + ')');
  } else {
    const r = run({
      session_id: 's-l4', tool_name: 'Edit',
      tool_input: { file_path: hardlinkPath, old_string: 'ANCHOR', new_string: 'ANCHOR\n**2026-06-03 — n** [test:l4-hardlink]\n<!-- trigger: path=.claude/guards/ -->\nbody\n' },
    }, mem);
    ok('[L-4 硬链接] Edit + 硬链接指向 lessons.md,自身文件名不在 ALL_FILES 内 → DENY(basename 改取 (dev,ino) 匹配到的真实 canonical 文件名)', isDenied(r.out), 'code=' + r.code + ' out=' + r.out.slice(0, 200));
  }
}

// ── L-5 (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md L-5): the write gate itself is
// spawned directly as a node process (not through an intermediate bash/MSYS layer) so it does not carry
// the rc-protocol collision L-5 fixed in pmm-entry-length-watch.sh's own scope-helper — that fix and its
// red/green evidence live in pmm-entry-length-watch-scope-test.sh instead, where the collision actually
// occurs (a bash script spawning node, with MSYS's argv-translation in the path). See that file's own
// MSYS_NO_PATHCONV case.

// ── INFO (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md INFO, from its §② "找新洞"):
// `<canonical-dir>::$INDEX_ALLOCATION\lessons.md` and the `:$I30:$INDEX_ALLOCATION` spelling — NTFS's
// directory b-tree INDEX_ALLOCATION alternate attribute, addressed on the MEMORY DIRECTORY itself (not
// on the file) — were found during the audit's own exploration to already reach canonical via realpath
// (the DIRECTORY-level ADS suffix has no effect on stripWin32AdsSuffix(), which only strips a FILE's
// last segment, so the lexical check sees a mismatched basename, but realpathForCompare() resolves the
// whole path through the OS regardless and lands back on the real directory). Pin it down with an
// explicit case so a future refactor narrowing realpathForCompare()'s scope gets caught red-handed.
for (const suffix of ['::$INDEX_ALLOCATION', ':$I30:$INDEX_ALLOCATION']) {
  const mem = mkMem({ 'lessons.md': 'ANCHOR\n' });
  const fp = mem.replace(/\//g, '\\') + suffix + '\\lessons.md';
  const r = run({
    session_id: 's-info-index-alloc-' + suffix.replace(/[^a-z]/gi, ''), tool_name: 'Edit',
    tool_input: { file_path: fp, old_string: 'ANCHOR', new_string: 'ANCHOR\n**2026-06-04 — n** [test:index-allocation]\n<!-- trigger: path=.claude/guards/ -->\nbody\n' },
  }, mem);
  ok('[INFO] Edit + memory 目录' + suffix + '\\lessons.md 的非法 trigger → DENY(realpath 顺带封住,钉住防回归)', isDenied(r.out), 'fp=' + JSON.stringify(fp) + ' code=' + r.code + ' out=' + r.out.slice(0, 200));
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`trigger-write-gate-probe: ${pass}/${pass + fail} (skip=${skip})`);
// L-2 fix: rc=1 for a real failure (unchanged); rc=2 when every assertion that DID run passed but at
// least one was SKIPped (e.g. mklink /J unavailable on this host), so a roster checking rc alone can no
// longer mistake incomplete coverage for a clean pass — it must also read the `skip=N` above or assert
// SKIP=0 itself to call this fully green.
process.exit(fail > 0 ? 1 : (skip > 0 ? 2 : 0));
