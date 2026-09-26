/**
 * 房间连接的 React 上下文 —— 前端**唯一**持有 `RoomConnection` 的地方。
 *
 * ## 连接放在 Provider 而不是页面里
 *
 * 因为路由会变：`/` → `/r/配对码` → `/t/配对码`。连接要是挂在页面上，
 * 每次切路由都会 leave + rejoin 一次，玩家会在自己的房间里反复「进出」，
 * 服务端那边座位状态跟着抖。放在包住整个 Router 的 Provider 上，
 * 页面切换就只是换个视图，连接不动。
 *
 * ## 三个必须防的重复 / 错乱触发
 *
 * 1. **React 19 StrictMode 在 dev 下会把 effect 跑两遍**（挂载 → 清理 → 再挂载）。
 *    等待室是「打开链接就自动进房」，靠 effect 触发，所以会被打两次。
 *    这里用 `pendingKeyRef` 做同步守卫：第二次进来发现同一个 key 正在连，直接返回。
 *    （ref 在 StrictMode 的两次 effect 之间是保留的，所以守卫有效。）
 * 2. **按钮连点**。`status === 'connecting'` 时按钮禁用，UI 层先挡一道；
 *    这里的守卫是第二道，防的是编程调用。
 * 3. **迟到的成功**。`joinRoom` 是个 promise，玩家在它飞着的这段时间里点了「离开」，
 *    或者改去了另一个房间。等它终于回来时，界面已经不属于它了——这时候 adopt
 *    会把玩家一脚踹回他刚离开的房间。`generationRef` 就是为此存在：
 *    每次要换连接就 +1，promise 回来时发现自己所在的世代已经不是最新的，
 *    就立刻把这条连接关掉（而不是留着占服务端那个 120 秒的重连座位）。
 *
 * ## 故意不在 unmount 时 leave
 *
 * 加了 unmount 清理的话，StrictMode 的模拟卸载会在 dev 下把刚建立的连接立刻拆掉。
 * 而这个 Provider 的寿命就是整个 App，真实卸载只发生在关标签页时——那时浏览器
 * 自己会关 WebSocket，服务端的 `onLeave` 照样触发。
 *
 * 所以「刷新页面」和「关标签页」是两条不同的路：刷新时 WebSocket 也会断，
 * 但重连凭证在**这个标签页的 sessionStorage** 里（见 `net/storage.ts`），
 * 重新挂载后 `joinRoom` 会先拿它去续上同一个座位。关掉标签页则连 sessionStorage
 * 一起没了，服务端 120 秒后按离开处理。不做 unmount 清理是这条续座路径成立的前提。
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import type { C2S } from '@poker-room/shared/view';

import { createGameClient } from '../net/client';
import { describeConnectionError, type ConnectionFailure } from '../net/errors';
import type {
  EventListener,
  GameClient,
  LinkState,
  Notice,
  PlayerProfile,
  RoomConnection,
  RoomSnapshot,
  Unsubscribe,
} from '../net/types';

export type RoomStatus = 'idle' | 'connecting' | 'connected' | 'error';

interface RoomState {
  readonly status: RoomStatus;
  readonly snapshot: RoomSnapshot | null;
  readonly failure: ConnectionFailure | null;
  /**
   * 连接是否还活着。`'reconnecting'` 是 SDK 自动重连的那约 56 秒窗口，
   * 期间状态快照是**过期的**——UI 必须把这件事说出来，理由见 `net/types.ts`。
   */
  readonly link: LinkState;
  /**
   * 服务端 / 适配器给玩家的话，主要是中文错误解释和「重连凭证过期」这类提醒。
   * 归属跟连接走：换新连接就清空，因为旧总线里的内容对新连接没有意义。
   */
  readonly notices: readonly Notice[];
}

const IDLE_STATE: RoomState = { status: 'idle', snapshot: null, failure: null, link: 'online', notices: [] };

