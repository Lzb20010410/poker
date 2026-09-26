/**
 * 回放器的三个预置场景（M3.2）。
 *
 * ## 它们是「服务端会说过的话」的誊写，不是规则
 *
 * 每一帧的 `ops` 都对着真实服务端的一次 patch 写：谁先行动、跟注要补多少、街怎么推进、
 * 池怎么分层、谁赢哪一份——全部是**手填的结论**，本文件一个字都不判定。
 * 真要改规则，改的是 `shared/engine`，不是这里。
 *
 * 手填就一定会填错，所以 `test/devReplay.test.ts` 拿几条**记账恒等式**兜住：
 * 每一帧 `retainedChips + potTotal` 必须等于买入总额、公共牌张数必须落在合法的一街、
 * 派彩不许超过池、`legal` 里的 `maxRaiseTotal` 不许小于 `callAmount`。这些不是规则，是算术。
 * 编译层还会在「口袋里掏不出这么多」时直接抛错，所以错不到画面上。
 *
 * ## 三个场景各自在验什么（对着 TASKS.md M3.2 / M3.4 / M3.5 的验收条目）
 *
 * - `eight-max-chop`：满桌一手牌走完四条街，收尾两人**平分**同一个池 → 验多个赢家同时高亮、
 *   `bestFive` 全是公共牌。
 * - `side-pots`：四人三种筹码深度，池按深度切成 400 / 600 / 400 三段，由三个不同的人收
 *   → 验「多个池依次派彩不混乱」。
 * - `heads-up-walk`：单挑，最后一手对面弃牌 → 验未被跟注的下注退回、只剩一人时**不翻别人的牌**。
 *
 * ## 为什么 B 的决胜 all-in 排在河牌圈
 *
 * 翻牌前就全员 all-in 的那一份 patch 里会同时到达 8 段动画（行动 1 + 三条公共牌 3 + 亮牌 1 +
 * 派彩 3 + 本手结束 1 之类），而 SPEC §3.1 规定积压超过 5 段就清空队列、直接落终态。
 * 那不是 bug，是写好的取舍（`anim/queue.ts` 顶部有整段说明）。为了让这个回放器真能把他
 * 需要目视的东西放出来，B 把决胜堆的 all-in 放在河牌圈——但这一帧仍然到 6 段，**照样超线**。
 * 保留超线是故意的：那一帧点下去你会看到画面**直接落终态**、按钮行右侧的「队列 N 段 / 上限 5」
 * 停在 0（第 6 段一进来整条队列就被清空，所以这个数永远到不了 6），
 * 该不该放宽那个 5 由他在这里判断，不由我们在代码里替他决定。
 * 想看完全不超线的多池派彩，把 B 最后那一帧之前的牌面当成参照即可；A 的河牌圈双 all-in
 * 是另一条不超线的路（3 段）。
 */

import type { Card, Rank, Suit } from '@poker-room/shared/view';

import type { ScriptLegal, ScriptScenario } from './replayScript';

/** 写牌面用的简写：`c(11, 's')` = J♠。点数沿用 `types.ts`：10=T 11=J 12=Q 13=K 14=A */
function c(rank: Rank, suit: Suit): Card {
  return { rank, suit };
}

/** A 的公共牌 9♠ T♥ J♦ Q♣ K♠——它自己就是桌上最大的顺子，所以收尾必然平分 */
const A_BOARD = {
  flop: [c(9, 's'), c(10, 'h'), c(11, 'd')],
  turn: c(12, 'c'),
  river: c(13, 's'),
} as const;

/**
 * 服务端算好、随快照下来的那份提示位（`players[i].legal`）。
 *
 * 只在「轮到我」的帧上给，其余帧一律留空——全灰才是线上「这一下还没轮到你」的样子。
 * 三个数按当前局面手填：`callAmount` 还要补多少、`minRaiseTotal` 最小加注总额、
 * `maxRaiseTotal` 全进时的总额（= 本街已投 + 口袋余额）。
 */
function legal(callAmount: number, minRaiseTotal: number, maxRaiseTotal: number): ScriptLegal {
  return {
    canFold: true,
    canCheck: callAmount === 0,
    callAmount,
    canRaise: maxRaiseTotal > callAmount,
    minRaiseTotal,
    maxRaiseTotal,
    canAllIn: maxRaiseTotal > 0,
  };
}

