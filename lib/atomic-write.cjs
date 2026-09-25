#!/usr/bin/env node
// AxMem atomic file write helper. (2026-09-24, group 6 "补" —
// guards/audits/BORROW-MATRIX-2026-09-24-full.md: adapters/claude-code/
// merge-hooks.cjs wrote the real ~/.claude/settings.json with a plain
// fs.copyFileSync(backup) + fs.writeFileSync(SETTINGS, newRaw) pair — a
// process crash or power loss landing between those two calls leaves
// settings.json truncated/corrupt on disk, taking every Claude Code hook
// with it. This repo already has the fix PATTERN in two places
// (lifecycle/install-manifest.cjs writeManifestAtomic(),
// lifecycle/restore.cjs writeJournalAtomic(): same-directory staging file
// + fs.renameSync) but neither is exported for reuse, and neither calls
// fsync before the rename — good enough for "never see a half-written
// file" (rename is atomic at the filesystem level regardless), not quite
// enough for "survives a power loss between write and the next fsync of
// the containing directory's metadata". This helper adds that missing
// fsync step and is the one shared place other write points in this repo
// can pull the same guarantee from instead of re-deriving it.
//
// Vendor decision (recorded in full in guards/vendor/VENDOR.md): the
// obvious candidate, npm/write-file-atomic, was NOT vendored. Its current
// stable release (8.0.0) dropped the old imurmurhash dependency but now
// requires Node ^22.22.2 || ^24.15.0 || >=26.0.0 — incompatible with this
// repo's own declared floor ("engines": {"node": ">=20"} in package.json)
// and with the Node 24.14.1 actually running in this environment at the
// time of this fix. Every earlier release compatible with Node >=20
// (verified against the npm registry: 4.0.2 needs ^12.13.0||^14.15.0||
// >=16.0.0, 5.0.1 needs ^14.17.0||^16.13.0||>=18.0.0) still carries BOTH
// imurmurhash AND signal-exit as dependencies — there is no version of
// this package that is simultaneously Node>=20-compatible and free of a
// transitive dependency chain. Introducing either would be the FIRST
// production dependency this zero-dependency repo has ever had (see
// guards/vendor/VENDOR.md's own note on why node-tar was rejected for the
// same reason). This ~25-line function below is written to the SAME core
// algorithm write-file-atomic's sync path uses (open tmp file in the
// SAME directory as the target -> write -> fsync -> close -> rename over
// the target -> best-effort unlink the tmp file if anything above threw
// before the rename), deliberately dropping only write-file-atomic's
// signal-exit-based "also clean up the tmp file if the process is KILLED
// by a signal mid-write" behavior: that is a tidiness nicety (an orphaned
// .tmp file left behind after a hard kill), not a correctness requirement
// — the real target file is never touched until the rename, so it can
// never observe a half-write either way.
'use strict';
const fs = require('fs');
const path = require('path');

// writeFileAtomicSync(filePath, data, options?)
// `data` is a string or Buffer. `options.mode` (default 0o666, subject to
// umask, matching fs.writeFileSync's own default) sets the new file's
// mode; it is applied to the tmp file before rename so the renamed-over
// target never has a moment with the wrong permissions.
function writeFileAtomicSync(filePath, data, options) {
  options = options || {};
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), options.encoding || 'utf8');
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const staging = path.join(dir, `.${base}.axmem-staging-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let fd = null;
  let renamed = false;
  try {
    fd = fs.openSync(staging, 'w', options.mode || 0o666);
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd); // durability: force the new bytes to disk BEFORE the rename that makes them visible
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(staging, filePath); // atomic at the filesystem level — readers see either the old or the new file, never a partial one
    renamed = true;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed, or never successfully opened */ }
    }
    if (!renamed) {
      try { fs.unlinkSync(staging); } catch { /* staging may not exist yet if openSync itself threw — nothing to clean up */ }
    }
  }
}

module.exports = { writeFileAtomicSync };

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-atomic-write-selftest-'));
  const target = path.join(T, 'settings.json');

  // 1. normal round trip: content lands, file is readable, no stray staging
  //    file left behind afterward.
  {
    writeFileAtomicSync(target, '{"hooks":{}}\n');
    const listing = fs.readdirSync(T);
    check('1 normal write: target has exact content, and no leftover .axmem-staging-* file remains in the directory',
      fs.readFileSync(target, 'utf8') === '{"hooks":{}}\n' && listing.filter((f) => f.includes('.axmem-staging-')).length === 0);
  }

  // 2. crash-mid-write simulation: an existing target file with real content
  //    must NOT be truncated/corrupted if the process dies between opening
  //    the staging file and the rename that would publish it — the whole
  //    point of writing to a same-directory staging file first instead of
  //    truncating the real target in place. Simulated by monkey-patching
  //    fs.renameSync (the step write-file-atomic's own algorithm treats as
  //    the atomic "publish" point) to throw, standing in for the process
  //    being killed at that exact instant.
  {
    fs.writeFileSync(target, 'OLD-COMPLETE-CONTENT');
    const before = fs.readFileSync(target, 'utf8');
    const origRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated crash: process killed before rename could publish the new content'); };
    let threw = false;
    try {
      writeFileAtomicSync(target, 'NEW-CONTENT-that-should-never-land-half-written');
    } catch {
      threw = true;
    } finally {
      fs.renameSync = origRename;
    }
    const after = fs.readFileSync(target, 'utf8');
    const listing = fs.readdirSync(T);
    const strayStaging = listing.filter((f) => f.includes('.axmem-staging-'));
    check('2 simulated crash before rename: writeFileAtomicSync throws, the real target file is byte-for-byte UNCHANGED (never truncated/half-written), and the orphaned staging file was cleaned up (no half file left behind)',
      threw && after === before && before === 'OLD-COMPLETE-CONTENT' && strayStaging.length === 0);
  }

  console.log(results.join('\n'));
  console.log(`atomic-write self-test ${ok}/2`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  return ok === 2 ? 0 : 1;
}

if (require.main === module && process.argv.includes('--self-test')) {
  process.exit(selfTest());
}
