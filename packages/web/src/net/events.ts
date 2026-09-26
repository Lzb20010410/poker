/**
 * `event` 通道的入站校验 —— 服务端广播 → `S2C_Broadcast`。
 *
 * 为什么不直接 `payload as S2C_Broadcast`：TypeScript 的 `as` 只是一个说法，
 * 运行时什么都不做。这条通道上走的是 `this.broadcast('event', ...)` 发出去的裸 JSON
 * （`S2C_Broadcast` 里有 `Card[]`、`Action`、`Pot[]` 这些结构体，schema 帮不上忙），
 * 前端与服务端的版本不总是同一天上线的，所以要有一个地方把「我收到的东西」变成
 * 「我确信它长这样」。动画层拿到的一定是合形状的事件，才有资格不写判空。
 *
 * ## 丢掉是安全的，猜是危险的
 *
 * 判不过就返回 `null`，这条广播当没发生过。权威状态由 schema patch 单独兜（SPEC §1.3），
 * 所以少一段动画 ≠ 画面出错；反过来，用默认值凑一个能播的任务，凑出来的位置是编的。
 *
 * 唯一值得停一下的是 `board:deal`：那里的 `cards` 是**位置**——公共牌动画按张数决定
 * 飞几枚、落在哪一格。混进一张非法牌时「丢掉那一张、播剩下两张」会让后面每一张都错位，
 * 所以这里和 `view.ts` 的 `readCards` 相反：任何一张不合，整条丢。
 */