/** `createRoom` 时配对码要等服务端分配，守卫用这个占位 key */
const CREATE_KEY = '\u0000create';

export interface RoomContextValue extends RoomState {
  /**
   * 创建房间。成功返回配对码，失败返回 null（原因在 `failure` 里）。
   *
   * 函数成员写成属性而不是方法签名，理由见 `net/types.ts`。
   */
  readonly createRoom: (profile: PlayerProfile) => Promise<string | null>;
  /**
   * 用配对码进房。
   * 返回 true 表示「已经在这条连接上了」或「正在连这个码」（StrictMode 重复触发就是后者）；
   * false 表示失败或什么都没做，原因在 `failure` 里。
   *
   * 已经在同一个房间但连接彻底断了（`link === 'offline'`）时会重试一次：
   * 这是「重连没成功，横幅让你回大厅」之后玩家按浏览器刷新能自动救回来的路径。
   */
  readonly joinRoom: (code: string, profile: PlayerProfile) => Promise<boolean>;
  /** 主动离开并回到 idle。UI 应当立刻响应，所以状态先改、`leave()` 后等 */
  readonly leaveRoom: () => Promise<void>;
  /**
   * 上送一条服务端命令。返回 `false` 表示没发出去（没连上、或者这一步还悬着）。
   * 合法性由服务端判定，这里只负责「发」和「如实告诉调用方发没发」。
   */
  readonly send: (command: C2S) => boolean;
  /**
   * 订阅服务端广播的动画事件（`SPEC.md` §2.3 那条 `'event'` 通道）。
   *
   * 这里只是把连接上的通道转述出来，**不缓存、不重放**：注册晚了就是错过了，
   * 补播一段上一手的发牌动画比什么都不播更糟。牌桌的动画导演用它，
   * 因为只有牌桌知道画面层在哪个 DOM 里。
   *
   * 订阅时机和连接时机**无关**：还没进房、正在换房、连接断了又续上，订阅者都不用重写，
   * 因为事件走的是 Provider 里的总线（见 `eventBusRef`）。
   */
  readonly onEvent: (listener: EventListener) => Unsubscribe;
  /** 关掉错误横幅。连接状态不变，玩家可以原地重试 */
  readonly dismissFailure: () => void;
  /** 关掉一条提示 */
  readonly dismissNotice: (id: number) => void;
}

const RoomContext = createContext<RoomContextValue | null>(null);

/**
 * 默认 client 懒加载。
 *
 * 不能在模块顶层 `createGameClient()`：它会读 `window.location` 和
 * `import.meta.env`，在模块求值阶段做这件事会让「导入即依赖浏览器环境」，
 * 单测里想换实现也没有插入点。
 */
let sharedClient: GameClient | null = null;

function getSharedClient(): GameClient {
  sharedClient ??= createGameClient();
  return sharedClient;
}

/** 测试之间重置默认 client，否则上一个测试注入的假 client 会漏到下一个 */
export function resetSharedClient(): void {
  sharedClient = null;
}

export interface RoomProviderProps {
  readonly children: ReactNode;
  /** 注入点。不传就用真的 Colyseus client */
  readonly client?: GameClient;
}

