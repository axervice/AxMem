#!/usr/bin/env bash
# PMM write-integrity guard (v2, 2026-07-25「写入一步到位」— 原 entry-length guard 2026-07-04 扩展)
# 三重校验,对应 Write Discipline v2 第 5 条硬闸:
#   A. 超长净增(原有): decisions/lessons 条目体 > LIMIT 字节,数量较基线增加才拦(不骚扰存量豁免条)。
#   B. Index 奇偶(新): decisions/lessons/standing 的 Index 行数 == Entries 条目数,不平=有条目没建索引(或孤儿)。
#   C. 孤儿形态(新): 三文件非 Index 区出现「^- 20xx-xx-xx」日期列表块 = v2.1 式畸形写入,当场拦。
# 模式: SessionStart(无参)=站桩提醒; PostToolUse(--block)=违规 exit2 反馈 Claude 当场修。
# 2026-09-13 校准(Jax [memory:entry-cap-900b-sole-record],起因「壓的指針不失真」):
#   600→900:检索取回窗(标题+grep -A12)≈900B 一次取全 —— 条目再长取回也是截断的;
#   存量实况 超600B=233条 / 超900B=34条,旧线连忠实条目的自然尺寸都容不下,税全落在保真度。
#   [sole-record] 豁免:细节无处可指(无 repo/CHANGELOG/review 落点)→ 禁止强压,全文合法;
#   标记写在标题行或正文任意处,配对闸 = guards/pmm-pointer-lint.sh(能指的必须指得准)。
# #16 修正(OPUS-2026-09-26 辩护方裁决,CODEX-2026-09-26-w11-w15-home-review.md #16):按字节数量
# tee 行长度,不用 `${#var}`(在 UTF-8 locale 下按字符数算,遇多字节字符会与真实字节数分叉)。定义
# 在文件顶层(不在下面的 tee 条件块里)。本文件按 selftest-entry-roster.json 记录无 --self-test
# 入口(W13-F 已判定,由 pmm-shell-memory-watch.sh / pmm-supersede-fixture-test.sh 当 DUT 外部
# 驱动),因此没有内置回归例——同一份判断逻辑已在 pmm-trigger-recall.sh case 35 与
# pmm-trigger-write-gate.sh 的 --self-test 里验证过。
_TEE_MAX_LINE_BYTES=3800
_tee_bytelen() { printf '%s' "$1" | wc -c; }

