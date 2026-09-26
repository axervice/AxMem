#!/usr/bin/env node
// 触发式召回(窄试点,2026-09-13,codex 评审 P1,the maintainer 批[memory:push-sediment-design-v2])
// 不变量:PostToolUse(Edit/Write/MultiEdit/NotebookEdit) 时,被改文件命中某条教训的
//   `<!-- trigger: tool=…; repo=…; path=… -->` 元数据 → 注入该教训**标题行**(绝不注全文)。
// 铁律(codex 评审逐条落实):
//   - trigger 是独立元数据;artifact=证据位置,绝不当触发范围([pmm:artifact-is-evidence-not-trigger-scope])
//   - 跨机匹配用 repo-id + repo 相对 POSIX 路径;禁 basename/后缀兜底(低召回变跨仓误报)
//   - 每事件 ≤3 条,同会话同 tag 只推一次;链路分段计量,禁用含糊 hit
//   - fail-open:本机制是提醒不是闸,任何内部错误静默放行(telemetry 记 error)
// 止损(预注册):≥30 个人工标注样本(≥10 会话/≥5 trigger)后判;精确率<80% 砍;用户嫌吵立停。
//
// 确定性契约(2026-09-17,Opus 在验证「无 policy 时输出逐字节不变」时发现:同一事件+同一 session,
// 两个全新 PMM_RECALL_ROOT 却选中完全不相交的三条教训;已复现并查清,记录于此,连同自测「两个全新
// root+同输入⇒同输出」一并入册)——推送选择依赖且只依赖以下几处**磁盘状态**,均是刻意设计而非缺陷:
//   1. `.trigger-seen-<session>`(PMM_TRIGGER_STATE,默认 `PMM_HOME + '/.claude'`,与 PMM_RECALL_ROOT
//      是两个完全独立的目录):「同会话同 tag 只推一次」的去重记录。**这正是复现到的根因**——测试只
//      换了 PMM_RECALL_ROOT(它只决定 v3 台账落盘位置,从未被读回做选择判断),没有同步换
//      PMM_TRIGGER_STATE/PMM_HOME;同一 session 两次调用时,第二次会把第一次已推的 tag 当"已见"而
//      跳过,换上排位更靠后的候选去填满 3 条名额——两组结果因此完全不相交,但这是设计好的会话内
//      去重,不是不确定性。
//   2. `PMM_TRIGGER_MEM` 语料本身(lessons.md/decisions.md/standinginstructions.md 等):若语料在两次
//      调用之间被改写,匹配/排序结果自然不同。
//   3. `policy.json`(经 pmm-recall-policy.cjs,位于 PMM_RECALL_ROOT 下):只影响 mode/run_provenance
//      列与「class 被随机到 shadow 臂时是否显示」,不影响候选匹配/排序本身;两个全新 root 若都没有
//      policy.json,两次调用的 policy 分支完全等价(均 provenance=policy:absent)。
//   除以上三处外,匹配、取代链跳转、关联携带、类成员携带、cap 排序全部是纯函数(给定同一 MEM 语料 +
//   同一 file_path + 同一已见集合,输出确定)——没有随机数、没有系统时间参与选择逻辑本身(时间戳只
//   进 ts 列和标题里的日期串,不影响"选谁")。因此:两次调用要拿到同一份推送,MEM/STATE 必须都是
//   全新且彼此独立的(不能只换 PMM_RECALL_ROOT);见下方 --self-test「两个全新 root(STATE 一并全新)
//   同输入 ⇒ 同输出」与其反例「同 STATE 不同 root ⇒ seen 去重生效,输出理应不同」。
'use strict';
const fs = require('fs');
const path = require('path');

// R5-7 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-5 /
// FABLE-2026-09-15-codex-cumulative-triage.md R5-7 requirement ③): the glob compiler + B5 prefix
// policy used to be DEFINED in this file, which is exactly why pmm-core.cjs (which needed
// checkTriggerPathB5 for classifyTriggerLine) had to require THIS file — creating a one-directional
// dependency that made it impossible for this file to require pmm-core.cjs back (for
// classifyTriggerLine/FENCE_RE) without a genuine require() cycle. Extracted to the leaf module
// pmm-trigger-glob.cjs (zero dependency on either file); re-exported below unchanged so every existing
// require('./pmm-trigger-recall.cjs') caller (pmm-manifest.cjs, the self-tests) keeps working without
// modification.
// 2026-09-24 open-core cut: pmm-core.cjs (the causal shadow-memory engine) moved to AxMem Pro / a
// commercial license and is no longer part of this repo. classifyTriggerLine/FENCE_RE — the SAME
// fence-aware, authoritative trigger-line grammar the write gate uses — moved into pmm-trigger-glob.cjs
// alongside the trigger-path grammar it already owned (see that file's own header), rather than being
// removed along with the rest of pmm-core.cjs; this file now imports both from there instead.
const {
  TriggerPatternError, compileTriggerPath, checkTriggerPathB5, testTriggerPath, MAX_CANDIDATE_PATH_LEN,
  FENCE_RE, classifyTriggerLine,
} = require('./pmm-trigger-glob.cjs');
// M-SPEC 附录 B1 (2026-09-17): dual-write into the shared v3 ledger alongside the pre-existing
// dreams/trigger-log-*.tsv write and stdout injection, both of which stay BYTE-FOR-BYTE unchanged
// (golden-diffed against the pre-B1 binary during build — see build report). Ledger writes are pure
// side effects: any failure inside them must never alter stdout or the hook's exit behavior, so every
// new block below is wrapped in its own try/catch and writeEvent() itself never throws (it already
// swallows I/O errors and tallies them into write-failures.count).
const ledger = require('./pmm-recall-ledger.cjs');
// pmm-recall-policy.cjs (2026-09-17, MEDIUM-6 coordinator dispatch): the ONE policy resolver. Real
// production data showed 2750 eligible rows all mode='intervene' (this hook hardcoded it) --
// M3 reads `mode` off the eligible row to decide a unit's arm, so with no writer ever producing
// 'shadow' every class stayed UNKNOWN forever. This hook now consults policy.resolve() per matched
// tag's LESSON CLASS and records the real arm; when a class is randomized and lands on shadow, the
// tag is not displayed (a suppressed row records why), reproducing M3's random-intervention design.
const policy = require('./pmm-recall-policy.cjs');

