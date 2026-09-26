#!/usr/bin/env bash
#
# guard ID: workflow-model-guard
#
# Invariant protected:
#   Every `agent(...)` call inside a script executed by Claude Code's
#   `Workflow` tool must carry an explicit `model:` key in that call's own
#   argument list (the object passed as the call's 2nd argument), and that
#   key's value must not be an empty string or "inherit". Rationale:
#   `agent-model-guard.sh` enforces this same invariant for the top-level
#   `Agent` tool, but `Workflow` scripts invoke `agent()` as an in-process JS
#   function call, NOT as a separate PreToolUse(Agent)-intercepted tool call
#   -- so agent-model-guard.sh never sees it. This is the exact gap that
#   caused the original incident: a desktop session ran an ECC-trio-review
#   workflow whose subagents never got an explicit model override, all
#   silently inherited the parent session's expensive model, and burned a
#   5-hour quota in 30 minutes. This guard REDUCES that gap by statically
#   parsing the Workflow script's source into a real JS AST before it runs.
#
#   ⚠️ Deliberately NOT claiming it "closes" the gap. A cross-model review
#   called that exact wording over-claiming while known holes remained, and
#   the registry's 声称纪律 clause forbids evidence-free summaries. This is
#   static single-file analysis: it cannot see through renamed imports,
#   eval, indirect calls (`const c = agent; c(...)`), `agent.call(...)`,
#   `(0, agent)(...)`, sequence expressions, or `agent()` living in a file
#   this script require/imports. Statically unresolvable model values are
#   allowed by design (over-blocking gets guards disabled). See README's
#   残余风险 column for the current, evidence-backed list.
#
# Enforcement point:
#   Claude Code PreToolUse hook, matcher = "Workflow". Reads the hook input
#   JSON ({"tool_name":"Workflow","tool_input":{...}}) from stdin and writes
#   a PreToolUse permission-decision JSON to stdout when denying. On allow,
#   it is completely silent (no stdout) and exits 0.
#
# History: this is a REWRITE (2026-08-02). The original version was a
# hand-rolled text scanner (bracket-matching + regexes over a string/comment
# "mask", no real parser). A cross-model review found it had both false
# negatives (nested `model:` in a sub-object counted as top-level, only one
# branch of a ternary needing a `model:` to pass, `model:` text inside a
# regex literal counted as a real key, a comment between `agent` and `(`
# defeated call-site detection, `agent?.(...)` optional calls not detected,
# duplicate `model:` keys resolved to the wrong (non-last) one, a
# comment/parens/escape/template-literal hiding a bad `'inherit'` value from
# the literal-value check) and false positives (a `function agent(){}`
# declaration mistaken for a call, shorthand `{ model }` / quoted `{'model':
# ...}` keys not recognized as the `model` key, an unrelated array spread
# like `tools:[...tools]` tripping the "any spread anywhere" check, a
# newline right after `obj.` defeating the "preceding char" call-site
# boundary check, and a regex literal containing a paren like `/\)/`
# desyncing the hand-rolled paren counter). All of these are structural
# consequences of parsing source text with regexes/bracket-counting instead
# of an actual JS parser, so the fix is to use one: this version parses the
# script with the vendored `acorn` parser (guards/vendor/acorn.js) into a
# real ESTree AST and answers every question above (call-site identity,
# comments, optional chaining, string/template/regex literal boundaries,
# argument shape, property-key identity, duplicate-key "last one wins"
# semantics, escape decoding) using the parser's own semantics instead of
# reimplementing a worse version of them by hand.
#
# What "script text" means here, in priority order (UNCHANGED from the
# original version):
#   1. tool_input.script       -- inline script source, used as-is.
#   2. tool_input.scriptPath   -- path to a script file, read from disk.
#   3. tool_input.name         -- a saved workflow name; resolved by walking
#      UP from process.cwd() through every parent directory's
#      .claude/workflows/<name>.{js,mjs,ts}, NEAREST PROJECT LAYER FIRST,
#      stopping AFTER (inclusive of) the directory that contains the git
#      repo root (a `.git` file or directory) or at the filesystem root if
#      no `.git` is ever found -- then, and only then, the resolved-home
#      layer's .claude/workflows/ (via pmm-home.sh's PMM_HOME_RESOLVED, see
#      the HOME-layer resolution code below) as the final fallback layer.
#      This mirrors Claude Code
#      2.1.178+'s real resolution order: nearest project file wins, project
#      always outranks home. (REWRITTEN 2026-08-02 -- see "Known
#      limitations" and the fix's own comment block at the call site for why
#      the OLD "home-first, single bare cwd" 2-root search was a security
#      hole, not just an accuracy gap.) If none of the candidate files at
#      any searched layer exist, the guard CANNOT verify the workflow and
#      denies (fail-closed) rather than guessing.
#   4. If none of script/scriptPath/name are present, the guard cannot
#      determine what will run and denies (fail-closed).
#
# Environment-variable gate (NEW in this rewrite):
#   If CLAUDE_CODE_SUBAGENT_MODEL is set to a non-empty (post-trim) string,
#   this guard denies EVERY Workflow tool call outright, before even
#   resolving/parsing the script. Rationale: that env var outranks any
#   per-call `model:` value inside the script (it overrides at dispatch
#   time), and Workflow's in-process `agent()` dispatch never passes through
#   agent-model-guard.sh's own PreToolUse(Agent) env-var check -- so if this
#   guard didn't also check it, a hazardous env var would go completely
#   unchecked on the Workflow path, silently making every literal `model:`
#   value inside the script meaningless. This check is unconditional (it
#   does not first check whether the script contains any `agent()` calls)
#   because the guard already cannot see through requires/imports/indirect
#   calls (see "Known limitations" below), so a blanket deny is the only
#   fail-closed option while that env var is active.
#
# Core check (real AST parse via vendored acorn, NOT a text/regex scanner):
#   1. Parse the script text with acorn (`ecmaVersion: 'latest'`,
#      `sourceType: 'module'`; on parse failure, retry once with
#      `sourceType: 'script'`; if BOTH fail, deny -- a script that doesn't
#      parse as either module or script has a genuine syntax error and would
#      fail at Workflow runtime too, so denying is correct, not a guard
#      limitation).
#   2. Walk the entire AST (generic recursive walk over every node/array
#      property, including inside ConditionalExpression branches and inside
#      the `.expression` of a ChainExpression, which is how acorn represents
#      optional calls like `agent?.(...)`) and collect every CallExpression
#      node whose `callee` is an `Identifier` with `name === 'agent'`. This
#      naturally excludes `function agent(){}` (a FunctionDeclaration, not a
#      CallExpression), `obj.agent(...)` / `obj.\nagent(...)` (callee is a
#      MemberExpression, not a bare Identifier, regardless of whitespace or
#      newlines between the dot and the name -- the parser tokenizes this
#      correctly no matter how it's formatted), and `myagent(...)` (a
#      different Identifier name). Comments between `agent` and `(` are
#      trivia to the parser and never affect this at all.
#   3. For each such call, classify its 2nd argument (`arguments[1]`):
#        - Missing entirely (`arguments.length < 2`) -> violation
#          (missing-model).
#        - `ObjectExpression` -> a SEQUENTIAL, ORDER-SENSITIVE left-to-right
#          scan of ONLY this object's own top-level `properties` (a nested
#          object like `{ metadata: { model: ... } }` does NOT count -- its
#          `model` is inside a nested ObjectExpression, never visited by
#          this step). Real JS object-literal semantics apply: a later key
#          or spread overwrites an earlier one at construction time, so
#          ORDER matters, not just presence. The scan tracks the CURRENT
#          "final model source" plus whether a spread/unknown-computed-key
#          has been seen SINCE that source was set (fixes 2026-08-02
#          cross-model review defects #1 spread-order and #2
#          computed-key-override, see "History" below):
#            - Top-level `SpreadElement` (`{...x}`) -> might supply/override
#              `model` at runtime -> sets a "pending override" flag. (A
#              spread nested INSIDE a property's own value, e.g.
#              `tools: [...tools]`, is not a top-level SpreadElement of THIS
#              object and never sets this.)
#            - A property whose key resolves to the name `model` --
#              `Property.key` is either a non-computed `Identifier` (covers
#              shorthand `{ model }` too), a non-computed `Literal` (covers
#              quoted `{ 'model': ... }`), OR a *computed* key (`{ [x]: ... }`)
#              whose own key expression is ITSELF statically resolvable to
#              the string `"model"` (a string `Literal` or a `TemplateLiteral`
#              with no `${...}` interpolation) -- becomes the new "final
#              model source" and CLEARS the pending-override flag: this key
#              is written after anything earlier, so real JS semantics say
#              it wins over them. If `model:` (or an equivalent resolvable
#              key) appears more than once, the LAST one in source order is
#              the final source -- matches real JS object-literal semantics.
#              EXCEPTION (2026-08-02 cross-model review defect #B, ADDED):
#              if this `model`-named property is an accessor
#              (`Property.kind === 'get'` or `'set'`) or a shorthand method
#              (`Property.method === true`, i.e. `{ model(){} }`), it is
#              handled SEPARATELY and denied UNCONDITIONALLY the moment it is
#              seen -- it never becomes a "final model source" candidate at
#              all, regardless of position relative to other `model:` keys.
#              Rationale: a setter-only property's runtime READ is always
#              `undefined`; a getter's return value lives inside a function
#              body and is not statically knowable; and critically, a getter
#              and a setter sharing the same key MERGE into a single accessor
#              property descriptor at runtime instead of the later one simply
#              overwriting the earlier one the way two plain data properties
#              would -- which breaks the "last plain key wins" ordering logic
#              every other branch here depends on. Over-blocking here (vs.
#              trying to reason precisely about get/set merge order) is the
#              deliberately chosen, safer tradeoff.
#            - A computed key whose expression is NOT statically resolvable
#              to a string (a variable `Identifier`, `MemberExpression`,
#              `CallExpression`, an interpolated template, a non-string
#              literal, ...) -- might evaluate to `"model"` and overwrite
#              the current final source -> same "pending override" flag as
#              a spread. A property whose key IS statically resolvable but
#              to some name OTHER than `"model"` is simply irrelevant and
#              touches neither flag.
#            - After the whole properties list has been scanned: no final
#              model source at all -> violation (missing-model). A final
#              source exists but the pending-override flag is still set
#              (a spread or an unknown computed key came AFTER it, with no
#              later resolvable `model:` clearing it again) -> violation
#              (spread-override / computed-override respectively -- a
#              spread/unresolvable-computed-key that comes BEFORE the final
#              `model:` is harmless, because the later explicit key
#              overwrites it anyway). Otherwise -> validate the final
#              source's VALUE (see step 4).
#        - `ConditionalExpression` (ternary) -> recursively classify BOTH
#          `consequent` and `alternate` the same way; the ternary as a whole
#          is only acceptable if BOTH branches are (nested ternaries recurse
#          further automatically). If either branch fails, that branch's
#          violation is reported.
#        - Anything else (`Identifier`, `MemberExpression`, `CallExpression`,
#          a non-object `Literal`, etc.) -> statically unresolvable ->
#          treated as acceptable (deliberately, to avoid over-blocking
#          legitimate `model: someComputedValue` code -- a text scanner
#          can't evaluate it and neither can a static AST pass, so denying
#          it would just teach people to hardcode strings or disable the
#          guard).
#   4. Validating the final `model` source's value: acorn has ALREADY
#      resolved parentheses (no `preserveParens` option is set, so
#      `('inherit')` parses to the exact same Literal node as `'inherit'`),
#      block/line comments (pure trivia, `model: /* c */ 'inherit'` parses
#      identically to `model: 'inherit'`), and escape sequences (a string
#      Literal's `.value` is the DECODED string, so `'inherit'` already
#      reads as `"inherit"` -- no separate unescaping step needed here).
#        - `Literal` with a string `.value` -> use that string; empty or,
#          case-insensitively/whitespace-trimmed, `'inherit'` -> violation
#          (bad-model-literal). Otherwise acceptable.
#        - `TemplateLiteral` with NO `${...}` expressions (`.expressions`
#          empty) -> same check against `quasis[0].value.cooked` (the
#          decoded text of a plain, non-interpolated template like
#          `` `inherit` ``).
#        - Any OTHER static `Literal` -- number (`0`), boolean (`false`),
#          `null` (acorn parses the `null` keyword as a `Literal` with
#          `value: null`), a regex, or a bigint -- is a statically-KNOWN
#          NON-STRING value -> violation (non-string-literal). This is
#          deliberately NOT treated as "unresolvable": an unresolvable value
#          would not be a `Literal` node in the first place, so a
#          non-string `Literal` is definitively invalid, matching
#          agent-model-guard.sh's own "must be a valid non-empty string"
#          contract (fixes 2026-08-02 cross-model review defect #3).
#        - `Identifier` named `undefined` -> same violation
#          (non-string-literal). `undefined` is not a keyword literal in JS
#          grammar (it parses as a plain `Identifier` referencing the
#          global), but it is just as statically-known-invalid as a literal
#          `null`/`false`/`0`, so it gets the same treatment rather than
#          falling into the "unresolvable -> allow" catch-all below.
#          KNOWN EDGE CASE (deliberately NOT special-cased, see 2026-08-02
#          cross-model review): if a script locally shadows the name
#          `undefined` as a parameter/variable (`function f(undefined) {
#          agent('x', { model: undefined }); }`), the runtime value at that
#          call site is actually whatever was passed as that shadowed
#          binding -- possibly a valid string -- yet this guard still denies,
#          because distinguishing "the global `undefined`" from "a locally
#          shadowed identifier that happens to be named `undefined`" requires
#          real scope resolution, not just a name check on an `Identifier`
#          node. This is treated as an acceptable false-positive (fail
#          toward over-blocking, not under-blocking) rather than a bug to
#          fix; the denial message tells the user how to work around it.
#        - `UnaryExpression` with `operator === 'void'` (i.e. `void 0`,
#          `void anything`) -> violation (static-invalid-value). `void <expr>`
#          always evaluates to the literal value `undefined` regardless of
#          `<expr>`, so this is exactly as statically-known-invalid as the
#          bare `undefined` identifier above, just spelled differently
#          (2026-08-02 cross-model review defect #B).
#        - `ObjectExpression`, `ArrayExpression`, `ArrowFunctionExpression`,
#          `FunctionExpression`, or `ClassExpression` -> violation
#          (static-invalid-value). These are all node types whose *kind* is
#          statically known and definitively NOT a string at the AST level --
#          `{}`, `[]`, `() => 'sonnet'`, `function(){}`, `class X {}` -- so
#          (like the non-string `Literal` case above) they are NOT treated as
#          "unresolvable"; an unresolvable value would not have one of these
#          concrete, non-string node types in the first place. This closes a
#          real false-negative the previous version of this guard had: these
#          five types used to fall through into the generic "anything else ->
#          unresolvable -> allow" catch-all below, silently passing
#          `model: {}` / `model: []` / `model: () => 'sonnet'` /
#          `model: function(){}` / `model: class X {}` (2026-08-02
#          cross-model review defect #B).
#        - Anything else (a real variable `Identifier` -- including
#          shorthand `{ model }`'s own value, which is a same-named
#          `Identifier` --, `MemberExpression`, `CallExpression`, a template
#          WITH interpolation, a value-position `ConditionalExpression`
#          ternary like `model: ok ? 'a' : 'b'`, etc.) -> statically
#          unresolvable -> acceptable, same rationale as step 3's catch-all.
#
# Fail-closed policy:
#   Any internal failure of this guard itself (stdin unreadable, JSON parse
#   failure, missing `node`, node crashing, script text unreadable, script
#   text unresolvable, script fails to parse under BOTH sourceType attempts,
#   or any other exception while walking the AST) MUST deny, never silently
#   allow. There is no "on error, exit 0 and let the call through" path in
#   this script by design.
#
# Known limitations / bypasses (out of scope to fix from inside this hook):
#   - Hooks disabled entirely (settings, --no-hooks-equivalent, or the
#     hooks config being removed/renamed).
#   - A different Claude Code config/settings directory that doesn't wire
#     this hook (project-local settings.json without the entry, or
#     CLAUDE_CONFIG_DIR pointed elsewhere).
#   - Direct use of the Claude Agent SDK / API, bypassing the CLI's hook
#     pipeline entirely.
#   - A saved, *named* workflow (tool_input.name) whose file cannot be
#     located at ANY searched layer -- every parent directory from cwd up to
#     and including the git repo root, then home -- under
#     .claude/workflows/{name}.js|.mjs|.ts, so it cannot be verified. This
#     guard denies it (fail-closed) rather than silently allowing an
#     unverifiable script to run.
#     (NOTE on .ts: the candidate list includes .ts only so that an existing
#      .ts file is FOUND and reported accurately rather than as "not found".
#      acorn parses JavaScript ONLY -- TypeScript syntax will fail to parse and
#      therefore deny. That is correct here: the Workflow tool documents its
#      scripts as "plain JavaScript, NOT TypeScript", so TS syntax would fail
#      at Workflow runtime too. This guard does NOT claim TypeScript support.)
#   - This is now a REAL parser (acorn/ESTree), not a text scanner, but it
#     still only sees the literal source of the resolved script. It cannot
#     see through indirection that moves the actual `agent(` token out of
#     that source entirely: `const call = agent; call(...)`, a renamed
#     import (`import { agent as invokeAgent } from '...'; invokeAgent(...)`),
#     `eval("agent(...)")`, dynamically built strings, or an `agent(...)`
#     call that lives inside a required/imported helper file are all
#     invisible to this guard, exactly as they would be to any purely static
#     single-file analysis.
#   - A `model:` value that is a variable, computed member access, function
#     call, or any other non-literal expression is deliberately treated as
#     PASSING (statically unresolvable != invalid) -- this is a conscious
#     over-blocking-avoidance tradeoff, not an oversight. Note this is
#     narrower than it sounds than it used to be: a *literal* value that is
#     statically known to be non-string (`null`/`false`/`0`/a bare
#     `undefined` identifier/`void 0`/regex/etc.) IS still denied (see step
#     4), and as of the 2026-08-02 defect-#B fix, so are the five node types
#     whose *kind* alone proves they aren't a string --
#     `ObjectExpression`/`ArrayExpression`/`ArrowFunctionExpression`/
#     `FunctionExpression`/`ClassExpression` (`{}`, `[]`, `() => 'x'`,
#     `function(){}`, `class X {}`) -- and any accessor/method spelling of
#     the `model` key itself (`{ model(){} }`, `{ get model(){} }`,
#     `{ set model(v){} }`), which are rejected even earlier, before value
#     validation even runs (see step 3's accessor/method exception). Only
#     genuinely unresolvable expressions (a real variable, member access,
#     call, interpolated template, value-position ternary) pass. A malicious
#     or buggy script could still exploit that remaining unresolvable case by
#     writing `model: (Math.random(), 'inherit')` or similar, but that is
#     indistinguishable from a legitimate computed model selector without
#     actually executing the script, which this guard does not do.
#   - Similarly, a top-level spread or an unresolvable computed key is only
#     disqualifying when it appears AFTER the final `model:` in source
#     order (see step 3); this guard has no way to know at what point in
#     the object's construction order the runtime spread SOURCE's own keys
#     would actually land relative to other keys beyond that ordering rule
#     -- it trusts standard left-to-right object-literal evaluation order,
#     which is the one thing JS itself guarantees here.
#
set -u

