#!/usr/bin/env bash
# pmm-manifest 包装器。用法: [--json|--check] | --self-test
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"; mkdir -p "$T"
  mk() { printf '%s' "$1" > "$T/lessons.md"; : > "$T/decisions.md"; : > "$T/standinginstructions.md"; }
  ok=0
  # 1 红 B1:Supersedes 悬空目标
  mk '**2026-01-02 — n** [a:new]
b
Supersedes: [[a:ghost-never-defined]]
'
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  # 2 红 B2:取代环
  mk '**2026-01-01 — a** [a:x]
b
Supersedes: [[a:y]]

**2026-01-02 — b** [a:y]
b
Supersedes: [[a:x]]
'
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  # 3 红 B3:Index 标记与声明矛盾
  mk '## Index

- 2026-01-01 [a:old] o (superseded→[a:wrong])

## Entries

**2026-01-01 — o** [a:old]
b

**2026-01-02 — n** [a:new]
b
Supersedes: [[a:old]]

**2026-01-03 — w** [a:wrong]
b
'
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  # 4 绿:干净链(Index 双射完整——两条目各有自己的 Index 行)
  mk '## Index

- 2026-01-01 [a:old] o (superseded→[a:new])
- 2026-01-02 [a:new] n

## Entries

**2026-01-01 — o** [a:old]
b

**2026-01-02 — n** [a:new]
b
Supersedes: [[a:old]]
'
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 0 ] && ok=$((ok+1))
  # 5 红 B4:数数平账但集合不等(条目无 Index 行 + Index 行无条目)必须拦
  printf '%s' '## Index

- 2026-01-01 [a:phantom] 幽灵行

## Entries

**2026-01-02 — 真条目** [a:real]
b
' > "$T/lessons.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  # 6 红 B5:trigger 注释格式错(path= 独行,缺 tool/repo)→ 推送端静默忽略,写入时必须拦
  printf '%s' '## Index

- 2026-01-02 [a:real] 真条目

## Entries

**2026-01-02 — 真条目** [a:real]
<!-- trigger: path=.claude/guards/ -->
b
' > "$T/lessons.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  # 7 红 B6:Class 目标不在 classes.md(受控词表)
  printf '%s' '## Index

- 2026-01-02 [a:real] 真条目

## Entries

**2026-01-02 — 真条目** [a:real]
Class: [[class:ghost-never-defined]]
b
' > "$T/lessons.md"
  printf '%s' '**2026-09-14 — 类:甲** [class:alpha]
判据:x
' > "$T/classes.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  # 8 红 B6:2026-09-15 起的新教训没有 Class 行
  printf '%s' '## Index

- 2026-09-15 [a:new] 新条目

## Entries

**2026-09-15 — 新条目** [a:new]
b
' > "$T/lessons.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  # 9 绿 B6:新教训带合法 Class 且类已定义
  printf '%s' '## Index

- 2026-09-15 [a:new] 新条目

## Entries

**2026-09-15 — 新条目** [a:new]
Class: [[class:alpha]]
b
' > "$T/lessons.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 0 ] && ok=$((ok+1))
  # 10 绿 B5(HIGH-4b 2026-09-15,guards/audits/FABLE-2026-09-15-glob-review-triage.md finding 4b,回归
  #    守卫——注:实测这条在 0ee7541(glob 支持已上线)之后一直是绿的,不是本批修复的红→绿 break-测
  #    试;本批 HIGH-4b 的真正红→绿证据是 pmm-core-high4b-probe.cjs 的 require.cache 实现替换黑盒测
  #    试,见 pmm-core.sh --self-test)。这里只是补一条 pmm-manifest.cjs(现役写入闸,真实通过
  #    PostToolUse 挂在生产上)的端到端 spawn 子进程证据:真实语料上唯一的多 token glob
  #    (src/lib/**/*lock*)必须被判合法——防止写入闸未来又独立发明一套不认得 `**` 的判断。
  printf '%s' '## Index

- 2026-01-02 [a:real] 真条目

## Entries