# ── C05-BUILD-SPEC B2 tee (2026-09-24, read-only; PMM_TEE_LOG unset ⇒ zero behavior change) ──
if [ -n "${PMM_TEE_LOG:-}" ] && [ -z "${_PMM_TEE_INNER:-}" ] && [ "${1:-}" != "--self-test" ] && [ "${1:-}" != "--self-check" ]; then
  _tee_in="$(mktemp)"; _tee_out="$(mktemp)"; _tee_err="$(mktemp)"
  cat > "$_tee_in" 2>/dev/null || true
  _PMM_TEE_INNER=1 "$0" "$@" < "$_tee_in" > "$_tee_out" 2> "$_tee_err"
  _tee_rc=$?
  cat "$_tee_out"
  cat "$_tee_err" >&2
  _tee_tuid="$(grep -o '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$_tee_in" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [ -z "$_tee_tuid" ] && _tee_tuid="$(grep -o '"toolUseId"[[:space:]]*:[[:space:]]*"[^"]*"' "$_tee_in" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  # M-10 fix (2026-09-24, audit `guards/audits/OPUS-2026-09-24-c05-batch-review.md` §2 / errata E-6):
  # record the hook's IDENTITY and its stdout's ORIGINAL text (spec item 2 says "把自己的 stdout/exit
  # code 追加一行", not a hash of it) instead of just sha256(stdout) with no way to tell which of the
  # four legacy hooks a line came from. base64-encodes stdout so embedded tabs/newlines never break
  # this TSV row; caps at 1200B of RAW stdout (item 20/23's existing payload ceiling, reused here since
  # no separate tee-specific cap exists in spec) before truncating, and always also records sha256 of
  # the FULL untruncated stdout so a truncated line still has something to verify a candidate blob
  # against.
  # E-6b fix (2026-09-24, C05-BUILD-SPEC addendum 3 item 29, main-brain ruling): 7 cols -> 9. stderr is
  # now captured to its own temp file (instead of inheriting fd 2 straight through) so it can be
  # base64-encoded into the tee row for the comparator to decode routing/length failures from; it is
  # still forwarded byte-for-byte to the real caller via `cat >&2` right after stdout, so --block mode's
  # stderr+exit-2 feedback path sees identical bytes as before -- only the timing (buffered vs live)
  # changes, and only while PMM_TEE_LOG is set.
  _tee_hook="$(basename "$0")"
  _tee_out_size="$(wc -c < "$_tee_out" 2>/dev/null | tr -d '[:space:]')"
  _tee_sha="$(sha256sum "$_tee_out" 2>/dev/null | cut -d' ' -f1)"
  if [ -n "$_tee_out_size" ] && [ "$_tee_out_size" -gt 1200 ]; then
    _tee_trunc=1
    _tee_b64="$(head -c 1200 "$_tee_out" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
  else
    _tee_trunc=0
    _tee_b64="$(base64 < "$_tee_out" 2>/dev/null | tr -d '\n')"
  fi
  _tee_err_size="$(wc -c < "$_tee_err" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$_tee_err_size" ] && [ "$_tee_err_size" -gt 1200 ]; then
    _tee_err_trunc=1
    _tee_err_b64="$(head -c 1200 "$_tee_err" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
  else
    _tee_err_trunc=0
    _tee_err_b64="$(base64 < "$_tee_err" 2>/dev/null | tr -d '\n')"
  fi
  # W12-2 (2026-09-25, 组9 tee 并发交织根治,不加锁): 四旧 hook 各写自己的文件(配置值 + "." + 本 hook
  # 基名,如 legacy-<mach>.log.pmm-entry-length-watch),不再共用同一 $PMM_TEE_LOG——消除跨 hook 交织
  # (`>> "$PMM_TEE_LOG"` 本就是无锁 append,多个不同 hook 并发写*同一*文件才会在行中途切断;各写各的
  # 文件后同一文件只有这一只 hook 的调用会写,交织窗口消失,不需要 flock/mkdir 锁,也不改 settings.json
  # 或 $PMM_TEE_LOG 本身的配置值)。旧的统一文件路径保留只读(历史数据),对照器合并读四个分文件 + 该
  # 历史文件。
  #
  # LOW-2(FAB-2026-09-25 W11+W12 盲攻复核)+ #16 修正(OPUS-2026-09-26 辩护方裁决,CODEX-2026-09-26-
  # w11-w15-home-review.md #16,CONFIRMED):分文件之后同一分文件仍可能被同一 hook 的多个并发实例
  # (同一工具调用事件被并行触发两次)无锁 `>>` 追加。此前这里的依据写的是"整行字节数 < PIPE_BUF(标准
  # 4096)时,单次 write() 对同一 fd 的 O_APPEND 写是原子的"——这条引用是错的:PIPE_BUF 是 POSIX 对
  # pipe/FIFO 单次 write() 的原子性保证,不覆盖对普通文件的 O_APPEND 写,普通文件没有这条保证。真正
  # 兜底的是下游:撕裂行会改变列数,pmm-shadow-compare.cjs 的 parseLegacyLog() 按
  # `f.length !== 7 && f.length !== 9` 把它计入 parseErrors,在对照报告里可见,不会被静默接受为合法
  # 行(辩护方已实测确认)。这里的显式常量 + 写入前实测断言,语义仍是"超限就再截一刀、标 trunc=1"
  # (与两路 1200B 硬顶同款),只是不再需要 PIPE_BUF 撑腰。长度按字节数判断(`_tee_bytelen`,文件顶层
  # 定义,printf+wc -c,不用 `${#var}`——UTF-8 locale 下它按字符数算,tee 行里除 tool_use_id(平台生成
  # 的 ASCII `toolu_…`)外全是 ASCII,但字符数与字节数在含多字节字符时仍会分叉)。正常路径(两路都在
  # 1200B 硬顶内,实测整行约 3.4KB)不会触发这条兜底,行为与改动前逐字节相同。
  _tee_ts="$(date -u +%FT%TZ)"
  _tee_line="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_tee_ts" "$_tee_hook" "${_tee_tuid:--}" "$_tee_trunc" "${_tee_b64:--}" "${_tee_sha:--}" "$_tee_rc" "${_tee_err_b64:--}" "$_tee_err_trunc")"
  if [ "$(_tee_bytelen "$_tee_line")" -gt "$_TEE_MAX_LINE_BYTES" ]; then
    _tee_trunc=1
    _tee_b64="$(head -c 400 "$_tee_out" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
    _tee_line="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_tee_ts" "$_tee_hook" "${_tee_tuid:--}" "$_tee_trunc" "${_tee_b64:--}" "${_tee_sha:--}" "$_tee_rc" "${_tee_err_b64:--}" "$_tee_err_trunc")"
    if [ "$(_tee_bytelen "$_tee_line")" -gt "$_TEE_MAX_LINE_BYTES" ]; then
      _tee_err_trunc=1
      _tee_err_b64="$(head -c 200 "$_tee_err" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
      _tee_line="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_tee_ts" "$_tee_hook" "${_tee_tuid:--}" "$_tee_trunc" "${_tee_b64:--}" "${_tee_sha:--}" "$_tee_rc" "${_tee_err_b64:--}" "$_tee_err_trunc")"
    fi
  fi
  printf '%s\n' "$_tee_line" >> "$PMM_TEE_LOG.${_tee_hook%.sh}" 2>/dev/null || true
  rm -f "$_tee_in" "$_tee_out" "$_tee_err"
  exit "$_tee_rc"
