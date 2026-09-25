# PROGRESS.md — 进度账本

> **AI 每完成一个任务必须在此追加一条记录。** 这是跨会话不丢进度的唯一保险。
> 最新的记录写在最上面（倒序）。
> 不要删除历史记录，只追加。

---

## 当前状态速览

| 项 | 值 |
|---|---|
| 当前里程碑 | M0 · 骨架 |
| 下一个任务 | `M0.3 · Colyseus 服务端骨架` |
| 已完成任务数 | 2 / 24 |
| 测试状态 | 全绿（63 passed / 3 包；shared 覆盖率 100/100/100/100） |
| 构建状态 | 全绿（`pnpm verify` 退出码 0） |
| 最后更新 | 2026-09-25 |

---

## 遗留问题（未修）

> 已知但没修的问题都记在这里。修复后移到下方「已解决」。
> 格式：`[严重程度 高/中/低] 问题描述 —— 发现于哪个任务 —— 是否阻塞下一里程碑`

- **[低] server 生产构建（`node dist/index.js`）当前不可用** —— M0.1 —— 不阻塞 M0-M3，**M4.3 必须解决**。
  原因见 `DECISIONS.md` D-006：shared 包用源码导出模式，dev 走 tsx 没问题，但 server 用 `tsc` 产出的 JS 会在运行时解析到 `.ts` 文件。M4.3 加 tsup 打包即可，不需要返工前面的代码。
- **[低] `uuid@8.3.2` 是 deprecated 的间接依赖** —— M0.1 —— 不阻塞。来自 Colyseus 依赖链，非本项目直接引入，无法自行升级。记录备查。
- **[低] npm 将 `eslint@9.39.5` 标记为 deprecated（10.11.0 可用）** —— M0.1 —— 不阻塞。
  暂未升 10：需先确认 `typescript-eslint@8.70.1` 是否声明支持 eslint 10 的 peer。留到 M4 打磨期统一处理依赖升级。

---

## 建议（AI 提出但超出当前范围的想法）

> AI 觉得有价值但不属于当前任务的想法记这里，用户在里程碑验收时决定是否采纳。
> **AI 不得自行实现这里的任何条目。**

_（暂无）_

---

## 任务记录

### 模板（复制这个格式追加）

```
### 【任务号 · 任务名】 — 完成日期 YYYY-MM-DD

**做了什么**
- 简明列出实际改动（文件级别），不要复述任务描述

**测试结果**
- 命令：`pnpm --filter shared test`
- 通过：X passed / Y total
- 覆盖率：statements XX%
- （UI 任务改为：手动验证步骤与结果）

**验收标准自检**
- ✅ / ❌ 逐条对应 TASKS.md 里该任务的验收标准

**遗留问题**
- （无 / 具体描述，并同步登记到上方「遗留问题」章节）

**给下一个任务的提示**
- （踩过的坑、需要注意的地方、和规格里写的不太一样的实际做法）
```

---

### M0.2 · 领域类型与洗牌 — 2026-09-25

**做了什么**
- `packages/shared/src/types.ts`：领域词汇表。`Suit`/`Rank`/`Card` + `SUITS`/`RANKS` 常量表；`cardId`/`parseCardId`（**查表实现，不是正则**，见下方提示）；`rankLabel`/`suitSymbol`/`suitIndex`；`Phase` + `PHASES` + `BETTING_PHASES` + `isBettingPhase`；`Action`（`raise` 用 `totalBet` 总额）；`PlayerHandState`（全部字段 `readonly`）；`Pot`；`TableConfig` + `DEFAULT_TABLE_CONFIG`（SB 10 / BB 20 / 2000 筹码 / 8 人 / 30s）+ `ACTION_WARNING_SEC`
- `packages/shared/src/engine/random.ts`：`RandomSource` 类型、`cryptoRandom()`（Web Crypto，走 `globalThis.crypto` 不 import `node:crypto`）、`mulberry32(seed)`、`randomInt(rand, max)`（对随机源做上下界校验并抛错，不 clamp）
- `packages/shared/src/engine/deck.ts`：`createDeck()`、`shuffle()`（Fisher-Yates，不修改入参）、`Deck` 类（`fresh` / `remaining` / `burned` 冻结快照 / `burn(n)` / `dealOne()` / `deal(n)` 原子性 / `reset()`）、`DeckExhaustedError`（带 `requested` 与 `remaining`）
- `packages/shared/src/engine/index.ts`：引擎出口（`export * from './deck' | './random'`），对应 package.json 的 `./engine` 子路径
- `packages/shared/src/index.ts`：追加 `export * from './types'`
- 新增 3 个测试文件：`test/types.test.ts`（15）、`test/random.test.ts`（12）、`test/deck.test.ts`（31）