/** A：8 人满桌，收尾两人平分底池。买入 8×1000 = 8000。 */
const eightMaxChop: ScriptScenario = {
  id: 'eight-max-chop',
  title: '8 人满桌 · 平分底池',
  summary:
    '四条街走完。河牌圈两人 all-in，公共牌 9-T-J-Q-K 本身就是最大的顺子，两人平分 2070。',
  smallBlind: 10,
  bigBlind: 20,
  seats: [
    { nickname: '我', chips: 1000 },
    { nickname: '阿明', chips: 1000 },
    { nickname: '老张', chips: 1000 },
    { nickname: '小林', chips: 1000 },
    { nickname: '大伟', chips: 1000 },
    { nickname: '阿芳', chips: 1000 },
    { nickname: '小陈', chips: 1000 },
    { nickname: '老王', chips: 1000 },
  ],
  frames: [
    { label: '空桌', note: '还没开局：8 个座位各 1000，池是空的。', ops: [] },
    {
      label: '开局 · 发牌',
      note: '一份 patch 里四件事同时到：hand:start → shuffle → deal:start → turn:change。发牌起点是小盲（7 号位）。',
      ops: [
        { t: 'start', dealer: 5, sb: 6, bb: 7 },
        { t: 'shuffle' },
        {
          t: 'deal',
          holes: [
            [c(2, 'c'), c(3, 'c')],
            [c(4, 'd'), c(5, 'd')],
            [c(6, 's'), c(7, 's')],
            [c(5, 's'), c(6, 'c')],
            [c(7, 'd'), c(8, 'd')],
            [c(2, 'd'), c(3, 'd')],
            [c(4, 's'), c(8, 's')],
            [c(2, 's'), c(6, 'd')],
          ],
        },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(20, 40, 1000) },
      ],
    },
    {
      label: '我开局加注 60',
      note: '翻牌前由大盲下一位（我，UTG）先动。池 30 → 90。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'raise', totalBet: 60 } },
        { t: 'turn', seat: 1 },
      ],
    },
    {
      label: '2 号弃牌',
      note: '弃牌只有 260ms：牌面朝下飘走，不加戏。',
      ops: [
        { t: 'act', seat: 1, action: { type: 'fold' } },
        { t: 'turn', seat: 2 },
      ],
    },
    {
      label: '3 号跟注（翻牌前）',
      note: '池 150。',
      ops: [
        { t: 'act', seat: 2, action: { type: 'call' } },
        { t: 'turn', seat: 3 },
      ],
    },
    {
      label: '4 号弃牌',
      ops: [
        { t: 'act', seat: 3, action: { type: 'fold' } },
        { t: 'turn', seat: 4 },
      ],
    },
    {
      label: '5 号弃牌',
      ops: [
        { t: 'act', seat: 4, action: { type: 'fold' } },
        { t: 'turn', seat: 5 },
      ],
    },
    {
      label: '6 号弃牌',
      ops: [
        { t: 'act', seat: 5, action: { type: 'fold' } },
        { t: 'turn', seat: 6 },
      ],
    },
    {
      label: '7 号（小盲）弃牌',
      note: '他那 10 枚小盲已经在池里了——弃牌不会把它退回来。',
      ops: [
        { t: 'act', seat: 6, action: { type: 'fold' } },
        { t: 'turn', seat: 7 },
      ],
    },
    {
      label: '8 号（大盲）跟注 → 翻牌',
      note: '一份 patch：action:made → round:end → board:deal(flop)。补 40 之后池 190，三张牌一起翻出来。',
      ops: [
        { t: 'act', seat: 7, action: { type: 'call' } },
        { t: 'street', phase: 'FLOP', cards: A_BOARD.flop },
        { t: 'turn', seat: 7, seconds: 30 },
      ],
    },
    {
      label: '8 号过牌',
      note: '街上还剩三个人：我、3 号、8 号。行动顺序从庄家左边算起，所以 8 号先动。',
      ops: [
        { t: 'act', seat: 7, action: { type: 'check' } },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(0, 20, 940) },
      ],
    },
    {
      label: '我加注 150',
      ops: [
        { t: 'act', seat: 0, action: { type: 'raise', totalBet: 150 } },
        { t: 'turn', seat: 2 },
      ],
    },
    {
      label: '3 号跟注（翻牌圈）',
      note: '池 490。8 号还没决定。',
      ops: [
        { t: 'act', seat: 2, action: { type: 'call' } },
        { t: 'turn', seat: 7, seconds: 30 },
      ],
    },
    {
      label: '8 号弃牌 → 转牌',
      note: '一份 patch：他弃牌让一街立刻结束，Q♣ 紧跟着落地。',
      ops: [
        { t: 'act', seat: 7, action: { type: 'fold' } },
        { t: 'street', phase: 'TURN', cards: [A_BOARD.turn] },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(0, 20, 790) },
      ],
    },
    {
      label: '我过牌',
      ops: [
        { t: 'act', seat: 0, action: { type: 'check' } },
        { t: 'turn', seat: 2 },
      ],
    },
    {
      label: '3 号加注 200',
      ops: [
        { t: 'act', seat: 2, action: { type: 'raise', totalBet: 200 } },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(200, 400, 790) },
      ],
    },
    {
      label: '我跟注 → 河牌',
      note: '池 890。K♠ 落地后，公共牌自己就是 K 高顺子——谁的手牌都没用。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'call' } },
        { t: 'street', phase: 'RIVER', cards: [A_BOARD.river] },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(0, 20, 590) },
      ],
    },
    {
      label: '我全进',
      ops: [
        { t: 'act', seat: 0, action: { type: 'allIn' } },
        { t: 'turn', seat: 2 },
      ],
    },
    {
      label: '3 号全进 → 摊牌 → 平分',
      note: '两人都只能用公共牌：同一个顺子、同一个 2070 的池，各分 1035。两个赢家都该同时亮起来。',
      ops: [
        { t: 'act', seat: 2, action: { type: 'allIn' } },
        { t: 'roundEnd' },
        { t: 'show', pots: [{ amount: 2070, eligible: [0, 2] }] },
        { t: 'reveal', seats: [0, 2] },
        {
          t: 'award',
          potIndex: 0,
          winners: [0, 2],
          payouts: [
            [0, 1035],
            [2, 1035],
          ],
          handName: '顺子',
          bestFive: [...A_BOARD.flop, A_BOARD.turn, A_BOARD.river],
        },
        { t: 'emoji', seat: 2, emoji: 'fold-face' },
        {
          t: 'end',
          handNames: [
            [0, '顺子'],
            [2, '顺子'],
          ],
        },
      ],
    },
  ],
};

