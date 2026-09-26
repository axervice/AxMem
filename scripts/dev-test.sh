#!/usr/bin/env bash
# scripts/dev-test.sh -- W24-U2: AxMem's single definition of "green" for publish work.
#
# One command that clones this repo into a disposable temp directory, isolates it from the real
# ~/.claude / ~/.hermes / ~/.codex* environment, runs the three publish-*.test.cjs unit suites plus
# `npm run selftest`, and (with --export) dry-runs scripts/publish-public.cjs (never --push) to prove
# the export is idempotent against the currently-published `public` tree. Exists so builders and the
# lead stop rediscovering the environment traps documented below by hand every time.
#
# Usage:
#   bash scripts/dev-test.sh                        # clone + isolate + run the 3 tests + npm run selftest
#   bash scripts/dev-test.sh --export                # same, plus a no-push dry-run export + idempotence check
#   bash scripts/dev-test.sh --keep                  # do not delete the temp clone afterwards
#   bash scripts/dev-test.sh --ref <rev>              # clone/checkout <rev> instead of this repo's HEAD
#   bash scripts/dev-test.sh --allow-dirty-inputs     # proceed even though a publish input has uncommitted
#                                                      # changes in the SOURCE repo (mirrors
#                                                      # scripts/publish-public.cjs's own checkInputsClean())
#   bash scripts/dev-test.sh --export --allow-tree-change  # with --export, don't fail if the freshly
#                                                      # exported tree differs from the source repo's
#                                                      # currently-published `public` tree
#
# Known traps this script exists to absorb (each one caused real rework before this script existed):
#   - A machine-wide `core.autocrlf=true` silently CRLF-corrupts a checkout. The disposable clone this
#     script makes is always created with `git clone --no-hardlinks -c core.autocrlf=false`, which
#     persists that setting into the CLONE's own .git/config regardless of the machine's global config
#     or of the checkout this script itself happens to be invoked from (see the recursion/self-clone
#     note below -- this is why running this script from an autocrlf=true checkout is still safe).
#   - A disposable clone has no git identity. Every git identity used below is supplied purely via
#     GIT_AUTHOR_*/GIT_COMMITTER_* environment variables (defaulted if unset) -- never via
#     `git config --global` or any per-repo `git config` write.
#   - The three tests/publish-*.test.cjs suites refuse (exit 2) when run against a cwd whose git remotes
#     point at a real github.com/axervice/* repo (they read/write git objects and must never do that
#     against a real checkout). This script always runs them inside the disposable clone, which has
#     ALL remotes removed before any test runs.
#   - scripts/publish-public.cjs reads every publish input (the manifest, publish-overrides/**, overlay/
#     addFiles/replacement sources) from the frozen source commit, not the working tree -- but it still
#     REFUSES to run at all if a publish input has an uncommitted edit, unless --allow-dirty-inputs is
#     passed. This script mirrors that exact check (via the exporter's own checkInputsClean()) against
#     the SOURCE repo before ever cloning it, so a dirty source tree is caught here immediately instead
#     of surfacing later as a confusing failure inside the clone.
#   - A full export (--export) runs `npm run selftest` internally (GATE3) and takes roughly 10 minutes.
#
# Recursion guard: this script writes a marker file at the root of every disposable clone it creates.
# If the repo this script is itself running from carries that marker, it refuses to run -- it must never
# be invoked against its own temp clone output (that would compound clones without bound).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER_NAME=".axmem-devtest-clone-marker"

usage() {
  cat <<'EOF'
Usage: bash scripts/dev-test.sh [--export] [--keep] [--ref <rev>] [--allow-dirty-inputs] [--allow-tree-change]

  --export               also run scripts/publish-public.cjs (never --push) inside the clone and assert
                          the resulting `public` tree matches the source repo's current `public` tree
  --keep                 do not delete the temp clone/isolation dir when done
  --ref <rev>             clone this repo at <rev> instead of the current HEAD of the repo this script
                          lives in
  --allow-dirty-inputs    proceed even though a publish input has uncommitted changes in the source repo
  --allow-tree-change     with --export, do not fail if the exported tree differs from the source repo's
                          published `public` tree
  -h, --help              show this help
EOF
}

