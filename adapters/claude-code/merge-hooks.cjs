#!/usr/bin/env node
// AxMem Claude Code adapter — idempotent hook wiring. (P1, 2026-09-13;
// dedup fixed + trigger-recall wired in P1 2.4, 2026-09-17)
// Merges AxMem's hook entries into ~/.claude/settings.json WITHOUT touching
// anything else: existing hooks keep their order; ours are appended only
// when no entry with the exact SAME {event, matcher, command} identity
// already exists in that event/matcher group (P1 2.4 — replaces the old
// "any command containing the substring axmem" heuristic, which both
// (a) false-positived on a third-party command that merely mentions
// "axmem" in passing, silently skipping our real entry, and (b) never
// caught a stale duplicate since a NEW distinct axmem command would also
// match the substring and get skipped). A timestamped backup of
// settings.json is written before any real write.
// Usage: node merge-hooks.cjs [--dry-run] [--settings <path>]
'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('../../lib/prelude.cjs');
const { writeFileAtomicSync } = require('../../lib/atomic-write.cjs');

const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');

function buildWant(root) {
  const GATE = `bash "${root}/core/write-gate.sh" --block`;
  const TRIGGER = `bash "${root}/core/trigger-recall.sh"`;
  const RCPT = `bash "${root}/core/receipt.sh"`;
  return [
    { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', command: GATE },
    // P1 2.4: trigger-recall was speced (WANT) but never actually wired —
    // gate ran on every governed write, but moment-triggered recall never
    // fired through the CC adapter until this entry existed.
    { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', command: TRIGGER },
    { event: 'PostToolUse', matcher: 'AskUserQuestion', command: `${RCPT} from-hook || exit 0` },
    { event: 'Stop', matcher: null, command: `${RCPT} stop-check` },
    { event: 'SessionStart', matcher: null, command: `${RCPT} session-lamp` },
  ];
}

function normalizeCommand(cmd) {
  return typeof cmd === 'string' ? cmd.trim() : '';
}

function findGroup(groups, matcher) {
  return groups.find((g) => (matcher ? g.matcher === matcher : !g.matcher));
}

// Counts how many hook entries in `settings` exactly match `identity`
// {event, matcher, normalized_command}. Order-independent by construction
// (uses .find()/.filter() over parsed objects, never a raw-text compare —
// a JSON file with reordered keys or a reordered hooks array is identical
// input as far as this function is concerned).
function countIdentityMatches(settings, identity) {
  const groups = (settings.hooks && settings.hooks[identity.event]) || [];
  let count = 0;
  for (const g of groups) {
    const matcherOk = identity.matcher ? g.matcher === identity.matcher : !g.matcher;
    if (!matcherOk || !Array.isArray(g.hooks)) continue;
    count += g.hooks.filter((h) => h && h.type === 'command' && normalizeCommand(h.command) === normalizeCommand(identity.normalized_command)).length;
  }
  return count;
}

// Applies WANT to a parsed settings object IN PLACE. Returns
// { added: [{event, matcher, normalized_command}], addedCount }.
function applyWant(settings, want) {
  settings.hooks = settings.hooks || {};
  const added = [];
  for (const w of want) {
    const groups = (settings.hooks[w.event] = settings.hooks[w.event] || []);
    let group = findGroup(groups, w.matcher);
    if (!group) {
      group = w.matcher ? { matcher: w.matcher, hooks: [] } : { hooks: [] };
      groups.push(group);
    }
    group.hooks = group.hooks || [];
    const exists = group.hooks.some((h) => h && h.type === 'command' && normalizeCommand(h.command) === normalizeCommand(w.command));
    if (exists) continue;
    group.hooks.push({ type: 'command', command: w.command });
    added.push({ event: w.event, matcher: w.matcher, normalized_command: w.command });
  }
  return { added, addedCount: added.length };
}

// Verifies the CURRENT on-disk settings against WANT, per entry, for
// doctor. Returns [{event, matcher, normalized_command, matches, ok}].
// `root` is accepted only for tests that want a synthetic WANT list; real
// callers (bin/axmem's doctor) should omit it so this always compares
// against the SAME slash-normalized ROOT constant `main()` used to build
// the commands it actually wrote — a caller-supplied root string in any
// OTHER representation (e.g. a POSIX /c/... path vs this file's own
// backslash-stripped C:/... form) would silently never match, even though
// both name the identical directory on disk.
function verifyWiring(settingsPath, root) {
  const want = buildWant(root || ROOT);
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return want.map((w) => ({ event: w.event, matcher: w.matcher, normalized_command: w.command, matches: 0, ok: false }));
  }
  return want.map((w) => {
    const matches = countIdentityMatches(settings, { event: w.event, matcher: w.matcher, normalized_command: w.command });
    return { event: w.event, matcher: w.matcher, normalized_command: w.command, matches, ok: matches === 1 };
  });
}

function recordLifecycleTargets(settingsPath, origRaw, newRaw, addedTargets) {
  try {
    const lm = require('../../lifecycle/install-manifest.cjs');
    const stateDir = process.env.AXMEM_STATE_DIR || ctx.STATE_DIR;
    const preSha = lm.sha256Text(origRaw);
    const postSha = lm.sha256Text(newRaw);
    for (const t of addedTargets) {
      lm.recordTarget(stateDir, 'claude_code', {
        path: path.resolve(settingsPath),
        kind: 'json-hook',
        identity: t,
        expected_count: 1,
        pre_sha256: preSha,
        post_sha256: postSha,
      });
    }
  } catch (e) {
    console.error(`claude-code adapter: warning — could not record lifecycle manifest entry: ${e.message}`);
  }
}

function main(argv) {
  const dry = argv.includes('--dry-run');
  const si = argv.indexOf('--settings');
  const SETTINGS = si >= 0 ? argv[si + 1] : ctx.cfgGet('adapters.claude_code.settings_json', ctx.HOME_DIR + '/.claude/settings.json');

  let origRaw = '';
  let settings = {};
  try {
    origRaw = fs.readFileSync(SETTINGS, 'utf8');
    settings = JSON.parse(origRaw);
  } catch (e) {
    console.error(`cannot read/parse ${SETTINGS}: ${e.message}`);
    process.exit(1);
  }

  const { added, addedCount } = applyWant(settings, buildWant(ROOT));

  if (addedCount === 0) {
    console.log('claude-code adapter: already wired (nothing to do)');
    process.exit(0);
  }
  if (dry) {
    console.log(`claude-code adapter (dry-run): would add ${addedCount} hook(s) to ${SETTINGS}`);
    process.exit(0);
  }

  const backup = SETTINGS + '.axmem-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SETTINGS, backup);
  const newRaw = JSON.stringify(settings, null, 2) + '\n';
  // BORROW-MATRIX-2026-09-24-full.md group 6 "补": this used to be a plain
  // fs.writeFileSync(SETTINGS, newRaw) directly on the real settings.json —
  // a process crash or power loss between that call and its return leaves
  // settings.json truncated/corrupt on disk (every CC hook stops firing).
  // writeFileAtomicSync stages the new content in a sibling file, fsyncs
  // it, then renames it over SETTINGS — a reader/crash at any point before
  // the rename still sees the OLD complete file, never a half-written one.
  writeFileAtomicSync(SETTINGS, newRaw);
  JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); // choke early if we wrote garbage
  console.log(`claude-code adapter: added ${addedCount} hook(s); backup at ${backup}`);

  recordLifecycleTargets(SETTINGS, origRaw, newRaw, added);
}