// HIGH-1 (2026-09-17, fab blind attack / Opus reproduction): this used to hardcode
// `process.env.PMM_HOME || 'C:/Users/<user>'` -- correct on exactly one machine, and never overridable
// by a redirected-HOME test harness that didn't also know to set PMM_HOME. Now derived through
// ledger.resolveHome() (PMM_HOME > USERPROFILE > HOME > os.homedir(), the ONE resolver -- see that
// function's own comment), same convergence discipline LOW-5/LOW-K2 already applied to
// PMM_RECALL_ROOT resolution.
const HOME = ledger.resolveHome().replace(/\\/g, '/');
const MEM = (process.env.PMM_TRIGGER_MEM || HOME + '/.claude/memory').replace(/\\/g, '/');
const STATE = (process.env.PMM_TRIGGER_STATE || HOME + '/.claude').replace(/\\/g, '/');
// 按机器分文件(2026-09-13 Opus P0-3 同族):此文件入库同步,双机 append 同一文件=合并冲突炸弹
const MACH = (require('os').hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
// M-SPEC 补注(2026-09-17, fab blind attack item 2): telemetry now lives under the recall ROOT
// (PMM_RECALL_ROOT, same directory family as the v3 ledger/policy.json/quarantine file -- local
// runtime state, never committed to the repo), not under MEM/dreams/ (which IS committed -- the
// already-in-repo dreams/trigger-log-<mach>.tsv is frozen as a historical artifact going forward,
// see memory/dreams/trigger-log-<mach>.contaminated-keys.txt for why). RECALL_ROOT is computed
// once at module load (a pure function of env vars, safe to call before runHook()) so this default
// path and every ledger.writeEvent({root: RECALL_ROOT}) call later in this file agree byte-for-byte.
const RECALL_ROOT = ledger.resolveRoot();
const LOG = (process.env.PMM_TRIGGER_LOG || RECALL_ROOT + '/trigger-log-' + MACH + '.tsv').replace(/\\/g, '/');
const TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function tlog(stage, extra) {
  // LOW-2 fix (2026-09-23, fab blind delta / Opus reproduction): a fresh PMM_RECALL_ROOT whose parent
  // directory doesn't exist yet used to silently swallow the FIRST tlog write ever made against it
  // (fs.appendFileSync ENOENTs, caught by the empty catch below) -- the no-repo early-exit path is
  // often that first write, so a brand-new root could look like the hook never ran at all. mkdirSync
  // is inside the SAME try as the append (never a second silent-failure surface of its own).
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, [new Date().toISOString(), extra.session || '-', stage, extra.tool || '-', extra.repo || '-', extra.rel || '-', extra.tag || '-', extra.note || '-'].join('\t') + '\n');
  } catch {}
}

// truncateUtf8Bytes(s, max) — truncate a UTF-8 string to at most `max` bytes on a code-point
// boundary (never split a surrogate pair / multi-byte sequence). Used only by 补遗二 §23 R2's
// repush payload packing below (item 20's 1.2KB-quota discipline, applied here for the LIVE hook).
function truncateUtf8Bytes(s, max) {
  s = String(s);
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = '';
  for (const ch of s) {
    const cand = out + ch;
    if (Buffer.byteLength(cand, 'utf8') > max) break;
    out = cand;
  }
  return out;
}