EXPORT=0
KEEP=0
REF=""
ALLOW_DIRTY_INPUTS=0
ALLOW_TREE_CHANGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --export) EXPORT=1; shift ;;
    --keep) KEEP=1; shift ;;
    --ref)
      if [ $# -lt 2 ]; then echo "dev-test.sh: --ref requires a value" >&2; exit 2; fi
      REF="$2"; shift 2 ;;
    --allow-dirty-inputs) ALLOW_DIRTY_INPUTS=1; shift ;;
    --allow-tree-change) ALLOW_TREE_CHANGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "dev-test.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

START_TS=$(date +%s)

# ---------------------------------------------------------------------------------------------
# Resolve the repo this script lives in ("the source repo"). Never the caller's cwd -- so
# `bash scripts/dev-test.sh` behaves the same regardless of where it's invoked from.
SOURCE_REPO="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$SOURCE_REPO" ]; then
  echo "dev-test.sh: cannot resolve the git repo containing this script ($SCRIPT_DIR/..)" >&2
  exit 2
fi

# ---------------------------------------------------------------------------------------------
# Recursion guard: refuse if SOURCE_REPO is itself one of this script's own disposable clones.
if [ -f "$SOURCE_REPO/$MARKER_NAME" ]; then
  echo "dev-test.sh: refusing to run -- $SOURCE_REPO is itself a disposable clone created by a" >&2
  echo "  previous dev-test.sh run (marker file '$MARKER_NAME' present at its root). This is the" >&2
  echo "  recursion guard: dev-test.sh must not be invoked against its own temp clone output." >&2
  exit 2
fi

echo "dev-test.sh: source repo = $SOURCE_REPO"

# ---------------------------------------------------------------------------------------------
# Dirty-input check, mirroring scripts/publish-public.cjs's own checkInputsClean() gate -- run
# against the SOURCE repo, before anything is cloned. allowDirty is always passed as `true` to the
# exporter's own function so it never throws; THIS script decides whether the result is fatal.
DIRTY_CHECK_OUT="$(node -e '
  const path = require("path");
  const repo = process.argv[1];
  let pp;
  try { pp = require(path.join(repo, "scripts", "publish-public.cjs")); }
  catch (e) { process.stdout.write("SKIP-NO-EXPORTER: " + (e && e.message) + "\n"); process.exit(0); }
  const manifest = pp.readManifest();
  const result = pp.checkInputsClean(manifest, true);
  if (result.dirty.length) {
    process.stdout.write("DIRTY\n" + result.dirty.join("\n") + "\n");
    process.exit(3);
  }
  process.stdout.write("CLEAN\n");
' "$SOURCE_REPO" 2>&1)"
DIRTY_RC=$?
if [ "$DIRTY_RC" -eq 3 ]; then
  if [ "$ALLOW_DIRTY_INPUTS" -eq 1 ]; then
    echo "dev-test.sh: WARNING -- publish inputs have uncommitted changes in $SOURCE_REPO (--allow-dirty-inputs set, proceeding):"
    printf '%s\n' "$DIRTY_CHECK_OUT" | tail -n +2
  else
    echo "dev-test.sh: refusing -- publish inputs have uncommitted changes in $SOURCE_REPO (mirrors" >&2
    echo "  scripts/publish-public.cjs's own checkInputsClean() gate). Re-run with --allow-dirty-inputs" >&2
    echo "  to proceed anyway (the clone will still only ever see the last COMMITTED version of every" >&2
    echo "  input). Dirty publish input(s):" >&2
    printf '%s\n' "$DIRTY_CHECK_OUT" | tail -n +2 >&2
    exit 2
  fi
elif [ "$DIRTY_RC" -ne 0 ]; then
  echo "dev-test.sh: dirty-input check itself failed unexpectedly (rc=$DIRTY_RC):" >&2
  printf '%s\n' "$DIRTY_CHECK_OUT" >&2
  exit 2
else
  echo "dev-test.sh: publish inputs clean in $SOURCE_REPO ($DIRTY_CHECK_OUT)"
fi

# ---------------------------------------------------------------------------------------------
# Git identity via env only -- never `git config --global` / `git config` in any repo this script
# touches. Defaulted only if the caller hasn't already set one.
: "${GIT_AUTHOR_NAME:=axmem-devtest}"
: "${GIT_AUTHOR_EMAIL:=axmem-devtest@example.invalid}"
: "${GIT_COMMITTER_NAME:=axmem-devtest}"
: "${GIT_COMMITTER_EMAIL:=axmem-devtest@example.invalid}"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

# ---------------------------------------------------------------------------------------------
# Resolve --ref (default: SOURCE_REPO's current HEAD) against the SOURCE repo.
if [ -z "$REF" ]; then
  REF_OID="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
