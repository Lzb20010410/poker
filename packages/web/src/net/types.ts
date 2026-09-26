/**
 * 前端与服务端之间的**视图契约**。
 *
 * 这些类型不是 Colyseus schema 的复制品，而是 `net/view.ts` 把 schema
 * 翻译之后交给 React 的东西。之所以要隔一层：
 *
 * - schema 的实例是 Colyseus 生成的动态对象，形状随协议版本变化，
 *   直接把它塞进 React 会让每个组件都依赖 SDK 的类型。
 * - 组件要的是「一个普通只读数组」，不是 `MapSchema`。
 * - 有了这层，测试可以拿一个假的 `GameClient` 驱动整个 UI，不用起服务端。
 * - schema 里的哨兵值（`-1` / `0` / `''`）在这里还原成 `null`，
 *   组件不必各自记一遍「-1 表示没人坐」——见 DECISIONS.md D-016。
 *
 * 铁律（SPEC §1.2）：前端只渲染、只上送操作，**不判定动作是否合法、不算谁赢**。
 * 所以下面所有 `canFold` / `callAmount` / `minRaiseTotal` 之类的字段都是
 * **服务端算好的提示**，前端拿来决定按钮亮不亮；真正的合法性由服务端再判一次。
 */

import type { C2S, Card, FeltColor, Phase, S2C_Broadcast } from '@poker-room/shared/view';

/** 玩家自己选择的身份。进房时随 join options 上送，服务端会再清洗一遍 */
export interface PlayerProfile {
  readonly nickname: string;
  /** DiceBear 头像 seed。同步 seed 而不是图片，见 DECISIONS.md D-011 */
  readonly avatarSeed: string;
}

/** 在线状态。`left` 是「已离桌但账户还在」，不是连接状态 */
export type Presence = 'online' | 'reconnecting' | 'left';

/** 服务端为本手冻结的身份（换座位/离开后仍按这一手的记录显示，见 D-014） */
export interface HandPlayerView {
  readonly playerId: string;
  readonly seatIndex: number;
  readonly nickname: string;
  readonly avatarSeed: string;
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly sittingOut: boolean;
  readonly hasActed: boolean;
  readonly committedThisStreet: number;
  readonly committedTotal: number;
}

/** 服务端算好的可执行动作提示。`raise` 用的是**总额**，不是增量 */
export interface LegalActionsView {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly callAmount: number;
  readonly canRaise: boolean;
  readonly minRaiseTotal: number;
  readonly maxRaiseTotal: number;
  readonly canAllIn: boolean;
}

/** 结算后的单人结果，直接来自 schema */
export interface ResultView {
  readonly playerId: string;
  readonly seatIndex: number;
  readonly chips: number;
  readonly delta: number;
  readonly handName: string;
}

/** 一手里的一个池（主池 / 边池），`eligible` 是座位号 */
export interface PotView {
  readonly amount: number;
  readonly eligible: readonly number[];
}

/** 一条 `pot:awarded` 事件，用来在摊牌处写出「谁赢了哪个池、什么牌型」 */
export interface AwardView {
  readonly potIndex: number;
  readonly winners: readonly number[];
  readonly amount: number;
  readonly handName: string;
  readonly bestFive: readonly Card[];
}

/** 某位玩家摊牌亮出的底牌。`playerId` 在**收到时**由冻结身份解析，之后不随座位变动改写 */
export interface RevealView {
  readonly playerId: string;
  readonly seatIndex: number;
  readonly cards: readonly [Card, Card];
}

/** 牌桌配置。数字全用 `number`：schema 就是 number，前端不做「2..8」这种收窄，免得替服务端说谎 */
export interface TableViewConfig {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly startingChips: number;
  readonly maxPlayers: number;
  readonly actionTimeoutSec: number;
  readonly minPlayersToStart: number;
  /**
   * 桌布颜色。这是配置里唯一的纯展示项，规则引擎除了「合法取值是哪几档」之外不读它。
   * 和上面几个数字不同，这一项**要**收窄：它的值是 `FELT_COLORS` 的查表键，
   * 查不到就是 `undefined`，整张桌面会渲染成黑的。所以 `view.ts` 里有一道白名单。
   */
  readonly felt: FeltColor;
}

/** 房间里一个玩家（含旁观者：`seatIndex === null`），视角是「我看到的他」 */
export interface ConnectedPlayer extends PlayerProfile {
  /** 账户 id，等于 Colyseus 的 sessionId，房间内的唯一标识 */
  readonly id: string;
  readonly isSelf: boolean;
  /** 座位号 0..7；`null` 表示还没入座（哨兵 -1 已还原） */
  readonly seatIndex: number | null;
  readonly chips: number;
  readonly presence: Presence;
  readonly isHost: boolean;
  readonly legal: LegalActionsView;
}