// ── hook 主体(仅当本文件作为进程入口直接执行时才跑;require() 进来只拿 compileTriggerPath 等
//   纯函数,绝不读 stdin/绝不 process.exit——pmm-core.cjs/pmm-manifest.cjs 会在 --check 等场景
//   require() 本文件,没有 stdin 可读,若不做这层隔离会直接卡死或提前退出宿主进程)──────────────
function runHook() {
let inputBuf = Buffer.alloc(0);
try { inputBuf = fs.readFileSync(0); } catch { process.exit(0); }
const input = inputBuf.toString('utf8');
let data = {};
try { data = JSON.parse(input); } catch {
  // LOW-6->MEDIUM (2026-09-17, fab blind attack / production trigger-log showed 62 real 'error' rows
  // for non-JSON stdin with no way to tell which caller sent it): sha16 of the first 64 raw BYTES
  // (not the utf8-decoded string, so this stays meaningful even for truncated/invalid-UTF-8 input)
  // plus the total byte length, appended to the telemetry note. Diagnostic only -- never changes the
  // fail-open exit(0) behavior or anything the caller can observe.
  const head64 = inputBuf.slice(0, 64);
  const head64Sha16 = require('crypto').createHash('sha256').update(head64).digest('hex').slice(0, 16);
  tlog('error', { note: 'bad-json:len=' + inputBuf.length + ';head64sha16=' + head64Sha16 });
  process.exit(0);
}
const tool = data.tool_name || '';
if (!TOOLS.has(tool)) process.exit(0);
const session = String(data.session_id || 'nosess').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
// v3 ledger identity fields (附录 B1): full (untruncated) session_id, plus the optional agent/prompt/
// tool_use_id fields Claude Code hook payloads may carry — same defensive extraction convention as
// pmm-bash-impression.cjs (the sibling M0 hook sharing this ledger module).
const sessionIdRaw = (typeof data.session_id === 'string' && data.session_id) ? data.session_id : null;
const toolUseIdRaw =
  (typeof data.tool_use_id === 'string' && data.tool_use_id) ? data.tool_use_id :
  (typeof data.toolUseId === 'string' && data.toolUseId) ? data.toolUseId :
  (typeof data.tool_call_id === 'string' && data.tool_call_id) ? data.tool_call_id : null;
const agentIdRaw =
  (typeof data.agent_id === 'string' && data.agent_id) ? data.agent_id :
  (typeof data.agentId === 'string' && data.agentId) ? data.agentId : null;
// M-SPEC 附录 B 补注 #5 (2026-09-17, fab blind attack item 3 / Opus reproduction): the session-scoped
// dedup key used to be the first 8 chars of session_id alone -- a main session and any sub-agent
// sharing that SAME session_id (Claude Code agent sub-sessions do) collapsed onto the identical
// `.trigger-seen-<8chars>` file, so whichever one ran first silently "used up" the other's seen-once
// budget for a tag (mutual starvation, never a duplicate push). The key is now
// sha16(session_id || NUL || agent_id) -- the SAME two-field identity pmm-recall-ledger.cjs's own
// impressionId()/M0 sibling hook already use elsewhere, so a bare main session (agent_id='') keeps
// its EXACT old effective behavior (one deterministic key per session_id, agent_id folded in as
// empty), while a sub-agent sharing the session_id gets its own independent key and its own
// once-per-tag budget.
const seenKey = ledger.sha16((sessionIdRaw || 'nosess') + ledger.NUL + (agentIdRaw || ''));
const agentTypeRaw =
  (typeof data.agent_type === 'string' && data.agent_type) ? data.agent_type :
  (typeof data.agentType === 'string' && data.agentType) ? data.agentType : null;
const promptIdRaw =
  (typeof data.prompt_id === 'string' && data.prompt_id) ? data.prompt_id :
  (typeof data.promptId === 'string' && data.promptId) ? data.promptId : null;
let fp = String((data.tool_input && data.tool_input.file_path) || (data.tool_input && data.tool_input.notebook_path) || '');
if (!fp) process.exit(0);
const rawFpForHash = fp; // cmd_sha16 = sha16(tool_input.file_path) — hashed BEFORE the slash/drive-letter normalization below

// ── 规范化 + repo-id 解析(确定性,零猜测)──
fp = fp.replace(/\\/g, '/');
fp = fp.replace(/^([A-Za-z]):\//, (m, d) => d.toLowerCase() + ':/');
const lower = fp.toLowerCase();
let repo = null, rel = null;
// [Builder W9, 2026-09-24] PMM_REPO_MARKERS: comma-separated repo directory
// names this hook recognizes by path substring, beyond `home` (was a single
// hardcoded real personal-project directory name -- a deployment detail
// that had no business being a literal in shipped guard logic, and would
// have leaked into the public export verbatim). Empty by default (matches
// this pass's other two env-parameterized guard hardcodes,
// PMM_SECOND_REPO_DIR and PMM_POINTER_EXTRA_ROOTS, per the same README
// note) -- with no markers configured, only `repo=home` (below) is ever
// recognized. First marker whose `/<marker>/` substring appears wins, same
// last-substring-match semantics the single hardcoded case used to have.
const REPO_MARKERS = String(process.env.PMM_REPO_MARKERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const marker of REPO_MARKERS) {
  const markerLower = marker.toLowerCase();
  const idx = lower.lastIndexOf('/' + markerLower + '/');
  if (idx >= 0) {
    repo = marker;
    rel = fp.slice(idx + markerLower.length + 2); // +2: the two '/' either side of the marker
    break;
  }
}
if (!repo && lower.startsWith(HOME.toLowerCase() + '/')) {
  repo = 'home';
  rel = fp.slice(HOME.length + 1);
}
// worktree 物理根 → 仓库相对(2026-09-13 Opus 审计 P1:原来只剥 axervice 一处,home 及任意
// repo 的 worktree 全 miss 且被记成 matched=0,与"真不相关"不可区分 → 试点止损永远看不见这个洞)
if (rel) {
  const wt = rel.match(/^(?:.*?\/)??\.claude\/worktrees\/[^/]+\/(.*)$/);
  if (wt && wt[1]) { rel = wt[1]; tlog('wt-normalized', { session, tool, repo, rel }); }
}
if (!repo) { tlog('event', { session, tool, note: 'no-repo matched=0' }); process.exit(0); }
const relLower = rel.toLowerCase();

// ── 补遗二 §23 R2 detection(2026-09-24,C05-BUILD-SPEC B6 / M-SPEC 附录B补注#6)──────────────────
// R2 = this event is an Edit or MultiEdit under <repo=home>/.claude/guards/** whose union of
// old_string(s) assigns one of the isolation-redirect variables while the corresponding union of
// new_string(s) no longer assigns that SAME variable name -- i.e. someone just removed an isolation
// redirect. Write has no old_string (KNOWN-GAP, spec text verbatim) -- never judged as R2.
const R2_VARS = ['HOME', 'USERPROFILE', 'PMM_HOME', 'PMM_RECALL_ROOT', 'PMM_TRIGGER_MEM', 'PMM_TRIGGER_STATE', 'PMM_TRIGGER_LOG', 'PMM_MEM_DIR'];
function assignedVars(text) {
  const s = String(text || '');
  const found = new Set();
  for (const v of R2_VARS) {
    // word-boundary before the name (so PMM_HOME doesn't false-match inside SOME_PMM_HOME) followed
    // immediately by '=' -- a bare shell/JS-style assignment token, same convention isolation-gate
    // uses for its own "complete redirect set" prefix-assignment check.
    if (new RegExp('(^|[^A-Za-z0-9_])' + v + '=').test(s)) found.add(v);
  }
  return found;
}
let isR2Edit = false;
if ((tool === 'Edit' || tool === 'MultiEdit') && repo === 'home' && relLower.indexOf('.claude/guards/') === 0) {
  let oldUnion = '', newUnion = '';
  const ti = data.tool_input || {};
  if (tool === 'Edit') {
    oldUnion = String(ti.old_string || '');
    newUnion = String(ti.new_string || '');
  } else if (Array.isArray(ti.edits)) {
    for (const ed of ti.edits) {
      oldUnion += String((ed && ed.old_string) || '') + '\n';
      newUnion += String((ed && ed.new_string) || '') + '\n';
    }
  }
  const oldVars = assignedVars(oldUnion);
  const newVars = assignedVars(newUnion);
  for (const v of oldVars) { if (!newVars.has(v)) { isR2Edit = true; break; } }
}

// ── v3 ledger row builder (附录 B1) ──────────────────────────────────────────────────────────────
// gate_instance_id = sha16(repo ‖ NUL ‖ rel_path) — pinned by the B1 appendix text (distinct from the
// per-gate-kind pinning in 附录 A/§17, which governs the Bash pipe gate + M0 cmd-trigger hook, not
// this Edit/Write path-trigger hook). Computed once per hook event: repo/rel are fixed for the whole
// invocation, so every row this event writes shares one gate_instance_id.
//
// Opus review (2026-09-17, "G11 的 impression 可核"): gate_instance_id was computed but never
// written to any column, so an external verifier (the G11 runner) could never recompute
// impression_id from the ledger row alone. Pinned inputs to the formula (so an external recompute
// is deterministic): `repo` is exactly the string this trigger engine resolved above ('home' or
// one of PMM_REPO_MARKERS -- never a filesystem path); `rel` is the path relative to THAT repo's root,
// forward-slashed (fp already had backslashes normalized above), with no leading './' (it is a
// direct String.slice() right after the repo-root prefix, which structurally cannot produce one).
// The hash itself is carried in run_provenance as an appended `inst:<sha16>` tag (suppressed rows'
// existing seen/cap value comes first, `;`-separated) -- ledger schema v3 has no dedicated column
// for it, and run_provenance is the column 附录 B1 already designated for this hook's provenance
// notes. (RECALL_ROOT is the module-level constant computed above, near LOG's own definition --
// HIGH-1/item-2 converged this hook onto ONE root computation instead of a second local copy.)
const gateInstanceId = ledger.sha16(repo + ledger.NUL + rel);
const cmdSha16 = ledger.sha16(rawFpForHash);
function appendInst(existing) {
  const instTag = 'inst:' + gateInstanceId;
  return existing ? existing + ';' + instTag : instTag;
}
// MEDIUM-6 (2026-09-17, coordinator dispatch): policy.resolve() is consulted per TAG (keyed by
// that lesson's class via classOf.get(tag), the same class value ledgerRow() already puts in the
// class_tag column) and cached, since the same tag can be looked at more than once as it flows
// through eligible -> (redirect) -> seen/cap dedup -> the policy filter below. resolve() itself
// never throws, but this is defensive: a hook failure here must NEVER touch stdout.
const tagPolicyCache = new Map();
function policyFor(tag) {
  if (tagPolicyCache.has(tag)) return tagPolicyCache.get(tag);
  let pol;
  try { pol = policy.resolve(sessionIdRaw || '', classOf.get(tag) || '', { root: RECALL_ROOT }); }
  catch (e) { pol = { arm: 'shadow', provenance: 'policy:corrupt' }; }
  tagPolicyCache.set(tag, pol);
  return pol;
}
function ledgerIds(tag, eventKind) {
  const idMissing = !(sessionIdRaw && toolUseIdRaw);
  if (idMissing) return { impressionId: '', eventId: '', idMissing: true };
  const impId = ledger.impressionId({
    session_id: sessionIdRaw, agent_id: agentIdRaw || '', tool_use_id: toolUseIdRaw,
    trigger_or_gate_id: tag || '', gate_instance_id: gateInstanceId,
  });
  const ordinal = ledger.ordinalOf(tag || '', gateInstanceId, eventKind);
  const evId = ledger.eventId(impId, eventKind, ordinal);
  return { impressionId: impId, eventId: evId, idMissing: false };
}
// runProvenanceOverride: suppressed rows carry 'seen'/'cap'/'policy-shadow' as their PRIMARY
// run_provenance reason (附录 B1 / MEDIUM-6); eligible/displayed rows (no override) carry the
// policy resolver's own provenance string ('policy:absent'|'policy:shadow'|'policy:randomized'|
// 'policy:corrupt') instead of the old PMM_RECALL_TAG-or-empty default -- MEDIUM-6 explicitly wants
// this column to say WHY a row got the mode it got.
// mode: 'intervene' whenever the class is NOT randomized (legacy default -- unconditional display,
// exactly the old hardcoded behavior, "行为不变"); when randomized, mode = the resolved arm itself
// (this is the column M3 reads to tell the two arms apart -- MEDIUM-6's whole point).
function ledgerRow(tag, eventKind, runProvenanceOverride) {
  const { impressionId, eventId, idMissing } = ledgerIds(tag, eventKind);
  const toolUseIdF = ledger.sanitize(toolUseIdRaw || '');
  const agentIdF = ledger.sanitize(agentIdRaw || '');
  const agentTypeF = ledger.sanitize(agentTypeRaw || '');
  const promptIdF = ledger.sanitize(promptIdRaw || '');
  const anySanitized = toolUseIdF.sanitized || agentIdF.sanitized || agentTypeF.sanitized || promptIdF.sanitized;
  const pol = policyFor(tag);
  const mode = (pol.provenance === 'policy:randomized') ? pol.arm : 'intervene';
  return {
    sid_sha16: sessionIdRaw ? ledger.sha16(sessionIdRaw) : '',
    agent_sha16: agentIdRaw ? ledger.sha16(agentIdRaw) : '',
    agent_type: agentTypeF.value, prompt_id: promptIdF.value, tool_use_id: toolUseIdF.value,
    impression_id: impressionId, event_id: eventId, event_kind: eventKind,
    gate: '', confidence: '', class_tag: classOf.get(tag) || '', trigger_or_gate_id: tag,
    cmd_sha16: cmdSha16, parser_version: '', mode: mode,
    run_provenance: appendInst(runProvenanceOverride || pol.provenance),
    sanitized: anySanitized ? '1' : '0', id_missing: idMissing ? '1' : '0',
    agent_id_missing: agentIdRaw ? '0' : '1',
  };
}

// ── 编译 trigger 表(扫描三文件;条目头之后的 trigger 注释归属该条目)──
// R-4 fix (2026-09-15 round 3, guards/audits/OPUS-2026-09-15-round2-review.md "R-4"): anchored to the
// full line (`^...$`) — previously unanchored `.match()` matched a trigger construct ANYWHERE in the
// line (leading indentation, leading/trailing garbage all ignored), while the read-side grammar
// (pmm-core.cjs's classifyTriggerLine/TRIG_P_RE) requires the WHOLE line to be exactly the trigger
// comment. Anchoring closed the indentation gap and the "trailing text after -->" gap (same class as
// B2/B3 in R-3).
//
// R5-7 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-5 /
// FABLE-2026-09-15-codex-cumulative-triage.md R5-7): the R-4 fix above closed the anchoring gap but
// this scan was STILL a bare per-line regex with NO fence state at all — a trigger-comment EXAMPLE
// inside a ``` fenced code block (invisible to core.parseFile()/the write gate, both of which are
// fence-aware) was still collected here and could fire a real push. The require-cycle blocker that
// used to prevent reusing classifyTriggerLine directly is gone (pmm-trigger-glob.cjs extraction, see
// this file's top) — this scan now (a) tracks fence state exactly like parseFile()'s own `wasFence`
// toggle, skipping EVERY line's classification (not just triggers — same treatment applies to
// Supersedes/Class/link lines below, since a documentation example inside a fence is just as invalid
// evidence for those), and (b) classifies candidate trigger lines with core.classifyTriggerLine itself
// — the SAME authoritative grammar, not a fourth regex reimplementation of it.
const triggers = [];
// 2026-09-13 the maintainer 裁定「細分記憶之間如果有關聯或因果,要一起想起」:
// 扫描时顺带收每条目的出向双链(正文里的 [[ns:tag]])+ 全库 tag→标题表。
// 关联携带是确定性链跟随(零判断),一跳、限名额、遥测分列。
const tagTitle = new Map();     // tag -> title(标题即锚点,自带 YYYY-MM-DD = 时间线随身)
const entryLinks = new Map();   // tag -> [出向链接 tag...]
// 取代链(the maintainer 2026-09-13「agent 需知道記憶的時間線」):被 Supersedes 的记忆不许被当现行推。
// 两个确定性来源:① Index 行尾 (superseded→[new]) ② 条目内 Supersedes: [[old]] 行。
const supNext = new Map();      // old-tag -> new-tag
// 归档也在扫描面内(codex 评审 Finding-1,HIGH):redirect 的入口元数据必须比正文命长——
// 旧条目被归档(淡忘)后,它的 trigger/Supersedes/标题仍要能把编辑事件引到 live 链头,
// 否则「归档旧条=杀死指向新条的推送」。归档条目的 trigger 命中永远 redirect,不会推旧正文。
// 分类法(2026-09-14 the maintainer「分类的事情也要解决」):classes.md 的类枢纽当条目匹配(自带 trigger);
// 每条教训的 `Class: [[class:x]]` 行把它挂到类上——命中枢纽推最近两条成员,命中成员报同类余数。
const classOf = new Map();      // tag -> class:x
const classMembers = new Map(); // class:x -> [live member tag...]
const classRules = new Map();   // class:x -> [管辖它的 Kernel 规则 tag...]
// 补遗二 §23 R2(2026-09-24,C05-BUILD-SPEC B6):再推载荷 = 条目首个 `What to do instead:` 行
// (去前缀);first-wins per tag, populated in the SAME per-line scan below (no second file pass).
const whatToDo = new Map();     // tag -> first "What to do instead:" line content (prefix stripped)
for (const f of ['lessons.md', 'decisions.md', 'standinginstructions.md', 'classes.md',
                 'lessons-archive.md', 'decisions-archive.md', 'standinginstructions-archive.md']) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  let curTag = null, curTitle = null;
  let inFence = false; // R5-7: reset per file, toggled/consumed exactly like core.parseFile()'s wasFence
  for (const line of s.split(/\r?\n/)) {
    const wasFence = inFence;
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (wasFence) continue; // inside a fence: invisible to the grammar entirely (matches parseFile())
    const h = line.match(/^\*\*(20[^*]+)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
    if (h) {
      curTitle = h[1].slice(0, 60); curTag = h[2];
      // trust 随身(fab 盲攻进化4):agent 该知道推来的是「拍板」还是「推导」
      const _tr = (line.match(/\[trust:([a-z-]+)\]/) || [])[1];
      tagTitle.set(curTag, curTitle + (_tr ? ' [trust:' + _tr + ']' : ''));
      if (!entryLinks.has(curTag)) entryLinks.set(curTag, []);
      continue;
    }
    // R5-7: classify with the SAME authoritative grammar core.parseFile()/the write gate use, instead
    // of a fourth private regex. Only path-form triggers (kind==='path') are relevant to this engine
    // (it matches Edit/Write/MultiEdit/NotebookEdit file-path events, never Bash commands) — a cmd-form
    // trigger classifies fine but is simply not collected here, same as before this fix.
    if (curTag) {
      let trigRes = null;
      try { trigRes = classifyTriggerLine(line); } catch { trigRes = null; }
      if (trigRes && trigRes.ok && trigRes.trigger.kind === 'path') {
        triggers.push({ tools: trigRes.trigger.tools, repo: trigRes.trigger.repo, path: trigRes.trigger.path.toLowerCase(), tag: curTag, title: curTitle });
      }
    }
    if (line.startsWith('- 20')) { // Index 行:只取取代标记,不算出向边
      const sm = line.match(/^- 20[^[]*\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\].*superseded→\[?([A-Za-z0-9:._-]+?)\]?\)/);
      if (sm) {
        let nx = sm[2];
        if (!nx.includes(':')) nx = sm[1].split(':')[0] + ':' + nx; // 库内既有写法常省命名空间,补同域前缀
        supNext.set(sm[1], nx);
      }
      continue;
    }
    if (curTag && /^Supersedes:/.test(line.trim()))
      for (const om of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) supNext.set(om[1], curTag);
    if (curTag && /^Class:\s*\[\[class:[a-z0-9-]+\]\]\s*$/.test(line)) {
      const c = line.match(/\[\[(class:[a-z0-9-]+)\]\]/)[1];
      classOf.set(curTag, c);
      if (!classMembers.has(c)) classMembers.set(c, []);
      if (!f.includes('-archive')) classMembers.get(c).push(curTag);
      continue; // Class 行不算出向双链(否则每条教训都"关联"到枢纽,挤掉真关联)
    }
    // 类枢纽的 Rules: 行(2026-09-14 the maintainer「我立下的規則分類了嗎」):该类受哪些 Kernel 铁律管辖。
    // 不占推送名额、不算出向链——随枢纽行以「规则:」附注推出,agent 顺手 grep 原文。
    if (curTag && curTag.startsWith('class:') && /^Rules:/.test(line.trim())) {
      classRules.set(curTag, [...line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)].map(m => m[1]));
      continue;
    }
    if (curTag && !whatToDo.has(curTag)) {
      const wtdM = line.match(/^What to do instead:\s*(.*)$/);
      if (wtdM) whatToDo.set(curTag, wtdM[1]);
    }
    if (curTag) for (const lm of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) {
      const arr = entryLinks.get(curTag); if (!arr.includes(lm[1])) arr.push(lm[1]);
    }
  }
}
// 沿取代链跳到最新(codex 终审 #7 / fab LOW-3,2026-09-23,批 A3):固定 `hops++ < 5` 只是防环的替代品,
// 不是环检测——一条 7 节点取代链(s1→…→s7,trigger 种在 s1)5 跳就停在 s6,推的不是最新版。改用
// visited-Set 一直追到链的真正终点(supNext 里没有下一跳,或下一跳已经访问过);后者说明出现了环,
// 停在第一次重复**之前**(不把环上的节点当"最新"返回)并记一行 tlog('supersede-cycle')，方便追查
// 是谁写出的坏 Supersedes 数据,同时避免死循环。
function head(tag) {
  let t = tag;
  const visited = new Set([t]);
  while (supNext.has(t)) {
    const next = supNext.get(t);
    if (visited.has(next)) {
      tlog('supersede-cycle', { session, tool, repo, rel, tag: t, note: 'cycle-at=' + next });
      break;
    }
    visited.add(next);
    t = next;
  }
  return t;
}

