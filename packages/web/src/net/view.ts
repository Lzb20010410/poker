/**
 * schema → 视图快照的翻译层，外加定向消息载荷的校验。
 *
 * 三条规矩：
 * 1. **哨兵还原**。`t.number` 表达不了 `null`，服务端用 `-1`（没座位 / 没人轮到）、
 *    `0`（没有截止时刻）、`''`（没房主）占位（D-016）。翻译层负责还原成 `null`，
 *    免得每个组件都自己记一遍这套暗号。
 * 2. **收窄必须有兜底**。schema 镜像里 `phase` / `presence` 是 `string`，
 *    视图里是联合类型。收到不认识的值时走**最保守**的那一支：
 *    未知 phase 当 `IDLE`、未知 presence 当 `reconnecting`——两者的效果都是
 *    「按钮不亮、不让玩家乱点」，宁可少动一下，也不能让过期界面继续操作。
 * 3. **不泄漏引用**。返回的全是新构造的普通对象/数组：快照会被 React memo、
 *    会被测试断言，绝不能持有 `MapSchema` 的活引用，否则下一次 patch 会
 *    把玩家已经看到的那份数据原地改掉。
 */

import {
  FELT_VALUES, PHASES, RANKS, SUITS,
  type Card, type FeltColor, type Phase, type Rank, type Suit,
} from '@poker-room/shared/view';

import type { PotAwardedEvent } from './events';
import type { SyncedCard, SyncedList, SyncedRoomState } from './sdkTypes';
import type {
  AwardView, ConnectedPlayer, HandPlayerView, Presence, PotView, RevealView,
  ResultView, RoomSnapshot, TableViewConfig,
} from './types';

/** 翻译层能碰到的私有信息：只可能来自发给我的定向消息 */
export interface PrivateView {
  holeCards: readonly [Card, Card] | null;
  reveals: RevealView[];
  timeoutWarning: number | null;
  awards: AwardView[];
}

const PRESENCES: readonly Presence[] = ['online', 'reconnecting', 'left'];

/** 第一个 patch 之前的状态：全空，字段一个都不能少，否则组件到处要判 undefined */
const EMPTY_CONFIG: TableViewConfig = {
  smallBlind: 0,
  bigBlind: 0,
  startingChips: 0,
  maxPlayers: 0,
  actionTimeoutSec: 0,
  minPlayersToStart: 0,
  // 上面的 0 是「还不知道」，这一项不能是「还不知道」：桌面底色在第一个 patch 之前也要有，
  // 否则连接中的那一帧是黑屏。默认档和引擎的 `DEFAULT_TABLE_CONFIG.felt` 同一个值。
  felt: FELT_VALUES[0],
};

export function emptyPrivate(): PrivateView {
  return { holeCards: null, reveals: [], timeoutWarning: null, awards: [] };
}

/** 收到第一个 patch 且 `joinCode` 已填上，才算「可以渲染」 */
export function isStateReady(state: SyncedRoomState | undefined): state is SyncedRoomState {
  return state !== undefined && typeof state.joinCode === 'string' && state.joinCode.length > 0;
}

function readNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function readSeat(value: number): number | null {
  // 先判有限性，**再**走哨兵。顺序反了就错：`readNumber` 把非有限值归成 0，而 0 是
  // 一个合法座位号，于是「服务端给了个垃圾值」会被翻译成「服务端在等 0 号位」，
  // 坐 0 号位的人动作条直接亮起来。金额猜 0 只是少显示，座位猜 0 是多显示。
  if (!Number.isFinite(value)) return null;
  return value < 0 ? null : value;
}

/** 时刻类字段用 0 表示「没有」，所以 `<= 0` 才是哨兵 */
function readTime(value: number): number | null {
  const time = readNumber(value);
  return time <= 0 ? null : time;
}

function readId(value: string): string | null {
  return value.length > 0 ? value : null;
}

function readPhase(raw: string): Phase {
  return (PHASES as readonly string[]).includes(raw) ? (raw as Phase) : 'IDLE';
}

