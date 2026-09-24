# OSS vendoring candidates for AxMem P2 (owner rule 2026-09-17)

Owner rule: before building infrastructure, find OSS on GitHub that can be copied, vendor it with
attribution, then optimize. Scope: AxMem is Node.js CommonJS (no build step) + bash, Windows/Git
Bash first, Apache-2.0. Vendored code must be MIT/BSD/Apache/ISC (GPL/AGPL excluded). All license
IDs and dates below are read live from the GitHub API (`pushed_at`) and the npm registry on
2026-09-17 — not from memory. Sources consulted: `README.md`, `docs/P2-CC-PERFECT-SPEC.md` v1.1,
`~/.claude/guards/specs/PMM-V3-FINAL-SPEC.md` §3/§5, `C05-BUILD-SPEC.md`,
`PMM-CMD-PARSE-CONTRACT.md`, and the current tree (`lib/`, `core/`, `adapters/`, `lifecycle/`).

Where relevant I checked what AxMem **already has** before recommending a vendor — three findings
changed verdicts materially and are called out inline: `lib/lock.cjs` (858-line hand-rolled
Windows-safe directory lock, already better than generic lockfile libs for this repo's specific
failure mode), `lib/msys-path.cjs` (already solves the MSYS `/c/...` case), and
`adapters/claude-code/merge-hooks.cjs` (already does identity-based hook dedup, but writes
`settings.json` with a plain `fs.writeFileSync` + separate `copyFileSync` backup — **not** the
temp+rename atomic pattern the P2 spec requires and that `lifecycle/install-manifest.cjs` /
`lifecycle/restore.cjs` already use elsewhere in this same repo).

---

## 1. Bash command parser as a differential test oracle (for parser 1.2)

Goal: not a replacement — a second, independent parser to run the same 1935-command corpus (and
the `pmm-cmd-parse-conformance.json` fixtures) through, diffing `exe`/`sub`/pipeline/redirect shape
against our `pmm-cmd-parse.cjs` v1.2. This is a **devDependency / test-only** use; it does not ship
in the runtime, so its own dependency count matters less than usual.