fi

LIMIT=900
STATE="${PMM_STATE_FILE:-$HOME/.claude/.pmm-len-baseline}"   # 金丝雀红测用 override,防真基线被夹具毒化(2026-07-31 有过毒化事故)
MEM="${PMM_MEM_DIR:-$HOME/.claude/memory}"           # 金丝雀红测用 override:喂夹具目录,不碰真记忆

# 2026-09-13 Opus 审计 P2(1.9s/Edit 的大头在本脚本):--block 模式下若 hook stdin 带 file_path
# 且不在 memory 目录 → 本次编辑不可能改变任何被守量,直接放行。非 hook 调用(tty)不受影响。
if [ "${1:-}" = "--block" ] && [ ! -t 0 ]; then
  # timeout 兜底(2026-09-13):后台进程的 stdin 是不闭合管道时,裸 head 永久阻塞——
  # 当天两条后台链因此挂死。1 秒拿不到 hook JSON 就当没有,走全量检查(fail-safe 方向正确)。
  if command -v timeout >/dev/null 2>&1; then _hin="$(timeout 1 head -c 4096 2>/dev/null || true)"; else _hin=""; fi
  # E7(2026-09-14 自查):hook JSON 里的 Windows 路径是 `C:\\Users\\…` 双反斜杠转义,tr 后成
  # `C://Users//…//memory//`,与 `/.claude/memory/` 对不上 → 09-13 起所有 Edit 工具的记忆写入被
  # 静默放行(只剩提交层 E2 沉井兜底)。盲攻与自审都没抓到:夹具经 Bash 工具输入时反斜杠被折半,
  # 从未喂过生产形态。修:折叠连续斜杠。夹具改用文件里逐字写的 JSON(guard-canary E7 行)。
  _fp="$(printf '%s' "$_hin" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' | tr '\\' '/' | sed 's#//*#/#g')"
  # 统一小写比对(2026-09-14 fab E3:Windows FS 不分大小写,\MEMORY\ 路径原样绕过五检)
  _fpl="$(printf '%s' "$_fp" | tr 'A-Z' 'a-z')"
  # M-1 修法(2026-09-23,guards/audits/OPUS-2026-09-23-a2-a5-review.md M-1,A2 自己引入的回归):
  # MEDIUM-4 收敛(见下)把预筛从"整条路径子串匹配"改成了"basename ∈ 8 个固定文件名"的白名单——但
  # 阻断检查 D(引用缺命名空间,`grep -rho '\[\[…\]\]' "$MEM"/*.md`,在全检函数体里)扫的是 memory
  # 目录下**全部** .md 文件(实测 25 个),E-graph/R 冗余闸/write-echo 同样在全检函数体里、同样不分
  # 文件。旧的 8 文件白名单会让另外 17 个 .md 文件的这些写入错误地零成本放行——实证:夹具
  # processes.md 含 `[[foo]]`,同一次 Edit 换成 processes/memory/timeline/preferences/config.md 为
  # file_path,旧脚本(子串预筛)rc=2,只按 8 文件白名单的脚本 rc=0。改法:候选集不再是固定文件名
  # 列表,而是"剥后缀后 basename 以 `.md` 结尾"——这样进 helper 的候选集与"检查 D 到底扫哪些文件"
  # 的真实范围一致,不再需要在这两处分别维护一份列表。
  #
  # MEDIUM-4 收敛(2026-09-23,guards/audits/OPUS-2026-09-23-codex-final-triage.md #8 /
  # guards/audits/OPUS-2026-09-23-fab-delta-triage.md MEDIUM-4):这道预筛此前是对**整条路径**做
  # 子串匹配("*/.claude/memory/*"),对 `./`、`memory.\`、junction、UNC、ADS 后缀这些"词法上不含
  # 该子串,但实际落在 canonical 内"的写法一律 exit 0 放行——HIGH-2 收敛只解决了子串命中之后的
  # 权威判定,预筛本身仍在用子串"猜"。改成只看 **basename**(小写化后剥尾 `.`/空格与 `:` 流后缀)——
  # 交给下面的 node helper 做权威判定(helper 调用 core.isUnderCanonical,已收敛
  # realpathForCompare/UNC-admin-share/ADS 归一化,见 pmm-core.cjs 自己的头注)。basename 判断本身
  # 故意宽松(`:` 后缀不区分默认数据流/命名流,一律先剥再判)——宽松预筛的代价只是多调一次 node
  # (≈60ms,只发生在 .md 文件上),权威判定全部下放给 helper,fail-safe 方向不变。
  #
  # L-6 顺手优化(guards/audits/OPUS-2026-09-23-a2-a5-review.md L-6):basename 提取改用纯参数展开,
  # 不再 fork sed/子 shell(实测每次 Edit 省 ~114ms)。`${_fpl##*/}` 取最后一段(最长前缀匹配剥离);
  # `${_bn%%:*}` 剥 `:` 流后缀(已是参数展开);尾随 `.`/空格用 while 循环逐字符剥,同样零 fork。
  _bn="${_fpl##*/}"
  _bn="${_bn%%:*}"
  while :; do
    case "$_bn" in
      *.) _bn="${_bn%.}" ;;
      *" ") _bn="${_bn% }" ;;
      *) break ;;
    esac
  done
  case "$_bn" in
    "") : ;;                                  # 没解析到路径 → 保守全跑
    *.md)
      # HIGH-2 收敛(2026-09-17,fab 盲攻 + Opus 复现,Jax 铁律「基建先抄开源再优化」):上面的
      # basename 预筛只是"值得认真看"的门槛,不是权威判断。权威判断收敛到 pmm-core.cjs 的
      # isUnderCanonical——与 pmm-trigger-write-gate.cjs 用同一个函数(vendor domenic/
      # path-is-inside + jonschlinkert/normalize-path 的前缀剥离,不是两处各写一份正则),两闸
      # 不再各自维护一份"是否在目录内"的判断。basename 预筛留着是为了性能(多数编辑离记忆目录很远,
      # 零 fork 的参数展开比启一个 node 进程便宜得多);只有命中候选集(任意 .md)的这一小撮才多付
      # 一次 node 启动去做权威确认。脚本内容含反斜杠/正则转义,一律 heredoc 落一个临时 .cjs 文件
      # 再用 node 跑,不用 `node -e` 内联(2026-09-10 血的教训
      # [tooling:node-e-inline-strips-backslashes-in-claude-bash]:`node -e` 内联脚本落盘会把反斜杠
      # 吃掉,两次真实事故)。fail-safe 方向:node 不可用/崩溃/给不出确切答案时,一律维持候选集命中
      # 的原判断继续全跑,只有 node 明确给出"确实不在 canonical 内"才改判放行——不确定时永远偏向
      # "多做一次全检",不偏向"少做一次"。
      #
      # L-5 修法(2026-09-23,guards/audits/OPUS-2026-09-23-a2-a5-review.md L-5;确认——helper 原来
      # 用 rc=1 表示"确认不在范围内",但 node 未捕获异常/MODULE_NOT_FOUND 的退出码**同样是** 1(实测
      # `MSYS_NO_PATHCONV=1` 时 helper 自身的脚本路径未被 MSYS 翻译,node 直接找不到入口文件崩溃,
      # rc=1——与"确认不在范围"撞码,于是真记忆写入被直接放行,新旧脚本都有此洞,并非本批引入)。
      # 撞码的后果:一次真正的 node 崩溃会被当成"确认在范围外",本该更保守("给不出确切答案就全跑")
      # 的 fail-safe 分支反而被绕过。改用专用码:0=在范围(→往下走全检),3=确认不在范围(→跳过),
      # 任何其它 rc(1/2/崩溃/找不到入口文件……)一律当"给不出确切答案"处理,落回全检分支。
      if command -v node >/dev/null 2>&1; then
        _scope_helper="$(mktemp)" 2>/dev/null || _scope_helper=""
        if [ -n "$_scope_helper" ]; then
          cat > "$_scope_helper" <<'SCOPE_CHECK_EOF'
