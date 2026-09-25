/**
 * Colyseus 客户端封装 —— 整个前端**唯一**认识 `@colyseus/sdk` 的地方。
 *
 * 为什么要包一层，而不是让组件直接 `new Client(...)`：
 *
 * 1. SDK 的 `Room` 类型带三个泛型参数、内部大量 `any`，直接往组件里传会把
 *    `any` 传染到整个 UI 层。这里用一组最小的结构化接口（`SdkRoomLike`）
 *    把它挡住，全仓库只有下面两处 `as unknown as SdkRoomLike` 的断言。
 * 2. schema 实例是 Colyseus 动态生成的对象。这里把它翻译成普通的只读快照
 *    （`RoomSnapshot`），组件拿到的是纯数据，可以直接 memo、直接断言。
 * 3. 测试可以塞一个假的 `GameClient` 进来，不起服务端跑完整个大厅流程。
 *
 * ## `waitForInitialState` 是本地实现的
 *
 * `@colyseus/testing` 给 SDK 的 Room 打了个 `waitForInitialState()` 补丁，
 * 服务端集成测试里能用；但它是 **monkey-patch，只存在于 testing 包**
 * （`@colyseus/testing/build/Room.ext.mjs`），生产 bundle 里没有这个方法。
 * 所以这里照它的实现自己写一份，并额外加了超时——原版没有超时，
 * 服务端不发状态就会永久挂住。
 *
 * 顺带一个必须知道的事实：`sdk.create()` / `joinById()` 的 promise
 * 在收到**第一个状态补丁之前**就 resolve 了（实测）。直接读 `room.state`
 * 会拿到空对象，所以每次连上都要先等一次。
 */

import { Client, type ColyseusSDK } from '@colyseus/sdk';

import { ConnectionTimeoutError } from './errors';
import { currentServerUrl } from './serverUrl';
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
} from './types';

/**
 * 房间类型名。服务端 `packages/server/src/index.ts` 里的 `ROOM_TYPE_POKER` 是同一个值。
 *
 * 现在两边各写一份是有意的：web 不许 import server（SPEC §1.2），而这个常量目前
 * 还没有别的伴生内容。等 M1.5 落地 C/S 消息协议时，它会连同消息类型一起搬进
 * `shared/src/protocol.ts`，那时就有真正值得测的东西了。
 */
export const ROOM_TYPE_POKER = 'poker';

/** 等第一个状态快照的上限。局域网/本机远小于这个数，超时基本等于服务端有问题 */
export const INITIAL_STATE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// SDK 形状的最小结构化描述（只在断言处使用，不外泄）
// ---------------------------------------------------------------------------

/** schema 里 `PlayerSlot` 的镜像。字段名必须和 `server/src/schema/PokerRoomState.ts` 一致 */
interface SyncedPlayerSlot {
  readonly nickname: string;
  readonly avatarSeed: string;
}

/** `t.map(PlayerSlot)` 的镜像。只声明我们用到的 `forEach`，语义与 `Map.forEach` 相同 */
interface SyncedPlayers {
  forEach(callback: (value: SyncedPlayerSlot, key: string) => void): void;
}

interface SyncedRoomState {
  readonly joinCode: string;
  readonly players: SyncedPlayers;
}

type StateListener = (state: SyncedRoomState) => void;
/** WebSocket 关闭时的回调形状，`onDrop` 与 `onLeave` 共用 */
type CloseListener = (code: number, reason?: string) => void;
type ReconnectListener = () => void;

/**
 * Colyseus 的信号对象：本身可调用（长期订阅），同时带 `once` / `remove`。
 * 见 `@colyseus/sdk/build/Room.d.ts` 里 `onStateChange` 的交叉类型。
 */
interface SdkSignal<Callback> {
  (callback: Callback): unknown;
  once(callback: Callback): void;
  remove(callback: Callback): void;
}

