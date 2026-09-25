# AGENTS.md — 私局德州扑克

> 本文件是你的常驻上下文。**每次开始工作前完整读一遍。**
> 详细规格见 `SPEC.md`（架构/协议/动画/UI）、`RULES-SPEC.md`（规则引擎算法）、`TASKS.md`（工作队列）。

---

## 项目是什么

一个 **2-8 人在线德州扑克**，供朋友私局使用，同时作为开发者的求职作品集。

- 房主创建房间生成 **6 位配对码**，其他人用配对码入房
- **PC 浏览器 + 手机浏览器**双端，同一套 React 代码，不做原生 App
- 有**精细动画**：发牌、筹码下注/收池、翻牌、亮牌
- 纯虚拟筹码，**无任何充值/兑换/提现**

## 技术栈（已定，不要改）

| 层 | 选型 |
|---|---|
| 语言 | TypeScript（严格模式），前后端共享类型 |
| 包管理 | pnpm workspaces monorepo |
| 前端 | React 18 + Vite |
| 动画 | GSAP 3 |
| 图形 | **SVG + CSS，不用 Canvas/WebGL** |
| 联机 | **Colyseus 0.18**（房间、状态增量同步、断线重连） |
| 比牌 | pokersolver 2.1 |
| 测试 | vitest（规则引擎必须 100% 覆盖）+ @testing-library/react |
| 部署 | Docker，单台 VPS |

**不要引入其他运行时依赖，除非任务明确要求，并在 DECISIONS.md 记录理由。**

---

## 仓库结构

```
packages/
  shared/     纯规则逻辑，零 IO，零框架依赖。整个项目的命脉。
    src/engine/   deck.ts  betting.ts  evaluator.ts  sidepot.ts  table.ts
    src/types.ts
    src/protocol.ts
    test/
  server/     Colyseus 房间。只做"权威判定 + 同步"，不含游戏规则逻辑。
    src/rooms/PokerRoom.ts
    src/schema/
  web/        React。只做"渲染状态 + 播动画 + 收集操作"，不含游戏规则逻辑。
    src/lobby/  src/table/  src/anim/  src/assets/
```

**铁律：游戏规则（谁能行动、下注是否合法、边池怎么算、谁赢）只存在于 `shared/engine`。**
服务端调用它做权威判定；前端**永远不要**自己跑规则逻辑做决策，只做展示。

---

## 绝对禁止（违反即视为任务失败）

1. **禁止 mock / stub / 简化规则引擎的任何部分。**
   边池计算、all-in、下注轮结束判定、PREFLOP 大盲 option —— 这些必须真实实现并通过单测。
   不许写 `// TODO: handle side pots later`、不许写 `return [] // simplified`。

2. **禁止把玩家的底牌同步给其他客户端。**
   公共状态走 Colyseus schema；**底牌只走定向消息** `client.send('deal', ...)`。
   任何情况下 schema 里都不能出现其他玩家的 hole cards。

3. **禁止跳过测试或伪造测试输出。**
   完成规则相关任务时，必须实际运行 `pnpm --filter shared test` 并**把完整终端输出贴给用户**，输出里要能看到具体通过条数。

4. **禁止一次做多个任务。**
   一次只做一个 `TASKS.md` 里的任务，做完就停下等验收。

5. **禁止在 M1 完成前碰 M2/M3 的美术与动画。**

6. **禁止信任客户端。** 所有动作（下注额、是否轮到、是否已弃牌、筹码是否够）服务端必须重新校验。

7. **禁止新增充值/兑换/提现相关的任何代码、接口、字段。** 这是合规红线。

8. **禁止修改 `TASKS.md` 的任务顺序或验收标准**，除非用户明确要求。

---

## 每个任务的标准工作流

按顺序执行，不要跳步：