GUARD_ID="workflow-model-guard"

# Resolve this guard's own directory so it can find the vendored acorn
# parser regardless of the caller's cwd (the hook may be invoked with any
# working directory). Mirrors the pattern already used by
# workflow-model-guard.test.sh.
GUARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACORN_PATH="${GUARD_DIR}/vendor/acorn.js"

# Emit a PreToolUse deny decision and exit 0 (per the PreToolUse output
# protocol: the JSON on stdout carries the decision; the hook process
# itself is considered to have run successfully).
emit_deny() {
  local reason="$1"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

# Fail-closed helper: any error inside THIS script (not a normal policy
# deny) routes through here so it is unmistakably labeled as a guard
# malfunction rather than a normal policy rejection.
fail_closed() {
  emit_deny "守卫自身故障(${GUARD_ID}): $1 -- 已 fail-closed 拒绝本次 Workflow 调用,请检查 hook 环境或联系维护者。"
}

# node is required (no jq dependency per contract; project environment
# guarantees node is present). If it isn't, that's a guard malfunction.
command -v node >/dev/null 2>&1 || fail_closed "找不到 node 可执行文件"

[ -f "$ACORN_PATH" ] || fail_closed "找不到 vendored acorn 解析器(期望路径: ${ACORN_PATH})"

INPUT="$(cat)"

NODE_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/workflow-model-guard.XXXXXX.js" 2>/dev/null)" || fail_closed "无法创建临时解析脚本"
trap 'rm -f "$NODE_SCRIPT"' EXIT

cat > "$NODE_SCRIPT" <<'NODE_EOF'
const fs = require('fs');
const path = require('path');

// process.argv[2] is the absolute path to the vendored acorn parser,
// passed in by the bash wrapper (NOT hardcoded here) so this heredoc stays
// portable and doesn't need shell-side string interpolation into a
// single-quoted (non-expanding) heredoc. process.argv[3] is this guard's
// own directory (GUARD_DIR), used only to require pmm-recall-ledger.cjs's
// resolveHome() -- the ONE home-directory resolver (PMM_HOME > USERPROFILE
// > HOME > os.homedir()) -- instead of this script reading os.homedir()/
// process.env.HOME/process.env.USERPROFILE directly, which would otherwise
// be flagged by pipe-gate-v2-acceptance.cjs's self-check
// (part13_home_resolution_scan) as a direct read outside that one resolver.
const acorn = require(process.argv[2]);
const { resolveHome } = require(path.join(process.argv[3], 'pmm-recall-ledger.cjs'));

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

let raw;
try {
  raw = fs.readFileSync(0, 'utf8');
} catch (e) {
  deny('守卫自身故障(workflow-model-guard): 读取 stdin 失败(' + e.message + ') -- 已 fail-closed 拒绝本次 Workflow 调用。');
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  deny('守卫自身故障(workflow-model-guard): hook 输入 JSON 解析失败,疑似损坏 -- 已 fail-closed 拒绝本次 Workflow 调用。');
}

if (data === null || typeof data !== 'object' || Array.isArray(data)) {
  deny('守卫自身故障(workflow-model-guard): hook 输入不是 JSON 对象 -- 已 fail-closed 拒绝本次 Workflow 调用。');
}

const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input))
  ? data.tool_input
  : null;

