import { describe, expect, expectTypeOf, it } from 'vitest';
import solver from 'pokersolver';

import { evaluate7 as evaluateFromRoot } from '../src';
import { createDeck, evaluate7, mulberry32, shuffle, type HandResult } from '../src/engine';
import { cardId, parseCardId, type Card, type Rank } from '../src/types';
import { cards, expectBestFive, seven } from './evaluator-fixtures';

// 分值逐例按 RULES-SPEC §2.3 人工展开，重复组保留每一张点数。
const cases = [
  {
    title: '高牌取最高五张，五层比较点数都是 kickers',
    input: 'As Kh 9d 7c 5s 3h 2d', best: 'As Kh 9d 7c 5s',
    rank: 1, name: '高牌', nameEn: 'High Card', kickers: [14, 13, 9, 7, 5],
    score: 15 ** 5 + 14 * 15 ** 4 + 13 * 15 ** 3 + 9 * 15 ** 2 + 7 * 15 + 5,
  },
  {
    title: '一对把对子放在高踢脚之前，英文规范为 One Pair 而非库的 Pair',
    input: '9s 9h Ac Kd 7s 4h 2d', best: '9s 9h Ac Kd 7s',
    rank: 2, name: '一对', nameEn: 'One Pair', kickers: [14, 13, 7],
    score: 2 * 15 ** 5 + 9 * 15 ** 4 + 9 * 15 ** 3 + 14 * 15 ** 2 + 13 * 15 + 7,
  },
  {
    title: '两对按大对子、小对子、单张顺序保留全部五个比较键',
    input: 'Js Jh 4s 4h Ac 8d 2c', best: 'Js Jh 4s 4h Ac',
    rank: 3, name: '两对', nameEn: 'Two Pair', kickers: [14],
    score: 3 * 15 ** 5 + 11 * 15 ** 4 + 11 * 15 ** 3 + 4 * 15 ** 2 + 4 * 15 + 14,
  },
  {
    title: '三条放在 A、K 两个踢脚之前',
    input: '7s 7h 7d As Kc 9d 2h', best: '7s 7h 7d As Kc',
    rank: 4, name: '三条', nameEn: 'Three of a Kind', kickers: [14, 13],
    score: 4 * 15 ** 5 + 7 * 15 ** 4 + 7 * 15 ** 3 + 7 * 15 ** 2 + 14 * 15 + 13,
  },
  {
    title: '普通顺子只取连续五张而不把 A 当踢脚',
    input: '9s 8h 7d 6c 5s Ad 2h', best: '9s 8h 7d 6c 5s',
    rank: 5, name: '顺子', nameEn: 'Straight', kickers: [],
    score: 5 * 15 ** 5 + 9 * 15 ** 4 + 8 * 15 ** 3 + 7 * 15 ** 2 + 6 * 15 + 5,
  },
  {
    title: '同花保留第五张 2 参与比较',
    input: 'As Ks 9s 5s 2s Qh Jd', best: 'As Ks 9s 5s 2s',
    rank: 6, name: '同花', nameEn: 'Flush', kickers: [14, 13, 9, 5, 2],
    score: 6 * 15 ** 5 + 14 * 15 ** 4 + 13 * 15 ** 3 + 9 * 15 ** 2 + 5 * 15 + 2,
  },
  {
    title: '葫芦以 AAAKK 五个点数编码，对子不能丢失',
    input: 'As Ah Ad Ks Kh 9d 2c', best: 'As Ah Ad Ks Kh',
    rank: 7, name: '葫芦', nameEn: 'Full House', kickers: [],
    score: 7 * 15 ** 5 + 14 * 15 ** 4 + 14 * 15 ** 3 + 14 * 15 ** 2 + 13 * 15 + 13,
  },
  {
    title: '四条以 KKKKA 五个点数编码，而非把 A 排到最前',
    input: 'Ks Kh Kd Kc As 9h 2d', best: 'Ks Kh Kd Kc As',
    rank: 8, name: '四条', nameEn: 'Four of a Kind', kickers: [14],
    score: 8 * 15 ** 5 + 13 * 15 ** 4 + 13 * 15 ** 3 + 13 * 15 ** 2 + 13 * 15 + 14,
  },
  {
    title: '同花顺只取连续同花五张，没有踢脚',
    input: '9s 8s 7s 6s 5s Ad 2h', best: '9s 8s 7s 6s 5s',
    rank: 9, name: '同花顺', nameEn: 'Straight Flush', kickers: [],
    score: 9 * 15 ** 5 + 9 * 15 ** 4 + 8 * 15 ** 3 + 7 * 15 ** 2 + 6 * 15 + 5,
  },
  {
    title: '轮子比较键为 54321，但 bestFive 的 A 恢复点数 14 和原花色',
    input: 'As 2h 3d 4c 5s Kh 9d', best: '5s 4c 3d 2h As',
    rank: 5, name: '顺子', nameEn: 'Straight', kickers: [],
    score: 5 * 15 ** 5 + 5 * 15 ** 4 + 4 * 15 ** 3 + 3 * 15 ** 2 + 2 * 15 + 1,
  },
  {
    title: '轮子同花顺恢复红心 A，仍按 54321 计分',
    input: 'Ah 2h 3h 4h 5h Ks 9d', best: '5h 4h 3h 2h Ah',
    rank: 9, name: '同花顺', nameEn: 'Straight Flush', kickers: [],
    score: 9 * 15 ** 5 + 5 * 15 ** 4 + 4 * 15 ** 3 + 3 * 15 ** 2 + 2 * 15 + 1,
  },
  {
    title: '项目 10 转为 solver 的 T 后组成最大顺子',
    input: 'As Kh Qd Jc 10s 4h 2d', best: 'As Kh Qd Jc 10s',
    rank: 5, name: '顺子', nameEn: 'Straight', kickers: [],
    score: 5 * 15 ** 5 + 14 * 15 ** 4 + 13 * 15 ** 3 + 12 * 15 ** 2 + 11 * 15 + 10,
  },
  {
    title: '皇家同花顺仍属于第九类，不另造 Royal Flush 分类',
    input: 'As Ks Qs Js 10s 8h 2d', best: 'As Ks Qs Js 10s',
    rank: 9, name: '同花顺', nameEn: 'Straight Flush', kickers: [],
    score: 9 * 15 ** 5 + 14 * 15 ** 4 + 13 * 15 ** 3 + 12 * 15 ** 2 + 11 * 15 + 10,
  },
  {
    title: 'QKA23 不允许环绕，保留 A 高牌而非顺子',
    input: 'Qs Kh Ad 2c 3s 7h 9d', best: 'Ad Kh Qs 9d 7h',
    rank: 1, name: '高牌', nameEn: 'High Card', kickers: [14, 13, 12, 9, 7],
    score: 15 ** 5 + 14 * 15 ** 4 + 13 * 15 ** 3 + 12 * 15 ** 2 + 9 * 15 + 7,
  },
  {
    title: '七张中有多个可选顺子时选择最高的五张',
    input: 'As 2h 3d 4c 5s 6h 7d', best: '7d 6h 5s 4c 3d',
    rank: 5, name: '顺子', nameEn: 'Straight', kickers: [],
    score: 5 * 15 ** 5 + 7 * 15 ** 4 + 6 * 15 ** 3 + 5 * 15 ** 2 + 4 * 15 + 3,
  },
  {
    title: '三对选最大的两对，再从剩余对子中选第五张',
    input: 'As Ah Ks Kh Qs Qh 2d', best: 'As Ah Ks Kh Qs',
    rank: 3, name: '两对', nameEn: 'Two Pair', kickers: [12],
    score: 3 * 15 ** 5 + 14 * 15 ** 4 + 14 * 15 ** 3 + 13 * 15 ** 2 + 13 * 15 + 12,
  },
  {
    title: '双三条 AAAKKK 截取 AAAKK，不能把 solver 的第六张计入分值',
    input: 'As Ah Ad Ks Kh Kd 2c', best: 'As Ah Ad Ks Kh',
    rank: 7, name: '葫芦', nameEn: 'Full House', kickers: [],
    score: 7 * 15 ** 5 + 14 * 15 ** 4 + 14 * 15 ** 3 + 14 * 15 ** 2 + 13 * 15 + 13,
  },
  {
    title: '一个三条加两个对子时选择较大的对子组成葫芦',
    input: '4s 4h 4d As Ah Ks Kh', best: '4s 4h 4d As Ah',
    rank: 7, name: '葫芦', nameEn: 'Full House', kickers: [],
    score: 7 * 15 ** 5 + 4 * 15 ** 4 + 4 * 15 ** 3 + 4 * 15 ** 2 + 14 * 15 + 14,
  },
  {
    title: '六张同花只取最大的五张，不把低牌补入 score',
    input: 'As Ks 9s 7s 5s 2s Qh', best: 'As Ks 9s 7s 5s',
    rank: 6, name: '同花', nameEn: 'Flush', kickers: [14, 13, 9, 7, 5],
    score: 6 * 15 ** 5 + 14 * 15 ** 4 + 13 * 15 ** 3 + 9 * 15 ** 2 + 7 * 15 + 5,
  },
  {
    title: '七张同花只取最高五张，不返回第六和第七张',
    input: 'Ah Kh Jh 9h 7h 4h 2h', best: 'Ah Kh Jh 9h 7h',
    rank: 6, name: '同花', nameEn: 'Flush', kickers: [14, 13, 11, 9, 7],
    score: 6 * 15 ** 5 + 14 * 15 ** 4 + 13 * 15 ** 3 + 11 * 15 ** 2 + 9 * 15 + 7,
  },
  {
    title: '七张连续同花选择最大的同花顺而非最先发现的五张',
    input: '3d 4d 5d 6d 7d 8d 9d', best: '9d 8d 7d 6d 5d',
    rank: 9, name: '同花顺', nameEn: 'Straight Flush', kickers: [],
    score: 9 * 15 ** 5 + 9 * 15 ** 4 + 8 * 15 ** 3 + 7 * 15 ** 2 + 6 * 15 + 5,
  },
  {
    title: '相同点数的等价顺子选牌使用固定花色顺序，而不受输入顺序影响',
    input: '9h 8d 7c 6h 5d 9s 6s', best: '9s 8d 7c 6s 5d',
    rank: 5, name: '顺子', nameEn: 'Straight', kickers: [],
    score: 5 * 15 ** 5 + 9 * 15 ** 4 + 8 * 15 ** 3 + 7 * 15 ** 2 + 6 * 15 + 5,
  },
];

