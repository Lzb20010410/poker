/**
 * 测试用的假 `GameClient`。
 *
 * 存在的全部理由：M0.4 的验收项里有好几条讲的是**连接失败时要怎样**
 * （服务端没起、房间不存在、房间已满）。这些路径用真服务端要么造不出来
 * （满房要拉 8 个连接），要么造出来也很脆（时序）。把 `GameClient`
 * 换成假的之后，「reject 一个 522」就是一行代码。
 *
 * 它**刻意不模拟** Colyseus 的 schema / 增量同步：那部分由 `packages/server`
 * 的集成测试和 `test/adapter.test.ts` 负责。这里只模拟「拿到一份快照、
 * 之后还会推新快照、有时会掉线、发出去的操作要被记下来」。
 *
 * ## 一条底线：假实现不许比真实现更正确
 *
 * M0 那版 `onLinkChange` 无条件推 `'online'`，因为当时真实现就是那样（有 bug）。
 * M1.6 把真适配器改成「注册时推**当前**状态」，这里就跟着改。
 * 假实现替真实现「补上」没做的事，测试就会绿在一个不存在的行为上。
 */

import { DEFAULT_TABLE_CONFIG, type C2S } from '@poker-room/shared';

import { readBroadcastEvent } from '../src/net/events';
import type {
  ConnectedPlayer,
  EventListener,
  GameClient,
  LegalActionsView,
  LinkListener,
  LinkState,
  Notice,
  NoticeListener,
  PlayerProfile,
  RoomConnection,
  RoomListener,
  RoomSnapshot,
  Unsubscribe,
} from '../src/net/types';
import { awardFromEvent } from '../src/net/view';

/** 一个玩家什么都做不了。默认用它，测试想要亮按钮就自己覆盖 */
export const NO_LEGAL: LegalActionsView = {
  canFold: false,
  canCheck: false,
  callAmount: 0,
  canRaise: false,
  minRaiseTotal: 0,
  maxRaiseTotal: 0,
  canAllIn: false,
};

/** 轮到我、且什么动作都能做的提示位。用来测操作面板的按钮全亮 */
export const FULL_LEGAL: LegalActionsView = {
  canFold: true,
  canCheck: false,
  callAmount: 20,
  canRaise: true,
  minRaiseTotal: 40,
  maxRaiseTotal: 2000,
  canAllIn: true,
};

export function fakePlayer(
  id: string,
  nickname: string,
  isSelf = false,
  extras: Partial<Omit<ConnectedPlayer, 'id' | 'nickname' | 'isSelf'>> = {},
): ConnectedPlayer {
  return {
    id,
    nickname,
    avatarSeed: `seed-${id}`,
    isSelf,
    seatIndex: null,
    chips: DEFAULT_TABLE_CONFIG.startingChips,
    presence: 'online',
    isHost: false,
    legal: NO_LEGAL,
    ...extras,
  };
}

/**
 * 一份「刚建好、还没开局」的完整快照。
 *
 * 之所以要把每个字段都填上：`RoomSnapshot` 的字段是必填的，组件里就可以直接
 * `snapshot.config.maxPlayers` 而不写一堆 `??`。假数据要是缺字段，
 * 测出来的就是组件的容错路径，不是它的正常路径。
 */
export function fakeSnapshot(code: string, overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
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
    hostId: 'self',
    myId: 'self',
    mySeat: null,
    isHost: true,
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
    config: { ...DEFAULT_TABLE_CONFIG },
    clockOffsetMs: 0,
    ...overrides,
  };
}

/**
 * 假服务端里的一间房。句柄上的方法用来从测试里「推动」它。
 *
 * 三个连接方法的命名**刻意对齐 SDK 的信号名**，而不是笼统地叫「掉线」。
 * 原因写在下面 `createFakeRoom` 里：上一版假 client 把「掉线」直接映射成
 * `onLeave`，而真 SDK 掉线时先发的是 `onDrop`，`onLeave` 要等重连耗尽才来——
 * 于是测试全绿、真浏览器里却整整 56 秒没有任何提示。假实现必须模拟
 * **真的那套时序**，否则它保护的只是一个不存在的行为。
 */
