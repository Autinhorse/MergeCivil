# CLAUDE.md

合并文明（Merge Civ）原型，现在在做 v10 规则和数值平衡。

- **先读** `docs/handoff.md`：项目目标、代码结构、怎么跑、当前默认值、Rex 的偏好、已知问题。
- **数值记录** `docs/v10-balance-notes.md`：每项默认值是怎么测出来的。
- 数值只改 `src/v10/data.ts`；规则在 `src/v10/game.ts`；测试版界面在 `src/v10/ui.ts`。
- 改完以后：
  1. 跑 `npx tsc --noEmit -p .`；
  2. 跑 `NOINF=1 BOTS=expert N=8 TURNS=600 npx tsx scripts/sim10.ts` 做对比。
- 和 Rex 用中文交流，回复简短，先说结论，用表格对比数据。规则上的改动先问 Rex。
