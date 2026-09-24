#!/usr/bin/env bash
# selftest-iso.sh — shell counterpart of selftest-iso.cjs (C05-BUILD-SPEC 补遗二 §22).
# See that file's header for why realHome()/isoEnv()/footprint must not be reimplemented per-guard.
#
# Provides:
#   selftest_iso_env <T>
#     Exports HOME=USERPROFILE=PMM_HOME=<T> plus the derived PMM_RECALL_ROOT/PMM_TRIGGER_* into the
#     CURRENT shell (mutates the calling process's environment on purpose -- a `# ISO-ENTRIES:`
#     function is expected to call this, then invoke the DUT as a separate statement that inherits
#     the now-exported env; every other ambient PMM_* is unset first). All value derivation is
#     delegated to selftest-iso.cjs's isoEnv() so shell and Node never carry two copies of the rule.
#   selftest_footprint_begin <snapshot_file>
#     Writes a JSON snapshot of the real-root watch set to <snapshot_file>.
#   selftest_footprint_end <snapshot_file> <nonce> <run_root_base> [src_file]
#     Prints the footprint verdict line and returns 0 (pass) / 1 (red).
#
# Neither function does its own glob/diff/marker logic in shell; both shell out to the .cjs.

SELFTEST_ISO_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELFTEST_ISO_CJS="$SELFTEST_ISO_SH_DIR/selftest-iso.cjs"

selftest_iso_env() {
  local T="$1"
  # Normalize to Windows mixed-slash form BEFORE handing it to node (same idiom
  # pmm-trigger-recall.sh's run_dut/TW helpers already use): a raw `mktemp -d` POSIX path passed
  # straight through as an env VAR VALUE (not argv) is never MSYS-translated, so a native node.exe
  # reading process.env.HOME would resolve "/tmp/xxx" against the current drive's root instead of
  # the real temp dir (tooling:node-e-embedded-posix-path-silent-fallback's same class of bug).
  local TW
  TW="$(cygpath -m "$T" 2>/dev/null || printf '%s' "$T")"
  local kv
  kv="$(node -e '
    const iso = require(process.argv[1]);
    const env = iso.isoEnv(process.argv[2], {});
    for (const k of Object.keys(env)) {
      if (k.indexOf("PMM_") === 0) process.stdout.write(k + "=" + env[k] + "\n");
    }
  ' "$SELFTEST_ISO_CJS" "$TW")" || return 1
  local existing v
  existing="$(compgen -e 2>/dev/null | grep '^PMM_' || true)"
  for v in $existing; do unset "$v"; done
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    export "$line"
  done <<< "$kv"
  export HOME="$TW"
  export USERPROFILE="$TW"
  export PMM_HOME="$TW"
}

selftest_footprint_begin() {
  local snapshot_file="$1"
  node -e '
    const iso = require(process.argv[1]);
    const fs = require("fs");
    const snap = iso.footprint.begin();
    const obj = { before: Array.from(snap.before.entries()), ts: snap.ts };
    fs.writeFileSync(process.argv[2], JSON.stringify(obj));
  ' "$SELFTEST_ISO_CJS" "$snapshot_file"
}

selftest_footprint_end() {
  local snapshot_file="$1" nonce="$2" run_root_base="$3" src_file="${4:-}"
  node -e '
    const iso = require(process.argv[1]);
    const fs = require("fs");
    const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const before = new Map(raw.before);
    const markers = iso.markersFromSource(process.argv[5] || "", process.argv[3], process.argv[4]);
    const res = iso.footprint.end({ before, ts: raw.ts }, markers);
    console.log(res.line);
    process.exit(res.red ? 1 : 0);
  ' "$SELFTEST_ISO_CJS" "$snapshot_file" "$nonce" "$run_root_base" "$src_file"
}
