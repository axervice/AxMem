#!/usr/bin/env bash
# pmm-fault-matrix.sh — C05-BUILD-SPEC.md 交付物 8. 薄壳:所有逻辑在 pmm-fault-matrix.cjs。
# 隔离闸(补遗二第 21 条)会把这个文件本身算作 DUT——调用者必须带完整的
# HOME=$T USERPROFILE=$T PMM_HOME=$T 前缀(T 是不在 <真 home>/.claude 下的临时目录),即使本工具
# 内部从不读 HOME 决定自己的路径(GUARDS_DIR/HOOK_PATH/INDEX_EMIT_PATH/FAULTS_DIR 全部由 __dirname
# 推出)——它唯一会用到进程自身 HOME 的地方是把它转交给每个 DUT 子进程各自独立算出的 isoEnv(T)。
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$G/pmm-fault-matrix.cjs" "$@"
