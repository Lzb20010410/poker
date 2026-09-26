import { expect } from 'vitest';

import { awardPots, calculatePots, evaluate7, type HandResult, type PotAward } from '../src/engine';
import { parseCardId, type PlayerHandState, type Pot } from '../src/types';

export type Contribution = Pick<PlayerHandState, 'seatIndex' | 'committedTotal' | 'folded'>;

export function player(seatIndex: number, committedTotal: number, folded = false): Contribution {
  return { seatIndex, committedTotal, folded };
}

export function expectPots(players: readonly Contribution[], expected: readonly Pot[]): Pot[] {
  const before = JSON.stringify(players);
  const pots = calculatePots(players);
  expect(pots).toEqual(expected);
  expect(pots.reduce((sum, pot) => sum + pot.amount, 0)).toBe(
    players.reduce((sum, entry) => sum + entry.committedTotal, 0),
  );
  for (const pot of pots) {
    expect(Number.isSafeInteger(pot.amount)).toBe(true);
    expect(pot.amount).toBeGreaterThan(0);
    expect(new Set(pot.eligible).size).toBe(pot.eligible.length);
  }
  expect(JSON.stringify(players)).toBe(before);
  return pots;
}

/** 同一副真实公共牌和互不重复的底牌，禁止用手写 score 替代评估器。 */
export function showdown(board: string, holes: readonly (readonly [number, string])[]): Map<number, HandResult> {
  const community = board.split(' ').map(parseCardId);
  expect(community).toHaveLength(5);
  const allIds = [...board.split(' '), ...holes.flatMap(([, cards]) => cards.split(' '))];
  expect(new Set(allIds).size).toBe(allIds.length);
  return new Map(holes.map(([seatIndex, cards]) => {
    const holeCards = cards.split(' ').map(parseCardId);
    expect(holeCards).toHaveLength(2);
    return [seatIndex, evaluate7([...community, ...holeCards])];
  }));
}

export function rankedHands(): Map<number, HandResult> {
  return showdown('4c 8d 7h Jc 2h', [
    [0, 'As Ah'], [1, 'Ks Kh'], [2, 'Qs Qh'], [3, 'Js Jh'], [4, '10c 9c'],
  ]);
}

export function tiedHands(): Map<number, HandResult> {
  return showdown('10h Jh Qh Kh Ah', [[0, '2h 3h'], [2, '4h 5h'], [7, '6h 7h']]);
}

/** 这里只验证派彩与局部余额守恒，不冒充 table 的完整一手回归。 */
export function expectAwards(
  pots: readonly Pot[],
  hands: ReadonlyMap<number, HandResult>,
  dealerButton: number,
  expected: readonly PotAward[],
): PotAward[] {
  const before = JSON.stringify([pots, [...hands]]);
  const awards = awardPots(pots, hands, dealerButton);
  expect(awards).toEqual(expected);
  expect(awards).toHaveLength(pots.length);
  const total = pots.reduce((sum, pot) => sum + pot.amount, 0);
  let paid = 0;
  for (const award of awards) {
    const pot = pots[award.potIndex]!;
    expect(award.amount).toBe(pot.amount);
    expect(award.payouts.reduce((sum, payout) => sum + payout.amount, 0)).toBe(pot.amount);
    expect(award.payouts.map((payout) => payout.seatIndex)).toEqual(award.winners);
    for (const payout of award.payouts) {
      expect(pot.eligible).toContain(payout.seatIndex);
      expect(Number.isSafeInteger(payout.amount)).toBe(true);
      expect(payout.amount).toBeGreaterThanOrEqual(0);
      paid += payout.amount;
    }
  }
  expect(paid).toBe(total);
  expect(JSON.stringify([pots, [...hands]])).toBe(before);
  // 返回值只能包含领域数据，不带 evaluator/pokersolver 的手牌对象。
  expect(JSON.parse(JSON.stringify(awards))).toEqual(awards);
  return awards;
}

export function award(potIndex: number, amount: number, payouts: readonly (readonly [number, number])[]): PotAward {
  return {
    potIndex,
    amount,
    winners: payouts.map(([seatIndex]) => seatIndex),
    payouts: payouts.map(([seatIndex, chips]) => ({ seatIndex, amount: chips })),
  };
}
