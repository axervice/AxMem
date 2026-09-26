#!/usr/bin/env node
// pmm-bash-impression.cjs — M0 impression telemetry hook (PreToolUse, matcher=Bash).
//
// guards/specs/RECALL-LOOP-M-SPEC-v2.md M0 + 附录 A (schema v3) + specs/PIPE-GATE-V2-REPAIR-BRIEF.md
// §5/§8/§17 (共用台账迁移). This is a PURE OBSERVER: it never emits additionalContext, never sets
// permissionDecision, never changes what the Bash tool call does. Its only observable effect is an
// append to the SHARED v3 ledger (`pmm-recall-ledger.cjs`'s `events-v3-<host>.tsv`, under
// `PMM_RECALL_ROOT`), through the exact same module the pipe gate (`bash-pipe-exitcode-watch.cjs`)
// writes through — this commit is the migration described in the brief §8 delivery ②: "M0 的
// pmm-bash-impression.cjs 与本闸同一提交内改为只调用它(禁止照抄)".
//
// Ledger schema: 21-column v3 (see pmm-recall-ledger.cjs COLUMNS), parser_version now '1.2' (from
// pmm-cmd-parse.cjs's own PARSER_VERSION export — never hardcoded here). The OLD 22-column
// impressions-<host>.tsv ledger this file used to write is retired: real-file migration (renaming the
// live ~/.claude/.local/pmm-recall/impressions-*.tsv / queue-*.tsv to `.discarded-<ts>`, read-only) was
// done by hand in the same commit that landed this file, per brief §5 "旧台账整体改名
// *.discarded-<ts>...M0 写入器同提交升级,不允许旧写入器再写回旧列".
//
// gate_instance_id for M0 trigger rows (brief §17, M-SPEC 附录 A): the matched SEGMENT's own index
// (`String(seg.index)`) — NOT shared across two segments of one command that both match the same
// trigger (that was the v1 impression_id design; v3 gives each segment match its own impression,
// corrected here). 'observed' rows use gate_instance_id='' (not segment-specific — that row describes
// the whole hook event, not one match).
//
// Main-thread corrections carried over from the pre-v3 build (still true under the shared module):
//   - tool_use_id and every free-text column are TSV-sanitized before being written (tab/CR/LF/NUL ->
//     '_', via pmm-recall-ledger.cjs's sanitize()), and a `sanitized` column records whether any
//     substitution happened on this row.
//   - a missing session_id or tool_use_id is never written as the sentinel '-': impression_id/event_id
//     stay empty and `id_missing=1` is set; that row's trigger_id is NOT added to this session's
//     already-eligible set (no stable key -> no idempotency claim for it).
//   - every ledger row is its own single write through pmm-recall-ledger.cjs's writeEvent() (never a
//     multi-line buffer joined and written once); a write failure is swallowed but tallied (via the
//     shared module's own write-failures.count bump), so "disk full" doesn't silently vanish.
//   - zero file side effects beyond the shared ledger / queue / write-failures.count under
//     PMM_RECALL_ROOT — no correlation/state file (unlike the pipe gate's pending/receipts layer) --
//     UPDATED 2026-09-24 (L-8 fix, audit OPUS-2026-09-24-c05-batch-review.md §2): ONE exception now
//     exists, `<PMM_RECALL_ROOT>/.read-signal-cache-<host>.json`, a pure performance cache for item
//     24's read-signal corpus parse (see getReadSignalCorpus() below) — it is never consulted for
//     anything but that tag-set/class lookup, is keyed by the corpus files' own mtime+size (so it
//     self-invalidates the instant any memory file changes), and a missing/corrupt cache file is
//     always safe to fall through to a fresh parse.
//   - agent_id/agent_type/prompt_id: session_id is the TOP-LEVEL session id shared by a parent session
//     and every subagent spawned from it (a subagent's own Bash calls are recorded under the PARENT's
//     session_id) — recorded when present, else empty with agent_id_missing=1.
//   - EVERY qualifying Bash event (valid JSON/tool_input/non-empty command, trigger corpus loaded —
//     regardless of whether anything matched) writes exactly one event_kind='observed' row, so M3's
//     "next 20 Bash events" observation window can be reconstructed later.
//
// Reserved-word / unsupported-structure segments from pmm-cmd-parse.cjs (parse_status !== 'ok') are NEVER
// eligible to match a trigger (HIGH-6): a parse failure must never be recorded as a confident non-match,
// so it is simply excluded from matching entirely (the event still gets its one 'observed' row; it just
// can never contribute an 'eligible'/'suppressed' row).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { parseCommand, PARSER_VERSION } = require('./pmm-cmd-parse.cjs');
const ledger = require('./pmm-recall-ledger.cjs');
// pmm-recall-policy.cjs (2026-09-17, MEDIUM-6 coordinator dispatch): this hook wrote mode='' on
// every row it ever produced (real production data: 2750+ rows, none with a usable arm) -- M3
// reads `mode` off the eligible row to tell arms apart, so this observer's rows could never
// contribute a shadow arm either. This is a PURE OBSERVER (never emits additionalContext, see file
// header), so there is no display-suppression fork here like the Edit/Write trigger hook has --
// only mode/run_provenance need to reflect the resolved policy.
const policy = require('./pmm-recall-policy.cjs');

function miss() { process.exit(0); }
process.on('uncaughtException', miss);

let core = null;
try {
  core = require('./pmm-core.cjs');
} catch (e) {
  // AxMem Pro module (guards/pmm-core.cjs) is not part of the free/open-core tier this file ships
  // in -- see README's "guards/ is legacy/reference" section for what is and is not wired into
  // bin/axmem. This guard is a no-op in this install BY DESIGN, not a silent accident -- print that
  // once so anyone running this file standalone sees why, instead of it just doing nothing.
  process.stderr.write('[pmm-bash-impression] AxMem Pro module guards/pmm-core.cjs not present in this (free-tier) install -- no-op.\n');
  core = null;
}

