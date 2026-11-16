#!/usr/bin/env node
'use strict';
// Deliberately NOT the full merge installer: PMM already owns the other five hooks.
// No prelude import: this CLI uses only explicit settings/root/config/record paths.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { buildWant, countIdentityMatches, normalizeCommand } = require('./merge-hooks.cjs');
const { writeFileAtomicSync } = require('../../lib/atomic-write.cjs');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const encode = (v) => JSON.stringify(v, null, 2) + '\n';
const identity = (w) => ({ event: w.event, matcher: w.matcher, normalized_command: normalizeCommand(w.command) });
const matches = (settings, w) => countIdentityMatches(settings, identity(w));
function trialWant(root, config) {
  const want = buildWant(root).slice(5); // phase-1-only
  return want.map((w) => ({ ...w, command: `AXMEM_CONFIG="${config}" ${w.command}` })); // config-command-guard
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--settings', '--root', '--config', '--record'].includes(flag)) {
      if (out[flag.slice(2)] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('missing/duplicate argument: ' + flag);
      out[flag.slice(2)] = argv[++i];
    } else if (['--dry-run', '--apply', '--rollback', '--status'].includes(flag) && !out.mode) out.mode = flag.slice(2);
    else throw new Error('unknown/duplicate argument: ' + flag);
  }
  if (!out.settings || !out.root || !out.config || !out.mode) throw new Error('required: --settings <path> --root <absolute root> --config <absolute config> (--dry-run|--apply|--rollback|--status) [--record <path>]');
  if (!path.isAbsolute(out.config)) throw new Error('config must be an absolute path'); // config-absolute-guard
  if (/["$`%!\u0000-\u001f\u007f]/.test(out.config)) throw new Error('config must be a shell-safe path'); // config-shell-guard
  out.config = path.resolve(out.config).replace(/\\/g, '/');
  if (!fs.statSync(out.config).isFile()) throw new Error('config must be an existing file'); // config-file-guard
  if (!path.isAbsolute(out.root) || /["$`%!\u0000-\u001f\u007f]/.test(out.root)) throw new Error('root must be an absolute, shell-safe path');
  out.root = path.resolve(out.root).replace(/\\/g, '/');
  if (!fs.statSync(path.join(out.root, 'adapters/claude-code/hook.cjs')).isFile()) throw new Error('root has no hook.cjs'); // root-guard
  out.settings = path.resolve(out.settings);
  out.record = path.resolve(out.record || out.settings + '.axmem-trial-install.json');
  const configPath = path.resolve(out.config);
  if (out.settings === configPath || out.record === configPath || out.record === out.settings || out.record === path.join(out.root, 'adapters/claude-code/hook.cjs')) throw new Error('settings/record path conflicts with input');
  return out;
}
function parseSettings(raw) {
  const s = JSON.parse(raw.toString('utf8')); // json-guard
  if (!object(s) || (Object.hasOwn(s, 'hooks') && !object(s.hooks))) throw new Error('settings/hooks must be objects');
  for (const groups of Object.values(s.hooks || {})) {
    if (!Array.isArray(groups) || groups.some((g) => !object(g) || !Array.isArray(g.hooks))) throw new Error('hook events must contain groups with hooks arrays');
  }
  return s;
}
function plan(settings, want) {
  const next = clone(settings), added = [], createdGroups = [], createdEvents = [];
  const createdHooks = !Object.hasOwn(settings, 'hooks');
  for (const w of want) {
    // Search ALL groups, not just the first one sharing a matcher.
    if (matches(next, w) > 0) continue; // identity-guard
    if (!Object.hasOwn(next.hooks || {}, w.event)) createdEvents.push(w.event);
    // Each new identity gets its own group; existing PMM groups stay intact.
    const template = w.matcher ? { matcher: w.matcher, hooks: [] } : { hooks: [] };
    createdGroups.push({ event: w.event, template });
    next.hooks ||= {};
    (next.hooks[w.event] ||= []).push({ ...template, hooks: [{ type: 'command', command: w.command }] });
    added.push(w);
  }
  return { next, added, createdGroups, createdEvents, createdHooks };
}
function loadRecord(opt, want) {
  let record;
  try { record = JSON.parse(fs.readFileSync(opt.record, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!object(record) || record.schema !== 'axmem.cc.trial-install.v1' || record.settings !== opt.settings || record.root !== opt.root || record.config !== opt.config ||
      typeof record.active !== 'boolean' || !Array.isArray(record.added) || record.added.length < 1 || record.added.length > 3 ||
      !record.added.every((id) => want.some((w) => JSON.stringify(identity(w)) === JSON.stringify(id))) ||
      new Set(record.added.map((id) => JSON.stringify(id))).size !== record.added.length ||
      typeof record.backup !== 'string' || path.dirname(record.backup) !== path.dirname(opt.settings) ||
      !record.backup.startsWith(opt.settings + '.axmem-trial-backup-') ||
      !/^[a-f0-9]{64}$/.test(record.backup_sha256) || !/^[a-f0-9]{64}$/.test(record.applied_sha256)) throw new Error('invalid/conflicting install record; use the original root/config/settings/record');
  return record;
}
function backupInfo(record) {
  if (!record) return { exists: false, shaMatches: false };
  try {
    const bytes = fs.readFileSync(record.backup);
    return { exists: true, shaMatches: sha256(bytes) === record.backup_sha256, bytes };
  } catch (e) { if (e.code === 'ENOENT') return { exists: false, shaMatches: false }; throw e; }
}
function assertUnchanged(file, raw) {
  if (!fs.readFileSync(file).equals(raw)) throw new Error('settings changed during operation; stop other writers and retry');
}
function removeOwned(settings, owned, p) {
  let removed = 0;
  const touched = new Set();
  for (const w of owned) {
    for (const g of settings.hooks?.[w.event] || []) {
      g.hooks = g.hooks.filter((h) => {
        if (matches({ hooks: { [w.event]: [{ ...g, hooks: [h] }] } }, w)) { removed++; touched.add(g); return false; }
        return true;
      });
    }
  }
  for (const { event, template } of p.createdGroups) {
    const groups = settings.hooks?.[event];
    if (!groups) continue;
    // Prefer the group we actually removed our command from: another owner
    // may have inserted an identical EMPTY group before it. Ignore object key
    // order for this check only; never rewrite the surviving group's keys.
    // Ambiguous copies are retained rather than deleting someone else's group.
    const empty = groups.filter((g) => isDeepStrictEqual(g, template));
    const ownedEmpty = empty.filter((g) => touched.has(g));
    const candidates = ownedEmpty.length ? ownedEmpty : empty;
    if (candidates.length === 1) groups.splice(groups.indexOf(candidates[0]), 1); // cleanup-guard
  }
  for (const event of p.createdEvents) if (settings.hooks?.[event]?.length === 0) delete settings.hooks[event];
  if (p.createdHooks && settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}
function main(argv) {
  const opt = parseArgs(argv);
  const raw = fs.readFileSync(opt.settings);
  const settings = parseSettings(raw);
  const want = trialWant(opt.root, opt.config);
  const record = loadRecord(opt, want);
  const counts = want.map((w) => matches(settings, w));
  if (opt.mode === 'status') {
    const b = backupInfo(record);
    console.log(`trial-install status: ${counts.filter((n) => n > 0).length}/3 present; counts=${counts.join(',')}`);
    console.log(`command: ${want[0].command}`);
    console.log(`record: ${opt.record}; active=${record ? record.active : 'none'}`);
    console.log(`backup: ${record?.backup || '(none)'}; exists=${b.exists}; sha256_matches=${record ? b.shaMatches : 'n/a'}`);
    return;
  }
  if (opt.mode === 'rollback') {
    if (!record) throw new Error('no install record; refusing to guess ownership');
    if (!record.active) { console.log('rollback: already rolled back (no-op)'); return; }
    const b = backupInfo(record);
    if (!b.exists || !b.shaMatches) throw new Error('backup missing or SHA256 mismatch; rollback refused'); // backup-guard
    const before = parseSettings(b.bytes);
    const owned = record.added.map((id) => want.find((w) => JSON.stringify(identity(w)) === JSON.stringify(id)));
    if (owned.some((w) => matches(before, w))) throw new Error('record claims a pre-existing hook');
    const p = plan(before, owned);
    if (sha256(encode(p.next)) !== record.applied_sha256) throw new Error('record/backup plan mismatch');
    let branch, target;
    if (JSON.stringify(settings) === JSON.stringify(p.next)) { // restore-guard
      branch = 'exact-restore (backup bytes restored)'; target = b.bytes;
    } else {
      const removed = removeOwned(settings, owned, p);
      branch = `identity-only (settings changed; removed ${removed}; other edits kept)`;
      // Avoid formatting-only writes when nothing was removed or cleaned up.
      target = JSON.stringify(settings) === JSON.stringify(parseSettings(raw)) ? raw : Buffer.from(encode(settings));
    }
    assertUnchanged(opt.settings, raw);
    if (!target.equals(raw)) writeFileAtomicSync(opt.settings, target, { mode: fs.statSync(opt.settings).mode });
    writeFileAtomicSync(opt.record, encode({ ...record, active: false, rollback_branch: branch, rolled_back_at: new Date().toISOString() }), { mode: 0o600 });
    console.log('rollback: ' + branch);
    return;
  }
  const p = plan(settings, want);
  if (!p.added.length) { console.log('trial-install: 3/3 already present (no-op; no writes)'); return; }
  if (record?.active) throw new Error('active trial record with missing hooks; rollback first, do not overwrite the original backup');
  if (opt.mode === 'dry-run') { // dry-run-guard
    console.log(`trial-install dry-run: would add ${p.added.length} hook(s); no writes; record=${opt.record}`);
    for (const w of p.added) console.log(JSON.stringify(identity(w)));
    return;
  }
  // All argument/JSON/root/config/record checks precede the FIRST write (the backup).
  // The record's parent must already exist; the CLI never creates state/config.
  if (!fs.statSync(path.dirname(opt.record)).isDirectory()) throw new Error('record parent is not a directory');
  const backup = opt.settings + '.axmem-trial-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
  const nextRaw = Buffer.from(encode(p.next));
  const nextRecord = { schema: 'axmem.cc.trial-install.v1', settings: opt.settings, root: opt.root, config: opt.config, active: true,
    installed_at: new Date().toISOString(), backup, backup_sha256: sha256(raw), applied_sha256: sha256(nextRaw), added: p.added.map(identity) };
  assertUnchanged(opt.settings, raw);
  fs.writeFileSync(backup, raw, { flag: 'wx', mode: fs.statSync(opt.settings).mode }); // backup-first
  if (sha256(fs.readFileSync(backup)) !== nextRecord.backup_sha256) throw new Error('backup verification failed');
  writeFileAtomicSync(opt.record, encode(nextRecord), { mode: 0o600 }); // journal-before-publish
  assertUnchanged(opt.settings, raw);
  writeFileAtomicSync(opt.settings, nextRaw, { mode: fs.statSync(opt.settings).mode }); // atomic-publish
  console.log(`trial-install: added ${p.added.length} hook(s); backup=${backup}; sha256=${nextRecord.backup_sha256}; record=${opt.record}`);
}
module.exports = { main };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error('trial-install refused: ' + e.message); process.exitCode = 1; }
}
