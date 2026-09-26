# RULES-SPEC.md — 德州扑克规则引擎精确规格

> **这是整个项目最重要的一份文档。** 规则引擎写错，后面所有的动画和美术都是废品。
> 实现 `packages/shared/src/engine/` 时，必须逐条对照本文档。
> 本文档的所有算法都是**权威定义**，不要"优化"或"简化"它们。

约定：
- 所有金额单位为**整数筹码**，禁止浮点
- 座位号 `seatIndex` 为 0..7，顺时针递增
- 玩家 `id` 为字符串（Colyseus sessionId）
- 本文件中「未弃牌」= `folded === false`；「在手」= 未弃牌且未离桌

---

## 1. 牌与牌堆

### 1.1 数据结构

```ts
type Suit = 's' | 'h' | 'd' | 'c'   // 黑桃 红心 方块 梅花
type Rank = 2|3|4|5|6|7|8|9|10|11|12|13|14   // 11=J 12=Q 13=K 14=A
interface Card { rank: Rank; suit: Suit }
```

牌的唯一标识：`rank * 4 + suitIndex`，或直接字符串 `"As"` `"Kh"` `"10d"` `"2c"`。

### 1.2 洗牌

**必须使用 Fisher-Yates 洗牌**，且随机源可注入：

```ts
function shuffle(deck: Card[], rand: () => number = cryptoRandom): Card[]
```

- 每手牌开始时用一副**全新的 52 张牌**重新洗牌，不沿用上一手的牌序
- 默认随机源用 `crypto.getRandomValues`，测试时注入伪随机（如 mulberry32）以便复现

### 1.3 发牌顺序

```
每手开始：
  burn 1 张（弃掉，不公开）
  发底牌：从 dealerButton 的下一位（SB 位）开始，顺时针每人 1 张，共发 2 轮 → 每人 2 张
  （注意：是"每人一张轮两次"，不是"每人连发两张"）
FLOP：burn 1 张，发 3 张公共牌
TURN：burn 1 张，发 1 张
RIVER：burn 1 张，发 1 张
```

烧掉的牌必须记录（用于复盘），但**绝不下发给客户端**。

---

## 2. 手牌评估

用 `pokersolver` 库，不要自己实现比牌算法。

### 2.1 接口封装

```ts
// packages/shared/src/engine/evaluator.ts
interface HandResult {
  rank: number        // 1-9，见下表，越大越好
  name: string        // 中文名，用于 UI 显示
  nameEn: string      // 英文名
  score: number       // 可直接比较的整数分值，越大越好
  bestFive: Card[]    // 组成最佳牌型的 5 张牌，用于 UI 高亮
  kickers: Rank[]     // 踢脚牌，降序
}
function evaluate7(cards: Card[]): HandResult   // 从 7 张中选最佳 5 张
function compare(a: HandResult, b: HandResult): -1 | 0 | 1
```

### 2.2 牌型等级（rank）

| rank | 英文 | 中文 |
|---|---|---|
| 9 | Straight Flush | 同花顺 |
| 8 | Four of a Kind | 四条 |
| 7 | Full House | 葫芦 |
| 6 | Flush | 同花 |
| 5 | Straight | 顺子 |
| 4 | Three of a Kind | 三条 |
| 3 | Two Pair | 两对 |
| 2 | One Pair | 一对 |
| 1 | High Card | 高牌 |

**A-2-3-4-5 是合法顺子**（轮子/wheel），此时 A 当作 1，为最小顺子。
**10-J-Q-K-A 是最大顺子。**
**不允许环绕顺子**：Q-K-A-2-3 **不是**顺子。
**同花顺中 A-2-3-4-5 为最小同花顺**（steel wheel）。

### 2.3 score 计算（供平局比较）

```
score = rank * 15^5 + k1 * 15^4 + k2 * 15^3 + k3 * 15^2 + k4 * 15 + k5
```
其中 k1..k5 是决定牌型的 5 个关键点数，按重要性降序。用 15 进制是因为 rank 最大 14。
`score` 相等等价于完全平局（chop）。

### 2.4 必测用例（≥40 条，全部写进单测）