**2026-01-02 — 真条目** [a:real]
<!-- trigger: tool=Edit|Write; repo=axervice-booking; path=src/lib/**/*lock* -->
b
' > "$T/lessons.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 0 ] && ok=$((ok+1))
  # 11 绿 R7-2(2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md MEDIUM-1):a fenced
  #    DOCUMENTATION EXAMPLE — an entry header + a Class: line to an undefined class + a Supersedes:
  #    line to a target that does not exist, entirely inside a ``` block — must NOT be parsed as a
  #    second real entry (core.parseFile() treats fenced content as opaque body text of the enclosing
  #    real entry, never a new entry). Before R7-2 this file's `wasFence` gated ONLY the trigger-
  #    classification branch; the entry-header/Class/Supersedes scanning below it were fence-BLIND and
  #    raised spurious B1 (dangling Supersedes target)/B4 (no Index row for the phantom entry)/B6
  #    (undefined Class target) on a corpus parseFile sees as perfectly clean.
  printf '%s' '## Index

- 2026-01-02 [a:real] 真条目

## Entries

**2026-01-02 — 真条目** [a:real]
b

下面是围栏内的书写示例,不是真实条目:
```
**2026-01-03 — 围栏内假条目(不是真条目)** [a:fence-ghost]
Class: [[class:does-not-exist]]
Supersedes: [[a:dangling-target-not-defined]]
```
围栏结束。
' > "$T/lessons.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 0 ] && ok=$((ok+1))
  # 12 红 R7-3(2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md LOW-1 /
  #     round-6 深审 §四 复核为坐实):R5-2 converged this file's trigger-tool validation onto
  #     core.classifyTriggerLine (replacing a private `tool=([^;]+)` regex that accepted ANY string for
  #     `tool=`), but that fix never got its OWN break-test in this self-test — a typo'd tool value like
  #     `tool=Edti` (silently dead: the recall engine's `tr.tools.includes(tool)` never matches it) must
  #     be rejected (B5) here, the CURRENT, live write-time gate, not just at the recall-engine layer.
  printf '%s' '## Index

- 2026-01-02 [a:real] 真条目

## Entries

**2026-01-02 — 真条目** [a:real]
<!-- trigger: tool=Edti; repo=axervice-booking; path=src/lib/foo.ts -->
b
' > "$T/lessons.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  # 13 红 R8-2(2026-09-15 round 8, guards/audits/OPUS-2026-09-15-round8-review.md MEDIUM-1):test #11
  #     above proves a CLOSED fenced example is invisible to B1/B4/B6 (matches core.parseFile()). This
  #     one proves the missing other half: an UNCLOSED fence (the ``` on the line below never closes)
  #     must itself be blocking (B32) — otherwise every real construct in the file AFTER the stray fence
  #     open (not just the fenced example) goes invisible to this — the CURRENT, live write-time — gate
  #     for the rest of the file, a strictly LARGER blind spot than the one R7-2 closed. The corpus below
  #     is otherwise completely clean (real entry has its own Index row, no Class/Supersedes issues) —
  #     the fenced "second entry"'s dangling Supersedes target must NOT itself produce a B1 (that would
  #     mean the fence gating silently stopped working, the OPPOSITE finding from R7-2's own test #11);
  #     the only diagnostic that may fire here is B32.
  printf '%s' '## Index

- 2026-01-02 [a:real] 真条目

## Entries

**2026-01-02 — 真条目** [a:real]
b

下面的围栏故意不闭合(直到文件结尾都没有配对的```):
```
**2026-01-03 — 围栏内假条目(不该被解析)** [a:fence-ghost]
Supersedes: [[a:dangling-target-not-defined]]
' > "$T/lessons.md"
  PMM_MEM_DIR="$T" node "$G/pmm-manifest.cjs" --check >/dev/null 2>&1; [ $? -eq 2 ] && ok=$((ok+1))
  rm -rf "$T"
  if [ "$ok" -eq 13 ]; then echo "pmm-manifest 自证 13/13(B1-B6 红 + 干净绿 ×2 + HIGH-4b glob 写入闸绿 + round-7 围栏内假条目绿 + tool=Edti 红 + round-8 未闭合围栏红[B32])"; exit 0; fi
  echo "✖ pmm-manifest 自证 $ok/13"; exit 1
fi
exec node "$G/pmm-manifest.cjs" "$@"
