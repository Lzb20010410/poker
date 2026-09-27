/**
 * Colyseus 客户端封装 —— 整个前端**唯一**认识 `@colyseus/sdk` 的地方。
 *
 * 为什么要包一层，而不是让组件直接 `new Client(...)`：
 *
 * 1. SDK 的 `Room` 类型带三个泛型参数、内部大量 `any`，直接往组件里传会把
 *    `any` 传染到整个 UI 层。这里用一组最小的结构化接口（`net/sdkTypes.ts`）
 *    把它挡住，全仓库只有 `asRoomLike` 一处断言。
 * 2. schema 实例是 Colyseus 动态生成的对象。`net/view.ts` 把它翻译成普通只读
 *    快照（`RoomSnapshot`），组件拿到的是纯数据，可以直接 memo、直接断言。
 * 3. 测试可以塞一个假的 `GameClient` 进来，不起服务端跑完整个大厅 + 牌桌流程。
 *
 * ## 三条时序事实（全部实测，见 DECISIONS.md D-012 / D-016）
 *
 * - `sdk.create()` / `joinById()` 的 promise 在收到**第一个状态补丁之前**就
 *   resolve 了。所以连上之后必须等一次初始状态，`net/client.ts` 里的
 *   `waitForInitialState` 就是干这个的（`@colyseus/testing` 的同名方法是
 *   monkey-patch，生产 bundle 里没有）。
 * - `onReconnect` 触发时，`reconnectionToken` **还没换成新值**，新状态也还没推。
 *   所以「重连成功」不等于「可以操作」：必须等重连后的第一个 patch，才把
 *   凭证落盘、把界面重新点亮。
 * - SDK 在断线期间会把 `send` 的消息攒在队列里，重连后一次性吐出去。
 *   牌桌上这是灾难：玩家掉线前点的那一下会在几十秒后变成一个过期动作。
 *   所以 `maxEnqueuedMessages = 0`，并且我们自己只在 `link === 'online'` 时发。
 */

import { Client, type ColyseusSDK } from '@colyseus/sdk';
import type { C2S } from '@poker-room/shared/view';

import { readBroadcastEvent } from './events';
import { ConnectionTimeoutError, describeConnectionError } from './errors';
import { currentServerUrl } from './serverUrl';
import { clearToken, readToken, saveToken, tokenKey, type RawTokenStorage } from './storage';
import type { SdkRoomLike, SyncedRoomState } from './sdkTypes';
import type {
  EventListener, GameClient, LinkListener, LinkState, Notice, NoticeListener, PlayerProfile,
  RoomConnection, RoomListener, RoomSnapshot, Unsubscribe,
} from './types';
import {
  buildSnapshot, emptyPrivate, isStateReady, awardFromEvent, readDeal, readError,
  readReveal, readTimeoutWarning, type PrivateView,
} from './view';

/** 房间类型名，和服务端 `defineServer('poker', ...)` 一致 */
export const ROOM_TYPE_POKER = 'poker';

/** 等第一个状态快照的上限。局域网/本机远小于这个数，超时基本等于服务端有问题 */
export const INITIAL_STATE_TIMEOUT_MS = 10_000;

/** 服务端 `onCommand` 只认这个通道名（M1.5，见 D-016） */
const COMMAND_CHANNEL = 'command';

/** 提示最多留几条：玩家不看历史，只看得懂「刚刚发生了什么」 */
const NOTICE_LIMIT = 5;

/**
 * 连续掉到第几次才劝玩家刷新。
 *
 * 一次掉线 SDK 自己会重试约 56 秒（见 `types.ts` 的 `LinkState`），所以「连着三次」
 * 意味着三段重试窗口全白等 —— 这时候继续盯着这张不动的牌桌没有意义，
 * 刷新才会重新走一遍 `joinRoom`：sessionStorage 里的凭证还在，座位能续上。
 */
const DROP_STREAK_HINT = 3;

export interface GameClientOptions {
  /**
   * 重连凭证的存放处。默认用 `sessionStorage`（按标签页隔离，
   * 两个标签页开同一个码不会互相抢身份）。
   * 传 `null` 表示完全不存，测试里传内存实现。
   */
  readonly storage?: RawTokenStorage | null;
}

/** 唯一的 SDK → 结构化镜像断言点。`Room<any, any>` 与镜像没有直接重叠，所以要经 `unknown` */
function asRoomLike(room: unknown): SdkRoomLike {
  return room as SdkRoomLike;
}