至少覆盖：
- 9 种牌型各至少 1 例，且验证 `bestFive` 正确
- 轮子顺 A-2-3-4-5 vs 2-3-4-5-6 → 后者胜
- 最大顺子 10-J-Q-K-A vs 9-10-J-Q-K → 前者胜
- Q-K-A-2-3 混合花色 → 判为高牌 A，**不是顺子**
- 同花 A-K-9-5-2 vs 同花 A-K-9-5-3 → 后者胜
- 四条 KKKK + A vs 四条 KKKK + 2 → 前者胜
- 葫芦 AAA22 vs AAA33 → 后者胜；AAA22 vs KKKAA → 前者胜
- 两对 AA22K vs AA22Q → 前者胜（第五张踢脚）
- 两对 AA22 vs AA33 → 后者胜
- 一对 AAKQ9 vs AAKQ8 → 前者胜
- 完全平分：双方都用公共牌组成同花顺 → `compare` 返回 0
- 从 7 张里正确挑出最佳 5 张：手上 2 张与公共 5 张的组合优先于纯公共牌
- 公共牌本身是 4 条时，双方各自的第 5 张踢脚决定胜负
- 花色**不影响**大小（黑桃不比红桃大）

---

## 3. 下注轮引擎（`betting.ts`）

### 3.1 玩家在手牌中的可变状态

```ts
interface PlayerHandState {
  seatIndex: number
  chips: number            // 桌上剩余筹码（≥0）
  holeCards: Card[]        // 2 张，仅服务端持有
  folded: boolean
  allIn: boolean
  committedThisStreet: number   // 本下注轮已投入
  committedTotal: number        // 本手累计投入（跨轮，用于算边池）
  hasActed: boolean             // 本下注轮是否已行动过
  sittingOut: boolean           // 离座/托管中
}
```

### 3.2 动作

```ts
type Action =
  | { type: 'fold' }
  | { type: 'check' }                                  // 仅当 toCall === 0
  | { type: 'call' }                                   // 投入 min(toCall, chips)；chips 不足则自动 all-in
  | { type: 'raise', totalBet: number }                // totalBet = 本轮下注目标总额（不是增量）
  | { type: 'allIn' }
```

**用 `totalBet`（总额）而非 `amount`（增量）**，这能消除 80% 的下注逻辑歧义。

### 3.3 每个动作的合法性校验（服务端必须逐条检查）

设 `currentBet` = 本轮当前最高 `committedThisStreet`，`toCall = currentBet - player.committedThisStreet`。

| 动作 | 合法条件 |
|---|---|
| `fold` | 轮到该玩家 且 未弃牌。（`toCall === 0` 时也允许 fold，不报错） |
| `check` | 轮到该玩家 且 未弃牌 且 `toCall === 0` |
| `call` | 轮到该玩家 且 未弃牌 且 `toCall > 0` |
| `raise(totalBet)` | 轮到该玩家 且 未弃牌 且 `totalBet > currentBet` 且 `totalBet - player.committedThisStreet <= player.chips` 且满足最小加注规则（见 3.4） |
| `allIn` | 轮到该玩家 且 未弃牌 且 `player.chips > 0` |

**已 all-in 的玩家不能行动**，跳过。

### 3.4 最小加注规则（no-limit hold'em 标准）

- 维护 `lastRaiseSize` = 上一次「加注增量」，初始为 `bigBlind`
- 一次合法加注必须使 `currentBet` 至少增加 `lastRaiseSize`
- 即：`totalBet >= currentBet + lastRaiseSize`
- **例外：all-in 短注（short all-in）**
  - 若玩家 all-in 后的 `totalBet > currentBet` 但 `< currentBet + lastRaiseSize`，**允许**（因为筹码不够）
  - 但这种 short all-in **不重置** `lastRaiseSize`
  - 且**不重新开启**已行动玩家的加注权（他们只能 call 或 fold，不能再 raise）
  - 若 short all-in 的 `totalBet >= currentBet + lastRaiseSize`（不太可能，但边界要处理），则视为完整加注，重置 `lastRaiseSize = totalBet - currentBet`，并重新开启行动权

### 3.5 all-in 语义

