/**
 * `@colyseus/sdk` 与 public schema 的**最小结构化镜像**。
 *
 * 应用代码里只有 `net/client.ts` 允许 import `@colyseus/sdk`（本仓库的边界约定，见 DECISIONS.md D-017），
 * 而它需要的「房间长什么样」就写在这里。这里刻意只用结构化类型描述，
 * 不去 `import type { Room } from '@colyseus/sdk'`：那个类型带三个泛型参数、
 * 内部大量 `any`，一旦外泄就会传染整个 UI 层。
 *
 * 字段名必须和 `packages/server/src/schema/PokerRoomState.ts` 一致。
 * 之所以两边各写一份而不是共享：web 不许 import server（SPEC §1.2），
 * 而 schema 里出现的每一个字段都是**公开信息**——底牌永远不在里面（D-016）。
 * `net/view.ts` 会把这里的 `string` 收窄成真正的联合类型，收窄失败时走保守分支。
 */

import type { C2S } from '@poker-room/shared/view';

/** `t.number` 只能表达「有值」，哨兵用 -1 / 0 / '' 表示「没有」。镜像里就保持原始类型 */
export interface SyncedCard {
  readonly rank: number;
  readonly suit: string;
}

export interface SyncedPot {
  readonly amount: number;
  readonly eligible: SyncedList<number>;
}

export interface SyncedResult {
  readonly playerId: string;
  readonly seatIndex: number;
  readonly chips: number;
  readonly delta: number;
  readonly handName: string;
}

/** `ArraySchema<T>` 的镜像：只声明我们真正用到的 `forEach`（`ArraySchema` 继承 `Array`） */
export interface SyncedList<T> {
  forEach(callback: (value: T, index: number) => void): void;
}

/** `MapSchema<T>` 的镜像，语义与 `Map.forEach` 相同 */
export interface SyncedMap<V> {
  forEach(callback: (value: V, key: string) => void): void;
}

export interface SyncedConfig {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly startingChips: number;
  readonly maxPlayers: number;
  readonly actionTimeoutSec: number;
  readonly minPlayersToStart: number;
  /** schema 侧是 `t.string`，所以这里保持 `string`：收窄在 `view.ts` 的白名单里做 */
  readonly felt: string;
}

/** 一个账户位（含未入座的旁观者）。`legal*` 是服务端算好的提示 */
export interface SyncedPlayerSlot {
  readonly id: string;
  readonly nickname: string;
  readonly avatarSeed: string;
  readonly seatIndex: number;
  readonly chips: number;
  readonly presence: string;
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly callAmount: number;
  readonly canRaise: boolean;
  readonly minRaiseTotal: number;
  readonly maxRaiseTotal: number;
  readonly canAllIn: boolean;
}

/** 本手冻结身份。键是 playerId，座位换人也不会改写 */
export interface SyncedHandPlayer {
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

export interface SyncedRoomState {
  readonly joinCode: string;
  readonly hostId: string;
  readonly phase: string;
  readonly handId: string;
  readonly handNo: number;
  readonly turnVersion: number;
  readonly serverTime: number;
  readonly dealerSeat: number;
  readonly sbSeat: number;
  readonly bbSeat: number;
  readonly currentTurn: number;
  readonly deadline: number;
  readonly nextHandAt: number;
  readonly currentBet: number;
  readonly lastRaiseSize: number;
  readonly runOutBoard: boolean;
  readonly potTotal: number;
  readonly introducedChips: number;
  readonly retainedChips: number;
  readonly config: SyncedConfig;
  readonly players: SyncedMap<SyncedPlayerSlot>;
  readonly handPlayers: SyncedMap<SyncedHandPlayer>;
  readonly board: SyncedList<SyncedCard>;
  readonly pots: SyncedList<SyncedPot>;
  readonly results: SyncedList<SyncedResult>;
}

/**
 * SDK 的信号对象：本身可调用（长期订阅），同时带 `once` / `remove`。
 * 见 `@colyseus/sdk/build/Room.d.ts` 里 `onStateChange` 的交叉类型。
 */
export interface SdkSignal<Callback> {
  (callback: Callback): unknown;
  once(callback: Callback): void;
  remove(callback: Callback): void;
}

/** `room.reconnection`（`build/Reconnection.d.ts`）。四个字段都要能被我们改写 */
export interface SdkReconnection {
  enabled: boolean;
  isReconnecting: boolean;
  maxEnqueuedMessages: number;
  minUptime: number;
}

/** `room.connection` 上我们真正碰到的两个成员 */
export interface SdkConnection {
  isOpen: boolean;
  close(code?: number): void;
}

/**
 * 我们用到的那部分 `Room`。`state` 在收到第一个 patch 之前是 `undefined`，
 * 所以它是可选的——这不是保守，是实测（`sdk.create()` 的 promise 先于状态 resolve）。
 */
export interface SdkRoomLike {
  roomId: string;
  sessionId: string;
  reconnectionToken: string;
  state: SyncedRoomState | undefined;
  reconnection: SdkReconnection;
  connection: SdkConnection;
  onStateChange: SdkSignal<(state: SyncedRoomState) => void>;
  /** 非自愿离房（重连耗尽 / 房间解散 / 服务端踢）。也用于「状态还没到就断了」 */
  onLeave: SdkSignal<(code: number) => void>;
  /** 连接掉下去的**第一时间**触发，之后 SDK 才开始指数退避重连 */
  onDrop: SdkSignal<(code: number) => void>;
  /** 重连成功。此刻 `reconnectionToken` 还是**旧值**，新状态也还没推过来 */
  onReconnect: SdkSignal<() => void>;
  onError: SdkSignal<(code: number, reason?: string) => void>;
  onMessage<Payload>(type: string, callback: (payload: Payload) => void): () => void;
  send(type: string, data: C2S): void;
  leave(consented?: boolean): Promise<number>;
}