interface SdkRoomLike {
  roomId: string;
  sessionId: string;
  state: SyncedRoomState | undefined;
  onStateChange: SdkSignal<StateListener>;
  onLeave: SdkSignal<CloseListener>;
  /**
   * 连接掉下去的**第一时间**触发，之后 SDK 才开始指数退避重连。
   * 与 `onLeave` 的分工见 `types.ts` 里 `LinkState` 的注释。
   */
  onDrop: SdkSignal<CloseListener>;
  /** 重连成功时触发（`reconnection.isReconnecting` 已被 SDK 置回 false） */
  onReconnect: SdkSignal<ReconnectListener>;
  leave(consented?: boolean): Promise<number>;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/**
 * 把 schema 翻译成快照。
 *
 * 玩家顺序按 sessionId 升序排：`MapSchema` 的迭代顺序取决于补丁到达顺序，
 * 各端理论上一致，但排序之后是**确定**一致。M1 会换成服务端的 seatIndex，
 * 那才是真正的座位顺序；现在这么做只是为了列表不会跳。
 */
function readSnapshot(room: SdkRoomLike): RoomSnapshot {
  const state = room.state;
  // state 可能还没有：join 成功后连接立刻被关掉（房间刚 dispose）就会走到这里。
  // 返回一个空快照而不是抛错——UI 显示「0 人」比崩掉好。
  if (state === undefined || state.players === undefined) {
    return { code: room.roomId, players: [] };
  }

  const players: ConnectedPlayer[] = [];
  state.players.forEach((slot, sessionId) => {
    players.push({
      sessionId,
      nickname: slot.nickname,
      avatarSeed: slot.avatarSeed,
      isSelf: sessionId === room.sessionId,
    });
  });
  players.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));

  return { code: state.joinCode.length > 0 ? state.joinCode : room.roomId, players };
}

/**
 * 等第一个状态快照。
 *
 * `onLeave` 也要监听：房间在发出状态之前就关闭（例如刚创建就 dispose）时，
 * 只等 `onStateChange` 会一直挂到超时，玩家白等 10 秒。
 *
 * 两个 `once` 处理器不做移除：promise 一旦 settle，后到的那次调用是 no-op，
 * 而 `.once` 本身会自动摘掉自己。省掉移除逻辑就不用依赖 `remove` 对
 * once-处理器是否生效这种实现细节。
 */
function waitForInitialState(room: SdkRoomLike, timeoutMs: number = INITIAL_STATE_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ConnectionTimeoutError('等待房间初始状态', timeoutMs));
    }, timeoutMs);
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    room.onStateChange.once(settle);
    room.onLeave.once(settle);
  });
}

function toConnection(room: SdkRoomLike): RoomConnection {
  const listeners = new Set<RoomListener>();
  const linkListeners = new Set<LinkListener>();
  let consented = false;

  /**
   * 统一的连接状态出口。`consented` 挡在这里而不是每个 handler 里：
   * 玩家自己点「离开」之后，SDK 仍会走一遍 onclose → onDrop/onLeave，
   * 那是我们主动断的，不该在 UI 上变成一条红色警告。
   */
  const emitLink = (link: LinkState): void => {
    if (consented) return;
    for (const listener of linkListeners) listener(link);
  };

  const onState: StateListener = () => {
    const snapshot = readSnapshot(room);
    for (const listener of listeners) listener(snapshot);
  };
  room.onStateChange(onState);

  // 三个信号都用长期订阅而不是 `.once`：一次连接的生命周期里
  // 「掉线 → 重连上 → 又掉线」是可能反复发生的（手机切网络尤其常见），
  // 只监听一次会让第二次掉线彻底静默。
  room.onDrop(() => {
    emitLink('reconnecting');
  });
  room.onReconnect(() => {
    emitLink('online');
  });
  // close code 刻意丢掉：UI 对「重连失败」和「房间被解散」说的话是同一句
  //（见 StatusBanner 的 offline 分支），区分它们只会多一个没人消费的字段。
  room.onLeave(() => {
    emitLink('offline');
  });

  return {
    code: room.roomId,
    mySessionId: room.sessionId,
    snapshot: () => readSnapshot(room),
    subscribe(listener: RoomListener): Unsubscribe {
      listeners.add(listener);
      // 立刻推一次：组件不必区分首次与后续，也不用干等下一个补丁才有内容可渲染
      listener(readSnapshot(room));
      return () => {
        listeners.delete(listener);
      };
    },
    onLinkChange(listener: LinkListener): Unsubscribe {
      linkListeners.add(listener);
      // 同 subscribe 的口径：注册即推一次当前值（刚连上，必然是 online）
      listener('online');
      return () => {
        linkListeners.delete(listener);
      };
    },
    async leave(): Promise<void> {
      consented = true;
      listeners.clear();
      linkListeners.clear();
      await room.leave(true);
    },
  };
}

/** 连一次房间：join → 等初始状态 → 包成 RoomConnection。create 与 joinById 共用 */
async function connect(join: () => Promise<unknown>): Promise<RoomConnection> {
  const room = (await join()) as SdkRoomLike;
  await waitForInitialState(room);
  return toConnection(room);
}

export function createGameClient(serverUrl: string = currentServerUrl()): GameClient {
  const sdk: ColyseusSDK = new Client(serverUrl);

  return {
    createRoom(profile: PlayerProfile): Promise<RoomConnection> {
      return connect(() => sdk.create(ROOM_TYPE_POKER, { ...profile }));
    },
    joinRoom(code: string, profile: PlayerProfile): Promise<RoomConnection> {
      return connect(() => sdk.joinById(code, { ...profile }));
    },
  };
}