// ── 匹配(compileTriggerPath 唯一实现;大小写不敏感;§GLOB-TRIGGER-SPEC.md)──
// 编译失败的 trigger:跳过该条 + stderr 响亮 + 本机 error 行,绝不整体崩(fail-open,与 B28 推送侧口径一致)。
const matched = triggers.filter(tr => {
  if (!tr.tools.includes(tool) || tr.repo !== repo) return false;
  let compiled;
  try { compiled = compileTriggerPath(tr.path); }
  catch (e) {
    process.stderr.write(`[pmm-trigger-recall] compileTriggerPath 编译失败,已跳过该 trigger: tag=${tr.tag} path=${tr.path} err=${e.message}\n`);
    tlog('error', { session, tool, repo, rel, tag: tr.tag, note: 'compile-fail:' + e.message });
    return false;
  }
  return testTriggerPath(compiled, relLower);
});
tlog('event', { session, tool, repo, rel, note: 'matched=' + matched.length });
// 附录 B1: 每个 matched tag 一行 eligible (before any redirect/dedup/seen-suppression decision —
// mirrors the existing tlog('event', ...) telemetry line above, which also counts raw `matched`).
try { for (const m of matched) ledger.writeEvent(ledgerRow(m.tag, 'eligible'), { root: RECALL_ROOT }); } catch (e) { /* never affect stdout */ }
if (matched.length === 0) process.exit(0);