/** 某一时刻房间的全貌。每次 schema 变化都会推一个新的快照给订阅者 */
export interface RoomSnapshot {
  readonly code: string;
  /** 按座位升序；旁观者排最后。座位为空的那些位置不在这里，由 UI 按 `config.maxPlayers` 补 */
  readonly players: readonly ConnectedPlayer[];
  readonly handPlayers: readonly HandPlayerView[];
  readonly pots: readonly PotView[];
  readonly results: readonly ResultView[];
  readonly board: readonly Card[];
  readonly awards: readonly AwardView[];
  readonly reveals: readonly RevealView[];
  /** **只有我自己**的底牌，来自定向 `deal` 消息。绝不来自 schema */
  readonly holeCards: readonly [Card, Card] | null;
  /** 服务端 `timeoutWarning` 的剩余秒数；没收到定向消息时为 null */
  readonly timeoutWarning: number | null;
  /** 我这一步动作已经发出去了、还没被新状态或错误确认。用来挡双击 */
  readonly actionPending: boolean;
  readonly phase: Phase;
  readonly handId: string;
  readonly handNo: number;
  readonly turnVersion: number;
  readonly hostId: string | null;
  readonly myId: string;
  readonly mySeat: number | null;
  readonly isHost: boolean;
  readonly isMyTurn: boolean;
  readonly dealerSeat: number | null;
  readonly sbSeat: number | null;
  readonly bbSeat: number | null;
  readonly currentTurn: number | null;
  /** 服务端时钟下的行动截止时刻；`null` 表示现在没人该行动 */
  readonly deadline: number | null;
  readonly nextHandAt: number | null;
  readonly currentBet: number;
  readonly lastRaiseSize: number;
  readonly runOutBoard: boolean;
  readonly potTotal: number;
  readonly introducedChips: number;
  readonly retainedChips: number;
  readonly config: TableViewConfig;
  /**
   * `serverTime - 本地时间`，在收到这次 patch 的瞬间算好。
   * 倒计时必须走 `deadline - (Date.now() + clockOffsetMs)`，
   * 不能在本地自己每 tick 减一：那样手机切后台回来数字就对不上了。
   */
  readonly clockOffsetMs: number;
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
 * 「这房间还没站稳，不值得重连」，直接发 `onLeave`。适配器把 `minUptime`
 * 设成 0，让「刚进房就断」和「玩到一半才断」走同一条路径。
 */
export type LinkState = 'online' | 'reconnecting' | 'offline';

/** 一句要展示给玩家的话。`info` 是「刚才那个码过期了，已用新身份进来」这类 */
export interface Notice {
  readonly id: number;
  readonly kind: 'info' | 'error';
  readonly message: string;
}

export type RoomListener = (snapshot: RoomSnapshot) => void;
export type LinkListener = (link: LinkState) => void;
export type NoticeListener = (notice: Notice) => void;
/**
 * 服务端的广播事件（动画的输入）。
 *
 * 和上面三个监听器的**关键区别**：注册时不重放。快照、连接状态、提示都是「现在是什么样」，
 * 晚一点挂上去也得知道；广播事件是「刚才发生了什么」，重放一遍就是把已经播过的动画再播一次——
 * 发牌牌会从牌堆飞第二遍，底池会二次滚筹码。所以这里只在注册之后转发新到的事件。
 */
export type EventListener = (event: S2C_Broadcast) => void;
export type Unsubscribe = () => void;

/** 一条已建立的房间连接。生命周期由 `state/RoomContext.tsx` 管，组件只订阅 */
export interface RoomConnection {
  /** 配对码，也就是 roomId（DECISIONS.md D-009） */
  readonly code: string;
  /** 我自己的账户 id（= sessionId）。服务端后续动作都以它为准 */
  readonly mySessionId: string;
  /** 立刻取一份当前快照，不订阅后续变化 */
  readonly snapshot: () => RoomSnapshot;
  /**
   * 订阅快照变化。**注册时会立刻同步推一次当前值**，
   * 这样组件不必区分「首次」和「后续」，也不用等下一个 patch 才有内容显示。
   */
  readonly subscribe: (listener: RoomListener) => Unsubscribe;
  /**
   * 订阅连接状态迁移。**注册时会立刻同步推一次当前值**（不是无条件 `'online'`：
   * 掉线期间晚挂载的组件必须看到 `'reconnecting'`，否则它会以为还连着）。
   * 玩家自己点「离开」不会触发这里（`'offline'` 只表示非自愿断开）。
   */
  readonly onLinkChange: (listener: LinkListener) => Unsubscribe;
  /** 订阅提示。**注册时会立刻重放已有提示**，避免 StrictMode 双挂载把第一条吞掉 */
  readonly onNotice: (listener: NoticeListener) => Unsubscribe;
  /**
   * 上送一条命令。返回 `false` 表示**没发出去**：连接不在 `online`、
   * 或者这一步动作还悬着（防双击）。断线期间一律不发，交给玩家重试，
   * 而不是让 SDK 攒在队列里，重连后突然把过期的动作打在服务端上。
   */
  readonly send: (command: C2S) => boolean;
  /**
   * 订阅服务端的**广播事件**（`SPEC.md` §2.3：动画由事件驱动，不由状态 diff 驱动）。
   * 载荷已经过 `net/events.ts` 的形状校验，不合法的那条不会到达这里。
   * 注册时不重放，理由见 `EventListener`。
   */
  readonly onEvent: (listener: EventListener) => Unsubscribe;
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
  /** 用配对码进房。有存下的重连凭证就先重连，没有才当新玩家加入 */
  readonly joinRoom: (code: string, profile: PlayerProfile) => Promise<RoomConnection>;
}