export interface FakeRoomHandle {
  readonly code: string;
  readonly connection: RoomConnection;
  /** 覆盖式地换掉玩家列表，并推给所有订阅者（模拟一次 schema patch） */
  readonly pushPlayers: (players: readonly ConnectedPlayer[]) => void;
  /** 改快照的一部分并推给所有订阅者（模拟服务端又同步了一次状态） */
  readonly patch: (changes: Partial<RoomSnapshot>) => void;
  /** 模拟 SDK 的 `onDrop`：连接断了，SDK 随即开始自动重连 */
  readonly dropConnection: () => void;
  /** 模拟 SDK 的 `onReconnect` 之后拿到新状态：链接回 `online` 并补推一次快照 */
  readonly restoreConnection: () => void;
  /**
   * 模拟 SDK 的 `onLeave`（非自愿）。真 SDK 有两条路走到这里：
   * 重连 15 次全部失败，或者进房还不到 `minUptime`（5 秒）就直接放弃重连。
   * 对我们的代码而言两者没有区别，所以只留一个方法。
   */
  readonly failReconnection: () => void;
  /** 模拟服务端的一条定向提示（`error` / 重连凭证过期这类） */
  readonly pushNotice: (kind: Notice['kind'], message: string) => void;
  /**
   * 模拟服务端的一次广播事件（动画的输入）。
   *
   * 走的是和真适配器一样的两步：先过 `readBroadcastEvent` 判形状，再分给「摊牌栏」和
   * 「事件订阅者」。所以测试里喂一条不合形状的事件，效果和浏览器里收到它一样——什么都不发生。
   */
  readonly pushEvent: (event: unknown) => void;
  readonly leaveCount: () => number;
  readonly snapshot: () => RoomSnapshot;
  /** 这条连接上成功发出去的命令，按顺序 */
  readonly sent: readonly C2S[];
  /** 被拒的发送（断线或双击）次数 */
  readonly refused: () => number;
}

/** 假 client 本体，除了 `client` 之外都是给断言用的记录 */
export interface FakeClientHandle {
  readonly client: GameClient;
  readonly rooms: ReadonlyMap<string, FakeRoomHandle>;
  /** `createRoom` 收到的 profile，按调用顺序 */
  readonly created: readonly PlayerProfile[];
  /** `joinRoom` 收到的 (code, profile)，按调用顺序 */
  readonly joined: readonly { code: string; profile: PlayerProfile }[];
  readonly joinCallsFor: (code: string) => number;
  readonly createCalls: () => number;
}

export interface FakeClientOptions {
  /** `createRoom` 依次分配的配对码。用完就报错——测试里应该显式写清要几张桌子 */
  readonly createCodes?: readonly string[];
  /** `createRoom` 要失败时放这里（例如模拟服务端没起） */
  readonly createFailure?: Error;
  /** 指定的配对码在 `joinRoom` 时 reject */
  readonly joinFailures?: ReadonlyMap<string, Error>;
  /** 所有 `joinRoom` 都 reject（模拟服务端整个挂了） */
  readonly joinFailure?: Error;
}

/**
 * 长得像 SDK `MatchMakeError` 的错误。
 *
 * 用真的 Error 子类而不是普通对象，有两个理由：
 * 1. `only-throw-error` 不允许 `throw` 一个非 Error，而假 client 的全部意义就是
 *    「按测试给的东西 reject」；
 * 2. `describeConnectionError` 本来就是**结构化**判定（看 name / code / message，
 *    不做 `instanceof`），所以只要这三个字段对，行为就和真 SDK 抛出来的完全一致。
 *
 * `code` 刻意是 `unknown`：实测服务端没起时它是字符串 `"ECONNREFUSED"`，
 * 尽管 SDK 的 `.d.ts` 写的是 `number`。
 */
