#!/usr/bin/env node
// AxMem lifecycle backup — manifest.json-carrying tar archive. (P1 2.3, 2026-09-16)
// Extends `axmem migrate --backup`'s bare `tar -cf` with a manifest.json
// member (format version, per-file relative path + sha256, member count,
// total bytes) so `restore` has something to verify tar integrity against
// BEFORE trusting a single byte of it (spec: "无 manifest ⇒ 拒绝并提示先
// migrate --backup"). Archive layout: `manifest.json` at the archive root,
// plus `<memoryDirBasename>/...` holding a full copy of the memory dir
// tree — same top-level name the ORIGINAL bare-tar backup already used, so
// existing pre-P1-2.3 backups and this one agree on where the content
// lives inside the archive.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const MANIFEST_FORMAT_VERSION = 1;

// Converts a native Windows path to POSIX/MSYS form (C:\a\b -> /c/a/b).
// Required before handing ANY path to the `tar` binary here: it is an MSYS
// build, and its argv handling silently CORRUPTS long (~100+ character)
// backslash-heavy Windows-style path arguments — reproduced empirically
// (a 110-char `C:\...` destination had its middle characters mangled,
// "13dedaac" became "vdedaac", causing a spurious "Cannot open" failure)
// while the byte-identical POSIX-spelled path worked every time. This is
// NOT optional hardening, it is a correctness fix for real AXMEM_STATE_DIR
// depths (see the builder report for the full reproduction).
function toPosixTarPath(p) {
  const abs = path.resolve(p);
  return abs.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Recursively lists files under `dir`, returning POSIX-style paths relative
// to `dir` (forward slashes always, regardless of platform — tar and the
// manifest both need a stable, cross-platform separator).
// [LOW] `onSkip(fullPath)`, when given, is called for every symlink (file
// or directory/junction — Node's Dirent.isSymbolicLink() reports Windows
// junctions this way too, verified empirically elsewhere in this repo)
// encountered while walking. The memory dir is expected to be plain files;
// a symlink is silently excluded from both the backup manifest and any
// tree-identity hash computed over this listing (restore.cjs's
// computeTreeHash reuses this same function) — previously with NO signal
// that anything was left out at all, which could hide real data loss
// (a symlinked note silently never backed up) behind a clean, quiet run.
function listFilesRecursive(dir, base = dir, onSkip) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      if (onSkip) onSkip(full);
      continue;
    }
    if (e.isDirectory()) {
      out = out.concat(listFilesRecursive(full, base, onSkip));
    } else if (e.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join('/');
      out.push(rel);
    }
    // anything that's neither a symlink, directory, nor plain file (a
    // device/FIFO/socket) still falls through silently here — out of
    // scope for a memory-notes directory, and tar-safety.cjs already
    // rejects those types outright wherever a restore actually matters.
  }
  return out;
}

function copyRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(srcDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) copyRecursive(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// Builds the manifest object for `memoryDir`, with each file's path
// prefixed by `basename` (the archive-internal top-level folder name).
function buildManifest(memoryDir, basename) {
  const rels = listFilesRecursive(memoryDir, memoryDir, (full) => {
    console.error(`backup: warning — skipping symlink "${full}" (symlinks are never included in a backup)`);
  }).sort(); // deterministic order
  const files = rels.map((rel) => {
    const full = path.join(memoryDir, ...rel.split('/'));
    const stat = fs.statSync(full);
    return { path: `${basename}/${rel}`, sha256: sha256File(full), size: stat.size };
  });
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  return { format_version: MANIFEST_FORMAT_VERSION, member_count: files.length, total_bytes: totalBytes, files };
}

// Creates the tar at `outputTarPath` from `memoryDir`. Returns the manifest
// object that was embedded. Uses the `tar` binary already relied on by the
// pre-existing `axmem migrate --backup` (no new runtime dependency).
function createBackup(memoryDir, outputTarPath) {
  const basename = path.basename(memoryDir);
  const manifest = buildManifest(memoryDir, basename);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-backup-staging-'));
  try {
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    copyRecursive(memoryDir, path.join(staging, basename));
    fs.mkdirSync(path.dirname(path.resolve(outputTarPath)), { recursive: true });
    // --force-local: GNU tar on Windows otherwise parses a leading "C:" in
    // ANY path argument (archive path OR -C base) as a "host:path" remote
    // spec and fails with "Cannot connect to C: resolve failed" — a
    // pre-existing bug in the ORIGINAL bare `tar -cf` this replaces too
    // (reproduced and fixed in the same pass, see builder report).
    execFileSync('tar', ['--force-local', '-cf', toPosixTarPath(outputTarPath), '-C', toPosixTarPath(staging), 'manifest.json', basename], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return manifest;
}

module.exports = { createBackup, buildManifest, listFilesRecursive, sha256File, toPosixTarPath, MANIFEST_FORMAT_VERSION };

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function selfTest() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-backup-selftest-'));
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  const memDir = path.join(T, 'memory');
  fs.mkdirSync(path.join(memDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(memDir, 'decisions.md'), 'hello decisions\n');
  fs.writeFileSync(path.join(memDir, 'sub', 'nested.md'), 'nested content\n');
  const tarPath = path.join(T, 'backup.tar');

  const manifest = createBackup(memDir, tarPath);

  // 1. manifest lists exactly the files present, with correct sha256/size
  check('1 manifest lists all files with correct hash/size', manifest.files.length === 2 && manifest.member_count === 2 &&
    manifest.files.every((f) => {
      const rel = f.path.split('/').slice(1).join('/');
      const full = path.join(memDir, ...rel.split('/'));
      return fs.existsSync(full) && sha256File(full) === f.sha256 && fs.statSync(full).size === f.size;
    }));

  // 2. tar was actually created and is non-trivial
  check('2 tar archive created', fs.existsSync(tarPath) && fs.statSync(tarPath).size > 0);

  // 3. tar contains manifest.json AND the memory/ tree — verify by listing
  const list = execFileSync('tar', ['--force-local', '-tf', toPosixTarPath(tarPath)], { encoding: 'utf8' });
  check('3 tar contains manifest.json and the memory tree', list.includes('manifest.json') && list.includes('memory/decisions.md') && list.includes('memory/sub/nested.md'));

  // 4. total_bytes matches the sum of file sizes
  const sum = manifest.files.reduce((n, f) => n + f.size, 0);
  check('4 total_bytes matches sum of file sizes', manifest.total_bytes === sum);

  // 5 (LOW): a symlink inside the memory dir is excluded from the backup
  // AND produces an explicit warning — not silent data loss.
  {
    const symMemDir = path.join(T, 'memory-with-symlink');
    fs.mkdirSync(symMemDir, { recursive: true });
    fs.writeFileSync(path.join(symMemDir, 'decisions.md'), 'real file\n');
    const linkTargetDir = path.join(T, 'symlink-target');
    fs.mkdirSync(linkTargetDir, { recursive: true });
    fs.writeFileSync(path.join(linkTargetDir, 'ghost.md'), 'never backed up\n');
    let symlinkOk = true;
    try { fs.symlinkSync(linkTargetDir, path.join(symMemDir, 'linked'), 'junction'); } catch { symlinkOk = false; }
    if (symlinkOk) {
      const origErr = console.error;
      let warned = false;
      console.error = (msg) => { if (typeof msg === 'string' && msg.includes('skipping symlink') && msg.includes('linked')) warned = true; };
      let manifest5;
      try { manifest5 = buildManifest(symMemDir, 'memory-with-symlink'); } finally { console.error = origErr; }
      check('5 (LOW) symlink inside memory dir excluded from the manifest AND produces an explicit warning', warned && manifest5.files.length === 1 && manifest5.files[0].path.endsWith('decisions.md'));
    } else {
      check('5 (LOW) symlink warning (skipped: could not create a test symlink on this system)', true);
    }
  }

  console.log(results.join('\n'));
  console.log(`backup self-test ${ok}/5`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === 5 ? 0 : 1;
}

if (require.main === module && process.argv[2] === '--self-test') {
  process.exit(selfTest());
}
