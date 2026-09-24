#!/usr/bin/env node
// pmm-shadow-compare.cjs — C05-BUILD-SPEC.md 交付物 2 (影子对照器,五维版 — 补遗三第 28/29 条改写版)。
//
// 只读、只对照,从不改任何权威行为。输入两份日志:
//   - 影子日志(`<resolveHome()>/.claude/.shadow/hook-<mach>.log`,pmm-hook.cjs --shadow 写的 JSON 行,
//     Pre 相含 writer 字段、Post 相含 echo/routing/length/pushSelected 等字段 —— 这些字段名与形状由
//     B1(pmm-hook.cjs)决定,本文件按第 29 条定义的字段名读取,字段缺失/形状不识别时该维记「不可比」,
//     绝不崩溃 —— 见下面 normalizeShadow*() 各函数头注「字段契约」说明);
//   - 旧四 hook 的只读 tee 日志(`<resolveHome()>/.claude/.shadow/legacy-<mach>.log`,PMM_TEE_LOG 环境
//     存在时旧脚本自己追加的 TSV:E-6b(补遗三第 29 条)后为 9 列 —— ts、hook、tool_use_id、trunc、
//     base64(stdout)、sha256(全量 stdout)、rc、base64(stderr ≤1200B)、stderr 截断旗标;E-6b 之前的
//     7 列行仍可解析,但 routing/length 两维退化为只比 rc,见 parseLegacyLog()/7-列兼容 一节)。
//
// 连接键 = tool_use_id(两边都记)。五维 = push(推送)/ writer(写闸)/ echo(回显)/ routing(项目路由)/
// length(写入完整性)。在域矩阵(补遗三第 29 条):Pre×{Edit,Write,MultiEdit}→writer;
// Post×{Edit,Write,MultiEdit}→push/echo/routing/length;Post×NotebookEdit→只有 push。
//
// 09-24 建造实测(本次改写前,见 W4-B3 建造记录):`parseLegacyLog` 此前硬编码只认 7 列,而 E-6b 已把
// 生产 tee 行扩到 9 列 —— 结果是全部 legacy 行被当解析错误丢弃,220 事件回放呈现"仅影子侧有数据"的
// 假象(而不是本行原有注释所说的"tee 从未接线"——tee 早已接线且真实产出了数据,只是这个文件读不懂新
// 格式)。本次改写把 7/9 列兼容作为地基,否则五维对照全部建在一个假前提上。
//
// 09-24 建造实测二(同一时点):写闸/回显/路由/写入完整性四只旧 hook(write-gate、entry-length-watch、
// lessons-routing)目前只有 pmm-trigger-recall 一只被 `pmm-shadow-replay.cjs` 实际起子进程 tee 过——
// 回放器的写面属于另一任务(B3 简报「回放器只在读格式处跟随」),本文件不擅自扩大它的起子进程范围。
// 后果:writer/echo/routing/length 四维在"回放"模式下 legacy 侧永远拿不到数据,不是逐事件异常,是
// 整个会话没接这几只旧 hook —— 用 `dimHookSeenThisRun` 整会话级旗标区分「这次会话根本没起这只旧
// hook」(不算未解释,只降级为不可比/无数据)与「这只旧 hook 起过、但单单这一事件没留下行」(真信号,
// 算未解释)。没有这层区分,折入未解释会把"回放器暂不起这三只 hook"的已知边界误判成几百条假红。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const core = require('./pmm-core.cjs');
const ledger = require('./pmm-recall-ledger.cjs');

// ── 家目录/机器名(与 pmm-hook.cjs 同一套解析纪律;唯一直读 HOME/USERPROFILE/PMM_HOME 的是
//    ledger.resolveHome()) ──────────────────────────────────────────────────────────────────────
function resolveHomeNorm() { return ledger.resolveHome().replace(/\\/g, '/'); }
function mach() { return (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12); }

function defaultShadowLogPath(home) { return home + '/.claude/.shadow/hook-' + mach() + '.log'; }
function defaultLegacyLogPath(home) { return home + '/.claude/.shadow/legacy-' + mach() + '.log'; }

// ── git 可疑所有权护栏(M9, Opus wave-2 review `guards/audits/OPUS-2026-09-24-c05-wave2-review.md`)──
// Under the isolation callers are required to use (HOME=$T USERPROFILE=$T PMM_HOME=$T <cmd>), git
// looks for its safe.directory exception in $HOME/.gitconfig — which no longer exists once HOME points
// at T, even though the REAL root already has that exception configured. Every git call this file
// makes is a read-only `-C <repoRoot>` invocation against a repo this process was explicitly handed
// (never one discovered by walking up from cwd), so it is always safe to grant exactly that one path —
// GIT_CONFIG_COUNT/KEY_0/VALUE_0 supplies a single, PRECISE safe.directory entry via the environment
// (git >=2.32), scoped to this process only, without touching any gitconfig file on disk and without
// the blanket "trust every repo" wildcard (`GIT_CONFIG_VALUE_0='*'`) pmm-index-emit.cjs's own B4 fix
// uses — the audit specifically calls that out as over-permissive for a tool whose repoRoot argument
// isn't always the real, trusted root (a --repo override could point anywhere).
function gitSafeEnv(repoRoot) {
  const rr = String(repoRoot).replace(/\\/g, '/');
  return Object.assign({}, process.env, {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: rr,
  });
}

// ── OID 钉住(补遗一第 12 条)────────────────────────────────────────────────────────────────────
function pinMemoryOid(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD:.claude/memory'], { encoding: 'utf8', env: gitSafeEnv(repoRoot) }).trim();
}

// git archive <oid> 导出 .claude/memory 树到 destMemDir(只读来源;destMemDir 全新建,从不写回仓库)。
function archiveCorpus(repoRoot, oid, destMemDir) {
  fs.mkdirSync(destMemDir, { recursive: true });
  const tarPath = destMemDir.replace(/[\\/]+$/, '') + '.archive-' + crypto.randomBytes(4).toString('hex') + '.tar';
  try {
    execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', '-o', tarPath, oid], { env: gitSafeEnv(repoRoot) });
    // --force-local: GNU tar (Git-for-Windows' bundled tar) otherwise parses a `C:/...` destination as
    // a `host:path` remote-shell spec (the colon after the drive letter looks like rsh/ssh syntax) and
    // fails with "tar: Cannot connect to C: resolve failed" -- this flag pins both paths to the local
    // filesystem regardless of how many colons they contain.
    execFileSync('tar', ['--force-local', '-xf', tarPath, '-C', destMemDir]);
  } finally {
    try { fs.rmSync(tarPath, { force: true }); } catch { /* best effort */ }
  }
}

// 在一个已经落盘的 memDir(例如 archiveCorpus 的输出,或回放器自己 isoEnv 根下的 .claude/memory)上跑
// core.snapshot('worktree') + core.analyze()。绝不修改 process.env 之外的全局状态;PMM_MEM_DIR 用完即还原。
function analyzeMemDir(memDir) {
  const saved = process.env.PMM_MEM_DIR;
  process.env.PMM_MEM_DIR = memDir;
  try {
    const snap = core.snapshot('worktree');
    return { analyzed: core.analyze(snap, {}), error: null };
  } catch (e) {
    return { analyzed: null, error: e };
  } finally {
    if (saved === undefined) delete process.env.PMM_MEM_DIR; else process.env.PMM_MEM_DIR = saved;
  }
}

// 便捷组合:钉住的 OID → 临时 archive → analyze → 清理临时目录。用于「实时」模式的分类语料。
function loadAnalyzedAt(repoRoot, oid) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-shadow-cmp-corpus-'));
  const memDir = T + '/mem';
  try {
    archiveCorpus(repoRoot, oid, memDir);
    return analyzeMemDir(memDir);
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── 影子日志解析(JSON 行,来自 pmm-hook.cjs --shadow)────────────────────────────────────────────
function parseShadowLog(text) {
  const rows = [];
  let parseErrors = 0;
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    let obj;
    try { obj = JSON.parse(l); } catch { parseErrors++; continue; }
    if (!obj || typeof obj !== 'object') { parseErrors++; continue; }
    rows.push(obj);
  }
  return { rows, parseErrors };
}

// ── 旧 hook tee 日志解析:9 列(E-6b)为主,7 列(E-6b 之前)向后兼容 ──────────────────────────────
// 9 列: ts、hook、tool_use_id、trunc、base64(stdout)、sha256(全量 stdout)、rc、base64(stderr≤1200B)、
//       stderr 截断旗标。7 列(旧格式,无 stderr 两列):routing/length 两维在该行上退化为只比 rc
//       (补遗三第 29 条「对照器同时接受 7 列与 9 列;7 列行的 routing/length 只比 rc」)。
function parseLegacyLog(text) {
  const rows = [];
  let parseErrors = 0;
  const lines = String(text || '').split('\n');
  for (const l of lines) {
    if (!l) continue;
    const f = l.split('\t');
    if (f.length !== 7 && f.length !== 9) { parseErrors++; continue; }
    const [ts, hook, toolUseIdRaw, truncRaw, b64, shaExpected, rcRaw, errB64Raw, errTruncRaw] = f;
    const toolUseId = toolUseIdRaw === '-' ? '' : toolUseIdRaw;
    const trunc = truncRaw === '1';
    let stdoutBuf = Buffer.alloc(0);
    let decodeOk = true;
    try { stdoutBuf = Buffer.from(b64 === '-' ? '' : b64, 'base64'); } catch { decodeOk = false; }
    // trunc=0 时可以核验完整性;trunc=1 时解码出的只是前 1200B,sha 对不上是预期行为,不当错误。
    const shaOfDecoded = crypto.createHash('sha256').update(stdoutBuf).digest('hex');
    const shaVerified = !trunc && decodeOk && shaOfDecoded === shaExpected;

    const cols = f.length;
    let stderrTrunc = null, stderrDecodeOk = null, stderrText = '';
    if (cols === 9) {
      stderrTrunc = errTruncRaw === '1';
      let errBuf = Buffer.alloc(0);
      stderrDecodeOk = true;
      try { errBuf = Buffer.from(errB64Raw === '-' ? '' : errB64Raw, 'base64'); } catch { stderrDecodeOk = false; }
      stderrText = stderrDecodeOk ? errBuf.toString('utf8') : '';
    }

    rows.push({
      ts, hook, toolUseId, cols, trunc, decodeOk, shaExpected, shaOfDecoded, shaVerified,
      rc: Number(rcRaw), stdoutText: decodeOk ? stdoutBuf.toString('utf8') : '',
      stderrTrunc, stderrDecodeOk, stderrText,
    });
  }
  return { rows, parseErrors };
}

// ── 旧 hook 身份正则(四只) ──────────────────────────────────────────────────────────────────────
const HOOK_RECALL_RE = /pmm-trigger-recall\.(sh|cjs)$/;
const HOOK_WRITEGATE_RE = /pmm-trigger-write-gate\.(sh|cjs)$/;
const HOOK_LENGTH_RE = /pmm-entry-length-watch\.sh$/;
const HOOK_ROUTING_RE = /pmm-lessons-routing\.sh$/;

// ── 工具集(settings.json 实测接线;domainAndRows() 用它判在域)──────────────────────────────────
const PUSH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ELR_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']); // writer/echo/routing/length 共用

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// push 维(推送 tag 集合)—— 生产者 pmm-trigger-recall.cjs:600-663
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// 通用括号扫描(仍用于写闸 legacy 侧的兜底解析,见 writer 维);push 维改用下面的行锚定提取。
const TAG_BRACKET_RE = /\[([a-zA-Z][\w.:-]*)\]/g;
function extractTagsFromContext(text) {
  const set = new Set();
  let ctx = String(text || '');
  try {
    const parsed = JSON.parse(ctx);
    if (parsed && parsed.hookSpecificOutput) {
      const hso = parsed.hookSpecificOutput;
      if (typeof hso.additionalContext === 'string') ctx = hso.additionalContext;
      else if (typeof hso.permissionDecisionReason === 'string') ctx = hso.permissionDecisionReason;
    }
  } catch { /* fall through to raw-text regex below */ }
  TAG_BRACKET_RE.lastIndex = 0;
  let m;
  while ((m = TAG_BRACKET_RE.exec(ctx))) set.add(m[1]);
  return set;
}

// MEDIUM-1 修复(wave3-review):旧正则要求 "↳ [" 紧邻,但生产者(pmm-trigger-recall.cjs:609)实际输出
// 的是 "↳ 同类成员 [tag]" 或 "↳ 关联(较旧) [tag]"/"↳ 关联 [tag]" —— ↳ 与 [ 之间总有中文标签,旧正则
// 对真实行 100% 提取失败(全盲)。R2 再推行(:632,"⚠️ 风险时刻再推…[tag]:")单独一路提取,归入允许类
// r2-repush(补遗三第 29 条「push」小节)。
const LINE_DIRECT_TAG_RE = /^- \[([a-zA-Z][\w.:-]*)\]/;
const LINE_LINKED_TAG_RE = /^\s+↳ (?:同类成员|关联(?:\([^)]*\))?) \[([a-zA-Z][\w.:-]*)\]/;
const LINE_R2REPUSH_TAG_RE = /^⚠️ 风险时刻再推.*?\[([a-zA-Z][\w.:-]*)\]/;
function extractPushTagLines(text) {
  let ctx = String(text || '');
  try {
    const parsed = JSON.parse(ctx);
    if (parsed && parsed.hookSpecificOutput) {
      const hso = parsed.hookSpecificOutput;
      if (typeof hso.additionalContext === 'string') ctx = hso.additionalContext;
      else if (typeof hso.permissionDecisionReason === 'string') ctx = hso.permissionDecisionReason;
    }
  } catch { /* truncated/non-JSON tail — scan whatever text is there line-by-line below */ }
  const direct = new Set(), linked = new Set(), r2 = new Set();
  for (const line of ctx.split('\n')) {
    let m;
    if ((m = LINE_DIRECT_TAG_RE.exec(line))) { direct.add(m[1]); continue; }
    if ((m = LINE_LINKED_TAG_RE.exec(line))) { linked.add(m[1]); continue; }
    if ((m = LINE_R2REPUSH_TAG_RE.exec(line))) { r2.add(m[1]); continue; }
  }
  return { direct, linked, r2 };
}

// 影子侧「若为权威会推送的 tag 集合」—— 与 pmm-hook.cjs 自己打包 additionalContext 时用的过滤规则
// 完全一致(policy-shadow 臂的候选从不进最终载荷,见 pmm-hook.cjs:406 的 packCandidates 调用)。
function shadowPushTagSet(row) {
  const set = new Set();
  for (const c of ((row && row.pushSelected) || [])) {
    if (c && c.provenance === 'policy:randomized' && c.arm === 'shadow') continue;
    if (c && c.source === 'class-count') { if (c.classTag) set.add(c.classTag); continue; }
    if (c && c.tag) set.add(c.tag);
  }
  return set;
}

function preTruncationTagSet(row) {
  const set = new Set();
  for (const c of ((row && row.pushCandidatesPreTruncation) || [])) {
    if (!c) continue;
    if (c.source === 'class-count') { if (c.classTag) set.add(c.classTag); continue; }
    if (c.tag) set.add(c.tag);
  }
  return set;
}

