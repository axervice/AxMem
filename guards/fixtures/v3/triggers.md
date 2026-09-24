# triggers.md — trigger grammar oracle (multi-tool path trigger, repo=wildcard cmd legal/illegal, bad forms)
# NOTE: title text itself must never contain a literal `*` — TITLE's title group is [^*\n]+? so a
# stray asterisk in the human-readable title breaks the grammar match (that's the TITLE_RE contract,
# not a bug); wildcard/star is spelled out in words here instead.

**2026-01-01 — multi-tool path trigger (Edit or Write or MultiEdit)** [fx:multi-tool-trigger]
<!-- trigger: tool=Edit|Write|MultiEdit; repo=home; path=.claude/guards/* -->
three tools on one trigger line, prefix path with 2+ segments after stripping the trailing star.

**2026-01-02 — wildcard-repo cmd trigger with a LEGAL exe not in the denylist** [fx:cmd-legal]
<!-- trigger: tool=Bash; repo=*; cmd=jq -->
`jq` is not git/npm/npx/node/bash/sh/pwsh/powershell/python/py/cd/ls/cat/echo/rm/cp/mv — legal.

**2026-01-03 — wildcard-repo cmd trigger with an ILLEGAL exe, denylisted, must be B5** [fx:cmd-illegal]
<!-- trigger: tool=Bash; repo=*; cmd=git -->
`git` under repo=wildcard is denylisted — B5 must fire.

**2026-01-04 — cmd trigger with a sub-command token** [fx:cmd-with-sub]
<!-- trigger: tool=Bash; repo=home; cmd=npm run -->
exe=npm sub=run, two tokens, non-substring match semantics (informational for §3.1's push matcher;
core only validates the FORM here).

**2026-01-05 — malformed trigger comment missing repo=, must be B5** [fx:bad-trigger-form]
<!-- trigger: tool=Edit; path=.claude/x -->
missing `repo=` segment entirely — does not match TRIG_P or TRIG_C, must be flagged B5.

**2026-01-06 — path trigger with a too-short root-level prefix is B5** [fx:bad-path-prefix]
<!-- trigger: tool=Write; repo=home; path=ab* -->
09-15 revision: a root-level (no `/`) prefix is legal if it is ≥3 UTF-8 bytes (`.env*`, `vercel*`,
`docs/*`, `prisma/*` are all fine) — but "ab" is only 2 bytes, still B5.

**2026-01-07 — bare wildcard path is illegal, B5** [fx:bad-path-star]
<!-- trigger: tool=Edit; repo=home; path=* -->
09-15 revision: bare `*` now matches TRIG_P (path is captured loosely) but gets the SPECIFIC
"拒 path=*" reason from code, not the generic malformed-comment fallback.

**2026-01-08 — root-level prefix >=3 bytes with no slash is LEGAL (09-15 revision)** [fx:good-root-prefix]
<!-- trigger: tool=Edit; repo=axervice-booking; path=.env* -->
".env" (4 bytes, no `/`) is a legal root-level file-name prefix now — must NOT be B5.

**2026-01-09 — a star anywhere but the very end is now LEGAL glob, not B5 (09-15 revision)** [fx:good-mid-star]
<!-- trigger: tool=Edit; repo=axervice-booking; path=scripts/itest-*lock*.ts -->
09-15 revision (GLOB-TRIGGER-SPEC.md): two stars, neither at the true end, used to be the exact dead
pattern that caused the 9-trigger incident — must now compile and be RECORDED as a trigger, not B5.

**2026-01-10 — a mid-string star is still B5 if the literal prefix before it is under 3 bytes** [fx:bad-short-prefix-midstar]
<!-- trigger: tool=Edit; repo=axervice-booking; path=ab*cd*ef -->
the prefix-length policy applies regardless of WHERE the first star sits — "ab" is 2 bytes, still B5,
even though the star is not the very last character.

**2026-01-11 — a mid-string star with a leading-slash prefix is B5** [fx:bad-leading-slash-midstar]
<!-- trigger: tool=Edit; repo=axervice-booking; path=/ab*cd -->
prefix "/ab" starts with a slash — illegal regardless of length or star position.

**2026-01-12 — real-world incident pattern: mid-string star in a root-level glob, docs design files** [fx:good-docs-design]
<!-- trigger: tool=Edit; repo=home; path=docs/*-design.md -->
one of the actual 9 dead triggers from the 2026-09-15 incident report — must compile and match e.g.
`docs/api-design.md`, must NOT match `xdocs/a.md`.

**2026-01-13 — real-world incident pattern: prisma sql migrations prefix-then-star-then-suffix** [fx:good-prisma-sql]
<!-- trigger: tool=Edit|Write; repo=axervice-booking; path=prisma/*.sql -->
another actual incident pattern — prefix "prisma/" then a trailing-ish star before a literal
extension; must compile as legal.

**2026-01-14 — HIGH-4b canary: UTF-8 byte-length prefix, one char, three bytes** [fx:good-utf8-byte-prefix]
<!-- trigger: tool=Edit; repo=home; path=中* -->
2026-09-15 (guards/audits/CODEX-2026-09-15-glob-spec-review.md finding 8 / MED-8, and the HIGH-4b
"gate and engine must truly share one implementation" black-box test in pmm-core-selftest.cjs): "中"
is ONE JS string character (`.length === 1`) but THREE UTF-8 bytes. The B5 contract requires >=3
UTF-8 BYTES, not >=3 characters and not >=3 UTF-16 code units. If this repo's write-time B5 gate ever
forked its own local length check (e.g. `pattern.length >= 3` instead of delegating to the shared
`checkTriggerPathB5`/`compileTriggerPath`), THIS specific trigger would wrongly become B5 (1 < 3)
even though it is legal — must NOT be B5.

**2026-01-15 — HIGH-4b canary: the exact live multi-token glob pattern must be legal at the GATE too, not only in the engine** [fx:good-lock-glob-gate]
<!-- trigger: tool=Edit|Write; repo=axervice-booking; path=src/lib/**/*lock* -->
the runtime-engine side of this same pattern's HIGH-1 fix is proven end-to-end by
pmm-trigger-recall.sh --self-test cases 12/13 (spawned-process real match/no-match); this fixture is
the GATE-side half of the same black-box proof — if pmm-core.cjs's B5 diagnostic path ever stopped
delegating to the shared compileTriggerPath (e.g. reverted to the old two-way ternary, which cannot
even parse `**`), this exact live trigger would wrongly become B5 — must NOT be B5.
