/**
 * 领域类型 —— 整个项目的词汇表。
 *
 * 权威定义见 RULES-SPEC.md。本文件只放类型，以及「与类型不可分割的纯函数」
 * （牌的规范字符串形式、查表转换）。任何带 IO / 带状态 / 带随机性的东西都不许放这里。
 *
 * 铁律：所有金额字段一律是整数筹码，禁止浮点。
 */

// ---------------------------------------------------------------------------
// 牌（RULES-SPEC §1.1）
// ---------------------------------------------------------------------------

/** 花色：s=黑桃 h=红心 d=方块 c=梅花。数组下标即 suitIndex */
export type Suit = 's' | 'h' | 'd' | 'c';

export const SUITS = ['s', 'h', 'd', 'c'] as const satisfies readonly Suit[];

/** 点数：2..10 为牌面数字，11=J 12=Q 13=K 14=A。A 恒为 14，轮子顺 A-2-3-4-5 由评估器特判 */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const satisfies readonly Rank[];

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

const RANK_LABELS: Record<Rank, string> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

const SUIT_SYMBOLS: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/** 点数的显示字符：J/Q/K/A 用字母，其余用数字 */
export function rankLabel(rank: Rank): string {
  return RANK_LABELS[rank];
}

/** 花色的 Unicode 符号，仅用于文字兜底渲染（正式牌面走 SVG 资产，见 SPEC.md §4.5） */
export function suitSymbol(suit: Suit): string {
  return SUIT_SYMBOLS[suit];
}

/** 花色下标。牌的全局唯一编号 = rank * 4 + suitIndex */
export function suitIndex(suit: Suit): number {
  return SUITS.indexOf(suit);
}

/** 牌的规范字符串形式，用于协议传输、日志与测试断言。例："As" "Kh" "10d" "2c" */
export function cardId(card: Card): string {
  return `${RANK_LABELS[card.rank]}${card.suit}`;
}

/**
 * 全部 52 个合法牌标识 → 牌。
 *
 * 用查表而不是正则解析：表的键集合就是「合法输入」的完整定义，查不到即非法。
 * 这样"非法输入"是一条真实可达、可测试的分支，而不是靠正则的分组保证
 * 制造出永远走不到的 throw（走不到的代码 = 覆盖率黑洞 + 从未被验证过的错误处理）。
 */
const CARD_BY_ID = new Map<string, Card>(
  SUITS.flatMap((suit) => RANKS.map((rank) => [`${RANK_LABELS[rank]}${suit}`, { rank, suit }] as const)),
);

/** cardId 的逆运算。非法输入抛错，不返回 null —— 静默失败在牌类逻辑里是最贵的 bug */
export function parseCardId(id: string): Card {
  const found = CARD_BY_ID.get(id);
  if (found === undefined) throw new Error(`非法的牌标识：${JSON.stringify(id)}`);
  // 返回新对象而不是表里的实例，避免调用方拿到跨模块共享的可变引用
  return { rank: found.rank, suit: found.suit };
}

/** 全部 52 张牌的规范标识，升序固定。测试与调试用 */
export const ALL_CARD_IDS: readonly string[] = Object.freeze([...CARD_BY_ID.keys()]);

// ---------------------------------------------------------------------------
// 牌局阶段（RULES-SPEC §5.1）
// ---------------------------------------------------------------------------

export type Phase = 'IDLE' | 'DEALING' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'HAND_END';

/** 状态机顺序：IDLE → DEALING → PREFLOP → FLOP → TURN → RIVER → SHOWDOWN → HAND_END */
export const PHASES = [
  'IDLE',
  'DEALING',
  'PREFLOP',
  'FLOP',
  'TURN',
  'RIVER',
  'SHOWDOWN',
  'HAND_END',
] as const satisfies readonly Phase[];

/** 需要玩家行动的下注阶段。IDLE / DEALING / SHOWDOWN / HAND_END 都不接受动作 */
export const BETTING_PHASES = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const;

export type BettingPhase = (typeof BETTING_PHASES)[number];

export function isBettingPhase(phase: Phase): phase is BettingPhase {
  return (BETTING_PHASES as readonly Phase[]).includes(phase);
}

// ---------------------------------------------------------------------------
// 动作（RULES-SPEC §3.2）
// ---------------------------------------------------------------------------

export type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'allIn';

/**
 * 玩家动作。
 *
 * 注意 raise 用的是 `totalBet`（本轮下注目标**总额**），不是增量。
 * 用总额能消除 80% 的下注逻辑歧义（RULES-SPEC §3.2）。
 */
export type Action =
  | { readonly type: 'fold' }
  | { readonly type: 'check' }
  | { readonly type: 'call' }
  | { readonly type: 'raise'; readonly totalBet: number }
  | { readonly type: 'allIn' };

// ---------------------------------------------------------------------------
// 玩家在手牌中的状态（RULES-SPEC §3.1）
// ---------------------------------------------------------------------------

export interface PlayerHandState {
  /** 座位号 0..7，顺时针递增 */
  readonly seatIndex: number;
  /** 桌上剩余筹码（≥ 0），整数 */
  readonly chips: number;
  /** 2 张底牌，**仅服务端持有**，绝不进入 Colyseus schema */
  readonly holeCards: readonly Card[];
  readonly folded: boolean;
  readonly allIn: boolean;
  /** 本下注轮已投入，进入新一轮时清零 */
  readonly committedThisStreet: number;
  /** 本手累计投入（跨轮）。边池计算只看这个字段 */
  readonly committedTotal: number;
  /** 本下注轮是否已行动过。PREFLOP 大盲 option 靠它实现 */
  readonly hasActed: boolean;
  /** 离座 / 托管中 */
  readonly sittingOut: boolean;
}

// ---------------------------------------------------------------------------
// 奖池（RULES-SPEC §4.1）
// ---------------------------------------------------------------------------

export interface Pot {
  /** 池内筹码，整数 */
  readonly amount: number;
  /** 有资格赢取本池的座位号。已弃牌玩家的贡献计入金额，但不会出现在这里 */
  readonly eligible: readonly number[];
}

// ---------------------------------------------------------------------------
// 牌桌配置（RULES-SPEC §5.3）
// ---------------------------------------------------------------------------

/** 开局最少人数，规格固定为 2 */
export type MinPlayers = 2;

/** 牌桌最大人数，2..8 */
export type MaxPlayers = 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface TableConfig {
  /** 小盲，默认 10 */
  readonly smallBlind: number;
  /** 大盲，默认 20（= 2 × smallBlind） */
  readonly bigBlind: number;
  /** 起始筹码，默认 2000（= 100 BB） */
  readonly startingChips: number;
  /** 最大人数，默认 8 */
  readonly maxPlayers: MaxPlayers;
  /** 单次行动超时秒数，默认 30。超时自动 check / fold */
  readonly actionTimeoutSec: number;
  /** 开局最少人数，固定 2 */
  readonly minPlayersToStart: MinPlayers;
}

export const DEFAULT_TABLE_CONFIG: TableConfig = {
  smallBlind: 10,
  bigBlind: 20,
  startingChips: 2000,
  maxPlayers: 8,
  actionTimeoutSec: 30,
  minPlayersToStart: 2,
};

/** 行动超时提前告警秒数（剩余 10 秒时提示），见 SPEC.md §3.5 */
export const ACTION_WARNING_SEC = 10;
