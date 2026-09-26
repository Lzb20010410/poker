import type { PlayerHandState, Pot } from '../types';
import type { HandResult } from './evaluator';

export interface PotAward {
  readonly potIndex: number;
  readonly amount: number;
  /** 按按钮后顺时针排列，与 payouts 顺序一致。 */
  readonly winners: readonly number[];
  readonly payouts: readonly { readonly seatIndex: number; readonly amount: number }[];
}

function assertChips(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('筹码必须为非负安全整数');
}

/**
 * 座位号上界写死 7，和 `validateConfig` 的 `maxPlayers <= 8` 是同一条约束的两端
 * （牌桌座位永远是 0..maxPlayers-1，而 maxPlayers 最大就是 8）。
 * 想扩到 9 人以上：先改 `validateConfig` 的上限，这里必须跟着改成同一个来源，
 * 否则算池会先于配置报错，症状看起来像"池子炸了"而不是"人数超限"。
 */
function assertSeat(seat: number): void {
  if (!Number.isInteger(seat) || seat < 0 || seat > 7) throw new RangeError('座位必须为 0..7');
}

function assertDistinctSeats(seats: readonly number[]): void {
  for (const seat of seats) assertSeat(seat);
  if (new Set(seats).size !== seats.length) throw new RangeError('座位不能重复');
}

/** RULES-SPEC §4.1：先按所有投入分层，再合并相邻的等资格池。 */
export function calculatePots(
  players: readonly Pick<PlayerHandState, 'seatIndex' | 'committedTotal' | 'folded'>[],
): Pot[] {
  assertDistinctSeats(players.map((p) => p.seatIndex));
  let total = 0;
  for (const p of players) {
    assertChips(p.committedTotal);
    total += p.committedTotal;
    assertChips(total);
  }
  const levels = [...new Set(players.map((p) => p.committedTotal))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    if (level <= prev) continue;
    let amount = 0;
    for (const p of players) {
      amount += Math.min(p.committedTotal, level) - Math.min(p.committedTotal, prev);
    }
    const eligible = players.filter((p) => !p.folded && p.committedTotal >= level).map((p) => p.seatIndex);
    if (amount > 0 && eligible.length > 0) {
      pots.push({ amount, eligible });
    } else if (amount > 0) {
      const previous = pots.at(-1);
      if (previous !== undefined) {
        pots[pots.length - 1] = { amount: previous.amount + amount, eligible: previous.eligible };
      } else {
        // 保留规格的防御路径；awardPots 明确拒绝无资格池，不能让筹码消失。
        pots.push({ amount, eligible: [] });
      }
    }
    prev = level;
  }
  const merged: Pot[] = [];
  for (const pot of pots) {
    const previous = merged.at(-1);
    if (previous !== undefined && previous.eligible.length === pot.eligible.length
      && previous.eligible.every((seat) => pot.eligible.includes(seat))) {
      merged[merged.length - 1] = { amount: previous.amount + pot.amount, eligible: [...previous.eligible] };
    } else {
      merged.push({ amount: pot.amount, eligible: [...pot.eligible] });
    }
  }
  return merged;
}

/** RULES-SPEC §4.2：逐池比大小、整数平分，余数从按钮后一位开始分。 */
export function awardPots(
  pots: readonly Pot[],
  hands: ReadonlyMap<number, HandResult>,
  dealerButton: number,
): PotAward[] {
  assertSeat(dealerButton);
  let total = 0;
  return pots.map((pot, potIndex) => {
    assertChips(pot.amount);
    total += pot.amount;
    assertChips(total);
    assertDistinctSeats(pot.eligible);
    if (pot.eligible.length === 0) throw new RangeError('奖池没有可派彩的玩家');
    let bestScore = -Infinity;
    let winners: number[] = [];
    for (const seat of pot.eligible) {
      const hand = hands.get(seat);
      if (hand === undefined) throw new RangeError(`缺少座位 ${seat} 的手牌评估`);
      if (hand.score > bestScore) {
        bestScore = hand.score;
        winners = [seat];
      } else if (hand.score === bestScore) {
        winners.push(seat);
      }
    }
    winners.sort((a, b) => ((a - dealerButton + 7) % 8) - ((b - dealerButton + 7) % 8));
    const base = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount % winners.length;
    return {
      potIndex,
      amount: pot.amount,
      winners,
      payouts: winners.map((seatIndex, index) => ({ seatIndex, amount: base + (index < remainder ? 1 : 0) })),
    };
  });
}
