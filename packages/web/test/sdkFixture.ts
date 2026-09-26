import type { C2S } from '@poker-room/shared';
import type { SdkConnection, SdkReconnection, SdkRoomLike, SyncedRoomState } from '../src/net/sdkTypes';

export function signal<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  const subscribe = (callback: (...args: Args) => void) => { listeners.add(callback); };
  return Object.assign(subscribe, {
    remove: (callback: (...args: Args) => void) => { listeners.delete(callback); },
    once: (callback: (...args: Args) => void) => {
      const one = (...args: Args) => { listeners.delete(one); callback(...args); };
      listeners.add(one);
    },
    emit: (...args: Args) => { for (const callback of [...listeners]) callback(...args); },
    size: () => listeners.size,
  });
}
export const slot = (id = 'self', seatIndex = 0) => ({
  id, nickname: id, avatarSeed: id, seatIndex, chips: 1990, presence: 'online',
  canFold: true, canCheck: false, callAmount: 10, canRaise: true,
  minRaiseTotal: 40, maxRaiseTotal: 2000, canAllIn: true,
});
export const hand = (playerId = 'self', seatIndex = 0) => ({
  playerId, seatIndex, nickname: playerId, avatarSeed: playerId,
  folded: false, allIn: false, sittingOut: false, hasActed: false,
  committedThisStreet: 10, committedTotal: 10,
});
export function publicState(): SyncedRoomState {
  return {
    joinCode: 'K7QM3D', hostId: 'self', phase: 'PREFLOP', handId: 'hand-1',
    handNo: 1, turnVersion: 1, serverTime: 1800000000000,
    dealerSeat: 0, sbSeat: 0, bbSeat: 1, currentTurn: 0,
    deadline: 1800000030000, nextHandAt: 0, currentBet: 20, lastRaiseSize: 20,
    runOutBoard: false, potTotal: 30, introducedChips: 4000, retainedChips: 0,
    // `felt` 故意给 `'blue'` 而不是默认的 `'green'`：白名单回落的目标就是 `'green'`，
    // 基座也是 `'green'` 的话「非法值被改成 green」和「这个字段根本没被读」两种实现
    // 都能通过断言。基座换成另一档，回落才真的可分辨。
    config: { smallBlind: 10, bigBlind: 20, startingChips: 2000, maxPlayers: 8, actionTimeoutSec: 30, minPlayersToStart: 2, felt: 'blue' },
    players: new Map([['self', slot()], ['other', slot('other', 1)]]),
    handPlayers: new Map([['self', hand()], ['other', hand('other', 1)]]),
    board: [], pots: [], results: [],
  };
}
export function sdkRoom(initial?: SyncedRoomState) {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const sent: C2S[] = [];
  let leaves = 0;
  let closes = 0;
  /**
   * 这两个子对象**必须**单独标类型，不能只靠下面的 `satisfies`：
   * `satisfies` 只做兼容性检查、不参与推导，`isOpen: true` 会被推成字面量类型 `true`，
   * 于是测试里 `room.connection.isOpen = false` 直接编译不过。
   * 而测试恰恰要手动改这几个字段来模拟「socket 关了」「SDK 正在重连」。
   */
  const reconnection: SdkReconnection = {
    enabled: true,
    isReconnecting: false,
    maxEnqueuedMessages: 10,
    minUptime: 5000,
  };
  const connection: SdkConnection = { isOpen: true, close: () => { closes++; connection.isOpen = false; } };
  const room = {
    roomId: 'K7QM3D', sessionId: 'self', reconnectionToken: 'K7QM3D:old-secret', state: initial,
    reconnection, connection,
    onStateChange: signal<[SyncedRoomState]>(), onLeave: signal<[number]>(),
    onDrop: signal<[number]>(), onReconnect: signal<[]>(), onError: signal<[number, string?]>(),
    onMessage: <T>(type: string, cb: (payload: T) => void) => {
      const set = handlers.get(type) ?? new Set<(data: unknown) => void>();
      const handler = cb as (payload: unknown) => void;
      set.add(handler); handlers.set(type, set);
      return () => { set.delete(handler); };
    },
    send: (_type: string, data: C2S) => { sent.push(data); },
    leave: async (_consented?: boolean) => { leaves++; return 4000; },
  } satisfies SdkRoomLike;
  return {
    room, sent, leaves: () => leaves, closes: () => closes,
    message: (type: string, data: unknown) => { for (const cb of handlers.get(type) ?? []) cb(data); },
    patch: (state = publicState()) => { room.state = state; room.onStateChange.emit(state); },
    messageListeners: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}
export function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data, getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}
