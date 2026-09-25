/**
 * 测试用的假 `GameClient`。
 *
 * 存在的全部理由：M0.4 的验收项里有好几条讲的是**连接失败时要怎样**
 * （服务端没起、房间不存在、房间已满）。这些路径用真服务端要么造不出来
 * （满房要拉 8 个连接），要么造出来也很脆（时序）。把 `GameClient`
 * 换成假的之后，「reject 一个 522」就是一行代码。
 *
 * 它**刻意不模拟** Colyseus 的 schema / 增量同步：那部分由 `packages/server`
 * 的集成测试负责。这里只模拟「拿到一份快照、之后还会推新快照、有时会掉线」。
 */

import type {
  ConnectedPlayer,
  GameClient,
  LinkListener,
  LinkState,
  PlayerProfile,
  RoomConnection,
  RoomListener,
  RoomSnapshot,
  Unsubscribe,
} from '../src/net/types';

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
  /** 模拟 SDK 的 `onDrop`：连接断了，SDK 随即开始自动重连 */
  readonly dropConnection: () => void;
  /** 模拟 SDK 的 `onReconnect`：重连成功，状态会继续推过来 */
  readonly restoreConnection: () => void;
  /**
   * 模拟 SDK 的 `onLeave`（非自愿）。真 SDK 有两条路走到这里：
   * 重连 15 次全部失败，或者进房还不到 `minUptime`（5 秒）就直接放弃重连。
   * 对我们的代码而言两者没有区别，所以只留一个方法。
   */
  readonly failReconnection: () => void;
  readonly leaveCount: () => number;
  readonly snapshot: () => RoomSnapshot;
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

/** 造一个玩家条目。`isSelf` 由调用方决定，因为假 client 不知道「谁是我」 */
export function fakePlayer(sessionId: string, nickname: string, isSelf = false): ConnectedPlayer {
  return { sessionId, nickname, avatarSeed: `seed-${sessionId}`, isSelf };
}

export function createFakeRoom(code: string, initial: readonly ConnectedPlayer[] = []): FakeRoomHandle {
  let players: readonly ConnectedPlayer[] = initial;
  let leaves = 0;
  const roomListeners = new Set<RoomListener>();
  const linkListeners = new Set<LinkListener>();

  const snapshot = (): RoomSnapshot => ({ code, players });

  const emitLink = (link: LinkState): void => {
    for (const listener of linkListeners) listener(link);
  };

  const connection: RoomConnection = {
    code,
    mySessionId: 'self',
    snapshot,
    subscribe: (listener: RoomListener): Unsubscribe => {
      roomListeners.add(listener);
      // 和真实现一样：注册时立刻同步推一次，组件不必区分「首次」与「后续」
      listener(snapshot());
      return (): void => {
        roomListeners.delete(listener);
      };
    },
    onLinkChange: (listener: LinkListener): Unsubscribe => {
      linkListeners.add(listener);
      // 真实现也是无条件推一次 'online'（它假定「刚连上」）。
      // 这里照抄，而不是「更聪明地」推当前状态：假实现比真实现更正确，
      // 同样会把 bug 藏起来。
      listener('online');
      return (): void => {
        linkListeners.delete(listener);
      };
    },
    leave: async (): Promise<void> => {
      leaves += 1;
      roomListeners.clear();
      linkListeners.clear();
    },
  };

  return {
    code,
    connection,
    snapshot,
    leaveCount: (): number => leaves,
    pushPlayers: (next: readonly ConnectedPlayer[]): void => {
      players = next;
      const pushed = snapshot();
      for (const listener of roomListeners) listener(pushed);
    },
    dropConnection: (): void => {
      emitLink('reconnecting');
    },
    restoreConnection: (): void => {
      emitLink('online');
    },
    failReconnection: (): void => {
      emitLink('offline');
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
    const me: ConnectedPlayer = {
      sessionId: `session-${others.length + 1}`,
      nickname: profile.nickname,
      avatarSeed: profile.avatarSeed,
      isSelf: true,
    };
    room.pushPlayers([...others, me]);
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