// ── 会话内去重 + 每事件 ≤3 ── (M-SPEC 附录 B 补注 #5: key = sha16(session_id‖NUL‖agent_id), see
// seenKey's own comment above -- a main session and a same-session_id sub-agent now get independent
// dedup budgets instead of colliding on one truncated-8-char filename.)
const seenF = STATE + '/.trigger-seen-' + seenKey;
let seen = new Set();
try { seen = new Set(fs.readFileSync(seenF, 'utf8').split('\n').filter(Boolean)); } catch {}
// 直接命中先过取代链:trigger 种在旧条目上时,推的必须是链头(最新裁定),旧 tag 只作来源注
const redirected = [];
{
  const dedup = new Set();
  for (const m of matched) {
    const h2 = head(m.tag);
    if (dedup.has(h2)) continue; dedup.add(h2);
    if (h2 === m.tag) redirected.push(m);
    else { tlog('superseded-redirect', { session, tool, repo, rel, tag: h2, note: 'from=' + m.tag }); redirected.push({ ...m, tag: h2, title: tagTitle.get(h2) || m.title, from: m.tag }); }
  }
}
const fresh = [], sup = [];
for (const m of redirected) (seen.has(m.tag) ? sup : fresh).push(m);
// 补遗二 §23 R2 (2026-09-24, C05-BUILD-SPEC B6): among tags already suppressed-seen, an
// R2-qualifying edit (isR2Edit) gets ONE repush per (seenKey, tag). Budget tracked by a
// `repush:<tag>` line appended to the SAME seen file (spec text: "记账方式:在同一个 seen 文件里
// 追加一行 repush:<tag>...不得另起前缀" — every existing /^\.trigger-seen-/ sentinel and autopull's
// GC keep covering it automatically without new code). This partition happens BEFORE candidates/
// inject are ever computed, so it never touches their contents (control test: a non-R2 event's
// normal push payload stays byte-identical to before this feature existed).
const repushTagSet = new Set();
for (const s of seen) { const rm = /^repush:(.+)$/.exec(s); if (rm) repushTagSet.add(rm[1]); }
const repushable = [], supFinal = [];
for (const m of sup) (isR2Edit && !repushTagSet.has(m.tag) ? repushable : supFinal).push(m);
for (const m of supFinal) tlog('suppressed-seen', { session, tool, repo, rel, tag: m.tag });
try { for (const m of supFinal) ledger.writeEvent(ledgerRow(m.tag, 'suppressed', 'seen'), { root: RECALL_ROOT }); } catch (e) { /* never affect stdout */ }
const candidates = fresh.slice(0, 3);
for (const m of fresh.slice(3)) tlog('suppressed-cap', { session, tool, repo, rel, tag: m.tag });
try { for (const m of fresh.slice(3)) ledger.writeEvent(ledgerRow(m.tag, 'suppressed', 'cap'), { root: RECALL_ROOT }); } catch (e) { /* never affect stdout */ }
if (candidates.length === 0 && repushable.length === 0) process.exit(0);
// MEDIUM-6 (2026-09-17, coordinator dispatch): among candidates that survived seen/cap dedup,
// split by the resolved policy arm. A class that is NOT randomized behaves EXACTLY as before
// (unconditional display, "行为不变") -- policyFor() returns arm='shadow' in that case too, but
// its provenance is not 'policy:randomized', so the check below only ever pulls a tag out of
// display when the class was DELIBERATELY randomized AND the coin-flip landed on shadow.
const inject = [];
for (const m of candidates) {
  const pol = policyFor(m.tag);
  if (pol.provenance === 'policy:randomized' && pol.arm === 'shadow') {
    tlog('suppressed-policy-shadow', { session, tool, repo, rel, tag: m.tag });
    try { ledger.writeEvent(ledgerRow(m.tag, 'suppressed', 'policy-shadow'), { root: RECALL_ROOT }); } catch (e) { /* never affect stdout */ }
  } else {
    inject.push(m);
  }
}
// ALL candidates (displayed or policy-shadow-suppressed) are marked seen for this session -- the
// arm is stable per (session, class) for the whole session, so re-evaluating the same tag on a
// later edit in the same session would only reproduce the identical policy decision.
try { fs.appendFileSync(seenF, candidates.map(m => m.tag).join('\n') + '\n'); } catch {}
for (const m of inject) tlog('injected', { session, tool, repo, rel, tag: m.tag });

