import type { PrivateMessage, S2C_Broadcast } from '../protocol';
import type { Card, Phase, Pot } from '../types';
import { evaluate7, type HandResult } from './evaluator';
import { awardPots, calculatePots, type PotAward } from './sidepot';
import {
  update,
  type TableContext,
  type TableParticipant,
  type TableState,
  type TableUpdate,
} from './table-state';

function holeCards(p: TableParticipant): readonly [Card, Card] {
  // 开手时恰好发两张；整个手牌生命周期不改变底牌。
  return [p.holeCards[0]!, p.holeCards[1]!];
}
export function holeMessage(state: TableState, p: TableParticipant): PrivateMessage {
  return {
    playerId: p.playerId,
    message: { t: 'deal:holeCards', cards: holeCards(p), handId: state.handId },
  };
}
function reveals(state: TableState, playerId: string): PrivateMessage[] {
  return state.participants
    .filter((p) => !p.folded)
    .map((p) => ({
      playerId,
      message: {
        t: 'showdown:reveal',
        handId: state.handId,
        seatIndex: p.seatIndex,
        cards: holeCards(p),
      },
    }));
}
export function getPrivateMessages(state: TableState, id: string): readonly PrivateMessage[] {
  if (!state.accounts.some((a) => a.id === id && a.presence !== 'left')) return [];
  const participant = state.participants.find((p) => p.playerId === id);
  const own = participant ? [holeMessage(state, participant)] : [];
  // results 仅在结算完成后存在；IDLE 等待重买时仍允许**参加过这一手的人**重连恢复已公开信息。
  // 亮牌的公开范围是"这一手的牌桌"，不是"这个房间"：`PokerRoom` 每次 ping / 每个新加入者都会
  // 重放这里，所以必须以收信人参加过这一手为条件，否则后进房的人会反复收到上一手的底牌（铁律 #1）。
  const shown =
    participant !== undefined &&
    state.results.length > 0 &&
    state.participants.filter((p) => !p.folded).length > 1;
  return shown ? [...own, ...reveals(state, id)] : own;
}

/**
 * 铁律：弃牌者投入里"没有任何还在手的人跟得到"的部分，在关门那一刻退回原主，
 * 不进底池、也不参与摊牌分配（uncalled bet returns to the bettor）。
 *
 * 为什么必须在进池之前夹：`calculatePots` 按 `committedTotal` 分层，一个只有弃牌者投过钱的
 * 层没有合格赢家，会走 RULES-SPEC §4.1 的防御分支被并进上一池，于是这笔钱被摊牌赢家顺走
 * （小盲投 10、大盲 3 不足额全下、三人各跟 3 后小盲弃牌：池算成 19 而不是 12，小盲多输 7）。
 * 在手的最大投入就是"还有人跟得到"的上限，所以弃牌者的入池额夹到这里，差额直接退人。
 * `calculatePots` / `awardPots` 保持原样：在手玩家的未跟到部分本来就由分层边池自动退回。
 */
function potContributions(state: TableState): Map<number, number> {
  const liveMax = state.participants
    .filter((p) => !p.folded)
    .reduce((max, p) => Math.max(max, p.committedTotal), 0);
  return new Map(
    state.participants.map((p) => [
      p.seatIndex,
      p.folded ? Math.min(p.committedTotal, liveMax) : p.committedTotal,
    ]),
  );
}

export function settleHand(
  state: TableState,
  ctx: TableContext,
  winnerSeat: number | null,
): TableUpdate {
  update(state);
  const events: S2C_Broadcast[] = [];
  const phases: Phase[] = [];
  const privateMessages: PrivateMessage[] = [];
  const contributions = potContributions(state);
  const inPot = (p: TableParticipant) => ({
    seatIndex: p.seatIndex,
    committedTotal: contributions.get(p.seatIndex)!,
    folded: p.folded,
  });
  let pots: readonly Pot[];
  let awards: readonly PotAward[];
  const hands = new Map<number, HandResult>();
  if (winnerSeat !== null) {
    // 单人路径不能调用评估器：即使公共牌未发完也直接派奖，绝不泄漏 bestFive。
    const amount = state.participants.reduce((sum, p) => sum + contributions.get(p.seatIndex)!, 0);
    pots = [{ amount, eligible: [winnerSeat] }];
    awards = [
      { potIndex: 0, amount, winners: [winnerSeat], payouts: [{ seatIndex: winnerSeat, amount }] },
    ];
    events.push({
      t: 'pot:awarded',
      potIndex: 0,
      amount,
      winners: [winnerSeat],
      bestFive: [],
      handName: '其他玩家弃牌',
    });
  } else {
    phases.push('SHOWDOWN');
    pots = calculatePots(state.participants.map(inPot));
    for (const p of state.participants.filter((p) => !p.folded))
      hands.set(p.seatIndex, evaluate7([...p.holeCards, ...state.board]));
    // 每手开始已选择按钮，结算前不会清除。
    awards = awardPots(pots, hands, state.dealerSeat!);
    events.push({ t: 'showdown:start', pots });
    // 收信人必须是这一手的参与者，和 getPrivateMessages 用同一个条件：原来这里发给"所有未离桌账号"，
    // 于是中途入座、这手没参与的人会在摊牌那一刻收到全桌底牌（铁律 #1）。
    for (const p of state.participants) {
      if (state.accounts.some((a) => a.id === p.playerId && a.presence !== 'left'))
        privateMessages.push(...reveals(state, p.playerId));
    }
    for (const award of awards) {
      // awardPots 保证每个池至少一个赢家，且该赢家必有评估结果。
      const hand = hands.get(award.winners[0]!)!;
      events.push({
        t: 'pot:awarded',
        potIndex: award.potIndex,
        winners: award.winners,
        amount: award.amount,
        handName: hand.name,
        bestFive: hand.bestFive,
      });
    }
  }
  // 起点不是 0：夹出去的那部分从未进池，直接记在原主账上，保证 Σwinnings == ΣcommittedTotal。
  const winnings = new Map(
    state.participants.map(
      (p) => [p.seatIndex, p.committedTotal - contributions.get(p.seatIndex)!],
    ),
  );
  for (const award of awards)
    for (const payout of award.payouts)
      winnings.set(payout.seatIndex, winnings.get(payout.seatIndex)! + payout.amount);
  const accounts = state.accounts.map((a) => {
    const p = state.participants.find((p) => p.playerId === a.id);
    return p ? { ...a, chips: a.chips + winnings.get(p.seatIndex)! } : a;
  });
  const results = state.participants.map((p) => ({
    playerId: p.playerId,
    seatIndex: p.seatIndex,
    chips: accounts.find((a) => a.id === p.playerId)!.chips,
    delta: winnings.get(p.seatIndex)! - p.committedTotal,
    ...(hands.has(p.seatIndex) ? { handName: hands.get(p.seatIndex)!.name } : {}),
  }));
  phases.push('HAND_END');
  events.push({ t: 'hand:end', results });
  return update(
    {
      ...state,
      accounts,
      results,
      pots,
      phase: 'HAND_END',
      currentTurn: null,
      deadline: null,
      nextHandAt: ctx.now + 5000,
      participants: state.participants.map((p) => ({
        ...p,
        committedThisStreet: 0,
        committedTotal: 0,
      })),
    },
    events,
    privateMessages,
    phases,
  );
}