/**
 * 凭证无效 / 过期。真 SDK 抛的是 `MatchMakeError`，我们用**结构化**判定
 * （看 name + message，不做 instanceof），理由和测试替身 `FakeMatchMakeError` 一样。
 *
 * 只有这一类错误才允许「清掉凭证、当新玩家重新加入」。网络故障（`TypeError: Failed to fetch`）
 * 绝对不能走到那一步：那会悄悄把玩家变成房里的新人，原来的座位和底牌都没了。
 */
function isExpiredReconnectionToken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const shape = error as { name?: unknown; message?: unknown };
  if (shape.name !== 'MatchMakeError' || typeof shape.message !== 'string') return false;
  return /reconnection token|token (invalid|expired)/i.test(shape.message);
}

/**
 * 这条凭证还有没有救。`null` = 还有救（暂时性故障，必须留着）；否则给出换身份时该说的原因。
 *
 * `room-not-found` 也算"没救"是 M4.1 实测出来的：服务端重启或房间解散之后，
 * `reconnect` 抛的是 `code === 522` + `room "X" has been disposed.`，**和凭证过期是两种错**，
 * 但结果一样——那个 `roomId:token` 指向的对象已经不在这个进程里了，再试一百次也不会回来。
 * 不清掉的话，玩家刷新永远卡在同一条错误上（配对码会被回收复用，这条死凭证还会挡住新房间）。
 *
 * 满员**故意不算**在这里：它和房间消失共用 522，只有 message 里的 `is locked` 分得开，
 * 判错方向的代价不对称——把满员当成分散会让玩家以为坐进去了，其实是换身份挤进了别的桌。
 */
function deadTokenReason(error: unknown): 'expired' | 'gone' | null {
  if (isExpiredReconnectionToken(error)) return 'expired';
  return describeConnectionError(error).kind === 'room-not-found' ? 'gone' : null;
}

/** 换身份这件事必须说出来：玩家看到的是"我的座位没了"，得知道是谁把他换掉的 */
const DEAD_TOKEN_NOTICES: Record<'expired' | 'gone', string> = {
  expired: '之前的重连凭证已过期，我用新身份重新加入了这个房间。',
  gone: '这个房间已经不存在了（服务端重启或牌局已解散），我用新身份重新加入了这个配对码。',
};

// ---------------------------------------------------------------------------
// 提示（notice）
// ---------------------------------------------------------------------------

interface NoticeBus {
  readonly push: (kind: Notice['kind'], message: string) => void;
  /** 直接作为 `RoomConnection.onNotice` 暴露出去 */
  readonly connection: (listener: NoticeListener) => Unsubscribe;
}