const raw = require('fs').readFileSync(0, 'utf8');
const m = raw.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
if (!m) process.exit(2);
let fp; try { fp = JSON.parse('"' + m[1] + '"'); } catch { process.exit(2); }
let core; try { core = require(process.argv[3]); } catch { process.exit(2); }
process.exit(core.isUnderCanonical(fp, process.argv[2]) ? 0 : 3);
SCOPE_CHECK_EOF
          # MEDIUM-4 收敛:此前这里传 `-- "$MEM" "…pmm-core.cjs"`,node 的 argv 把字面量 `--` 本身
          # 排进 process.argv[2],helper 却读 process.argv[1]/[2] 当 MEM/core 路径——`require('--')`
          # 对任何输入都抛异常,rc 恒为 2,scope 收窄从未真正生效过(只是"多做一次全检"的 fail-safe
          # 分支从未被绕开,不是安全洞,但优化是死代码)。去掉 `--`,helper 侧的 argv 索引同步右移一位。
          printf '%s' "$_hin" | node "$_scope_helper" "$MEM" "$HOME/.claude/guards/pmm-core.cjs" 2>/dev/null
          _scope_rc=$?
          rm -f "$_scope_helper"
          [ "$_scope_rc" -eq 3 ] && exit 0
        fi
      fi
      if command -v timeout >/dev/null 2>&1; then _hin="$_hin$(timeout 1 cat 2>/dev/null || true)"; fi
      HOOK_JSON="$_hin" ;;
    *) exit 0 ;;                              # basename 不以 .md 结尾 → 零成本放行
  esac