玩家 `call` 或 `raise` 时若 `chips` 不足，**自动转为 all-in**，不报错。投入 = 全部剩余筹码。
all-in 后 `chips = 0`，`allIn = true`，本手后续所有下注轮自动跳过该玩家。

### 3.6 下注轮结束条件（按顺序判断，任一满足即结束）

```
1. 未弃牌玩家数 === 1        → 本手立即结束，进入结算，不亮牌
2. 所有未弃牌玩家都 allIn，或除一人外都 allIn 且该人已匹配 currentBet
                            → 下注轮结束，且标记 runOutBoard = true
                              （后续公共牌一次性发完，不再需要行动）
3. 所有未弃牌且未 allIn 的玩家满足：
     committedThisStreet === currentBet  AND  hasActed === true
                            → 下注轮正常结束
```

**PREFLOP 大盲 option（极易漏，必须实现并测试）**
- PREFLOP 时，若其他所有玩家都只是 call 到 bigBlind（没有 raise），大盲玩家的 `committedThisStreet === currentBet` 成立，但他**必须仍有一次行动机会**（可以 check 或 raise）
- 实现方式：进入 PREFLOP 时把大盲的 `hasActed` 设为 `false`，即使他已投入 bigBlind
- 其他阶段不存在这个问题
- **边界（M1 审查问过，判定为按结束条件 2 走）**：option 的前提是"加注了也有人能跟"。
  如果其余还在手里的玩家**全部已全下**（例如小盲弃牌、后位不足额全下），大盲虽然 `hasActed === false`，
  结束条件 2 仍然先生效 —— 直接 `runOutBoard`，不再问他一次。此时他多出来的投入按 §4.2
  "未跟到的钱先退回原主"处理。把 option 理解成"大盲永远最后一次行动"会让他对着空气下注。
  回归锁定：`packages/shared/test/betting-round.test.ts`「小盲弃牌 + 后位不足额全下时…」
  与 `betting-status.test.ts` 结束条件真值表 `[allIn=true, committed=20/30, hasActed=false] → runout`。

**行动顺序推进**
- 从 `firstToAct` 开始，顺时针找下一个「未弃牌 且 未 allIn 且 未 sittingOut」的玩家
- 每次行动后把该玩家 `hasActed = true`，然后推进
- 若绕一圈回到起点且所有人都满足结束条件 3 → 结束

**第一个行动者**
- PREFLOP：大盲的下一位（UTG）
- FLOP / TURN / RIVER：庄家按钮的下一位（第一个仍在手的玩家）；若该玩家已 all-in，继续顺时针找

### 3.7 超时托管

- 每个玩家行动限时 **30 秒**（可配置）
- 超时后服务端自动执行：`toCall === 0` → `check`；`toCall > 0` → `fold`
- 剩余 10 秒时向该客户端发 `timeoutWarning`
- 连续超时 2 次的玩家标记 `sittingOut`，下一手不發牌（可选，v1 可先只自动托管不标记）

---

## 4. 边池计算（`sidepot.ts`）— **最容易写错的部分**

### 4.1 权威算法

> **本算法已于 2026-09-25 用 Node 实跑验证**：跑通下方 §4.3 中用例 1/2/3/4/5/6/14 共 7 个 `calculatePots` 场景，全部通过「池总额 === 玩家投入总额」守恒断言，且期望值与本文档标注一致。**请照此实现，不要"优化"或改写。**
> 验证过程也暴露了文档初版的两处错误并已修正：用例 6 的边池是 100（不是 50）；用例 9 属于 `awardPots` 而非 `calculatePots`。**如果你实跑发现别的用例期望值对不上，先怀疑文档、再怀疑实现，并把结论告诉用户。**

输入：所有参与本手的玩家（**包含已弃牌的**）的 `committedTotal` 与 `folded`。