// ── repo resolution: realpath(cwd) -> git toplevel (worktree-aware, pure fs, no `git` subprocess) ->
//    basename -> config mapping. "不硬编码": the only literal is the default HOME path (same convention
//    already used by pmm-trigger-recall.cjs's own `PMM_HOME` override), everything else derives from it
//    or from an optional external mapping file. ─────────────────────────────────────────────────────────
function findGitToplevel(startDir) {
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    const gitPath = path.win32.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(gitPath); } catch (e) { st = null; }
    if (st) {
      if (st.isDirectory()) return dir;
      // worktree: `.git` is a FILE containing "gitdir: <main>/.git/worktrees/<name>" — the main repo
      // root is everything before the "/.git/worktrees/" boundary, regardless of worktree name/depth.
      try {
        const content = fs.readFileSync(gitPath, 'utf8');
        const m = /gitdir:\s*(.+)/.exec(content);
        if (m) {
          const gd = m[1].trim().replace(/\\/g, '/');
          const marker = '/.git/worktrees/';
          const idx = gd.indexOf(marker);
          if (idx !== -1) return gd.slice(0, idx).replace(/\//g, path.win32.sep);
        }
      } catch (e) { /* fall through to best-effort */ }
      return dir;
    }
    const parent = path.win32.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveRepo(cwdRaw) {
  if (!cwdRaw) return null;
  let real;
  try { real = fs.realpathSync(cwdRaw); } catch (e) { real = cwdRaw; }
  const top = findGitToplevel(real);
  if (!top) return null;
  const base = path.win32.basename(top).toLowerCase();
  // HIGH-1 followup (2026-09-23, Opus reproduction): this used to hardcode 'C:/Users/<user>' as the
  // fallback when PMM_IMPRESSION_HOME is unset -- correct on exactly one machine, same class of bug
  // pmm-trigger-recall.cjs's own HOME constant had before HIGH-1. PMM_IMPRESSION_HOME keeps its own
  // top-priority override (a distinct, already-documented env var this hook's own callers/self-tests
  // reference), but the fallback below it is now ledger.resolveHome() (PMM_HOME > USERPROFILE > HOME >
  // os.homedir(), the ONE resolver conventions.home_resolution names) instead of a second hardcoded copy.
  const home = (process.env.PMM_IMPRESSION_HOME || ledger.resolveHome()).replace(/\\/g, '/');
  const homeBase = path.win32.basename(home).toLowerCase();
  let mapped = (base === homeBase) ? 'home' : base;
  const mapPath = process.env.PMM_IMPRESSION_REPO_MAP;
  if (mapPath) {
    try {
      const j = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      if (j && typeof j === 'object' && typeof j[base] === 'string') mapped = j[base];
    } catch (e) { /* keep default mapping */ }
  }
  return mapped;
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────
function sha16(s) { return ledger.sha16(s); }

// HIGH-5 remediation display layer: strip usernames out of home-dir paths, blank quoted-string content,
// cap length. Persistent ledger keeps only hashes; this is the short, read-only, human-labelable layer.
function desensitize(cmd) {
  let s = String(cmd || '');
  s = s.replace(/\/Users\/[^/\s]+\//g, '/Users/_/');
  s = s.replace(/C:\/Users\/[^/\s]+\//gi, 'C:/Users/_/');
  s = s.replace(/"[^"]*"/g, '""');
  s = s.replace(/'[^']*'/g, "''");
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

// ── cmd-trigger corpus: reuse core.snapshotDir + core.parseAll (which internally calls
//    core.classifyTriggerLine per field line, fence-aware) — no second parser written here, per the
//    brief's explicit instruction. core.memDir() already respects PMM_MEM_DIR for test isolation. ──────
function loadCmdTriggers() {
  if (!core) return [];
  const snap = core.snapshotDir(core.memDir(), { requireAll: false });
  const all = core.parseAll(snap);
  const triggers = [];
  for (const e of all.entries) {
    for (const t of (e.triggers || [])) {
      if (t.kind === 'cmd') triggers.push({ tag: e.id, cls: e.class, repo: t.repo, exe: t.exe, sub: t.sub });
    }
  }
  return triggers;
}

// ── read-signal detection (item 24, "读信号"):
// pmm-search.sh / pmm-grep.sh query matching against live identity tags.
// Per spec: extract first non-option arg for search, second arg for grep; only write if it matches a live tag.
//
// L-8 fix (2026-09-24, audit `guards/audits/OPUS-2026-09-24-c05-batch-review.md` §2): this used to run
// core.snapshotDir()+core.parseAll() over the WHOLE memory corpus TWICE per matching read-signal event
// (once here, once more inside buildReadRow()'s own classTag lookup) and ONCE per EVERY OTHER qualifying
// Bash event too (the call below runs unconditionally, independent of whether anything matched) --
// measured against the real corpus (682 entries): ~21ms per parse, i.e. this hook's median cost rose by
// that amount on every single Bash call, matching or exceeding the "+33ms" the audit measured live.
// Since this hook is a fresh process per invocation (PreToolUse subprocess -- an in-memory cache buys
// nothing across calls), the cache has to live on disk, keyed by a signature of the corpus files' own
// mtime+size (mirrors the existing `.pmm-index-lkg/<sha(sourceOids+...)>` convention this codebase
// already uses elsewhere for corpus-derived caches), auto-invalidated the instant any memory file
// changes. This is the ONE new on-disk artifact this otherwise "zero file side effects... no
// correlation/state file" hook now writes (see file header above) -- pure performance cache, never
// consulted for anything but the read-signal tag set/class lookup, safe to delete at any time (a cache
// miss or a corrupt/unreadable cache file just falls through to a fresh parse, same as before this fix).
function readSignalCachePath() {
  const mach = (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
  return ledger.resolveRoot() + '/.read-signal-cache-' + mach + '.json';
}
function corpusMtimeKey() {
  const dir = core.memDir();
  const parts = [];
  for (const f of core.ALL_FILES) {
    try {
      const st = fs.statSync(dir + '/' + f);
      parts.push(f + ':' + st.mtimeMs + ':' + st.size);
    } catch (e) { parts.push(f + ':-'); }
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
let _readSignalCacheMem = null; // same-process memoization layered on top of the disk cache
function getReadSignalCorpus() {
  if (!core) return { tags: new Set(), classByTag: new Map() };
  const key = corpusMtimeKey();
  if (_readSignalCacheMem && _readSignalCacheMem.key === key) return _readSignalCacheMem;

  const cachePath = readSignalCachePath();
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached && cached.key === key && Array.isArray(cached.tags) && cached.classByTag && typeof cached.classByTag === 'object') {
      const result = { key, tags: new Set(cached.tags), classByTag: new Map(Object.entries(cached.classByTag)) };
      _readSignalCacheMem = result;
      return result;
    }
  } catch (e) { /* miss (absent/corrupt/stale) -- fall through to a fresh parse, same as before this fix */ }

  const snap = core.snapshotDir(core.memDir(), { requireAll: false });
  const all = core.parseAll(snap);
  const tags = new Set();
  const classByTag = new Map();
  for (const e of all.entries) {
    if (e.id && !e.archived) {
      const idLower = e.id.toLowerCase();
      tags.add(idLower);
      classByTag.set(idLower, e.class || '');
    }
  }
  const result = { key, tags, classByTag };
  _readSignalCacheMem = result;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ key, tags: Array.from(tags), classByTag: Object.fromEntries(classByTag) }));
  } catch (e) { /* cache write failure never affects correctness, only forfeits this run's speedup */ }
  return result;
}
function getReadSignalIdentities() {
  return getReadSignalCorpus().tags;
}

function extractReadSignalQuery(segment, scriptBasename) {
  // For pmm-search.sh: first non-option arg (index 1, after the script path itself)
  // For pmm-grep.sh: second non-option arg (index 2)
  const targetIdx = scriptBasename === 'pmm-search.sh' ? 1 : (scriptBasename === 'pmm-grep.sh' ? 2 : -1);
  if (targetIdx < 0) return null;

  let nonOptIdx = 0;
  for (const arg of segment.args) {
    if (!arg.raw.startsWith('-')) {
      if (nonOptIdx === targetIdx) {
        const decoded = (arg.decoded || arg.raw).toLowerCase().trim();
        return decoded || null;
      }
      nonOptIdx++;
    }
  }
  return null;
}

function buildReadRow(segment, ctx, matchedTag, scriptBasename) {
  const sidSha16 = sha16(ctx.sessionIdRaw || 'nosess');
  const gateInstanceId = 'read:' + String(segment.index);
  const eventKind = 'read';

  // Find the identity entry to get its class tag. L-8 fix: was its own SECOND full corpus parse
  // (on top of getReadSignalIdentities()'s) -- now reads the same cached corpus (see
  // getReadSignalCorpus() above), matchedTag already lowercased by extractReadSignalQuery().
  const classTag = core ? (getReadSignalCorpus().classByTag.get(matchedTag) || '') : '';

  const { impressionId, eventId, idMissing } = computeIds(
    ctx.sessionIdRaw, ctx.toolUseIdRaw, ctx.agentIdRaw, matchedTag, gateInstanceId, eventKind,
  );

  const toolUseIdF = ledger.sanitize(ctx.toolUseIdRaw || '');
  const agentIdF = ledger.sanitize(ctx.agentIdRaw || '');
  const agentTypeF = ledger.sanitize(ctx.agentTypeRaw || '');
  const promptIdF = ledger.sanitize(ctx.promptIdRaw || '');
  const anySanitized = toolUseIdF.sanitized || agentIdF.sanitized || agentTypeF.sanitized || promptIdF.sanitized;

  const cmdSha16 = sha16(ctx.cmd);

  const scriptName = scriptBasename === 'pmm-search.sh' ? 'pmm-search' : 'pmm-grep';
  return {
    sid_sha16: sidSha16, agent_sha16: ctx.agentIdRaw ? sha16(ctx.agentIdRaw) : '',
    agent_type: agentTypeF.value, prompt_id: promptIdF.value, tool_use_id: toolUseIdF.value,
    impression_id: impressionId, event_id: eventId, event_kind: eventKind,
    gate: '', confidence: '', class_tag: classTag, trigger_or_gate_id: matchedTag,
    cmd_sha16: cmdSha16, parser_version: PARSER_VERSION, mode: '',
    run_provenance: 'read:' + scriptName,
    sanitized: anySanitized ? '1' : '0', id_missing: idMissing ? '1' : '0',
    agent_id_missing: ctx.agentIdRaw ? '0' : '1',
  };
}

function matchTriggers(segments, repo, triggers) {
  const hits = [];
  for (const seg of segments) {
    if (seg.parse_status !== 'ok') continue; // HIGH-6: never match on a parse failure
    for (const tr of triggers) {
      if (tr.exe !== seg.exe) continue;
      if (tr.repo !== '*' && tr.repo !== repo) continue;
      if (tr.sub !== null && tr.sub !== seg.sub) continue;
      hits.push({ seg, tr });
    }
  }
  return hits;
}

// impression_id identifies ONE EXPOSURE OPPORTUNITY. Per brief §17 / M-SPEC 附录 A, gate_instance_id for
// an M0 trigger row is the matched segment's own index — so two segments of one command matching the
// SAME trigger now get TWO DISTINCT impression_ids (corrected from the pre-v3 design, which deliberately
// shared one impression_id across them). event_id = H(impression_id, event_kind, ordinal) is the
// per-ROW idempotency key.
function computeIds(sessionIdRaw, toolUseIdRaw, agentIdRaw, triggerTag, gateInstanceId, eventKind) {
  const idMissing = !(sessionIdRaw && toolUseIdRaw);
  if (idMissing) return { impressionId: '', eventId: '', idMissing: true };
  const impId = ledger.impressionId({
    session_id: sessionIdRaw, agent_id: agentIdRaw || '', tool_use_id: toolUseIdRaw,
    trigger_or_gate_id: triggerTag || '', gate_instance_id: gateInstanceId || '',
  });
  const ordinal = ledger.ordinalOf(triggerTag || '', gateInstanceId || '', eventKind);
  const evId = ledger.eventId(impId, eventKind, ordinal);
  return { impressionId: impId, eventId: evId, idMissing: false };
}

function buildRow(hit, ctx, eligibleTagsThisSession) {
  const tr = hit.tr, seg = hit.seg;
  const sidSha16 = sha16(ctx.sessionIdRaw || 'nosess');
  const cmdSha16 = sha16(ctx.cmd);

  const alreadyEligible = eligibleTagsThisSession.has(tr.tag);
  const eventKind = alreadyEligible ? 'suppressed' : 'eligible';
  const gateInstanceId = String(seg.index);
  const { impressionId, eventId, idMissing } = computeIds(
    ctx.sessionIdRaw, ctx.toolUseIdRaw, ctx.agentIdRaw, tr.tag, gateInstanceId, eventKind,
  );
  if (!alreadyEligible && !idMissing) eligibleTagsThisSession.add(tr.tag);

  const toolUseIdF = ledger.sanitize(ctx.toolUseIdRaw || '');
  const agentIdF = ledger.sanitize(ctx.agentIdRaw || '');
  const agentTypeF = ledger.sanitize(ctx.agentTypeRaw || '');
  const promptIdF = ledger.sanitize(ctx.promptIdRaw || '');
  const anySanitized = toolUseIdF.sanitized || agentIdF.sanitized || agentTypeF.sanitized || promptIdF.sanitized;

  // MEDIUM-6: mode = 'intervene' unless the trigger's class is policy-randomized, in which case it
  // is the resolved arm itself (the column M3 reads to tell the two arms apart). This hook never
  // emits additionalContext (pure observer), so there is no display fork -- only mode/run_provenance
  // change; resolve() never throws, but wrapped defensively so a policy read failure can never take
  // down this otherwise-fail-open hook.
  // LOW-5 (2026-09-17, codex second wave / Opus reproduction): root is passed EXPLICITLY as
  // ledger.resolveRoot() -- the same value this hook's own ledger writes already use -- instead of
  // letting policy.resolve() fall back to its own default internally. This was the ONE writer that
  // omitted it (pmm-trigger-recall.cjs already passes its own RECALL_ROOT explicitly); with a
  // whitespace-only PMM_RECALL_ROOT the two resolvers used to land on genuinely different
  // directories (policy.cjs's old private resolveRoot() never trimmed), so this hook's eligible rows
  // could silently disagree with the gate/trigger hooks about the SAME session x class's assigned arm.
  let pol;
  try { pol = policy.resolve(ctx.sessionIdRaw || '', tr.cls || '', { root: ledger.resolveRoot() }); }
  catch (e) { pol = { arm: 'shadow', provenance: 'policy:corrupt' }; }
  const mode = (pol.provenance === 'policy:randomized') ? pol.arm : 'intervene';

  const row = {
    sid_sha16: sidSha16, agent_sha16: ctx.agentIdRaw ? sha16(ctx.agentIdRaw) : '',
    agent_type: agentTypeF.value, prompt_id: promptIdF.value, tool_use_id: toolUseIdF.value,
    impression_id: impressionId, event_id: eventId, event_kind: eventKind,
    gate: '', confidence: '', class_tag: tr.cls || '', trigger_or_gate_id: tr.tag,
    cmd_sha16: cmdSha16, parser_version: PARSER_VERSION, mode: mode,
    run_provenance: pol.provenance,
    sanitized: anySanitized ? '1' : '0', id_missing: idMissing ? '1' : '0',
    agent_id_missing: ctx.agentIdRaw ? '0' : '1',
  };
  return { row, eventKind, impressionId, tag: tr.tag, seg };
}

// Every qualifying Bash event writes exactly one event_kind='observed' row. trigger_or_gate_id/gate/
// confidence/class_tag are blank — that row describes the whole hook event, not one segment-vs-trigger
// match. gate_instance_id='' per 附录 A ("observed/session-end 为空").
function buildObservedRow(ctx) {
  const sidSha16 = sha16(ctx.sessionIdRaw || 'nosess');
  const cmdSha16 = sha16(ctx.cmd);
  const { impressionId, eventId, idMissing } = computeIds(
    ctx.sessionIdRaw, ctx.toolUseIdRaw, ctx.agentIdRaw, '', '', 'observed',
  );

  const toolUseIdF = ledger.sanitize(ctx.toolUseIdRaw || '');
  const agentIdF = ledger.sanitize(ctx.agentIdRaw || '');
  const agentTypeF = ledger.sanitize(ctx.agentTypeRaw || '');
  const promptIdF = ledger.sanitize(ctx.promptIdRaw || '');
  const anySanitized = toolUseIdF.sanitized || agentIdF.sanitized || agentTypeF.sanitized || promptIdF.sanitized;

  return {
    sid_sha16: sidSha16, agent_sha16: ctx.agentIdRaw ? sha16(ctx.agentIdRaw) : '',
    agent_type: agentTypeF.value, prompt_id: promptIdF.value, tool_use_id: toolUseIdF.value,
    impression_id: impressionId, event_id: eventId, event_kind: 'observed',
    gate: '', confidence: '', class_tag: '', trigger_or_gate_id: '',
    cmd_sha16: cmdSha16, parser_version: PARSER_VERSION, mode: '',
    run_provenance: process.env.PMM_RECALL_TAG || '',
    sanitized: anySanitized ? '1' : '0', id_missing: idMissing ? '1' : '0',
    agent_id_missing: ctx.agentIdRaw ? '0' : '1',
  };
}

function writeImpressions(hits, ctx, parsed) {
  const root = ledger.resolveRoot();
  const sidSha16 = sha16(ctx.sessionIdRaw || 'nosess');
  const eligibleTagsThisSession = new Set();
  try {
    const content = fs.readFileSync(ledger.ledgerPath(root), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const kindIdx = ledger.COLUMNS.indexOf('event_kind');
    const sidIdx = ledger.COLUMNS.indexOf('sid_sha16');
    const trigIdx = ledger.COLUMNS.indexOf('trigger_or_gate_id');
    for (let i = 1; i < lines.length; i++) { // skip header row
      const cols = lines[i].split('\t');
      if (cols[sidIdx] === sidSha16 && cols[kindIdx] === 'eligible') eligibleTagsThisSession.add(cols[trigIdx]);
    }
  } catch (e) { /* no ledger yet: everything in this call starts eligible */ }

  ledger.writeEvent(buildObservedRow(ctx), { root });

  const queueRows = [];
  for (const hit of hits) {
    const built = buildRow(hit, ctx, eligibleTagsThisSession);
    ledger.writeEvent(built.row, { root });
    if (built.eventKind === 'eligible') {
      queueRows.push({
        impression_id: built.impressionId, trigger_or_gate_id: built.tag, class_tag: built.seg && hit.tr.cls || '',
        exe: built.seg.exe, sub: built.seg.sub || '', snippet: desensitize(ctx.cmd),
      });
    }
  }
  for (const q of queueRows) ledger.writeQueue(q, { root });

  // ── item 24 "读信号": detect pmm-search.sh / pmm-grep.sh with live identity tag queries ──
  if (parsed && parsed.segments && core) {
    const liveIdentities = getReadSignalIdentities();
    for (const segment of parsed.segments) {
      if (segment.parse_status !== 'ok') continue;
      // L-7 fix (2026-09-24, audit `guards/audits/OPUS-2026-09-24-c05-batch-review.md` §2): a read
      // signal only counts when the SEGMENT'S OWN EXE is bash/sh/node running the script as its
      // operand -- `cat ~/.../pmm-search.sh <tag>` used to be misdetected too (this loop treated
      // args[0] as "the script path" for ANY exe, with no exe check at all, so merely CATTING the
      // script with a live tag as a second word wrote a spurious 'read' row for a command that never
      // actually ran the search tool). Direct execution (`./pmm-search.sh <tag>`, exe=the script
      // itself) remains a documented KNOWN-GAP, unchanged by this fix (spec's own item 24 wording).
      if (segment.exe !== 'bash' && segment.exe !== 'sh' && segment.exe !== 'node') continue;
      if (!segment.args || segment.args.length === 0) continue;

      const scriptPath = segment.args[0].decoded || segment.args[0].raw;
      const scriptBasename = path.win32.basename(scriptPath).toLowerCase();

      if (scriptBasename === 'pmm-search.sh' || scriptBasename === 'pmm-grep.sh') {
        const query = extractReadSignalQuery(segment, scriptBasename);
        if (query && liveIdentities.has(query)) {
          const readRow = buildReadRow(segment, ctx, query, scriptBasename);
          ledger.writeEvent(readRow, { root });
        }
      }
    }
  }
}

// ── 补遗三第 33 条(2026-09-24, C05-BUILD-SPEC.md「召回触发面补洞」): Bash 命令若静态可判出
// 对 `.claude/guards/specs/*`、`.claude/memory/*.md` 的写入,视为该路径的一次 Edit 事件,走
// pmm-trigger-recall.cjs 同一推送入口(子进程复用它整条匹配/去重/policy/渲染逻辑,本文件不重
// 实现任何一步——只负责从命令文本里静态判出「写到哪」,然后拼一个等价的 Edit hook 载荷喂给它)。
// 由来:2026-09-24 台账证实主会话用 Bash 脚本改 spec 补遗时召回触发器 0 次推送(触发器只挂
// Edit|Write 路径,主脑用 Bash 改 spec 未命中),[process:copy-open-source-before-building-infra]
// 被绕开约 2M token 后才发现。
//
// 「只能静态判就静态判」(spec 原文):下列四种形态是纯文本/已解析 segment 结构上的模式匹配,
// 不是完整 shell 语义求值——变量拼接、间接路径(如 `f=x; > $f`)、外部脚本文件内容里非字面量的
// writeFileSync 调用均不追,是记录在案的 KNOWN-GAP,不冒充完备:
//   (a) `>`/`>>` 重定向目标(segment.redirects,op ∈ {'>','>>'})
//   (b) `tee`/`tee -a` 操作数
//   (c) `cp`/`mv` 的目的地操作数(最后一个非选项操作数)
//   (d) node/python 调用:任一非选项操作数本身是这些路径下的路径(脚本文件路径参数直指这些路径);
//       或 -e/-p/--eval/--print/-c 内联代码文本里 `writeFileSync(<字面量>, ...)` 的字面量目标。
function isSpecOrMemMdPath(absPath) {
  const norm = String(absPath || '').replace(/\\/g, '/').toLowerCase();
  if (norm.indexOf('/.claude/guards/specs/') !== -1) return true;
  if (norm.indexOf('/.claude/memory/') !== -1 && /\.md$/.test(norm)) return true;
  return false;
}

function resolveAgainstCwd(raw, cwd) {
  let p = String(raw || '').replace(/\\/g, '/');
  if (!p) return null;
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) return p; // already absolute
  const base = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!base) return null;
  return base + '/' + p;
}

// writeFileSync(<quote><target><same-quote> — lazy up to the FIRST unescaped matching quote (no
// nested-quote handling; a literal containing its own quote char defeats this, documented KNOWN-GAP).
const WRITEFILESYNC_RE = /writeFileSync\s*\(\s*(['"`])((?:(?!\1).)*)\1/g;
function extractInlineWriteTargets(text) {
  const out = [];
  const s = String(text || '');
  let m;
  WRITEFILESYNC_RE.lastIndex = 0;
  while ((m = WRITEFILESYNC_RE.exec(s))) out.push(m[2]);
  return out;
}

const EVAL_FLAGS = new Set(['-e', '-p', '--eval', '--print', '-c']);

// detectWriteTargets(segment, cwd) -> raw (unresolved) target strings this ONE segment names, per
// the four forms above. Resolution against cwd + the specs/memory path filter happen in the caller
// (collectBashWriteTargets) so this function stays a pure per-segment extractor, easy to unit-test.
function detectWriteTargets(segment) {
  const raw = [];
  if (!segment || segment.parse_status !== 'ok') return raw; // HIGH-6 convention: never trust a parse failure
  const exe = segment.exe;
  const args = segment.args || [];

  for (const r of (segment.redirects || [])) {
    if (r.op === '>' || r.op === '>>') {
      const dec = (r.target && (r.target.decoded || r.target.raw)) || r.raw_target;
      if (dec) raw.push(dec);
    }
  }

  if (exe === 'tee') {
    for (const a of args) {
      const v = a.decoded || a.raw;
      if (v && !String(a.raw || '').startsWith('-')) raw.push(v);
    }
  }

  if (exe === 'cp' || exe === 'mv') {
    const operands = args.filter((a) => !String(a.raw || '').startsWith('-')).map((a) => a.decoded || a.raw);
    if (operands.length >= 2) raw.push(operands[operands.length - 1]);
  }

  if (exe === 'node' || exe === 'python' || exe === 'python3') {
    let inEval = false;
    for (const a of args) {
      const argRaw = a.raw || '';
      const dec = a.decoded || argRaw;
      if (inEval) {
        for (const t of extractInlineWriteTargets(dec)) raw.push(t);
        inEval = false;
        continue;
      }
      if (EVAL_FLAGS.has(argRaw)) { inEval = true; continue; }
      if (!argRaw.startsWith('-')) raw.push(dec); // 脚本文件路径参数/直接路径操作数
    }
  }

  return raw;
}

function collectBashWriteTargets(parsed, cwd) {
  if (!parsed || !Array.isArray(parsed.segments)) return [];
  const seen = new Set();
  const out = [];
  for (const seg of parsed.segments) {
    for (const t of detectWriteTargets(seg)) {
      const resolved = resolveAgainstCwd(t, cwd);
      if (!resolved || !isSpecOrMemMdPath(resolved)) continue;
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

// buildBashWriteRow: this hook's OWN telemetry row for the detection event (distinct from whatever
// row(s) the pmm-trigger-recall.cjs subprocess writes for the push decision itself, which already
// carry their own policy-derived run_provenance) — "台账记 via=bash-write" per spec text, so an
// audit can tell "this push happened because of a Bash write" apart from a native Edit/Write call.
function buildBashWriteRow(ctx, targetPath, pushed) {
  const sidSha16 = sha16(ctx.sessionIdRaw || 'nosess');
  const targetKey = 'bash-write:' + sha16(targetPath);
  const { impressionId, eventId, idMissing } = computeIds(
    ctx.sessionIdRaw, ctx.toolUseIdRaw, ctx.agentIdRaw, targetKey, targetKey, 'bash-write',
  );
  const toolUseIdF = ledger.sanitize(ctx.toolUseIdRaw || '');
  const agentIdF = ledger.sanitize(ctx.agentIdRaw || '');
  const agentTypeF = ledger.sanitize(ctx.agentTypeRaw || '');
  const promptIdF = ledger.sanitize(ctx.promptIdRaw || '');
  const anySanitized = toolUseIdF.sanitized || agentIdF.sanitized || agentTypeF.sanitized || promptIdF.sanitized;
  return {
    sid_sha16: sidSha16, agent_sha16: ctx.agentIdRaw ? sha16(ctx.agentIdRaw) : '',
    agent_type: agentTypeF.value, prompt_id: promptIdF.value, tool_use_id: toolUseIdF.value,
    impression_id: impressionId, event_id: eventId, event_kind: 'bash-write',
    gate: '', confidence: '', class_tag: '', trigger_or_gate_id: desensitize(targetPath),
    cmd_sha16: sha16(ctx.cmd), parser_version: PARSER_VERSION, mode: '',
    run_provenance: 'via=bash-write;pushed=' + (pushed ? '1' : '0'),
    sanitized: anySanitized ? '1' : '0', id_missing: idMissing ? '1' : '0',
    agent_id_missing: ctx.agentIdRaw ? '0' : '1',
  };
}

// pushBashWriteRecall: for each detected target, construct an equivalent Edit hook payload and hand
// it to a FRESH pmm-trigger-recall.cjs subprocess (inherits this process's own env, so whatever
// HOME/PMM_*/isolation redirection this hook itself received propagates unchanged — no separate
// isolation surface introduced). Its whole matching/dedup/policy/rendering pipeline runs completely
// unmodified; this function only relays the FIRST non-empty additionalContext it produces (a hook can
// only usefully emit one JSON blob on stdout) and ledgers every attempted target either way.
function pushBashWriteRecall(targets, ctx) {
  const root = ledger.resolveRoot();
  let pushedAny = false;
  for (const targetPath of targets) {
    let pushed = false;
    try {
      const eventPayload = {
        tool_name: 'Edit',
        tool_input: { file_path: targetPath },
        cwd: ctx.cwd,
      };
      if (ctx.sessionIdRaw) eventPayload.session_id = ctx.sessionIdRaw;
      if (ctx.toolUseIdRaw) eventPayload.tool_use_id = ctx.toolUseIdRaw;
      if (ctx.agentIdRaw) eventPayload.agent_id = ctx.agentIdRaw;
      if (ctx.agentTypeRaw) eventPayload.agent_type = ctx.agentTypeRaw;
      if (ctx.promptIdRaw) eventPayload.prompt_id = ctx.promptIdRaw;
      const r = spawnSync(process.execPath, [path.join(__dirname, 'pmm-trigger-recall.cjs')], {
        input: JSON.stringify(eventPayload), env: process.env, timeout: 5000,
      });
      const out = (r.stdout || Buffer.alloc(0)).toString('utf8').trim();
      if (out) {
        pushed = true;
        if (!pushedAny) {
          let parsedOut = null;
          try { parsedOut = JSON.parse(out); } catch (e) { parsedOut = null; }
          const ctxText = parsedOut && parsedOut.hookSpecificOutput && parsedOut.hookSpecificOutput.additionalContext;
          if (ctxText) {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: { hookEventName: ctx.hookEventNameRaw || 'PreToolUse', additionalContext: ctxText },
            }));
            pushedAny = true;
          } else {
            pushed = false;
          }
        }
      }
    } catch (e) { /* fail-open: this channel must never crash the observer */ }
    try { ledger.writeEvent(buildBashWriteRow(ctx, targetPath, pushed), { root }); } catch (e) { /* swallow */ }
  }
}

function main() {
  let raw;
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { miss(); }
  let data;
  try { data = JSON.parse(raw); } catch (e) { miss(); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) miss();

  const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input)) ? data.tool_input : null;
  if (!toolInput) miss();
  const cmd = toolInput.command;
  if (typeof cmd !== 'string' || cmd.trim() === '') miss();

  if (!core) miss(); // can't classify triggers without pmm-core.cjs -> silent fail-open, zero writes

  const cwd = (typeof data.cwd === 'string' && data.cwd.trim() !== '') ? data.cwd : process.cwd();
  const sessionIdRaw = (typeof data.session_id === 'string' && data.session_id) ? data.session_id : null;
  const toolUseIdRaw =
    (typeof data.tool_use_id === 'string' && data.tool_use_id) ? data.tool_use_id :
    (typeof data.toolUseId === 'string' && data.toolUseId) ? data.toolUseId :
    (typeof data.tool_call_id === 'string' && data.tool_call_id) ? data.tool_call_id : null;
  const agentIdRaw =
    (typeof data.agent_id === 'string' && data.agent_id) ? data.agent_id :
    (typeof data.agentId === 'string' && data.agentId) ? data.agentId : null;
  const agentTypeRaw =
    (typeof data.agent_type === 'string' && data.agent_type) ? data.agent_type :
    (typeof data.agentType === 'string' && data.agentType) ? data.agentType : null;
  const promptIdRaw =
    (typeof data.prompt_id === 'string' && data.prompt_id) ? data.prompt_id :
    (typeof data.promptId === 'string' && data.promptId) ? data.promptId : null;

  const repo = resolveRepo(cwd);

  let parsed;
  try { parsed = parseCommand(cmd); } catch (e) { miss(); }

  let triggers;
  try { triggers = loadCmdTriggers(); } catch (e) { miss(); }

  // An empty trigger corpus or zero matches is NOT a "true miss" — we already have a valid, parseable
  // Bash event, so it gets its one 'observed' row regardless.
  const hits = matchTriggers(parsed.segments, repo, triggers || []);

  const hookEventNameRaw = (typeof data.hook_event_name === 'string' && data.hook_event_name) ? data.hook_event_name : 'PreToolUse';
  const ctx = { sessionIdRaw, toolUseIdRaw, agentIdRaw, agentTypeRaw, promptIdRaw, cmd, repo, cwd, hookEventNameRaw };

  writeImpressions(hits, ctx, parsed);

  // 补遗三第 33 条: Bash 写入 specs/memory 路径 -> 视为该路径的 Edit 事件,走同一召回入口。
  let bashWriteTargets = [];
  try { bashWriteTargets = collectBashWriteTargets(parsed, cwd); } catch (e) { bashWriteTargets = []; }
  if (bashWriteTargets.length) {
    try { pushBashWriteRecall(bashWriteTargets, ctx); } catch (e) { /* fail-open: never crash the observer */ }
  }

  process.exit(0);
}

module.exports = {
  resolveRepo, findGitToplevel, sanitizeField: ledger.sanitize, desensitize, sha16, matchTriggers, loadCmdTriggers,
  computeIds, detectWriteTargets, collectBashWriteTargets, isSpecOrMemMdPath, resolveAgainstCwd, extractInlineWriteTargets,
};

if (require.main === module && process.argv[2] !== '--self-test') {
  try { main(); } catch (e) { miss(); }
  process.exit(0);
}

// ============================================================================
// --self-test
// ============================================================================
// SELFTEST-BEGIN
// spec 22 (C05-BUILD-SPEC 补遗二 §22): every DUT subprocess this self-test spawns must get its
// environment from selftest-iso.cjs's isoEnv() (no bare ambient-env clone of any shape). REAL_TREE_HOME
// below is already K8-safe (derived from __dirname, exactly what selftest-iso.cjs's realHome() also
// computes) -- kept as the file's own name for minimal diff, reused wherever a case deliberately needs
// the REAL settings.json / REAL memory corpus (the e2eCase() wiring checks), while every fully-isolated
// case now points PMM_IMPRESSION_HOME at ITS OWN isolated root instead of the real tree (the K8 fix:
// the OLD `ledger.resolveHome()`-derived REAL_HOME_FOR_SELFTEST silently resolved to whatever HOME this
// self-test itself happened to be invoked under, not a stable real-tree reference).
const iso = require('./selftest-iso.cjs');
if (require.main === module && process.argv[2] === '--self-test') {
  const { spawnSync } = require('child_process'); // execFileSync no longer used here (see 2026-09-17 stderr-capture fix)
  const G = __dirname;
  const REAL_TREE_HOME = path.resolve(__dirname, '..', '..');
  const nonce = 'nonce-' + crypto.randomBytes(6).toString('hex');
  const fpSnap = iso.footprint.begin();
  let PASS = 0, FAIL = 0;
  function report(name, ok, detail) {
    if (ok) { console.log('PASS: ' + name); PASS++; }
    else { console.log('FAIL: ' + name + ' -- ' + (detail || '')); FAIL++; }
  }

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-bash-impression-selftest-'));
  function cleanup() { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  process.on('exit', cleanup);

  // ---- fixture memory corpus (isolated via PMM_MEM_DIR; never touches real ~/.claude/memory) ----
  const MEM = path.join(T, 'mem');
  fs.mkdirSync(MEM, { recursive: true });
  fs.writeFileSync(path.join(MEM, 'lessons.md'),
    '## Index\n\n## Entries\n\n' +
    '**2026-01-01 — footool wildcard trigger** [test:footool-trigger]\n' +
    '<!-- trigger: tool=Bash; repo=*; cmd=footool -->\n' +
    'Class: [[class:test-class]]\n' +
    'body text.\n\n' +
    '**2026-01-02 — npm test in fixturerepo** [test:npmtest-trigger]\n' +
    '<!-- trigger: tool=Bash; repo=fixturerepo; cmd=npm test -->\n' +
    'Class: [[class:test-class]]\n' +
    'body text.\n');
  fs.writeFileSync(path.join(MEM, 'decisions.md'), '## Index\n\n## Entries\n');
  fs.writeFileSync(path.join(MEM, 'standinginstructions.md'), '## Index\n\n## Entries\n');
  fs.writeFileSync(path.join(MEM, 'classes.md'), '## Index\n\n## Entries\n');

  const EMPTY_MEM = path.join(T, 'empty-mem');
  fs.mkdirSync(EMPTY_MEM, { recursive: true });
  fs.writeFileSync(path.join(EMPTY_MEM, 'lessons.md'), '## Index\n\n## Entries\n');

  // fixture git repos (pure fs; no `git` binary invoked, matching resolveRepo's own implementation)
  const NOREPO_DIR = 'C:/Windows/Temp';
  const FIXREPO_DIR = path.join(T, 'fixturerepo');
  fs.mkdirSync(path.join(FIXREPO_DIR, '.git'), { recursive: true });
  fs.mkdirSync(path.join(FIXREPO_DIR, 'sub'), { recursive: true });
  const OTHERREPO_DIR = path.join(T, 'otherrepo');
  fs.mkdirSync(path.join(OTHERREPO_DIR, '.git'), { recursive: true });

  // ---- unit tests: resolveRepo (pure fs walk-up + worktree .git-file resolution) ----
  const { resolveRepo, sanitizeField, desensitize, matchTriggers, computeIds } = require('./pmm-bash-impression.cjs');
  report('resolveRepo: subdir of a real repo -> basename', resolveRepo(path.join(FIXREPO_DIR, 'sub')) === 'fixturerepo',
    resolveRepo(path.join(FIXREPO_DIR, 'sub')));
  report('resolveRepo: no .git anywhere up to temp root -> null', resolveRepo(NOREPO_DIR) === null, String(resolveRepo(NOREPO_DIR)));
  {
    const mainRepo = path.join(T, 'wtmain');
    fs.mkdirSync(path.join(mainRepo, '.git', 'worktrees', 'wt1'), { recursive: true });
    const wtDir = path.join(T, 'wtplace', 'wt1');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: ' + mainRepo.replace(/\\/g, '/') + '/.git/worktrees/wt1\n');
    report('resolveRepo: worktree .git file resolves to MAIN repo basename, not the worktree dir name',
      resolveRepo(wtDir) === 'wtmain', String(resolveRepo(wtDir)));
  }
  // HIGH-1 followup (2026-09-23, Opus reproduction): resolveRepo()'s home-basename fallback used to
  // hardcode 'C:/Users/<user>' when PMM_IMPRESSION_HOME was unset. Proven here directly (in-process,
  // no spawn needed since resolveRepo() is a pure function of its cwd argument + process.env): with
  // PMM_IMPRESSION_HOME deleted and PMM_HOME pointed at a FAKE repo whose basename is NOT the real machine's home basename,
  // resolveRepo() must still map that fixture to 'home' -- which only happens if the fallback is
  // genuinely calling ledger.resolveHome() (honoring PMM_HOME) and not silently defaulting to the
  // old literal (whose basename really is the real machine's home basename, so a regression here would make this assert false
  // against a same-basename coincidence on THIS machine -- it instead asserts against a basename that
  // deliberately does NOT match the real machine home, so a hardcoded-fallback regression goes red).
  {
    const homeFixtureRepo = path.join(T, 'homelike-repo');
    fs.mkdirSync(path.join(homeFixtureRepo, '.git'), { recursive: true });
    const fakeHomeSameBasename = path.join(T, 'unrelated-parent', 'homelike-repo');
    fs.mkdirSync(fakeHomeSameBasename, { recursive: true });
    const before = { PMM_HOME: process.env.PMM_HOME, PMM_IMPRESSION_HOME: process.env.PMM_IMPRESSION_HOME };
    delete process.env.PMM_IMPRESSION_HOME;
    process.env.PMM_HOME = fakeHomeSameBasename;
    try {
      report('resolveRepo: PMM_IMPRESSION_HOME unset falls back to ledger.resolveHome() (here: PMM_HOME), not an old single-machine hardcoded home path',
        resolveRepo(homeFixtureRepo) === 'home', String(resolveRepo(homeFixtureRepo)));
    } finally {
      if (before.PMM_HOME === undefined) delete process.env.PMM_HOME; else process.env.PMM_HOME = before.PMM_HOME;
      if (before.PMM_IMPRESSION_HOME === undefined) delete process.env.PMM_IMPRESSION_HOME; else process.env.PMM_IMPRESSION_HOME = before.PMM_IMPRESSION_HOME;
    }
  }
  report('sanitizeField: tab/CR/LF/NUL replaced, sanitized=true', (() => {
    const r = sanitizeField('a\tb\rc\nd' + String.fromCharCode(0) + 'e');
    return r.value === 'a_b_c_d_e' && r.sanitized === true;
  })());
  report('sanitizeField: clean value passes through, sanitized=false', (() => {
    const r = sanitizeField('clean-value');
    return r.value === 'clean-value' && r.sanitized === false;
  })());
  report('desensitize: strips username from C:/Users/<name>/ and truncates >120 chars', (() => {
    const s = desensitize('cat C:/Users/<user>/secret/file.txt "quoted content here" ' + 'x'.repeat(150));
    return s.indexOf(os.userInfo().username) === -1 && s.length <= 120;
  })());
  report('matchTriggers: parse_status!=ok never matches (HIGH-6)', (() => {
    const segs = parseCommand('(footool; echo x)').segments;
    const hits = matchTriggers(segs, null, [{ tag: 't', cls: 'c', repo: '*', exe: 'footool', sub: null }]);
    return hits.length === 0 && segs[0].parse_status !== 'ok';
  })());
  report('computeIds: deterministic 16-hex, differ across event_kind for the same match', (() => {
    const a = computeIds('s1', 'tu1', 'ag1', 'trig', '0', 'eligible');
    const a2 = computeIds('s1', 'tu1', 'ag1', 'trig', '0', 'eligible');
    const b = computeIds('s1', 'tu1', 'ag1', 'trig', '0', 'suppressed');
    return a.impressionId === a2.impressionId && /^[0-9a-f]{16}$/.test(a.impressionId) &&
      /^[0-9a-f]{16}$/.test(a.eventId) && a.eventId !== b.eventId;
  })());
  report('computeIds: two DIFFERENT segment indices (gate_instance_id) -> DIFFERENT impression_id (brief §17)', (() => {
    const a = computeIds('s1', 'tu1', 'ag1', 'trig', '0', 'eligible');
    const b = computeIds('s1', 'tu1', 'ag1', 'trig', '1', 'eligible');
    return a.impressionId !== b.impressionId;
  })());
  report('computeIds: missing session_id/tool_use_id -> empty ids, idMissing=true', (() => {
    const a = computeIds(null, 'tu1', 'ag1', 'trig', '0', 'eligible');
    const b = computeIds('s1', null, 'ag1', 'trig', '0', 'eligible');
    return a.impressionId === '' && a.idMissing === true && b.impressionId === '' && b.idMissing === true;
  })());

  // ---- black-box tests: spawn the REAL hook process, env-isolated via PMM_RECALL_ROOT ----
  // 2026-09-17 falsify-caught bug (same class as bash-pipe-exitcode-watch.cjs's runWired()):
  // execFileSync() without an explicit stdio pipe never exposes a SUCCESSFUL (rc=0) child's stderr via its
  // own return value -- only the thrown Error's `.stderr` carries it, and only on a non-zero exit. The old
  // code here hardcoded `err = ''` on the success path, so every `r.err === 0` assertion below (most of
  // this file's black-box section) was structurally incapable of ever going red on a real stderr leak.
  // spawnSync() unconditionally returns {stdout, stderr, status} regardless of exit code.
  function runHook(jsonStdin, envOverrides) {
    // every caller's envOverrides already carries its own fresh PMM_RECALL_ROOT (freshRoot() below) --
    // that same isolated directory doubles as this DUT subprocess's HOME/USERPROFILE/PMM_HOME base.
    const base = (envOverrides && envOverrides.PMM_RECALL_ROOT) || T;
    const env = iso.isoEnv(base, envOverrides);
    const r = spawnSync(process.execPath, [path.join(G, 'pmm-bash-impression.cjs')], {
      input: jsonStdin, env, timeout: 5000,
    });
    const out = r.stdout || Buffer.alloc(0);
    const err = r.stderr || Buffer.alloc(0);
    const rc = (r.status === null || r.status === undefined) ? -1 : r.status;
    return { out: Buffer.from(out).length, err: Buffer.from(err).length, rc };
  }

  function freshRoot(tag) {
    const root = path.join(T, 'root-' + tag);
    return {
      root,
      env: {
        PMM_MEM_DIR: MEM, PMM_RECALL_ROOT: root,
        PMM_IMPRESSION_HOME: root,
      },
    };
  }
  function ledgerRows(root) {
    try {
      const lines = fs.readFileSync(path.join(root, 'events-v3-' + os.hostname() + '.tsv'), 'utf8').split('\n').filter(Boolean);
      return lines.slice(1); // drop header
    } catch (e) { return []; }
  }
  function queueRows(root) {
    try {
      const lines = fs.readFileSync(path.join(root, 'queue-' + os.hostname() + '.tsv'), 'utf8').split('\n').filter(Boolean);
      return lines.slice(1);
    } catch (e) { return []; }
  }
  const KIND_IDX = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('event_kind');
  const IMP_IDX = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('impression_id');
  const EVT_IDX = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('event_id');
  const PARSER_IDX = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('parser_version');
  const MODE_IDX = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('mode');
  const RUNPROV_IDX = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('run_provenance');
  function byKind(rows, kind) { return rows.filter((r) => r.split('\t')[KIND_IDX] === kind); }

  console.log('==================================================');
  console.log('Black-box: every qualifying event gets an observed row + eligible/suppressed dedup');
  console.log('==================================================');
  {
    const p = freshRoot('a');
    const j1 = JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu1', cwd: NOREPO_DIR, tool_input: { command: 'footool arg1' } });
    const r1 = runHook(j1, p.env);
    report('eligible hit: stdout=0 stderr=0 rc=0', r1.out === 0 && r1.err === 0 && r1.rc === 0, JSON.stringify(r1));
    let rows = ledgerRows(p.root);
    report('eligible hit: exactly 2 rows (1 observed + 1 eligible)', rows.length === 2 && byKind(rows, 'observed').length === 1 && byKind(rows, 'eligible').length === 1, JSON.stringify(rows));
    report('eligible hit: parser_version column is 1.2', byKind(rows, 'eligible')[0].split('\t')[PARSER_IDX] === '1.2', JSON.stringify(rows));
    report('eligible hit: queue got 1 row', queueRows(p.root).length === 1, JSON.stringify(queueRows(p.root)));

    const j2 = JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu2', cwd: NOREPO_DIR, tool_input: { command: 'footool arg2' } });
    const r2 = runHook(j2, p.env);
    report('same session, same trigger again: still zero-output', r2.out === 0 && r2.err === 0 && r2.rc === 0, JSON.stringify(r2));
    rows = ledgerRows(p.root);
    report('same session, same trigger again: +2 rows (1 observed + 1 suppressed), 4 total', rows.length === 4 && byKind(rows, 'observed').length === 2 && byKind(rows, 'suppressed').length === 1, JSON.stringify(rows));
    report('same session, same trigger again: queue NOT grown (still 1)', queueRows(p.root).length === 1, JSON.stringify(queueRows(p.root)));

    const j3 = JSON.stringify({ session_id: 'test:s2', tool_use_id: 'toolu_selftest_tu3', cwd: NOREPO_DIR, tool_input: { command: 'footool arg3' } });
    runHook(j3, p.env);
    rows = ledgerRows(p.root);
    report('DIFFERENT session, same trigger: eligible again (dedup is per-session), 6 rows total', rows.length === 6 && byKind(rows, 'eligible').length === 2, JSON.stringify(rows));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: MEDIUM-6 (2026-09-17, coordinator dispatch) -- mode/run_provenance reflect');
  console.log('policy.resolve(session, class), not the old hardcoded mode=\'\' this hook used to write');
  console.log('==================================================');
  {
    const p = freshRoot('policy-absent');
    const j = JSON.stringify({ session_id: 'test:pol-s1', tool_use_id: 'toolu_selftest_pol-tu1', cwd: NOREPO_DIR, tool_input: { command: 'footool x' } });
    runHook(j, p.env);
    const rows = ledgerRows(p.root);
    const elig = byKind(rows, 'eligible')[0].split('\t');
    report('no policy.json: mode=intervene (legacy default, "行为不变")', elig[MODE_IDX] === 'intervene', JSON.stringify(elig));
    report('no policy.json: run_provenance=policy:absent', elig[RUNPROV_IDX] === 'policy:absent', JSON.stringify(elig));
  }
  {
    // class:test-class (the fixture trigger's own class) marked randomized; find one session that
    // lands on each arm via the SAME assignment() formula the hook itself calls.
    const polMod = require('./pmm-recall-policy.cjs');
    let shadowSid = null, intervSid = null;
    for (let i = 0; i < 500 && (!shadowSid || !intervSid); i++) {
      const sid = 'pmed6-' + i;
      const arm = polMod.assignment(sid, 'class:test-class', 'randomized');
      if (arm === 'shadow' && !shadowSid) shadowSid = sid;
      if (arm === 'intervene' && !intervSid) intervSid = sid;
    }
    report('setup: found both a shadow-arm and an intervene-arm session id for class:test-class', !!shadowSid && !!intervSid, JSON.stringify({ shadowSid, intervSid }));

    const pRoot = freshRoot('policy-randomized').root;
    fs.mkdirSync(pRoot, { recursive: true });
    fs.writeFileSync(path.join(pRoot, 'policy.json'), JSON.stringify({ 'class:test-class': { mode: 'randomized' } }));
    const envR = { PMM_MEM_DIR: MEM, PMM_RECALL_ROOT: pRoot, PMM_IMPRESSION_HOME: pRoot };

    const jShadow = JSON.stringify({ session_id: shadowSid, tool_use_id: 'toolu_selftest_tu-shd', cwd: NOREPO_DIR, tool_input: { command: 'footool x' } });
    const rShadow = runHook(jShadow, envR);
    report('policy randomized, shadow arm: still zero-output (pure observer, never suppresses stdout itself)', rShadow.out === 0 && rShadow.err === 0 && rShadow.rc === 0, JSON.stringify(rShadow));
    const rowsShadow = ledgerRows(pRoot);
    const eligShadow = byKind(rowsShadow, 'eligible')[0].split('\t');
    report('policy randomized, shadow arm: mode=shadow', eligShadow[MODE_IDX] === 'shadow', JSON.stringify(eligShadow));
    report('policy randomized, shadow arm: run_provenance=policy:randomized', eligShadow[RUNPROV_IDX] === 'policy:randomized', JSON.stringify(eligShadow));

    const jInterv = JSON.stringify({ session_id: intervSid, tool_use_id: 'toolu_selftest_tu-itv', cwd: NOREPO_DIR, tool_input: { command: 'footool x' } });
    runHook(jInterv, envR);
    const rowsInterv = ledgerRows(pRoot);
    const eligInterv = byKind(rowsInterv, 'eligible').find((r) => r.split('\t')[require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('tool_use_id')] === 'toolu_selftest_tu-itv').split('\t');
    report('policy randomized, intervene arm: mode=intervene', eligInterv[MODE_IDX] === 'intervene', JSON.stringify(eligInterv));
    report('policy randomized, intervene arm: run_provenance=policy:randomized', eligInterv[RUNPROV_IDX] === 'policy:randomized', JSON.stringify(eligInterv));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: LOW-5 (2026-09-17, codex second wave / Opus reproduction) -- PMM_RECALL_ROOT=\' \'');
  console.log('(whitespace-only) must resolve identically for the ledger write AND the policy lookup');
  console.log('==================================================');
  {
    // HOME/USERPROFILE redirected to a temp dir so the DEFAULT root (what PMM_RECALL_ROOT=' ' must
    // fall back to) lands somewhere safe -- never the real ~/.claude/.local/pmm-recall.
    const fakeHome = path.join(T, 'low5-fakehome-' + Date.now());
    fs.mkdirSync(fakeHome, { recursive: true });
    const expectedDefaultRoot = path.join(fakeHome, '.claude', '.local', 'pmm-recall');
    const env = iso.isoEnv(fakeHome, { PMM_MEM_DIR: MEM, PMM_IMPRESSION_HOME: fakeHome, PMM_RECALL_ROOT: ' ' });
    const j = JSON.stringify({ session_id: 'test:low5-sess', tool_use_id: 'toolu_selftest_low5-tu', cwd: NOREPO_DIR, tool_input: { command: 'footool x' } });
    const r = spawnSync(process.execPath, [path.join(G, 'pmm-bash-impression.cjs')], { input: j, env, timeout: 5000 });
    report('LOW-5: whitespace-only PMM_RECALL_ROOT -> hook still exits zero-output', Buffer.from(r.stdout || '').length === 0 && Buffer.from(r.stderr || '').length === 0 && r.status === 0, JSON.stringify({ status: r.status }));
    const ledgerFile = path.join(expectedDefaultRoot, 'events-v3-' + os.hostname() + '.tsv');
    report('LOW-5: ledger write landed at the DEFAULT root derived from the redirected HOME (never a literal \' \' path)', fs.existsSync(ledgerFile), ledgerFile);
    let rows = [];
    try { rows = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).slice(1); } catch (e) { /* leave empty */ }
    const elig = byKind(rows, 'eligible')[0];
    const eligCols = elig ? elig.split('\t') : [];
    report('LOW-5: eligible row present at that SAME default-root ledger (policy lookup used the same directory as the write)', !!elig, JSON.stringify(rows));
    report('LOW-5: run_provenance is policy:absent (no policy.json at the default root) -- NOT an error, NOT a bogus whitespace-derived path', eligCols[RUNPROV_IDX] === 'policy:absent', JSON.stringify(eligCols));
    report('LOW-5: mode=intervene (absent provenance -> legacy default, consistent with the ledger write path actually being found)', eligCols[MODE_IDX] === 'intervene', JSON.stringify(eligCols));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: repo-scoped trigger matching');
  console.log('==================================================');
  {
    const p = freshRoot('b');
    const jMatch = JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu1', cwd: path.join(FIXREPO_DIR, 'sub'), tool_input: { command: 'npm test' } });
    runHook(jMatch, p.env);
    const rows = ledgerRows(p.root);
    report('repo=fixturerepo trigger matches when cwd resolves to fixturerepo: observed+eligible', rows.length === 2 && byKind(rows, 'eligible').length === 1, JSON.stringify(rows));

    const p2 = freshRoot('b2');
    const jNoMatch = JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu1', cwd: OTHERREPO_DIR, tool_input: { command: 'npm test' } });
    runHook(jNoMatch, p2.env);
    const rows2 = ledgerRows(p2.root);
    report('repo=fixturerepo trigger does NOT match a different repo: exactly 1 observed row, zero eligible', rows2.length === 1 && rows2[0].split('\t')[KIND_IDX] === 'observed', JSON.stringify(rows2));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: same trigger matching TWO segments of one command -> TWO DISTINCT impression_ids (brief §17)');
  console.log('==================================================');
  {
    const p = freshRoot('j');
    const j = JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu1', cwd: NOREPO_DIR, tool_input: { command: 'footool a; footool b' } });
    runHook(j, p.env);
    const rows = ledgerRows(p.root);
    const matchRows = rows.filter((r) => r.split('\t')[KIND_IDX] !== 'observed');
    const impIds = matchRows.map((r) => r.split('\t')[IMP_IDX]);
    const evtIds = matchRows.map((r) => r.split('\t')[EVT_IDX]);
    report('two segments, same trigger: 2 match rows (1 eligible + 1 suppressed) with DIFFERENT impression_ids (segment-index gate_instance_id)',
      matchRows.length === 2 && impIds[0] !== impIds[1] && impIds[0] !== '' && impIds[1] !== '', JSON.stringify(rows));
    report('two segments, same trigger: event_id also differs', evtIds.length === 2 && evtIds[0] !== evtIds[1], JSON.stringify(rows));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: item 24 (读信号) — pmm-search.sh / pmm-grep.sh identity tag matching');
  console.log('==================================================');
  {
    // Create a fixture memory with a live identity tag
    const readMEM = path.join(T, 'read-signal-mem');
    fs.mkdirSync(readMEM, { recursive: true });
    fs.writeFileSync(path.join(readMEM, 'lessons.md'),
      '## Index\n\n## Entries\n\n' +
      '**2026-01-01 — test read tag** [test:read-identity-tag]\n' +
      'Class: [[class:read-test-class]]\n' +
      'body text.\n');
    fs.writeFileSync(path.join(readMEM, 'decisions.md'), '## Index\n\n## Entries\n');
    fs.writeFileSync(path.join(readMEM, 'standinginstructions.md'), '## Index\n\n## Entries\n');
    fs.writeFileSync(path.join(readMEM, 'classes.md'), '## Index\n\n## Entries\n');

    const p = freshRoot('read-signal');
    const readEnv = { PMM_MEM_DIR: readMEM, PMM_RECALL_ROOT: p.root, PMM_IMPRESSION_HOME: p.root };

    // Test pmm-search.sh with matching identity tag (lowercase query)
    const jRead = JSON.stringify({
      session_id: 'test:read-s1', tool_use_id: 'toolu_selftest_read-tu1',
      cwd: NOREPO_DIR,
      tool_input: { command: 'bash ~/.claude/memory/_local-config/pmm-search.sh TEST:READ-IDENTITY-TAG' }
    });
    const rRead = runHook(jRead, readEnv);
    report('read signal: pmm-search.sh with live tag: zero-output', rRead.out === 0 && rRead.err === 0 && rRead.rc === 0, JSON.stringify(rRead));
    let readRows = ledgerRows(p.root);
    const readEventRows = byKind(readRows, 'read');
    report('read signal: exactly 1 read row written', readEventRows.length === 1, JSON.stringify(readEventRows));
    if (readEventRows.length === 1) {
      const readCols = readEventRows[0].split('\t');
      const trigIdx = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('trigger_or_gate_id');
      const classIdx = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('class_tag');
      const provIdx = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('run_provenance');
      const gateInstIdx = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('event_id');
      report('read signal: trigger_or_gate_id = matched tag (lowercase)', readCols[trigIdx] === 'test:read-identity-tag', JSON.stringify(readCols));
      report('read signal: class_tag set from entry', readCols[classIdx] === 'class:read-test-class', JSON.stringify(readCols));
      report('read signal: run_provenance = read:pmm-search', readCols[provIdx] === 'read:pmm-search', JSON.stringify(readCols));
    }

    // Test pmm-search.sh with non-matching query (should NOT write read row)
    const p2 = freshRoot('read-signal-2');
    const jNoMatch = JSON.stringify({
      session_id: 'test:read-s2', tool_use_id: 'toolu_selftest_read-tu2',
      cwd: NOREPO_DIR,
      tool_input: { command: 'bash ~/.claude/memory/_local-config/pmm-search.sh some-random-non-identity-query' }
    });
    runHook(jNoMatch, Object.assign({}, readEnv, { PMM_RECALL_ROOT: p2.root, PMM_IMPRESSION_HOME: p2.root }));
    const rowsNoMatch = ledgerRows(p2.root);
    const readRowsNoMatch = byKind(rowsNoMatch, 'read');
    report('read signal: non-identity query: zero read rows written', readRowsNoMatch.length === 0, JSON.stringify(readRowsNoMatch));
    report('read signal: non-identity query: still has observed row', byKind(rowsNoMatch, 'observed').length === 1, JSON.stringify(byKind(rowsNoMatch, 'observed')));

    // L-7 fix (2026-09-24, audit `guards/audits/OPUS-2026-09-24-c05-batch-review.md` §2): only
    // bash/sh/node running the script AS ITS OPERAND counts as a read signal -- `cat` (or any other
    // non-bash/sh/node exe) merely NAMING the script as an argument, e.g. to display it, must NOT be
    // misdetected as actually running it.
    const p3 = freshRoot('read-signal-cat');
    const jCat = JSON.stringify({
      session_id: 'test:read-s3', tool_use_id: 'toolu_selftest_read-tu3',
      cwd: NOREPO_DIR,
      tool_input: { command: 'cat ~/.claude/memory/_local-config/pmm-search.sh TEST:READ-IDENTITY-TAG' }
    });
    runHook(jCat, Object.assign({}, readEnv, { PMM_RECALL_ROOT: p3.root, PMM_IMPRESSION_HOME: p3.root }));
    const rowsCat = ledgerRows(p3.root);
    const readRowsCat = byKind(rowsCat, 'read');
    report('read signal (L-7): cat naming pmm-search.sh with a live tag does NOT count as read', readRowsCat.length === 0, JSON.stringify(readRowsCat));
    report('read signal (L-7): cat case still has its one observed row', byKind(rowsCat, 'observed').length === 1, JSON.stringify(byKind(rowsCat, 'observed')));

    // L-8 fix (2026-09-24, same audit): the read-signal corpus parse is now cached to disk under
    // PMM_RECALL_ROOT, keyed by the corpus files' own mtime+size (measured off-line against the real
    // 682-entry corpus: ~21ms/parse before this fix vs ~1.1ms median/~1.8ms max on a cache hit --
    // timing is reported, not gated here, same convention item 21's latency check already uses).
    // This self-test covers CORRECTNESS: a cache file appears with the right content, a repeat call
    // against an unchanged corpus still classifies correctly, and a CHANGED corpus is picked up (the
    // cache must never serve stale data).
    const p4 = freshRoot('read-signal-cache');
    const jFirst = JSON.stringify({
      session_id: 'test:read-cache-s1', tool_use_id: 'toolu_selftest_readcache-tu1',
      cwd: NOREPO_DIR,
      tool_input: { command: 'bash ~/.claude/memory/_local-config/pmm-search.sh TEST:READ-IDENTITY-TAG' }
    });
    runHook(jFirst, Object.assign({}, readEnv, { PMM_RECALL_ROOT: p4.root, PMM_IMPRESSION_HOME: p4.root }));
    let cacheFiles = [];
    try { cacheFiles = fs.readdirSync(p4.root).filter((f) => f.indexOf('read-signal-cache') !== -1); } catch (e) { /* directory not created yet is itself a finding below */ }
    report('read signal cache (L-8): a cache file is created after the first matching call', cacheFiles.length === 1, JSON.stringify(cacheFiles));
    let cacheContent = '';
    if (cacheFiles.length) { try { cacheContent = fs.readFileSync(path.join(p4.root, cacheFiles[0]), 'utf8'); } catch (e) { /* checked below */ } }
    report('read signal cache (L-8): cache content includes the live tag', cacheContent.indexOf('test:read-identity-tag') !== -1, cacheContent.slice(0, 200));

    // second call, SAME corpus (mtime unchanged) -- a different tool_use_id so it lands its own row;
    // must still classify correctly, proving a cache-hit read returns the same answer as a cold parse.
    const jSecond = JSON.stringify({
      session_id: 'test:read-cache-s1', tool_use_id: 'toolu_selftest_readcache-tu2',
      cwd: NOREPO_DIR,
      tool_input: { command: 'bash ~/.claude/memory/_local-config/pmm-search.sh TEST:READ-IDENTITY-TAG' }
    });
    runHook(jSecond, Object.assign({}, readEnv, { PMM_RECALL_ROOT: p4.root, PMM_IMPRESSION_HOME: p4.root }));
    const readRowsAfterSecond = byKind(ledgerRows(p4.root), 'read');
    report('read signal cache (L-8): repeat call against an unchanged corpus (cache hit) still detects the live tag', readRowsAfterSecond.length === 2, JSON.stringify(readRowsAfterSecond));

    // third call: corpus CHANGES (old tag removed, new tag added) between calls -- the cache must
    // invalidate, not keep answering with the stale tag set.
    fs.writeFileSync(path.join(readMEM, 'lessons.md'),
      '## Index\n\n## Entries\n\n' +
      '**2026-01-03 — replacement read tag** [test:read-identity-tag-v2]\n' +
      'Class: [[class:read-test-class]]\n' +
      'body text.\n');
    const jThirdOld = JSON.stringify({
      session_id: 'test:read-cache-s1', tool_use_id: 'toolu_selftest_readcache-tu3',
      cwd: NOREPO_DIR,
      tool_input: { command: 'bash ~/.claude/memory/_local-config/pmm-search.sh TEST:READ-IDENTITY-TAG' }
    });
    runHook(jThirdOld, Object.assign({}, readEnv, { PMM_RECALL_ROOT: p4.root, PMM_IMPRESSION_HOME: p4.root }));
    const jThirdNew = JSON.stringify({
      session_id: 'test:read-cache-s1', tool_use_id: 'toolu_selftest_readcache-tu4',
      cwd: NOREPO_DIR,
      tool_input: { command: 'bash ~/.claude/memory/_local-config/pmm-search.sh TEST:READ-IDENTITY-TAG-V2' }
    });
    runHook(jThirdNew, Object.assign({}, readEnv, { PMM_RECALL_ROOT: p4.root, PMM_IMPRESSION_HOME: p4.root }));
    const readTagsFinal = byKind(ledgerRows(p4.root), 'read').map((r) => r.split('\t')[require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('trigger_or_gate_id')]);
    report('read signal cache (L-8): corpus change invalidates the cache -- old (removed) tag no longer detected',
      readTagsFinal.filter((t) => t === 'test:read-identity-tag').length === 2 /* only the two calls BEFORE the corpus changed */, JSON.stringify(readTagsFinal));
    report('read signal cache (L-8): corpus change invalidates the cache -- new tag IS detected',
      readTagsFinal.indexOf('test:read-identity-tag-v2') !== -1, JSON.stringify(readTagsFinal));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: true structural misses (zero rows) vs observed-but-no-match (exactly 1 observed row)');
  console.log('==================================================');
  {
    const p = freshRoot('c');
    const noTrig = { PMM_MEM_DIR: EMPTY_MEM, PMM_RECALL_ROOT: p.root };
    const r = runHook(JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu1', cwd: NOREPO_DIR, tool_input: { command: 'footool x' } }), noTrig);
    report('empty trigger corpus: zero-output', r.out === 0 && r.err === 0 && r.rc === 0, JSON.stringify(r));
    const rows = ledgerRows(p.root);
    report('empty trigger corpus: exactly 1 observed row (not a true miss)', rows.length === 1 && rows[0].split('\t')[KIND_IDX] === 'observed', JSON.stringify(rows));
  }
  {
    const p = freshRoot('d');
    const r = runHook('{not json', p.env);
    report('malformed JSON: zero-output', r.out === 0 && r.err === 0 && r.rc === 0, JSON.stringify(r));
    report('malformed JSON: still a TRUE miss, nothing written at all', ledgerRows(p.root).length === 0, JSON.stringify(ledgerRows(p.root)));
  }
  {
    const p = freshRoot('e');
    const r = runHook('', p.env);
    report('empty stdin: zero-output', r.out === 0 && r.err === 0 && r.rc === 0, JSON.stringify(r));
    report('empty stdin: still a TRUE miss, nothing written at all', ledgerRows(p.root).length === 0, JSON.stringify(ledgerRows(p.root)));
  }
  {
    const p = freshRoot('f');
    const r = runHook(JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu1', cwd: NOREPO_DIR, tool_input: { command: '(footool x; echo y)' } }), p.env);
    report('unsupported-structure command (subshell) containing the trigger exe: still zero-output', r.out === 0 && r.err === 0 && r.rc === 0, JSON.stringify(r));
    const rows = ledgerRows(p.root);
    report('unsupported-structure command: exactly 1 observed row, zero eligible (HIGH-6)', rows.length === 1 && rows[0].split('\t')[KIND_IDX] === 'observed', JSON.stringify(rows));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: id_missing / sanitization / write-failures');
  console.log('==================================================');
  {
    const p = freshRoot('g');
    const r = runHook(JSON.stringify({ cwd: NOREPO_DIR, tool_input: { command: 'footool x' } }), p.env); // no session_id/tool_use_id at all
    report('missing session_id+tool_use_id: zero-output', r.out === 0 && r.err === 0 && r.rc === 0, JSON.stringify(r));
    const rows = ledgerRows(p.root);
    const idMissingIdx = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('id_missing');
    report('missing session_id+tool_use_id: 2 rows written (observed + eligible), both id_missing=1, impression_id/event_id empty, no "-" sentinel anywhere',
      rows.length === 2 && rows.every((r2) => { const c = r2.split('\t'); return c[idMissingIdx] === '1' && c[IMP_IDX] === '' && c[EVT_IDX] === ''; }) && rows.every((r2) => r2.indexOf('\t-\t') === -1),
      JSON.stringify(rows));
  }
  {
    const p = freshRoot('h');
    const r = runHook(JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu\twith\ttabs', cwd: NOREPO_DIR, tool_input: { command: 'footool x' } }), p.env);
    const rows = ledgerRows(p.root);
    const matchRow = byKind(rows, 'eligible')[0];
    const cols = matchRow.split('\t');
    const sanitizedIdx = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('sanitized');
    const tuIdx = require('./pmm-recall-ledger.cjs').COLUMNS.indexOf('tool_use_id');
    report('tool_use_id with embedded tabs: sanitized in place, sanitized column=1, row has exactly 21 columns',
      r.out === 0 && cols[tuIdx] === 'toolu_selftest_tu_with_tabs' && cols[sanitizedIdx] === '1' && cols.length === 21, JSON.stringify(rows));
  }
  {
    const p = freshRoot('i');
    const okDir = path.join(T, 'ok-dir-' + Date.now());
    fs.mkdirSync(okDir, { recursive: true });
    const hostFile = path.join(okDir, 'events-v3-' + os.hostname() + '.tsv');
    fs.mkdirSync(hostFile);
    const env = Object.assign({}, p.env, { PMM_RECALL_ROOT: okDir, PMM_IMPRESSION_HOME: okDir });
    const r = runHook(JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu1', cwd: NOREPO_DIR, tool_input: { command: 'footool x' } }), env);
    report('ledger path occupied by a directory (EISDIR): still zero-output (fail-open on write)', r.out === 0 && r.err === 0 && r.rc === 0, JSON.stringify(r));
    const failPath = path.join(okDir, 'write-failures.count');
    let failed = false;
    try { failed = fs.statSync(failPath).size > 0; } catch (e) { failed = false; }
    report('ledger path occupied by a directory: write-failures.count grew (silent data loss is now visible)', failed, failed ? 'size>0' : 'missing/empty');
  }

  console.log();
  console.log('==================================================');
  console.log('End-to-end zero-output lock: the ACTUAL settings.json-wired command string');
  console.log('==================================================');
  const WIRED_CMD = 'bash "' + path.join(G, 'pmm-bash-impression.sh').replace(/\\/g, '/') + '" || { echo "pmm-bash-impression 自身故障 — 报告闸 fail-open 放行" >&2; exit 0; }';
  // NOTE: REAL_TREE_HOME here, not REAL_HOME_FOR_SELFTEST -- settings.json is a git-tracked file at a
  // FIXED on-disk location (derived from __dirname), never wherever HOME/USERPROFILE happen to be
  // redirected to for THIS self-test run (measured: using resolveHome() here broke the wiring check
  // under a redirected-HOME-only run, 59/60 -- the same class of bug this file's other fixtures fix).
  const SETTINGS_JSON = process.env.CLAUDE_SETTINGS_JSON_OVERRIDE || path.join(REAL_TREE_HOME, '.claude', 'settings.json');

  // spec 22 (K23): the per-case before/after check used to be a bespoke sha256 snapshot of settings.json
  // + 4 memory files + .trigger-seen-* only (audit-flagged gap: no ledger/queue/quarantine/trigger-log
  // coverage) -- replaced by the shared iso.footprint primitives (the full spec-pinned watch set), one
  // begin()/end() pair per case so a leaking case is still individually pinpointed.
  //
  // 2026-09-17 falsify-caught bug (same class as runHook() above / bash-pipe-exitcode-watch.cjs's
  // runWired()): execFileSync() hardcoded `err = Buffer.alloc(0)` on the success path, so this function's
  // own stderr-empty check at line ~632 could never go red on a real leak. spawnSync() replaces it.
  function e2eCase(name, jsonStdin, envExtra) {
    const isoRoot = path.join(T, 'e2e-root-' + Math.random().toString(36).slice(2));
    // REAL_TREE_HOME (not an isolated temp root): this case deliberately reads the REAL settings.json
    // and REAL memory corpus to prove the actual wiring works, same "read-only real corpus" allowance
    // isoEnv()'s own header documents for PMM_MEM_DIR -- writes still land only under isoRoot.
    const env = iso.isoEnv(REAL_TREE_HOME, Object.assign({ PMM_RECALL_ROOT: isoRoot, PMM_IMPRESSION_HOME: REAL_TREE_HOME }, envExtra || {}));
    const caseSnap = iso.footprint.begin();
    const t0 = Date.now();
    const spawned = spawnSync('bash', ['-c', WIRED_CMD], { input: jsonStdin, env, timeout: 5000 });
    const out = spawned.stdout || Buffer.alloc(0);
    const err = spawned.stderr || Buffer.alloc(0);
    const rc = (spawned.status === null || spawned.status === undefined) ? -1 : spawned.status;
    const elapsed = Date.now() - t0;
    const fp = iso.footprint.end(caseSnap, iso.markersFromSource(__filename, nonce, path.basename(T)));
    const ok = rc === 0 && Buffer.from(out).length === 0 && Buffer.from(err).length === 0 && !fp.red && elapsed <= 5000;
    report('e2e shadow lock: ' + name, ok,
      'rc=' + rc + ' stdout_bytes=' + Buffer.from(out).length + ' stderr_bytes=' + Buffer.from(err).length + ' elapsed_ms=' + elapsed + ' footprint=' + fp.line);
  }

  e2eCase('normal hit-shaped input (PMM_MEM_DIR unset -> uses real corpus, harmless whether it matches or not)', JSON.stringify({ session_id: 'test:e2e1', tool_use_id: 'toolu_selftest_e2e1-tu', cwd: REAL_TREE_HOME, tool_input: { command: 'tail -1 /dev/null' } }));
  e2eCase('malformed JSON on stdin', '{not json');
  e2eCase('empty stdin', '');
  {
    const notADir2 = path.join(T, 'e2e-not-a-dir-' + Date.now());
    fs.writeFileSync(notADir2, 'x');
    e2eCase('unwritable ledger path (PMM_RECALL_ROOT is a file, not a dir)', JSON.stringify({ session_id: 'test:e2e4', tool_use_id: 'toolu_selftest_e2e4-tu', cwd: REAL_TREE_HOME, tool_input: { command: 'tail -1 /dev/null' } }), { PMM_RECALL_ROOT: notADir2 });
  }
  e2eCase('unsupported-structure command', JSON.stringify({ session_id: 'test:e2e5', tool_use_id: 'toolu_selftest_e2e5-tu', cwd: REAL_TREE_HOME, tool_input: { command: '(tail -1 x; echo y)' } }));

  console.log();
  console.log('==================================================');
  console.log('MEDIUM-3 (fab blind attack, contract v2.16 G05): all four wired launches, PATH with no node -> zero bytes rc 0');
  console.log('==================================================');
  {
    // The four settings.json launches this session wires (PreToolUse Bash matcher has two commands;
    // PostToolUse and PostToolUseFailure each wire bash-pipe-exitcode-watch.sh once). Three of the four
    // share one .sh file (only hook_event_name differs in the JSON payload); tested as four distinct
    // launches anyway since that is what settings.json actually registers and what MEDIUM-3 is about --
    // every wired command string, not just the two .sh files.
    const GATE_SH = path.join(G, 'bash-pipe-exitcode-watch.sh').replace(/\\/g, '/');
    const GATE_WIRED = 'bash "' + GATE_SH + '" || { echo "bash-pipe-exitcode-watch 自身故障 — 报告闸 fail-open 放行" >&2; exit 0; }';
    // Strip ONLY the node.exe directory from the CURRENT PATH (never replace PATH wholesale with a
    // POSIX-only value like '/usr/bin:/bin' -- on this host that also makes `bash` itself unresolvable by
    // the OUTER execFileSync('bash', ...) call, a spawn ENOENT unrelated to what this test is checking;
    // the same host-dependent trap the acceptance runner's own Z06 case hits).
    const rawPath = process.env.PATH || process.env.Path || '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const filteredPath = rawPath.split(/[;:]/).filter((p) => !/nodejs/i.test(p)).join(sep);
    const noNodeEnv = { PATH: filteredPath, PMM_RECALL_ROOT: path.join(T, 'no-node-root') };
    delete noNodeEnv.Path;
    function noNodeLaunch(name, wiredCmd, hookEventName) {
      const hook = JSON.stringify({ hook_event_name: hookEventName, session_id: 'test:nn', agent_id: 'nn', tool_use_id: 'toolu_selftest_nn-tu', cwd: T, tool_input: { command: 'echo hi' } });
      // spawnSync, not execFileSync: execFileSync only exposes stdout/stderr via the thrown Error's
      // properties on a NON-ZERO exit -- on a SUCCESSFUL (rc 0) run its stderr is silently inherited to
      // THIS process's own stderr instead of being returned at all, which would have made a wrapper whose
      // outer `|| { echo ...>&2; exit 0; }` fallback fires (rc forced to 0, but stderr non-empty) look
      // like a false pass. Caught empirically while building this exact assertion: the reverse-proof run
      // (guard removed) still reported 0 stderr bytes under execFileSync even though the child plainly
      // wrote to stderr, confirmed by redirecting the WHOLE self-test's own stderr and finding the leaked
      // text there instead.
      const r = spawnSync('bash', ['-c', wiredCmd], { input: hook, env: iso.isoEnv(T, noNodeEnv), timeout: 5000 });
      const outLen = Buffer.from(r.stdout || Buffer.alloc(0)).length;
      const errLen = Buffer.from(r.stderr || Buffer.alloc(0)).length;
      const rc = r.status === null || r.status === undefined ? -1 : r.status;
      report('MEDIUM-3: ' + name + ' with no node on PATH -> zero stdout/stderr, rc 0', outLen === 0 && errLen === 0 && rc === 0,
        'stdout_bytes=' + outLen + ' stderr_bytes=' + errLen + ' rc=' + rc);
    }
    noNodeLaunch('Pre gate (bash-pipe-exitcode-watch.sh, PreToolUse)', GATE_WIRED, 'PreToolUse');
    noNodeLaunch('Pre M0 (pmm-bash-impression.sh, PreToolUse)', WIRED_CMD, 'PreToolUse');
    noNodeLaunch('Post (bash-pipe-exitcode-watch.sh, PostToolUse)', GATE_WIRED, 'PostToolUse');
    noNodeLaunch('PostToolUseFailure (bash-pipe-exitcode-watch.sh, PostToolUseFailure)', GATE_WIRED, 'PostToolUseFailure');
  }

  console.log();
  console.log('==================================================');
  console.log('Wiring check (informational before settings.json is edited; must flip green after)');
  console.log('==================================================');
  {
    let wired = false;
    try {
      const d = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'));
      const arr = (d.hooks && Array.isArray(d.hooks.PreToolUse)) ? d.hooks.PreToolUse : [];
      for (const entry of arr) {
        if (!entry || String(entry.matcher || '').split('|').indexOf('Bash') === -1 || !Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          if (h && typeof h.command === 'string' && /pmm-bash-impression\.sh/.test(h.command)) wired = true;
        }
      }
    } catch (e) { wired = false; }
    report('wiring: settings.json PreToolUse matcher=Bash -> pmm-bash-impression.sh', wired, wired ? '' : 'not wired yet');
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: two hooks share the SAME ledger file/header (delivery ② "两钩子共写自测")');
  console.log('==================================================');
  {
    const sharedRoot = path.join(T, 'shared-root');
    const env = { PMM_MEM_DIR: MEM, PMM_RECALL_ROOT: sharedRoot, PMM_IMPRESSION_HOME: sharedRoot };
    runHook(JSON.stringify({ session_id: 'test:s1', tool_use_id: 'toolu_selftest_tu1', cwd: NOREPO_DIR, tool_input: { command: 'footool a' } }), env);
    require('./pmm-recall-ledger.cjs').writeEvent({
      tool_use_id: 'toolu_selftest_gate-tu', impression_id: 'gateimp', event_id: 'gateevt', event_kind: 'would-warn',
      gate: 'A', confidence: 'recurrence', parser_version: '1.2', mode: 'shadow',
    }, { root: sharedRoot });
    const text = fs.readFileSync(path.join(sharedRoot, 'events-v3-' + os.hostname() + '.tsv'), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const headerLines = lines.filter((l) => l === require('./pmm-recall-ledger.cjs').COLUMNS.join('\t'));
    report('M0 hook + shared-module direct write land in the SAME file with a SINGLE header line', lines.length === 4 && headerLines.length === 1, JSON.stringify(lines));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: 补遗三第 33 条 -- Bash write to specs/memory path routes through the SAME recall');
  console.log('push entry point pmm-trigger-recall.cjs uses for Edit/Write (subprocess reuse, via=bash-write)');
  console.log('==================================================');
  {
    // Fully self-consistent isolated env, built directly with iso.isoEnv (bypassing runHook/freshRoot's
    // own base-selection convention, which would otherwise diverge HOME from PMM_RECALL_ROOT here) --
    // HOME=USERPROFILE=PMM_HOME=bwT, matching the `cwd` this event carries, so the pmm-trigger-recall.cjs
    // subprocess resolves repo='home' the same way it would for a real Edit/Write on this machine.
    const bwT = path.join(T, 'item33-bashwrite');
    fs.mkdirSync(bwT, { recursive: true });
    const bwMEM = path.join(bwT, 'mem');
    fs.mkdirSync(bwMEM, { recursive: true });
    fs.writeFileSync(path.join(bwMEM, 'lessons.md'),
      '## Index\n\n## Entries\n\n' +
      '**2026-01-05 — spec 补遗需先查开源** [process:copy-open-source-before-building-infra]\n' +
      '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/specs/* -->\n' +
      'Class: [[class:test-class]]\n' +
      'body text.\n');
    fs.writeFileSync(path.join(bwMEM, 'decisions.md'), '## Index\n\n## Entries\n');
    fs.writeFileSync(path.join(bwMEM, 'standinginstructions.md'), '## Index\n\n## Entries\n');
    fs.writeFileSync(path.join(bwMEM, 'classes.md'), '## Index\n\n## Entries\n');

    // 例 1: node 脚本(-e 内联)写 spec -> 推送 [process:copy-open-source-before-building-infra]
    const bwRoot = path.join(bwT, 'root-write');
    const envWrite = iso.isoEnv(bwT, {
      PMM_MEM_DIR: bwMEM, PMM_RECALL_ROOT: bwRoot, PMM_IMPRESSION_HOME: bwT,
      PMM_TRIGGER_MEM: bwMEM, PMM_TRIGGER_STATE: path.join(bwT, '.claude'),
    });
    const nodeWriteCmd = "node -e \"require('fs').writeFileSync('.claude/guards/specs/FOO.md', 'x')\"";
    const jWrite = JSON.stringify({
      session_id: 'test:bw-s1', tool_use_id: 'toolu_selftest_bw-tu1', cwd: bwT,
      tool_input: { command: nodeWriteCmd },
    });
    const rw = spawnSync(process.execPath, [path.join(G, 'pmm-bash-impression.cjs')], { input: jWrite, env: envWrite, timeout: 5000 });
    const rwOut = (rw.stdout || Buffer.alloc(0)).toString('utf8');
    const rwErrLen = Buffer.from(rw.stderr || Buffer.alloc(0)).length;
    const rwRc = (rw.status === null || rw.status === undefined) ? -1 : rw.status;
    report('item33 red->green (red half, pre-fix behavior documented): node -e writeFileSync(specs path) runs clean (rc=0, stderr empty)',
      rwRc === 0 && rwErrLen === 0, 'rc=' + rwRc + ' errLen=' + rwErrLen);
    report('item33 (green): node -e writeFileSync(specs path) -> stdout carries the pushed recall tag',
      rwOut.indexOf('copy-open-source-before-building-infra') !== -1, rwOut.slice(0, 300));
    let bwRows = [];
    try { bwRows = fs.readFileSync(path.join(bwRoot, 'events-v3-' + os.hostname() + '.tsv'), 'utf8').split('\n').filter(Boolean).slice(1); } catch (e) { bwRows = []; }
    const bwWriteRows = byKind(bwRows, 'bash-write');
    report('item33 (green): ledger has >=1 bash-write row, run_provenance contains via=bash-write',
      bwWriteRows.length >= 1 && bwWriteRows.every((r2) => r2.split('\t')[RUNPROV_IDX].indexOf('via=bash-write') !== -1),
      JSON.stringify(bwWriteRows));

    // 例 2: 普通 Bash(无写入目标) -> 不推(既有 pure-observer 零输出不变量不受影响)
    const bwRoot2 = path.join(bwT, 'root-plain');
    const envPlain = iso.isoEnv(bwT, {
      PMM_MEM_DIR: bwMEM, PMM_RECALL_ROOT: bwRoot2, PMM_IMPRESSION_HOME: bwT,
      PMM_TRIGGER_MEM: bwMEM, PMM_TRIGGER_STATE: path.join(bwT, '.claude'),
    });
    const jPlain = JSON.stringify({
      session_id: 'test:bw-s2', tool_use_id: 'toolu_selftest_bw-tu2', cwd: bwT,
      tool_input: { command: 'ls -la' },
    });
    const rp = spawnSync(process.execPath, [path.join(G, 'pmm-bash-impression.cjs')], { input: jPlain, env: envPlain, timeout: 5000 });
    const rpOutLen = Buffer.from(rp.stdout || Buffer.alloc(0)).length;
    const rpErrLen = Buffer.from(rp.stderr || Buffer.alloc(0)).length;
    const rpRc = (rp.status === null || rp.status === undefined) ? -1 : rp.status;
    report('item33: plain Bash command (ls -la, no write target) -> zero-output, unchanged pure-observer invariant',
      rpOutLen === 0 && rpErrLen === 0 && rpRc === 0, 'rc=' + rpRc + ' out=' + rpOutLen + ' err=' + rpErrLen);
    let plainRows = [];
    try { plainRows = fs.readFileSync(path.join(bwRoot2, 'events-v3-' + os.hostname() + '.tsv'), 'utf8').split('\n').filter(Boolean).slice(1); } catch (e) { plainRows = []; }
    report('item33: plain Bash command -> no bash-write row written', byKind(plainRows, 'bash-write').length === 0, JSON.stringify(plainRows));

    // 单元测试:纯函数层面的判据(不需要子进程)
    report('item33 unit: isSpecOrMemMdPath matches guards/specs and memory/*.md, rejects unrelated paths', (() => {
      return isSpecOrMemMdPath('C:/Users/x/.claude/guards/specs/FOO.md') === true &&
        isSpecOrMemMdPath('C:/Users/x/.claude/memory/lessons.md') === true &&
        isSpecOrMemMdPath('C:/Users/x/.claude/memory/lessons.txt') === false &&
        isSpecOrMemMdPath('C:/Users/x/.claude/guards/pmm-core.cjs') === false;
    })());
    report('item33 unit: detectWriteTargets finds redirect/tee/cp/mv/node-eval targets', (() => {
      const s1 = parseCommand('echo x > .claude/guards/specs/A.md').segments[0];
      const s2 = parseCommand('echo x | tee .claude/memory/lessons.md').segments[1];
      const s3 = parseCommand('cp a.md .claude/guards/specs/B.md').segments[0];
      const s4 = parseCommand('mv a.md .claude/memory/decisions.md').segments[0];
      const s5 = parseCommand("node -e \"writeFileSync('.claude/memory/lessons.md', x)\"").segments[0];
      return detectWriteTargets(s1).indexOf('.claude/guards/specs/A.md') !== -1 &&
        detectWriteTargets(s2).indexOf('.claude/memory/lessons.md') !== -1 &&
        detectWriteTargets(s3).indexOf('.claude/guards/specs/B.md') !== -1 &&
        detectWriteTargets(s4).indexOf('.claude/memory/decisions.md') !== -1 &&
        detectWriteTargets(s5).indexOf('.claude/memory/lessons.md') !== -1;
    })());
    report('item33 unit: a plain command with no matching form yields zero targets', (() => {
      const s = parseCommand('ls -la').segments[0];
      return collectBashWriteTargets({ segments: [s] }, 'C:/Users/x').length === 0;
    })());
  }

  const markers = iso.markersFromSource(__filename, nonce, path.basename(T));
  const fp = iso.footprint.end(fpSnap, markers);
  report('footprint: zero attributable change on the real root', !fp.red, fp.line);
  console.log(fp.line);

  console.log();
  console.log('==================================================');
  console.log('Summary: ' + PASS + ' passed, ' + FAIL + ' failed');
  console.log('==================================================');
  process.exit(FAIL > 0 ? 1 : 0);
}
// SELFTEST-END