function createNoticeBus(): NoticeBus {
  const notices: Notice[] = [];
  const listeners = new Set<NoticeListener>();
  let nextId = 1;
  return {
    push: (kind, message) => {
      const notice: Notice = { id: nextId, kind, message };
      nextId += 1;
      notices.push(notice);
      if (notices.length > NOTICE_LIMIT) notices.shift();
      for (const listener of [...listeners]) listener(notice);
    },
    connection: (listener) => {
      listeners.add(listener);
      // 注册时重放已有提示：StrictMode 会把 effect 跑两遍，第一遍订阅、第二遍取消，
      // 不重放的话「凭证过期」这类一次性提醒会被吞掉。
      for (const notice of notices) listener(notice);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 一条连接的内部状态
// ---------------------------------------------------------------------------

interface ConnectionHandle {
  readonly connection: RoomConnection;
  /** 建连失败时的清理：摘掉所有监听，不关 socket（关不关由调用方决定） */
  readonly dispose: () => void;
  /** 初始状态到手：落盘凭证、补一次 ping、把界面点亮 */
  readonly markOnline: () => void;
}

/**
 * 把 SDK 房间包成 `RoomConnection`。
 *
 * 监听器**在这里就全部挂上**，不等初始状态。原因：底牌和错误是定向消息，
 * 服务端可能在第一个 patch 之前就发出去了；晚挂一步，玩家就会看到一张
 * 「没有我的底牌」的牌桌，而且再也补不回来。
 */
function toConnection(
  room: SdkRoomLike,
  code: string,
  store: RawTokenStorage | null,
  notices: NoticeBus,
  key: string,
): ConnectionHandle {
  const privateView: PrivateView = emptyPrivate();
  const snapshotListeners = new Set<RoomListener>();
  const linkListeners = new Set<LinkListener>();
  const eventListeners = new Set<EventListener>();
  const detach: Unsubscribe[] = [];

  let link: LinkState = 'online';
  let consented = false;
  let disposed = false;
  /** 重连成功但新状态还没到：这段时间仍然不能发送（服务端那边可能已经换人了） */
  let awaitingFreshState = false;
  /** 已发出、还没被新状态或错误确认的动作，键是 `handId:turnVersion` */
  let pendingKey: string | null = null;
  /** 底牌属于哪一手。当前手不知道时（还没收到 patch）先收下，事后对不上再丢 */
  let holeHandId: string | null = null;
  let seenHandId = '';
  /** 这条连接上连着掉了几次。真接回去过一次就归零，见 `DROP_STREAK_HINT` */
  let dropStreak = 0;

  const snapshot = (): RoomSnapshot =>
    buildSnapshot(room.state, { code, myId: room.sessionId, privateView, actionPending: pendingKey !== null });

  const notifySnapshot = (): void => {
    const next = snapshot();
    for (const listener of [...snapshotListeners]) listener(next);
  };
  const notifyLink = (): void => {
    for (const listener of [...linkListeners]) listener(link);
  };
  /**
   * 广播事件**只发给订阅者**，不碰快照。
   *
   * 这不是省事，是必须这样：快照是「现在是什么样」，事件是「刚才发生了什么」。
   * 事件一旦进了快照，任何一次重渲染都可能把它再播一遍（React 不知道它被消费过没有）。
   * 只有 `pot:awarded` 例外——摊牌那一栏要长期显示「谁赢了哪个池」，那份是**结果**，
   * 播过之后留在快照里是对的。
   */
  const notifyEvent = (event: Parameters<EventListener>[0]): void => {
    for (const listener of [...eventListeners]) listener(event);
  };

  const persistToken = (): void => {
    saveToken(store, key, room.reconnectionToken);
  };

  const sendPing = (): void => {
    room.send(COMMAND_CHANNEL, { t: 'ping' });
  };

  /**
   * 当前是哪一手。`state` 还没到时返回 null，表示「无从判断」。
   * 定向消息带手号的一律要过这一关，迟到的上一手底牌不能贴到新的一手上。
   */
  const currentHandId = (): string | null => {
    const state: SyncedRoomState | undefined = room.state;
    return isStateReady(state) ? state.handId : null;
  };

  const onStateChange = (): void => {
    if (disposed) return;
    const state: SyncedRoomState | undefined = room.state;
    if (isStateReady(state)) {
      // 新的一手：上一手的私密信息一律作废，不然会「带着底牌进下一手」。
      // `seenHandId === ''` 是这次连接看到的第一个状态，不算「换了一手」——
      // 定向底牌比 patch 早到时（见 `onDeal` 的注释）不能把它顺手清掉。
      if (seenHandId !== '' && seenHandId !== state.handId) {
        Object.assign(privateView, emptyPrivate());
        holeHandId = null;
        pendingKey = null;
      }
      seenHandId = state.handId;
      if (holeHandId !== null && holeHandId !== state.handId) {
        privateView.holeCards = null;
        holeHandId = null;
      }
      if (pendingKey !== null && (pendingKey !== `${state.handId}:${state.turnVersion}` || !snapshot().isMyTurn)) {
        // 解锁有两种情形：① 这一步已经不是当初那一步了（换手或换行动轮次）；
        // ② 服务端已经不再等我了（回合移走、或者一手直接结束）。
        // 第 ② 种是浏览器实测出来的：全下之后服务端一口气跑完公共牌进结算，
        // `turnVersion` 从此不再变化，只按 ① 判定的话，这把锁会一直挂到下一手开始，
        // 玩家在「等待开局」的界面上看到「上一步已经发出去了，等服务端确认」——
        // 而那一步其实早就被接受了。
        pendingKey = null;
      }
    }
    if (awaitingFreshState) {
      // onReconnect 到这里的间隔里 token 已经换新、状态已经推全，此时才允许操作。
      awaitingFreshState = false;
      dropStreak = 0;
      if (link === 'reconnecting') {
        link = 'online';
        notifyLink();
      }
      persistToken();
      sendPing();
    }
    notifySnapshot();
  };
  const onDrop = (): void => {
    if (disposed) return;
    link = 'reconnecting';
    pendingKey = null;
    dropStreak += 1;
    if (dropStreak === DROP_STREAK_HINT) {
      notices.push('info', `这条连接已经连着断了 ${DROP_STREAK_HINT} 次，自动重连多半救不回来了。刷新这一页通常能续上原来的座位。`);
    }
    notifyLink();
  };
  const onReconnect = (): void => {
    if (disposed) return;
    awaitingFreshState = true;
  };
  const onLeave = (): void => {
    if (disposed || consented) return;
    // 凭证不清：重连耗尽不等于「你不许再进来」，玩家还能凭配对码重新加入。
    link = 'offline';
    pendingKey = null;
    notifyLink();
  };

  detach.push(
    () => {
      room.onStateChange.remove(onStateChange);
    },
    () => {
      room.onDrop.remove(onDrop);
    },
    () => {
      room.onReconnect.remove(onReconnect);
    },
    () => {
      room.onLeave.remove(onLeave);
    },
  );
  room.onStateChange(onStateChange);
  room.onDrop(onDrop);
  room.onReconnect(onReconnect);
  room.onLeave(onLeave);

  const onDeal = (payload: unknown): void => {
    const deal = readDeal(payload);
    if (deal === null) return;
    const expected = currentHandId();
    // 状态还没到手时先收下：定向消息可能比第一个 patch 更早到。
    // 等 patch 到了再由 onStateChange 对账，对不上就丢。
    if (expected !== null && deal.handId !== expected) return;
    privateView.holeCards = deal.cards;
    holeHandId = deal.handId;
    notifySnapshot();
  };
  const onReveal = (payload: unknown): void => {
    const reveal = readReveal(payload, room.state);
    if (reveal === null) return;
    privateView.reveals = [...privateView.reveals.filter((row) => row.playerId !== reveal.playerId), reveal];
    notifySnapshot();
  };
  const onWarning = (payload: unknown): void => {
    const seconds = readTimeoutWarning(payload);
    if (seconds === null) return;
    privateView.timeoutWarning = seconds;
    notifySnapshot();
  };
  const onError = (payload: unknown): void => {
    const failure = readError(payload);
    if (failure === null) return;
    // 服务端拒绝了这个动作，界面必须立刻重新可点：玩家看到的是「我的按钮没反应」，
    // 不解锁的话他会再点一次，而这一次可能打在下一手上。
    pendingKey = null;
    notices.push('error', failure.message);
    notifySnapshot();
  };
  /**
   * `'event'` 通道：服务端每次状态迁移广播的那一串动画事件（`SPEC.md` §2.3）。
   *
   * 先过 `readBroadcastEvent` 再分头用，是因为这一条通道上**两个消费者要的确定性不一样**：
   * 快照里的摊牌栏只要「合形状就能显示」，动画队列却要拿它当位置信息用
   *（`board:deal` 的张数决定飞几枚牌、落在哪一格）。所以过一次、只把合形状的放过去，
   * 两个消费者看到的都是同一个已经收窄的对象，而不是各判各的。
   */
  const onEvent = (payload: unknown): void => {
    const event = readBroadcastEvent(payload);
    if (event === null) return;
    if (event.t === 'pot:awarded') {
      privateView.awards = [...privateView.awards, awardFromEvent(event)];
      notifySnapshot();
    }
    notifyEvent(event);
  };
  const channels: readonly [string, (payload: unknown) => void][] = [
    ['deal', onDeal],
    ['showdown:reveal', onReveal],
    ['timeoutWarning', onWarning],
    ['error', onError],
    ['event', onEvent],
  ];
  for (const [channel, handler] of channels) {
    detach.push(room.onMessage<unknown>(channel, handler));
  }

  const canSend = (): boolean =>
    !disposed && link === 'online' && room.connection.isOpen && !room.reconnection.isReconnecting;

  const connection: RoomConnection = {
    code,
    mySessionId: room.sessionId,
    snapshot,
    subscribe: (listener) => {
      snapshotListeners.add(listener);
      // 和真实现一样：注册时立刻同步推一次，组件不必区分「首次」和「后续」
      listener(snapshot());
      return () => {
        snapshotListeners.delete(listener);
      };
    },
    onLinkChange: (listener) => {
      linkListeners.add(listener);
      // 推**当前值**而不是无条件推 'online'：掉线期间晚挂载的组件
      // 要是被告知「连着」，它就会把按钮点亮，玩家点了没反应。
      listener(link);
      return () => {
        linkListeners.delete(listener);
      };
    },
    onNotice: notices.connection,
    onEvent: (listener) => {
      // 注册时**不**重放：事件是「刚才发生了什么」，重放一遍就是把发牌动画再播一次。
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    send: (command: C2S): boolean => {
      if (!canSend()) return false;
      if (command.t === 'action') {
        const state: SyncedRoomState | undefined = room.state;
        if (!isStateReady(state)) return false;
        if (pendingKey !== null) return false;
        pendingKey = `${command.handId}:${command.turnVersion}`;
        // 立刻推一份快照：`actionPending` 变成了 true，界面才能在同一帧把按钮按下去。
        // 不推的话就只有内部锁生效，玩家看到的是「点了没反应」，会去点第二下。
        notifySnapshot();
      }
      room.send(COMMAND_CHANNEL, command);
      return true;
    },
    leave: async (): Promise<void> => {
      consented = true;
      dispose();
      clearToken(store, key);
      await room.leave(true);
    },
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of detach) unsubscribe();
    detach.length = 0;
    snapshotListeners.clear();
    linkListeners.clear();
    eventListeners.clear();
  }

  return {
    connection,
    dispose,
    markOnline: () => {
      link = 'online';
      persistToken();
      sendPing();
      notifySnapshot();
    },
  };
}

/**
 * 等第一个状态补丁。
 *
 * 三个出口都必须清干净：`dispose` 由调用方负责摘业务监听，这里只摘自己这两个。
 * 用长期订阅而不是 `.once`，是因为「第一个 patch 里 joinCode 还是空」在服务端
 * 分配 roomId 之前是可能发生的（`onCreate` 里 `allocatePairingCode` 是异步的），
 * `.once` 会把它当成成功然后永久失去这个信号。
 */
function waitForInitialState(room: SdkRoomLike, timeoutMs: number = INITIAL_STATE_TIMEOUT_MS): Promise<void> {
  if (isStateReady(room.state)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room.onStateChange.remove(onState);
      room.onLeave.remove(onClose);
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new ConnectionTimeoutError('等待房间初始状态', timeoutMs));
      });
    }, timeoutMs);
    const onState = (): void => {
      if (isStateReady(room.state)) finish(resolve);
    };
    const onClose = (): void => {
      finish(() => {
        reject(new Error('房间在发出第一个状态之前就关闭了'));
      });
    };
    room.onStateChange(onState);
    room.onLeave(onClose);
  });
}

