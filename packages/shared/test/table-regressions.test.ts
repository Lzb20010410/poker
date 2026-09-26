import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLE_CONFIG, type TableConfig } from '../src/types';
import {
  addTablePlayer,
  applyPlayerAction,
  createTable,
  getPrivateMessages,
  getTimeoutWarning,
  rebuyPlayer,
  setPlayerPresence,
  setTableConfig,
  sitPlayer,
  standPlayer,
  startHand,
  startTable,
  tickTable,
} from '../src/engine/table';
import { act, checkDown, conserved, context, freeze, table } from './table-fixtures';

describe('table integration regressions', () => {
  it('leaving against two all-ins settles immediately, excluding the leaver from reveal recipients', () => {
    let state = startHand(table([30, 80, 200]), context(0, 1)).newState;
    state = act(state, 0, { type: 'allIn' });
    state = act(state, 1, { type: 'allIn' });
    const update = setPlayerPresence(freeze(state), 'p2', 'left', context());
    expect(update.newState.phase).toBe('HAND_END');
    expect(update.newState.pots).toEqual([
      { amount: 80, eligible: [0, 1] },
      { amount: 50, eligible: [1] },
    ]);
    expect(update.newState.accounts.map((p) => p.chips)).toEqual([80, 50, 180]);
    expect(update.privateMessages.map((m) => m.playerId)).toEqual(['p0', 'p0', 'p1', 'p1']);
    expect(
      update.privateMessages.every(
        (m) => m.message.t === 'showdown:reveal' && m.message.seatIndex !== 2,
      ),
    ).toBe(true);
    conserved(update.newState);
  });
  it('off-turn forced fold can end a street without stealing another player action', () => {
    let state = startHand(table([200, 200, 200]), context()).newState;
    state = act(state, 0, { type: 'call' });
    state = act(state, 1, { type: 'call' });
    state = act(state, 2, { type: 'raise', totalBet: 60 });
    const update = standPlayer(state, 'p1', context(10));
    expect(update.newState.currentTurn).toBe(0);
    expect(update.newState.accounts.map((p) => p.chips)).toEqual([180, 180, 140]);
    const ended = checkDown(update.newState);
    expect(ended.pots).toEqual([{ amount: 140, eligible: [0, 2] }]);
    conserved(ended);
  });
  it('bootstrap spectators can join the next hand; moving seats never grants chips', () => {
    let state = createTable(DEFAULT_TABLE_CONFIG, [
      { id: 'a', nickname: 'A', avatarSeed: 'A', seatIndex: 0, chips: 200 },
      { id: 'b', nickname: 'B', avatarSeed: 'B', seatIndex: 1, chips: 200 },
      { id: 'c', nickname: 'C', avatarSeed: 'C', seatIndex: null, chips: 200 },
    ]);
    state = sitPlayer(state, 'a', 5, context()).newState;
    state = startHand(state, context()).newState;
    state = sitPlayer(state, 'c', 0, context()).newState;
    expect(state.participants.map((p) => p.playerId)).toEqual(['b', 'a']);
    expect(getPrivateMessages(state, 'c')).toEqual([]);
    state = standPlayer(state, 'c', context()).newState;
    state = sitPlayer(state, 'c', 0, context()).newState;
    const end = checkDown(state);
    const next = startHand(end, context(5000)).newState;
    expect(next.participants.map((p) => p.playerId)).toContain('c');
    expect(next.introducedChips).toBe(600);
    conserved(next);
  });
  it('a drop that never becomes a departure keeps the crown, and an offline host cannot start', () => {
    let state = startHand(table(), context()).newState;
    state = setPlayerPresence(state, 'p0', 'reconnecting', context()).newState;
    state = setPlayerPresence(state, 'p1', 'reconnecting', context()).newState;
    // SPEC §2.5 只在房主**离开**时转移房主；两人都只是掉线重连，王冠留在原处
    expect(state.hostId).toBe('p0');
    const end = tickTable(state, context(30000)).newState;
    expect(end.accounts.map((p) => p.chips)).toEqual([190, 210]);
    const idle = tickTable(end, context(35000)).newState;
    expect(idle.phase).toBe('IDLE');
    // 保住名分不等于保住权力：没连回来的房主照样开不了局（这条走的是离线判定，
    // 阶段已经是 IDLE，所以不可能是被「阶段不对」挡出来的）
    expect(() => startTable(idle, 'p0', context(35000))).toThrow(
      expect.objectContaining({ code: 'INVALID_ACTION' }),
    );
    const back = setPlayerPresence(idle, 'p0', 'online', context()).newState;
    expect(back.hostId).toBe('p0');
    conserved(back);
  });
  it('rebuy during HAND_END keeps results but never repays the prior hand on the next tick', () => {
    const end = startHand(table([10, 10]), context()).newState;
    // 两人各 10 筹码全下、公共牌跑完：赢家 20、输家 0。**谁**赢取决于发牌，
    // 所以这里按"筹码为 0 的那个人"取，不把座位写死（发牌起点按 §1.3 修正过一次，写死就会跟着抖）。
    const loser = end.accounts.find((a) => a.chips === 0)!;
    const winner = end.accounts.find((a) => a.id !== loser.id)!;
    expect(winner.chips).toBe(20);
    const state = rebuyPlayer(end, loser.id, context()).newState;
    expect(state.results).toEqual(end.results);
    // 重买只给回初始筹码，不把上一手已经派过的 20 再派一次：输家恰好 startingChips、赢家仍是 20。
    expect(state.accounts.find((a) => a.id === loser.id)!.chips).toBe(state.config.startingChips);
    expect(state.accounts.find((a) => a.id === winner.id)!.chips).toBe(20);
    const next = tickTable(state, context(5000)).newState;
    expect(next.handNo).toBe(2);
    // 下一手只重新下了一次盲注（10 + 20），不会因为上一手的派彩再动一次钱
    expect(next.participants.reduce((sum, p) => sum + p.committedTotal, 0)).toBe(30);
    conserved(next);
  });
  it('old timers and commands cannot act in later turns or a later hand', () => {
    const first = startHand(table(), context()).newState;
    const next = act(first, 0, { type: 'call' }, 1000);
    expect(tickTable(next, context(30000)).newState).toBe(next);
    expect(getTimeoutWarning(next, 1000)).toBeNull();
    const end = checkDown(next);
    const second = startHand(end, context(5000)).newState;
    expect(() =>
      applyPlayerAction(
        second,
        'p1',
        { type: 'call' },
        first.handId,
        second.turnVersion,
        context(),
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ACTION' }));
    const standing = standPlayer(first, 'p0', context()).newState;
    expect(() =>
      applyPlayerAction(
        standing,
        'p0',
        { type: 'fold' },
        standing.handId,
        standing.turnVersion,
        context(),
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_SEATED' }));
    conserved(second);
  });
  it('join ignores extra untrusted chip properties and retains old account balances', () => {
    const state = setPlayerPresence(table(), 'p0', 'left', context()).newState;
    const update = addTablePlayer(
      state,
      { id: 'new', nickname: 'New', avatarSeed: 'N', chips: 999999 } as {
        id: string;
        nickname: string;
        avatarSeed: string;
      },
      context(),
    );
    expect(update.newState.accounts.map((p) => p.chips)).toEqual([200, 200, 2000]);
    expect(update.events[0]).toEqual({
      t: 'player:joined',
      seatIndex: 0,
      profile: { id: 'new', nickname: 'New', avatarSeed: 'N' },
    });
    conserved(update.newState);
  });
  it.each([null, [], 12, undefined].map((input) => [input]))(
    'rejects non-object bootstrap configuration %j',
    (input) => {
      expect(() => createTable(input as unknown as TableConfig, [])).toThrow(
        expect.objectContaining({ code: 'INVALID_ACTION' }),
      );
    },
  );
  it('detects table-level conservation damage rather than validating only payout sums', () => {
    const state = startHand(table(), context()).newState;
    expect(() => act({ ...state, introducedChips: 401 }, 0, { type: 'fold' })).toThrow(
      '牌桌筹码不守恒',
    );
  });
  it('unknown symbol config keys are rejected by the whitelist', () => {
    expect(() => setTableConfig(table(), 'p0', { [Symbol('extra')]: 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ACTION' }),
    );
  });
  it('repeated final action is stale even though there is no next actor to increment the version', () => {
    const start = startHand(table(), context()).newState;
    const end = applyPlayerAction(
      start,
      'p0',
      { type: 'fold' },
      start.handId,
      start.turnVersion,
      context(),
    ).newState;
    expect(() =>
      applyPlayerAction(end, 'p0', { type: 'fold' }, start.handId, start.turnVersion, context()),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ACTION' }));
    expect(end.accounts.map((p) => p.chips)).toEqual([190, 210]);
    conserved(end);
  });
  it('a deadline and next-hand timestamp equal to zero are not mistaken for absent timers', () => {
    const start = startHand(table(), context(-30000)).newState;
    expect(start.deadline).toBe(0);
    expect(getTimeoutWarning(start, -10000)?.message).toEqual({
      t: 'timeoutWarning',
      remainingSec: 10,
    });
    expect(tickTable(start, context(-1)).newState).toBe(start);
    const timed = tickTable(start, context(0)).newState;
    expect(timed.phase).toBe('HAND_END');
    conserved(timed);
    const end = act(start, 0, { type: 'fold' }, -5000);
    expect(end.nextHandAt).toBe(0);
    expect(tickTable(end, context(-1)).newState).toBe(end);
    const next = tickTable(end, context(0)).newState;
    expect(next.handNo).toBe(2);
    conserved(next);
  });
  /**
   * 浏览器里实测到的：房主刷新一下页面，WebSocket 先断再续，
   * 期间服务端把 presence 改成 'reconnecting'。房主标识不能因此跑到别人头上——
   * 否则别人只要等房主刷一次页面就能拿走「开始牌局 / 改配置」的权力。
   */
  it('a refresh-induced drop keeps the crown with the host', () => {
    const base = freeze(table([200, 200]));
    expect(base.hostId).toBe('p0');
    const dropped = freeze(setPlayerPresence(base, 'p0', 'reconnecting', context()).newState);
    expect(dropped.hostId).toBe('p0');
    const back = setPlayerPresence(dropped, 'p0', 'online', context()).newState;
    expect(back.hostId).toBe('p0');
    expect(() => startTable(back, 'p0', context())).not.toThrow();
  });
  it('only a real departure moves the crown, and it goes to the lowest seated player', () => {
    const base = freeze(table([200, 200, 200]));
    const gone = freeze(setPlayerPresence(base, 'p0', 'left', context()).newState);
    expect(gone.hostId).toBe('p1');
    const alsoGone = setPlayerPresence(gone, 'p1', 'left', context()).newState;
    expect(alsoGone.hostId).toBe('p2');
    conserved(alsoGone);
  });
});