// 补遗二 §23 R2: repush candidates go through the SAME policy resolver (M-SPEC 附录B补注#6③).
// randomized+shadow arm: eligible (already written above, before dedup/seen) + suppressed(policy-
// shadow) only -- never displayed, never occupies stdout. Otherwise: displayed, run_provenance gets
// `;repush:R2` appended (via ledgerRow's runProvenanceOverride param).
const repushDisplayed = [];
for (const m of repushable) {
  const pol = policyFor(m.tag);
  if (pol.provenance === 'policy:randomized' && pol.arm === 'shadow') {
    tlog('suppressed-policy-shadow', { session, tool, repo, rel, tag: m.tag, note: 'repush' });
    try { ledger.writeEvent(ledgerRow(m.tag, 'suppressed', 'policy-shadow'), { root: RECALL_ROOT }); } catch (e) { /* never affect stdout */ }
  } else {
    repushDisplayed.push(m);
  }
}
// M4 修复(guards/audits/OPUS-2026-09-24-c05-wave2-review.md「M4 R2 被联合配额整条丢弃仍烧掉一次性
// 再推额度」):这里原来无条件把 repushable 全体(含还没经过下面联合配额裁剪的 repushDisplayed)都
// 记一行 repush:<tag>,发生在联合配额裁剪(下面 if (repushDisplayed.length > 0) 块,算 quota 的地方)
// **之前**——一个 R2 候选若被联合 1200B 配额整条丢弃(repushDroppedByQuota,从未真正出现在 stdout
// 里),仍会在这里被记成"已经用掉这次(seenKey, tag)的一次性再推额度",下次同一 tag 再触发就只
// suppressed|seen,永不再推。E-5① 的语义是"only the entries that survived the joint quota"才算真正
// 展示过;额度消耗理应跟着同一条界线走。真正要保留的行为(见下面 policy-shadow 分支自己的注释,
// 与 M4 review 无关、不动):policy 判定为 shadow 臂而不展示的 repush 候选,仍然算用过额度(臂判定
// 按 session+class 稳定,同一会话内再考虑一次也只会得到同一个结果)——只有"联合配额整条丢弃"这一种
// 结局不消耗额度、改记 suppressed(cap),下次仍有机会再推。因此这一行 seenF 写入延后到下面配额裁剪
// 算出 repushDroppedByQuota 之后再做(见下方 quota 代码块之后),写入集合 = repushable 去掉被配额
// 丢弃的那些。tlog('injected', ...) 遥测行本身不属于本次修复范围(M4 review 只谈 seenF 额度记账/
// ledger displayed 记录,tlog 是独立的 dreams/trigger-log 遥测,位置保持原样不动)。
for (const m of repushDisplayed) tlog('injected', { session, tool, repo, rel, tag: m.tag, note: 'repush:R2' });