export function RoomProvider({ children, client }: RoomProviderProps): ReactNode {
  const [state, setState] = useState<RoomState>(IDLE_STATE);
  const connectionRef = useRef<RoomConnection | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const teardownRef = useRef<Unsubscribe[]>([]);
  /** 每次「换一条连接」递增，用来作废还在飞的旧连接（见文件头第 3 条） */
  const generationRef = useRef(0);
  /**
   * `link` 的镜像。
   *
   * `joinRoom` 要按当前连接状态决定「续用还是重试」，但把 `state.link` 放进它的
   * 依赖数组会让 `joinRoom` 的身份每变一次状态就换一次，页面里那个自动进房 effect
   * 于是跟着重跑。用 ref 读，`joinRoom` 就能保持稳定引用。
   */
  const linkRef = useRef<LinkState>('online');
  /**
   * 事件转发总线（动画的输入）。
   *
   * 为什么不是「让订阅方自己去摸连接」：牌桌页的自动进房 effect 要等一个 promise 才有
   * 连接，而动画导演在**同一个 commit** 里就完成订阅了。如果 `onEvent` 直接读
   * `connectionRef.current`，导演拿到的是一个空退订，此后一段动画都不会播——
   * 而且单测很难抓到，因为「先连后订阅」的测试写起来照样绿。
   *
   * 总线归 Provider 而不是归连接：订阅方的寿命跟着组件走，连接的寿命跟着进房/离开走，
   * 两者不同步，中间这一层就是用来吸收这个不同步的。每换一条连接，`adopt` 会把总线
   * 接到新连接上，旧的随 `dispose()` 一起清掉。
   *
   * 这里**不缓存历史**：重连后补播上一手的发牌动画是最糟糕的失败模式，
   * 「不存」是这条保证唯一不需要额外代码的写法。
   */
  const eventBusRef = useRef<Set<EventListener>>(new Set());

  const teardown = useCallback(() => {
    for (const unsubscribe of teardownRef.current) unsubscribe();
    teardownRef.current = [];
  }, []);

  /** 注入的 client 优先；没有才用进程内共享的那个真 client */
  const resolveClient = useCallback((): GameClient => client ?? getSharedClient(), [client]);

  const pushNotice = useCallback((notice: Notice) => {
    // 按 id 去重：`onNotice` 注册时会重放已有提示，同一连接上也可能重放两次
    //（StrictMode 双挂载），不去重就会在屏幕上看到重复的一行。
    setState((current) =>
      current.notices.some((existing) => existing.id === notice.id)
        ? current
        : { ...current, notices: [...current.notices, notice] },
    );
  }, []);

  const adopt = useCallback(
    (connection: RoomConnection) => {
      teardown();
      connectionRef.current = connection;
      teardownRef.current = [
        // subscribe 会立刻同步推一次当前快照，所以这里一注册 UI 就有内容了。
        // 用函数式更新**保留** link 和 notices：重连成功后 SDK 会补推一次全量状态，
        // 那时 link 已被 onLinkChange 置成 'online'，不该被快照回调改写；
        // 反过来，掉线期间若还有缓冲的补丁到达，也不能把 'reconnecting' 冲掉。
        connection.subscribe((snapshot) => {
          setState((current) => ({ ...current, status: 'connected', snapshot, failure: null }));
        }),
        connection.onLinkChange((link) => {
          linkRef.current = link;
          setState((current) => ({ ...current, link }));
        }),
        connection.onNotice(pushNotice),
        // 总线接到这条新连接上。断开由 `dispose()` 收，这里入 `teardownRef` 是双保险：
        // 换连接时旧的那条即使还没走 dispose 流程，也不会再往界面上送事件。
        connection.onEvent((event) => {
          for (const listener of [...eventBusRef.current]) listener(event);
        }),
      ];
    },
    [pushNotice, teardown],
  );

  const beginConnect = useCallback(
    async (key: string, start: () => Promise<RoomConnection>): Promise<RoomConnection | 'duplicate' | null> => {
      if (pendingKeyRef.current === key) return 'duplicate';
      pendingKeyRef.current = key;
      const generation = ++generationRef.current;
      linkRef.current = 'online';
      setState({ ...IDLE_STATE, status: 'connecting' });
      try {
        const connection = await start();
        if (generationRef.current !== generation) {
          // 这条连接回来得太晚了：玩家已经离开或者换去了别的房间。
          // 不 adopt，也不留着——服务端会按 consented 立刻释放座位。
          void connection.leave().catch(() => undefined);
          return null;
        }
        adopt(connection);
        return connection;
      } catch (error) {
        setState({ ...IDLE_STATE, status: 'error', failure: describeConnectionError(error) });
        return null;
      } finally {
        pendingKeyRef.current = null;
      }
    },
    [adopt],
  );

  const leaveCurrent = useCallback(async () => {
    // 先作废所有在飞的连接，再拆当前这条：顺序反了的话，
    // 在飞的那条会在我们拆完之后把状态改回 connected。
    generationRef.current += 1;
    const existing = connectionRef.current;
    connectionRef.current = null;
    linkRef.current = 'online';
    teardown();
    if (existing !== null) await existing.leave();
  }, [teardown]);

  const createRoom = useCallback(
    async (profile: PlayerProfile): Promise<string | null> => {
      // 已经在建一个房间了：不要打断它去建第二个，按失败返回，让 UI 保持现状。
      if (pendingKeyRef.current === CREATE_KEY) return null;
      await leaveCurrent();
      const outcome = await beginConnect(CREATE_KEY, () => resolveClient().createRoom(profile));
      // 'duplicate' 在正常情况下到不了：创建按钮在 connecting 期间是禁用的。
      // 真到了也返回 null，调用方按失败处理，不会导航到一个错的房间。
      return outcome !== null && outcome !== 'duplicate' ? outcome.code : null;
    },
    [beginConnect, leaveCurrent, resolveClient],
  );

  const joinRoom = useCallback(
    async (code: string, profile: PlayerProfile): Promise<boolean> => {
      if (pendingKeyRef.current === code) return true;
      const existing = connectionRef.current;
      // 已经在这张桌上了。SDK 还在自动重连（`reconnecting`）时不要抢它的活——
      // 重连凭证在它手里，我们另起一条连接反而会把这个座位丢掉。
      // 只有确定断死了（`offline`）才重建，凭证由适配器负责先试后降级。
      if (existing !== null && existing.code === code && linkRef.current !== 'offline') return true;
      await leaveCurrent();
      const outcome = await beginConnect(code, () => resolveClient().joinRoom(code, profile));
      return outcome !== null;
    },
    [beginConnect, leaveCurrent, resolveClient],
  );

  const leaveRoom = useCallback(async () => {
    // 先改状态再等 leave()：玩家点「离开」应该立刻看到界面变化，
    // 而不是等服务端往返一圈（断网时那个往返可能永远不会回来）。
    setState(IDLE_STATE);
    await leaveCurrent();
  }, [leaveCurrent]);

  const send = useCallback((command: C2S): boolean => {
    const existing = connectionRef.current;
    return existing === null ? false : existing.send(command);
  }, []);

  const onEvent = useCallback((listener: EventListener): Unsubscribe => {
    // 读写都落在总线上，不碰 `connectionRef`：订阅发生在挂载时，连接什么时候到、
    // 换过几条，都不该影响「有没有在听」（理由见 `eventBusRef`）。
    eventBusRef.current.add(listener);
    return (): void => {
      eventBusRef.current.delete(listener);
    };
  }, []);

  const dismissFailure = useCallback(() => {
    setState((current) => (current.failure === null ? current : { ...current, failure: null }));
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setState((current) => {
      const notices = current.notices.filter((notice) => notice.id !== id);
      return notices.length === current.notices.length ? current : { ...current, notices };
    });
  }, []);

  const value = useMemo<RoomContextValue>(
    () => ({
      ...state,
      createRoom,
      joinRoom,
      leaveRoom,
      send,
      onEvent,
      dismissFailure,
      dismissNotice,
    }),
    [state, createRoom, joinRoom, leaveRoom, send, onEvent, dismissFailure, dismissNotice],
  );

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

/** 取房间状态。Provider 外面调用直接抛错，理由同 `useProfile` */
export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext);
  if (value === null) {
    throw new Error('useRoom 必须在 <RoomProvider> 内部使用');
  }
  return value;
}