if (require.main === module && !process.argv.includes('--self-test')) {
  main(process.argv.slice(2));
}

module.exports = { buildWant, applyWant, countIdentityMatches, verifyWiring, normalizeCommand };

// ---------------------------------------------------------------------------
// Self-test — the four fixtures spec §2.4 explicitly names, plus round-trip
// and dedup-count sanity.
// ---------------------------------------------------------------------------
function selfTest() {
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }
  const want = buildWant('/fake/root');

  // 1. "同 group 已有 gate、缺 trigger": applying WANT adds ONLY the missing
  //    trigger entry, leaves the existing gate entry untouched.
  {
    const settings = { hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: want[0].command }] }] } };
    const before = JSON.stringify(settings);
    const r = applyWant(settings, want);
    const group = settings.hooks.PostToolUse.find((g) => g.matcher === 'Edit|Write|MultiEdit');
    check(
      '1 same-group-has-gate-missing-trigger: adds only trigger, gate entry untouched',
      r.addedCount >= 1 &&
        group.hooks.some((h) => h.command === want[0].command) &&
        group.hooks.some((h) => h.command === want[1].command) &&
        group.hooks.filter((h) => h.command === want[0].command).length === 1
    );
  }

  // 2. "已有第三方含 axmem 字样的 command": a third-party command that merely
  //    MENTIONS "axmem" must NOT suppress our real entries.
  {
    const settings = { hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'echo "not really axmem, just mentions the word axmem in passing"' }] }] } };
    const r = applyWant(settings, want);
    const group = settings.hooks.PostToolUse.find((g) => g.matcher === 'Edit|Write|MultiEdit');
    check(
      '2 third-party command merely mentioning "axmem" does not block our real entries',
      r.added.some((a) => a.normalized_command === want[0].command) && r.added.some((a) => a.normalized_command === want[1].command) && group.hooks.some((h) => h.command === want[0].command) && group.hooks.some((h) => h.command === want[1].command)
    );
  }

  // 3. "两条完全相同条目": pre-existing EXACT duplicate of our own entry ->
  //    applyWant adds nothing more for it (no third copy), and doctor-style
  //    verification reports the anomaly (matches=2, not ok).
  {
    const settings = { hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: want[0].command }, { type: 'command', command: want[0].command }] }] } };
    const r = applyWant(settings, want);
    const dupCount = countIdentityMatches(settings, { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', normalized_command: want[0].command });
    check(
      '3 pre-existing exact duplicate: applyWant does not add a third copy; count reflects the anomaly',
      !r.added.some((a) => a.normalized_command === want[0].command) && dupCount === 2
    );
  }

  // 4. "JSON 重排语义相同": a settings object built with keys/array order
  //    different from what a fresh WANT-driven build would produce is still
  //    recognized as already-wired (order-independent by construction —
  //    this compares PARSED objects, never re-serializes to compare text).
  {
    const settings = {
      someOtherTopLevelKey: 'zzz', // present before "hooks" — key order differs from a typical build
      hooks: {
        SessionStart: [{ hooks: [{ command: want[4].command, type: 'command' }] }], // 'type' after 'command'
        PostToolUse: [
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: want[2].command }] },
          { hooks: [{ type: 'command', command: 'user-own-thing' }] }, // an unrelated no-matcher group present BEFORE ours
          { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: want[1].command }, { type: 'command', command: want[0].command }] }, // trigger listed before gate
        ],
        Stop: [{ hooks: [{ type: 'command', command: want[3].command }] }],
      },
    };
    const r = applyWant(settings, want);
    check('4 JSON reordered but semantically identical: recognized as already fully wired', r.addedCount === 0);
  }

  // 5. verifyWiring reports ok=true for exactly-once matches, ok=false otherwise
  {
    const os = require('os');
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-cc-verify-'));
    const settingsPath = path.join(T, 'settings.json');
    const settings = {};
    applyWant(settings, want);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const report = verifyWiring(settingsPath, '/fake/root');
    check('5 verifyWiring: every WANT entry reports ok after a fresh wire', report.every((r) => r.ok) && report.length === want.length);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 6. crash-mid-write (BORROW-MATRIX-2026-09-24-full.md group 6 "补"): a
  //    real main() run against a real settings.json that dies between the
  //    atomic staging write and the rename that would publish it must leave
  //    the on-disk settings.json byte-for-byte UNCHANGED — no half-written
  //    file. Simulated by monkey-patching fs.renameSync (the exact step
  //    writeFileAtomicSync uses to publish) to throw, standing in for the
  //    process being killed at that instant.
  {
    const os = require('os');
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-cc-crash-'));
    const settingsPath = path.join(T, 'settings.json');
    const oldContent = JSON.stringify({ hooks: {} }, null, 2) + '\n';
    fs.writeFileSync(settingsPath, oldContent);
    const origRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated crash: killed before rename could publish settings.json'); };
    let threw = false;
    try {
      main(['--settings', settingsPath]);
    } catch {
      threw = true;
    } finally {
      fs.renameSync = origRename;
    }
    const after = fs.readFileSync(settingsPath, 'utf8');
    const strayStaging = fs.readdirSync(T).filter((f) => f.includes('.axmem-staging-'));
    check('6 simulated crash before settings.json rename: original file byte-for-byte unchanged (never half-written), no stray staging file left behind',
      threw && after === oldContent && strayStaging.length === 0);
    fs.rmSync(T, { recursive: true, force: true });
  }

  console.log(results.join('\n'));
  console.log(`claude-code merge-hooks self-test ${ok}/6`);
  return ok === 6 ? 0 : 1;
}

if (require.main === module && process.argv.includes('--self-test')) {
  process.exit(selfTest());
}