fi
HOOK_JSON="${HOOK_JSON:-}"
DEC="$MEM/decisions.md"; LES="$MEM/lessons.md"; STD="$MEM/standinginstructions.md"

count_over(){ [ -f "$1" ] || { echo 0; return; }
  # LC_ALL=C 钉死字节口径:CJK locale 下 awk length() 返回字符数,手动跑会把错误基线写进 STATE(2026-07-31 实测毒化事故)
  # 条目体边界 = `Ratified by:` 行 或 `---` 分隔线(2026-08-02 dream B2):此前一路累加到下个 `**20` 标题,
  # 把条目之后的归档出处注记(`*(…)*` / `*Archived →…` / `*RAG…`)与 PERMANENT 锚点块算进上一条 body,
  # 制造超长假象 —— 实测 m7-strategy 857→真 425(已达标)、codex-plus-backstop 2185→真 667。计数不准 = 分批收错对象。
  # 2026-09-13 Opus 审计逃逸①封堵:原「Ratified by:/--- 即停计」= 把正文挪到 Ratified 行后就
  # 全部免计(实测 5447B 放行)。改为计到下一个 ^**20 标题;归档注记(*(…)*/*Archived/*RAG)
  # 逐行跳过——2026-08-02 引入停计规则要防的虚高,由行级跳过实现,不再留免计尾巴。
  # 跳过行限额(2026-09-14 fab E5:逐行套 *(…) 衣可让 4KB 条目计 0)——每条目前 3 行免计,之后照算
  # Class 行免计(2026-09-14 分类法):严格形态 `Class: [[class:x]]` 一行、有界(manifest B6 拦非标形态),不是内容
  LC_ALL=C awk -v L="$LIMIT" '/^\*\*20/{if(h&&sz>L&&!ex)n++; h=$0;sz=0;sk=0;ex=index($0,"[sole-record]")>0;next} /^Class: \[\[class:[a-z0-9-]+\]\]$/{next} /^\*\(|^\*Archived|^\*RAG/{sk++; if(sk>3)sz+=length($0); next} h{sz+=length($0); if(index($0,"[sole-record]")>0)ex=1} END{if(h&&sz>L&&!ex)n++; print n+0}' "$1"; }
now=$(( $(count_over "$DEC") + $(count_over "$LES") ))

# I/Q: 提炼闸(2026-09-14 Jax「給記憶設置一個提煉守衛,把我的原話精簡提煉」)。机器只数两样数得清的:
#   I  Index 行字节 >IDX_LIMIT(320B≈100 汉字;Index 每会话全文注入,是最大 token 项,细节该留条目里)
#   Q  attribution 引原话:写「原话/逐字/verbatim」或引 ≥120B 的「」原文(记忆=提炼,来源+日期+一句要点即可)
# 两者都是基线相对(净增即拦),corpus 清干净后可改绝对。中英择简/clause 清单是判断题,留在 config ⑦ 纪律。
IDX_LIMIT=320
count_idx_over(){ [ -f "$1" ] || { echo 0; return; }
  LC_ALL=C awk -v L="$IDX_LIMIT" '/^## Index|^### Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/&&length($0)>L{n++} END{print n+0}' "$1"; }
count_quotes(){ [ -f "$1" ] || { echo 0; return; }
  LC_ALL=C awk '/<!-- attribution:/{ if ($0 ~ /原话|逐字|verbatim/) {n++; next}
    s=index($0,"「"); if(!s) next; t=$0; e=0; p=0; while((k=index(t,"」"))>0){p+=k; e=p; t=substr(t,k+1)}
    if(e && e-s>=120) n++ } END{print n+0}' "$1"; }
now_i=$(( $(count_idx_over "$DEC") + $(count_idx_over "$LES") + $(count_idx_over "$STD") ))
now_q=$(( $(count_quotes "$DEC") + $(count_quotes "$LES") + $(count_quotes "$STD") ))
STATE_I="${STATE}.idx"; STATE_Q="${STATE}.quote"