**测试结果**
- 命令：`pnpm --filter @poker-room/shared test`
- 通过：**60 passed / 60 total**，4 个 test file 全绿（含 M0.1 的 smoke）
- 覆盖率（`pnpm test:cov`）：statements **100%** / branches **100%** / functions **100%** / lines **100%**
- 全仓 `pnpm verify` 退出码 **0**（eslint 零 error、守卫 5/5、typecheck 通过、3 包共 63 passed、web 构建 222.80 kB / gzip 69.61 kB）
- 全仓 `grep -rn "Math\.random"`：shared 源码与测试中**零处调用**，仅注释与守卫脚本自身提及

**验收标准自检**（对应 TASKS.md M0.2）
- ✅ `pnpm --filter shared test` 输出已贴出，全绿（60 passed）
- ✅ 新牌堆 52 张且不重复；4 花色 × 13 点数一个不缺
- ✅ 洗牌后仍是 52 张且不重复，**固定 seed（20260925）验证可复现**；不同 seed 结果不同
- ✅ 洗牌后顺序与原顺序不同，且 52 个位置中 >45 个发生位移（排除"只换了几张"的假洗牌）
- ✅ `burn()` 返回的牌不出现在后续 `deal()` 中；多次 burn 按序全部记录；`reset()` 清空烧牌记录
- ✅ `deal(n)` 数量正确、牌堆相应减少；`deal(0)` 不消耗；张数超出剩余时抛错且**不部分消耗**（原子性）
- ✅ `shuffle` 的随机源是注入参数（`rand: RandomSource = cryptoRandom`），测试中全程注入 `mulberry32(SEED)`，没有直接调 `Math.random`
- ✅ Fisher-Yates 实现正确 —— **不是靠读代码判断，是靠分布检验**：4 张牌洗 19200 次，断言 4! = 24 种排列全部出现且每种频率在期望值 ±20% 内。`sort(() => rand()-0.5)` 过不了这条
- ✅ 额外覆盖：8 人满桌完整发牌流程（1 烧 + 16 底牌 + 1 烧 3 翻 + 1 烧 1 转 + 1 烧 1 河 = 25 张，全场无重复，剩 27）

**遗留问题**
- 无新增。M0.1 登记的三项低优先级问题状态不变。

**给下一个任务的提示**
- **`pnpm test` 通过 ≠ 类型正确。vitest 只转译不做类型检查**，本任务就栽了一次：`buckets[randomInt(...)] += 1` 在 `noUncheckedIndexedAccess` 下是 error，vitest 全绿，`pnpm typecheck` 才报出来。**每个任务收尾必须跑 `pnpm verify`，不能只跑 `pnpm test`。**
- **100% 语句覆盖率门槛会反过来约束设计**，这是好事但要知道：任何"理论上走不到"的防御分支都会让 `pnpm test:cov` 变红。本任务因此做了两个具体选择——① `parseCardId` 用 `CARD_BY_ID` 查表而不是正则解析（表的键集合就是合法输入的完整定义，"非法输入"成为一条真实可达、被测试覆盖的分支）；② `cryptoRandom` 用 `DataView.getUint32(0)` 而不是 `Uint32Array[0]`（后者在 `noUncheckedIndexedAccess` 下类型是 `number | undefined`，会逼出一段永远走不到的判空）。**后续引擎代码照这个原则写：宁可换一种写法，也不要留死分支。**详见 `DECISIONS.md` D-008。
- `shuffle` 内部用了两处非空断言 `out[i]!` / `out[j]!`，前提是可证的（`i < length` 由循环条件保证、`j ∈ [0,i]` 由 `randomInt` 的校验保证），旁边有注释说明。我们的 ESLint 用的是 `recommendedTypeChecked`，`no-non-null-assertion` 属于 `strictTypeChecked` 所以没开——**但这不等于可以到处撒 `!`**。规则引擎里每出现一个 `!` 都要能当场说出它为什么安全，说不出来就换写法。
- `cryptoRandom` 缺 `globalThis.crypto` 的那条错误分支是可测的：vitest 的 node 环境里 `Reflect.deleteProperty(globalThis, 'crypto')` 有效，`finally` 里 `Reflect.set` 能恢复（已实测，见 `test/random.test.ts`）。
- `Deck.burned` 每次访问都返回一个新的冻结副本，外部改不动内部记录；服务端要长期留存烧牌记录时，直接在自己的状态里存数组，别指望持有这个 getter 的返回值。
- `Card` / `PlayerHandState` / `Pot` / `Action` 的字段全是 `readonly`。M1.3 的下注引擎和 M1.4 的状态机要按"不可变状态 + 返回新对象"来写，别就地改字段——`applyAction(state, seat, action) → { newState, events }` 这个签名已经假定它是纯的。
- 牌的全局唯一编号约定为 `rank * 4 + suitIndex`（`suitIndex` 已导出）。M1.1 接 pokersolver 时如果需要字符串牌面，直接用 `cardId()`，格式是 `"As"` / `"10d"` / `"2c"`，pokersolver 吃的就是这个格式。