import { PHASES, RANKS, SUITS, type Action, type Card, type Phase, type PlayerProfile, type PlayerResult, type Pot, type Rank, type S2C_Broadcast, type Suit } from '@poker-room/shared/view';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 存在的有限数字。注意 `0` 是合法值（0 号座位、0 筹码），不能用真值判 */
function numberField(source: JsonRecord, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 金额字段：引擎的铁律是整数筹码（`shared/types.ts` 文件头），来了小数就是协议违规 */
function chipsField(source: JsonRecord, key: string): number | null {
  const value = numberField(source, key);
  return value !== null && Number.isSafeInteger(value) ? value : null;
}

/** 数组里的座位号，规则和 `seatField` 一样，只是来源是数组元素而不是具名字段 */
function readSeat(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * 座位号：**非负安全整数**。这里不比对 `config.maxPlayers`——校验层拿不到配置，
 * 而且座位号合法但桌上没这个人，渲染层按座位查不到就是了，不是错播。
 */
function seatField(source: JsonRecord, key: string): number | null {
  return readSeat(source[key]);
}

/** 存在且非空的字符串：`handId`、昵称、牌型名，空的比缺的更难看 */
function textField(source: JsonRecord, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readCardJson(value: unknown): Card | null {
  if (!isRecord(value)) return null;
  const rank = value['rank'];
  const suit = value['suit'];
  if (typeof rank !== 'number' || !(RANKS as readonly number[]).includes(rank)) return null;
  if (typeof suit !== 'string' || !(SUITS as readonly string[]).includes(suit)) return null;
  return { rank: rank as Rank, suit: suit as Suit };
}

/**
 * 牌的 JSON 数组。`allowEmpty` 分开是因为两处要的规矩不同：
 * `bestFive` 只是展示（空顶多少显示几张牌），`board:deal` 的张数决定动画怎么走。
 */
function readCardsJson(value: unknown, allowEmpty: boolean): Card[] | null {
  if (!Array.isArray(value)) return null;
  const cards: Card[] = [];
  for (const raw of value as unknown[]) {
    const card = readCardJson(raw);
    if (card === null) return null;
    cards.push(card);
  }
  return !allowEmpty && cards.length === 0 ? null : cards;
}

/** 座位号数组（`winners` / `eligible`），任何一项不合就整条不合 */
function readSeatsJson(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const seats: number[] = [];
  for (const raw of value as unknown[]) {
    const seat = readSeat(raw);
    if (seat === null) return null;
    seats.push(seat);
  }
  return seats;
}

/** `Action` 是判别联合，`raise` 少了 `totalBet` 就没法算该飞多少筹码 */
function readActionJson(value: unknown): Action | null {
  if (!isRecord(value)) return null;
  switch (value['type']) {
    case 'fold':
    case 'check':
    case 'call':
    case 'allIn':
      return { type: value['type'] };
    case 'raise': {
      const totalBet = chipsField(value, 'totalBet');
      return totalBet === null || totalBet < 0 ? null : { type: 'raise', totalBet };
    }
    default:
      return null;
  }
}

function readPhaseJson(value: unknown): Phase | null {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value) ? (value as Phase) : null;
}

function readPotsJson(value: unknown): Pot[] | null {
  if (!Array.isArray(value)) return null;
  const pots: Pot[] = [];
  for (const raw of value as unknown[]) {
    if (!isRecord(raw)) return null;
    const amount = chipsField(raw, 'amount');
    const eligible = readSeatsJson(raw['eligible']);
    if (amount === null || amount < 0 || eligible === null) return null;
    pots.push({ amount, eligible });
  }
  return pots;
}

function readResultsJson(value: unknown): PlayerResult[] | null {
  if (!Array.isArray(value)) return null;
  const results: PlayerResult[] = [];
  for (const raw of value as unknown[]) {
    if (!isRecord(raw)) return null;
    const playerId = textField(raw, 'playerId');
    const seatIndex = seatField(raw, 'seatIndex');
    const chips = chipsField(raw, 'chips');
    const delta = chipsField(raw, 'delta');
    if (playerId === null || seatIndex === null || chips === null || delta === null) return null;
    // `handName` 是可选的（没摊牌的一手就没有），缺了不许当成空字符串显示
    const handName = raw['handName'] === undefined ? undefined : textField(raw, 'handName');
    if (handName === null) return null;
    results.push({ playerId, seatIndex, chips, delta, ...(handName === undefined ? {} : { handName }) });
  }
  return results;
}

function readProfileJson(value: unknown): PlayerProfile | null {
  if (!isRecord(value)) return null;
  const id = textField(value, 'id');
  const nickname = textField(value, 'nickname');
  const avatarSeed = textField(value, 'avatarSeed');
  return id === null || nickname === null || avatarSeed === null ? null : { id, nickname, avatarSeed };
}

/**
 * `pot:awarded` 单独点名出来：`view.ts` 的 `awardFromEvent` 只吃这一种，
 * 拿已经收窄过的类型投影，比在投影里再判一次 `event.t` 老实。
 */
export type PotAwardedEvent = Extract<S2C_Broadcast, { readonly t: 'pot:awarded' }>;

/**
 * 一个变体一个读法。返回 `null` 有两种含义，调用方不必区分：
 * 「事件名不认识」（服务端比前端新）和「认识但形状不合」（协议改了或传输坏了）。
 * 两种都只能丢——动画层的规矩是「要么按它播，要么不播」。
 */
export function readBroadcastEvent(payload: unknown): S2C_Broadcast | null {
  if (!isRecord(payload)) return null;
  const type = textField(payload, 't');
  if (type === null) return null;

  switch (type) {
    case 'hand:start': {
      const handId = textField(payload, 'handId');
      const dealerSeat = seatField(payload, 'dealerSeat');
      const sbSeat = seatField(payload, 'sbSeat');
      const bbSeat = seatField(payload, 'bbSeat');
      return handId === null || dealerSeat === null || sbSeat === null || bbSeat === null
        ? null
        : { t: type, handId, dealerSeat, sbSeat, bbSeat };
    }
    case 'shuffle':
      return { t: type };
    case 'deal:start': {
      // `count` 是「这一轮发几张」，0 张没有意义（引擎恒为 1 或 2）
      const count = numberField(payload, 'count');
      const startSeat = seatField(payload, 'startSeat');
      return count === null || !Number.isSafeInteger(count) || count < 1 || startSeat === null
        ? null
        : { t: type, count, startSeat };
    }
    case 'board:deal': {
      const phase = payload['phase'];
      if (phase !== 'flop' && phase !== 'turn' && phase !== 'river') return null;
      const cards = readCardsJson(payload['cards'], false);
      return cards === null ? null : { t: type, phase, cards };
    }
    case 'action:made': {
      const seatIndex = seatField(payload, 'seatIndex');
      const action = readActionJson(payload['action']);
      const chipsDelta = chipsField(payload, 'chipsDelta');
      return seatIndex === null || action === null || chipsDelta === null
        ? null
        : { t: type, seatIndex, action, chipsDelta };
    }
    case 'turn:change': {
      const seatIndex = seatField(payload, 'seatIndex');
      // `deadline` 是服务端时钟下的毫秒戳，可以比现在早（动画队列可能比它慢）
      const deadline = numberField(payload, 'deadline');
      return seatIndex === null || deadline === null ? null : { t: type, seatIndex, deadline };
    }
    case 'round:end': {
      const phase = readPhaseJson(payload['phase']);
      return phase === null ? null : { t: type, phase };
    }
    case 'showdown:start': {
      const pots = readPotsJson(payload['pots']);
      return pots === null ? null : { t: type, pots };
    }
    case 'pot:awarded': {
      const potIndex = numberField(payload, 'potIndex');
      const winners = readSeatsJson(payload['winners']);
      const amount = chipsField(payload, 'amount');
      const handName = textField(payload, 'handName');
      const bestFive = readCardsJson(payload['bestFive'], true);
      if (potIndex === null || !Number.isSafeInteger(potIndex) || potIndex < 0) return null;
      return winners === null || amount === null || handName === null || bestFive === null
        ? null
        : { t: type, potIndex, winners, amount, handName, bestFive };
    }
    case 'hand:end': {
      const results = readResultsJson(payload['results']);
      return results === null ? null : { t: type, results };
    }
    case 'player:joined': {
      const seatIndex = seatField(payload, 'seatIndex');
      const profile = readProfileJson(payload['profile']);
      return seatIndex === null || profile === null ? null : { t: type, seatIndex, profile };
    }
    case 'player:left':
    case 'chips:rebuy': {
      const seatIndex = seatField(payload, 'seatIndex');
      return seatIndex === null ? null : { t: type, seatIndex };
    }
    case 'player:emoji': {
      const seatIndex = seatField(payload, 'seatIndex');
      const emoji = textField(payload, 'emoji');
      return seatIndex === null || emoji === null ? null : { t: type, seatIndex, emoji };
    }
    default:
      return null;
  }
}