/** 连接建立失败时把这条连接彻底关掉：不能再让 SDK 拿着一个没绑定的凭证去重连 */
function abandon(room: SdkRoomLike): void {
  room.reconnection.enabled = false;
  room.connection.close();
}

export function createGameClient(
  serverUrl: string = currentServerUrl(),
  options: GameClientOptions = {},
): GameClient {
  const sdk: ColyseusSDK = new Client(serverUrl);
  const store = 'storage' in options ? options.storage ?? null : readBrowserStorage();

  const keyOf = (code: string): string => tokenKey(serverUrl, code);

  async function establish(join: () => Promise<unknown>, codeHint: string | null, notices: NoticeBus): Promise<RoomConnection> {
    const room = asRoomLike(await join());
    const code = codeHint ?? room.roomId;
    // 断线期间的消息一律不攒（见文件头），刚进房就掉线也要能重连（minUptime 默认 5000）。
    room.reconnection.maxEnqueuedMessages = 0;
    room.reconnection.minUptime = 0;
    const handle = toConnection(room, code, store, notices, tokenKey(serverUrl, code));
    try {
      await waitForInitialState(room);
    } catch (error) {
      handle.dispose();
      abandon(room);
      throw error;
    }
    handle.markOnline();
    return handle.connection;
  }

  return {
    createRoom(profile: PlayerProfile): Promise<RoomConnection> {
      // 创建永远走全新房间：存着的旧凭证跟这个新码无关，用它只会把两个房间搅在一起。
      return establish(() => sdk.create(ROOM_TYPE_POKER, { ...profile }), null, createNoticeBus());
    },
    async joinRoom(code: string, profile: PlayerProfile): Promise<RoomConnection> {
      const notices = createNoticeBus();
      const key = keyOf(code);
      const token = readToken(store, key);
      if (token !== null) {
        try {
          return await establish(() => sdk.reconnect(token), code, notices);
        } catch (error) {
          const reason = deadTokenReason(error);
          if (reason === null) {
            // 暂时性故障：凭证留着，界面按失败处理，玩家重试的还是同一个身份。
            throw error;
          }
          clearToken(store, key);
          notices.push('info', DEAD_TOKEN_NOTICES[reason]);
        }
      }
      return establish(() => sdk.joinById(code, { ...profile }), code, notices);
    },
  };
}

/** 默认凭证仓库：`sessionStorage` 在部分隐私模式下会抛，那种情况下就没有持久化，不影响游玩 */
function readBrowserStorage(): RawTokenStorage | null {
  try {
    const area = globalThis.sessionStorage;
    return area === undefined ? null : {
      getItem: (k) => area.getItem(k),
      setItem: (k, v) => {
        area.setItem(k, v);
      },
      removeItem: (k) => {
        area.removeItem(k);
      },
    };
  } catch {
    return null;
  }
}
