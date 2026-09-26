import type { PlayerProfile, PlayerResult, PrivateMessage, S2C_Broadcast } from '../protocol';
import { FELT_VALUES } from '../types';
import type { Card, Phase, PlayerHandState, Pot, TableConfig } from '../types';
import type { BettingState } from './betting';
import { RuleError } from './errors';

/**
 * 必须「正安全整数」的那几项。`felt` 不在这里——它是唯一一个字符串配置项，
 * 单独走枚举判定（见 `validateConfig`）。
 *
 * 分成两份名单是因为上面那条「未知配置项」要按**全量**名单判：
 * 少写一项就会把合法的字段当成非法拒掉，多写一项又会放非法字段进来。
 */
const NUMERIC_CONFIG_KEYS = [
  'smallBlind',
  'bigBlind',
  'startingChips',
  'maxPlayers',
  'actionTimeoutSec',
  'minPlayersToStart',
] as const;

export interface TableContext {
  readonly now: number;
  readonly rand: () => number;
}
export interface InitialTablePlayer extends PlayerProfile {
  readonly seatIndex: number | null;
  /** 可信 bootstrap；客户端 join 不能提供筹码。 */
  readonly chips?: number;
}
export interface TableAccount extends PlayerProfile {
  readonly seatIndex: number | null;
  readonly chips: number;
  readonly presence: 'online' | 'reconnecting' | 'left';
}
export type TableParticipant = Omit<PlayerHandState, 'chips'> & { readonly playerId: string };
export interface TableState {
  readonly config: TableConfig;
  readonly accounts: readonly TableAccount[];
  readonly participants: readonly TableParticipant[];
  readonly hostId: string | null;
  readonly introducedChips: number;
  readonly handNo: number;
  readonly handId: string;
  readonly dealerSeat: number | null;
  readonly sbSeat: number | null;
  readonly bbSeat: number | null;
  readonly phase: Phase;
  readonly currentBet: number;
  readonly lastRaiseSize: number;
  readonly currentTurn: number | null;
  readonly turnVersion: number;
  readonly deadline: number | null;
  readonly nextHandAt: number | null;
  readonly deck: readonly Card[];
  readonly burned: readonly Card[];
  readonly board: readonly Card[];
  readonly pots: readonly Pot[];
  readonly results: readonly PlayerResult[];
  readonly runOutBoard: boolean;
}
export interface TableUpdate {
  readonly newState: TableState;
  readonly events: readonly S2C_Broadcast[];
  readonly privateMessages: readonly PrivateMessage[];
  /** 本次进入的阶段；瞬时阶段不另造网络事件。 */
  readonly phases: readonly Phase[];
}

export function assertChips(chips: number): void {
  if (!Number.isSafeInteger(chips) || chips < 0)
    throw new RuleError('INVALID_ACTION', '筹码必须是非负安全整数');
}
export function assertSeat(seat: number, config: TableConfig): void {
  if (!Number.isInteger(seat) || seat < 0 || seat >= config.maxPlayers)
    throw new RuleError('NOT_SEATED', '座位超出牌桌范围');
}
export function validateConfig(input: unknown): TableConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new RuleError('INVALID_ACTION', '配置必须是对象');
  const keys: readonly string[] = [...NUMERIC_CONFIG_KEYS, 'felt'];
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key)))
    throw new RuleError('INVALID_ACTION', '未知配置项');
  for (const key of NUMERIC_CONFIG_KEYS) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
      throw new RuleError('INVALID_ACTION', '配置项必须是正安全整数');
  }
  // 上述逐字段检查已验证全部数值字段；下面检查领域约束。
  const config = input as TableConfig;
  // `felt` 是唯一一个字符串字段，所以它不进上面那个「正整数」循环，单独按枚举判。
  // 用 `FELT_VALUES` 而不是手写两个字符串：名单与类型同源（见 `types.ts`）。
  if (!FELT_VALUES.includes(config.felt)) throw new RuleError('INVALID_ACTION', '桌布只能是绿呢或蓝呢');
  // `bigBlind === 2 × smallBlind` 是**故意收窄**，不是漏写了非 2 倍盲注的支持：
  // RULES-SPEC §5.5 把它写成默认值注释，但实现里它是硬约束，因为最小加注增量以 BB 为锚
  // （§3.4 `lastRaiseSize` 初值 = BB），非 2 倍盲注会连带改变翻牌前的加注语义，那是另一次决策。
  // 前端 `HostPanel` 同步把大盲显示成只读派生值，所以这条约束对用户不可见、也不可能被误碰。
  if (
    config.bigBlind !== 2 * config.smallBlind ||
    config.maxPlayers < 2 ||
    config.maxPlayers > 8 ||
    config.minPlayersToStart !== 2 ||
    config.actionTimeoutSec > 300
  )
    throw new RuleError('INVALID_ACTION', '配置超出允许范围');
  return { ...config };
}
export function getAccount(state: TableState, id: string): TableAccount {
  const account = state.accounts.find((p) => p.id === id && p.presence !== 'left');
  if (!account) throw new RuleError('NOT_SEATED', '玩家不在房间');
  return account;
}
export function requireOnline(account: TableAccount): void {
  if (account.presence !== 'online') throw new RuleError('INVALID_ACTION', '离线玩家不能操作');
}
export function requireHost(state: TableState, id: string): void {
  const account = getAccount(state, id);
  requireOnline(account);
  if (state.hostId !== id) throw new RuleError('NOT_HOST', '仅房主可以操作');
}
export function chooseHost(state: TableState): TableState {
  // 「还占着座位的人」才是候选，`reconnecting` 也算：
  // 浏览器刷一次页面只会让 presence 短暂变成 'reconnecting'，
  // 那一刻把王冠交出去，等于「谁碰上房主刷新谁夺权」——
  // 拿到房主的人就能改配置、开牌局，而真正建房的人回来发现自己说了不算了。
  // 只有真正离桌（座位被收回）才让位，让位顺序：先给还在线的，再按座位号。
  const candidates = state.accounts
    .filter((p) => p.presence !== 'left' && p.seatIndex !== null)
    .sort(
      (a, b) =>
        Number(b.presence === 'online') - Number(a.presence === 'online') ||
        a.seatIndex! - b.seatIndex!,
    );
  return {
    ...state,
    hostId: candidates.find((p) => p.id === state.hostId)?.id ?? candidates[0]?.id ?? null,
  };
}
export function activeAccounts(state: TableState): readonly TableAccount[] {
  return state.accounts
    .filter((p) => p.presence === 'online' && p.seatIndex !== null && p.chips > 0)
    .sort((a, b) => a.seatIndex! - b.seatIndex!);
}
export function update(
  state: TableState,
  events: readonly S2C_Broadcast[] = [],
  privateMessages: readonly PrivateMessage[] = [],
  phases: readonly Phase[] = [],
): TableUpdate {
  const total =
    state.accounts.reduce((sum, p) => sum + p.chips, 0) +
    state.participants.reduce((sum, p) => sum + p.committedTotal, 0);
  if (total !== state.introducedChips) throw new Error('牌桌筹码不守恒');
  return { newState: state, events, privateMessages, phases };
}

