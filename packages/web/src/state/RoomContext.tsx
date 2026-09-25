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
 * ## 两个必须防的重复触发
 *
 * 1. **React 19 StrictMode 在 dev 下会把 effect 跑两遍**（挂载 → 清理 → 再挂载）。
 *    等待室是「打开链接就自动进房」，靠 effect 触发，所以会被打两次。
 *    这里用 `pendingKeyRef` 做同步守卫：第二次进来发现同一个 key 正在连，直接返回。
 *    （ref 在 StrictMode 的两次 effect 之间是保留的，所以守卫有效。）
 * 2. **按钮连点**。`status === 'connecting'` 时按钮禁用，UI 层先挡一道；
 *    这里的守卫是第二道，防的是编程调用。
 *
 * ## 故意不在 unmount 时 leave
 *
 * 加了 unmount 清理的话，StrictMode 的模拟卸载会在 dev 下把刚建立的连接立刻拆掉。
 * 而这个 Provider 的寿命就是整个 App，真实卸载只发生在关标签页时——那时浏览器
 * 自己会关 WebSocket，服务端的 `onLeave` 照样触发。所以不做这层清理是安全的。
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import { createGameClient } from '../net/client';
import { describeConnectionError, type ConnectionFailure } from '../net/errors';
import type {
  GameClient,
  LinkState,
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
}

const IDLE_STATE: RoomState = { status: 'idle', snapshot: null, failure: null, link: 'online' };

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
   * 返回 true 表示「已经连上了」或「正在连这个码」（StrictMode 重复触发就是后者）；
   * false 表示失败或什么都没做，原因在 `failure` 里。
   */
  readonly joinRoom: (code: string, profile: PlayerProfile) => Promise<boolean>;
  /** 主动离开并回到 idle。UI 应当立刻响应，所以状态先改、`leave()` 后等 */
  readonly leaveRoom: () => Promise<void>;
  /** 关掉错误横幅。连接状态不变，玩家可以原地重试 */
  readonly dismissFailure: () => void;
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

  const teardown = useCallback(() => {
    for (const unsubscribe of teardownRef.current) unsubscribe();
    teardownRef.current = [];
  }, []);

  /** 注入的 client 优先；没有才用进程内共享的那个真 client */
  const resolveClient = useCallback((): GameClient => client ?? getSharedClient(), [client]);

  const adopt = useCallback(
    (connection: RoomConnection) => {
      teardown();
      connectionRef.current = connection;
      teardownRef.current = [
        // subscribe 会立刻同步推一次当前快照，所以这里一注册 UI 就有内容了。
        // 用函数式更新**保留** link：重连成功后 SDK 会补推一次全量状态，
        // 那时 link 已被 onLinkChange 置成 'online'，不该被快照回调改写；
        // 反过来，掉线期间若还有缓冲的补丁到达，也不能把 'reconnecting' 冲掉。
        connection.subscribe((snapshot) => {
          setState((current) => ({ status: 'connected', snapshot, failure: null, link: current.link }));
        }),
        connection.onLinkChange((link) => {
          setState((current) => ({ ...current, link }));
        }),
      ];
    },
    [teardown],
  );

  const beginConnect = useCallback(
    async (key: string, start: () => Promise<RoomConnection>): Promise<RoomConnection | 'duplicate' | null> => {
      if (pendingKeyRef.current === key) return 'duplicate';
      pendingKeyRef.current = key;
      setState({ status: 'connecting', snapshot: null, failure: null, link: 'online' });
      try {
        const connection = await start();
        adopt(connection);
        return connection;
      } catch (error) {
        setState({ status: 'error', snapshot: null, failure: describeConnectionError(error), link: 'online' });
        return null;
      } finally {
        pendingKeyRef.current = null;
      }
    },
    [adopt],
  );

  const leaveCurrent = useCallback(async () => {
    const existing = connectionRef.current;
    connectionRef.current = null;
    teardown();
    if (existing !== null) await existing.leave();
  }, [teardown]);

  const createRoom = useCallback(
    async (profile: PlayerProfile): Promise<string | null> => {
      await leaveCurrent();
      const outcome = await beginConnect(CREATE_KEY, () => resolveClient().createRoom(profile));
      // 'duplicate' 在这里到不了：创建按钮在 connecting 期间是禁用的。
      // 真到了也返回 null，调用方按失败处理，不会导航到一个错的房间。
      return outcome !== null && outcome !== 'duplicate' ? outcome.code : null;
    },
    [beginConnect, leaveCurrent, resolveClient],
  );

  const joinRoom = useCallback(
    async (code: string, profile: PlayerProfile): Promise<boolean> => {
      const existing = connectionRef.current;
      if (existing !== null && existing.code === code) return true;
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

  const dismissFailure = useCallback(() => {
    setState((current) => (current.failure === null ? current : { ...current, failure: null }));
  }, []);

  const value = useMemo<RoomContextValue>(
    () => ({
      ...state,
      createRoom,
      joinRoom,
      leaveRoom,
      dismissFailure,
    }),
    [state, createRoom, joinRoom, leaveRoom, dismissFailure],
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