else
  REF_OID="$(git -C "$SOURCE_REPO" rev-parse --verify "${REF}^{commit}" 2>/dev/null)"
  if [ -z "$REF_OID" ]; then
    echo "dev-test.sh: --ref '$REF' does not resolve to a commit in $SOURCE_REPO" >&2
    exit 2
  fi
fi

# ---------------------------------------------------------------------------------------------
# Temp dir setup + cleanup trap.
CLONE_PARENT="$(mktemp -d)"
CLONE_DIR="$CLONE_PARENT/repo"
ISO_HOME="$CLONE_PARENT/isohome"
mkdir -p "$ISO_HOME/.axmem" "$ISO_HOME/mem" "$ISO_HOME/state"

OVERALL_OK=1

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "dev-test.sh: --keep set, leaving temp dir: $CLONE_PARENT"
  else
    rm -rf "$CLONE_PARENT"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------
# Clone (full history, all branches) with the two traps neutralized at the clone level itself:
# --no-hardlinks so this clone never shares object storage with SOURCE_REPO, and
# -c core.autocrlf=false persisted into the CLONE's own .git/config (independent of whatever the
# machine's global config, or SOURCE_REPO's own checkout, currently is -- this is what makes
# acceptance scenario (c), running this script from an autocrlf=true checkout, safe).
echo "dev-test.sh: cloning $SOURCE_REPO @ $REF_OID -> $CLONE_DIR"
if ! git clone --no-hardlinks -q -c core.autocrlf=false "$SOURCE_REPO" "$CLONE_DIR"; then
  echo "dev-test.sh: clone failed" >&2
  exit 2
fi

# Ensure a local `main` exists and points exactly at REF_OID (scripts/publish-public.cjs's
# resolveSourceOid() always resolves the literal branch name "main").
if ! git -C "$CLONE_DIR" show-ref --verify --quiet refs/heads/main; then
  git -C "$CLONE_DIR" branch main origin/main >/dev/null 2>&1 || git -C "$CLONE_DIR" branch main "$REF_OID" >/dev/null
fi
git -C "$CLONE_DIR" branch -f main "$REF_OID" >/dev/null
git -C "$CLONE_DIR" checkout -q main

# Resolve a usable `public` ref on a repo, local branch first, else any remote-tracking .../public.
find_public_rev() {
  local repo="$1"
  if git -C "$repo" show-ref --verify --quiet refs/heads/public; then
    echo "public"
    return 0
  fi
  local ref
  ref="$(git -C "$repo" for-each-ref --format='%(refname)' 'refs/remotes/*/public' 2>/dev/null | head -n 1)"
  if [ -n "$ref" ]; then
    echo "$ref"
    return 0
  fi
  return 1
}

HAVE_PUBLIC=0
CLONE_SRC_PUBLIC_REV="$(find_public_rev "$CLONE_DIR" || true)"
if [ -n "$CLONE_SRC_PUBLIC_REV" ]; then
  HAVE_PUBLIC=1
  if [ "$CLONE_SRC_PUBLIC_REV" != "public" ]; then
    git -C "$CLONE_DIR" branch public "$CLONE_SRC_PUBLIC_REV" >/dev/null
  fi
fi

# Remove ALL remotes -- required by the tests' own real-repo guard, and by this task's contract.
for r in $(git -C "$CLONE_DIR" remote); do
  git -C "$CLONE_DIR" remote remove "$r"
done

# Recursion-guard marker (untracked; never committed).
{
  echo "created-by=dev-test.sh"
  echo "pid=$$"
  echo "ts=$(date -u +%FT%TZ)"
  echo "source-repo=$SOURCE_REPO"
  echo "ref-oid=$REF_OID"
} > "$CLONE_DIR/$MARKER_NAME"

echo "dev-test.sh: clone ready (main=$REF_OID, public-source=${CLONE_SRC_PUBLIC_REV:-none})"

# ---------------------------------------------------------------------------------------------
# Isolation env for every node/npm invocation below -- never the real $HOME/$USERPROFILE, never the
# real ~/.claude / ~/.hermes / ~/.codex* trees, and GIT_ALLOW_PROTOCOL=file as defense-in-depth
# against any accidental network git operation.
run_isolated() {
  (
    export HOME="$ISO_HOME"
    export USERPROFILE="$ISO_HOME"
    export PMM_HOME="$ISO_HOME"
    export AXMEM_HOME="$ISO_HOME/.axmem"
    export AXMEM_MEMORY_DIR="$ISO_HOME/mem"
    export AXMEM_STATE_DIR="$ISO_HOME/state"
    export GIT_ALLOW_PROTOCOL=file
    "$@"
  )
}