```ts
interface Pot {
  amount: number        // 该池筹码总额
  eligible: number[]    // 有资格赢取该池的 seatIndex 列表（未弃牌 且 投入达到该层）
}

function calculatePots(players: PlayerHandState[]): Pot[] {
  // 1. 收集所有不同的投入额作为分层点
  const levels = [...new Set(players.map(p => p.committedTotal))].sort((a, b) => a - b);

  const pots: Pot[] = [];
  let prev = 0;

  for (const L of levels) {
    if (L <= prev) continue;

    // 2. 本层金额 = 每个玩家在本层区间内的贡献之和
    //    用 min/max 夹逼，自动正确处理筹码不足者和已弃牌者
    let amount = 0;
    for (const p of players) {
      amount += Math.min(p.committedTotal, L) - Math.min(p.committedTotal, prev);
    }

    // 3. 有资格者 = 未弃牌 且 投入达到本层上限
    const eligible = players
      .filter(p => !p.folded && p.committedTotal >= L)
      .map(p => p.seatIndex);

    if (amount > 0 && eligible.length > 0) {
      pots.push({ amount, eligible });
    } else if (amount > 0) {
      // 所有人都在本层之前弃牌 → 这笔钱归入上一个池（或最后一个有资格者的池）
      if (pots.length > 0) pots[pots.length - 1].amount += amount;
      else pots.push({ amount, eligible: [] });   // 理论不可达，防御性处理
    }

    prev = L;
  }

  // 4. 合并 eligible 集合完全相同的相邻池（纯为 UI 显示简洁，不影响正确性）
  return mergeAdjacentEqualEligible(pots);
}
```

### 4.2 结算

> **前置规则：未跟到的钱先退回原主，再分池。** 任何一笔投入，只要**没有任何仍在手的玩家跟得到**（即超出"仍在手玩家的最大 `committedTotal`"），就不属于底池：它在这一手结束时退回原主。
> 典型场景：SB 投 10，BB 只有 3 筹码不足额全下，其余两人各跟 3，SB 随后弃牌 —— 池是 `3×4 = 12`，SB 只输被跟到的 3，多出来的 7 退回 SB。
> **与 §7「弃牌玩家的超额投入正确进入只含剩余玩家的边池」不冲突**：那条说的是"超出某个 all-in 玩家、但被另一个仍在手的玩家跟到了"的钱（例如 A 全下 50，B 投 100 后弃牌，C 跟到 100 —— B 多出的 50 有 C 跟得到，归 C）。判断标准始终是**有没有仍在手的人跟得到**，不是"是否弃牌"。
> 仍在手玩家的未跟到部分由 §4.1 的分层自动处理（那一层的 eligible 只有他自己）；**弃牌玩家**的部分必须在进池**之前**夹住，否则 §4.1 的"本层无合格赢家 → 并入上一池"防御分支会把它送给摊牌赢家。

```
对每个 pot（顺序无关）：
  在 pot.eligible 中找出 HandResult.score 最高的玩家（可能多个）
  平分：base = Math.floor(pot.amount / winners.length)
        remainder = pot.amount % winners.length
  每个赢家先拿 base
  remainder 的分配：**从庄家按钮的下一位开始顺时针**，
    依次给每个赢家 +1，直到 remainder 分完
    （这是业界标准的"odd chip"规则）
```

### 4.3 必测用例（≥15 条，全部写进单测）

必须逐条覆盖，一条都不能少。标注「已实跑验证」的用例，其**期望值是 2026-09-25 用 §4.1 算法实跑得出的**，请以此为准，不要凭直觉改写期望值。

1. **两人，无 all-in**：A 投 100，B 投 100 → 单池 200，eligible `[A,B]`　*（已实跑验证）*
2. **两人，一方 all-in 且更少**：A 有 50 全下，B 投 100 → 主池 100 `[A,B]`，边池 50 `[B]`　*（已实跑验证）*
3. **三人，一人 all-in 最少**：A 全下 50，B 投 100，C 投 100 → 主池 150 `[A,B,C]`，边池 100 `[B,C]`　*（已实跑验证）*
4. **三人，两级 all-in**：A 全下 30，B 全下 80，C 投 200
   → 池1 `90 [A,B,C]`；池2 `100 [B,C]`（=(80−30)×2）；池3 `120 [C]`（=(200−80)×1）。总额 310 = 30+80+200　*（已实跑验证）*
5. **弃牌者的钱留在池里**：A 投 100 后弃牌，B、C 各投 100
   → 单池 300，eligible 只有 `[B,C]`（A 的 100 进了池但他没资格）　*（已实跑验证）*