export class FakeMatchMakeError extends Error {
  readonly code: unknown;

  constructor(code: unknown, message: string) {
    super(message);
    this.name = 'MatchMakeError';
    this.code = code;
  }
}

export function createFakeRoom(code: string, initial: readonly ConnectedPlayer[] = []): FakeRoomHandle {
  let base = fakeSnapshot(code, { players: initial });
  let link: LinkState = 'online';
  let leaves = 0;
  let refused = 0;
  let noticeId = 0;
  /** 我这一步发出去了、还没被新状态确认。真适配器用 `${handId}:${turnVersion}` 记，这里照做 */
  let pendingKey: string | null = null;
  const roomListeners = new Set<RoomListener>();
  const linkListeners = new Set<LinkListener>();
  const noticeListeners = new Set<NoticeListener>();
  const eventListeners = new Set<EventListener>();
  const sent: C2S[] = [];

  const emitSnapshot = (): void => {
    const pushed = base;
    for (const listener of roomListeners) listener(pushed);
  };

  const emitLink = (next: LinkState): void => {
    link = next;
    for (const listener of linkListeners) listener(next);
  };

  const applyPatch = (changes: Partial<RoomSnapshot>): void => {
    base = { ...base, ...changes };
    const key = `${base.handId}:${base.turnVersion}`;
    // 和真适配器同一条规则（见 `net/client.ts` 的 `onStateChange`）：
    // 服务端认了这一步有两种表现——这一步本身变了，或者它已经不在等我了
    //（回合移走 / 一手直接结束，此时 `turnVersion` 可能永远不再变）。
    if (pendingKey !== null && (pendingKey !== key || !base.isMyTurn)) pendingKey = null;
    // `actionPending` 是派生字段，和真适配器一样由「有没有悬着的动作」决定
    base = { ...base, actionPending: pendingKey !== null };
    emitSnapshot();
  };

  const connection: RoomConnection = {
    code,
    mySessionId: 'self',
    snapshot: () => base,
    subscribe: (listener: RoomListener): Unsubscribe => {
      roomListeners.add(listener);
      // 和真实现一样：注册时立刻同步推一次，组件不必区分「首次」与「后续」
      listener(base);
      return (): void => {
        roomListeners.delete(listener);
      };
    },
    onLinkChange: (listener: LinkListener): Unsubscribe => {
      linkListeners.add(listener);
      // 推**当前**状态，和 M1.6 的真适配器一致。掉线期间晚挂载的组件
      // 必须一上来就知道现在是 'reconnecting'，否则它会亮着按钮等一个发不出去的动作。
      listener(link);
      return (): void => {
        linkListeners.delete(listener);
      };
    },
    onNotice: (listener: NoticeListener): Unsubscribe => {
      noticeListeners.add(listener);
      return (): void => {
        noticeListeners.delete(listener);
      };
    },
    onEvent: (listener: EventListener): Unsubscribe => {
      // 和真适配器一样**不重放**：重放等于把已经播过的动画再排一遍队。
      eventListeners.add(listener);
      return (): void => {
        eventListeners.delete(listener);
      };
    },
    send: (command: C2S): boolean => {
      // 断线期间一律不发（真适配器把 SDK 的队列缓冲也关了）。
      if (link !== 'online') {
        refused += 1;
        return false;
      }
      if (command.t === 'action') {
        // 和真适配器一致：只要上一步还没被新状态或错误确认，**任何**动作都不放行，
        // 而不是只挡同一个 key —— 双击常见于连点两个不同按钮。
        if (pendingKey !== null) {
          refused += 1;
          return false;
        }
        pendingKey = `${command.handId}:${command.turnVersion}`;
        sent.push(command);
        // 推一份快照，让界面立刻看到 actionPending 变成 true
        applyPatch({});
        return true;
      }
      sent.push(command);
      return true;
    },
    leave: async (): Promise<void> => {
      leaves += 1;
      roomListeners.clear();
      linkListeners.clear();
      noticeListeners.clear();
      eventListeners.clear();
    },
  };

  return {
    code,
    connection,
    snapshot: () => base,
    sent,
    leaveCount: (): number => leaves,
    refused: (): number => refused,
    pushPlayers: (players: readonly ConnectedPlayer[]): void => {
      applyPatch({ players });
    },
    patch: applyPatch,
    dropConnection: (): void => {
      pendingKey = null;
      emitLink('reconnecting');
    },
    restoreConnection: (): void => {
      emitLink('online');
      // 重连后服务端会推一份全量状态：走和 patch 同一条路，
      // 于是「这一步已被新状态确认」的解锁规则也一起生效。
      applyPatch({});
    },
    failReconnection: (): void => {
      pendingKey = null;
      emitLink('offline');
    },
    pushNotice: (kind: Notice['kind'], message: string): void => {
      noticeId += 1;
      const notice: Notice = { id: noticeId, kind, message };
      for (const listener of noticeListeners) listener(notice);
    },
    pushEvent: (event: unknown): void => {
      // 和 `net/client.ts` 的 `onEvent` 同一套两步：判形状 → `pot:awarded` 进快照 → 转发。
      // 少一步都会让假连接比真连接更宽松，测试就绿在一个不存在的行为上。
      const valid = readBroadcastEvent(event);
      if (valid === null) return;
      if (valid.t === 'pot:awarded') applyPatch({ awards: [...base.awards, awardFromEvent(valid)] });
      for (const listener of [...eventListeners]) listener(valid);
    },
  };
}