# ---------------------------------------------------------------------------------------------
# Step 2: the three publish-*.test.cjs unit suites, then `npm run selftest` -- one summary line each.
TEST_FILES=(
  "tests/publish-leak-scan.test.cjs"
  "tests/publish-source-freeze.test.cjs"
  "tests/publish-push-hygiene.test.cjs"
)

for f in "${TEST_FILES[@]}"; do
  name="$(basename "$f" .test.cjs)"
  OUT="$( (cd "$CLONE_DIR" && run_isolated node "$f") 2>&1 )"
  RC=$?
  SUMMARY="$(printf '%s\n' "$OUT" | grep -E ' self-test [0-9]+/[0-9]+$' | tail -n 1)"
  if [ -z "$SUMMARY" ]; then SUMMARY="(no summary line found)"; fi
  echo "STEP $name: rc=$RC  $SUMMARY"
  if [ "$RC" -ne 0 ]; then
    OVERALL_OK=0
    printf '%s\n' "$OUT" | tail -n 40
  fi
done

SELFTEST_OUT="$( (cd "$CLONE_DIR" && run_isolated npm run selftest) 2>&1 )"
SELFTEST_RC=$?
echo "STEP npm-run-selftest: rc=$SELFTEST_RC"
if [ "$SELFTEST_RC" -ne 0 ]; then
  OVERALL_OK=0
  printf '%s\n' "$SELFTEST_OUT" | tail -n 60
fi

# ---------------------------------------------------------------------------------------------
# Step 3 (--export): dry-run scripts/publish-public.cjs (never --push) inside the clone, then assert
# idempotence against the source repo's currently-published `public` tree.
if [ "$EXPORT" -eq 1 ]; then
  echo "dev-test.sh: --export set -- running scripts/publish-public.cjs inside the clone (no --push)"
  EXPORT_OUT="$( (cd "$CLONE_DIR" && run_isolated node scripts/publish-public.cjs) 2>&1 )"
  EXPORT_RC=$?
  printf '%s\n' "$EXPORT_OUT"
  if [ "$EXPORT_RC" -ne 0 ]; then
    echo "STEP export: rc=$EXPORT_RC -- FAIL"
    OVERALL_OK=0
  else
    CLONE_PUBLIC_TREE="$(git -C "$CLONE_DIR" rev-parse public^{tree} 2>/dev/null)"
    echo "STEP export: rc=$EXPORT_RC  public-tree=$CLONE_PUBLIC_TREE"
    SOURCE_PUBLIC_REV="$(find_public_rev "$SOURCE_REPO" || true)"
    if [ -n "$SOURCE_PUBLIC_REV" ]; then
      SOURCE_PUBLIC_TREE="$(git -C "$SOURCE_REPO" rev-parse "${SOURCE_PUBLIC_REV}^{tree}" 2>/dev/null)"
      if [ "$CLONE_PUBLIC_TREE" = "$SOURCE_PUBLIC_TREE" ]; then
        echo "STEP export: IDEMPOTENT (clone public tree == source public tree $SOURCE_PUBLIC_TREE)"
      elif [ "$ALLOW_TREE_CHANGE" -eq 1 ]; then
        echo "STEP export: tree CHANGED (source=$SOURCE_PUBLIC_TREE clone=$CLONE_PUBLIC_TREE) -- allowed via --allow-tree-change"
      else
        echo "dev-test.sh: export tree differs from the source repo's published public tree, and --allow-tree-change was not set:" >&2
        echo "  source public tree: $SOURCE_PUBLIC_TREE" >&2
        echo "  clone  public tree: $CLONE_PUBLIC_TREE" >&2
        OVERALL_OK=0
      fi
    else
      echo "STEP export: source repo has no 'public' ref at all -- skipping idempotence assertion"
    fi
  fi
fi

# ---------------------------------------------------------------------------------------------
END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))
echo "dev-test.sh: runtime ${DURATION}s"

if [ "$OVERALL_OK" -eq 1 ]; then
  echo "DEV-TEST: PASS"
  exit 0
else
  echo "DEV-TEST: FAIL"
  exit 1
fi