export function toBetting(state: TableState): BettingState {
  return {
    phase: state.phase,
    currentBet: state.currentBet,
    lastRaiseSize: state.lastRaiseSize,
    currentTurn: state.currentTurn,
    players: state.participants.map((p) => ({
      ...p,
      // 参与者只在开手时由 accounts 创建；账号永久保留，不以可复用座位查余额。
      chips: state.accounts.find((a) => a.id === p.playerId)!.chips,
    })),
  };
}
export function fromBetting(state: TableState, betting: BettingState): TableState {
  const participants = state.participants.map((p) => {
    // betting 保持参与者集合不变。
    const { chips: _chips, ...hand } = betting.players.find(
      (entry) => entry.seatIndex === p.seatIndex,
    )!;
    return { ...hand, playerId: p.playerId };
  });
  return {
    ...state,
    participants,
    currentBet: betting.currentBet,
    lastRaiseSize: betting.lastRaiseSize,
    currentTurn: betting.currentTurn,
    accounts: state.accounts.map((a) => {
      const participant = state.participants.find((p) => p.playerId === a.id);
      return participant
        ? { ...a, chips: betting.players.find((p) => p.seatIndex === participant.seatIndex)!.chips }
        : a;
    }),
  };
}

export function createTable(
  config: TableConfig,
  players: readonly InitialTablePlayer[],
): TableState {
  const validated = validateConfig(config);
  if (players.length > validated.maxPlayers) throw new RuleError('ROOM_FULL', '房间已满');
  const ids = new Set<string>();
  const seats = new Set<number>();
  let introducedChips = 0;
  const accounts = players.map((p): TableAccount => {
    if (ids.has(p.id)) throw new RuleError('INVALID_ACTION', '玩家 id 不能重复');
    ids.add(p.id);
    if (p.seatIndex !== null) {
      assertSeat(p.seatIndex, validated);
      if (seats.has(p.seatIndex)) throw new RuleError('INVALID_ACTION', '座位不能重复');
      seats.add(p.seatIndex);
    }
    const chips = p.chips ?? validated.startingChips;
    assertChips(chips);
    introducedChips += chips;
    assertChips(introducedChips);
    return {
      id: p.id,
      nickname: p.nickname,
      avatarSeed: p.avatarSeed,
      seatIndex: p.seatIndex,
      chips,
      presence: 'online',
    };
  });
  return chooseHost({
    config: validated,
    accounts,
    participants: [],
    hostId: null,
    introducedChips,
    handNo: 0,
    handId: '',
    dealerSeat: null,
    sbSeat: null,
    bbSeat: null,
    phase: 'IDLE',
    currentBet: 0,
    lastRaiseSize: validated.bigBlind,
    currentTurn: null,
    turnVersion: 0,
    deadline: null,
    nextHandAt: null,
    deck: [],
    burned: [],
    board: [],
    pots: [],
    results: [],
    runOutBoard: false,
  });
}