/** B：四人三种深度，池按深度切三段，三个不同的人各收一段。买入 500+100+300+500 = 1400。 */
const sidePots: ScriptScenario = {
  id: 'side-pots',
  title: '边池 · 三个池三个赢家',
  summary:
    '2 号只有 100（翻牌前就 all-in），3 号 300（转牌 all-in），我与大伟各 500（河牌 all-in）。' +
    '池切 400 / 600 / 400 三段，分别由同花、顺子、三条收走——最矮的筹码堆赢下主池。',
  smallBlind: 10,
  bigBlind: 20,
  seats: [
    { nickname: '我', chips: 500 },
    { nickname: '老王', chips: 100 },
    { nickname: '老张', chips: 300 },
    { nickname: '大伟', chips: 500 },
  ],
  frames: [
    { label: '空桌', note: '四人买入 1400。2 号只有 100，这就是他后面只能竞争主池的原因。', ops: [] },
    {
      label: '开局 · 发牌',
      note: '盲注：我小盲 10、2 号大盲 20。庄家 4 号，所以 3 号先行动。',
      ops: [
        { t: 'start', dealer: 3, sb: 0, bb: 1 },
        { t: 'shuffle' },
        {
          t: 'deal',
          holes: [
            [c(11, 's'), c(11, 'd')],
            [c(14, 'h'), c(13, 'h')],
            [c(10, 's'), c(10, 'h')],
            [c(11, 'c'), c(10, 'd')],
          ],
        },
        { t: 'turn', seat: 2 },
      ],
    },
    {
      label: '3 号加注 100',
      note: '他只有 300，这一手从这一刻起就封顶在 300 那一层。',
      ops: [
        { t: 'act', seat: 2, action: { type: 'raise', totalBet: 100 } },
        { t: 'turn', seat: 3 },
      ],
    },
    {
      label: '4 号跟注（翻牌前）',
      ops: [
        { t: 'act', seat: 3, action: { type: 'call' } },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(90, 180, 500) },
      ],
    },
    {
      label: '我跟注（补 90）',
      note: '小盲只补差额：490 + 90 之后本街已投 100。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'call' } },
        { t: 'turn', seat: 1 },
      ],
    },
    {
      label: '2 号全进（只剩 80）→ 翻牌',
      note: '一份 patch：他补 80 全进，一街随之结束，7♥ 8♥ 9♠ 同时落地。池 400。',
      ops: [
        { t: 'act', seat: 1, action: { type: 'allIn' } },
        { t: 'street', phase: 'FLOP', cards: [c(7, 'h'), c(8, 'h'), c(9, 's')] },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(0, 20, 400) },
      ],
    },
    {
      label: '我过牌（翻牌圈）',
      note: '2 号已经 all-in，不再出现在行动序列里；他那段「等轮到我」根本不会来。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'check' } },
        { t: 'turn', seat: 2 },
      ],
    },
    {
      label: '3 号下注 100',
      ops: [
        { t: 'act', seat: 2, action: { type: 'raise', totalBet: 100 } },
        { t: 'turn', seat: 3 },
      ],
    },
    {
      label: '4 号跟注（翻牌圈）',
      ops: [
        { t: 'act', seat: 3, action: { type: 'call' } },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(100, 200, 400) },
      ],
    },
    {
      label: '我跟注 → 转牌',
      note: 'J♥ 落地：公共牌第三张红心，同时给我补成三条。池 700。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'call' } },
        { t: 'street', phase: 'TURN', cards: [c(11, 'h')] },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(0, 20, 300) },
      ],
    },
    {
      label: '我过牌（转牌圈）',
      ops: [
        { t: 'act', seat: 0, action: { type: 'check' } },
        { t: 'turn', seat: 2 },
      ],
    },
    {
      label: '3 号全进（只剩 100）',
      ops: [
        { t: 'act', seat: 2, action: { type: 'allIn' } },
        { t: 'turn', seat: 3 },
      ],
    },
    {
      label: '4 号跟注（转牌圈）',
      ops: [
        { t: 'act', seat: 3, action: { type: 'call' } },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(100, 200, 300) },
      ],
    },
    {
      label: '我跟注 → 河牌',
      note: '池 1000。2♣ 是张废牌：它没改变任何人的最好五张。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'call' } },
        { t: 'street', phase: 'RIVER', cards: [c(2, 'c')] },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(0, 20, 200) },
      ],
    },
    {
      label: '我全进（只剩 200）',
      note: '这一下把顶层撑到 500，第三个边池就是这么长出来的。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'allIn' } },
        { t: 'turn', seat: 3, seconds: 30 },
      ],
    },
    {
      label: '4 号全进 → 三个池依次派彩',
      note:
        '这一帧到达 6 段动画（行动 + 亮牌 + 派彩 ×3 + 本手结束），超过 SPEC §3.1 的积压上限 5。' +
        '点了它你会看到牌一张没飞、画面直接落终态，按钮行右侧的「队列 N 段」停在 0——这就是需要他判断的那一下。',
      ops: [
        { t: 'act', seat: 3, action: { type: 'allIn' } },
        { t: 'roundEnd' },
        {
          t: 'show',
          pots: [
            { amount: 400, eligible: [0, 1, 2, 3] },
            { amount: 600, eligible: [0, 2, 3] },
            { amount: 400, eligible: [0, 3] },
          ],
        },
        { t: 'reveal', seats: [0, 1, 2, 3] },
        {
          t: 'award',
          potIndex: 0,
          winners: [1],
          payouts: [[1, 400]],
          handName: '同花',
          bestFive: [c(14, 'h'), c(13, 'h'), c(11, 'h'), c(8, 'h'), c(7, 'h')],
        },
        {
          t: 'award',
          potIndex: 1,
          winners: [2],
          payouts: [[2, 600]],
          handName: '顺子',
          bestFive: [c(11, 'h'), c(10, 's'), c(9, 's'), c(8, 'h'), c(7, 'h')],
        },
        {
          t: 'award',
          potIndex: 2,
          winners: [0],
          payouts: [[0, 400]],
          handName: '三条',
          bestFive: [c(11, 's'), c(11, 'd'), c(11, 'h'), c(9, 's'), c(8, 'h')],
        },
        { t: 'emoji', seat: 3, emoji: 'angry' },
        {
          t: 'end',
          handNames: [
            [0, '三条'],
            [1, '同花'],
            [2, '顺子'],
            [3, '一对'],
          ],
        },
      ],
    },
  ],
};