if (toolInput === null) {
  deny('守卫自身故障(workflow-model-guard): hook 输入缺少 tool_input 字段 -- 已 fail-closed 拒绝本次 Workflow 调用。');
}

// ---------------------------------------------------------------------
// Step 0: environment-variable gate. CLAUDE_CODE_SUBAGENT_MODEL outranks
// any per-call `model:` literal inside the script (it overrides at
// dispatch time, same as agent-model-guard.sh's own check for the
// top-level Agent tool), and Workflow's in-process agent() dispatch never
// reaches agent-model-guard.sh's PreToolUse(Agent) hook -- so if this
// guard didn't check it too, the env var would go completely unchecked on
// this path. Unconditional: applies to every Workflow call while the env
// var is active, independent of what the script contains, because this
// guard cannot see through indirection (requires/imports/eval) anyway --
// see "Known limitations" in the header comment.
// ---------------------------------------------------------------------
const envModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
const envOverrideActive = (typeof envModel === 'string' && envModel.trim().length > 0); // MUTATION-TARGET:env-check
if (envOverrideActive) {
  deny('环境变量 CLAUDE_CODE_SUBAGENT_MODEL="' + envModel + '" 已设置,其优先级高于 Workflow 脚本内任何显式 model 字面量,且 Workflow 的 agent() 派发不经过 agent-model-guard 的同名检查 -- 已 fail-closed 拒绝本次 Workflow 调用。请先 unset CLAUDE_CODE_SUBAGENT_MODEL 再重新运行。');
}