6. **弃牌发生在 all-in 之后**：A 全下 50，B 投 100 后弃牌，C 投 100
   → 主池 `150 [A,C]`（A 50 + B 50 + C 50）；边池 `100 [C]`（B 多投的 50 + C 多投的 50，因 B 已弃牌故仅 C 有资格）。总额 250　*（已实跑验证 —— 注意边池是 100 不是 50，这里很容易算错）*
7. **A 全下最少且赢得主池**：接用例 3 的场景，若 A 的牌最大 → A 只拿主池 150，边池 100 由 B/C 中较大者拿走
8. **平局分池（两人）**：单池 201，两名赢家牌型完全相同 → 101 / 100，多出的 1 给「按钮后顺时针第一位」赢家
9. **平局分池 odd chip（三人）**：直接构造 `Pot { amount: 100, eligible: [A,B,C] }` 且三人 `score` 相同 → 派彩 34 / 33 / 33，多出的 1 给按钮后顺时针第一位。
   **注意：这是 `awardPots()` 的用例，不是 `calculatePots()` 的用例。** 不要试图用不等额投入去凑出 100 的单池——那样会产生多个池，测不到 odd chip 逻辑
10. **多人多级 all-in 且中间有人弃牌**：综合场景（建议 5 人：两人 all-in 不同额、一人中途弃牌、两人跟到底），验证总额守恒且每个池的 eligible 正确
11. **筹码守恒断言**：所有 `pot.amount` 之和 === 所有玩家 `committedTotal` 之和（**上面每条 calculatePots 用例都必须加这个断言**）
12. **所有人 all-in 且金额相同**：单池，全员 eligible，`runOutBoard === true`
13. **只有一人未弃牌**：不进入边池计算，直接拿走全部投入（验证结算路径正确）
14. **盲注造成的不等额**：SB 投 50 后弃牌，BB 投 100，另一玩家 call 100
    → 合并为单池 250，eligible `[BB, 另一人]`（两层 eligible 集合相同，被 `mergeAdjacentEqualEligible` 合并）　*（已实跑验证 —— 记得测合并逻辑确实生效，UI 上不应显示两个池）*
15. **一手打完后的筹码总量守恒**：开局所有玩家筹码总和 === 结算后总和（**这是最重要的回归断言，每个涉及结算的用例都要加**）

---

## 5. 牌桌状态机（`table.ts`）

### 5.1 阶段

```
IDLE          人数 < 2，等待
DEALING       洗牌 + 发底牌（服务端瞬时完成，前端播动画）
PREFLOP       下注轮 1
FLOP          发 3 张 + 下注轮 2
TURN          发 1 张 + 下注轮 3
RIVER         发 1 张 + 下注轮 4
SHOWDOWN      算池 + 比牌 + 派彩
HAND_END      展示结果，等待下一手
```

### 5.2 推进规则

```
IDLE → DEALING:
  至少 2 名有筹码的活跃玩家；只能由房主点击开始
  （本条原文曾写"或人满自动开始"。M1 审查确认从未实现，且与 D-018 的房主控制相冲突：
   人满即开局会让最后入座的玩家没有"先看看桌子"的机会。若之后要支持无人值守开局，
   那是一个需要单独决策的功能，不是这条规则的遗漏实现。）
  注意区分：一旦开过一局，HAND_END → DEALING 的自动轮转确实存在（见 5.3 与 D-012），
  那是"下一手"的自动开始，不是"人满自动开局"。
DEALING → PREFLOP:
  盲注已扣（见 5.3），底牌已发
PREFLOP/FLOP/TURN → 下一阶段:
  下注轮结束（见 3.6）
  若 runOutBoard === true，则跳过中间下注轮，直接一次性发完剩余公共牌到 RIVER
RIVER → SHOWDOWN:
  下注轮结束
SHOWDOWN → HAND_END:
  池已结算，赢家已派彩
HAND_END → DEALING 或 IDLE:
  庄家按钮顺时针移到下一个有筹码的活跃玩家
  若只剩 1 名有筹码的玩家 → 本桌结束（v1：提示并重置筹码）
  若有玩家筹码为 0 → v1 提供「重买（rebuy）」按钮，重置为初始筹码
```