| Candidate | License | Last commit | Size | Deps | Windows/Git Bash fit | Verdict |
|---|---|---|---|---|---|---|
| [vorpaljs/bash-parser](https://github.com/vorpaljs/bash-parser) (npm `bash-parser`) | MIT | 2024-06-23 | 1.25 MB repo, single jison-generated AST module | **21** runtime deps (babylon, magic-string, etc.) | Pure JS, runs anywhere Node runs incl. Windows | **VENDOR (as test-only devDependency, not source-copy)** — do not vendor its source given the 21-dep tree; install it only in a `tests/oracles/` package.json scoped to that folder so it never touches the dependency-free runtime |
| [mvdan/sh](https://github.com/mvdan/sh) via [un-ts/sh-syntax](https://github.com/un-ts/sh-syntax) (npm `sh-syntax`) | mvdan/sh: BSD-3-Clause; sh-syntax wrapper: MIT | mvdan/sh 2026-09-09; sh-syntax 2026-09-11 (both actively maintained) | sh-syntax npm pkg: 794 KB unpacked, 23 files (bundles a Go→WASM binary) | **0** npm deps | WASM through Node, no native compile step — safe on Windows | **VENDOR (as test-only devDependency)** — most semantically complete oracle (full bash grammar incl. heredocs/subshells/functions, which is exactly parser 1.2's weak spot); superseded `mvdan-sh` (GopherJS) is archived, do not use it |
| [tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) via [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) (npm `web-tree-sitter`) | Both MIT | tree-sitter-bash 2026-09-13; tree-sitter core 2026-09-17 | web-tree-sitter: 0 deps, 4.68 MB unpacked (mostly its own `.wasm` runtime); prebuilt `tree-sitter-bash.wasm` release asset: 1.36 MB | **0** deps for web-tree-sitter | Use the **prebuilt `.wasm` from the GitHub Release** (`v0.25.1`), not the native `tree-sitter-bash` npm package (that one pulls `node-gyp-build`/native bindings and needs a C toolchain — avoid on Windows) | **VENDOR (as test-only devDependency + vendored `.wasm` binary)** — cheapest to wire up, gives a real CST (subshells, heredocs, functions, quoting) without any native build |
| [ljharb/shell-quote](https://github.com/ljharb/shell-quote) (npm `shell-quote`) | MIT | 2026-07-15 | 274 KB repo | 0 runtime deps | Pure JS | **REFERENCE-ONLY** — it's a quote/tokenize-args helper for POSIX shells, not a command-structure parser (no pipelines/redirects/heredoc model); useful only as a cross-check for its `parse()` token/operator split, not as an oracle for parser 1.2's segment shape |

**Recommendation**: run all three real parsers (bash-parser, sh-syntax, web-tree-sitter+tree-sitter-bash)
as three independent oracles in a dedicated `tests/oracles/package.json` (its own lockfile, isolated
from the zero-dep runtime), each converted to a small normalized shape (segment boundaries + exe +
redirect targets) and diffed against `pmm-cmd-parse.cjs` output on the same 1935-command corpus.
Three oracles agreeing where our parser disagrees is a much stronger signal than any one of them
alone, since none of the three shares our exact segment model (`pipeline_id`, `scope_id`,
`group.kind`, etc. are AxMem-specific and won't come free from any of them — this is comparison of
derived shape, not one-line diffing).

---

## 2. Lightweight full-text ranking for retrieval v2

Current state: `retrieval/pmm-search.sh` is a 34-line bash/grep shim (README calls it a "legacy
reference pending port"); there is no BM25 today, so this is greenfield. Need: exact-hit pinning,
field weights, deterministic scores, in-memory, zero/near-zero native deps.

| Candidate | License | Last commit | Size | Deps | Scoring model | Verdict |
|---|---|---|---|---|---|---|
| [lucaong/minisearch](https://github.com/lucaong/minisearch) | MIT | 2025-09-16 | Core source ≈2,650 lines across `src/MiniSearch.ts` (2,261) + `src/SearchableMap/*` (≈650); 826 KB unpacked incl. all dist formats | **0** | BM25+ (documented, deterministic given fixed corpus/query); per-field `boost`, `boostDocument`, `combineWith` | **VENDOR** — best match to the ask. No built-in "exact-hit pin," but that's a 5-line wrapper: if `query` case/diacritic-folds equal to a document's identity field, force it to rank 0 before returning MiniSearch's own (deterministic) order for the rest |
| [winkjs/wink-bm25-text-search](https://github.com/winkjs/wink-bm25-text-search) | MIT | 2022-11-21 (**stale**, ~4 yr, 0 open issues but no releases since) | 685 KB, 15 files | 0 required for the BM25 core itself, but its README workflow assumes `wink-nlp`/`wink-nlp-utils`/`wink-eng-lite-web-model` for tokenization (adds real weight) | True BM25 (not BM25+), field weights via per-doc field concatenation | **REFERENCE-ONLY** — algorithm is fine and small, but the project is dormant and its idiomatic usage drags in the wink-nlp stack; not worth the dependency surface when minisearch does the same job actively maintained |
| [olivernn/lunr.js](https://github.com/olivernn/lunr.js) | MIT | 2024-07-31 | Single bundled `lunr.js` = 3,475 lines; 21 small source files under `lib/` | 0 | TF-IDF (not BM25), deterministic, per-field boost via `field(name, {boost})` | **REFERENCE-ONLY** — ships as one drop-in file which is attractive for a no-build-step repo, but its scoring is TF-IDF not BM25/BM25+ and its API is index-once/immutable (no incremental update), a worse fit than minisearch for a memory corpus that grows daily |
| [nextapps-de/flexsearch](https://github.com/nextapps-de/flexsearch) | Apache-2.0 | 2026-06-28 (active) | 248 files, 2.3 MB unpacked | 0 | Custom "contextual" scoring, not classic BM25; multiple index presets trade recall vs. determinism | **NO** — over-built for this need (worker pools, multiple encoders/presets), documented tuning knobs make "deterministic scores" harder to reason about than minisearch's fixed BM25+ formula, and its file count is the opposite of "single-file/few-file" |
| [krisk/Fuse.js](https://github.com/krisk/Fuse) | Apache-2.0 | 2026-08-09 (active) | 20 files, 417 KB | 0 | Approximate/fuzzy string-distance scoring, not term-frequency ranking | **NO** — wrong tool: Fuse is fuzzy-match (typo tolerance) scoring, not BM25-style relevance ranking; it does have field weights but no exact-hit/IDF semantics the spec's `score = Σ 字段命中 × 权重` model wants |

**Target path**: `core/retrieval-bm25.cjs` (new), wrapping a vendored, trimmed copy of
`minisearch`'s `dist/` (CJS build) or its `src/MiniSearch.ts` compiled ahead-of-time to plain `.cjs`
(no build step at runtime, one offline compile when vendoring) — attribution header pointing at
`lucaong/minisearch` + MIT license text.

---

## 3. Transactional file replace, preimage store, and idempotent JSON merge

Existing gap found in-repo: `lifecycle/install-manifest.cjs:66-67` and `lifecycle/restore.cjs:70-71`
already do same-directory-staging + `fs.renameSync` (the atomic-write pattern) for their own JSON
files. `adapters/claude-code/merge-hooks.cjs:153-156`, which is the actual settings.json writer the
P2 spec's §3.3 transactional-install requirement targets, does **not** — it does
`fs.copyFileSync` (backup) then a direct `fs.writeFileSync` (non-atomic; a crash mid-write corrupts
`settings.json` in place). This is a real, concrete gap, not a hypothetical one.

| Candidate | License | Last commit | Size | Deps | What it solves | Verdict |
|---|---|---|---|---|---|---|
| [npm/write-file-atomic](https://github.com/npm/write-file-atomic) | ISC | 2026-07-02 | `lib/index.js` = 269 lines | 1 (`signal-exit`, ISC, 0 deps of its own) | Temp file + `fsync` + `rename`, preserves mode/uid/gid of the file it replaces, and retries on Windows `EPERM`/`EINVAL` (a documented `graceful-fs` workaround for a real Windows rename race) | **VENDOR** — this is exactly the P2 §3.3 "写前保存原始字节...一次原子替换(临时文件 + rename)" requirement, already battle-tested by npm itself on Windows CI for years. Vendor `writeFileAtomicSync` (drop the async/Promise variant, AxMem is sync-CLI) into `lib/atomic-write.cjs`; either vendor `signal-exit` too (tiny, ISC) or drop the signal-handler cleanup and accept an at-most-once stale-temp-file cleanup gap on SIGKILL |
| [typicode/steno](https://github.com/typicode/steno) | MIT | 2024-06-16 | 5 files, 7 KB | 0 | Same temp+rename idea, plus a write queue (ordered async writes, coalescing) | **REFERENCE-ONLY** — smaller and zero-dep, but it's async-only (Promise-based) and built for lowdb's use case (frequent small writes with debouncing); AxMem's hook/install writes are one-shot sync CLI operations, so write-file-atomic's sync API is a closer fit and its Windows-EPERM retry is documented/tested, steno's isn't |
| [moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) | MIT | 2023-10-25 (no commits in 3 yr) | 8 files, 30 KB | 3 (`retry`, `graceful-fs`, `signal-exit`, all ISC) | Advisory inter-process lock via `mkdir` | **NO** — AxMem's `lib/lock.cjs` (858 lines) already implements a directory-claim lock protocol specifically engineered around a Windows-specific failure this repo already hit and documented (`renameSync` onto an existing directory fails with **EPERM**, not `EEXIST`, on Windows — proper-lockfile's mkdir-based approach does not account for that distinction). Re-deriving/replacing working, spec'd, tested code with a 3-year-stale generic library is a downgrade, not an upgrade |
| [pierreinglebert/json-merge-patch](https://github.com/pierreinglebert/json-merge-patch) | MIT | 2024-02-10 | 9 files, 11 KB | 1 (`fast-deep-equal`, MIT) | RFC 7396 merge-patch (`null` deletes a key) | **NO** — wrong semantics for this use case: merge-patch's "`null` = delete" and "arrays replace wholesale" model is actively wrong for hook arrays, where we want *additive, identity-deduped* array entries (which is what `merge-hooks.cjs` already hand-rolls correctly). Also: RFC 7396 operates on parsed objects and cannot preserve original file formatting/comments — moot here since `settings.json` has no comments, but worth recording so nobody reaches for this library expecting byte-format preservation |
| [josdejong/immutable-json-patch](https://github.com/josdejong/immutable-json-patch) | **ISC** (GitHub API reports `NOASSERTION`; `LICENSE.md` in-repo is the ISC text, verified by fetch) | 2026-06-24 (active) | 57 files, 238 KB | 0 | RFC 6902 JSON Patch (immutable apply + inverse/undo) | **REFERENCE-ONLY** — different standard (ordered operations, not a merge), and AxMem's need is "merge a WANT list into an existing document," which is what `merge-hooks.cjs` already does correctly by hand; the useful idea to borrow is its *inverse-operation* pattern for `axmem uninstall`'s "restore preimage" path, not the library itself |
| Claude Code hook installers surveyed: [overact/claude-code-dotfiles](https://github.com/overact/claude-code-dotfiles) `install.sh`; [karanb192/claude-code-hooks](https://github.com/karanb192/claude-code-hooks); [decider/claude-hooks](https://github.com/decider/claude-hooks); [SuperClaude-Org/SuperClaude_Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework) | dotfiles: MIT; claude-code-hooks: MIT; claude-hooks: MIT; SuperClaude: MIT | dotfiles 2026-06-17; claude-code-hooks 2026-09-17 (active); claude-hooks 2025-07-20; SuperClaude 2026-09-15 | — | — | See below | **REFERENCE-ONLY, and weaker than what's already in-repo** |

Detail on the last row: `overact/claude-code-dotfiles/install.sh` backs up then does
`jq -s '.[0] * .[1]' settings.json template.json` — jq's `*` operator does **not** merge arrays
item-by-item, it replaces the array wholesale on the winning side, so re-running this against an
already-hooked `settings.json` would either duplicate or clobber hook entries depending on merge
direction. `karanb192/claude-code-hooks` ships 20+ plugins that rely entirely on Claude Code's
**native** plugin/marketplace install mechanism (`.claude-plugin/plugin.json` + `hooks/hooks.json`)
and contains no custom settings.json-merge code at all. `SuperClaude_Framework`'s installer is
Python and its actual settings-merge code path could not be located in the public tree (searched
`install_commands.py`, `install_mcp.py`, `hooks/__init__.py` — none contain a merge/backup
implementation; only `install_mcp.py` does a plain read-modify-write with no backup or atomicity).
**Conclusion: `adapters/claude-code/merge-hooks.cjs`'s identity-based `{event,matcher,command}`
dedup is already more correct than every external example found.** The one genuine improvement
available from outside is write-file-atomic's temp+rename+retry, which should be spliced into
`merge-hooks.cjs`'s existing write step (line 156) and into `lifecycle/backup.cjs`'s copy step.

**Target paths**: `lib/atomic-write.cjs` (new, vendored from write-file-atomic); wire it into
`adapters/claude-code/merge-hooks.cjs` (replace the `copyFileSync`+`writeFileSync` pair) and any
future `lifecycle/*.cjs` writers that don't already stage+rename.

---

## 4. Component registry / self-test discovery conventions (REFERENCE-ONLY, as expected)

Need: precedent for `docs/COMPONENTS.json` (§3.1 of the P2 spec) — a manifest where each entry
names a component + its selftest/fingerprint/canary command, consumed by multiple tools.

| Reference | What it does | Transferable idea |
|---|---|---|
| [git/git `t/` harness](https://github.com/git/git/tree/master/t) (`t/README`, `t/test-lib.sh`) | Convention-over-configuration: any `t[0-9]{4}-*.sh` file is a test; each sources `test-lib.sh` and calls `test_expect_success`. No central manifest — discovery is filename-pattern-based | Cheap for a large, single-repo test suite; **not** a model for COMPONENTS.json since it has no per-component canary/fingerprint concept, just pass/fail |
| [bats-core/bats-core](https://github.com/bats-core/bats-core) (Bash Automated Testing System) | Same convention-over-configuration idea for `.bats` files; each `@test "..." { }` block becomes a function; runner does a two-pass execution (count, then run) and emits TAP | Good model for *test file* discovery, but again no registry-of-components-with-metadata — it discovers tests, not components with named capabilities (selftest vs. fingerprint vs. canary are three different command *kinds* per component, which bats has no concept of) |
| [go-task/task](https://github.com/go-task/task) `Taskfile.yml` schema | A single declarative YAML manifest where each task has `desc`, `cmds`, `status` (a command whose success means "skip, already done"), `sources`/`generates` (fingerprint-like change detection). `task --list` introspects the manifest for humans; the same file drives execution | **Closest structural analog to `docs/COMPONENTS.json`**: one machine-readable manifest, each entry carrying multiple named command slots (here: `cmds` execution + `status` check, which is structurally the same shape as `selftestCommand`/`canaryCommand`/`fingerprint` fields) consumed by one CLI for multiple purposes (run, list, list-only-stale-via-status) |
| [casey/just](https://github.com/casey/just) `Justfile` + `just --list` | Single file of named recipes with optional doc-comments; `--list` reads the same file for a human-facing summary; a `mod` system lets recipes be split across files while still self-listing | Reinforces the "one file, multiple consumers (execute vs. introspect) read the same source of truth" principle already implicit in COMPONENTS.json's design; nothing here is more specific than what Taskfile already demonstrates |

No code is vendorable from any of these (they're either not JS, or the "manifest" is really just the
test files themselves). The one design takeaway worth stating explicitly: Taskfile's `status:` field
(a command whose *exit code*, not output, decides staleness) is a clean pattern for
`docs/COMPONENTS.json`'s `canaryCommand`/`selftestCommand` distinction — consider modeling both as
"a command + how to interpret its exit code," matching what `bin/axmem selftest`/`canary` already do.

---

## 5. Windows path normalization for Node

Need: MSYS `/c/...`, UNC, `\\?\` prefix, 8.3 names, case folding, and "is path A inside directory B."

| Candidate | License | Last commit | Size | Deps | What it actually does | Verdict |
|---|---|---|---|---|---|---|
| [jonschlinkert/normalize-path](https://github.com/jonschlinkert/normalize-path) | MIT | 2022-10-07 | 1 file, 30 lines | 0 | Collapses `\`→`/`, dedupes slashes, strips trailing slash; **explicitly special-cases** the `\\?\` and `\\.\` Windows namespace prefixes (keeps them as `//` so `path.win32.parse()` still recognizes them) | **VENDOR (reference the 15-line algorithm, don't add the package)** — the `\\?\`/`\\.\` handling is exactly the "long path prefix" case the need calls out, and it's small enough to inline into `lib/msys-path.cjs` rather than take a new dependency for one function |
| [anodynos/upath](https://github.com/anodynos/upath) | MIT | 2026-09-13 (active) | 10 files, 67 KB | 0 | Full drop-in replacement for Node's `path` module with all outputs forward-slashed; adds extension-manipulation helpers AxMem doesn't need | **REFERENCE-ONLY** — correct and maintained, but replacing every `path.*` call across the repo with `upath.*` is a much bigger blast radius than the need calls for; AxMem's existing `lib/msys-path.cjs` already targets the one specific bug (`/c/...` MSYS shape) precisely instead of normalizing everything |
| [domenic/path-is-inside](https://github.com/domenic/path-is-inside) | Dual WTFPL/MIT | 2020-03-03 | 1 file, ~25 lines | 0 | `thePath.lastIndexOf(potentialParent, 0) === 0` prefix check, **with an explicit `process.platform === 'win32'` lowercase step** before comparing (Node's own `path` module is case-sensitive even on case-insensitive Windows filesystems — this library is one of very few that corrects for that) | **VENDOR** — this is the "canonical way to detect path-is-inside safely" the need asks for. CommonJS, tiny, and the win32 lowercase step is precisely the kind of correctness detail AxMem's own resolver code already cares about (see `realpathSync.native` + lowercase in `PMM-V3-FINAL-SPEC.md` §4) |
| [sindresorhus/is-path-inside](https://github.com/sindresorhus/is-path-inside) | MIT | 2025-09-11 | 1 file, 8 lines | 0 | `path.relative(parent, child)` then checks it doesn't start with `..` | **REFERENCE-ONLY, not VENDOR** — elegant and shorter, but it does **not** lowercase for Windows, so `C:\Foo` vs `c:\foo` (the same directory on a real Windows filesystem) would wrongly report "not inside." Also: current `main` branch is ESM-only (`import`/`export default`); the last CommonJS release is the pinned `v3.0.3` tag, not latest. domenic's version is the more correct and more compatible pick for this repo |

On 8.3 short names and full case-folding: **no evaluated library resolves 8.3 names** — that
requires an OS syscall (`GetLongPathName`/`realpath`), not string manipulation, and AxMem's own spec
already covers it: `realpathSync.native` (try) is the documented, already-adopted approach
(`PMM-V3-FINAL-SPEC.md` §4, `pmm-hook.cjs` design). Nothing to vendor there — the existing
`lib/msys-path.cjs` + `fs.realpathSync.native` combination already covers everything this need asks
for except the `\\?\` prefix case and the case-insensitive "is-inside" check, both handled above.

**Target path**: `lib/path-is-inside.cjs` (new, ~25 lines from domenic/path-is-inside, MIT/WTFPL
attribution); add a `\\?\`/`\\.\`-prefix branch to `lib/msys-path.cjs` modeled on normalize-path's
3-line special case (attribution comment, not a new dependency).

---

## 6. Graph memory / causal edges — design reference only

Need: Graphiti, cognee, mem0, letta — data model for edges + temporal validity; confirm whether
anything is copyable. **Conclusion up front: nothing is vendorable. All four are Python (or,
for mem0, TypeScript that is LLM/vector-store-coupled), and AxMem's own edge model
(Cause/effects/Follows/precedes/supersedes/head-resolution, `PMM-V3-FINAL-SPEC.md` §1/§3.5) is
already fully specified and more specific to this repo's markdown-file corpus than any of these
would give us "for free."**

| Project | License | Last commit | Edge / temporal model | Copyable code? |
|---|---|---|---|---|
| [getzep/graphiti](https://github.com/getzep/graphiti) | Apache-2.0 | 2026-09-17 (active) | Bi-temporal edges: `created_at`, `expired_at`, `valid_at`, `invalid_at` on every `EntityEdge`; contradicting facts close the old edge's validity window rather than deleting it (5 edge subtypes: Entity/Episodic/Community/HasEpisode/NextEpisode) | No — Python, tightly coupled to its graph-DB drivers (Neo4j/FalkorDB) and LLM extraction calls even in the "pure" helper functions (`get_entity_edge_from_record`, embedding batch generation) |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | Apache-2.0 | 2026-09-17 (active) | Edge = `(source_id, target_id, relationship_name)` identity key + `relationship_type`/`edge_text`; **no temporal validity fields at all** (static-fact model, no supersede/expire concept) | The dedup/edge-construction helper (`expand_with_nodes_and_edges.py`) is genuinely DB-independent pure logic — but it's Python dataclasses solving a *simpler* problem (no temporal versioning) than AxMem's spec already solves; porting it would be a downgrade, not an upgrade |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | 2026-09-17 (active) | Has a full TS package (`mem0-ts/src/oss/src/memory/index.ts`, ~70 KB single file) alongside the Python core, so it's not purely a client SDK — but that file's "graph" mode wraps a real graph DB adapter and LLM-based fact extraction/dedup end to end; there is no standalone deterministic edge-resolution function to lift out | No — the logic that exists is inseparable from LLM calls and vector-similarity dedup, not a pure function |
| [letta-ai/letta](https://github.com/letta-ai/letta) (formerly MemGPT) | Apache-2.0 | 2026-09-10 | **Not graph-based at all**: three-tier model of Core Memory (fixed in-context blocks), Recall Memory (conversation history), Archival Memory (pgvector similarity store) — no edges, no causal/temporal relationships | N/A — wrong shape of system entirely for this need |

**Most useful takeaway (design, not code)**: Graphiti's "close the old edge's validity window
instead of deleting" rule is the same principle AxMem's own `Supersedes`/head-resolution already
implements (§1/§5 ⑧ of `PMM-V3-FINAL-SPEC.md`: "retire = move," never delete). This is convergent
design, not something to import — cite it in `docs/COMPONENTS.json`/design docs as prior art if
useful for the "why" narrative, nothing more.

---

## 7. Wilson score interval + randomized-assignment utilities

| Candidate | License | Last commit | Size | Deps | Shape | Verdict |
|---|---|---|---|---|---|---|
| [msn0/wilson-score-interval](https://github.com/msn0/wilson-score-interval) (npm `wilson-score-interval`) | MIT | 2023-01-12 | 8 files, 9 KB | 0 | One function, ~25 lines, `module.exports = function(positiveScore, total) { ... return {left, right} }`, hard-codes z=1.96 (95% CI), textbook Wilson score formula | **VENDOR** — confirms the need's premise exactly: a genuine one-function, dependency-free, CommonJS implementation exists |
| [iamjaytong/wilson-score](https://github.com/iamjaytong/wilson-score) (npm `wilson-score-rank`) | MIT | — (registry-listed, `main: wilsonscore.js`) | 4 files, 13 KB | 0 | Same formula, `.interval(pos, total, {confidence, correction})` — adds a continuity-correction toggle | **REFERENCE-ONLY** — near-duplicate of the above with one extra option; not worth vendoring both, msn0's is simpler |
| `math-utils/wilson-score` (npm `wilson-score`) | MIT | — | — (registry metadata only; package appears effectively unmaintained/thin) | 0 | Lower-bound-only variant (Reddit-comment-ranking style) | **REFERENCE-ONLY** — narrower (lower bound only, no interval), msn0's superset covers this |
| [1mb-dev/rollout-bucket](https://github.com/1mb-dev/rollout-bucket) | MIT | 2026-09-14 (**brand new**, 1 star) | 13 files, 15.5 KB, has a CJS build (`dist/cjs/index.js`) | 1 (`murmur-hash`, MIT, 0 deps) | Deterministic hash-bucket assignment (MurmurHash3 of an id, mod N) for feature-flag/A-B-style stable assignment | **REFERENCE-ONLY, do not depend on it yet** — the algorithm (murmur3(id) % buckets) is exactly the "simple randomized-assignment utility" the need describes and is trivially small to hand-write (~15 lines), but the package itself is one day old with a single star at time of writing — too immature a supply-chain link to add a dependency on; **inline the murmur3-mod-N pattern directly** instead of taking this dependency |

**Target path**: `lib/wilson-score.cjs` (new, ~25 lines vendored from msn0/wilson-score-interval,
MIT attribution header); if/when a deterministic-assignment utility is needed for the acceptance
runner's scored variant rounds (`core/acceptance/` — null/always/blind-parser arms, per
`PMM-V3-FINAL-SPEC.md` §6 / P2 spec §1.1.3), hand-write a ~15-line murmur3-or-`crypto.createHash`
mod-N bucketer in `lib/assign.cjs` rather than adding `rollout-bucket` as a dependency; revisit if it
gains real adoption.

---

## Vendor list

| Repo | Commit/version pinned | Files to copy | License | Target path in AxMem | Why |
|---|---|---|---|---|---|
| un-ts/sh-syntax | npm `sh-syntax@0.6.0` | whole npm package (WASM + JS wrapper) | MIT (wraps mvdan/sh, BSD-3-Clause) | `tests/oracles/package.json` devDependency | Most complete oracle for parser 1.2 differential testing |
| tree-sitter/tree-sitter-bash | release `v0.25.1`, asset `tree-sitter-bash.wasm` | 1 prebuilt `.wasm` binary (1.36 MB) | MIT | `tests/oracles/fixtures/tree-sitter-bash.wasm` | Second independent oracle; avoids native `node-gyp` build on Windows |
| vorpaljs/bash-parser | npm `bash-parser@0.5.0` | whole npm package (devDependency only) | MIT | `tests/oracles/package.json` devDependency | Third independent oracle (jison-grammar AST), only used to diff, never shipped |
| lucaong/minisearch | npm `minisearch@7.2.0` | `dist/` CJS build (or `src/MiniSearch.ts` + `src/SearchableMap/*` compiled once) | MIT | `core/retrieval-bm25.cjs` (wrapper) + `vendor/minisearch/` | BM25+ ranking engine for retrieval v2; zero deps, deterministic, actively maintained |
| npm/write-file-atomic | `lib/index.js` @ latest tag (v8.0.0 API surface) | `writeFileAtomicSync` function only (~90 of the 269 lines) | ISC | `lib/atomic-write.cjs` | Fixes the non-atomic `settings.json` write in `adapters/claude-code/merge-hooks.cjs:153-156`; matches the temp+rename pattern already used in `lifecycle/install-manifest.cjs`/`restore.cjs` |
| domenic/path-is-inside | `lib/path-is-inside.js` @ v1.0.2 | 1 file, ~25 lines | Dual WTFPL/MIT | `lib/path-is-inside.cjs` | Canonical, Windows-case-folding-aware "is path inside directory" check |
| jonschlinkert/normalize-path | `index.js` @ v3.0.0, `\\?\`/`\\.\` branch only | ~3-line snippet, inlined with attribution comment | MIT | `lib/msys-path.cjs` (extend existing file) | Adds the one prefix case (`\\?\`, `\\.\`) not already handled |
| msn0/wilson-score-interval | `index.js` @ latest | 1 file, ~25 lines | MIT | `lib/wilson-score.cjs` | One-function Wilson score interval, exactly as needed |

## Not vendorable, reasons

- **wink-bm25-text-search** — dormant since 2022; idiomatic usage drags in the wink-nlp stack. Use minisearch instead.
- **lunr.js, flexsearch, Fuse.js** — wrong scoring model (TF-IDF / contextual / fuzzy-distance respectively) or wrong shape (too many files) for a deterministic BM25+field-weight need. See §2 table for per-project reasoning.
- **proper-lockfile** — AxMem's own `lib/lock.cjs` already solves the exact Windows `EPERM`-not-`EEXIST` rename failure this library's generic mkdir-lock approach doesn't account for; adopting it would be a regression.
- **json-merge-patch / immutable-json-patch** — wrong merge semantics (RFC 7396's "null deletes, arrays replace wholesale" and RFC 6902's ordered-ops model both mismatch the additive identity-deduped array merge `merge-hooks.cjs` already implements correctly by hand).
- **Claude Code hook installer examples (overact, karanb192, decider, SuperClaude)** — all either weaker than AxMem's existing `merge-hooks.cjs` (naive whole-array jq merge) or delegate entirely to Claude Code's native plugin system (no custom merge code exists to copy). No code taken; documented as negative confirmation that the in-repo approach is already ahead.
- **git t/, bats-core** — pure test-file-discovery conventions, no component-registry/multi-command-per-entry concept to lift; Taskfile.yml's `status:`-field idea is the only transferable pattern, and it's a design note, not code.
- **Graphiti, cognee, mem0, letta** — all Python (or LLM/vector-DB-coupled TS for mem0); no standalone deterministic edge-resolution function exists to port. AxMem's own edge/supersede model (`PMM-V3-FINAL-SPEC.md` §1/§3.5/§5) is already more specific to this repo's needs than any of the four would provide.
- **is-path-inside (sindresorhus, current/ESM)** — no Windows case-folding, and current `main` is ESM-only (incompatible with this repo's CommonJS/no-build-step rule); its own `v3.0.3` tag is CJS but functionally inferior to domenic's version for this repo's purposes.
- **upath** — correct and maintained, but replacing all `path.*` calls repo-wide is a much larger change than this need calls for; the existing narrowly-scoped `lib/msys-path.cjs` is the better-fitted design already in place.
- **rollout-bucket** — algorithm is right-shaped but the package is one day old with a single star; inline the ~15-line murmur3-mod-N pattern instead of taking the dependency now.
- **8.3 short filenames, full Windows case-folding** — no JS library resolves these (OS-syscall territory); already covered by this repo's existing `fs.realpathSync.native` usage, nothing to add.
