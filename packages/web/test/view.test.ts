/**
 * `net/view.ts` 的单元测试：schema → 快照这一层的**兜底方向**。
 *
 * 为什么单独测这一层，而不是全靠 `table.test.tsx` 的组件用例：
 * 组件用例喂的是**已经翻译好**的 `RoomSnapshot`（见 `fakeClient.ts` 的 `fakeSnapshot`），
 * 所以「服务端来了一个前端不认识的值」这条路径在整条 web 测试网里没人走。
 * 而这一层的规矩恰恰是「不认识时挑最保守的那一支」（见 `view.ts` 文件头第 2 条）。
 *
 * 这条缺口是 2026-09-26 用变异探针挖出来的，两个探针都在改动**留着**的情况下先写测试：
 * - 把 `readPhase` 的兜底从 `'IDLE'` 改成 `'PREFLOP'`：全仓 159 条 web 用例**一条都没红**。
 * - 把 `isMyTurn` 的 `currentTurn !== null &&` 去掉：仍然一条都没红，包括本文件第一版
 *   写的那条旁观者用例——它只测了「服务端等 0 号位、我是旁观者」，没测「服务端谁都不等」。
 *   也就是说这个文件自己一开始也没兜住。第三例（座位 0 当哨兵）则由本文件兜住了。
 *
 * 兜底方向不是风格问题。服务端先升级、客户端还是旧版时，前端会收到不认识的
 * `phase`：认成 `IDLE` 是「按钮不亮、什么都别点」；认成 `PREFLOP` 是「牌局正开着，
 * 我该动」——后者会让玩家在服务端根本没在等他的那一步上敲按钮、看到错的倒计时，
 * 甚至把上送的动作发到下一步的界面里。宁可少显示，不可多显示。
 */

import { describe, expect, it } from 'vitest';
import type { SyncedRoomState } from '../src/net/sdkTypes';
import { buildSnapshot, emptyPrivate } from '../src/net/view';
import { publicState, slot } from './sdkFixture';

/** 只关心翻译结果，定向消息一律给空的 */
function read(state: SyncedRoomState, myId = 'self') {
  return buildSnapshot(state, { code: 'K7QM3D', myId, privateView: emptyPrivate(), actionPending: false });
}

/** 覆盖公开状态里的任意字段，包括前端**不该认识**的值（`phase` 在镜像里本来就是 `string`） */
function withState(changes: Record<string, unknown>): SyncedRoomState {
  return { ...publicState(), ...changes };
}