1. **读**——`TASKS.md` 里找到当前任务，读它的目标、涉及文件、验收标准。若涉及规则，读 `RULES-SPEC.md` 对应章节。
2. **确认**——用 2-4 句话向用户复述你要做什么。**不要问"我可以开始吗"，直接说要做什么然后开始。** 除非任务描述里有真正的歧义。
3. **写测试先行**（规则引擎类任务）——先写 vitest 用例，看它失败，再写实现。
4. **实现**——小步前进，每步都能编译。
5. **验证**——
   - 规则类：`pnpm --filter shared test`，贴完整输出
   - UI 类：`pnpm --filter web dev`，说明如何手动验证，**并同时检查横屏与竖屏**
   - 联机类：启动 server + web，说明用几个窗口如何验证
6. **全量回归**——`pnpm -r test && pnpm -r build`，确认没有弄坏已有功能
7. **更新账本**——在 `PROGRESS.md` 追加一条记录（任务号、做了什么、测试结果、遗留问题）
8. **有技术取舍时**——在 `DECISIONS.md` 记录（决定、备选方案、为什么）
9. **停下**——告诉用户任务完成，列出验收标准逐条自检结果，等待验收。**不要自动开始下一个任务。**

---

## Definition of Done（每个任务都要满足）

- [ ] `pnpm -r build` 通过，零 TypeScript 错误（`strict: true`，不许用 `any` 绕过，不许 `@ts-ignore`）
- [ ] `pnpm -r test` 全绿
- [ ] ESLint 零 error
- [ ] 该任务在 `TASKS.md` 里的验收标准**逐条**满足，并已向用户列出自检结果
- [ ] `PROGRESS.md` 已更新
- [ ] 没有留下 `TODO` / `FIXME` / 注释掉的死代码（有则必须登记到 `PROGRESS.md` 的「遗留问题」）
- [ ] 没有引入未在 `SPEC.md` 技术栈表中的依赖

---

## 遇到障碍时

**不要静默改变方案。** 按以下顺序处理：

1. 先自己排查：读报错、读 Colyseus / GSAP 官方文档、检查版本
2. 如果 20 分钟内没进展，**停下来告诉用户**：
   - 具体卡在哪（贴报错原文）
   - 你已经试过什么
   - 你建议的 2-3 个方案及各自代价
3. 若需要偏离 SPEC，先说明偏离点和原因，**等用户批准**，批准后写进 `DECISIONS.md`

**特别地**：Colyseus 的 schema 同步、GSAP 的 timeline 编排、边池算法这三处是最容易反复出错的地方。如果你在这三处卡住超过 20 分钟，直接停下来求助，不要硬试。

---

## 代码风格

- TypeScript `strict: true`，禁止 `any`（确需时用 `unknown` + 类型收窄）
- 优先纯函数与不可变数据；`shared/engine` 里**禁止**任何 IO、随机源注入以外的副作用
- 洗牌必须使用注入的随机源（便于测试复现），默认 `crypto.getRandomValues`
- 单个文件超过 ~300 行就考虑拆分
- 命名：领域词汇用德州扑克术语（`blinds`, `pot`, `sidePot`, `showdown`, `holeCards`, `communityCards`, `dealerButton`, `currentBet`, `committed`）
- 金额单位：**统一用整数「筹码」**，禁止浮点数（避免精度问题）
- 注释写「为什么」，不写「是什么」

---

## 沟通方式

- 用中文回复用户
- 简洁。不要复述用户已经知道的项目背景
- 不要在每次回复末尾总结你做了什么——用户会看 diff 和 PROGRESS.md
- 完成任务时，**逐条列出验收标准的自检结果**（✅/❌），这是用户验收的依据
- 有把握就说有把握，没把握就明说没把握。**不要为了让用户满意而声称测试通过或功能可用。**

---

## 版本信息（已实测，2026-09-25）

- Colyseus `0.18.8`（npm，活跃维护）
- GSAP `3.15.0`
- pokersolver `2.1.4`（2022 年后未更新，但牌型规则不变，可放心用）
- React 18 / Vite 5+ / vitest 2+

安装前用 `npm view <pkg> version` 复核，若与上述差异较大，先告知用户再决定。
