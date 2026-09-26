# lib/ — 第三方来源记账

(独立于 `guards/vendor/VENDOR.md`——那份记账入口在本次落地时正被另一并发建造者编辑
`## minisearch` 段落,为避免把两个会话的改动混进同一提交,本条改记在 lib/ 自己的
VENDOR.md,记账对象是 `lib/` 下的模块,不是被 vendor 的第三方源码文件本身。)

## write-file-atomic(考虑但未 vendor,2026-09-24,group 6 补 —— 见
`guards/audits/BORROW-MATRIX-2026-09-24-full.md` 第6组)

- **背景**:`adapters/claude-code/merge-hooks.cjs` 对真实 `~/.claude/settings.json` 的写入原是
  `fs.copyFileSync`(备份)+ `fs.writeFileSync`(直接写)两步,进程崩溃/断电发生在两步之间会留下
  半写的 settings.json。矩阵裁决要求补原子写,首选候选是 `npm/write-file-atomic`。
- **未 vendor 的理由(核实于 2026-09-24,npm registry 逐版本核对)**:该包**没有一个版本
  同时满足「与本仓 Node >=20 引擎地板兼容」和「零生产依赖」**——
  - 最新稳定版 `8.0.0`(`dist-tags.latest`,ISC)已把旧的 `imurmurhash` 依赖去掉,只剩
    `signal-exit@^4.0.1` 一个依赖,但它的 `engines` 要求 `^22.22.2 || ^24.15.0 || >=26.0.0`——
    与本仓 `package.json` 自己声明的 `"engines": {"node": ">=20"}` 不兼容,且**本次落地时
    实测本机 `node --version` 为 `v24.14.1`,连 `8.0.0` 自己的引擎要求都不满足**。
  - 每个与 Node >=20 兼容的更早版本都同时带 `imurmurhash` **和** `signal-exit` 两个依赖
    (registry 逐版本核实:`4.0.2` engines `^12.13.0||^14.15.0||>=16.0.0`、`5.0.1` engines
    `^14.17.0||^16.13.0||>=18.0.0`,两者 `dependencies` 均为
    `{"imurmurhash":"^0.1.4","signal-exit":"^3.0.x 或 ^4.0.1"}`)。
  - 结论:vendor 这个包(哪怕只是"复制源文件进仓库、不走 npm install"的本仓惯例做法)要么要
    再多 vendor 一条依赖链(signal-exit,且引入它会在每次 CLI/hook 调用时注册全局进程信号
    处理器,而它解决的只是"进程被信号杀死时顺手删掉孤儿临时文件"这个整洁性问题,不影响
    真正要保的正确性属性),要么就要接受一个连本仓自己 Node 版本地板都不满足的引擎要求。
    两条路都不划算,判定为**不 vendor**。
- **改用方案**:`lib/atomic-write.cjs` 手写约 25 行的 `writeFileAtomicSync()`,算法参照
  write-file-atomic 的 sync 路径(同目录暂存文件 → write → **fsync**(该仓已有的
  `lifecycle/install-manifest.cjs`/`lifecycle/restore.cjs` 两处既有的暂存+rename 模式都没有
  这一步,这里补上,是比既有模式更强的持久性保证)→ close → rename 发布;跳过的仅是
  write-file-atomic 的 `signal-exit` onExit 清理钩子(信号杀死时的孤儿临时文件清理,
  整洁性而非正确性)。落地文件见 `lib/atomic-write.cjs` 头注释,自测含一例"rename 前模拟
  崩溃、真实目标文件字节不变"。
- **接入点**:`adapters/claude-code/merge-hooks.cjs` 对 `SETTINGS` 的写入(此次唯一改动的
  写点,矩阵报告点名的那一处)。`lifecycle/backup.cjs` 的 staging 拷贝步骤矩阵报告曾一并提及,
  但派工任务把范围收紧到"报告点名的那一处",此次未动,留给下一批任务处置。

## normalize-path(3行边界条件,非独立 vendor 文件 —— 2026-09-24,group 8 补,见
`guards/audits/BORROW-MATRIX-2026-09-24-full.md` 第8组)

- **来源**:`jonschlinkert/normalize-path` v3.0.0,`index.js` 第19-27行(MIT,
  https://github.com/jonschlinkert/normalize-path/blob/3.0.0/index.js)——Windows
  扩展长度/设备命名空间前缀(`\\?\`/`\\.\`)判断边界条件。
- **未独立 vendor 整个包的理由**:上游整个包(30行)做的是跨平台 glob 路径归一化,本仓只需要
  其中判断"是否是 `\\?\`/`\\.\` 前缀"这一个边界条件,且本仓要的处理结果(整段剥掉前缀,
  换回一个可直接与无前缀路径按字节比较的原生路径)与上游行为(改写成保留的 `//?/` 标记)不同,
  引入整个包只会多一层不需要的依赖。此判断条件此前已经在 `guards/pmm-core.cjs` 的
  `stripWin32DeviceNamespacePrefix()`(2026-09-17 HIGH-2)独立落地过一次,这次只是把同一个
  已验证过的3行判断条件搬进 `lib/msys-path.cjs`,未新增依赖。
- **落地文件**:`lib/msys-path.cjs` 的 `stripWin32DeviceNamespacePrefix()`(含 `\\?\UNC\...`
  的额外一支,展开成 `\\host\share\...`,这一支是 Win32 API 文档记载的纯语法等价改写,
  不是从 normalize-path 抄来的,单独在函数头注释里说明来源)。