export function createFakeClient(options: FakeClientOptions = {}): FakeClientHandle {
  const rooms = new Map<string, FakeRoomHandle>();
  const created: PlayerProfile[] = [];
  const joined: { code: string; profile: PlayerProfile }[] = [];
  const createCodes = [...(options.createCodes ?? [])];

  const ensureRoom = (code: string): FakeRoomHandle => {
    const existing = rooms.get(code);
    if (existing !== undefined) return existing;
    const room = createFakeRoom(code);
    rooms.set(code, room);
    return room;
  };

  /**
   * 把进房的人塞进玩家列表。
   *
   * 顺手把已有玩家的 `isSelf` 全清掉：一个浏览器标签页里只有一个人是「我」，
   * 而同一间假房可能被多个 profile 进过（测试里模拟 A 和 B）。
   */
  const seat = (room: FakeRoomHandle, profile: PlayerProfile): void => {
    const others = room.snapshot().players.map((player) => ({ ...player, isSelf: false }));
    const seatIndex = others.length;
    const me: ConnectedPlayer = fakePlayer(`session-${seatIndex + 1}`, profile.nickname, true, {
      avatarSeed: profile.avatarSeed,
      seatIndex,
    });
    // 服务端会把新入座的座位号一并写进快照，`mySeat` 不是前端自己猜的
    room.patch({ players: [...others, me], mySeat: seatIndex });
  };

  const client: GameClient = {
    createRoom: async (profile: PlayerProfile): Promise<RoomConnection> => {
      created.push(profile);
      if (options.createFailure !== undefined) throw options.createFailure;
      const code = createCodes.shift();
      if (code === undefined) throw new Error('FakeClient 的 createCodes 用完了');
      const room = ensureRoom(code);
      seat(room, profile);
      return room.connection;
    },
    joinRoom: async (code: string, profile: PlayerProfile): Promise<RoomConnection> => {
      joined.push({ code, profile });
      if (options.joinFailure !== undefined) throw options.joinFailure;
      const failure = options.joinFailures?.get(code);
      if (failure !== undefined) throw failure;
      const room = ensureRoom(code);
      seat(room, profile);
      return room.connection;
    },
  };

  return {
    client,
    rooms,
    created,
    joined,
    joinCallsFor: (code: string): number => joined.filter((entry) => entry.code === code).length,
    createCalls: (): number => created.length,
  };
}