describe('evaluate7：人工牌型与精确分值', () => {
  it.each(cases)('$title', ({ input, best, rank, name, nameEn, score, kickers }) => {
    const hand = seven(input);
    const result = evaluate7(hand);
    expect(result).toMatchObject({ rank, name, nameEn, score, kickers });
    expectBestFive(result, hand, best);
  });
});

describe('evaluate7：纯函数与适配器契约', () => {
  it('包根入口可以评估只读牌数组，并返回只读领域类型', () => {
    const hand: readonly Card[] = cards('As Ks Qs Js 10s 8h 2d');
    const result = evaluateFromRoot(hand);
    expect(result.name).toBe('同花顺');
    expectBestFive(result, hand, 'As Ks Qs Js 10s');
    expectTypeOf<HandResult['bestFive']>().toEqualTypeOf<readonly Card[]>();
    expectTypeOf<HandResult['kickers']>().toEqualTypeOf<readonly Rank[]>();
  });

  it('冻结数组和每张牌仍可评估轮子，不把输入的 A 改成 1', () => {
    const hand = Object.freeze(seven('As 2h 3d 4c 5s Kh 9d').map((card) => Object.freeze(card)));
    const before = hand.map(cardId);
    const result = evaluate7(hand);
    expectBestFive(result, hand, '5s 4c 3d 2h As');
    expect(hand.map(cardId)).toEqual(before);
    expect(hand[0]).toEqual(parseCardId('As'));
  });

  it('输出对象不共享输入或另一次求值的可变引用', () => {
    const hand = seven('As Ah Ad Ks Kh 9d 2c');
    const first = evaluate7(hand);
    const second = evaluate7(hand);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.bestFive).not.toBe(second.bestFive);
    expect(first.kickers).not.toBe(second.kickers);
    first.bestFive.forEach((card, index) => {
      expect(hand.some((input) => input === card)).toBe(false);
      expect(card).not.toBe(second.bestFive[index]);
    });
  });

  it.each([
    'As Ah Ad Ks Kh Kd 2c',
    '9h 8d 7c 6h 5d 9s 6s',
    'As Ah Ks Kh Qs Qh 2d',
  ])('等价选牌在输入排列变化后保持一致：%s', (text) => {
    const hand = seven(text);
    const expected = evaluate7(hand);
    const rand = mulberry32(20260925);
    for (let index = 0; index < 30; index += 1) {
      expect(evaluate7(shuffle(hand, rand))).toEqual(expected);
    }
  });

  it('1000 组固定种子牌对：分值比较与真实 solver 一致，最佳五张可独立重评', () => {
    const rand = mulberry32(314159);
    const deck = createDeck();
    const solve = (hand: readonly Card[]) => solver.Hand.solve(
      hand.map((card) => cardId(card).replace('10', 'T')), 'standard',
    );
    for (let index = 0; index < 1000; index += 1) {
      const dealt = shuffle(deck, rand);
      const a = dealt.slice(0, 7);
      const b = dealt.slice(7, 14);
      const first = evaluate7(a);
      const second = evaluate7(b);
      const libraryOrder = solve(a).compare(solve(b));
      expect(Math.sign(first.score - second.score)).toBe(libraryOrder === 0 ? 0 : -libraryOrder);
      for (const [hand, result] of [[a, first], [b, second]] as const) {
        expect(result.bestFive).toHaveLength(5);
        expect(new Set(result.bestFive.map(cardId)).size).toBe(5);
        for (const card of result.bestFive) expect(hand).toContainEqual(card);
        expect(Number.isSafeInteger(result.score)).toBe(true);
        expect(solve(result.bestFive).compare(solve(hand))).toBe(0);
      }
    }
  });
});
