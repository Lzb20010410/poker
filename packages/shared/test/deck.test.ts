import { describe, expect, it } from 'vitest';

import { Deck, DeckExhaustedError, createDeck, shuffle } from '../src/engine/deck';
import { mulberry32 } from '../src/engine/random';
import { RANKS, SUITS, cardId, type Card, parseCardId } from '../src/types';

/** 固定 seed —— 全部测试都用它，保证任何一次失败都能原样复现 */
const SEED = 20260925;

function ids(cards: readonly Card[]): string[] {
  return cards.map((c) => cardId(c));
}

describe('createDeck', () => {
  it('正好 52 张', () => {
    expect(createDeck()).toHaveLength(52);
  });

  it('没有重复牌', () => {
    expect(new Set(ids(createDeck())).size).toBe(52);
  });

  it('4 种花色 × 13 个点数，一个不缺', () => {
    const deck = createDeck();
    for (const suit of SUITS) {
      const ofSuit = deck.filter((c) => c.suit === suit).map((c) => c.rank);
      expect(ofSuit).toEqual([...RANKS]);
    }
  });

  it('每次调用返回新数组，互不影响', () => {
    const a = createDeck();
    const b = createDeck();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('cardId / parseCardId', () => {
  it('全牌堆往返解析一致', () => {
    for (const card of createDeck()) {
      expect(parseCardId(cardId(card))).toEqual(card);
    }
  });
});

describe('shuffle', () => {
  it('洗牌后仍是 52 张且不重复（不丢牌、不复制牌）', () => {
    const shuffled = shuffle(createDeck(), mulberry32(SEED));
    expect(shuffled).toHaveLength(52);
    expect(new Set(ids(shuffled)).size).toBe(52);
    expect([...ids(shuffled)].sort()).toEqual([...ids(createDeck())].sort());
  });

  it('同一 seed 洗牌结果完全一致（可复现）', () => {
    const a = ids(shuffle(createDeck(), mulberry32(SEED)));
    const b = ids(shuffle(createDeck(), mulberry32(SEED)));
    expect(a).toEqual(b);
  });

  it('不同 seed 洗牌结果不同', () => {
    const a = ids(shuffle(createDeck(), mulberry32(SEED)));
    const b = ids(shuffle(createDeck(), mulberry32(SEED + 1)));
    expect(a).not.toEqual(b);
  });

  it('洗牌后顺序与原顺序不同，且不是只有个别位置变动', () => {
    const original = ids(createDeck());
    const shuffled = ids(shuffle(createDeck(), mulberry32(SEED)));
    expect(shuffled).not.toEqual(original);
    const moved = shuffled.filter((id, i) => id !== original[i]).length;
    expect(moved).toBeGreaterThan(45);
  });

  it('不修改传入的数组（纯函数）', () => {
    const deck = createDeck();
    const before = ids(deck);
    shuffle(deck, mulberry32(SEED));
    expect(ids(deck)).toEqual(before);
  });

  it('空数组 / 单元素数组不抛错', () => {
    expect(shuffle([], mulberry32(SEED))).toEqual([]);
    const one: Card[] = [{ rank: 14, suit: 's' }];
    expect(shuffle(one, mulberry32(SEED))).toEqual(one);
  });

  it('默认随机源可用（不注入 rand 也能洗）', () => {
    const shuffled = shuffle(createDeck());
    expect(shuffled).toHaveLength(52);
    expect(new Set(ids(shuffled)).size).toBe(52);
    expect(ids(shuffled)).not.toEqual(ids(createDeck()));
  });

  it('是 Fisher-Yates 而不是 sort(() => rand()-0.5)：4 张牌的 24 种排列分布均匀', () => {
    // sort 式洗牌在 4 张牌上会产生明显偏斜（部分排列出现频率是其他的数倍，
    // 甚至永远不出现）。这是区分两者的硬指标，不能靠读代码判断。
    const four: Card[] = [
      { rank: 2, suit: 's' },
      { rank: 3, suit: 'h' },
      { rank: 4, suit: 'd' },
      { rank: 5, suit: 'c' },
    ];
    const rand = mulberry32(4242);
    const seen = new Map<string, number>();
    const runs = 24 * 800;
    for (let i = 0; i < runs; i += 1) {
      const key = ids(shuffle(four, rand)).join('');
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect(seen.size).toBe(24);
    const expected = runs / 24;
    for (const count of seen.values()) {
      expect(count).toBeGreaterThan(expected * 0.8);
      expect(count).toBeLessThan(expected * 1.2);
    }
  });
});

describe('Deck', () => {
  it('new Deck() 默认装入一副未洗的 52 张，随机源默认 cryptoRandom', () => {
    const deck = new Deck();
    expect(deck.remaining).toBe(52);
    expect(deck.burned).toEqual([]);
    expect(ids(deck.deal(52))).toEqual(ids(createDeck()));
  });

  it('new Deck(cards) 复制入参：之后改动外部数组不影响牌堆', () => {
    const source = createDeck();
    const deck = new Deck(source, mulberry32(SEED));
    source.length = 0;
    expect(deck.remaining).toBe(52);
  });

  it('fresh 之后有 52 张，烧牌数为 0', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    expect(deck.remaining).toBe(52);
    expect(deck.burned).toEqual([]);
  });

  it('同一 seed 的 fresh 牌堆顺序一致', () => {
    const a = ids(Deck.fresh(mulberry32(SEED)).deal(52));
    const b = ids(Deck.fresh(mulberry32(SEED)).deal(52));
    expect(a).toEqual(b);
  });

  it('deal(n) 数量正确，牌堆相应减少', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    expect(deck.deal(2)).toHaveLength(2);
    expect(deck.remaining).toBe(50);
    expect(deck.deal(3)).toHaveLength(3);
    expect(deck.remaining).toBe(47);
    expect(deck.dealOne()).toBeDefined();
    expect(deck.remaining).toBe(46);
  });

  it('deal 出去的牌互不重复，且合起来就是整副牌', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    const dealt = deck.deal(52);
    expect(new Set(ids(dealt)).size).toBe(52);
    expect([...ids(dealt)].sort()).toEqual([...ids(createDeck())].sort());
    expect(deck.remaining).toBe(0);
  });

  it('deal(0) 返回空数组且不消耗牌', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    expect(deck.deal(0)).toEqual([]);
    expect(deck.remaining).toBe(52);
  });

  it('Deck.fresh() 不注入随机源也能用', () => {
    const deck = Deck.fresh();
    expect(deck.remaining).toBe(52);
    expect(new Set(ids(deck.deal(52))).size).toBe(52);
  });

  it('负数 / 非整数张数抛错，且不消耗牌', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    expect(() => deck.deal(-1)).toThrow(/非负整数/);
    expect(() => deck.deal(1.5)).toThrow(/非负整数/);
    expect(() => deck.burn(-1)).toThrow(/非负整数/);
    expect(deck.remaining).toBe(52);
  });

  it('burn() 返回被烧的牌，且这些牌绝不出现在后续 deal() 中', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    const burned = deck.burn();
    expect(burned).toHaveLength(1);
    expect(deck.burned).toEqual(burned);
    expect(deck.remaining).toBe(51);

    const rest = deck.deal(51);
    const burnedIds = new Set(ids(burned));
    for (const card of rest) expect(burnedIds.has(cardId(card))).toBe(false);
  });

  it('多次 burn 全部按顺序记录，且不与发出的牌重叠', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    const b1 = deck.burn();
    const b2 = deck.burn();
    const b3 = deck.burn(3);
    expect(deck.burned).toHaveLength(5);
    expect(deck.burned).toEqual([...b1, ...b2, ...b3]);
    expect(deck.remaining).toBe(47);

    const dealt = deck.deal(47);
    const burnedIds = new Set(ids(deck.burned));
    expect(burnedIds.size).toBe(5);
    for (const card of dealt) expect(burnedIds.has(cardId(card))).toBe(false);
  });

  it('burned 是冻结快照：外部无法篡改内部记录', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    deck.burn(2);
    const first = deck.burned;
    const second = deck.burned;
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(deck.burned).toHaveLength(2);
  });

  it('牌堆耗尽后 deal / dealOne / burn 抛 DeckExhaustedError', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    deck.deal(52);
    expect(deck.remaining).toBe(0);
    expect(() => deck.dealOne()).toThrow(DeckExhaustedError);
    expect(() => deck.deal(1)).toThrow(DeckExhaustedError);
    expect(() => deck.burn()).toThrow(DeckExhaustedError);
    expect(() => deck.deal(1)).toThrow(/牌堆已空/);
  });

  it('要发的张数超过剩余时抛错，且不部分消耗牌堆（原子性）', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    deck.deal(50);
    expect(() => deck.deal(5)).toThrow(DeckExhaustedError);
    expect(deck.remaining).toBe(2);
  });

  it('DeckExhaustedError 带上请求数与剩余数，便于服务端定位是哪一步算错了牌数', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    deck.deal(50);
    try {
      deck.deal(5);
      throw new Error('应当抛出 DeckExhaustedError');
    } catch (error) {
      expect(error).toBeInstanceOf(DeckExhaustedError);
      expect(error).toBeInstanceOf(Error);
      const exhausted = error as DeckExhaustedError;
      expect(exhausted.requested).toBe(5);
      expect(exhausted.remaining).toBe(2);
      expect(exhausted.name).toBe('DeckExhaustedError');
      expect(exhausted.message).toContain('5');
      expect(exhausted.message).toContain('2');
    }
  });

  it('reset() 换一副全新 52 张重新洗（每手牌不沿用上一手的牌序）', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    const firstOrder = ids(deck.deal(20));
    deck.reset();
    expect(deck.remaining).toBe(52);
    const secondOrder = ids(deck.deal(20));
    expect(new Set(secondOrder).size).toBe(20);
    expect(secondOrder).not.toEqual(firstOrder);
  });

  it('reset() 清空烧牌记录', () => {
    const deck = Deck.fresh(mulberry32(SEED));
    deck.burn(3);
    expect(deck.burned).toHaveLength(3);
    deck.reset();
    expect(deck.burned).toEqual([]);
    expect(deck.remaining).toBe(52);
  });

  it('能走完一手 8 人满桌的完整发牌流程，全场无重复牌', () => {
    const deck = Deck.fresh(mulberry32(SEED));

    deck.burn();
    // 底牌是"每人一张、轮两次"，不是"每人连发两张"
    const holeRounds: Card[][] = [[], []];
    for (let round = 0; round < 2; round += 1) {
      for (let seat = 0; seat < 8; seat += 1) holeRounds[round]?.push(deck.dealOne());
    }
    expect(deck.remaining).toBe(52 - 1 - 16);

    deck.burn();
    const flop = deck.deal(3);
    deck.burn();
    const turn = deck.deal(1);
    deck.burn();
    const river = deck.deal(1);

    expect(flop).toHaveLength(3);
    expect(deck.remaining).toBe(27); // 1+16+1+3+1+1+1+1 = 25 张已出
    expect(deck.burned).toHaveLength(4);

    const all = [
      ...deck.burned,
      ...(holeRounds[0] ?? []),
      ...(holeRounds[1] ?? []),
      ...flop,
      ...turn,
      ...river,
    ];
    expect(all).toHaveLength(25);
    expect(new Set(ids(all)).size).toBe(25);

    // 轮次发牌的顺序：第一轮的 8 张就是烧牌后紧接着的 8 张
    const reference = Deck.fresh(mulberry32(SEED));
    reference.burn();
    expect(ids(holeRounds[0] ?? [])).toEqual(ids(reference.deal(8)));
  });
});