# B: Index↔Entries 奇偶(decisions/lessons: 全文件;standing: 只数 ## Entries 区条目 vs ### Index 行)
parity=""
p(){ # $1=file $2=label $3=mode(dl|std)
  [ -f "$1" ] || return 0
  if [ "$3" = "std" ]; then
    ix=$(awk '/^### Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/{n++} END{print n+0}' "$1")
    en=$(awk '/^## Entries/{e=1} e&&/^\*\*20/{n++} END{print n+0}' "$1")
  else
    ix=$(awk '/^## Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/{n++} END{print n+0}' "$1")
    en=$(grep -c '^\*\*20' "$1")
  fi
  [ "$ix" -ne "$en" ] && parity="$parity ${2}(Index ${ix}≠Entries ${en})"
}
p "$DEC" decisions dl; p "$LES" lessons dl; p "$STD" standing std

# C: 孤儿形态(非 Index 区的日期列表块;processes.md 体裁豁免不在此列)
orphans=""
for f in "$DEC" "$LES" "$STD"; do
  [ -f "$f" ] || continue
  o=$(awk '/^## Index|^### Index/{i=1} /^## Entries/{i=0} !i&&/^- 20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/{n++} END{print n+0}' "$f")
  [ "$o" -gt 0 ] && orphans="$orphans $(basename "$f" .md)(${o}块)"
done

# C3: 伪装条目标题(2026-09-13 Opus 审计逃逸②封堵):`> **2026…` 这类带前缀的标题形态会让
# 计数/奇偶/退役追踪/标题锚定检索四路同时失明。检出「行内含 **20xx-xx-xx — 且带 [ns:tag]
# 但不以 ** 起行」即拦。纯正则零判断;Index 行(- 起行)与正文引用极少命中此全形态。
ghosts=""
for f in "$DEC" "$LES" "$STD"; do
  [ -f "$f" ] || continue
  g=$(grep -cE '^[^*[:space:]].*\*\*20[0-9][0-9]-[0-9][0-9]-[0-9][0-9][^*]*\*\*.*\[[a-z][a-z0-9-]*:' "$f" 2>/dev/null); g=${g:-0}
  # 前导空格伪装(2026-09-14 fab E4:一个空格骗过六个消费者)
  g2=$(grep -cE '^[[:space:]]+\*\*20[0-9][0-9]-[0-9][0-9]-[0-9][0-9][^*]*\*\*.*\[[a-z][a-z0-9-]*:' "$f" 2>/dev/null); g2=${g2:-0}
  g=$((g+g2))
  [ "$g" -gt 0 ] && ghosts="$ghosts $(basename "$f" .md)(${g}行)"
done

# C2: progress.md 的 ## Active 段体积上限(2026-08-06,Jax 问「过时内容能不能自动移走」)。
#
# 为什么只卡体积、不判「过时」:机器分不清「试点店 cmrli86k7」是还在用还是早废了;
# 按日期标老行也不行(「生产 LIVE 07-12」又老又当前 → 大面积误报 → 检查被整条删掉)。
# **体积是纯事实,零判断。** 分工:机器只报「太大了」,砍哪几行由人定 —— 与已有的
# 条目超长闸同形状(它也只说「这条太长」,不说怎么压)。
#
# 它治的是一个机制而非一次疏忽:**加是事件触发**(每次干完活都有理由记一笔),
# **删是判断触发**(「这条还当前吗」的时机永远不明确)—— 只进不出的单向棘轮。
# 实测:Active 从「每项目 ≤5 行」的规矩涨到 52 行 / 30.4KB ≈ 1 万 tok/会话,
# 其中三周前的陈旧行 2026-08-06 两次误导判断(据「next M8.3」当主线,而 M20 早已 shipped)。
# 体积压力还**间接治过时**:被逼压缩时最先砍的自然是旧的。
# 上限 3000B ≈ 重写后 1613B 的近两倍裕量:容得下正常增长,拦得住失控。
PROG_LIMIT=3000
PROG="$MEM/progress.md"
active_bytes=0
[ -f "$PROG" ] && active_bytes=$(LC_ALL=C awk '/^## Active/{f=1;next} /^## Ledger/{f=0} f{n+=length($0)+1} END{print n+0}' "$PROG")