/** C：单挑，最后对面弃牌。买入 2×1000 = 2000。 */
const headsUpWalk: ScriptScenario = {
  id: 'heads-up-walk',
  title: '单挑 · 无人跟注的派彩',
  summary:
    '两人桌的规矩都在这儿：庄家就是我、我就是小盲，翻牌前我先动，后三条街反过来让对面先动。' +
    '河牌圈我下 300 他弃牌 → 那 300 从未进池、原路退回，剩下的池直接给我，不翻任何人的牌。',
  smallBlind: 10,
  bigBlind: 20,
  seats: [
    { nickname: '我（庄家 / 小盲）', chips: 1000 },
    { nickname: '对面', chips: 1000 },
  ],
  frames: [
    { label: '空桌', note: '两人桌，买入 2000。', ops: [] },
    {
      label: '开局 · 发牌',
      note: '两人桌庄家**就是**小盲（SPEC §5.3）：发牌从我开始，行动也从我开始。',
      ops: [
        { t: 'start', dealer: 0, sb: 0, bb: 1 },
        { t: 'shuffle' },
        {
          t: 'deal',
          holes: [
            [c(14, 's'), c(13, 's')],
            [c(12, 'd'), c(11, 'd')],
          ],
        },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(10, 40, 1000) },
      ],
    },
    {
      label: '我平跟（补 10）',
      note: '小盲只补到大盲，不是再下一手。池 40。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'call' } },
        { t: 'turn', seat: 1 },
      ],
    },
    {
      label: '大盲加注到 80',
      ops: [
        { t: 'act', seat: 1, action: { type: 'raise', totalBet: 80 } },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(60, 140, 1000) },
      ],
    },
    {
      label: '我跟注 → 翻牌',
      note: '池 160。翻牌后行动权换人：**大盲先动**，所以下一帧轮到对面。',
      ops: [
        { t: 'act', seat: 0, action: { type: 'call' } },
        { t: 'street', phase: 'FLOP', cards: [c(2, 'h'), c(7, 'c'), c(9, 'd')] },
        { t: 'turn', seat: 1, seconds: 30 },
      ],
    },
    {
      label: '对面过牌（翻牌圈）',
      ops: [
        { t: 'act', seat: 1, action: { type: 'check' } },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(0, 20, 920) },
      ],
    },
    {
      label: '我下注 100',
      ops: [
        { t: 'act', seat: 0, action: { type: 'raise', totalBet: 100 } },
        { t: 'turn', seat: 1, seconds: 30 },
      ],
    },
    {
      label: '他跟注 → 转牌',
      note: '池 360，4♠ 落地。',
      ops: [
        { t: 'act', seat: 1, action: { type: 'call' } },
        { t: 'street', phase: 'TURN', cards: [c(4, 's')] },
        { t: 'turn', seat: 1, seconds: 30 },
      ],
    },
    {
      label: '对面过牌（转牌圈）',
      ops: [
        { t: 'act', seat: 1, action: { type: 'check' } },
        { t: 'turn', seat: 0, seconds: 30, legal: legal(0, 20, 820) },
      ],
    },
    {
      label: '我下注 150',
      ops: [
        { t: 'act', seat: 0, action: { type: 'raise', totalBet: 150 } },
        { t: 'turn', seat: 1, seconds: 30 },
      ],
    },
    {
      label: '他跟注 → 河牌',
      note: '池 660，10♦ 落地。',
      ops: [
        { t: 'act', seat: 1, action: { type: 'call' } },
        { t: 'street', phase: 'RIVER', cards: [c(10, 'd')] },
        { t: 'turn', seat: 1, seconds: 30 },
      ],
    },
    {
      label: '对面过牌（超时预警已发）',
      note: '这一帧带 `warn`：快照的 `timeoutWarning` 有值，牌桌顶部该出现「服务端还有 N 秒会替你决定」。',
      ops: [
        { t: 'act', seat: 1, action: { type: 'check' } },
        { t: 'turn', seat: 0, seconds: 12, warn: 9, legal: legal(0, 20, 670) },
      ],
    },
    {
      label: '我下注 300',
      ops: [
        { t: 'act', seat: 0, action: { type: 'raise', totalBet: 300 } },
        { t: 'turn', seat: 1, seconds: 20 },
      ],
    },
    {
      label: '对面弃牌 → 300 退回 → 直接派彩',
      note:
        '单人路径：不评估牌型、不发 showdown:start、不翻任何人的牌。未被跟注的 300 原路回口袋，' +
        '池里剩下的 660 全给我。终局 1330 / 670 = 2000。',
      ops: [
        { t: 'act', seat: 1, action: { type: 'fold' } },
        { t: 'roundEnd' },
        { t: 'refund', seat: 0, amount: 300 },
        { t: 'walk', winner: 0 },
        { t: 'emoji', seat: 1, emoji: 'fold-face' },
        { t: 'wait', seconds: 8 },
        { t: 'end' },
      ],
    },
  ],
};

/** 回放器工具条上的三个场景，顺序即 TASKS.md M3.2 的验收条目顺序 */
export const REPLAY_SCENARIOS: readonly ScriptScenario[] = [eightMaxChop, sidePots, headsUpWalk];