// ---------------------------------------------------------------------
// Step 1: resolve the script source text, per the priority contract:
//   script (inline) > scriptPath (file) > name (saved workflow) > deny.
// (Unchanged from the pre-rewrite version.)
// ---------------------------------------------------------------------
let scriptSource = null;
let scriptOrigin = '';

if (typeof toolInput.script === 'string') {
  scriptSource = toolInput.script;
  scriptOrigin = 'tool_input.script (inline)';
} else if (typeof toolInput.scriptPath === 'string') {
  const p = toolInput.scriptPath;
  try {
    scriptSource = fs.readFileSync(p, 'utf8');
    scriptOrigin = 'tool_input.scriptPath="' + p + '"';
  } catch (e) {
    deny('守卫无法核验本次 Workflow 调用: tool_input.scriptPath="' + p + '" 读取失败(' + e.message + ') -- 已 fail-closed 拒绝(无法确认脚本是否含未指定 model 的 agent() 调用)。');
  }
} else if (typeof toolInput.name === 'string') {
  // ---------------------------------------------------------------------
  // SECURITY FIX (2026-08-02 cross-model review, defect #A): resolve named
  // workflows the same way Claude Code 2.1.178+ actually resolves them --
  // walk UP from process.cwd() through every parent directory's
  // .claude/workflows/, NEAREST PROJECT LAYER FIRST, stopping AFTER
  // (inclusive of) the directory containing the git repo root (a `.git`
  // FILE or directory -- a file covers submodules/worktrees, not just a
  // plain repo) or at the filesystem root if no `.git` is ever found. ONLY
  // THEN fall back to the resolved-home layer's .claude/workflows/ (home).
  //
  // The OLD version checked exactly two roots -- home FIRST, then a single
  // bare process.cwd() -- which was a genuine bypass, not just an accuracy
  // gap: if a nested project directory had its own noncompliant
  // .claude/workflows/<name>.js (missing `model:`) while a same-named file
  // under the resolved-home layer's .claude/workflows/ happened to be
  // compliant, this guard would
  // resolve and validate the HOME copy, find it clean, and ALLOW -- while
  // the Workflow tool itself resolves project-over-home from the actual
  // cwd and would RUN the noncompliant project file instead. Validating a
  // different file than the one that executes is a fail-open hole.
  // ---------------------------------------------------------------------
  const startDir = path.resolve(process.cwd());
  const fsRootPath = path.parse(startDir).root;
  const projectRoots = [];
  {
    let dir = startDir;
    // Bounded loop as a belt-and-suspenders safety net (a real directory
    // tree is nowhere close to this deep) so a pathological filesystem
    // (e.g. a symlink cycle that defeats the root/parent checks below)
    // can never spin this forever.
    for (let i = 0; i < 1024; i++) {
      projectRoots.push(path.join(dir, '.claude', 'workflows'));
      let isRepoRoot = false;
      try {
        isRepoRoot = fs.existsSync(path.join(dir, '.git'));
      } catch (e) {
        isRepoRoot = false;
      }
      if (isRepoRoot) break; // include this layer (already pushed above), then stop climbing
      if (dir === fsRootPath) break; // hit the filesystem root; nowhere left to climb
      const parent = path.dirname(dir);
      if (parent === dir) break; // Windows drive-root safety net: dirname("C:\\") === "C:\\"
      dir = parent;
    }
  }
  const home = resolveHome();
  const homeRoot = path.join(home, '.claude', 'workflows');
  // Nearest-project-first, then home; de-duplicated (e.g. cwd already lives
  // inside the home tree with no `.git` in between) purely so the candidate
  // list in the deny message below doesn't repeat the same path twice --
  // resolution order is unaffected either way since the first EXISTING
  // candidate always wins.
  const seenRoots = new Set();
  const roots = [];
  for (const r of projectRoots.concat([homeRoot])) {
    if (!seenRoots.has(r)) { seenRoots.add(r); roots.push(r); }
  }
  const exts = ['.js', '.mjs', '.ts'];
  const candidates = [];
  for (const root of roots) {
    for (const ext of exts) candidates.push(path.join(root, toolInput.name + ext));
  }
  let found = null;
  for (const cand of candidates) {
    let exists = false;
    try { exists = fs.existsSync(cand); } catch (e) { exists = false; }
    if (exists) { found = cand; break; }
  }
  if (!found) {
    deny('守卫无法核验具名 workflow "' + toolInput.name + '": 从当前目录逐级向上到仓库根(含)、再到 home,所有层级的 .claude/workflows/ 下都未找到 .js/.mjs/.ts(按搜索顺序尝试过: ' + candidates.join(', ') + ') -- 已 fail-closed 拒绝本次 Workflow 调用。请改用 script/scriptPath 传参,或联系维护者更新解析路径。');
  }
  try {
    scriptSource = fs.readFileSync(found, 'utf8');
    scriptOrigin = 'name="' + toolInput.name + '" -> ' + found;
  } catch (e) {
    deny('守卫无法核验本次 Workflow 调用: 已定位到 workflow 文件 "' + found + '" 但读取失败(' + e.message + ') -- 已 fail-closed 拒绝。');
  }
} else {
  deny('守卫无法核验本次 Workflow 调用: tool_input 中既无 script,也无 scriptPath,也无 name 字段 -- 已 fail-closed 拒绝(无法确认脚本是否含未指定 model 的 agent() 调用)。');
}