function readPresence(raw: string): Presence {
  return PRESENCES.includes(raw as Presence) ? (raw as Presence) : 'reconnecting';
}

/**
 * 桌布的兜底方向和其他收窄不同：认不出来时不需要「保守」，只需要「有一块桌布」。
 * 但**必须**认不出来的值不能直接进 `FELT_COLORS` 查表——查不到得到 `undefined`，
 * 拼出的 SVG 里 `stop-color` 为空，整张桌面变黑块。空串正是 `t.string` 的默认值
 * （服务端还没写过这个字段时到这里），所以白名单外一律回落 `FELT_VALUES[0]`。
 */
function readFelt(raw: string): FeltColor {
  return (FELT_VALUES as readonly string[]).includes(raw) ? (raw as FeltColor) : FELT_VALUES[0];
}

function readCard(raw: SyncedCard): Card | null {
  if (!(RANKS as readonly number[]).includes(raw.rank)) return null;
  if (!(SUITS as readonly string[]).includes(raw.suit)) return null;
  return { rank: raw.rank as Rank, suit: raw.suit as Suit };
}

/** `SyncedList.forEach` 收集成普通数组，顺手丢掉形状不对的项（服务端不该发，发了也只是少显示一张） */
function readCards(list: SyncedList<SyncedCard> | undefined): Card[] {
  const cards: Card[] = [];
  if (list === undefined) return cards;
  list.forEach((raw) => {
    const card = readCard(raw);
    if (card !== null) cards.push(card);
  });
  return cards;
}

function readConfig(raw: SyncedRoomState['config']): TableViewConfig {
  return {
    smallBlind: readNumber(raw.smallBlind),
    bigBlind: readNumber(raw.bigBlind),
    startingChips: readNumber(raw.startingChips),
    maxPlayers: readNumber(raw.maxPlayers),
    actionTimeoutSec: readNumber(raw.actionTimeoutSec),
    minPlayersToStart: readNumber(raw.minPlayersToStart),
    felt: readFelt(raw.felt),
  };
}

