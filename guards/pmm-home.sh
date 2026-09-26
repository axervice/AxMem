#!/usr/bin/env bash
# pmm-home.sh — sourceable helper: resolve PMM_HOME_RESOLVED via the ONE home-directory resolver
# (2026-09-17, M-6a, fab 盲攻 + Opus 复现; conventions.home_resolution names pmm-recall-ledger.cjs's
# resolveHome() as the single allowed reader of os.homedir()/HOME/USERPROFILE — every other guard
# reading those directly is a red in pipe-gate-v2-acceptance.cjs's self-check part13). Shell guards
# should source this instead of reading $HOME/$USERPROFILE themselves, so all of them converge on the
# SAME precedence (PMM_HOME > USERPROFILE > HOME > os.homedir()) instead of each hand-rolling one.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/pmm-home.sh"
#   echo "$PMM_HOME_RESOLVED"      # resolved home, POSIX-style (e.g. /c/Users/<user>) on this host
#   echo "$PMM_HOME_RESOLVED_VIA"  # "resolveHome" (normal path) or "fallback" (node/module unavailable)
#
# 2026-09-23 (Opus fab-delta HIGH-1, CONFIRMED — see audits/OPUS-2026-09-23-fab-delta-triage.md
# §HIGH-1): the previous version embedded the POSIX-style $G path directly inside a
# `node -e "...require('$G/...')..."` DOUBLE-quoted string. On this host node.exe is native Windows
# node (not MSYS-aware) and never translates a `/c/...` argument embedded in -e source text, so that
# require() call unconditionally threw MODULE_NOT_FOUND and this file silently fell straight through
# to the `cd ~ && pwd` fallback on EVERY invocation — not just when node was genuinely unavailable.
# That masked two failures at once: (a) PMM_HOME was ignored by every shell guard even though the
# node side (resolveHome() itself) honored it correctly, and (b) HOME vs USERPROFILE divergence was
# invisible because the fallback always tracked $HOME specifically.
#
# Fix: pass the ledger path through argv instead (bash -> node argv IS translated by MSYS, unlike
# text interpolated into the -e source), read it back with `require(process.argv[1])`, and normalize
# the result with `cygpath -u` (measured idempotent on all three shapes this host can produce:
# `C:\...`, `C:/...`, `/c/...`) so callers keep seeing the same POSIX-style value as before this fix.
# PMM_HOME_RESOLVED_VIA records which path actually ran, so a caller (or guards/pmm-home-split-
# probe.sh / the canary) can assert the resolveHome() path was taken instead of the fallback silently
# substituting for it.
#
# 2026-09-23 (Opus A4 review, LOW-2, CONFIRMED): the argv translation the fix above depends on is
# itself an MSYS behavior, not a bash one -- with `MSYS_NO_PATHCONV=1` or `MSYS2_ARG_CONV_EXCL=*` set
# in the caller's environment, MSYS stops rewriting POSIX-style argv entries, `$G` (already
# POSIX-style, from `pwd` above) reaches node unmodified, and this falls straight back into the same
# MODULE_NOT_FOUND -> fallback failure HIGH-1 fixed -- same defect class, just gated by two env vars
# instead of being unconditional. Fix: convert the ledger path to Windows form with `cygpath -m`
# BEFORE handing it to node, so the argv is already in the one form node's own require() accepts
# regardless of whether MSYS's argv rewriting runs on it or not (verified: resolveHome/VIA=resolveHome
# in all three of the ambient/normal, MSYS_NO_PATHCONV=1, and MSYS2_ARG_CONV_EXCL=* environments,
# matching pmm-migrate-v3.sh:58's own established `cygpath -m` convention). Falls back to the raw
# POSIX path if cygpath itself is unavailable (same overall fail-safe shape as everywhere else here).
#
# Fails safe: if node or the ledger module is genuinely unavailable (or resolveHome() returns
# nothing), falls back to the shell's own home directory via `cd ~ && pwd`. 2026-09-23 (Opus A4
# review, LOW-3): this line was previously also justified as avoiding a part13 hit for a literal
# `$HOME` read -- that rationale is now stale: v2.26's part13 scanner (pipe-gate-v2-acceptance.cjs)
# classifies `cd ~` itself as a hit and allowlists this exact line -- matched by its exact text, once
# per file (NOT by line number: an edit to this line un-allows it, which is the point) -- so the real
# guarantee that a genuine `$HOME`-read regression here gets caught is that allowlist entry plus
# guards/pmm-home-split-probe.sh's behavioral checks, not this line's particular phrasing. After the
# argv/cygpath fixes above, this fallback should only trigger when node (or cygpath, for the argv
# conversion) is truly missing from PATH -- not, as before, on every single invocation -- so it also
# emits a one-line stderr diagnostic and sets PMM_HOME_RESOLVED_VIA=fallback, making a silent
# divergence from resolveHome() visible instead of indistinguishable from the normal path.
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PMM_HOME_RESOLVED_VIA=resolveHome
LEDGER_ARG="$(cygpath -m "$G/pmm-recall-ledger.cjs" 2>/dev/null || printf '%s' "$G/pmm-recall-ledger.cjs")"
PMM_HOME_RESOLVED="$(node -e 'process.stdout.write(require(process.argv[1]).resolveHome())' "$LEDGER_ARG" 2>/dev/null)"
[ -n "$PMM_HOME_RESOLVED" ] && command -v cygpath >/dev/null 2>&1 && PMM_HOME_RESOLVED="$(cygpath -u "$PMM_HOME_RESOLVED")"
if [ -z "$PMM_HOME_RESOLVED" ]; then
  PMM_HOME_RESOLVED="$(cd ~ 2>/dev/null && pwd)"
  PMM_HOME_RESOLVED_VIA=fallback
  echo "pmm-home.sh: resolveHome() 不可用,回落 ~(PMM_HOME/USERPROFILE 未被采用)" >&2
fi
unset LEDGER_ARG
export PMM_HOME_RESOLVED PMM_HOME_RESOLVED_VIA