// ---------------------------------------------------------------------
// Step 2: parse the script text into a real AST. Try sourceType:'module'
// first (Workflow scripts commonly use ESM import/export); if that fails,
// retry once with sourceType:'script'. If BOTH fail, the script has a
// genuine syntax error and would fail at Workflow runtime too, so denying
// is the correct outcome, not a guard limitation.
// ---------------------------------------------------------------------
const PARSE_OPTS_BASE = {
  ecmaVersion: 'latest',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  locations: true,
};

let ast = null;
let parseErrors = [];
for (const sourceType of ['module', 'script']) {
  try {
    ast = acorn.parse(scriptSource, Object.assign({}, PARSE_OPTS_BASE, { sourceType }));
    break;
  } catch (e) {
    parseErrors.push(sourceType + ': ' + e.message);
  }
}

if (ast === null) {
  deny('Workflow 脚本(' + scriptOrigin + ')解析失败,以 module 与 script 两种 sourceType 均无法解析为合法 JavaScript(' + parseErrors.join('; ') + ') -- 已 fail-closed 拒绝。⚠️ 解析器是 acorn,**只支持 JavaScript、不支持 TypeScript 语法**;Workflow 工具本身也规定脚本是 plain JavaScript(NOT TypeScript),所以 TS 语法在 Workflow 运行时同样会失败。真语法错 → 修;写了 TS 语法 → 改成 JS。');
}

// ---------------------------------------------------------------------
// Step 3: walk the whole AST and collect every `agent(...)` call site --
// a CallExpression whose callee is a bare Identifier named "agent". This
// generic walk visits every node/array property (including inside
// ConditionalExpression branches, and inside a ChainExpression's
// `.expression`, which is how acorn represents optional calls like
// `agent?.(...)`), so it finds call sites regardless of nesting depth,
// comments, or whitespace/newline formatting between tokens -- none of
// that is visible to a real parser's AST in the first place.
// ---------------------------------------------------------------------
function findAgentCalls(root) {
  const found = [];
  const seen = new Set();
  function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (seen.has(node)) return; // guard against any unexpected cyclic refs
    seen.add(node);
    if (typeof node.type === 'string' &&
        node.type === 'CallExpression' &&
        node.callee && node.callee.type === 'Identifier' &&
        node.callee.name === 'agent') {
      found.push(node);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
      const val = node[key];
      if (val && typeof val === 'object') visit(val);
    }
  }
  visit(root);
  return found;
}

// ---------------------------------------------------------------------
// Step 4: classify one ObjectExpression (a candidate `agent(...)` options
// object) against the "top-level model key resolves, nothing after it can
// statically override it, value is a valid non-empty model string" invariant.
// Only node.properties (this object's OWN top-level entries) are inspected --
// a nested object's `model` never counts, matching the contract's "只看顶层
// 属性" rule.
//
// This is a SEQUENTIAL, ORDER-SENSITIVE scan (real JS object-literal
// semantics: later keys/spreads win over earlier ones at construction time),
// not a "does this object contain X anywhere" check. It tracks the CURRENT
// final `model` source as it walks left-to-right, plus whether a spread or
// an unknown computed key has been seen SINCE that final source was set:
//   - A top-level SpreadElement, or a computed key whose name can't be
//     resolved statically ({[x]: v}), might supply/override `model` at
//     runtime -- it only matters if it comes AFTER the model key that would
//     otherwise be final; one appearing BEFORE a later explicit `model:` is
//     harmless, because the later explicit key overwrites it anyway.
//   - A key statically known to resolve to the name "model" (non-computed
//     Identifier/shorthand, non-computed quoted Literal, OR a computed key
//     whose own key expression is itself a static string Literal / a
//     non-interpolated TemplateLiteral) becomes the new final source and
//     clears any pending spread/computed-override flag -- it supersedes
//     whatever might have overridden an earlier source.
// After the scan: no final source at all -> missing-model. A final source
// exists but a spread/unknown-computed-key is still pending after it ->
// spread-override / computed-override (it might clobber the value we'd
// otherwise validate). Otherwise, validate the final source's value.
// ---------------------------------------------------------------------
function resolveKeyName(prop) {
  // Returns { resolved: true, name } when the property's key can be
  // determined WITHOUT executing the script, or { resolved: false } when it
  // can't (this is the "unknown computed key" case for computed keys; for
  // non-computed keys, acorn only ever produces Identifier or Literal key
  // nodes for ObjectExpression properties, so those always resolve).
  const key = prop.key;
  if (!prop.computed) {
    if (key.type === 'Identifier') return { resolved: true, name: key.name }; // plain `model:` AND shorthand `{ model }`
    if (key.type === 'Literal') return { resolved: true, name: String(key.value) }; // quoted `{ 'model': ... }`
    return { resolved: false };
  }
  // Computed key ({[expr]: v}): only a string Literal or a non-interpolated
  // TemplateLiteral can be resolved to a name WITHOUT running the script.
  // A variable Identifier, MemberExpression, CallExpression, an
  // interpolated template, a non-string literal, etc. are NOT statically
  // resolvable -- they might evaluate to "model" and we can't know.
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return { resolved: true, name: key.value };
  }
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) {
    return { resolved: true, name: key.quasis[0].value.cooked };
  }
  return { resolved: false };
}

function normalizeIfBadModelString(str) {
  const norm = str.trim().toLowerCase();
  if (norm === '' || norm === 'inherit') return { ok: false, kind: 'bad-model-literal' }; // MUTATION-TARGET:bad-literal-check
  return { ok: true };
}