describe('视图翻译层的保守兜底', () => {
  it('不认识的 phase 当 IDLE，认识的原样通过', () => {
    const known = read(withState({ phase: 'RIVER' }));
    expect(known.phase).toBe('RIVER');

    const unknown = read(withState({ phase: 'TURN_TWO_AND_A_HALF' }));
    // 兜底成 IDLE 的下游效果在 UI 层：`HostPanel` 只在 IDLE 可编辑、`SeatList` 只在
    // IDLE/HAND_END 允许重购。本层只保证 phase 落在最保守那一支，不掺别的判断。
    expect(unknown.phase).toBe('IDLE');
  });

  it('不认识的 presence 当 reconnecting，不让玩家对一个可能已经没了的座位操作', () => {
    const state = withState({
      players: new Map([['self', { ...slot(), presence: 'quantum' }], ['other', slot('other', 1)]]),
    });
    const snapshot = read(state);
    expect(snapshot.players.find((player) => player.isSelf)?.presence).toBe('reconnecting');
  });

  it('座位 0 是真座位，只有 -1 才是「没座位」', () => {
    // 服务端用 -1 占位（D-016）。把 0 也当成占位，等于让坐 1 号位以外第 0 座的人
    // 在自己的牌桌上失去身份：轮到他也不亮按钮。
    const zero = read(withState({ currentTurn: 0 }));
    expect(zero.mySeat).toBe(0);
    expect(zero.currentTurn).toBe(0);
    expect(zero.isMyTurn).toBe(true);

    const none = read(withState({ currentTurn: -1 }));
    expect(none.currentTurn).toBeNull();
    expect(none.isMyTurn).toBe(false);
  });

  it('没座位就永远不轮到自己：服务端等 0 号位时不算我，谁都不等时也不算我', () => {
    // `isMyTurn` 必须是「服务端在等的那个座位 === 我的座位」，而不是「两者相等」：
    // 没座位是 null，而 null === null 会让整桌旁观者的按钮一起亮。
    const spectators = withState({
      players: new Map([
        ['self', slot('self', -1)],
        ['other', slot('other', 0)],
      ]),
      currentTurn: 0,
    });
    const snapshot = read(spectators, 'self');
    expect(snapshot.mySeat).toBeNull();
    expect(snapshot.isMyTurn).toBe(false);

    // 真正的危险在另一头：IDLE / HAND_END 时服务端谁都不等（`currentTurn: -1`）。
    // 此时「没座位」和「没人轮到」都是 null，只比相等就等于让每个旁观者都以为轮到
    // 自己——动作条会亮，点下去的动作服务端根本不会接受。
    const nobody = read(
      withState({
        players: new Map([['self', slot('self', -1)]]),
        currentTurn: -1,
      }),
      'self',
    );
    expect(nobody.currentTurn).toBeNull();
    expect(nobody.mySeat).toBeNull();
    expect(nobody.isMyTurn).toBe(false);
  });

  it('非有限的数字不进快照：金额归 0，时刻归 null', () => {
    // `t.number` 是 float64，NaN 和 Infinity 都**表达得出来**（服务端一处 `Math.max()`
    // 空数组就是 -Infinity）。这一层的规矩是"不认识就别显示"，所以它们必须被挡在快照外：
    // 让 NaN 漏到界面上，玩家看到的是「底池 NaN」「行动剩余 NaN 秒」。
    const snapshot = read(withState({
      potTotal: Number.NaN,
      introducedChips: Number.NaN,
      deadline: Number.POSITIVE_INFINITY,
    }));
    expect(snapshot.potTotal).toBe(0);
    expect(snapshot.introducedChips).toBe(0);
    // 时刻归 0 之后再过 `readTime` 的 `<= 0` 那一支，于是变成 null：倒计时干脆不出现
    expect(snapshot.deadline).toBeNull();
  });

  it('currentTurn 是不认识的值时宁可谁都不等，也不能落到 0 号位', () => {
    // 这条不是在测 `readNumber` 的兜底，而是测兜底**之后**的连锁：
    // 非有限 → 0，而 0 恰好是合法座位号。于是"服务端给了个垃圾值"会被翻译成
    // "服务端在等 0 号位"，坐 0 号位的人动作条就亮了。
    // 座位和金额不一样：金额猜 0 只是少显示，座位猜 0 是**多显示**。
    const snapshot = read(withState({ currentTurn: Number.NaN }));
    expect(snapshot.currentTurn).toBeNull();
    expect(snapshot.isMyTurn).toBe(false);
  });

  it('时刻类字段用 0 表示「没有」，但不是「已过期」', () => {
    const idle = read(withState({ deadline: 0, nextHandAt: 0 }));
    expect(idle.deadline).toBeNull();
    expect(idle.nextHandAt).toBeNull();

    const running = read(withState({ deadline: 1800000030000, nextHandAt: 0 }));
    expect(running.deadline).toBe(1800000030000);
  });

  it('金额与动作资格一律照抄服务端，前端不自己算', () => {
    // 这条钉的是「禁止信任客户端」的另一半：反过来前端也不许自己推一个数出来。
    // 一旦有人图省事写成 `callAmount: currentBet - committed`，这里就会红。
    const snapshot = read(publicState());
    const me = snapshot.players.find((player) => player.isSelf)!;
    expect(me.legal).toEqual({
      canFold: true,
      canCheck: false,
      callAmount: 10,
      canRaise: true,
      minRaiseTotal: 40,
      maxRaiseTotal: 2000,
      canAllIn: true,
    });
  });

  it('房主身份只认服务端给的 hostId，空串哨兵表示「现在没房主」', () => {
    const asOther = read(publicState(), 'other');
    expect(asOther.isHost).toBe(false);
    expect(asOther.players.find((player) => player.id === 'other')?.isHost).toBe(false);
    expect(asOther.players.find((player) => player.id === 'self')?.isHost).toBe(true);

    // 房主转移的瞬间服务端会发空串（D-016）。这时谁都不该拿到「开始牌局」按钮。
    const hostless = read(withState({ hostId: '' }));
    expect(hostless.hostId).toBeNull();
    expect(hostless.isHost).toBe(false);
    expect(hostless.players.some((player) => player.isHost)).toBe(false);
  });

  it('桌布只认那两档，其余一律留成默认绿呢', () => {
    // 这条测的是收窄，不是配色：`felt` 在 schema 镜像里是 `string`（和 phase / presence 一样），
    // 前端拿到不认识的值时必须落回一个**确定存在**的桌布，否则 `tableFeltDataUri` 会拿到
    // undefined，整张桌子的背景直接消失。
    const withFelt = (felt: string): SyncedRoomState =>
      withState({ config: { ...publicState().config, felt } });
    expect(read(withFelt('blue')).config.felt).toBe('blue');
    expect(read(withFelt('green')).config.felt).toBe('green');
    // 空串是 `t.string` 的默认值：服务端还没写这个字段（旧服务端 + 新前端）就会到这里
    expect(read(withFelt('')).config.felt).toBe('green');
    expect(read(withFelt('blue ')).config.felt).toBe('green');
  });

  it('快照不持有 schema 引用：改原始对象不会改写已发布的快照', () => {
    const state = publicState();
    const snapshot = read(state);
    const before = structuredClone(snapshot.players);
    // 模拟一次原地 patch（真 Colyseus 就会这么干）。镜像类型只开了 `forEach`
    // （见 `sdkTypes.ts`），所以从这里拿引用，而不是假设有 `get`。
    state.players.forEach((entry, id) => {
      if (id === 'self') (entry as { chips: number }).chips = 1;
    });
    state.handPlayers.forEach((entry) => {
      if (entry.playerId === 'other') (entry as { committedTotal: number }).committedTotal = 999;
    });
    expect(snapshot.players).toEqual(before);
    expect(readHand(snapshot, 'other').committedTotal).toBe(10);
  });
});

function readHand(snapshot: ReturnType<typeof read>, playerId: string) {
  const row = snapshot.handPlayers.find((entry) => entry.playerId === playerId);
  if (row === undefined) throw new Error(`快照里没有 ${playerId}`);
  return row;
}
