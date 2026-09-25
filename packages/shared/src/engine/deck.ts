/**
 * 牌堆：创建、洗牌、发牌、烧牌（RULES-SPEC §1）。
 *
 * 纯逻辑，零 IO。随机性通过 RandomSource 参数注入（见 engine/random.ts）。
 *
 * 两条容易忽略但必须遵守的规则：
 *
 * 1. **每手牌都用一副全新的 52 张重新洗**，不沿用上一手的牌序（Deck.reset() 为此存在）。
 * 2. 烧掉的牌（burned）只在服务端留存用于复盘，**绝不下发给客户端**——
 *    它能让任何人在河牌之前就算出全部公共牌。
 */

import { RANKS, SUITS, type Card } from '../types';
import { cryptoRandom, randomInt, type RandomSource } from './random';

/**
 * 牌堆空了还要发牌。
 * 服务端应当把它当 bug 记日志，而不是当普通业务错误回给客户端——
 * 一手正常的德州扑克永远发不满 52 张（8 人满桌最多用掉 25 张）。
 */
export class DeckExhaustedError extends Error {
  constructor(
    readonly requested: number,
    readonly remaining: number,
  ) {
    super(`牌堆已空：请求发 ${String(requested)} 张，仅剩 ${String(remaining)} 张`);
    this.name = 'DeckExhaustedError';
  }
}

/**
 * 一副标准 52 张牌，不含大小王。
 * 顺序：花色外层（s → h → d → c），点数内层升序（2 → A）。固定顺序便于断言与调试。
 */
export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

/**
 * Fisher-Yates 洗牌（Knuth shuffle）。
 *
 * 从最后一张往前，每张与 [0, i] 区间内随机选中的一张交换。这个方向保证每个位置
 * 被每张牌填中的概率严格相等。写成 `sort(() => rand() - 0.5)` 会产生严重偏斜
 * （部分排列的出现频率是其他的数倍），单测里有分布检验盯着这件事。
 *
 * **不修改入参**，返回新数组。调用方可以安全地把同一个原始牌堆反复洗。
 */
export function shuffle(cards: readonly Card[], rand: RandomSource = cryptoRandom): Card[] {
  const out = [...cards];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(rand, i + 1);
    // 两处非空断言的前提是可证的：i < out.length 由循环条件保证，
    // j ∈ [0, i] 由 randomInt 的上下界校验保证。
    const moved = out[i]!;
    out[i] = out[j]!;
    out[j] = moved;
  }
  return out;
}

/**
 * 一手牌的牌堆。
 *
 * 与 shuffle() 的区别：Deck 持有"已发出 / 已烧掉"的状态，保证同一手牌里绝不会
 * 把同一张牌发两次。table.ts 的状态机只通过 Deck 取牌，不自己碰数组。
 */
export class Deck {
  private cards: Card[];
  private readonly burnedCards: Card[] = [];

  /**
   * @param cards 牌堆内容，从头部按顺序发出。**会被复制**，外部数组的后续改动不影响本 Deck。
   * @param rand  随机源，reset() 时复用。默认 cryptoRandom。
   */
  constructor(
    cards: readonly Card[] = createDeck(),
    private readonly rand: RandomSource = cryptoRandom,
  ) {
    this.cards = [...cards];
  }

  /** 新建一副 52 张并洗好，用于每手牌的开始 */
  static fresh(rand: RandomSource = cryptoRandom): Deck {
    return new Deck(shuffle(createDeck(), rand), rand);
  }

  /** 剩余可发的张数 */
  get remaining(): number {
    return this.cards.length;
  }

  /** 已烧掉的牌，按烧牌顺序。冻结快照，外部无法篡改内部记录 */
  get burned(): readonly Card[] {
    return Object.freeze([...this.burnedCards]);
  }

  /**
   * 烧牌：从牌堆顶移除 n 张并记录，不公开。
   * @returns 被烧掉的牌（服务端复盘用，**不得下发客户端**）
   */
  burn(n = 1): Card[] {
    this.assertTakeable(n);
    const taken = this.cards.splice(0, n);
    this.burnedCards.push(...taken);
    return taken;
  }

  /** 发一张牌。牌堆为空时抛 DeckExhaustedError */
  dealOne(): Card {
    const card = this.cards.shift();
    if (card === undefined) throw new DeckExhaustedError(1, 0);
    return card;
  }

  /**
   * 发 n 张牌，按牌堆顶顺序返回。
   * n 超过剩余张数时抛 DeckExhaustedError，且**不部分消耗牌堆**（原子性）——
   * 半发状态会让整手牌无法结算。
   */
  deal(n: number): Card[] {
    this.assertTakeable(n);
    return this.cards.splice(0, n);
  }

  /** 换一副全新 52 张重新洗牌，并清空烧牌记录。每手牌开始时调用 */
  reset(): void {
    this.cards = shuffle(createDeck(), this.rand);
    this.burnedCards.length = 0;
  }

  private assertTakeable(n: number): void {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`取牌张数必须是非负整数，收到 ${String(n)}`);
    }
    if (n > this.cards.length) throw new DeckExhaustedError(n, this.cards.length);
  }
}