// Node types whose *kind* alone proves, statically, that the value can
// never be a string at runtime: `{}`, `[]`, `() => 'x'`, `function(){}`,
// `class X {}`. Added 2026-08-02 (cross-model review defect #B) -- these
// five used to fall through into the generic "unresolvable -> allow"
// catch-all at the bottom of validateModelValue(), silently passing things
// like `model: {}` or `model: () => 'sonnet'`.
const STATIC_INVALID_VALUE_TYPES = new Set([
  'ObjectExpression',
  'ArrayExpression',
  'ArrowFunctionExpression',
  'FunctionExpression',
  'ClassExpression',
]);

function validateModelValue(val) {
  // acorn has ALREADY resolved parentheses (no `preserveParens` option, so
  // `('inherit')` parses to the exact same Literal node as `'inherit'`),
  // block/line comments (pure trivia), and escape sequences (a string
  // Literal's `.value` is the DECODED string).
  if (val.type === 'Literal' && typeof val.value === 'string') {
    return normalizeIfBadModelString(val.value);
  }
  if (val.type === 'TemplateLiteral' && val.expressions.length === 0) {
    return normalizeIfBadModelString(val.quasis[0].value.cooked); // plain `` `text` ``, no ${...}
  }
  if (val.type === 'Literal') {
    // Any OTHER static Literal -- number (`0`), boolean (`false`), `null`
    // (acorn parses the `null` keyword as Literal value:null), regex, or
    // bigint -- is a statically-known NON-STRING value. This is
    // definitively invalid (agent-model-guard.sh's own contract requires a
    // valid non-empty STRING), not "unresolvable" -- an unresolvable value
    // would not be a Literal node in the first place.
    return { ok: false, kind: 'non-string-literal' }; // MUTATION-TARGET:non-string-literal-check
  }
  if (val.type === 'Identifier' && val.name === 'undefined') {
    // `undefined` is not a keyword literal in JS grammar -- it parses as a
    // plain Identifier referencing the global -- but it IS a
    // statically-known invalid value, same treatment as literal
    // null/false/0, not the "unresolvable -> allow" catch-all below.
    // KNOWN EDGE CASE (deliberately not special-cased, see header comment):
    // a locally-shadowed `undefined` binding (`function f(undefined) {...}`)
    // is indistinguishable from the real global at this static-name-only
    // check, so it is denied too -- fail toward over-blocking, not under.
    return { ok: false, kind: 'non-string-literal' }; // MUTATION-TARGET:undefined-identifier-check
  }
  if (val.type === 'UnaryExpression' && val.operator === 'void') {
    // `void <anything>` always evaluates to the literal value `undefined`,
    // regardless of the operand -- exactly as statically-known-invalid as
    // the bare `undefined` Identifier above, just spelled differently
    // (2026-08-02 cross-model review defect #B).
    return { ok: false, kind: 'static-invalid-value' }; // MUTATION-TARGET:void-check
  }
  if (STATIC_INVALID_VALUE_TYPES.has(val.type)) {
    // {}, [], () => 'x', function(){}, class X {} -- see
    // STATIC_INVALID_VALUE_TYPES comment above (2026-08-02 cross-model
    // review defect #B).
    return { ok: false, kind: 'static-invalid-value' }; // MUTATION-TARGET:static-invalid-type-check
  }
  // Everything else (a real variable Identifier, MemberExpression,
  // CallExpression, an interpolated template, a value-position
  // ConditionalExpression ternary, shorthand `{ model }`'s own value
  // Identifier, ...) is statically unresolvable and treated as acceptable
  // (deliberately, to avoid over-blocking legitimate
  // `model: someComputedValue` code).
  return { ok: true };
}

function checkObjectExpression(node) {
  let finalModelProp = null;
  let spreadPending = false;
  let computedPending = false;

  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') {
      // Might supply/override `model` when the object is actually built.
      // Only disqualifying if it ends up AFTER the final model source (see
      // the "cleared below" step) -- checked once the whole object has been
      // walked, not here.
      spreadPending = true; // MUTATION-TARGET:spread-pending-set
      continue;
    }
    // prop.type === 'Property' (the only other member type ObjectExpression
    // properties can have).
    const resolved = resolveKeyName(prop);
    if (!resolved.resolved) {
      // Unknown computed key ({[x]: v}, x not statically knowable) -- same
      // "might override" reasoning as a spread.
      computedPending = true; // MUTATION-TARGET:computed-pending-set
      continue;
    }
    if (resolved.name !== 'model') {
      // Definitely NOT named "model" (whether a plain key or a
      // statically-resolved computed key) -- irrelevant to model tracking,
      // does not touch the pending-override flags either way.
      continue;
    }
    // Statically known to BE the "model" key.
    if (prop.kind === 'get' || prop.kind === 'set' || prop.method === true) {
      // ACCESSOR/METHOD SPECIAL CASE (2026-08-02 cross-model review defect
      // #B) -- handled separately from the normal "final source" tracking
      // below, and denied UNCONDITIONALLY the instant it's seen, regardless
      // of position relative to other `model:` keys in this same object.
      // Rationale: a setter-only property's runtime READ is always
      // `undefined`; a getter's return value lives inside a function body
      // and is not statically knowable; and a getter+setter pair sharing
      // this key would MERGE into a single accessor property descriptor at
      // runtime instead of the later one simply overwriting the earlier one
      // -- which would break the "last plain key wins" ordering logic this
      // whole function otherwise relies on. Covers `{ model(){} }` (method
      // shorthand), `{ get model(){...} }`, and `{ set model(v){...} }`.
      return { ok: false, kind: 'accessor-or-method' }; // MUTATION-TARGET:accessor-or-method-check
    }
    // A normal (non-accessor, non-method) `model:` property. Becomes the
    // new final model source (real JS object-literal "last one wins" order)
    // and clears any pending spread/computed-override flag: this key is
    // written AFTER whatever came before it, so it supersedes any earlier
    // uncertainty.
    finalModelProp = prop;
    spreadPending = false;
    computedPending = false;
  }

  if (!finalModelProp) return { ok: false, kind: 'missing-model' }; // MUTATION-TARGET:missing-model-check-object
  if (spreadPending) return { ok: false, kind: 'spread-override' }; // MUTATION-TARGET:spread-override-check
  if (computedPending) return { ok: false, kind: 'computed-override' }; // MUTATION-TARGET:computed-override-check

  return validateModelValue(finalModelProp.value);
}

// ---------------------------------------------------------------------
// Step 5: classify an `agent(...)` call's 2nd argument (the "options"
// position). Recurses through ConditionalExpression branches (both sides
// must qualify); treats anything else that isn't an ObjectExpression as
// statically unresolvable and therefore acceptable, per the
// over-blocking-avoidance policy documented in the header comment.
// ---------------------------------------------------------------------
function classifyOptionsArg(argNode) {
  if (!argNode) return { ok: false, kind: 'missing-model' }; // MUTATION-TARGET:missing-model-check-arity
  if (argNode.type === 'ObjectExpression') {
    return checkObjectExpression(argNode);
  }
  if (argNode.type === 'ConditionalExpression') {
    const consequentResult = classifyOptionsArg(argNode.consequent);
    const alternateResult = classifyOptionsArg(argNode.alternate);
    if (!consequentResult.ok) return consequentResult; // MUTATION-TARGET:ternary-consequent-check
    if (!alternateResult.ok) return alternateResult; // MUTATION-TARGET:ternary-alternate-check
    return { ok: true };
  }
  // Identifier / MemberExpression / CallExpression / non-object Literal /
  // etc. -- statically unresolvable, allow.
  return { ok: true };
}