if (inject.length === 0 && repushDisplayed.length === 0) process.exit(0); // nothing to show

// 一跳关联携带(the maintainer 2026-09-13):直接命中优先占名额,剩余名额按链序补关联条目;
// 会话内 seen 同样约束关联;遥测 stage=injected-linked 与直接命中分列(校准分开算账)。
const linked = [];
const already = new Set(inject.map(m => m.tag));
// M-4① (2026-09-17, fab blind attack / Opus reproduction): a DANGLING [[link]] (no title anywhere in
// the scanned files -- includes a class:* reference whose hub entry never got a scannable header,
// e.g. one only defined in classes.md outside this trigger-scan's header grammar) used to occupy a
// push slot exactly like a real correlated entry, so a genuinely resolvable linked/class-member entry
// could be silently crowded out by a placeholder that carries no information. `resolvedSlots` counts
// only NON-dangling linked entries against the ≤3 cap; a dangling entry is still followed and shown
// with the SAME placeholder text as before (wording unchanged), it just never consumes a slot.
let resolvedSlots = 0;
// codex 终审 #7 / fab LOW-3(2026-09-23,批 A3):M-4① 让悬空项不占 ≤3 名额是对的,但同时把悬空项的
// 数量上限也一并去掉了(回归)——一个枢纽条目正文挂 30 个悬空链,旧代码 30 条全推。悬空占位现在单独
// 封顶 max(0, 3 − inject.length) 条:超出的只写 tlog('dangling-capped'),不进 additionalContext,
// 但仍然跳过(不 break),让同一直接命中后面排队的可解析关联/类成员照常有机会占用真名额。
let danglingShown = 0;
const danglingCap = Math.max(0, 3 - inject.length);
for (const m of inject) {
  for (const ltRaw of (entryLinks.get(m.tag) || [])) {
    const lt = head(ltRaw); // 关联也不许推已被取代的旧版
    if (already.has(lt) || seen.has(lt)) continue;
    const isDangling = !tagTitle.has(lt);
    if (!isDangling && inject.length + resolvedSlots >= 3) break;
    if (isDangling && danglingShown >= danglingCap) {
      tlog('dangling-capped', { session, tool, repo, rel, tag: lt, note: 'via=' + m.tag });
      already.add(lt); // 防止另一个直接命中的关联链再次把同一悬空 tag 记一遍 dangling-capped
      continue;
    }
    already.add(lt);
    const lTitle = tagTitle.get(lt) || '(冷区/项目档,标题不在三文件)';
    // 时间线标注:标题自带日期,再给 agent 一个显式新旧关系(与承载它的直接命中比)
    const dV = String(m.title || '').slice(0, 10), dL = String(lTitle).slice(0, 10);
    const age = /^20/.test(dL) && /^20/.test(dV) ? (dL > dV ? '较新' : dL < dV ? '较旧' : '同期') : '';
    linked.push({ tag: lt, title: lTitle, via: m.tag, age, from: lt !== ltRaw ? ltRaw : null });
    if (!isDangling) resolvedSlots++; else danglingShown++;
  }
}
// 类成员携带(2026-09-14 分类法):命中类枢纽 → 剩余名额补该类最近成员(按标题日期,新在前);同 seen 约束。
for (const m of inject) {
  if (!m.tag.startsWith('class:')) continue;
  const mem = (classMembers.get(m.tag) || []).slice().sort((a, b) => String(tagTitle.get(b) || '').localeCompare(String(tagTitle.get(a) || '')));
  for (const t of mem) {
    // codex 终审 #7(2026-09-23,批 A3):这里原来用 `inject.length + linked.length` 判名额,而
    // `linked` 此时已经含上面那段悬空链占位——悬空项把名额撑满后,同类成员这半永远进不来
    // (实测:枢纽 + 30 悬空链 + 2 同类成员 → 两个成员都缺席)。类成员本身不可能悬空(它们全部来自
    // 已经匹配到标题的扫描条目),所以按 resolvedSlots(只计非悬空)判才是这段注释原本想要的效果。
    if (inject.length + resolvedSlots >= 3) break;
    if (already.has(t) || seen.has(t)) continue;
    already.add(t);
    linked.push({ tag: t, title: tagTitle.get(t) || '', via: m.tag, age: '', from: null, cls: true });
    resolvedSlots++;
  }
}
if (linked.length) {
  try { fs.appendFileSync(seenF, linked.map(l => l.tag).join('\n') + '\n'); } catch {}
  for (const l of linked) tlog(l.cls ? 'injected-class-member' : 'injected-linked', { session, tool, repo, rel, tag: l.tag, note: 'via=' + l.via });
}
const clsNote = (tag) => {
  if (tag.startsWith('class:')) {
    const rules = classRules.get(tag) || [];
    return '(该类 live 成员 ' + (classMembers.get(tag) || []).length + ' 条,列全: pmm-grep.sh lessons "' + tag + '")' +
      (rules.length ? ' · 规则: ' + rules.map(r => '[' + r + ']').join(' ') : '');
  }
  const c = classOf.get(tag); if (!c) return '';
  return ' ↳ 同类 [' + c + '] 另 ' + Math.max(0, (classMembers.get(c) || []).length - 1) + ' 条';
};