// 差异分类(push 专属允许类别;判不进去的一律「未解释」,宁可少归类、不多归类)。
function classifyPushDiff(tag, direction, shadowRow, byId, legacyKinds) {
  // r2-repush(补遗三第 29 条「push」):R2 再推行的形态,legacy 独有,归入允许类,不需要语料上下文。
  if (direction === 'legacy-only' && legacyKinds && legacyKinds.r2 && legacyKinds.r2.has(tag)) return 'r2-repush';
  if (!byId) return 'no-corpus-context';
  if (direction === 'legacy-only') {
    if (shadowRow && shadowRow.quotaTruncated && preTruncationTagSet(shadowRow).has(tag)) return 'quota';
    const onLinkedLine = !!(legacyKinds && legacyKinds.linked.has(tag) && !legacyKinds.direct.has(tag));
    if (onLinkedLine) {
      for (const c of ((shadowRow && shadowRow.pushSelected) || [])) {
        if (c && c.source === 'class-count' && byId.has(tag)) {
          const e = byId.get(tag);
          if (e && e.class === c.classTag) return 'v3-class-count-not-members';
        }
      }
    }
    if (onLinkedLine) {
      for (const c of ((shadowRow && shadowRow.pushSelected) || [])) {
        if (!c || c.source !== 'direct') continue;
        const e = byId.get(c.tag);
        if (e && Array.isArray(e.links) && e.links.includes(tag)) return 'v3-untyped-link-not-carried';
      }
    }
    return 'unexplained';
  }
  for (const c of ((shadowRow && shadowRow.pushSelected) || [])) {
    if (c && c.source === 'class-count' && c.classTag === tag) return 'v3-class-count-not-members';
  }
  return 'unexplained';
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// writer 维(写闸)—— 补遗三第 28 条;legacy 侧 = pmm-trigger-write-gate.cjs:83,212-266 的 deny 文案
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const WRITER_B5B32_HEADER_RE = /^pmm-trigger-write-gate:/;
const WRITER_PRESENCE_HEADER_RE = /^pmm-trigger-presence-gate:/;
const WRITER_B5B32_BULLET_RE = /^ {2}- \[([A-Za-z0-9]+)\] L(\d+):/;
const WRITER_PRESENCE_BULLET_RE = /^ {2}- \[(.+)\]$/;
const WRITER_B5B32_TOTAL_RE = /含 (\d+) 处问题/;
const WRITER_PRESENCE_TOTAL_RE = /新增了 (\d+) 条条目/;
const WRITER_DISABLED_RE = /PMM_TRIGGER_WRITE_GATE_DISABLE=1/;

// legacy 侧解析:deny() 把整段 JSON 写在 stdout(exit 恒 0 — permissionDecision 字段本身就是判定,不是
// rc),bullet 已由生产者自己截到前 5 条(`bad.slice(0,5)`/`missing.slice(0,5)`),总数取文案里的
// 「含 N 处」/「新增了 N 条」。basename 由调用方传入(取自同 tuid 的影子 Pre 行 rel 字段的 basename,
// legacy tee 行本身不带文件身份)。
function parseLegacyWriterDenyText(rawStdoutText, basename) {
  if (!rawStdoutText) return { kind: 'none', keys: [], total: 0 };
  let reason = '';
  try {
    const parsed = JSON.parse(rawStdoutText);
    reason = (parsed && parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.permissionDecisionReason === 'string')
      ? parsed.hookSpecificOutput.permissionDecisionReason : '';
  } catch { return { kind: 'parse-error', keys: [], total: 0 }; }
  if (!reason) return { kind: 'none', keys: [], total: 0 };
  const lines = reason.split('\n');
  const firstLine = lines[0] || '';
  if (WRITER_B5B32_HEADER_RE.test(firstLine)) {
    const totalM = reason.match(WRITER_B5B32_TOTAL_RE);
    const total = totalM ? Number(totalM[1]) : 0;
    const keys = [];
    for (const l of lines) {
      const m = WRITER_B5B32_BULLET_RE.exec(l);
      if (m) keys.push(m[1] + '|' + basename + '|L' + m[2]);
    }
    return { kind: 'b5b32', keys, total };
  }
  if (WRITER_PRESENCE_HEADER_RE.test(firstLine)) {
    const totalM = reason.match(WRITER_PRESENCE_TOTAL_RE);
    const total = totalM ? Number(totalM[1]) : 0;
    const keys = [];
    for (const l of lines) {
      const m = WRITER_PRESENCE_BULLET_RE.exec(l);
      if (m) keys.push('presence|' + basename + '|' + m[1]);
    }
    return { kind: 'presence', keys, total };
  }
  return { kind: 'unknown', keys: [], total: 0 };
}

// 影子字段契约(HIGH-2 修复,wave4 复审 `guards/audits/OPUS-2026-09-24-c05-wave4-review.md`;读字段名
// `row.writer`;字段缺失/形状不识别 → 返回 null → 该事件 writer 维记「不可比」,不崩溃):
//   row.writer === undefined | null                     -> 未实现/未计算 -> null
//   row.writer = { disabled: true }                      -> 旧闸停用镜像 -> {disabled:true, keys:[], total:0}
//   row.writer = { keys: string[], total?: number }      -> 退化/测试形态
//   row.writer = string[]                                 -> 退化形态(直接当 keys,total=length)
//   row.writer = { b5b32Keys, b5b32Total, presenceKeys, presenceTotal, parseFailed? } -> B1 真实生产者
//     形状(pmm-hook.cjs:310 computeWriterDimension 的原样返回值)。B5/B32 与 presence 两支由生产者自己
//     短路互斥(非空的只会是其中一支,parseFailed 时两支皆空)——直接拼接 keys/合计 total 即得旧闸口径
//     的单一 {keys,total} 对,不需要另外分辨"这次到底是哪一支"(processWriter 只比 keys 集合与 total,
//     不看 kind)。这是 wave4 审计实证的三处"对真生产形状全返 null"之一:此前只认 {keys,total}/数组,
//     B1 出的 {b5b32Keys,...} 全部落空返回 null,活体 writer 可比恒为 0。
function normalizeShadowWriter(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return { disabled: false, keys: v.map(String), total: v.length };
  if (typeof v === 'object') {
    if (v.disabled) return { disabled: true, keys: [], total: 0 };
    if (Array.isArray(v.keys)) return { disabled: false, keys: v.keys.map(String), total: (typeof v.total === 'number' ? v.total : v.keys.length) };
    if (Array.isArray(v.b5b32Keys) || Array.isArray(v.presenceKeys)) {
      const b5 = v.b5b32Keys || [], pr = v.presenceKeys || [];
      const keys = [...b5, ...pr].map(String);
      const total = (typeof v.b5b32Total === 'number' ? v.b5b32Total : b5.length)
        + (typeof v.presenceTotal === 'number' ? v.presenceTotal : pr.length);
      return { disabled: false, keys, total };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// echo 维(写入关联回显)—— 补遗三第 29 条;legacy 侧 = pmm-write-echo.cjs:49-61 的输出行(经
// entry-length-watch --block 通过校验后在同一 stdout 里追加)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const ECHO_SUPERSEDED_RE = /^- \[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\] .*⚠️ 已被 \[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\] .*取代/;
const ECHO_UNKNOWN_RE = /^- \[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\] 未在记忆库/;
const ECHO_CURRENT_RE = /^- \[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\] .*\(现行\)\s*$/;
const ECHO_SUP_MARKED_RE = /^- 你声明取代 \[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\] .*旧条 Index 标记 ✓/;
const ECHO_SUP_UNMARKED_RE = /^- 你声明取代 \[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\] .*旧条 Index 标记 ✗/;

// 返回 Set<"tag|状态">,状态 ∈ {未在记忆库, 已被[X]取代, 现行, 已标记, 未标记}(补遗三第 29 条原文枚举,
// X 替换为实际取代目标 tag)。
// HIGH-3 修复(wave4 复审):空/纯空白 stdout(entry-length-watch --block 校验通过但没有可回显的
// [[引用]]——rc=0 时最常见的 case)→ 空集(与影子侧「没算出任何回显」同为「空」,理应 match,不是
// corrupt)。此前 `JSON.parse('')` 抛错直接返回 null,被 processEcho 的 `legacySet === null` 分支当
// tee-corrupt 计入「可比+未解释」——活体窗口实证 107 条假未解释由此产生(占 totalUnexplained 111 的
// 绝大头,wave4 审计原文)。null 现在只留给"非空但不可解析"的 stdout(理论上不该发生于真实 rc=0 行,
// 但仍需一个信号区分"真损坏"与"合法地什么都没有")。
function extractLegacyEcho(stdoutText) {
  const raw = stdoutText == null ? '' : String(stdoutText);
  if (raw.trim() === '') return new Set();
  let ctx = '';
  try {
    const parsed = JSON.parse(raw);
    ctx = (parsed && parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === 'string')
      ? parsed.hookSpecificOutput.additionalContext : '';
  } catch { return null; }
  const set = new Set();
  for (const line of ctx.split('\n')) {
    let m;
    if ((m = ECHO_SUPERSEDED_RE.exec(line))) { set.add(m[1] + '|已被[' + m[2] + ']取代'); continue; }
    if ((m = ECHO_UNKNOWN_RE.exec(line))) { set.add(m[1] + '|未在记忆库'); continue; }
    if ((m = ECHO_CURRENT_RE.exec(line))) { set.add(m[1] + '|现行'); continue; }
    if ((m = ECHO_SUP_MARKED_RE.exec(line))) { set.add(m[1] + '|已标记'); continue; }
    if ((m = ECHO_SUP_UNMARKED_RE.exec(line))) { set.add(m[1] + '|未标记'); continue; }
  }
  return set;
}

// 影子字段契约:row.echo — undefined/null -> 未实现 -> null;数组 -> 每项可以是
// "tag|status" 字符串、[tag,status] 二元组、或 {tag,status} 对象,统一折成 Set<"tag|status">。
// 形状不识别的整个字段(非数组)-> null(不可比,不崩溃)。
function normalizeShadowEcho(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  const set = new Set();
  for (const item of v) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') { set.add(item); continue; }
    if (Array.isArray(item) && item.length >= 2) { set.add(String(item[0]) + '|' + String(item[1])); continue; }
    if (typeof item === 'object' && item.tag != null && item.status != null) { set.add(String(item.tag) + '|' + String(item.status)); continue; }
  }
  return set;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// routing 维(项目路由)—— legacy 侧 = pmm-lessons-routing.sh:63 的 `grep -n` 命中行(<行号>:<标题行>)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
function extractRoutingHits(stderrText) {
  const set = new Set();
  for (const line of String(stderrText || '').split('\n')) {
    const m = /^(\d+):(.*)$/.exec(line);
    if (m) set.add(m[1] + ':' + m[2]);
  }
  return set;
}
// 影子字段契约(HIGH-2 修复):row.routing — undefined/null -> null;数组(退化/测试形态)-> 每项
// "<行号>:<标题>" 字符串或 {line,title} 对象,折成同形态字符串;
// row.routing = { rc, hits: string[] } -> B1 真实生产者形状(pmm-hook.cjs:395/406
// computeRoutingDimension 的原样返回值——hits 已是 `(行号)+':'+行文本` 形态,与
// extractRoutingHits() 对 legacy stderr 的 `grep -n` 输出解析结果同一格式,逐项直收)。非数组、
// 非带 hits 数组的对象 -> null。
function normalizeShadowRouting(v) {
  if (v === null || v === undefined) return null;
  let arr = null;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'object' && Array.isArray(v.hits)) arr = v.hits;
  if (arr === null) return null;
  const set = new Set();
  for (const item of arr) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') { set.add(item); continue; }
    if (typeof item === 'object' && item.line != null && item.title != null) { set.add(String(item.line) + ':' + String(item.title)); continue; }
  }
  return set;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// length 维(写入完整性)—— legacy 侧 = pmm-entry-length-watch.sh:271-310 的 `⚠️ <检查名>` 行,
// 11 项检查类(补遗三第 29 条原文枚举,标签逐字保留原文的空格写法)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const LENGTH_CHECK_PATTERNS = [
  [/^⚠️ 新增超长条目/, '超长净增'],
  [/^⚠️ 新增超长 Index 行/, 'Index 超长净增'],
  [/^⚠️ 原话引用/, '原话引用'],
  [/^⚠️ Index 奇偶不平/, 'Index 奇偶'],
  [/^⚠️ 孤儿日期列表块/, '孤儿块'],
  [/^⚠️ 伪装条目标题/, '伪装标题'],
  [/^⚠️ 引用缺命名空间/, '缺命名空间'],
  [/^⚠️ 取代记账缺失/, '取代记账'],
  [/^⚠️ 取代图不变量违规/, '取代图'],
  [/^⚠️ 冗余闸/, '冗余'],
  [/^⚠️ progress\.md 的 ## Active/, 'Active 体积'],
];
function extractLengthChecks(stderrText) {
  const set = new Set();
  for (const line of String(stderrText || '').split('\n')) {
    for (const [re, label] of LENGTH_CHECK_PATTERNS) if (re.test(line)) { set.add(label); break; }
  }
  return set;
}
// 影子字段契约(HIGH-2 修复):row.length — undefined/null -> null;数组(退化/测试形态,字符串,取自
// 上面 11 项标签集合的子集);row.length = { classes: string[], notComputed, detail, baselineAvailable,
// rc } -> B1 真实生产者形状(pmm-hook.cjs:554/602 computeLengthDimension 的原样返回值——classes 已是
// 上面 11 项标签集合的子集,标签字符串逐字相同,直收)。非数组、非带 classes 数组的对象 -> null。
function normalizeShadowLength(v) {
  if (v === null || v === undefined) return null;
  let arr = null;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'object' && Array.isArray(v.classes)) arr = v.classes;
  if (arr === null) return null;
  const set = new Set();
  for (const item of arr) if (typeof item === 'string') set.add(item);
  return set;
}

function compareSets(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ── 五维下限(补遗三第 29 条「「零未解释」生效条件」,主脑裁决采纳报告第 162 行建议值)────────────
const ZERO_UNEXPLAINED_THRESHOLDS = {
  push: { comparable: 100, nonEmpty: 30 },
  writer: { comparable: 30, nonEmpty: 0 },
  echo: { comparable: 30, nonEmpty: 10 },
  routing: { comparable: 100, nonEmpty: 0 },
  length: { comparable: 100, nonEmpty: 0 },
};

// ── 接线窗口白名单(CHANGELOG 登记的 [起,止] UTC 区间;补遗三第 29 条「配对」小节)。格式约定(供未来
// 登记者参照):CHANGELOG.md 里以 `WIRING-WINDOW: <dim> [<startISO>, <endISO>]` 起行的行,一行一条。
// 当前 CHANGELOG 没有任何登记 -> 返回空数组,白名单为空是诚实的默认值,不是本文件没实现。
function loadWiringWindows(repoRoot) {
  const windows = [];
  let text = '';
  try { text = fs.readFileSync(path.join(repoRoot, '.claude', 'CHANGELOG.md'), 'utf8'); } catch { return windows; }
  const re = /^WIRING-WINDOW:\s*(\S+)\s*\[\s*([^,]+?)\s*,\s*([^\]]+?)\s*\]/;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const start = Date.parse(m[2]), end = Date.parse(m[3]);
    if (Number.isFinite(start) && Number.isFinite(end)) windows.push({ dim: m[1], start, end });
  }
  return windows;
}
function inWiringWindow(windows, dim, tsIso) {
  const t = Date.parse(tsIso);
  if (!Number.isFinite(t)) return false;
  for (const w of windows) if ((w.dim === dim || w.dim === '*') && t >= w.start && t <= w.end) return true;
  return false;
}

// ── 差异分类允许集(push 专属;写闸/回显/路由/写入完整性四维没有 spec 定义的豁免子分类,任何不等
//    都直接算未解释)────────────────────────────────────────────────────────────────────────────
const ALLOWED_PUSH_CATS = new Set(['quota', 'v3-class-count-not-members', 'v3-untyped-link-not-carried', 'r2-repush']);

function newDimAcc() { return { inDomain: 0, incomparable: 0, comparable: 0, nonEmpty: 0 }; }

// ── 主对照:按 tool_use_id 连接影子行与 legacy tee 行,五维逐项比较 ────────────────────────────────
// opts.repoRoot: 用于读 CHANGELOG 接线窗口(可选,live CLI 传;回放/自测可不传,白名单为空)。
function compareEvents(input) {
  const shadowRows = (input && input.shadowRows) || [];
  const legacyRows = (input && input.legacyRows) || [];
  const analyzed = input && input.analyzed;
  const byId = analyzed ? new Map(analyzed.entries.map((e) => [e.id, e])) : null;
  const wiringWindows = (input && input.repoRoot) ? loadWiringWindows(input.repoRoot) : [];

  const bashSkippedShadow = shadowRows.filter((r) => r && r.tool === 'Bash').length;
  const shadowUsable = shadowRows.filter((r) => !r || r.tool !== 'Bash');

  const shadowByTuid = new Map();
  const shadowNoTuid = [];
  for (const r of shadowUsable) {
    const tuid = r && r.tool_use_id;
    if (!tuid) { shadowNoTuid.push(r); continue; }
    if (!shadowByTuid.has(tuid)) shadowByTuid.set(tuid, []);
    shadowByTuid.get(tuid).push(r);
  }
  const legacyByTuid = new Map();
  const legacyNoTuid = [];
  for (const r of legacyRows) {
    if (!r.toolUseId) { legacyNoTuid.push(r); continue; }
    if (!legacyByTuid.has(r.toolUseId)) legacyByTuid.set(r.toolUseId, []);
    legacyByTuid.get(r.toolUseId).push(r);
  }

  // H2 ⑤(不变,沿用):无 tool_use_id 的行不做 ts±2s 兜底配对 —— 会在两个不同并发会话之间瞎配,
  // 制造出凭空的"未解释"。fallbackPairs 永远为空,保留字段只为报告格式稳定。
  const fallbackPairs = [];
  const unmatchedShadowNoTuid = shadowNoTuid.length;
  const unmatchedLegacyNoTuid = legacyNoTuid.length;

  // ── 整会话级「这只旧 hook 到底有没有被起过」旗标(见文件头注「建造实测二」)。────────────────────
  const dimHookSeenThisRun = { push: false, writer: false, echo: false, routing: false, length: false };
  for (const r of legacyRows) {
    const h = r.hook || '';
    if (HOOK_RECALL_RE.test(h)) dimHookSeenThisRun.push = true;
    else if (HOOK_WRITEGATE_RE.test(h)) dimHookSeenThisRun.writer = true;
    else if (HOOK_LENGTH_RE.test(h)) { dimHookSeenThisRun.echo = true; dimHookSeenThisRun.length = true; }
    else if (HOOK_ROUTING_RE.test(h)) dimHookSeenThisRun.routing = true;
  }

  const dimStats = { push: newDimAcc(), writer: newDimAcc(), echo: newDimAcc(), routing: newDimAcc(), length: newDimAcc() };
  const categoryCounts = Object.create(null);
  const samples = Object.create(null);
  function bumpCategory(cat, sample) {
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    if (!samples[cat]) samples[cat] = [];
    if (samples[cat].length < 5) samples[cat].push(sample);
  }

  let echoGatedOffCount = 0;
  let pushBothSidesEvents = 0, pushMatchEvents = 0, pushDiffEvents = 0;
  let pushShadowOnlyEvents = 0, pushLegacyOnlyEvents = 0;
  const dimMatch = { writer: 0, echo: 0, routing: 0, length: 0 };
  const dimDiff = { writer: 0, echo: 0, routing: 0, length: 0 };

  // domainAndRows: 结构化判定「这个 tuid 对这一维是否在域」,以及两侧各自是否真有一行数据。
  // sRow 存在时用它的 tool 字段判在域(最可靠 — 来自权威 hook 自己记的 tool_name);sRow 不存在时靠
  // legacyRow 的存在本身证明在域(旧 hook 的 matcher 已经把工具集卡死,settings.json 实测见文件头)。
  function domainAndRows(sRow, legacyRow, toolSet) {
    if (sRow) {
      if (!toolSet.has(sRow.tool)) return { inDomain: false };
      return { inDomain: true, shadowRowExists: true, legacyRowExists: !!legacyRow };
    }
    if (legacyRow) return { inDomain: true, shadowRowExists: false, legacyRowExists: true };
    return { inDomain: false };
  }

  // 一侧有行、另一侧没有 = 未解释(补遗三第 29 条「配对」),但 legacy 侧「没有」要先排除「这只旧 hook
  // 整个会话都没被起过」这个已知边界(否则会把会话级缺口误判成几百条逐事件未解释 —— 见文件头注)。
  function oneSided(dim, tuid, tsForWindow, direction) {
    // 真空绿必红:「本次会话这只旧 hook 根本没被起过」不是一次真比较(没有 legacy 数据可比),把它计进
    // 可比/非空会让「零未解释生效」门槛被会话结构性缺口喂饱,而不是被真实比对喂饱 —— 记不可比,不进
    // 未解释,也不进可比/非空(09-24 建造实测三:220 事件真实回放里 echo/routing/length 三维在这条分支
    // 修正前呈现「可比=220 非空=220 但 match=0 diff=0」的假绿,根因就是这里)。
    if (direction === 'legacy-missing' && !dimHookSeenThisRun[dim]) { dimStats[dim].incomparable++; return; }
    dimStats[dim].comparable++;
    dimStats[dim].nonEmpty++;
    if (inWiringWindow(wiringWindows, dim, tsForWindow)) return; // CHANGELOG 登记的接线窗口白名单
    bumpCategory('one-sided:' + dim + ':' + direction, { tuid });
  }

  function processPush(tuid, sRow, legacyRow) {
    const d = domainAndRows(sRow, legacyRow, PUSH_TOOLS);
    if (!d.inDomain) return;
    dimStats.push.inDomain++;
    if (d.shadowRowExists && !d.legacyRowExists) { pushShadowOnlyEvents++; oneSided('push', tuid, sRow && sRow.ts, 'legacy-missing'); return; }
    if (!d.shadowRowExists && d.legacyRowExists) { pushLegacyOnlyEvents++; oneSided('push', tuid, legacyRow && legacyRow.ts, 'shadow-missing'); return; }
    // 双侧都有行
    if (legacyRow.trunc) { dimStats.push.incomparable++; return; }
    if (!legacyRow.shaVerified) { dimStats.push.comparable++; bumpCategory('tee-corrupt:push', { tuid }); return; }
    dimStats.push.comparable++;
    pushBothSidesEvents++;
    const sSet = shadowPushTagSet(sRow);
    const legacyKinds = extractPushTagLines(legacyRow.stdoutText);
    const lSet = new Set([...legacyKinds.direct, ...legacyKinds.linked, ...legacyKinds.r2]);
    if (sSet.size > 0 || lSet.size > 0) dimStats.push.nonEmpty++;
    let anyDiff = false;
    for (const tag of sSet) if (!lSet.has(tag)) {
      anyDiff = true;
      const cat = classifyPushDiff(tag, 'shadow-only', sRow, byId, legacyKinds);
      bumpCategory(cat, { tuid, tag, direction: 'shadow-only' });
    }
    for (const tag of lSet) if (!sSet.has(tag)) {
      anyDiff = true;
      const cat = classifyPushDiff(tag, 'legacy-only', sRow, byId, legacyKinds);
      bumpCategory(cat, { tuid, tag, direction: 'legacy-only' });
    }
    if (anyDiff) pushDiffEvents++; else pushMatchEvents++;
  }

  function processWriter(tuid, sPreRow, legacyRow) {
    const d = domainAndRows(sPreRow, legacyRow, ELR_TOOLS);
    if (!d.inDomain) return;
    dimStats.writer.inDomain++;
    if (d.shadowRowExists && !d.legacyRowExists) { oneSided('writer', tuid, sPreRow && sPreRow.ts, 'legacy-missing'); return; }
    if (!d.shadowRowExists && d.legacyRowExists) { oneSided('writer', tuid, legacyRow && legacyRow.ts, 'shadow-missing'); return; }
    if (legacyRow.trunc) { dimStats.writer.incomparable++; return; }
    if (!legacyRow.shaVerified) { dimStats.writer.comparable++; bumpCategory('tee-corrupt:writer', { tuid }); return; }
    if (WRITER_DISABLED_RE.test(legacyRow.stderrText || '')) { dimStats.writer.incomparable++; return; } // 旧闸停用逃生口
    const basename = (sPreRow && sPreRow.rel) ? path.basename(sPreRow.rel) : null;
    if (!basename) { dimStats.writer.incomparable++; return; }
    const shadowNorm = normalizeShadowWriter(sPreRow.writer);
    if (shadowNorm === null || shadowNorm.disabled) { dimStats.writer.incomparable++; return; }
    const legacyParsed = parseLegacyWriterDenyText(legacyRow.stdoutText, basename);
    dimStats.writer.comparable++;
    const legacyNonEmpty = legacyParsed.total > 0;
    const shadowNonEmpty = shadowNorm.total > 0;
    if (legacyNonEmpty || shadowNonEmpty) dimStats.writer.nonEmpty++;
    const same = legacyParsed.total === shadowNorm.total && compareSets(new Set(legacyParsed.keys), new Set(shadowNorm.keys));
    if (same) dimMatch.writer++; else { dimDiff.writer++; bumpCategory('writer-mismatch', { tuid, legacy: legacyParsed, shadow: shadowNorm }); }
  }

  function processEcho(tuid, sPostRow, legacyLenRow) {
    const d = domainAndRows(sPostRow, legacyLenRow, ELR_TOOLS);
    if (!d.inDomain) return;
    dimStats.echo.inDomain++;
    if (d.shadowRowExists && !d.legacyRowExists) { oneSided('echo', tuid, sPostRow && sPostRow.ts, 'legacy-missing'); return; }
    if (!d.shadowRowExists && d.legacyRowExists) { oneSided('echo', tuid, legacyLenRow && legacyLenRow.ts, 'shadow-missing'); return; }
    if (legacyLenRow.trunc) { dimStats.echo.incomparable++; return; }
    if (legacyLenRow.rc === 2) { dimStats.echo.incomparable++; echoGatedOffCount++; return; } // echo-gated-off,不比较,单列计数
    if (!legacyLenRow.shaVerified) { dimStats.echo.comparable++; bumpCategory('tee-corrupt:echo', { tuid }); return; }
    const shadowSet = normalizeShadowEcho(sPostRow.echo);
    if (shadowSet === null) { dimStats.echo.incomparable++; return; }
    const legacySet = extractLegacyEcho(legacyLenRow.stdoutText);
    if (legacySet === null) { dimStats.echo.comparable++; bumpCategory('tee-corrupt:echo', { tuid }); return; }
    dimStats.echo.comparable++;
    if (legacySet.size > 0 || shadowSet.size > 0) dimStats.echo.nonEmpty++;
    if (compareSets(legacySet, shadowSet)) dimMatch.echo++; else { dimDiff.echo++; bumpCategory('echo-mismatch', { tuid, legacy: [...legacySet], shadow: [...shadowSet] }); }
  }

  function processLength(tuid, sPostRow, legacyLenRow) {
    const d = domainAndRows(sPostRow, legacyLenRow, ELR_TOOLS);
    if (!d.inDomain) return;
    dimStats.length.inDomain++;
    if (d.shadowRowExists && !d.legacyRowExists) { oneSided('length', tuid, sPostRow && sPostRow.ts, 'legacy-missing'); return; }
    if (!d.shadowRowExists && d.legacyRowExists) { oneSided('length', tuid, legacyLenRow && legacyLenRow.ts, 'shadow-missing'); return; }
    const shadowSet = normalizeShadowLength(sPostRow.length);
    if (legacyLenRow.stderrTrunc === true) { dimStats.length.incomparable++; return; }
    if (legacyLenRow.stderrTrunc === null) {
      // 7 列旧格式:没有 stderr 数据,只比 rc(补遗三第 29 条 E-6b 段)
      if (shadowSet === null) { dimStats.length.incomparable++; return; }
      dimStats.length.comparable++;
      const legacyNonEmpty = legacyLenRow.rc !== 0;
      const shadowNonEmpty = shadowSet.size > 0;
      if (legacyNonEmpty || shadowNonEmpty) dimStats.length.nonEmpty++;
      if (legacyNonEmpty === shadowNonEmpty) dimMatch.length++;
      else { dimDiff.length++; bumpCategory('length-mismatch-rc-only', { tuid, rc: legacyLenRow.rc, shadowSize: shadowSet.size }); }
      return;
    }
    if (legacyLenRow.stderrDecodeOk === false) { dimStats.length.incomparable++; return; }
    if (shadowSet === null) { dimStats.length.incomparable++; return; }
    const legacySet = extractLengthChecks(legacyLenRow.stderrText);
    // 补遗三第 29 条 length 增补第 2 段:「取代图」「冗余」两类前提是先证明 pmm-manifest.cjs --check /
    // pmm-redundancy-lint.cjs 只读,B1 这批未做该准入证明,structurally 永不出现在 row.length.classes
    // 里(pmm-hook.cjs:604 notComputed 恒含这两项)。legacy 侧真实旧 hook 若报了这两类,两侧永远不对称
    // -> 假 length-mismatch。生产者自己声明了"这两类我没算"(notComputed 字段),对照器据此从 legacy 集
    // 里摘掉同名标签再比——这是"记为不可比"的可执行版本:不是整维降级,只是这两个 legacy 独有、shadow
    // 结构性算不出的标签不参与比对(spec:"做不到证明时这两类记为不可比")。
    const notComputed = (sPostRow.length && typeof sPostRow.length === 'object' && Array.isArray(sPostRow.length.notComputed))
      ? sPostRow.length.notComputed : [];
    for (const nc of notComputed) legacySet.delete(String(nc));
    dimStats.length.comparable++;
    if (legacySet.size > 0 || shadowSet.size > 0) dimStats.length.nonEmpty++;
    if (compareSets(legacySet, shadowSet)) dimMatch.length++; else { dimDiff.length++; bumpCategory('length-mismatch', { tuid, legacy: [...legacySet], shadow: [...shadowSet] }); }
  }

  function processRouting(tuid, sPostRow, legacyRouteRow) {
    const d = domainAndRows(sPostRow, legacyRouteRow, ELR_TOOLS);
    if (!d.inDomain) return;
    dimStats.routing.inDomain++;
    if (d.shadowRowExists && !d.legacyRowExists) { oneSided('routing', tuid, sPostRow && sPostRow.ts, 'legacy-missing'); return; }
    if (!d.shadowRowExists && d.legacyRowExists) { oneSided('routing', tuid, legacyRouteRow && legacyRouteRow.ts, 'shadow-missing'); return; }
    const shadowSet = normalizeShadowRouting(sPostRow.routing);
    if (legacyRouteRow.stderrTrunc === true) { dimStats.routing.incomparable++; return; }
    if (legacyRouteRow.stderrTrunc === null) {
      if (shadowSet === null) { dimStats.routing.incomparable++; return; }
      dimStats.routing.comparable++;
      const legacyNonEmpty = legacyRouteRow.rc !== 0;
      const shadowNonEmpty = shadowSet.size > 0;
      if (legacyNonEmpty || shadowNonEmpty) dimStats.routing.nonEmpty++;
      if (legacyNonEmpty === shadowNonEmpty) dimMatch.routing++;
      else { dimDiff.routing++; bumpCategory('routing-mismatch-rc-only', { tuid, rc: legacyRouteRow.rc, shadowSize: shadowSet.size }); }
      return;
    }
    if (legacyRouteRow.stderrDecodeOk === false) { dimStats.routing.incomparable++; return; }
    if (shadowSet === null) { dimStats.routing.incomparable++; return; }
    const legacySet = extractRoutingHits(legacyRouteRow.stderrText);
    dimStats.routing.comparable++;
    if (legacySet.size > 0 || shadowSet.size > 0) dimStats.routing.nonEmpty++;
    if (compareSets(legacySet, shadowSet)) dimMatch.routing++; else { dimDiff.routing++; bumpCategory('routing-mismatch', { tuid, legacy: [...legacySet], shadow: [...shadowSet] }); }
  }

  const allTuids = new Set([...shadowByTuid.keys(), ...legacyByTuid.keys()]);
  for (const tuid of allTuids) {
    const sRows = shadowByTuid.get(tuid) || [];
    const lRows = legacyByTuid.get(tuid) || [];
    const sPreRow = sRows.find((r) => r.phase === 'pre') || null;
    const sPostRow = sRows.find((r) => r.phase === 'post') || null;
    const legacyTrRow = lRows.find((r) => HOOK_RECALL_RE.test(r.hook || '')) || null;
    const legacyGateRow = lRows.find((r) => HOOK_WRITEGATE_RE.test(r.hook || '')) || null;
    const legacyLenRow = lRows.find((r) => HOOK_LENGTH_RE.test(r.hook || '')) || null;
    const legacyRouteRow = lRows.find((r) => HOOK_ROUTING_RE.test(r.hook || '')) || null;

    processPush(tuid, sPostRow, legacyTrRow);
    processWriter(tuid, sPreRow, legacyGateRow);
    processEcho(tuid, sPostRow, legacyLenRow);
    processLength(tuid, sPostRow, legacyLenRow);
    processRouting(tuid, sPostRow, legacyRouteRow);
  }

  // ── 域外「-」tuid 行:pmm-trigger-recall/write-gate 出现「-」= 未解释;entry-length-watch/
  //    lessons-routing 出现「-」= SessionStart,域外不计。影子 no-tuid 行:三种 intake 失败 = 未解释
  //    (shadow-intake);其余(tool-not-in-scope 等)域外不计,只留存计数。────────────────────────
  let dashTuidPushCount = 0, dashTuidWriterCount = 0, dashTuidOtherCount = 0;
  for (const r of legacyNoTuid) {
    if (HOOK_RECALL_RE.test(r.hook || '')) { dashTuidPushCount++; bumpCategory('dash-tuid:push', { hook: r.hook }); }
    else if (HOOK_WRITEGATE_RE.test(r.hook || '')) { dashTuidWriterCount++; bumpCategory('dash-tuid:writer', { hook: r.hook }); }
    else dashTuidOtherCount++; // length/routing 的 SessionStart「-」行,域外,不计
  }
  let shadowIntakeCount = 0, shadowOtherNoTuidCount = 0;
  const INTAKE_NOTES = new Set(['stdin-read-failed', 'empty-stdin', 'bad-json']);
  for (const r of shadowNoTuid) {
    if (r && INTAKE_NOTES.has(r.note)) { shadowIntakeCount++; bumpCategory('shadow-intake', { note: r.note }); }
    else shadowOtherNoTuidCount++; // tool-not-in-scope 等,域外,不计
  }

  const totalUnexplained = Object.keys(categoryCounts).reduce((sum, cat) => {
    if (ALLOWED_PUSH_CATS.has(cat)) return sum;
    return sum + categoryCounts[cat];
  }, 0);

  return {
    bashSkippedShadow,
    totalConnectedTuids: allTuids.size,
    fallbackPairsMatched: fallbackPairs.length,
    unmatchedShadowNoTuid, unmatchedLegacyNoTuid,
    shadowIntakeCount, shadowOtherNoTuidCount, dashTuidPushCount, dashTuidWriterCount, dashTuidOtherCount,
    dimHookSeenThisRun,
    push: { bothSidesEvents: pushBothSidesEvents, matchEvents: pushMatchEvents, diffEvents: pushDiffEvents, shadowOnlyEvents: pushShadowOnlyEvents, legacyOnlyEvents: pushLegacyOnlyEvents, stat: dimStats.push },
    writer: { matchEvents: dimMatch.writer, diffEvents: dimDiff.writer, stat: dimStats.writer },
    echo: { matchEvents: dimMatch.echo, diffEvents: dimDiff.echo, stat: dimStats.echo, gatedOff: echoGatedOffCount },
    routing: { matchEvents: dimMatch.routing, diffEvents: dimDiff.routing, stat: dimStats.routing },
    length: { matchEvents: dimMatch.length, diffEvents: dimDiff.length, stat: dimStats.length },
    categoryCounts, samples,
    totalUnexplained,
    corpusAvailable: !!byId,
  };
}

function zeroUnexplainedEffective(dim, stat) {
  const th = ZERO_UNEXPLAINED_THRESHOLDS[dim];
  return stat.comparable >= th.comparable && stat.nonEmpty >= th.nonEmpty;
}

// ── 报告渲染(Markdown;deliverable 2 "输出 shadow-compare.md 报告") ──────────────────────────────
function renderReport(result, meta) {
  const lines = [];
  lines.push('# pmm-shadow-compare 报告');
  lines.push('');
  lines.push('- 模式: ' + (meta.mode || 'live'));
  lines.push('- 语料 OID(开工): ' + meta.oidStart);
  const driftNote = meta.drift ? (meta.mode === 'replay' ? '  ⚠️ 漂移(回放全程只读 oidStart 快照,结论不受影响)' : '  ⚠️ 漂移,本轮结论作废') : '';
  lines.push('- 语料 OID(收工): ' + meta.oidEnd + driftNote);
  lines.push('- 影子日志: ' + meta.shadowLogPath + (meta.shadowLogExists === false ? '(不存在,视为 0 行)' : ''));
  lines.push('- legacy tee 日志: ' + meta.legacyLogPath + (meta.legacyLogExists === false ? '(不存在,视为 0 行 —— tee 未接线时的预期状态)' : ''));
  lines.push('- 语料快照分类上下文: ' + (result.corpusAvailable ? '可用' : '不可用(core.analyze 失败,差异一律计入 no-corpus-context)'));
  lines.push('');
  lines.push('## 事件计数');
  lines.push('- Bash 事件(不计): ' + result.bashSkippedShadow);
  lines.push('- 按 tool_use_id 连接的事件数: ' + result.totalConnectedTuids);
  lines.push('- 未配对(无 tool_use_id):影子=' + result.unmatchedShadowNoTuid + '(shadow-intake=' + result.shadowIntakeCount + ', 域外=' + result.shadowOtherNoTuidCount + ')'
    + ' legacy=' + result.unmatchedLegacyNoTuid + '(dash-tuid push=' + result.dashTuidPushCount + ' writer=' + result.dashTuidWriterCount + ', 域外=' + result.dashTuidOtherCount + ')');
  lines.push('- 本次会话旧 hook 是否被起过: push=' + result.dimHookSeenThisRun.push + ' writer=' + result.dimHookSeenThisRun.writer
    + ' echo=' + result.dimHookSeenThisRun.echo + ' routing=' + result.dimHookSeenThisRun.routing + ' length=' + result.dimHookSeenThisRun.length);
  lines.push('');
  lines.push('## 五维覆盖(在域/可比/其中非空/不可比 —— 补遗三第 29 条「报告首行」)');
  for (const dim of ['push', 'writer', 'echo', 'routing', 'length']) {
    const st = result[dim].stat;
    const eff = zeroUnexplainedEffective(dim, st);
    const th = ZERO_UNEXPLAINED_THRESHOLDS[dim];
    lines.push('- ' + dim + ': 在域=' + st.inDomain + ' 可比=' + st.comparable + ' 非空=' + st.nonEmpty + ' 不可比=' + st.incomparable
      + '(match=' + result[dim].matchEvents + (dim === 'push' ? '' : ', diff=' + result[dim].diffEvents)
      + (dim === 'push' ? ', shadow-only=' + result[dim].shadowOnlyEvents + ', legacy-only=' + result[dim].legacyOnlyEvents : '')
      + (dim === 'echo' ? ', gated-off=' + result[dim].gatedOff : '')
      + ') 「零未解释」生效=' + (eff ? '是' : '否(需可比≥' + th.comparable + (th.nonEmpty ? '且非空≥' + th.nonEmpty : '') + ')'));
  }
  lines.push('');
  lines.push('## 差异分类');
  const cats = Object.keys(result.categoryCounts).sort();
  if (!cats.length) lines.push('(无差异)');
  for (const c of cats) {
    lines.push('- ' + c + ': ' + result.categoryCounts[c]);
    for (const s of (result.samples[c] || [])) lines.push('    样例: ' + JSON.stringify(s));
  }
  lines.push('');
  lines.push('## 结论');
  lines.push('未解释差异计数: ' + result.totalUnexplained + (result.totalUnexplained === 0 ? '(零未解释差异)' : '(非零 —— 需要人工复核以上样例)'));
  return lines.join('\n') + '\n';
}

module.exports = {
  resolveHomeNorm, mach, defaultShadowLogPath, defaultLegacyLogPath,
  pinMemoryOid, archiveCorpus, analyzeMemDir, loadAnalyzedAt,
  parseShadowLog, parseLegacyLog, TAG_BRACKET_RE, extractTagsFromContext, extractPushTagLines,
  shadowPushTagSet, preTruncationTagSet, classifyPushDiff, compareEvents, renderReport,
  parseLegacyWriterDenyText, normalizeShadowWriter,
  extractLegacyEcho, normalizeShadowEcho,
  extractRoutingHits, normalizeShadowRouting,
  extractLengthChecks, normalizeShadowLength,
  loadWiringWindows, inWiringWindow, zeroUnexplainedEffective, ZERO_UNEXPLAINED_THRESHOLDS,
};

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
function runCli(argv) {
  const outIdx = argv.indexOf('--out');
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : null;
  const shadowIdx = argv.indexOf('--shadow-log');
  const legacyIdx = argv.indexOf('--legacy-log');
  const repoIdx = argv.indexOf('--repo');
  const repoRoot = repoIdx !== -1 ? argv[repoIdx + 1] : resolveHomeNorm();
  const home = resolveHomeNorm();
  const shadowLogPath = shadowIdx !== -1 ? argv[shadowIdx + 1] : defaultShadowLogPath(home);
  const legacyLogPath = legacyIdx !== -1 ? argv[legacyIdx + 1] : defaultLegacyLogPath(home);
  const mode = (shadowIdx !== -1 || legacyIdx !== -1) ? 'explicit-logs' : 'live';

  let oidStart;
  try { oidStart = pinMemoryOid(repoRoot); }
  catch (e) { process.stderr.write('pmm-shadow-compare: 无法钉住 OID -- ' + e.message + '\n'); process.exit(1); }

  let shadowText = '', shadowLogExists = true;
  try { shadowText = fs.readFileSync(shadowLogPath, 'utf8'); } catch { shadowLogExists = false; }
  let legacyText = '', legacyLogExists = true;
  try { legacyText = fs.readFileSync(legacyLogPath, 'utf8'); } catch { legacyLogExists = false; }

  const { rows: shadowRows } = parseShadowLog(shadowText);
  const { rows: legacyRows } = parseLegacyLog(legacyText);
  const { analyzed } = loadAnalyzedAt(repoRoot, oidStart);
  const result = compareEvents({ shadowRows, legacyRows, analyzed, repoRoot });

  let oidEnd;
  try { oidEnd = pinMemoryOid(repoRoot); }
  catch (e) { process.stderr.write('pmm-shadow-compare: 收工取 OID 失败 -- ' + e.message + '\n'); process.exit(1); }
  const drift = oidEnd !== oidStart;

  const report = renderReport(result, { mode, oidStart, oidEnd, drift, shadowLogPath, legacyLogPath, shadowLogExists, legacyLogExists });
  if (outFile) fs.writeFileSync(outFile, report); else process.stdout.write(report);
  process.exit(drift ? 1 : 0);
}

// SELFTEST-BEGIN (spec 22 canary-structure convention; 文件名交建造报告给收口者登记进
// SELFTEST_STRUCTURE_ROSTER)
function selfTest() {
  const cp = require('child_process');
  const iso = require('./selftest-iso.cjs');
  let pass = 0, fail = 0;
  const lines = [];
  function report(name, ok, detail) {
    if (ok) { pass++; lines.push('PASS ' + name); }
    else { fail++; lines.push('FAIL ' + name + (detail !== undefined ? (' :: ' + JSON.stringify(detail)) : '')); }
  }

  const nonce = 'test:shadowcmpst-' + crypto.randomBytes(6).toString('hex');
  const runRootBase = 'shadowcmp-st-' + crypto.randomBytes(4).toString('hex');
  const fpSnapshot = iso.footprint.begin();
  const tempRoots = [];
  function mkRoot(tag) {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), runRootBase + '-' + tag + '-'));
    tempRoots.push(T);
    return T.replace(/\\/g, '/');
  }

  // ── group 1: legacy tee TSV round-trip parsing — 9 列(现行格式)+ 7 列(向后兼容)+ 截断 + 损坏 ──
  {
    const stdoutObj = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '- [tooling:probe-a] Title A\n  ↳ 同类成员 [tooling:probe-b] Title B' } };
    const stdoutStr = JSON.stringify(stdoutObj);
    const buf = Buffer.from(stdoutStr, 'utf8');
    const b64 = buf.toString('base64');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const errBuf = Buffer.from('⚠️ 取代记账缺失 [tooling:x]\n', 'utf8');
    const errB64 = errBuf.toString('base64');
    const line9 = ['2026-01-01T00:00:00Z', 'pmm-trigger-recall.sh', 'toolu_selftest_' + nonce + '_1', '0', b64, sha, '0', errB64, '0'].join('\t');
    const { rows, parseErrors } = parseLegacyLog(line9 + '\n');
    report('legacy parse 9-col: exactly one row, no parse errors', rows.length === 1 && parseErrors === 0, { n: rows.length, parseErrors });
    if (rows.length === 1) {
      report('legacy parse 9-col: toolUseId decoded', rows[0].toolUseId === 'toolu_selftest_' + nonce + '_1');
      report('legacy parse 9-col: sha verified (non-truncated)', rows[0].shaVerified === true);
      report('legacy parse 9-col: stdoutText round-trips', rows[0].stdoutText === stdoutStr);
      report('legacy parse 9-col: stderrText round-trips', rows[0].stderrText === '⚠️ 取代记账缺失 [tooling:x]\n');
      report('legacy parse 9-col: stderrTrunc decoded (false)', rows[0].stderrTrunc === false);
      report('legacy parse 9-col: cols=9', rows[0].cols === 9);
    }
    // 7-col 向后兼容(E-6b 之前的旧格式,补遗三第 29 条「对照器同时接受 7 列与 9 列」)
    const line7 = ['2026-01-01T00:00:01Z', 'pmm-lessons-routing.sh', 'toolu_selftest_' + nonce + '_1b', '0', b64, sha, '0'].join('\t');
    const { rows: rows7, parseErrors: err7 } = parseLegacyLog(line7 + '\n');
    report('legacy parse 7-col: still parses (back-compat), no parse errors', rows7.length === 1 && err7 === 0, { n: rows7.length, err7 });
    if (rows7.length === 1) {
      report('legacy parse 7-col: cols=7, stderrTrunc=null (unknown, no stderr channel)', rows7[0].cols === 7 && rows7[0].stderrTrunc === null);
    }
    // malformed line (既非 7 列也非 9 列) 必须计入 parseErrors,不能悄悄丢弃或误判为某种已知列数
    const { rows: badRows, parseErrors: badErrs } = parseLegacyLog('only\tfive\tcolumns\there\tnow\n');
    report('legacy parse: malformed row (5 cols) counted as parseErrors, not a row', badRows.length === 0 && badErrs === 1, { badRows: badRows.length, badErrs });
  }

  // ── group 2: shadow JSON-line parsing tolerates bad lines, Bash rows excluded from usable set ──
  {
    const goodRow = { tool: 'Edit', tool_use_id: 'toolu_selftest_' + nonce + '_2', phase: 'post', pushSelected: [{ tag: 'tooling:x', source: 'direct' }] };
    const bashRow = { tool: 'Bash', tool_use_id: 'toolu_selftest_' + nonce + '_bash' };
    const text = JSON.stringify(goodRow) + '\n' + 'not json at all' + '\n' + JSON.stringify(bashRow) + '\n';
    const { rows, parseErrors } = parseShadowLog(text);
    report('shadow parse: 2 valid rows out of 3 lines, 1 parse error', rows.length === 2 && parseErrors === 1, { n: rows.length, parseErrors });
    const result = compareEvents({ shadowRows: rows, legacyRows: [], analyzed: null });
    report('13③: Bash row excluded, counted separately as bashSkippedShadow=1', result.bashSkippedShadow === 1, result.bashSkippedShadow);
  }

  // ── group 3: shadowPushTagSet honors the policy-shadow-arm filter (same rule packCandidates uses) ──
  {
    const row = {
      pushSelected: [
        { tag: 'tooling:a', source: 'direct', arm: 'intervene', provenance: 'policy:randomized' },
        { tag: 'tooling:b', source: 'cause', arm: 'shadow', provenance: 'policy:randomized' }, // suppressed
        { tag: null, source: 'class-count', classTag: 'class:foo', memberCount: 3 },
      ],
    };
    const set = shadowPushTagSet(row);
    report('shadowPushTagSet: policy-shadow-arm candidate excluded', !set.has('tooling:b'));
    report('shadowPushTagSet: normal direct candidate included', set.has('tooling:a'));
    report('shadowPushTagSet: class-count contributes its classTag', set.has('class:foo'));
    report('shadowPushTagSet: exactly 2 tags survive', set.size === 2, [...set]);
  }

  // ── group 4: compareEvents end-to-end on synthetic push rows -- exact match, each allowed category
  //    (quota/class-count/untyped-link/r2-repush), then one adversarial genuinely-unexplained case.
  //    MEDIUM-1 fix: linked-line fixtures now use the REAL producer shape ("↳ 同类成员 [tag]" /
  //    "↳ 关联(age) [tag]"), not the old bare "↳ [tag]" the pre-fix regex only matched.
  {
    const byIdEntries = [
      { id: 'tooling:direct-hit', class: 'class:widgets', links: ['tooling:untyped-linked'] },
      { id: 'tooling:member-1', class: 'class:widgets' },
      { id: 'tooling:untyped-linked', class: null },
    ];
    const analyzedStub = { entries: byIdEntries };

    function makeShadowPost(tuid, pushSelected, opts) {
      return Object.assign({ tool: 'Edit', tool_use_id: tuid, phase: 'post', pushSelected, pushCandidatesPreTruncation: pushSelected, quotaTruncated: false }, opts || {});
    }
    function makeLegacyTr(tuid, ctxLines) {
      const stdoutStr = ctxLines.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctxLines.join('\n') } }) : '';
      return { hook: 'pmm-trigger-recall.sh', toolUseId: tuid, trunc: false, shaVerified: true, decodeOk: true, stdoutText: stdoutStr };
    }

    const s4a = makeShadowPost('toolu_selftest_' + nonce + '_4a', [{ tag: 'tooling:direct-hit', source: 'direct' }]);
    const l4a = makeLegacyTr('toolu_selftest_' + nonce + '_4a', ['- [tooling:direct-hit] Title']);

    const s4b = Object.assign(
      makeShadowPost('toolu_selftest_' + nonce + '_4b', [{ tag: 'tooling:direct-hit', source: 'direct' }], { quotaTruncated: true }),
      { pushCandidatesPreTruncation: [{ tag: 'tooling:direct-hit', source: 'direct' }, { tag: 'tooling:dropped-by-quota', source: 'cause' }] });
    // MEDIUM-1: real linked-line shape carries "同类成员"/"关联" between ↳ and [tag] (pmm-trigger-recall.cjs:609)
    const l4b = makeLegacyTr('toolu_selftest_' + nonce + '_4b', ['- [tooling:direct-hit] Title', '  ↳ 同类成员 [tooling:dropped-by-quota] Title']);

    const s4c = makeShadowPost('toolu_selftest_' + nonce + '_4c', [{ tag: null, source: 'class-count', classTag: 'class:widgets', memberCount: 1 }]);
    const l4c = makeLegacyTr('toolu_selftest_' + nonce + '_4c', ['  ↳ 同类成员 [class:widgets] 1 条', '  ↳ 同类成员 [tooling:member-1] Title']);

    const s4d = makeShadowPost('toolu_selftest_' + nonce + '_4d', [{ tag: 'tooling:direct-hit', source: 'direct' }]);
    const l4d = makeLegacyTr('toolu_selftest_' + nonce + '_4d', ['- [tooling:direct-hit] Title', '  ↳ 关联(较旧) [tooling:untyped-linked] Title']);

    const s4e = makeShadowPost('toolu_selftest_' + nonce + '_4e', [{ tag: 'tooling:direct-hit', source: 'direct' }]);
    const l4e = makeLegacyTr('toolu_selftest_' + nonce + '_4e', ['- [tooling:direct-hit] Title', '  ↳ 关联 [tooling:no-explanation-at-all] Title']);

    // r2-repush (spec §29 push): legacy 独有的再推行,始终允许,不需要语料上下文。
    const s4f = makeShadowPost('toolu_selftest_' + nonce + '_4f', [{ tag: 'tooling:direct-hit', source: 'direct' }]);
    const l4f = makeLegacyTr('toolu_selftest_' + nonce + '_4f', ['- [tooling:direct-hit] Title', '⚠️ 风险时刻再推(刚才的编辑移除了隔离重定向)[tooling:repushed-only]: 建议']);

    const shadowRows = [s4a, s4b, s4c, s4d, s4e, s4f];
    const legacyRows = [l4a, l4b, l4c, l4d, l4e, l4f];
    const result = compareEvents({ shadowRows, legacyRows, analyzed: analyzedStub });

    report('compareEvents: 4a exact match contributes to matchEvents', result.push.matchEvents >= 1);
    report('compareEvents: quota category detected', (result.categoryCounts['quota'] || 0) >= 1, result.categoryCounts);
    report('MEDIUM-1: real "↳ 同类成员 [tag]" linked line now parses (v3-class-count-not-members detected)',
      (result.categoryCounts['v3-class-count-not-members'] || 0) >= 1, result.categoryCounts);
    report('MEDIUM-1: real "↳ 关联(age) [tag]" linked line now parses (v3-untyped-link-not-carried detected)',
      (result.categoryCounts['v3-untyped-link-not-carried'] || 0) >= 1, result.categoryCounts);
    report('r2-repush: R2 再推行 classified into allowed category, not unexplained', (result.categoryCounts['r2-repush'] || 0) >= 1, result.categoryCounts);
    report('compareEvents ADVERSARIAL: genuinely-unexplained diff is correctly flagged (unexplained>=1)', (result.categoryCounts['unexplained'] || 0) >= 1, result.categoryCounts);
    // r2-repush is an ALLOWED category -- it must NOT inflate totalUnexplained even though it's a real diff.
    report('r2-repush does not count toward totalUnexplained', result.totalUnexplained === (result.categoryCounts['unexplained'] || 0), { totalUnexplained: result.totalUnexplained, cats: result.categoryCounts });
  }

  // ── group 5: OID pin + drift detection against a hermetic throwaway git repo (never the real repo) ──
  {
    const T = mkRoot('gitoid');
    const repo = T + '/fakerepo';
    fs.mkdirSync(repo + '/.claude/memory', { recursive: true });
    for (const f of core.ALL_FILES) fs.writeFileSync(repo + '/.claude/memory/' + f, '');
    function git(args) { return cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: iso.isoEnv(T, {}) }); }
    git(['init', '-q']);
    git(['-c', 'user.email=selftest@test', '-c', 'user.name=selftest', 'add', '-A']);
    git(['-c', 'user.email=selftest@test', '-c', 'user.name=selftest', 'commit', '-q', '-m', 'init']);
    const oid1 = pinMemoryOid(repo);
    const oid1b = pinMemoryOid(repo);
    report('OID pin: stable across two immediate reads (no-drift control)', oid1 === oid1b, { oid1, oid1b });

    fs.writeFileSync(repo + '/.claude/memory/lessons.md', '**2026-01-01 — drift probe** [tooling:drift-probe]\nbody.\n');
    git(['-c', 'user.email=selftest@test', '-c', 'user.name=selftest', 'add', '-A']);
    git(['-c', 'user.email=selftest@test', '-c', 'user.name=selftest', 'commit', '-q', '-m', 'drift']);
    const oid2 = pinMemoryOid(repo);
    report('OID pin: drift after a commit between two pins is detected (differs)', oid2 !== oid1, { oid1, oid2 });

    const extractDir = T + '/extracted';
    archiveCorpus(repo, oid1, extractDir);
    const extractedLessons = fs.readFileSync(extractDir + '/lessons.md', 'utf8');
    report('archiveCorpus: frozen OID snapshot excludes the later commit\'s content', extractedLessons.indexOf('drift-probe') === -1, extractedLessons.length);
    const { analyzed } = analyzeMemDir(extractDir);
    report('analyzeMemDir: core.analyze succeeds on the archived snapshot', !!analyzed && Array.isArray(analyzed.entries));
  }

  // ── group 6: end-to-end integration against the REAL pmm-hook.cjs + pmm-trigger-recall.cjs, run
  //    under isoEnv on a hermetic fixture corpus (not the real corpus, not the real HOME) -- proves the
  //    parse+compare pipeline actually agrees with what the real tools emit, not just my assumptions
  //    about their output shape.
  {
    const T = mkRoot('e2e');
    fs.mkdirSync(T + '/.claude/memory', { recursive: true });
    const lessonsContent = '**2026-01-01 — shadow-compare e2e probe** [tooling:shadowcmp-e2e-probe]\n' +
      '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=probe.md -->\n' +
      'body text for the shadow-compare end-to-end probe.\n';
    fs.writeFileSync(T + '/.claude/memory/lessons.md', lessonsContent);
    for (const f of core.ALL_FILES) { if (f !== 'lessons.md') fs.writeFileSync(T + '/.claude/memory/' + f, ''); }
    const env = iso.isoEnv(T, {});
    const tuid = 'toolu_selftest_' + nonce + '_e2e';
    const evt = Buffer.from(JSON.stringify({
      tool_name: 'Edit', session_id: nonce + '-e2e', tool_use_id: tuid,
      tool_input: { file_path: T + '/probe.md' },
    }));
    const HOOK = path.resolve(__dirname, '..', 'pmm-hook.cjs');
    // The tee block lives in pmm-trigger-recall.SH (its non-self-test tail is `exec node
    // ".../pmm-trigger-recall.cjs"` with no args) -- spawning the .cjs directly bypasses tee entirely.
    // MUST spawn pmm-hook.cjs FIRST (it mkdirSync's .shadow/ as a side effect of writing its own line) —
    // 09-24 建造实测: `.shadow/` 目录不预先存在时,trigger-recall.sh 的 tee 重定向本身会失败
    // (bash: line 52: <path>: No such file or directory,`2>/dev/null||true` 盖不住重定向打开失败,
    // 只盖得住命令自身的 stderr) —— 顺序颠倒会让 tee 整行丢失,不是解析问题。
    const TRIGGER_RECALL_SH = path.resolve(__dirname, 'pmm-trigger-recall.sh');
    cp.spawnSync(process.execPath, [HOOK, '--shadow'], { env, input: evt });
    const legacyLog = T + '/.claude/.shadow/legacy-' + mach() + '.log';
    cp.spawnSync('bash', [TRIGGER_RECALL_SH], { env: Object.assign({}, env, { PMM_TEE_LOG: legacyLog }), input: evt });

    let shadowText = '', legacyText = '';
    try { shadowText = fs.readFileSync(T + '/.claude/.shadow/hook-' + mach() + '.log', 'utf8'); } catch { /* ignore */ }
    try { legacyText = fs.readFileSync(legacyLog, 'utf8'); } catch { /* ignore */ }
    const { rows: shadowRows } = parseShadowLog(shadowText);
    const { rows: legacyRows } = parseLegacyLog(legacyText);
    report('e2e: real pmm-hook.cjs produced exactly one shadow log line', shadowRows.length === 1, shadowRows.length);
    report('e2e: real pmm-trigger-recall.cjs produced exactly one legacy tee line (9-col, B0 already shipped)', legacyRows.length === 1, legacyRows.length);
    if (legacyRows.length === 1) report('e2e: legacy tee line parsed as 9 columns', legacyRows[0].cols === 9, legacyRows[0].cols);
    if (shadowRows.length === 1 && legacyRows.length === 1) {
      const { analyzed } = analyzeMemDir(T + '/.claude/memory');
      const result = compareEvents({ shadowRows, legacyRows, analyzed });
      report('e2e: real tools agree on the single push tag (0 unexplained)', result.totalUnexplained === 0, result.categoryCounts);
      report('e2e: push comparison actually ran both-sides (not a vacuous 0/0)', result.push.bothSidesEvents === 1 && result.push.matchEvents === 1, result.push);
    }
  }

  // ── group 7: writer 维 —— B5/B32 与 presence 两种 legacy deny 文案的行锚定解析(逐字复刻
  //    pmm-trigger-write-gate.cjs:212-266 的真实文案),外加 DISABLE 逃生口与「字段缺失→不可比,非崩溃」。
  {
    function makeGateRow(tuid, reasonOrNull, opts) {
      const stdoutText = reasonOrNull === null ? '' : JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reasonOrNull } });
      return Object.assign({ hook: 'pmm-trigger-write-gate.sh', toolUseId: tuid, trunc: false, shaVerified: true, stdoutText, rc: 0, stderrText: '', stderrTrunc: false, stderrDecodeOk: true, cols: 9 }, opts || {});
    }
    function makePre(tuid, rel, writerField) {
      return { tool: 'Edit', tool_use_id: tuid, phase: 'pre', rel, writer: writerField };
    }

    // 7a: real B5/B32 deny text, shadow agrees exactly -> match, 0 unexplained
    const b5b32Reason = 'pmm-trigger-write-gate:本次写入(重建拼接后的完整文件,经 core.parseFile 权威解析)含 2 处问题(B5 非法 trigger / B32 未闭合围栏,写时拦截,guards/audits/x HIGH-5;R5-2 片段拼回修正见 guards/audits/y HIGH-2)——修正后再写(误拦可设 PMM_TRIGGER_WRITE_GATE_DISABLE=1 逃生,但须记录原因):\n' +
      '  - [B5] L12: <!-- trigger: bad --> —— 非法字段\n' +
      '  - [B32] L40: ```unclosed —— 围栏未闭合';
    const parsedB5 = parseLegacyWriterDenyText(JSON.stringify({ hookSpecificOutput: { permissionDecisionReason: b5b32Reason } }), 'lessons.md');
    report('writer legacy parse: B5/B32 total extracted (含 2 处问题)', parsedB5.total === 2, parsedB5);
    report('writer legacy parse: B5/B32 keys line-anchored (code|basename|L<行>)', parsedB5.keys.length === 2 && parsedB5.keys[0] === 'B5|lessons.md|L12' && parsedB5.keys[1] === 'B32|lessons.md|L40', parsedB5.keys);

    const l7a = makeGateRow('toolu_selftest_' + nonce + '_7a', b5b32Reason);
    const s7a = makePre('toolu_selftest_' + nonce + '_7a', 'lessons.md', { keys: ['B5|lessons.md|L12', 'B32|lessons.md|L40'], total: 2 });
    // 7b: real presence deny text
    const presenceReason = 'pmm-trigger-presence-gate:本次写入新增了 1 条条目,缺 <!-- trigger: ... --> 行(2026-09-13 Jax [memory:trigger-plant-at-write-fine-grained]「写教训同笔种 trigger」——只管新增条目,存量不追溯)。修法:在该条目 attribution 注释之后、正文之前补一行合法 trigger(tool=;repo=;path=|cmd= 形态),或答不出确定性判据时显式写 <!-- trigger: none; 理由=<非空说明> -->:\n' +
      '  - [2026-01-01 — 示例标题]';
    const parsedPresence = parseLegacyWriterDenyText(JSON.stringify({ hookSpecificOutput: { permissionDecisionReason: presenceReason } }), 'decisions.md');
    report('writer legacy parse: presence total extracted (新增了 1 条条目)', parsedPresence.total === 1, parsedPresence);
    report('writer legacy parse: presence key = presence|basename|<dateISO><dateRaw> — <title>', parsedPresence.keys.length === 1 && parsedPresence.keys[0] === 'presence|decisions.md|2026-01-01 — 示例标题', parsedPresence.keys);

    const l7b = makeGateRow('toolu_selftest_' + nonce + '_7b', presenceReason);
    const s7b = makePre('toolu_selftest_' + nonce + '_7b', 'decisions.md', { keys: ['presence|decisions.md|2026-01-01 — 示例标题'], total: 1 });

    // 7c: DISABLE 逃生口 -> incomparable ("旧闸停用"), never unexplained
    const l7c = makeGateRow('toolu_selftest_' + nonce + '_7c', null, { stderrText: 'pmm-trigger-write-gate: PMM_TRIGGER_WRITE_GATE_DISABLE=1 —— 本次写入跳过了 trigger 写时闸判断(逃生口生效,已记入本机 trigger-log,非静默)\n' });
    const s7c = makePre('toolu_selftest_' + nonce + '_7c', 'lessons.md', { keys: [], total: 0 });

    // 7d: 字段缺失(B1 未落地/未populate)——shadow.writer = undefined -> 不可比,不崩溃,不算未解释
    const l7d = makeGateRow('toolu_selftest_' + nonce + '_7d', b5b32Reason);
    const s7d = { tool: 'Edit', tool_use_id: 'toolu_selftest_' + nonce + '_7d', phase: 'pre', rel: 'lessons.md' }; // no .writer field at all

    // 7e: ADVERSARIAL -- shadow disagrees with legacy (missing one key) -> writer-mismatch, unexplained
    const l7e = makeGateRow('toolu_selftest_' + nonce + '_7e', b5b32Reason);
    const s7e = makePre('toolu_selftest_' + nonce + '_7e', 'lessons.md', { keys: ['B5|lessons.md|L12'], total: 2 }); // missing B32 key

    const shadowRows7 = [s7a, s7b, s7c, s7d, s7e];
    const legacyRows7 = [l7a, l7b, l7c, l7d, l7e];
    const result7 = compareEvents({ shadowRows: shadowRows7, legacyRows: legacyRows7, analyzed: null });

    report('writer B5/B32: shadow matches legacy exactly -> no writer-mismatch for 7a', result7.writer.matchEvents >= 1);
    report('writer presence: shadow matches legacy exactly -> counted in comparable+nonEmpty', result7.writer.stat.nonEmpty >= 2, result7.writer);
    report('writer DISABLE: incomparable, not counted toward unexplained', result7.writer.stat.incomparable >= 1 && (result7.categoryCounts['writer-mismatch'] || 0) < 3, result7);
    report('writer field-missing (B1 not landed yet): incomparable, NOT one-sided/unexplained', !result7.categoryCounts['one-sided:writer:shadow-missing'], result7.categoryCounts);
    report('writer ADVERSARIAL: genuine key mismatch flagged as writer-mismatch', (result7.categoryCounts['writer-mismatch'] || 0) >= 1, result7.categoryCounts);
    report('writer: total unexplained includes the adversarial writer-mismatch', result7.totalUnexplained >= 1, result7.totalUnexplained);
  }

  // ── group 8: echo 维 —— 逐字复刻 pmm-write-echo.cjs:49-61 的五种回显行形态,rc=2 gated-off 单列。
  {
    function wrapEchoStdout(outLines) {
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '✍️ 写入关联回显(你刚接上的旧记忆,现况如下;时间线以标题日期为准):\n' + outLines.join('\n') } });
    }
    function makeLenRow(tuid, rc, stdoutText, opts) {
      return Object.assign({ hook: 'pmm-entry-length-watch.sh', toolUseId: tuid, trunc: false, shaVerified: true, rc, stdoutText: stdoutText || '', stderrText: '', stderrTrunc: false, stderrDecodeOk: true, cols: 9 }, opts || {});
    }
    function makePost(tuid, echoField) { return { tool: 'Edit', tool_use_id: tuid, phase: 'post', echo: echoField }; }

    const echoLines = [
      '- [[tooling:unknown-ref]] 未在记忆库(项目档或笔误——指针 lint 会验)',
      '- [[tooling:superseded-ref]] 老标题 ⚠️ 已被 [tooling:new-head] 新标题 取代——考虑改链最新版',
      '- [[tooling:current-ref]] 现行标题(现行)',
      '- 你声明取代 [tooling:marked] 旧标题 — 旧条 Index 标记 ✓ 已同笔处置',
      '- 你声明取代 [tooling:unmarked] 旧标题 — 旧条 Index 标记 ✗ 未标记(闸会拦:同笔补 (superseded→…) )',
    ];
    const l8a = makeLenRow('toolu_selftest_' + nonce + '_8a', 0, wrapEchoStdout(echoLines));
    const expectedEcho8a = [
      'tooling:unknown-ref|未在记忆库', 'tooling:superseded-ref|已被[tooling:new-head]取代', 'tooling:current-ref|现行',
      'tooling:marked|已标记', 'tooling:unmarked|未标记',
    ];
    const extracted8a = extractLegacyEcho(l8a.stdoutText);
    report('echo legacy parse: all 5 status shapes extracted (line-anchored, verbatim producer format)',
      extracted8a && extracted8a.size === 5 && expectedEcho8a.every((x) => extracted8a.has(x)), extracted8a && [...extracted8a]);
    const s8a = makePost('toolu_selftest_' + nonce + '_8a', expectedEcho8a);

    // rc=2 (gated-off): entry-length-watch --block 没通过校验,write-echo 从未被调用,不比较
    const l8b = makeLenRow('toolu_selftest_' + nonce + '_8b', 2, '');
    const s8b = makePost('toolu_selftest_' + nonce + '_8b', []);

    // 字段缺失(B1 未落地):shadow.echo === null(今日 pmm-hook.cjs 的占位值)-> 不可比,不是未解释
    const l8c = makeLenRow('toolu_selftest_' + nonce + '_8c', 0, wrapEchoStdout(['- [[tooling:x]] 标题(现行)']));
    const s8c = makePost('toolu_selftest_' + nonce + '_8c', null);

    // ADVERSARIAL: shadow 漏掉一条 -> echo-mismatch
    const l8d = makeLenRow('toolu_selftest_' + nonce + '_8d', 0, wrapEchoStdout(echoLines));
    const s8d = makePost('toolu_selftest_' + nonce + '_8d', expectedEcho8a.slice(0, 4)); // missing 1

    const result8 = compareEvents({ shadowRows: [s8a, s8b, s8c, s8d], legacyRows: [l8a, l8b, l8c, l8d], analyzed: null });
    report('echo: exact 5-pair match counted, no echo-mismatch for 8a', result8.echo.matchEvents >= 1);
    report('echo: rc=2 counted as gated-off, not compared', result8.echo.gatedOff >= 1, result8.echo);
    report('echo: field missing (B1 not landed) -> incomparable, not one-sided/unexplained', !result8.categoryCounts['one-sided:echo:shadow-missing'], result8.categoryCounts);
    report('echo ADVERSARIAL: missing pair flagged as echo-mismatch', (result8.categoryCounts['echo-mismatch'] || 0) >= 1, result8.categoryCounts);
  }

  // ── group 9: routing 维 —— 逐字复刻 pmm-lessons-routing.sh:63 的 grep -n 命中行(<行号>:<标题行>)。
  {
    function makeRouteRow(tuid, rc, stderrText, opts) {
      return Object.assign({ hook: 'pmm-lessons-routing.sh', toolUseId: tuid, trunc: false, shaVerified: true, rc, stdoutText: '', stderrText: stderrText || '', stderrTrunc: false, stderrDecodeOk: true, cols: 9 }, opts || {});
    }
    function makePost(tuid, routingField) { return { tool: 'Edit', tool_use_id: tuid, phase: 'post', routing: routingField }; }

    const routeStderr = '<!-- pmm-lessons-routing -->\n⚠️ PMM lessons-routing 违规:项目专属教训出现在 ~/.claude/memory/lessons.md。\n   → 移到对应 <repo>/LESSONS.md;PMM lessons.md 只放跨项目通用/工具/流程教训\n   (standinginstructions 2026-06-28 + config.md Write Discipline)。涉及条目:\n42:**2026-01-01 — 示例项目专属教训** [axervice:probe]\n88:**2026-01-02 — 另一条** [rag:probe2]\n';
    const l9a = makeRouteRow('toolu_selftest_' + nonce + '_9a', 2, routeStderr);
    const extracted9a = extractRoutingHits(routeStderr);
    report('routing legacy parse: hit lines extracted as "<行号>:<标题>" (line-anchored, real producer grep -n shape)',
      extracted9a.size === 2 && extracted9a.has('42:**2026-01-01 — 示例项目专属教训** [axervice:probe]') && extracted9a.has('88:**2026-01-02 — 另一条** [rag:probe2]'), [...extracted9a]);
    const s9a = makePost('toolu_selftest_' + nonce + '_9a', [...extracted9a]);

    // rc=0, no hits
    const l9b = makeRouteRow('toolu_selftest_' + nonce + '_9b', 0, '');
    const s9b = makePost('toolu_selftest_' + nonce + '_9b', []);

    // 7-col 旧格式(向后兼容):只比 rc
    const l9c = { hook: 'pmm-lessons-routing.sh', toolUseId: 'toolu_selftest_' + nonce + '_9c', trunc: false, shaVerified: true, rc: 2, stdoutText: '', stderrText: '', stderrTrunc: null, stderrDecodeOk: null, cols: 7 };
    const s9c = makePost('toolu_selftest_' + nonce + '_9c', ['42:some hit']); // shadow found something too -> rc-only match

    const result9 = compareEvents({ shadowRows: [s9a, s9b, s9c], legacyRows: [l9a, l9b, l9c], analyzed: null });
    report('routing: exact hit-line-set match counted', result9.routing.matchEvents >= 1);
    report('routing: 7-col legacy row degrades to rc-only comparison (still comparable, not incomparable)', result9.routing.stat.comparable >= 3, result9.routing.stat);
  }

  // ── group 10: length 维 —— 逐字复刻 pmm-entry-length-watch.sh 11 项检查的 `⚠️ <检查名>` 行,
  //    覆盖真实完整 --block 失败文案的多行结构(含续行不误判为新检查类)。
  {
    function makeLenRow(tuid, rc, stderrText, opts) {
      return Object.assign({ hook: 'pmm-entry-length-watch.sh', toolUseId: tuid, trunc: false, shaVerified: true, rc, stdoutText: '', stderrText: stderrText || '', stderrTrunc: false, stderrDecodeOk: true, cols: 9 }, opts || {});
    }
    function makePost(tuid, lengthField) { return { tool: 'Write', tool_use_id: tuid, phase: 'post', length: lengthField }; }

    // 真实 --block 失败文案:3 项检查,其中 Active 体积那条有多行续行(不应被误判为额外检查类)
    const realFailText = '<!-- pmm-write-integrity -->\n' +
      '⚠️ 新增超长条目(3→4,上限 900B): 压成「本体+WHY+→指针」,或——细节无处可指(PMM 是唯一档)时标 [sole-record] 全文保留(禁止失真强压)。\n' +
      '⚠️ Index 奇偶不平:decisions(Index 12≠Entries 13) —— 新条目忘加 Index 行(或条目畸形没被计数),当场补齐。\n' +
      '⚠️ progress.md 的 ## Active 涨到 3200B(上限 3000)——它每次开工全文注入,长了就不是仪表盘是日志。\n' +
      '   压法:**整段原文先搬进 ## Ledger(退役=移动,别删),再重写 Active 为当前状态**。规矩:每项目 ≤5 行、只留状态与指针。\n' +
      '   实测过的后果:上一版 30.4KB ≈ 1 万 tok/会话,且陈旧行两次误导判断(据「next M8.3」当主线,而 M20 早已 shipped)。\n' +
      '   规范全文 → config.md Write Discipline v2。修完再继续。\n';
    const l10a = makeLenRow('toolu_selftest_' + nonce + '_10a', 2, realFailText);
    const extracted10a = extractLengthChecks(realFailText);
    report('length legacy parse: 3 real check-classes extracted, continuation lines not mis-tagged as a 4th class',
      extracted10a.size === 3 && extracted10a.has('超长净增') && extracted10a.has('Index 奇偶') && extracted10a.has('Active 体积'), [...extracted10a]);
    const s10a = makePost('toolu_selftest_' + nonce + '_10a', [...extracted10a]);

    // rc=0 pass, empty checks
    const l10b = makeLenRow('toolu_selftest_' + nonce + '_10b', 0, '');
    const s10b = makePost('toolu_selftest_' + nonce + '_10b', []);

    // 截断:stderrTrunc=1 -> 该行 length 维不可比(不试图解析半截文本充数,MEDIUM-2 同一纪律)
    const l10c = makeLenRow('toolu_selftest_' + nonce + '_10c', 2, '⚠️ 冗余闸:\n部分截断的文本片段没有換行就断在这里而且看起来像是⚠️', { stderrTrunc: true });
    const s10c = makePost('toolu_selftest_' + nonce + '_10c', ['冗余']);

    const result10 = compareEvents({ shadowRows: [s10a, s10b, s10c], legacyRows: [l10a, l10b, l10c], analyzed: null });
    report('length: exact 3-class match counted', result10.length.matchEvents >= 1);
    report('length: stderr truncated -> incomparable (not compared, not a false match/mismatch)', result10.length.stat.incomparable >= 1, result10.length.stat);
  }

  // ── group 11: MEDIUM-2 truncation -> incomparable (push STDOUT channel; truncated JSON must never
  //    be scanned as if it were complete text -- that produces spurious 0-tag extractions == fabricated
  //    legacy-only "unexplained" diffs, exactly the wave3-review MEDIUM-2 finding). ──
  {
    const truncatedJsonPrefix = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '- [tooling:real-tag] Title that would be cut mid-escape \\u00' } }).slice(0, 80);
    const l11 = { hook: 'pmm-trigger-recall.sh', toolUseId: 'toolu_selftest_' + nonce + '_11', trunc: true, shaVerified: false, decodeOk: true, stdoutText: truncatedJsonPrefix, rc: 0 };
    const s11 = { tool: 'Edit', tool_use_id: 'toolu_selftest_' + nonce + '_11', phase: 'post', pushSelected: [{ tag: 'tooling:real-tag', source: 'direct' }], pushCandidatesPreTruncation: [], quotaTruncated: false };
    const result11 = compareEvents({ shadowRows: [s11], legacyRows: [l11], analyzed: { entries: [] } });
    report('MEDIUM-2: truncated legacy row (trunc=1) -> push incomparable, NOT compared as if lSet were empty',
      result11.push.stat.incomparable >= 1 && result11.push.stat.comparable === 0, result11.push.stat);
    report('MEDIUM-2: truncated row contributes zero fabricated unexplained diffs', result11.totalUnexplained === 0, result11.categoryCounts);
  }

  // ── group 12: MEDIUM-3 one-sided -> unexplained (shadow row proves the event happened; legacy tee
  //    line for a hook we KNOW was exercised this run is simply missing for this one tuid = a real gap). ──
  {
    // 造出「本次会话该旧 hook 确实被起过」的证据:另一个 tuid 有真实的 legacy recall 行。
    const seenProof = { hook: 'pmm-trigger-recall.sh', toolUseId: 'toolu_selftest_' + nonce + '_12seen', trunc: false, shaVerified: true, decodeOk: true, stdoutText: '', rc: 0 };
    const seenShadow = { tool: 'Edit', tool_use_id: 'toolu_selftest_' + nonce + '_12seen', phase: 'post', pushSelected: [], pushCandidatesPreTruncation: [], quotaTruncated: false };
    // 目标事件:shadow 有行,legacy 完全没有这个 tuid 的 recall 行 -> one-sided:push:legacy-missing
    const s12 = { tool: 'Edit', tool_use_id: 'toolu_selftest_' + nonce + '_12gap', phase: 'post', pushSelected: [{ tag: 'tooling:orphaned', source: 'direct' }], pushCandidatesPreTruncation: [], quotaTruncated: false };
    const result12 = compareEvents({ shadowRows: [seenShadow, s12], legacyRows: [seenProof], analyzed: { entries: [] } });
    report('MEDIUM-3: one-sided (shadow-only, hook WAS exercised this run) counted as unexplained',
      (result12.categoryCounts['one-sided:push:legacy-missing'] || 0) >= 1, result12.categoryCounts);
    report('MEDIUM-3: one-sided diff folds into totalUnexplained', result12.totalUnexplained >= 1, result12.totalUnexplained);

    // 对照:该旧 hook 这次会话从未被起过(dimHookSeenThisRun.push=false)时,同样的 shadow-only 缺口
    // 不应算未解释 —— 这是「这次会话没接这只 hook」的已知边界,不是逐事件异常(见文件头注「建造实测二」)。
    // 09-24 建造实测三(真实 220 事件回放抓到):这类事件也绝不能计进可比/非空 —— 计进去会让
    // echo/routing/length 三维在"整会话零比较"的情况下也报出「可比=220 非空=220」的假绿,让「零未解释
    // 生效」门槛被结构性缺口喂饱而不是被真比较喂饱。正确归类是不可比(见 oneSided() 的头注)。
    const s12b = { tool: 'Edit', tool_use_id: 'toolu_selftest_' + nonce + '_12solo', phase: 'post', pushSelected: [{ tag: 'tooling:orphaned2', source: 'direct' }], pushCandidatesPreTruncation: [], quotaTruncated: false };
    const result12b = compareEvents({ shadowRows: [s12b], legacyRows: [], analyzed: { entries: [] } });
    report('MEDIUM-3 boundary: hook never exercised this session -> shadow-only NOT counted as unexplained (known-gap, not a defect)',
      !result12b.categoryCounts['one-sided:push:legacy-missing'], result12b.categoryCounts);
    report('真空绿必红(端到端,09-24 实测三的回归夹具): hook 全会话未起时,「shadow 有行/legacy 无行」记不可比,绝不灌进可比/非空冒充真比较',
      result12b.push.stat.incomparable >= 1 && result12b.push.stat.comparable === 0 && result12b.push.stat.nonEmpty === 0, result12b.push.stat);
  }

  // ── group 13: 真空绿必红(vacuous-green must not validate) —— zeroUnexplainedEffective() 阈值判定。
  //    totalUnexplained===0 但 comparable/nonEmpty 远低于下限时,「零未解释」不应被判定为生效。
  {
    const lowStat = { inDomain: 1, comparable: 1, nonEmpty: 0, incomparable: 0 };
    report('真空绿必红: push dim with comparable=1 (far below 100) -> zero-unexplained NOT effective',
      zeroUnexplainedEffective('push', lowStat) === false, lowStat);
    const highStat = { inDomain: 150, comparable: 150, nonEmpty: 40, incomparable: 0 };
    report('真空绿必红对照: push dim meeting comparable>=100 and nonEmpty>=30 -> zero-unexplained IS effective',
      zeroUnexplainedEffective('push', highStat) === true, highStat);
    const echoLowNonEmpty = { inDomain: 50, comparable: 50, nonEmpty: 2, incomparable: 0 }; // comparable ok, nonEmpty too low
    report('真空绿必红: echo dim with comparable ok but nonEmpty=2 (below 10) -> NOT effective (vacuous both-empty matches)',
      zeroUnexplainedEffective('echo', echoLowNonEmpty) === false, echoLowNonEmpty);
  }

  // ── group 14: writer/echo/routing/length 字段规范化——形状不识别（非数组/非期望对象）一律 null
  //    (不可比),从不抛异常。────────────────────────────────────────────────────────────────────
  {
    report('normalizeShadowWriter: undefined -> null', normalizeShadowWriter(undefined) === null);
    report('normalizeShadowWriter: null -> null', normalizeShadowWriter(null) === null);
    report('normalizeShadowWriter: unrecognized shape (number) -> null, no throw', normalizeShadowWriter(42) === null);
    report('normalizeShadowEcho: unrecognized shape (string, not array) -> null, no throw', normalizeShadowEcho('oops') === null);
    report('normalizeShadowRouting: unrecognized shape (object, not array) -> null, no throw', normalizeShadowRouting({ foo: 1 }) === null);
    report('normalizeShadowLength: unrecognized shape (number) -> null, no throw', normalizeShadowLength(7) === null);
    report('normalizeShadowEcho: array of "tag|status" strings accepted', normalizeShadowEcho(['a:b|现行']).has('a:b|现行'));
    report('normalizeShadowEcho: array of [tag,status] tuples accepted', normalizeShadowEcho([['a:b', '现行']]).has('a:b|现行'));
    report('normalizeShadowEcho: array of {tag,status} objects accepted', normalizeShadowEcho([{ tag: 'a:b', status: '现行' }]).has('a:b|现行'));
  }

  // ── group 15: HIGH-2 直测(wave4 复审 `guards/audits/OPUS-2026-09-24-c05-wave4-review.md`)——
  //    normalizeShadowWriter/Routing/Length 现在认得 B1 真实的对象形状(pmm-hook.cjs:310/395/554
  //    computeWriterDimension/computeRoutingDimension/computeLengthDimension 的原样返回值),不再对
  //    这三维的真生产形态恒返回 null。每个正例后面跟一个「反证」:把该生产者真实字段名改名后必须
  //    重新变回不可比(null)——证明这条自测是在检查具体字段名,不是凑巧对任何对象都放行(否则这条
  //    自测本身就是 wave4 揭发的那种"永远碰巧通过"的假绿)。
  {
    const realWriterB5B32 = { b5b32Keys: ['B5|lessons.md|L12'], b5b32Total: 1, presenceKeys: [], presenceTotal: 0 };
    const nw1 = normalizeShadowWriter(realWriterB5B32);
    report('HIGH-2 writer: real B1 shape (b5b32Keys) now comparable (not null)',
      nw1 !== null && nw1.total === 1 && nw1.keys.length === 1 && nw1.keys[0] === 'B5|lessons.md|L12', nw1);
    const realWriterPresence = { b5b32Keys: [], b5b32Total: 0, presenceKeys: ['presence|decisions.md|2026-01-01 — x'], presenceTotal: 1 };
    const nw2 = normalizeShadowWriter(realWriterPresence);
    report('HIGH-2 writer: real B1 shape (presenceKeys) now comparable (not null)',
      nw2 !== null && nw2.total === 1 && nw2.keys[0] === 'presence|decisions.md|2026-01-01 — x', nw2);
    const realWriterClean = { b5b32Keys: [], b5b32Total: 0, presenceKeys: [], presenceTotal: 0 };
    const nw3 = normalizeShadowWriter(realWriterClean);
    report('HIGH-2 writer: real B1 clean shape -> comparable, empty (0 keys)', nw3 !== null && nw3.total === 0 && nw3.keys.length === 0, nw3);
    const driftedWriter = { b5b32KeysRENAMED: ['B5|x|L1'], b5b32Total: 1, presenceKeysRENAMED: [], presenceTotal: 0 };
    report('HIGH-2 writer ADVERSARIAL: renamed field (shape drift) goes back to null (incomparable), not silently comparable',
      normalizeShadowWriter(driftedWriter) === null, driftedWriter);

    const realRouting = { rc: 2, hits: ['5:**2026-01-01 — x** [axervice:probe]'] };
    const nr1 = normalizeShadowRouting(realRouting);
    report('HIGH-2 routing: real B1 shape ({rc,hits}) now comparable (not null)',
      nr1 !== null && nr1.size === 1 && nr1.has('5:**2026-01-01 — x** [axervice:probe]'), nr1 && [...nr1]);
    const realRoutingClean = { rc: 0, hits: [] };
    const nr2 = normalizeShadowRouting(realRoutingClean);
    report('HIGH-2 routing: real B1 clean shape -> comparable, empty', nr2 !== null && nr2.size === 0, nr2 && [...nr2]);
    const driftedRouting = { rc: 2, hitsRENAMED: ['5:x'] };
    report('HIGH-2 routing ADVERSARIAL: renamed field (shape drift) goes back to null',
      normalizeShadowRouting(driftedRouting) === null, driftedRouting);

    const realLength = { classes: ['原话引用', 'Index 奇偶'], notComputed: ['取代图', '冗余'], detail: {}, baselineAvailable: true, rc: 2 };
    const nl1 = normalizeShadowLength(realLength);
    report('HIGH-2 length: real B1 shape ({classes,...}) now comparable (not null)',
      nl1 !== null && nl1.size === 2 && nl1.has('原话引用') && nl1.has('Index 奇偶'), nl1 && [...nl1]);
    const realLengthClean = { classes: [], notComputed: ['取代图', '冗余'], detail: {}, baselineAvailable: false, rc: 0 };
    const nl2 = normalizeShadowLength(realLengthClean);
    report('HIGH-2 length: real B1 clean shape -> comparable, empty', nl2 !== null && nl2.size === 0, nl2 && [...nl2]);
    const driftedLength = { classesRENAMED: ['原话引用'], notComputed: [] };
    report('HIGH-2 length ADVERSARIAL: renamed field (shape drift) goes back to null',
      normalizeShadowLength(driftedLength) === null, driftedLength);

    // HIGH-2 length 增补:「取代图/冗余」两类 B1 结构性算不出(pmm-hook.cjs:604 notComputed 恒含这两
    // 项),legacy 侧若真报了 -> 从 legacy 比较集里摘除同名标签,不该被判 length-mismatch。
    const legacyStderrWithNotComputed = '⚠️ 取代图不变量违规 [tooling:x]\n⚠️ 冗余闸:…\n⚠️ 原话引用 [tooling:y]\n';
    const legacySetWithNC = extractLengthChecks(legacyStderrWithNotComputed);
    report('length notComputed setup: legacy extraction sees all 3 classes (sanity)', legacySetWithNC.size === 3, [...legacySetWithNC]);
    const lenRowNC = { hook: 'pmm-entry-length-watch.sh', toolUseId: 'toolu_selftest_' + nonce + '_15nc', trunc: false, shaVerified: true, rc: 2, stdoutText: '', stderrText: legacyStderrWithNotComputed, stderrTrunc: false, stderrDecodeOk: true, cols: 9 };
    const shadowRowNC = { tool: 'Edit', tool_use_id: 'toolu_selftest_' + nonce + '_15nc', phase: 'post', length: { classes: ['原话引用'], notComputed: ['取代图', '冗余'] } };
    const resultNC = compareEvents({ shadowRows: [shadowRowNC], legacyRows: [lenRowNC], analyzed: null });
    report('HIGH-2 length: legacy-only 取代图/冗余 (B1 结构性算不出) 从比对里摘除 -> match,不是 length-mismatch',
      resultNC.length.matchEvents >= 1 && !resultNC.categoryCounts['length-mismatch'], resultNC.categoryCounts);

    // HIGH-3 直测:extractLegacyEcho 空/纯空白 stdout -> 空集(不是 null)。真实场景:entry-length-watch
    // --block 通过校验但本次编辑没有 [[引用]](pmm-write-echo.cjs:17/24 在这两种情况下 process.exit(0)
    // 不写任何 stdout)——活体窗口 107 条假未解释的根因就是这个空 stdout 被当 tee-corrupt。
    report('HIGH-3 echo: empty stdout -> empty Set (not null)', (() => { const s = extractLegacyEcho(''); return s !== null && s.size === 0; })());
    report('HIGH-3 echo: whitespace-only stdout -> empty Set (not null)', (() => { const s = extractLegacyEcho('   \n\t \n'); return s !== null && s.size === 0; })());
    report('HIGH-3 echo: null/undefined stdout -> empty Set (not null)', (() => { const s = extractLegacyEcho(null); return s !== null && s.size === 0; })());
    report('HIGH-3 echo: genuinely non-empty, non-JSON stdout still -> null (real corruption stays corruption)', extractLegacyEcho('not json at all') === null);
    // end-to-end через processEcho: empty legacy stdout + empty shadow echo -> match, NOT tee-corrupt:echo
    {
      const lenRowEmpty = { hook: 'pmm-entry-length-watch.sh', toolUseId: 'toolu_selftest_' + nonce + '_15echo', trunc: false, shaVerified: true, rc: 0, stdoutText: '', stderrText: '', stderrTrunc: false, stderrDecodeOk: true, cols: 9 };
      const shadowRowEmpty = { tool: 'Edit', tool_use_id: 'toolu_selftest_' + nonce + '_15echo', phase: 'post', echo: [] };
      const resultEcho = compareEvents({ shadowRows: [shadowRowEmpty], legacyRows: [lenRowEmpty], analyzed: null });
      report('HIGH-3 echo e2e: empty stdout + empty shadow echo -> match (comparable, not tee-corrupt:echo, not unexplained)',
        resultEcho.echo.matchEvents >= 1 && !resultEcho.categoryCounts['tee-corrupt:echo'] && resultEcho.totalUnexplained === 0,
        resultEcho.categoryCounts);
    }
  }

  // ── group 16: HIGH-2/HIGH-3 端到端集成自测(spec 补遗三第 29 条;task ③)—— 隔离 HOME 下用真
  //    pmm-hook.cjs + 真四旧 hook(pmm-trigger-write-gate.sh/pmm-trigger-recall.sh/
  //    pmm-entry-length-watch.sh/pmm-lessons-routing.sh,经 settings.json 同款 --pre/--shadow/--block/
  //    PMM_TEE_LOG 调用形态)跑三个夹具事件(带 tag 的 lessons 编辑 + 路由违规 + 超长条目),9 列 tee,
  //    再用对照器比对,断言五维每维可比数>0、非空数>0、总未解释=0。末尾一个反例:捕获真实产出的一行,
  //    改一个字段名模拟"生产者形状再漂移",断言对照器重新判不可比(自测本身对未来漂移敏感,不是只在
  //    今天这份固定 fixture 上凑巧全绿)。
  {
    const T = mkRoot('e2e5dim');
    const memDir = T + '/.claude/memory';
    fs.mkdirSync(memDir, { recursive: true });
    // 两个标记点:Index 区与 Entries 区各一个,每个事件用 MultiEdit 的两个子编辑同时补 Index 行与
    // Entries 块 —— lessons.md 的「Index 奇偶」检查(pmm-entry-length-watch.sh)要求两区条目数逐一相等,
    // 只加 Entries 不加 Index 会让每个事件之后都恒定违规(rc=2),把 length-watch 永久卡在 gated-off,
    // echo 维(挂在同一只 --block hook 后面)也会跟着永远不可比 —— 09-24 建造实测排查得出。
    const IDXMARK = '<!--e2e5dim-idx-mark-->';
    const ENTMARK = '<!--e2e5dim-ent-mark-->';
    // nonce 本身含 ':'(见文件顶部 `'test:shadowcmpst-' + …`)—— tag 标识符正则(namespace:identifier)
    // 的冒号后半段不允许再出现冒号,直接拼进 tag 会让整条 tag 解析失败(09-24 建造实测:push/echo 两维
    // 非空数=0,并非维度本身有问题,是 tag 从未被任何一侧的解析器认出过)。tag 专用一份净化后缀。
    const nonceTag = nonce.replace(/[^A-Za-z0-9._-]/g, '-');
    const anchorTag = 'tooling:e2e5dim-anchor-' + nonceTag;
    const relPath = '.claude/memory/lessons.md'; // resolveRepoRel() 的 rel 相对 HOME 全路径,不是相对 memory/
    const initial = '## Index\n' +
      '- 2026-01-01 — e2e5dim anchor [' + anchorTag + ']\n' + IDXMARK + '\n\n' +
      '## Entries\n' +
      '**2026-01-01 — e2e5dim anchor** [' + anchorTag + ']\n' +
      '<!-- trigger: tool=Edit|Write|MultiEdit; repo=home; path=' + relPath + ' -->\n' +
      'anchor body for the shadow-compare 5-dim end-to-end probe.\n\n' + ENTMARK + '\n';
    fs.writeFileSync(memDir + '/lessons.md', initial);
    for (const f of core.ALL_FILES) { if (f !== 'lessons.md') fs.writeFileSync(memDir + '/' + f, ''); }
    fs.writeFileSync(T + '/.claude/.pmm-len-baseline', '0\n');
    fs.writeFileSync(T + '/.claude/.pmm-len-baseline.idx', '0\n');
    // entry-length-watch.sh 调用 write-echo 用的是 "$HOME/.claude/pmm-write-echo.cjs"(HOME 相对,不像
    // write-gate.sh/trigger-recall.sh 那样用脚本自身所在目录 $G)——isoEnv 下 HOME=T,这个文件不存在就
    // 不存在,不是缺陷,是一份真实 PMM 装机在那个 HOME 下本来就会有这个文件;镜像它(连同它唯一需要的
    // pmm-core.cjs,供 scope-check helper 的 isUnderCanonical 用)进隔离根,09-24 建造实测排查得出
    // (此前 write-echo 因 MODULE_NOT_FOUND 静默产出空 stdout,被 HIGH-3 修好的「空=空」误判成假匹配)。
    fs.mkdirSync(T + '/.claude/guards', { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '..', 'pmm-write-echo.cjs'), T + '/.claude/pmm-write-echo.cjs');
    fs.copyFileSync(path.resolve(__dirname, 'pmm-core.cjs'), T + '/.claude/guards/pmm-core.cjs');

    const env = iso.isoEnv(T, {});
    const HOOK = path.resolve(__dirname, '..', 'pmm-hook.cjs');
    const TRIGGER_RECALL_SH = path.resolve(__dirname, 'pmm-trigger-recall.sh');
    const TRIGGER_WRITE_GATE_SH = path.resolve(__dirname, 'pmm-trigger-write-gate.sh');
    const ENTRY_LENGTH_WATCH_SH = path.resolve(__dirname, '..', 'pmm-entry-length-watch.sh');
    const LESSONS_ROUTING_SH = path.resolve(__dirname, '..', 'pmm-lessons-routing.sh');
    const legacyLog = T + '/.claude/.shadow/legacy-' + mach() + '.log';
    const teeEnv = Object.assign({}, env, { PMM_TEE_LOG: legacyLog });

    // idxLine/entBlock 分别补进 Index 区与 Entries 区(MultiEdit 的两个子编辑,同一次工具调用)。
    function runEvent(tuid, idxLine, entBlock) {
      const toolInput = {
        file_path: memDir + '/lessons.md',
        edits: [
          { old_string: IDXMARK, new_string: idxLine + '\n' + IDXMARK },
          { old_string: ENTMARK, new_string: entBlock + '\n\n' + ENTMARK },
        ],
      };
      const evt = Buffer.from(JSON.stringify({ tool_name: 'MultiEdit', session_id: nonce + '-e2e5dim', tool_use_id: tuid, tool_input: toolInput }));
      // Pre phase (settings.json order: write-gate 先, pmm-hook --pre 后 -- 顺序在两只互不相关的 Pre
      // 钩子之间无关紧要;MUST spawn pmm-hook.cjs before any Post-phase legacy hook needs .shadow/ to
      // already exist, 同 group 6 顺序注释).
      cp.spawnSync(process.execPath, [HOOK, '--shadow', '--pre'], { env, input: evt });
      cp.spawnSync('bash', [TRIGGER_WRITE_GATE_SH], { env: teeEnv, input: evt });
      // 模拟真实工具已经执行:把这次编辑真的落盘(Pre 阶段的两只钩子只读重建 prospective,从不写盘;
      // Post 阶段的三只旧钩子读的是磁盘上的当前内容,不是 tool_input 本身)。
      let cur = fs.readFileSync(memDir + '/lessons.md', 'utf8');
      for (const e of toolInput.edits) {
        const idx = cur.indexOf(e.old_string);
        if (idx === -1) throw new Error('e2e5dim fixture bug: old_string not found on disk for ' + tuid + ': ' + e.old_string);
        cur = cur.slice(0, idx) + e.new_string + cur.slice(idx + e.old_string.length);
      }
      fs.writeFileSync(memDir + '/lessons.md', cur);
      // Post phase (settings.json 顺序:lessons-routing --block, entry-length-watch --block,
      // pmm-trigger-recall, 再 pmm-hook --shadow).
      cp.spawnSync('bash', [LESSONS_ROUTING_SH, '--block'], { env: teeEnv, input: evt });
      cp.spawnSync('bash', [ENTRY_LENGTH_WATCH_SH, '--block'], { env: teeEnv, input: evt });
      cp.spawnSync('bash', [TRIGGER_RECALL_SH], { env: teeEnv, input: evt });
      cp.spawnSync(process.execPath, [HOOK, '--shadow'], { env, input: evt });
    }

    // 事件 A ——「一次带 tag 的 lessons 编辑」:新增一条带 tag 的条目,故意不带 trigger 注释(presence
    // 闸命中,给 writer 维一个非空信号),正文里 [[引用]] 锚点条目(给 echo 维一个「现行」非空信号)。
    const tuidA = 'toolu_selftest_' + nonce + '_5dimA';
    const tagA = 'tooling:e2e5dim-tag-probe-' + nonceTag;
    runEvent(tuidA,
      '- 2026-01-02 — e2e5dim tagged entry (no trigger) [' + tagA + ']',
      '**2026-01-02 — e2e5dim tagged entry (no trigger)** [' + tagA + ']\n引用锚点: [[' + anchorTag + ']]。'
    );

    // 事件 B ——「一次路由违规」:axervice 命名空间(routing 的固定 fallback 名单成员之一)条目落进
    // lessons.md,触发 pmm-lessons-routing 的项目专属教训误落判定。
    const tuidB = 'toolu_selftest_' + nonce + '_5dimB';
    const tagB = 'axervice:e2e5dim-routing-probe-' + nonceTag;
    runEvent(tuidB,
      '- 2026-01-03 — e2e5dim routing probe [' + tagB + ']',
      '**2026-01-03 — e2e5dim routing probe** [' + tagB + ']\n' +
        '<!-- trigger: tool=Edit|Write|MultiEdit; repo=home; path=' + relPath + ' -->\n' +
        'project-specific text that should not live in the general PMM lessons.md.'
    );

    // 事件 C ——「一次超长条目」:正文 >900B(LEN_LIMIT),配合预置基线(prev=0)触发「超长净增」。
    const tuidC = 'toolu_selftest_' + nonce + '_5dimC';
    const tagC = 'tooling:e2e5dim-long-probe-' + nonceTag;
    runEvent(tuidC,
      '- 2026-01-04 — e2e5dim overlong entry [' + tagC + ']',
      '**2026-01-04 — e2e5dim overlong entry** [' + tagC + ']\n' +
        '<!-- trigger: tool=Edit|Write|MultiEdit; repo=home; path=' + relPath + ' -->\n' +
        'x'.repeat(950)
    );

    let shadowText = '', legacyText = '';
    try { shadowText = fs.readFileSync(T + '/.claude/.shadow/hook-' + mach() + '.log', 'utf8'); } catch { /* ignore */ }
    try { legacyText = fs.readFileSync(legacyLog, 'utf8'); } catch { /* ignore */ }
    const { rows: shadowRows } = parseShadowLog(shadowText);
    const { rows: legacyRows } = parseLegacyLog(legacyText);
    report('e2e5dim: real pmm-hook.cjs produced 6 shadow rows (3 events x Pre+Post)', shadowRows.length === 6, shadowRows.length);
    report('e2e5dim: real 4 legacy hooks produced 12 tee rows (3 events x 4 hooks: write-gate + routing + length-watch + recall)', legacyRows.length === 12, legacyRows.length);
    report('e2e5dim: all 12 legacy tee rows parsed as 9 columns (E-6b format)', legacyRows.every((r) => r.cols === 9), legacyRows.map((r) => r.cols));

    const { analyzed } = analyzeMemDir(memDir);
    const result = compareEvents({ shadowRows, legacyRows, analyzed });

    for (const dim of ['push', 'writer', 'echo', 'routing', 'length']) {
      const st = result[dim].stat;
      report('e2e5dim task③: ' + dim + ' 维可比数>0 (三维不再恒不可比)', st.comparable > 0, st);
      report('e2e5dim task③: ' + dim + ' 维非空数>0', st.nonEmpty > 0, st);
    }
    report('e2e5dim task③: 五维总未解释=0(真 B1 产出 + 真四旧 hook 产出,对照器认得两边真实形状)',
      result.totalUnexplained === 0, result.categoryCounts);

    // ── 反例:生产者形状再漂移必红 ── 取一行真实捕获到的 Pre writer 行,把 B1 的真实字段名改掉,
    //    证明对照器会重新判不可比,而不是对任何对象形状都碰巧放行(这正是 wave4 揭发的旧自测的错误:
    //    72/0 全绿只因从未喂过真生产形状,断言本身也走了同一条"字段缺失→不可比"分支,把断裂当成功)。
    const realWriterRow = shadowRows.find((r) => r.phase === 'pre' && r.tool_use_id === tuidA);
    report('e2e5dim ADVERSARIAL setup: captured a real Pre shadow row with a non-empty writer field to mutate',
      !!(realWriterRow && realWriterRow.writer && (realWriterRow.writer.b5b32Keys || realWriterRow.writer.presenceKeys)), realWriterRow && realWriterRow.writer);
    if (realWriterRow && realWriterRow.writer) {
      const w = realWriterRow.writer;
      const mutatedRow = Object.assign({}, realWriterRow, {
        writer: { b5b32KeysRENAMED: w.b5b32Keys, b5b32Total: w.b5b32Total, presenceKeysRENAMED: w.presenceKeys, presenceTotal: w.presenceTotal },
      });
      const mutatedShadowRows = shadowRows.map((r) => (r === realWriterRow ? mutatedRow : r));
      const resultMut = compareEvents({ shadowRows: mutatedShadowRows, legacyRows, analyzed });
      report('e2e5dim ADVERSARIAL: renaming the REAL captured B1 field name (b5b32Keys/presenceKeys -> …RENAMED) makes writer LESS comparable, not silently unchanged (self-test is sensitive to future producer/consumer drift)',
        resultMut.writer.stat.comparable < result.writer.stat.comparable, { before: result.writer.stat, after: resultMut.writer.stat });
    }
  }

  const markers = iso.markersFromSource(__filename, nonce, runRootBase);
  const fpResult = iso.footprint.end(fpSnapshot, markers);
  report('footprint: zero attributable change on the real root', fpResult.red === false, fpResult.line);

  for (const l of lines) console.log(l);
  console.log('PMM-SHADOW-COMPARE-SELFTEST {"pass":' + pass + ',"fail":' + fail + '}');
  process.exit(fail > 0 ? 1 : 0);
}
// SELFTEST-END

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test') || argv.includes('--self-check')) selfTest();
  else runCli(argv);
}