function preview60(source, idx) {
  return source.slice(idx, idx + 60).replace(/\r?\n/g, ' ');
}

function describeViolation(callNode, result, source) {
  const line = callNode.loc.start.line;
  const preview = preview60(source, callNode.start);
  if (result.kind === 'missing-model') {
    return '第' + line + '行: agent(...) 调用缺少 model(前60字符: "' + preview + '") -- 请加 { model: \'sonnet\' }(机械活)或 { model: \'opus\' }(高风险审查)';
  }
  if (result.kind === 'bad-model-literal') {
    return '第' + line + '行: agent(...) 的 model 字面量是空串或 "inherit"(前60字符: "' + preview + '") -- 这等同于不指定,会继承主会话贵模型。请改成 \'sonnet\'/\'opus\'/\'haiku\' 等具体模型';
  }
  if (result.kind === 'non-string-literal') {
    return '第' + line + '行: agent(...) 的 model 是静态已知的非字符串值(null/false/0/undefined 等,前60字符: "' + preview + '") -- model 必须是非空字符串,例如 \'sonnet\'。若这里的 undefined 其实是被局部遮蔽的变量(例如 function f(undefined){...}),请改用显式字符串以避免被拒';
  }
  if (result.kind === 'static-invalid-value') {
    return '第' + line + '行: agent(...) 的 model 是静态可判定为无效的值(对象字面量/数组字面量/箭头函数/普通函数/class,或 void 0,前60字符: "' + preview + '") -- model 必须是非空字符串字面量,例如 \'sonnet\'';
  }
  if (result.kind === 'accessor-or-method') {
    return '第' + line + '行: agent(...) 参数对象的 model 键是 getter/setter 或方法简写(如 { model(){} } / { get model(){} } / { set model(v){} },前60字符: "' + preview + '") -- 其运行时值无法静态判定(setter 读回恒为 undefined,getter 返回值取决于函数体,且 get+set 会合并成同一个 accessor descriptor,破坏"最后一个键获胜"的假设),请改成普通字符串字面量键,例如 model: \'sonnet\'';
  }
  if (result.kind === 'spread-override') {
    return '第' + line + '行: agent(...) 参数对象中,对象展开(...)出现在最终生效的 model 键之后,运行时可能覆盖它(前60字符: "' + preview + '") -- 请把展开挪到 model 之前,或在展开之后重新显式写一次 model';
  }
  if (result.kind === 'computed-override') {
    return '第' + line + '行: agent(...) 参数对象中,一个静态无法解析的 computed key([x]: ...)出现在最终生效的 model 键之后,运行时可能覆盖它(前60字符: "' + preview + '") -- 请把它挪到 model 之前,或在其之后重新显式写一次 model';
  }
  return '第' + line + '行: 未知问题(前60字符: "' + preview + '")';
}

let violations;
try {
  const calls = findAgentCalls(ast);
  violations = [];
  for (const call of calls) {
    const result = classifyOptionsArg(call.arguments[1]);
    if (!result.ok) {
      violations.push(describeViolation(call, result, scriptSource));
    }
  }
} catch (e) {
  deny('守卫自身故障(workflow-model-guard): 解析脚本内 agent() 调用时异常(' + e.message + ') -- 已 fail-closed 拒绝本次 Workflow 调用。');
}

if (violations.length > 0) {
  deny('Workflow 脚本(' + scriptOrigin + ')内的 agent() 调用未显式核验 model,agent-model-guard 拦截不到 Workflow 内部调用,会绕过并继承主会话贵模型(曾 30min 烧光 5h 配额): ' + violations.join('; '));
}

// ─────────────────────────────────────────────────────────────────────────
// 派工配比:报账(每次) + 无便宜档时问一次(每个上下文窗口)
//
// 2026-08-06。由来:一个会话今天派出 15 个 agent,**全是 opus+high,零 sonnet**,
// 而按路由至少三分之一(勘察/枚举调用点/贴输出/跑变异体)是 sonnet 的活。
// 它 model: 全写了 —— 本守卫要求的它都做到了。**堵住的是「静默继承」,没堵住「显式选错」。**
// 它自己的诊断:把「别默认自己写」执行成了「别默认自己写,但默认 Opus」。
//
// 两半强弱不同,别搞反:
//   报账(强):模型/effort 由机器从 AST 读,不经我转述,没有糊弄空间,最终到 the maintainer 眼前。
//             今天纠正这件事的正是这条链 —— 那边报了账,the maintainer 看到数字,当场驳回。
//   问一次(弱):问的是判断题,而**任何一种派法都能满足它**(随便拍一个 sonnet 就过)。
//             与今天被否掉的「阻断式提问」同形态:机器能强制提问,强制不了正确答案。
//             留着因为它便宜、且糊弄动作至少真降一档;**但它不是主力。**
//
// 「每个上下文窗口一次」而非「每会话一次」:这条干预依赖「那张表留在上下文里」,
// 压缩会让表消失而状态还在 = 两头落空。故 SessionStart(含 compact)清状态。
// 已知残余:长会话后段上下文稀释,表在但影响力降 —— 无干净修法,如实记着。
// ─────────────────────────────────────────────────────────────────────────
function litOf(objNode, wanted) {
  if (!objNode || objNode.type !== 'ObjectExpression') return null;
  var val = null;
  for (var i = 0; i < objNode.properties.length; i++) {
    var prop = objNode.properties[i];
    if (!prop || prop.type !== 'Property' || prop.computed) continue;
    var k = prop.key;
    var name = (k && k.type === 'Identifier') ? k.name
             : (k && k.type === 'Literal') ? String(k.value) : null;
    if (name !== wanted) continue;
    if (prop.value && prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
      val = prop.value.value;      // 后出现的同名键覆盖前者,与运行时一致
    } else {
      val = null;                  // 动态值:报账显示 ?,不假装知道
    }
  }
  return val;
}