// ctx is built EXACTLY as before (byte-identical) whenever there is no R2 repush this event --
// control test (C05-BUILD-SPEC B6): "普通推送(非 R2)的载荷与 HEAD 逐字节相同". The repush block
// (if any) is a separate string appended after it (or standing alone when inject is empty, e.g. the
// R2-only case: every normal candidate was already suppressed-seen and only the repush fired).
let ctx = '';
if (inject.length > 0) {
  ctx = '🧠 触发式召回(试点,与刚编辑的 ' + rel + ' 相关;不相关请直说,会记入校准):\n' +
    inject.map(m => '- [' + m.tag + '] ' + m.title + (m.from ? '(⚠️ 取代了 [' + m.from + '],已推最新)' : '') + ' → 全文: bash ~/.claude/memory/_local-config/pmm-search.sh "' + m.tag + '"' + clsNote(m.tag)).join('\n') +
    (linked.length ? '\n' + linked.map(l => (l.cls ? '  ↳ 同类成员' : '  ↳ 关联' + (l.age ? '(' + l.age + ')' : '')) + ' [' + l.tag + '] ' + l.title + (l.from ? '(取代了 [' + l.from + '])' : '')).join('\n') : '');
}
// M-8/M-9 fix (2026-09-24, audit `guards/audits/OPUS-2026-09-24-c05-batch-review.md` §2): the repush
// block used to be quota-packed against a FLAT 1200B budget of its own, independent of ctx's size --
// (a) M-9: when a normal push was ALSO present this event, the two got concatenated AFTER packing,
// so the combined additionalContext could exceed 1200B (spec 23's "整条 additionalContext <=1200B"
// covers the WHOLE payload, not the repush block alone; real repro measured 1940B); (b) M-8: EVERY
// entry in repushDisplayed got ledgered 'displayed' below regardless of whether its line actually
// survived the packing, so a quota-dropped repush row was recorded as shown when it never appeared in
// stdout at all. Fix: repush's own budget is whatever remains of the SHARED 1200B after ctx (+ the
// '\n' joiner, spent only when ctx is non-empty) -- normal push takes priority, matching item 3's
// "普通推送 + 再推同现时总上下文 <=1200B(再推让位或截断)"; only lines that actually survive into the
// final packed text are ledgered 'displayed' below -- the rest get 'suppressed'+'cap' (mirrors the
// existing candidates-cap convention at :479's `ledgerRow(m.tag, 'suppressed', 'cap')`).
let repushDisplayedFinal = repushDisplayed;
let repushDroppedByQuota = [];
if (repushDisplayed.length > 0) {
  // 补遗二 §23④: payload = entry's first `What to do instead:` line (prefix stripped), truncated to
  // <=320B on a code-point boundary (ellipsis on truncation); falls back to the title when the entry
  // has no such line. This is an EXPLICIT M4 (M1-precision-gate) exemption scoped only to R2.
  const repushLine = (m) => {
    const base = whatToDo.has(m.tag) ? whatToDo.get(m.tag) : m.title;
    const t = truncateUtf8Bytes(base, 320);
    return '⚠️ 风险时刻再推(刚才的编辑移除了隔离重定向)[' + m.tag + ']: ' + t + (t !== base ? '…' : '');
  };
  const repushEntries = repushDisplayed.map((m) => ({ m, line: repushLine(m) }));
  const joinerLen = ctx ? Buffer.byteLength(ctx, 'utf8') + 1 : 0; // ctx + the '\n' that joins it to repushText
  const repushBudget = Math.max(0, 1200 - joinerLen);

  // drop trailing lines then hard-truncate what remains, same discipline item 20 also gives the C0.5
  // shadow hook (independently implemented here since this is the LIVE hook, not the shadow one) --
  // now against repushBudget (the REMAINDER after ctx) instead of a flat 1200.
  let kept = repushBudget <= 0 ? [] : repushEntries.slice();
  let joined = kept.map((x) => x.line).join('\n');
  let truncated = repushBudget <= 0;
  while (kept.length > 0 && Buffer.byteLength(joined, 'utf8') > repushBudget) {
    kept.pop();
    truncated = true;
    joined = kept.map((x) => x.line).join('\n');
  }
  if (Buffer.byteLength(joined, 'utf8') > repushBudget) { joined = truncateUtf8Bytes(joined, Math.max(0, repushBudget - 1)) + '…'; truncated = true; }
  if (truncated) tlog('quota-truncated', { session, tool, repo, rel, note: 'r2' });

  repushDisplayedFinal = kept.map((x) => x.m);
  repushDroppedByQuota = repushEntries.slice(kept.length).map((x) => x.m);
  if (joined) ctx = ctx ? (ctx + '\n' + joined) : joined;
}
// M4 修复,续(见上面 :516 的头注):budget-consuming 集合 = repushable 去掉被联合配额整条丢弃的那些
// (repushDroppedByQuota,只可能来自 repushDisplayed——policy-shadow 分支的条目从未进入 repushDisplayed/
// repushEntries,不受这里的 quota 裁剪影响,原样计入消耗)。引用相等即可判断成员关系:repushable 循环
// 到 repushDisplayed 到 repushEntries 到 repushDisplayedFinal/repushDroppedByQuota 全程搬运的是同一批
// 对象引用,从未 clone。
const repushBudgetConsumed = repushable.filter((m) => repushDroppedByQuota.indexOf(m) === -1);
try { if (repushBudgetConsumed.length) fs.appendFileSync(seenF, repushBudgetConsumed.map(m => 'repush:' + m.tag).join('\n') + '\n'); } catch {}
if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } }));
// 附录 B1: displayed rows are written strictly AFTER stdout ("在真正写 stdout 之后记") — only the
// directly-injected `inject` tags (the ones that literally occupy a "- [tag] title" line above);
// the one-hop linked/class-member carry-alongs are a different mechanism and are out of this
// spec's literal "matched tag" / "真正注入的 tag" wording, so they are not separately ledgered here.
try { for (const m of inject) ledger.writeEvent(ledgerRow(m.tag, 'displayed'), { root: RECALL_ROOT }); } catch (e) { /* never affect stdout, already written above */ }
// 补遗二 §23 R2: repush rows get their OWN run_provenance suffix (`;repush:R2`, appended to whatever
// the policy resolver returned) so M3 can tell a repush-driven display apart from an ordinary one --
// only the entries that survived the joint quota (repushDisplayedFinal), per the M-8 fix above.
try { for (const m of repushDisplayedFinal) ledger.writeEvent(ledgerRow(m.tag, 'displayed', policyFor(m.tag).provenance + ';repush:R2'), { root: RECALL_ROOT }); } catch (e) { /* never affect stdout, already written above */ }
// M-8 fix: entries the joint quota dropped never appeared in stdout -- ledger them 'suppressed'/'cap'
// instead of silently miscounting them as 'displayed' (this would otherwise pollute M3's layering).
try { for (const m of repushDroppedByQuota) ledger.writeEvent(ledgerRow(m.tag, 'suppressed', 'cap'), { root: RECALL_ROOT }); } catch (e) { /* never affect stdout, already written above */ }
} // end runHook()

if (require.main === module) runHook();

module.exports = { compileTriggerPath, TriggerPatternError, checkTriggerPathB5, testTriggerPath, MAX_CANDIDATE_PATH_LEN };
