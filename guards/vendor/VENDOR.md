# guards/vendor/ — 来源、版本、许可证、上游正文 sha256(统一记账)

C05-BUILD-SPEC.md 补遗二 §19(the maintainer 09-17 铁律「基建先抄开源再优化,不手写排序器/路径判定」):
凡是本仓依赖的第三方算法/判定逻辑,先 vendor 现成实现,再在各自调用方的包装层加业务逻辑;
vendor 文件正文与上游逐字节一致,只在文件头加前置注释(来源/版本/许可证/sha256),不改正文。
本文件是这批 vendor 文件的统一记账入口(spec 原文:「统一记在 guards/vendor/VENDOR.md」)。

## unbash

- **来源**:`webpro-nl/unbash`(npm 包名 `unbash`;上游仓库 `https://github.com/webpro-nl/unbash`)
- **URL**:`https://registry.npmjs.org/unbash/-/unbash-4.0.11.tgz`
- **版本**:4.0.11(C05-BUILD-SPEC.md 补遗三 第27条「借用来源」段未指定精确版本,只要求
  vendor `unbash`;`guards/audits/BORROW-SURVEY-2026-09-24-c05.md` 对象 1 的调查在 2026-09-24
  当天核实的也是这个版本,故按调查所用版本原样 vendor,4.0.11 是 2026-09-24 当天 npm dist-tag
  `latest` —— **建者按调查取的最新版落地,精确版本号未经主脑逐一点名批准,收口时请核对**。
  `curl https://registry.npmjs.org/unbash/-/unbash-4.0.11.tgz` 于 2026-09-24 取得,tarball
  sha256 `43524c66522277cf83973df12c9cec287f20f4604c2573c753e04e33d3b59832`
  (=64 hex chars 的前 64 位,见下方逐文件正文 sha256;整包 shasum-1 与 npm registry `dist.shasum`
  逐字核对一致:`694c177e8bf8865c1d570177f10ae538617f1577`)
- **许可证**:ISC(全文见 `unbash/LICENSE`,取自 tarball 根 `LICENSE`,逐字节未改)
- **依赖**:0 生产依赖(`package.json` `dependencies` 为空;`devDependencies` 里的
  tree-sitter/sh-syntax/bash-parser 等只用于上游自己的构建/基准测试,不随 `dist/` 发布,未被
  vendor 的任何文件 `import`)
- **vendor 文件**(取自 tarball 内 `dist/*.js`,只 vendor `parse()` 入口 `dist/parser.js` 的
  真实运行时传递闭包 7 个文件——`dist/printer.js`(`./printer` 这个次要 export,未被本仓任何调用方
  使用)、`dist/source-map.js`、`dist/types.js`(TS interface-only,编译后不含任何被 import 的
  运行时绑定)以及全部 `*.d.ts` 均不在闭包内,未 vendor;`import` 关系已逐文件核对,见下表):
  - `unbash/parser.js`(= 上游 `dist/parser.js`,导出 `parse`/`parseRegion`)
  - `unbash/lexer.js`、`unbash/arithmetic.js`、`unbash/parts.js`、`unbash/word.js`、
    `unbash/ansi-c.js`、`unbash/chars.js`(均为 `parser.js` 的直接或传递 `import`,零外部包依赖,
    只互相 `import`,已用 `require()` 从新 vendor 路径实测装载成功、`parse()` 正常返回)
- **上游正文 sha256**(每个 vendor 文件里前置注释之后的正文,逐字节对照 tarball 原文一致,已用
  `diff` 验证):
  - `parser.js`: `4dabfd2127300abe6374a319103b71f66b3b6ac1eaedd580e60ca2dac510c712`
  - `lexer.js`: `789f7747ba1c621ed017624299db23551bdb048910b20937cdc050819df84595`
  - `arithmetic.js`: `2a4fa2ad593f596916797fe78f1c2a6d69ba9cbb1f5f010bc6a74f19d0330997`
  - `parts.js`: `4e30935d01ffdb6f5594ddedac1aa5aff7507309a7e970fa65ceae71da261a01`
  - `word.js`: `d79f5fe484cd0d541f476767d31f9b128d506c903022836d10e4bf1ec0f902fa`
  - `ansi-c.js`: `c4b82824f54190ea75654a9e07c01e4baa875085811f39c19bdc77192e718d47`
  - `chars.js`: `a7d1f62c9a196ceb548a1b46cc192cdcd25196704cab0b239f2b74616b765d7b`
- **用途**:`guards/pmm-isolation-gate.cjs`(C05-BUILD-SPEC.md 补遗三 第27条「借用来源」段)的
  shell 命令解析层——一棵带源码位置的完整 AST(heredoc 正文/命令替换/进程替换/`source` 参数/
  包装命令透传参数都是可遍历的真实节点,不再是手写 `pmm-cmd-parse.cjs` 的启发式 token 流),
  DUT 命中判定、redirect 完整性判定、closed-set 豁免(`NON_EXEC_EXE`/`ALLOW_ANY`/`ALLOW_PROD`/
  git 专属规则)全部在闸的包装层实现,不改 vendor 文件本身。**本条记账写于 vendor 文件落地时
  (2026-09-24);闸本身改用此 AST 重写 judge() 的落地状态见 CHANGELOG 与本次收口报告** ——
  vendor 与判定重写是分两笔提交的(spec 收口纪律),此段先落这一笔的记账。
- **改动**:每个文件头加了 5-6 行前置注释(来源/版本/许可证/用途/逐字节承诺),正文未改一字节
  (已用 `diff`(去掉各自的固定行数头注释后)对照 tarball `dist/` 原文逐文件验证,7/7 全部一致)。
- **未 vendor 的同包文件**(供下一个触碰此目录的人核对,不算本条记账缺项):`dist/printer.js`、
  `dist/source-map.js`、`dist/types.js`、全部 `dist/*.d.ts`——均确认不在 `parse()` 的运行时
  `import` 闭包内(逐文件 `grep -n "^import"` 核对,记录在
  `guards/audits/BORROW-SURVEY-2026-09-24-c05.md` 之后的建造记录里)。如果未来的包装层需要
  `printer.js`(例如把 AST 转回文本做诊断输出),按同一流程补 vendor + 补记账,不要旁路直接
  `npm install`。

## 既有 vendor 文件(先于本文件存在,各自文件头已自带来源注释,此处仅索引)

- `acorn.js` —— acorn(MIT,见同目录 `acorn.LICENSE`)。文件头未带来源/版本/sha256 注释
  (先于本 VENDOR.md 存在);未在本批补全,留给下一个触碰该文件的建造者按同一格式补上,
  不在 F3(B7 排序器重建)写面内。
- `path-is-inside.cjs` —— `domenic/path-is-inside` v1.0.2(WTFPL/MIT 双许可,见同目录
  `path-is-inside.LICENSE`)。文件头已自带来源/版本/sha256 注释,见该文件开头几行。