### 5.3 盲注与庄家按钮

- `dealerButton`（按钮/D）、`smallBlind`、`bigBlind` 三个位置
- **2 人（heads-up）特殊规则**：庄家按钮**就是**小盲，且 PREFLOP 由庄家先行动；FLOP 及之后由非庄家先行动。**这条极易写错，必须单独测试。**
- 3 人以上：按钮 → 小盲 → 大盲，PREFLOP 由大盲下一位（UTG）先行动
- 每手结束按钮顺时针移一位（跳过空座和筹码为 0 的座位）
- 玩家中途加入：下一手开始时入座，**不发牌**（等到再下一手），避免盲注错位

### 5.4 盲注扣除

```
SB = min(smallBlindAmount, player.chips)
BB = min(bigBlindAmount, player.chips)
```
不足则自动 all-in。扣除后立即计入 `committedThisStreet` 和 `committedTotal`，`currentBet = BB 实际投入额`。

- **`currentBet` 取的是"实际投入额"而不是 `config.bigBlind`**（M1 审查问过，已核对为按规格实现）：
  BB 只有 3 筹码时 `currentBet === 3`，其他人跟 3 就算跟平，不必凑到 20。
  但 `lastRaiseSize` 仍取 `config.bigBlind`（标准规则：最小加注增量以完整大盲为锚，
  短注大盲不缩小最小加注）。两条分别锁在
  `packages/shared/test/table-flow.test.ts`「未跟到的部分退回原主…」与
  `table-dealing.test.ts`「heads-up 大盲不足额全下时立即关门跑完，未跟到的部分回到小盲」
  （后者同时断言 `currentBet: 3` 与 `lastRaiseSize: 20`）。

### 5.5 配置项（房间创建时由房主设定）

```ts
interface TableConfig {
  smallBlind: number      // 默认 10
  bigBlind: number        // 默认 20；**引擎强制 bigBlind === 2 × smallBlind**
                          //（不是"默认如此"，`validateConfig` 会拒掉别的比例。
                          //  理由见 table-state.ts 的标注：最小加注以 BB 为锚，非 2 倍盲注
                          //  会改变翻牌前加注语义，属于另一次决策。）
  startingChips: number   // 默认 2000（= 100 BB）
  maxPlayers: 2|3|4|5|6|7|8   // 默认 8
  actionTimeoutSec: number    // 默认 30
  minPlayersToStart: 2
}
```

### 5.6 摊牌亮牌语义（M1 判定，别让后续审查再问一遍）

真牌桌的摊牌有两条礼仪规则：**亮牌顺序**（最后下注/加注者先亮，其余人按顺时针跟上）和
**盖牌 mucking**（已经确定输的人可以直接把牌推进去，不公开）。本项目 **M1 明确都不做**：
进摊牌时把**所有未弃牌玩家**的底牌一次性定向发给这一手的每位参与者（`table-settlement.ts` 的
`reveals()`），前端同时展示牌型。

理由，按重要性排：
1. **结算本来就需要所有人牌型**。多池分配要对每个池比出赢家，引擎在任何 UI 语义之下都已经评估了
   全部未弃牌手牌；"盖牌不亮"只是不展示，省下不了任何计算，也就省不下任何出错面。
2. **亮牌顺序不影响任何判定**。它只决定真人牌桌上"谁能看着谁的牌决定要不要盖"，是信息博弈的礼仪，
   而本项目的决策（第 1 条）已经取消了盖牌，顺序因此失去全部作用。
3. 定位是**朋友私局 + 作品集**，不是竞技场。复盘时"这手大家都亮了"比"他盖牌了我不知道他拿什么输的"
   更有价值。

代价与边界（诚实记录）：这比标准规则**多**公开了信息。若将来要做真牌桌观感，改动是纯增量的：
`reveals()` 按「最后完整加注者 → 顺时针」排序、逐条推送并带上 `showdown:order`，
输家那条换成 `showdown:muck`（只发座位不发牌），前端做盖牌动画。**不要**在 M1 阶段为它预留字段。