---

### M0.1 · Monorepo 初始化 — 2026-09-25

**做了什么**
- 根配置：`package.json`（scripts: dev/build/test/test:cov/lint/lint:arch/verify/typecheck）、`pnpm-workspace.yaml`、`tsconfig.base.json`（strict + noUncheckedIndexedAccess + experimentalDecorators + verbatimModuleSyntax）、`vitest.workspace.ts`、`eslint.config.js`（flat config + 类型感知规则 + 分层限制）、`.prettierrc.json`、`.npmrc`、`.gitignore`、`README.md`（含合规声明）
- `packages/shared`：包骨架 + `src/index.ts` 占位 + `vitest.config.ts`（**覆盖率门槛已设死：statements/functions/lines 100%、branches 95%**）+ 冒烟测试
- `packages/server`：包骨架 + `src/index.ts` 占位 + vitest 配置（集成测试超时放宽到 30s）+ 冒烟测试
- `packages/web`：Vite + React 19 + `index.html`（含 viewport-fit=cover 与合规 meta）+ `App.tsx` 占位 + vite proxy `/ws` → `localhost:2567` + `server.host: true`（手机同局域网可访问）+ jsdom 测试环境 + 冒烟测试
- `scripts/check-arch.mjs`：新增架构守卫，6 项检查，作为 `pnpm lint` 第二步

**测试结果**
- 命令：`pnpm verify`（= lint + typecheck + test + build），**退出码 0**
- ESLint：零 error 零 warning
- 架构守卫：5 项全通过（deps / purity / types / placeholder / selftest）
- vitest：`shared 2 passed` + `server 2 passed` + `web 1 passed` = **5 passed / 5 total**，3 个 test file 全绿
- build：shared tsc ✅、server tsc ✅、web `tsc --noEmit && vite build` ✅（产物 222.80 kB / gzip 69.61 kB）
- 依赖安装：438 包，pnpm 9.15，耗时 2m58s

**验收标准自检**（对应 TASKS.md M0.1）
- ✅ `pnpm install` 成功，lockfile 已生成
- ✅ `pnpm -r build` 通过（三个包都能编译）
- ✅ `pnpm -r test` 通过（vitest 能跑起来，5 个测试全绿）
- ✅ `pnpm lint` 零 error
- ✅ `tsconfig` 确认 `strict: true`；shared 包 `dependencies` 为**空**，无 react/colyseus —— 且这一点现在由 `check-arch.mjs` 自动守卫，不靠人工检查
- ✅ `.gitignore` 覆盖 node_modules / dist / coverage / .env

**遗留问题**
- 三项低优先级，已登记到上方「遗留问题」章节（server 生产构建、uuid 间接依赖 deprecated、eslint 9 被标 deprecated）

**给下一个任务的提示**
- **版本已按实测生态修正，不要照抄 SPEC 初稿**：TS 5.9.3（不是 7.0.2）、Vite 7.3.6（不是 8）、React 19.3.0（不是 18）、客户端包名是 `@colyseus/sdk`（不是 `colyseus.js`，后者停在 0.16）。详见 `DECISIONS.md` D-005。
- **shared 包新增依赖前先看 `check-arch.mjs` 的 `ALLOWED_RUNTIME_DEPS` 白名单**。M1.1 要加 `pokersolver`，加完守卫会自动放行（已在白名单里）。
- **`Math.random()` 在 shared 包里被 ESLint 和守卫双重禁止**，M0.2 的随机源必须走注入。守卫还禁止 `window`/`document`/`process` 和 `node:*` 导入。
- shared 的 `tsconfig.json` 设了 `"types": []`，意味着**不能依赖任何 @types 全局**。写测试时用 `import { describe, expect, it } from 'vitest'` 显式导入，不要用 globals。
- `verbatimModuleSyntax: true` 已开启，类型导入必须写 `import type { X }`，否则编译报错。
- 守卫脚本区分「剥离注释后的源码」（查代码构造）和「原始源码」（查 `@ts-ignore`/`TODO`）。**改这个脚本前先读它的头部注释**，那里记了第一版误报的坑。