try {
  var mixCalls = findAgentCalls(ast);
  if (mixCalls.length > 0) {
    var rows = mixCalls.map(function (c, i) {
      var o = c.arguments[1];
      return {
        label:  litOf(o, 'label')  || ('#' + (i + 1)),
        model:  litOf(o, 'model')  || '?',
        effort: litOf(o, 'effort') || '(默认)'
      };
    });
    var w = 0;
    rows.forEach(function (r) { if (r.label.length > w) w = r.label.length; });
    var lines = rows.map(function (r) {
      return '   ' + r.label + new Array(w - r.label.length + 1).join(' ') + '  ' + r.model + ' / ' + r.effort;
    });
    var tally = {};
    rows.forEach(function (r) { tally[r.model] = (tally[r.model] || 0) + 1; });
    var summary = Object.keys(tally).sort().map(function (m) { return tally[m] + '× ' + m; }).join(' · ');
    // 静态解不出的 model(简写 { model }、变量、三元…)= **无法判断,不问**。
    // 依据是本文件开头写死的设计哲学:「Statically unresolvable model values are allowed
    // by design (over-blocking gets guards disabled)」。第一版把 '?' 当成「非便宜档」去问,
    // 立刻让既有用例 fp2(shorthand { model })从 allow 变 deny —— 我违反了本守卫自己的哲学,
    // 而且那正是「误拦 → 守卫被整条删掉」的起点。报账里仍照实显示 '?'(那是信息,不是判断)。
    var anyUnresolved = rows.some(function (r) { return r.model === '?'; });
    var hasCheap = anyUnresolved || rows.some(function (r) { return /^(sonnet|haiku)/i.test(r.model); });

    // ── 精确层(2026-08-06):标签明说是机械活,却派了贵档 = 具体可核验的错 ──
    // 为什么它能「每次都拦」而下面那层不能:它响的时候一定有一个具体的东西要改
    // (点名哪个 agent、改成什么),只有一个正确修法 —— 与今天拦我 5 次都被我修了根因的
    // 那些检查同形态(Index 28≠29 只有一种改法)。模糊判断题才会被糊弄成仪式。
    // 词表**刻意保守**:只收一眼可辨的机械动词。verify/build/read 等可能含判断,**不收**
    // —— 误拦比漏拦危险,宁可漏掉几个也别让它变成会被整条删掉的东西。
    // 已知绕过:改标签就能躲。但那是**刻意**动作,而真实失败模式是「图省事,全填一个模型」,
    // 改名比直接改对更费事 —— 挡懒,不挡有意为之。
    var MECH = /(scout|勘察|探查|recon|survey|extract|提取|抽取|enumerate|枚举|list|列举|清点|inventory|count|计数|grep|locate|定位|collect|收集|dump|贴输出|paste)/i;
    var EXPENSIVE = /^(opus|fable)/i;
    var misfits = rows.filter(function (r) { return MECH.test(r.label) && EXPENSIVE.test(r.model); });
    if (misfits.length > 0) {
      deny(
        '⛔ 派工配比:' + misfits.length + ' 个机械活派了贵档 —— 改完再发\n\n' +
        misfits.map(function (r) {
          return '   ' + r.label + '  ' + r.model + ' / ' + r.effort + '   ← 标签是机械活,应为 sonnet(或 haiku)+ xhigh';
        }).join('\n') + '\n\n' +
        '本工作流全部 ' + rows.length + ' 个:\n' + lines.join('\n') + '\n\n' +
        '判据:勘察 · 枚举调用点 · 提取 · 清点 · 定位 · 贴输出 = 判据明确、自足、可验证 → sonnet\n' +
        '      技术深审(钱/并发/租户/schema)→ opus;框架与元层判断 → fable\n' +
        '      haiku/sonnet 一律 xhigh(思考便宜,买的正是它们最容易出错的地方)\n\n' +
        '若这个标签其实不是机械活,改个名字说清它在判断什么 —— 标签是给人读的,不是给守卫读的。'
      );
    }

    var home = resolveHome();
    // 2026-08-23 修复(计一次自修 strike):stamp 原为全机一个文件,多会话并行时
    // 任一会话消耗掉「问一次」,其它会话的全贵档派发就静默放行 —— the maintainer 实测「守卫没工作」
    // 的根因。改为按 session_id 分文件;无 session_id(测试夹具/旧输入)回退旧名,套件不受影响。
    // 过期清扫在 pmm-autopull(SessionStart):本会话戳 + >2 天的孤儿戳。
    var _sid = (typeof data === 'object' && data && typeof data.session_id === 'string')
      ? data.session_id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) : '';
    var stampPath = home + '/.claude/.wf-model-asked' + (_sid ? '-' + _sid : '');
    var asked = false;
    try { asked = fs.existsSync(stampPath); } catch (e) { asked = false; }

    if (!hasCheap && !asked) {
      try { fs.writeFileSync(stampPath, 'asked'); } catch (e) { /* 写不了就下次再问,不阻断 */ }
      deny(
        '⛔ 派工配比:' + rows.length + ' 个 agent 全无便宜档(' + summary + ')—— 逐阶段过一次再发\n\n' +
        lines.join('\n') + '\n\n' +
        '选模型(只需决定这一件,effort 由档位+角色自动定):\n' +
        '   haiku   xhigh   取值 · 数数 · 列文件 · 查存在 · 跑命令贴输出\n' +
        '   sonnet  xhigh   勘察 · 枚举调用点 · 机械核验 · 红绿测试 · 按规格建码\n' +
        '   opus            技术深审:钱路 · 并发/幂等 · 租户/鉴权 · schema · 时区\n' +
        '   fable           框架与元层:值不值 · 论证成不成立 · 盲区在哪 · 有无既得利益\n' +
        '       high  = 按清单核对(知道要找什么)\n' +
        '       xhigh = 找没人想到的东西 / 不可逆(合主干·上生产)/ 已复发过\n\n' +
        '红线(给多少 effort 都不下放):要跨源综合 · 要判对错 · 要分清「找不到 vs 不存在」\n\n' +
        '为什么拦(真实代价,不是劝诫):\n' +
        '   2026-07-16 子代理没显式降档 → 30 分钟烧光 5 小时配额,两条在途工作线全被打死。\n' +
        '   2026-08-06 一个会话 15 个 agent 全 opus+high,其中至少 4 个该是 sonnet。\n\n' +
        '确认这些阶段都需要判断力 → 原样重发即可,不必改。本上下文窗口只拦这一次。'
      );
    }

    // 报账:走 stderr(本文件上方已注明 stderr 由 Claude Code 单独呈现、不参与 JSON 协议)
    process.stderr.write('派工配比 ' + summary + '\n' + lines.join('\n') +
      '\n(汇报时带上这张表 + 完成后的 token 数)\n');
  }
} catch (e) {
  // 报账/问话出问题绝不阻断正常派发 —— 它是附加功能,不是本守卫的核心不变量
}

// allow: silent, no stdout, exit 0
process.exit(0);
NODE_EOF

# NOTE: stdout ONLY. Do NOT merge stderr (2>&1) into OUTPUT -- stdout carries
# the PreToolUse JSON protocol, and any node stderr noise (deprecation
# warnings, ExperimentalWarning, etc.) would be echoed as if it were protocol
# output and corrupt the JSON. stderr flows to the hook's own stderr, which
# Claude Code surfaces separately without parsing it. (agent-model-guard.sh
# already hit this; same fix applied here up front.)
OUTPUT="$(printf '%s' "$INPUT" | node "$NODE_SCRIPT" "$ACORN_PATH" "$GUARD_DIR")"
NODE_EXIT=$?

if [ "$NODE_EXIT" -ne 0 ]; then
  fail_closed "node 解析脚本异常退出(exit code=${NODE_EXIT})"
fi

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi

exit 0
