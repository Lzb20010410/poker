/**
 * 前端与服务端之间的**视图契约**。
 *
 * 这些类型不是 Colyseus schema 的复制品，而是 `net/client.ts` 把 schema
 * 翻译之后交给 React 的东西。之所以要隔一层：
 *
 * - schema 的实例是 Colyseus 生成的动态对象，形状随协议版本变化，
 *   直接把它塞进 React 会让每个组件都依赖 SDK 的类型。
 * - 组件要的是「一个普通只读数组」，不是 `MapSchema`。
 * - 有了这层，测试可以拿一个假的 `GameClient` 驱动整个 UI，不用起服务端。
 *
 * 铁律（SPEC §1.2）：前端只渲染、只上送操作，**不判定动作是否合法、不算谁赢**。
 */

/** 玩家自己选择的身份。进房时随 join options 上送，服务端会再清洗一遍 */
export interface PlayerProfile {
  readonly nickname: string;
  /** DiceBear 头像 seed。同步 seed 而不是图片，见 DECISIONS.md D-011 */
  readonly avatarSeed: string;
}

/** 房间里一个已连接的玩家，视角是「我看到的他」 */
export interface ConnectedPlayer extends PlayerProfile {
  /** Colyseus sessionId，房间内的唯一标识（M1 之后会另加 seatIndex） */
  readonly sessionId: string;
  readonly isSelf: boolean;
}

/** 某一时刻房间的全貌。每次 schema 变化都会推一个新的快照给订阅者 */
export interface RoomSnapshot {
  readonly code: string;
  readonly players: readonly ConnectedPlayer[];
}

/**
 * 连接状态。
 *
 * ## 为什么是三态，而不是「连着 / 断了」两态
 *
 * Colyseus SDK 默认开启自动重连（`room.reconnection.enabled === true`），
 * 参数是 15 次指数退避、单次延迟 100ms 起、封顶 5000ms —— 实测整个重试窗口
 * 约 **56 秒**。关键在于：这个窗口里 SDK **只发 `onDrop`，不发 `onLeave`**
 * （`Room.mjs` 的 `connection.events.onclose`：可重连的 close code 走
 * `onDrop` + `handleReconnection`，其余才直接走 `onLeave`）。重连彻底失败时
 * 才补发一次 `onLeave`，close code 是 `FAILED_TO_RECONNECT`。
 *
 * 所以如果 UI 只有两态，掉线后的这 56 秒里玩家看到的是一张完好无损的牌桌：
 * 别人的动作不再更新，也没有任何提示，他会一直等下去。
 * `reconnecting` 这个中间态就是为了把这段时间如实说出来。
 *
 * 另一个坑（`minUptime` 默认 5000ms）：进房不到 5 秒就掉线的话，SDK 认为
 * 「这房间还没站稳，不值得重连」，直接发 `onLeave`。所以刚进房就断
 * 和玩到一半断，走的是两条不同的路径——测试要分别覆盖。
 */
export type LinkState = 'online' | 'reconnecting' | 'offline';

export type RoomListener = (snapshot: RoomSnapshot) => void;
export type LinkListener = (link: LinkState) => void;
export type Unsubscribe = () => void;

/** 一条已建立的房间连接。生命周期由 `state/RoomContext.tsx` 管，组件只订阅 */
export interface RoomConnection {
  /** 配对码，也就是 roomId（DECISIONS.md D-009） */
  readonly code: string;
  readonly mySessionId: string;
  /** 立刻取一份当前快照，不订阅后续变化 */
  readonly snapshot: () => RoomSnapshot;
  /**
   * 订阅快照变化。**注册时会立刻同步推一次当前值**，
   * 这样组件不必区分「首次」和「后续」，也不用等下一个 patch 才有内容显示。
   */
  readonly subscribe: (listener: RoomListener) => Unsubscribe;
  /**
   * 订阅连接状态迁移。**注册时会立刻同步推一次 `'online'`**，
   * 与 `subscribe` 的口径一致：订阅者不必关心自己是第一个还是第 N 个。
   * 玩家自己点「离开」不会触发这里（`'offline'` 只表示非自愿断开）。
   */
  readonly onLinkChange: (listener: LinkListener) => Unsubscribe;
  /** 主动离开。`consented = true`，服务端因此不会给我们留重连座位 */
  readonly leave: () => Promise<void>;
}

/**
 * 前端唯一认识的服务端接口。
 *
 * 做成接口是为了可替换：测试里塞一个假的进去，就能不起服务端跑完整个大厅流程。
 *
 * 所有函数成员都写成**属性**而不是方法签名（`foo(): void` 的形式）：
 * 方法签名在 TS 里隐含 `this` 绑定，一旦从对象上解构下来就会触发
 * `@typescript-eslint/unbound-method`。这些实现全是 `useCallback` / 闭包，
 * 本来就没有 `this`，写成属性类型才是准确的描述。
 */
export interface GameClient {
  /** 创建房间，返回的连接里带着新分配到的配对码 */
  readonly createRoom: (profile: PlayerProfile) => Promise<RoomConnection>;
  /** 用配对码加入房间。码不存在 / 房间已满 / 服务端没起都会 reject */
  readonly joinRoom: (code: string, profile: PlayerProfile) => Promise<RoomConnection>;
}