function seatComparator(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * 由服务端提示决定亮哪些按钮。`currentTurn` 不是我的座位时一律不给动作，
 * 这不是「防作弊」（服务端会再判一次），是不让玩家点到下一步才会亮的按钮。
 */
function readPlayers(state: SyncedRoomState, myId: string, hostId: string | null): ConnectedPlayer[] {
  const players: ConnectedPlayer[] = [];
  state.players.forEach((slot, id) => {
    players.push({
      id,
      nickname: slot.nickname,
      avatarSeed: slot.avatarSeed,
      isSelf: id === myId,
      seatIndex: readSeat(slot.seatIndex),
      chips: readNumber(slot.chips),
      presence: readPresence(slot.presence),
      isHost: hostId !== null && id === hostId,
      legal: {
        canFold: slot.canFold === true,
        canCheck: slot.canCheck === true,
        callAmount: readNumber(slot.callAmount),
        canRaise: slot.canRaise === true,
        minRaiseTotal: readNumber(slot.minRaiseTotal),
        maxRaiseTotal: readNumber(slot.maxRaiseTotal),
        canAllIn: slot.canAllIn === true,
      },
    });
  });
  players.sort((a, b) => seatComparator(a.seatIndex, b.seatIndex) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return players;
}

function readHandPlayers(state: SyncedRoomState): HandPlayerView[] {
  const rows: HandPlayerView[] = [];
  state.handPlayers.forEach((hand, playerId) => {
    rows.push({
      playerId,
      seatIndex: hand.seatIndex,
      nickname: hand.nickname,
      avatarSeed: hand.avatarSeed,
      folded: hand.folded === true,
      allIn: hand.allIn === true,
      sittingOut: hand.sittingOut === true,
      hasActed: hand.hasActed === true,
      committedThisStreet: readNumber(hand.committedThisStreet),
      committedTotal: readNumber(hand.committedTotal),
    });
  });
  rows.sort((a, b) => a.seatIndex - b.seatIndex);
  return rows;
}

function readPots(state: SyncedRoomState): PotView[] {
  const pots: PotView[] = [];
  state.pots.forEach((pot) => {
    const eligible: number[] = [];
    pot.eligible.forEach((seat) => {
      eligible.push(readNumber(seat));
    });
    pots.push({ amount: readNumber(pot.amount), eligible });
  });
  return pots;
}

function readResults(state: SyncedRoomState): ResultView[] {
  const rows: ResultView[] = [];
  state.results.forEach((row) => {
    rows.push({
      playerId: row.playerId,
      seatIndex: row.seatIndex,
      chips: readNumber(row.chips),
      delta: readNumber(row.delta),
      handName: row.handName,
    });
  });
  rows.sort((a, b) => a.seatIndex - b.seatIndex);
  return rows;
}

export function buildSnapshot(
  state: SyncedRoomState | undefined,
  context: { readonly code: string; readonly myId: string; readonly privateView: PrivateView; readonly actionPending: boolean },
): RoomSnapshot {
  const { code, myId, privateView, actionPending } = context;
  if (!isStateReady(state)) {
    return {
      code,
      players: [],
      handPlayers: [],
      pots: [],
      results: [],
      board: [],
      awards: [],
      reveals: [],
      holeCards: null,
      timeoutWarning: null,
      actionPending: false,
      phase: 'IDLE',
      handId: '',
      handNo: 0,
      turnVersion: 0,
      hostId: null,
      myId,
      mySeat: null,
      isHost: false,
      isMyTurn: false,
      dealerSeat: null,
      sbSeat: null,
      bbSeat: null,
      currentTurn: null,
      deadline: null,
      nextHandAt: null,
      currentBet: 0,
      lastRaiseSize: 0,
      runOutBoard: false,
      potTotal: 0,
      introducedChips: 0,
      retainedChips: 0,
      config: EMPTY_CONFIG,
      clockOffsetMs: 0,
    };
  }
  const hostId = readId(state.hostId);
  const players = readPlayers(state, myId, hostId);
  const me = players.find((player) => player.isSelf);
  const mySeat = me?.seatIndex ?? null;
  const currentTurn = readSeat(state.currentTurn);
  return {
    code: state.joinCode.length > 0 ? state.joinCode : code,
    players,
    handPlayers: readHandPlayers(state),
    pots: readPots(state),
    results: readResults(state),
    board: readCards(state.board),
    awards: [...privateView.awards],
    reveals: [...privateView.reveals],
    holeCards: privateView.holeCards,
    timeoutWarning: privateView.timeoutWarning,
    actionPending,
    phase: readPhase(state.phase),
    handId: state.handId,
    handNo: readNumber(state.handNo),
    turnVersion: readNumber(state.turnVersion),
    hostId,
    myId,
    mySeat,
    isHost: hostId !== null && hostId === myId,
    isMyTurn: currentTurn !== null && currentTurn === mySeat,
    dealerSeat: readSeat(state.dealerSeat),
    sbSeat: readSeat(state.sbSeat),
    bbSeat: readSeat(state.bbSeat),
    currentTurn,
    deadline: readTime(state.deadline),
    nextHandAt: readTime(state.nextHandAt),
    currentBet: readNumber(state.currentBet),
    lastRaiseSize: readNumber(state.lastRaiseSize),
    runOutBoard: state.runOutBoard === true,
    potTotal: readNumber(state.potTotal),
    introducedChips: readNumber(state.introducedChips),
    retainedChips: readNumber(state.retainedChips),
    config: readConfig(state.config),
    // serverTime 是服务端发这个 patch 那一刻的时钟；本地时钟可能差几秒，
    // 所以倒计时只信这个差值，不信「我自己数了几秒」。
    clockOffsetMs: readNumber(state.serverTime) - Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 定向消息 / 广播事件的载荷校验
//
// 这些载荷是服务端 `client.send(...)` 出来的普通对象，不是 schema，
// 因此没有任何类型保证。这里逐个字段判形状，判不过就整条丢掉：
// 底牌宁可看不见，也不能把一条形状可疑的消息当成「我的牌」渲染出来。
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readPair(value: unknown): readonly [Card, Card] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const first = readCard(value[0] as SyncedCard);
  const second = readCard(value[1] as SyncedCard);
  return first !== null && second !== null ? [first, second] : null;
}

/**
 * `deal` 通道。手号的比对交给适配器做（它才知道「当前是哪一手」，
 * 而在收到第一个 patch 之前那个值还不存在），这里只管形状。
 */
export function readDeal(payload: unknown): { readonly handId: string; readonly cards: readonly [Card, Card] } | null {
  if (!isRecord(payload) || payload['t'] !== 'deal:holeCards') return null;
  const handId = readStringField(payload, 'handId');
  const cards = readPair(payload['cards']);
  return handId === null || cards === null ? null : { handId, cards };
}

/**
 * `showdown:reveal` 通道：亮牌只带座位号，身份由**本手冻结记录**解析。
 * 座位后来换人了也不能改写这条记录——否则新玩家会「继承」别人的底牌（D-014）。
 *
 * 手号的比对放在这里，不像 `deal` 那样交给适配器：`deal` 可能比第一个 patch 还早到，
 * 那时"当前是哪一手"还不存在，只能先收下再对账；而亮牌必须能读到 `state.handPlayers`
 * 才解析得出身份，状态没到就已经返回 null 了，所以这里可以严格要求手号对上。
 * 缺手号、手号对不上，一律按不合形状丢掉——迟到的上一手亮牌会贴到新一手的人身上。
 */
export function readReveal(payload: unknown, state: SyncedRoomState | undefined): RevealView | null {
  if (!isRecord(payload) || payload['t'] !== 'showdown:reveal') return null;
  const handId = readStringField(payload, 'handId');
  const seatIndex = readNumberField(payload, 'seatIndex');
  const cards = readPair(payload['cards']);
  if (handId === null || seatIndex === null || cards === null || state === undefined) return null;
  if (handId !== state.handId) return null;
  const owners: string[] = [];
  state.handPlayers.forEach((hand) => {
    if (hand.seatIndex === seatIndex) owners.push(hand.playerId);
  });
  const [playerId] = owners;
  return playerId === undefined ? null : { playerId, seatIndex, cards };
}

export function readTimeoutWarning(payload: unknown): number | null {
  if (!isRecord(payload) || payload['t'] !== 'timeoutWarning') return null;
  return readNumberField(payload, 'remainingSec');
}

/** 服务端错误码是 shared `ErrorCode` 的字符串，前端不枚举，原样交给 UI 显示中文消息 */
export function readError(payload: unknown): { readonly code: string; readonly message: string } | null {
  if (!isRecord(payload) || payload['t'] !== 'error') return null;
  const message = readStringField(payload, 'message');
  const code = readStringField(payload, 'code');
  return message === null || code === null ? null : { code, message };
}

/**
 * `pot:awarded` → 摊牌栏那一行。
 *
 * 输入是 `net/events.ts` 已经判过形状的事件，所以这里只做投影、不判空。
 * 以前这个函数自己从裸 JSON 里挑字段，和动画层那条校验各判各的——两份判定会长歪，
 * 而且「显示用的那条宽松、动画用的那条严格」这种差别没人会在半年后还记得。
 *
 * 顺带一提：丢掉一条不合形状的 `pot:awarded` 只是少了「哪个池、什么牌型」这一行装饰，
 * 谁赢了、赢多少在 schema 的 `results` 里另有一份（见 `readResults`），不会整个看不见。
 */
export function awardFromEvent(event: PotAwardedEvent): AwardView {
  return {
    potIndex: event.potIndex,
    winners: event.winners,
    amount: event.amount,
    handName: event.handName,
    bestFive: event.bestFive,
  };
}