# D: 引用缺命名空间(阻断)。写 [[gsd-paused]] 而定义是 [axervice:gsd-paused] —— 两种写法并存,
# 任何"找悬空指针"的扫描都会大面积误报。2026-08-03 实测:107 个 tag 带前缀、34 个不带,
# 那 34 个直接制造了一轮 91 疑似 / 78 假阳性的普查浪费。纯正则、零判断,所以阻断。
noprefix=""
for _t in $(grep -rho '\[\[[a-z0-9][a-z0-9._-]*\]\]' "$MEM"/*.md 2>/dev/null | tr -d '[]' | sort -u); do
  case "$_t" in *:*) continue;; esac
  grep -rqh "\[[a-z]\{1,\}:${_t}\]" "$MEM"/*.md 2>/dev/null && noprefix="$noprefix [[${_t}]]"
done

# E-sup: 取代记账闸(2026-09-13 Jax「旧记忆被更新或取代的话直接给旧记忆做标记」——
# 纪律早有「取代式写入三步」,但闸只管删除入档,不管「声明了 Supersedes 却忘标旧条 Index」。
# 忘标 = 旧版仍以现行姿态待在索引里 = 时间错乱的温床。纯 grep,零判断。)
supviol=""
for _t in $(grep -hE '^[[:space:]]*Supersedes:' "$DEC" "$LES" "$STD" 2>/dev/null | grep -oE '\[\[[a-z][a-z0-9-]*:[A-Za-z0-9._-]+\]\]' | tr -d '[]' | sort -u); do
  # 锚定「行自己的 tag」= 日期后第一个方括号;不锚定会命中新条目行里的 (supersedes→[旧]) 反向引用
  _row=$(grep -h "^- 20[^][]*\[${_t}\]" "$DEC" "$LES" "$STD" 2>/dev/null | head -1)
  if [ -n "$_row" ] && ! printf '%s' "$_row" | grep -q 'superseded→'; then supviol="$supviol [$_t]"; fi
done

# E(悬空引用检查)—— **建过,跑过,砍了。** 记在这里免得有人再造一遍:
# 设想是警告"[[tag]] 指向从没写过的条目"(2026-08-03 普查确有 13 处)。实现后在干净仓库上
# 一次报 48 条,里面是 [[0.4.0]] [[true]] [[index.ts]] [[qwen3:14b]],还有格式模板里的
# [[namespace:tag]] —— `[[...]]` 在代码示例、版本号、文件名里天然会出现,而真正的悬空
# 引用埋在这堆噪声里。再窄化也甩不掉跨库定义(rag:/upwork: 在 D:\RAG 等)这一类真假阳性。
# 一个在干净仓库上就报 48 次的警告,第二天就没人看 —— 那比没有更糟,因为它读起来像有覆盖。
# 审查者(Fable)批准了这条,但它没跑过;**跑一次就废了。证据高于预测。**
# 真要做,正确形态不是"事后扫",是让漏写在结构上不可能 —— 见下方 F 的思路。

if [ "${1:-}" = "--block" ]; then
  prev=$(cat "$STATE" 2>/dev/null || echo -1)
  fail=0; msg=""
  if [ "$prev" -ge 0 ] 2>/dev/null && [ "$now" -gt "$prev" ]; then
    fail=1; msg="${msg}⚠️ 新增超长条目(${prev}→${now},上限 ${LIMIT}B): 压成「本体+WHY+→指针」,或——细节无处可指(PMM 是唯一档)时标 [sole-record] 全文保留(禁止失真强压)。\n"
  fi
  prev_i=$(cat "$STATE_I" 2>/dev/null || echo -1); prev_q=$(cat "$STATE_Q" 2>/dev/null || echo -1)
  if [ "$prev_i" -ge 0 ] 2>/dev/null && [ "$now_i" -gt "$prev_i" ]; then
    fail=1; msg="${msg}⚠️ 新增超长 Index 行(${prev_i}→${now_i},上限 ${IDX_LIMIT}B≈100 字):Index 行每会话全文注入——tag+一句「什么/为什么」,细节留条目里 grep。\n"
  fi
  # Q 已改绝对(2026-09-14 存量 26 处原话引用当日提炼清零):任何一处即拦,不看基线
  if [ "$now_q" -gt 0 ]; then
    fail=1; msg="${msg}⚠️ 原话引用 ${now_q} 处:记忆=语义不变的提炼,不留原话——attribution 只写来源+日期+一句要点(config ⑦)。\n"
  fi
  [ -n "$parity" ] && { fail=1; msg="${msg}⚠️ Index 奇偶不平:${parity} —— 新条目忘加 Index 行(或条目畸形没被计数),当场补齐。\n"; }
  [ -n "$orphans" ] && { fail=1; msg="${msg}⚠️ 孤儿日期列表块:${orphans} —— 规则性内容必须是标准条目(标题+tag+Ratified),禁止裸列表/挂尾(v2.1 事故形态)。\n"; }
  [ -n "$ghosts" ] && { fail=1; msg="${msg}⚠️ 伪装条目标题:${ghosts} —— 标题必须以 ** 起行(带前缀=对计数/奇偶/退役/检索四路隐形,Opus 逃逸②)。\n"; }
  [ -n "$noprefix" ] && { fail=1; msg="${msg}⚠️ 引用缺命名空间:${noprefix} —— 定义带前缀、引用不带,会让悬空扫描大面积误报(2026-08-03: 34 处 → 一轮 78 个假阳性)。补成 [[ns:tag]]。\n"; }
  [ -n "$supviol" ] && { fail=1; msg="${msg}⚠️ 取代记账缺失:${supviol} —— 有条目声明 Supersedes 它,但它的 Index 行没标 (superseded→…)。旧版正以现行姿态留在索引里=时间错乱温床;同笔补标。\n"; }
  # E-graph 取代图不变量(2026-09-14 manifest 批):悬空取代目标/成环/标记与声明矛盾 → 拦
  if command -v node >/dev/null 2>&1; then
    _gout="$(PMM_MEM_DIR="$MEM" node "$HOME/.claude/guards/pmm-manifest.cjs" --check 2>/dev/null | grep '⛔' || true)"
    [ -n "$_gout" ] && { fail=1; msg="${msg}⚠️ 取代图不变量违规:\n${_gout}\n"; }
    # R 冗余闸(2026-09-14 Jax「允许豁免但必须在不失真前提下精简用词」):只数得清的四道——
    # R1 条目内 ≥12 字符汉语短语二现 / R2 与他条目共享 ≥40 字符纯散文 / R3 填充词 / R4 gzip 比过低;
    # R1/R4 只拦 [sole-record](豁免的代价),R2/R3 拦全部;术语/对照/标识符重复不算;[redundancy-ok] 逃生口进月审。
    _rout="$(PMM_MEM_DIR="$MEM" node "$HOME/.claude/guards/pmm-redundancy-lint.cjs" 2>/dev/null | grep -v '^pmm-redundancy-lint:' || true)"
    printf '%s' "$_rout" | grep -q '⛔' && { fail=1; msg="${msg}⚠️ 冗余闸:\n${_rout}\n"; }
  fi
  [ "$active_bytes" -gt "$PROG_LIMIT" ] && { fail=1; msg="${msg}⚠️ progress.md 的 ## Active 涨到 ${active_bytes}B(上限 ${PROG_LIMIT})——它每次开工全文注入,长了就不是仪表盘是日志。\n   压法:**整段原文先搬进 ## Ledger(退役=移动,别删),再重写 Active 为当前状态**。规矩:每项目 ≤5 行、只留状态与指针。\n   实测过的后果:上一版 30.4KB ≈ 1 万 tok/会话,且陈旧行两次误导判断(据「next M8.3」当主线,而 M20 早已 shipped)。\n"; }
  # F(未做,记在这里):"声称已被 X 取代但 X 里没有" 这类丢内容,正确解法不是去搜 X 的内容
  # (那是模糊匹配,会变成又一个自身缺陷不低于被守对象的文本级守卫),而是**取消"删除"这个动作**:
  # 退役 = 移动。live 文件删掉一条 → 同一 commit 必须在对应 *-archive.md 出现同一条标题行(逐字精确匹配)。
  # 这样"内容丢失"结构上不可能,"X 有没有覆盖到"这个问题直接消失 —— 原文永远在档案里。
  # 属 commit 级检查,归 pmm-precommit-gate.sh,不是这个 PostToolUse hook。(Fable 2026-08-03)
  if [ "$fail" -eq 1 ]; then
    # 基线不更新(codex R3 抓的粘性 bug:先写基线会让下一次调用 now==prev 放行)——修完超长回落后基线才随 pass 路径刷新
    { echo "<!-- pmm-write-integrity -->"; printf "%b" "$msg"; echo "   规范全文 → config.md Write Discipline v2。修完再继续。"; } >&2
    exit 2
  fi
  echo "$now" > "$STATE"; echo "$now_i" > "$STATE_I"; echo "$now_q" > "$STATE_Q"
  # 写入关联回显(2026-09-13 Jax:「写入时也跳出关联与因果记忆,一边写一边维护旧的」)——
  # 校验全绿后,把本次写入接上的 [[链]] 与 Supersedes 目标的现况回显给写入者(便利非闸,失败静默)。
  if [ -n "$HOOK_JSON" ]; then
    printf '%s' "$HOOK_JSON" | PMM_MEM_DIR="$MEM" node "$HOME/.claude/pmm-write-echo.cjs" 2>/dev/null || true
  fi
  exit 0
fi

# SessionStart: 刷新基线 + 站桩
echo "$now" > "$STATE"; echo "$now_i" > "$STATE_I"; echo "$now_q" > "$STATE_Q"
out=""
[ "$now" -gt 0 ] && out="${out}ℹ️ decisions/lessons 有 ${now} 条超 ≤80 词纪律(>${LIMIT}B),dream 分批收。\n"
[ -n "$parity" ] && out="${out}⚠️ Index 奇偶不平:${parity}(立刻补齐)。\n"
[ -n "$orphans" ] && out="${out}⚠️ 孤儿块:${orphans}(按 Write Discipline v2 第2条重整)。\n"
[ -n "$out" ] && { echo "<!-- pmm-write-integrity -->"; printf "%b" "$out"; }
exit 0
