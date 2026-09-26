/** 手牌评估适配器（RULES-SPEC §2）：选牌交给 pokersolver，领域层不暴露库对象。 */
import type {} from '../pokersolver-types';
import solver from 'pokersolver';

import { RANKS, SUITS, cardId, parseCardId, suitIndex, type Card, type Rank } from '../types';

export type HandRank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface HandResult {
  readonly rank: HandRank;
  readonly name: string;
  readonly nameEn: string;
  /** 类别 + 按重要性排列的五个点数，按 15 进制编码；数值越大越强。 */
  readonly score: number;
  /** 按比牌重要性排列的实际五张牌；轮子的 A 在这里仍为领域点数 14。 */
  readonly bestFive: readonly Card[];
  /** 散牌踢脚降序；高牌/同花为全部五点数，顺子/同花顺/葫芦为空。 */
  readonly kickers: readonly Rank[];
}

// 不直接采用库的 name：它把一对称为 Pair，而协议采用 One Pair。
const HAND_NAMES = {
  1: { name: '高牌', nameEn: 'High Card' },
  2: { name: '一对', nameEn: 'One Pair' },
  3: { name: '两对', nameEn: 'Two Pair' },
  4: { name: '三条', nameEn: 'Three of a Kind' },
  5: { name: '顺子', nameEn: 'Straight' },
  6: { name: '同花', nameEn: 'Flush' },
  7: { name: '葫芦', nameEn: 'Full House' },
  8: { name: '四条', nameEn: 'Four of a Kind' },
  9: { name: '同花顺', nameEn: 'Straight Flush' },
} as const satisfies Record<HandRank, { readonly name: string; readonly nameEn: string }>;

// solver 已将对子/三条/四条排在踢脚前；无需在适配器重新实现牌型判断。
const KICKER_START: Readonly<Record<HandRank, number>> = {
  1: 0, 2: 2, 3: 4, 4: 3, 5: 5, 6: 0, 7: 5, 8: 4, 9: 5,
};

/** 仅接受七张合法且互异的牌。不修改输入，也不复用输入中的卡对象。 */
export function evaluate7(cards: readonly Card[]): HandResult {
  if (cards.length !== 7) throw new Error('手牌评估必须恰好 7 张牌');

  const seen = new Set<string>();
  for (const card of cards) {
    if (!RANKS.includes(card.rank)) throw new Error(`非法的牌点数：${String(card.rank)}`);
    if (!SUITS.includes(card.suit)) throw new Error(`非法的牌花色：${String(card.suit)}`);
    const id = cardId(card);
    if (seen.has(id)) throw new Error(`重复的牌：${id}`);
    seen.add(id);
  }

  // 等价牌按固定顺序择一，使 UI 高亮不随输入顺序跳动。花色不进入分值。
  const ordered = [...cards].sort((a, b) => b.rank - a.rank || suitIndex(a.suit) - suitIndex(b.suit));
  const solved = solver.Hand.solve(ordered.map((card) => cardId(card).replace('10', 'T')), 'standard');

  // 2.1.4 对双三条葫芦可能返回六张；库自己的 compare 也只比较前五张。
  const selected = solved.cards.slice(0, 5);
  const score = selected.reduce<number>((value, card) => value * 15 + card.rank + 1, solved.rank);
  const bestFive = selected.map((card) => {
    const id = card.toString();
    // solver 将轮子 A 改写成 1；保留 score 中的 1，但恢复可用于 UI 的真实 A。
    return parseCardId(card.rank === 0 ? `A${id.slice(-1)}` : id);
  });

  return {
    rank: solved.rank,
    ...HAND_NAMES[solved.rank],
    score,
    bestFive,
    kickers: bestFive.slice(KICKER_START[solved.rank]).map((card) => card.rank),
  };
}

/** 正值为 a 胜，零为完全平局；花色与未入选五张的牌不参与比较。 */
export function compare(a: HandResult, b: HandResult): -1 | 0 | 1 {
  if (a.score > b.score) return 1;
  if (a.score < b.score) return -1;
  return 0;
}