回归锁定：`packages/shared/test/table-flow.test.ts`（每位参与者都收到"全部未弃牌者"的亮牌，
2 人桌即 2×2=4 条）、`table-lifecycle.test.ts`（没参加这一手的人收不到任何亮牌）、
网络场景 4（`packages/server/test/poker-network.test.ts`：亮牌座位集合 === 未弃牌集合）。

---

## 6. 必测的集成场景（服务端集成测试）

用模拟客户端（不开浏览器，直接连 Colyseus）跑完整流程：

1. **2 人完整一手**：盲注 → PREFLOP call → FLOP check-check → TURN bet-call → RIVER check-check → SHOWDOWN。验证赢家筹码、按钮轮转。
2. **heads-up 按钮规则**：验证 2 人时庄家即小盲，且 PREFLOP 庄家先行动。
3. **6 人，中途有人 all-in，产生边池**：验证结算金额。
4. **8 人满桌，3 人弃牌，其余 call 到 RIVER**：验证行动顺序跳过弃牌者。
5. **所有人 all-in 在 PREFLOP**：验证 `runOutBoard`，一次性发完 5 张公共牌，无人需要行动。
6. **大盲 option**：PREFLOP 全员只 call 到大盲，验证大盲仍获得行动机会并能 raise。
7. **非法动作被拒**：非当前行动者发 `raise` → 服务端拒绝并返回错误码，状态不变。
8. **下注额越界**：`raise` 超过自己筹码 → 自动转 all-in（不报错）。
9. **最小加注违规**：`raise` 增量小于 `lastRaiseSize` 且非 all-in → 拒绝。
10. **超时托管**：不发任何动作，等 30 秒，验证自动 check/fold。
11. **断线重连**：客户端断开再重连，验证座位保留、底牌重新收到、当前状态正确。
12. **筹码守恒**：以上每个场景结束时断言「所有玩家筹码之和 === 开局之和」。

---

## 7. 常见错误清单（AI 实现时最容易踩的坑）

实现完成后，**逐条自检**：

> 2026-09-26 全部自检完毕。**十四条现已全部拿到「改坏它 → 测试变红」的变异探针实跑记录**（第 2/3/4/7/9 条见【RULES-SPEC §7 十四条自检 · 变异探针审计】，第 12/13 条见【第四轮】，第 1/5/6/8/10/11/14 条见【第五轮】；第 13 条那轮还顺带审出并修掉了一个只在终态查隐私的时间性漏洞）。每条的失败数、生产代码行号、用例名都在 `PROGRESS.md` 对应记录里。判据文字未改动，仅把 `[ ]` 改成 `[x]`。
>
> 2026-09-26【第六轮续】补入第十五条（未跟到的钱退回原主）：它不在原来那十四条里，因为**规格本身漏写了这条真规则**；同轮带变异探针，见上一条的行内标注。

- [x] 用了 `totalBet`（总额）而不是增量，没有搞混
- [x] PREFLOP 大盲 option 实现了
- [x] heads-up 时庄家=小盲，且行动顺序正确
- [x] short all-in 不重置 `lastRaiseSize`，不重开行动权
- [x] 边池计算包含了**已弃牌玩家**的贡献
- [x] 弃牌玩家的超额投入正确进入了只含剩余玩家的边池
- [x] **没人跟得到的未跟到部分退回原主**（见 §4.2 前置规则；夹在进池之前，不是分完池再补）　*（2026-09-26 补：这条原本在规格里完全没写，实现因此漏了；变异探针两轮 —— 去掉夹算 →「未跟到的部分退回原主」红在池 19≠12，去掉退款 → 红在`牌桌筹码不守恒`。见【第六轮续】）*
- [x] odd chip 按「按钮后顺时针」分配
- [x] A-2-3-4-5 判为顺子且为最小；Q-K-A-2-3 判为高牌
- [x] `runOutBoard` 时跳过后续下注轮，直接发完公共牌
- [x] 只剩一人未弃牌时**不亮牌**直接派彩
- [x] 所有金额是整数，无浮点
- [x] 服务端校验了每一个动作的合法性，不信任客户端
- [x] 底牌从未出现在同步 schema 中
- [x] 洗牌用了新牌堆 + 可注入随机源
