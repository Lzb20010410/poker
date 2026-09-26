import { describe, expect, it } from 'vitest';
import { cardId, parseCardId } from '../src/types';
import {
  applyAction,
  applyPlayerAction,
  getPrivateMessages,
  getTableLegalActions,
  getTimeoutWarning,
  startHand,
  tickTable,
} from '../src/engine/table';
import { act, checkDown, conserved, context, freeze, table } from './table-fixtures';

describe('table flow', () => {
  it('plays a frozen-input hand through every street with exact seeded payout', () => {
    const start = startHand(freeze(table()), context());
    let state = start.newState;
    // §1.3 底牌从"小盲位"开始顺时针：两人桌小盲位就是庄家，所以第一、三张归座位 0。
    expect(state.participants.map((p) => p.holeCards.map(cardId))).toEqual([
      ['10c', 'Ah'],
      ['3h', 'Ac'],
    ]);
    const phases = ['IDLE', ...start.phases];
    const snapshots: unknown[] = [];
    for (const [seat, action] of [
      [0, { type: 'call' }],
      [1, { type: 'check' }],
      [1, { type: 'check' }],
      [0, { type: 'check' }],
      [1, { type: 'raise', totalBet: 40 }],
      [0, { type: 'call' }],
      [1, { type: 'check' }],
      [0, { type: 'check' }],
    ] as const) {
      const before = structuredClone(state);
      const update = applyAction(freeze(state), seat, freeze(action), context(100));
      expect(state).toEqual(before);
      state = update.newState;
      phases.push(...update.phases);
      conserved(state);
      snapshots.push([
        state.phase,
        state.currentTurn,
        state.currentBet,
        state.board.map(cardId),
        state.accounts.map((p) => p.chips),
      ]);
      if (state.phase === 'HAND_END') {
        expect(update.events.map((e) => e.t)).toEqual([
          'action:made',
          'round:end',
          'showdown:start',
          'pot:awarded',
          'hand:end',
        ]);
        expect(update.events).toContainEqual({
          t: 'pot:awarded',
          potIndex: 0,
          winners: [0],
          amount: 120,
          handName: '一对',
          bestFive: ['Qh', 'Qc', 'Ah', 'Jd', '10c'].map(parseCardId),
        });
      }
    }
    expect(snapshots).toEqual([
      ['PREFLOP', 1, 20, [], [180, 180]],
      ['FLOP', 1, 0, ['8s', 'Qc', 'Jd'], [180, 180]],
      ['FLOP', 0, 0, ['8s', 'Qc', 'Jd'], [180, 180]],
      ['TURN', 1, 0, ['8s', 'Qc', 'Jd', 'Qh'], [180, 180]],
      ['TURN', 0, 40, ['8s', 'Qc', 'Jd', 'Qh'], [180, 140]],
      ['RIVER', 1, 0, ['8s', 'Qc', 'Jd', 'Qh', '2h'], [140, 140]],
      ['RIVER', 0, 0, ['8s', 'Qc', 'Jd', 'Qh', '2h'], [140, 140]],
      ['HAND_END', null, 0, ['8s', 'Qc', 'Jd', 'Qh', '2h'], [260, 140]],
    ]);
    expect(phases).toEqual([
      'IDLE',
      'DEALING',
      'PREFLOP',
      'FLOP',
      'TURN',
      'RIVER',
      'SHOWDOWN',
      'HAND_END',
    ]);
    expect(state).toMatchObject({
      currentTurn: null,
      deadline: null,
      nextHandAt: 5100,
      runOutBoard: false,
    });
    expect(state.burned.map(cardId)).toEqual(['4c', '10d', '6c', '4s']);
    expect(state.pots).toEqual([{ amount: 120, eligible: [0, 1] }]);
    expect(state.results).toEqual([
      { playerId: 'p0', seatIndex: 0, chips: 260, delta: 60, handName: '一对' },
      { playerId: 'p1', seatIndex: 1, chips: 140, delta: -60, handName: '一对' },
    ]);
    expect(
      state.participants.every((p) => p.committedTotal === 0 && p.committedThisStreet === 0),
    ).toBe(true);
    expect(state.results.map((p) => p.delta).reduce((a, b) => a + b, 0)).toBe(0);
    expect(state.accounts.reduce((sum, p) => sum + p.chips, 0)).toBe(400);
    expect(startHand(state, context(5100)).phases).toEqual(['DEALING', 'PREFLOP']);
  });
  it('table projections preserve the short-all-in raise lock until the next street', () => {
    let state = startHand(table([200, 25, 200]), context()).newState;
    state = act(state, 0, { type: 'call' });
    state = act(state, 1, { type: 'allIn' });
    expect(state).toMatchObject({ currentBet: 25, lastRaiseSize: 20 });
    state = act(state, 2, { type: 'call' });
    expect(getTableLegalActions(state, 'p0')).toMatchObject({
      canRaise: false,
      canAllIn: false,
      callAmount: 5,
    });
    expect(() => applyAction(state, 0, { type: 'raise', totalBet: 45 }, context())).toThrow(
      expect.objectContaining({ code: 'INVALID_ACTION' }),
    );
    state = act(state, 0, { type: 'call' });
    expect(state).toMatchObject({
      phase: 'FLOP',
      currentTurn: 2,
      currentBet: 0,
      lastRaiseSize: 20,
    });
    expect(getTableLegalActions(state, 'p2').canRaise).toBe(true);
    state = checkDown(state);
    expect(state.accounts.map((p) => p.chips)).toEqual([175, 0, 250]);
    conserved(state);
  });
  it('BB keeps the option to raise after a limp', () => {
    const state = act(startHand(table(), context()).newState, 0, { type: 'call' });
    expect(state).toMatchObject({ currentTurn: 1, phase: 'PREFLOP' });
    expect(getTableLegalActions(state, 'p1').canRaise).toBe(true);
    const raised = act(state, 1, { type: 'raise', totalBet: 60 });
    expect(raised).toMatchObject({ currentBet: 60, lastRaiseSize: 40, currentTurn: 0 });
    checkDown(raised);
  });
  it('equal all-ins run out all streets in one update and reveal only to private recipients', () => {
    const state = act(startHand(table(), context()).newState, 0, { type: 'allIn' });
    const update = applyAction(state, 1, { type: 'call' }, context());
    expect(update.phases).toEqual(['FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'HAND_END']);
    expect(update.newState).toMatchObject({
      phase: 'HAND_END',
      runOutBoard: true,
      currentTurn: null,
    });
    expect(update.newState.pots).toEqual([{ amount: 400, eligible: [0, 1] }]);
    expect(update.newState.accounts.map((p) => p.chips)).toEqual([400, 0]);
    expect(update.events.filter((e) => e.t === 'board:deal')).toHaveLength(3);
    expect(update.events.filter((e) => e.t === 'turn:change')).toEqual([]);
    expect(update.privateMessages.filter((m) => m.message.t === 'showdown:reveal')).toHaveLength(4);
    expect(
      update.events.some((e) => 'holeCards' in e || e.t === 'deal:start' || 'burned' in e),
    ).toBe(false);
    conserved(update.newState);
  });
  it('layered all-ins produce 90/100/120 pots using the real evaluator', () => {
    let state = startHand(table([30, 80, 200]), context(0, 1)).newState;
    state = act(state, 0, { type: 'allIn' });
    state = act(state, 1, { type: 'allIn' });
    state = act(state, 2, { type: 'allIn' });
    expect(state.runOutBoard).toBe(true);
    expect(state.pots).toEqual([
      { amount: 90, eligible: [0, 1, 2] },
      { amount: 100, eligible: [1, 2] },
      { amount: 120, eligible: [2] },
    ]);
    // seed 1: p0 对 K 赢主池；p2 的 K-Q-J-8-7 高牌胜 p1 的 K-J-8-7-6。
    expect(state.participants.map((p) => p.holeCards.map(cardId))).toEqual([
      ['Qs', 'Kc'],
      ['7c', '6c'],
      ['Qh', '7d'],
    ]);
    expect(state.board.map(cardId)).toEqual(['8s', '5d', 'Jd', '3c', 'Ks']);
    expect(state.accounts.map((p) => p.chips)).toEqual([90, 0, 220]);
    expect(state.results.map((p) => p.delta)).toEqual([60, -80, 20]);
    expect(state.accounts.reduce((n, p) => n + p.chips, 0)).toBe(310);
  });
  it('one survivor takes every chip without evaluating or exposing any hand', () => {
    const state = startHand(table(), context()).newState;
    const update = applyAction(freeze(state), 0, { type: 'fold' }, context());
    expect(update.phases).toEqual(['HAND_END']);
    expect(update.newState.board).toEqual([]);
    expect(update.newState.accounts.map((p) => p.chips)).toEqual([190, 210]);
    expect(update.events).toContainEqual({
      t: 'pot:awarded',
      potIndex: 0,
      amount: 30,
      winners: [1],
      bestFive: [],
      handName: '其他玩家弃牌',
    });
    expect(update.events.some((e) => e.t === 'showdown:start')).toBe(false);
    expect(update.privateMessages).toEqual([]);
    expect(getPrivateMessages(update.newState, 'p0').map((m) => m.message.t)).toEqual([
      'deal:holeCards',
    ]);
    conserved(update.newState);
  });
  it('未跟到的部分退回原主：弃牌者多出来的钱不会被摊牌赢家顺走', () => {
    // 四人桌座位 2 的大盲只有 3 筹码 → 实际投入 3、currentBet 也只有 3。
    // 座位 3、0 各跟 3，小盲（已投 10，toCall 为 0）随后弃牌：它那 10 里有 7 没有任何还在手的人跟得到，
    // 真规则是"未跟到的部分退回原主"，所以池是 3×4 = 12 而不是 19，小盲只输被跟到的 3。
    const started = startHand(table([200, 200, 3, 200]), context()).newState;
    expect(started).toMatchObject({ dealerSeat: 0, sbSeat: 1, bbSeat: 2, currentBet: 3 });
    let state = act(started, 3, { type: 'call' });
    state = act(state, 0, { type: 'call' });
    // 小盲弃牌后场上还剩三人能行动，所以逐街过牌到摊牌（checkDown 自带守恒断言）。
    state = checkDown(act(state, 1, { type: 'fold' }));
    expect(state.phase).toBe('HAND_END');
    expect(state.pots).toEqual([{ amount: 12, eligible: [0, 2, 3] }]);
    // 谁赢取决于发牌，所以只断言与赢家无关的那三件事：弃牌的小盲只输 3、它拿回 7、
    // 并且在场的三人里恰好一个人净赢 9（= 12 的池 - 它自己的 3）。原来实现下池是 19，
    // 小盲会多输 7、赢家会多赢 7。
    expect(state.accounts.find((a) => a.id === 'p1')!.chips).toBe(197);
    expect(state.results.find((r) => r.playerId === 'p1')!.delta).toBe(-3);
    expect(state.results.filter((r) => r.delta === 9).map((r) => r.playerId)).toHaveLength(1);
    conserved(state);
  });
  it('folded money stays in the pot and folded cards never appear in reveals', () => {
    let state = startHand(table([200, 200, 200]), context()).newState;
    state = act(state, 0, { type: 'call' });
    state = act(state, 1, { type: 'fold' });
    state = checkDown(state);
    expect(state.pots).toEqual([{ amount: 50, eligible: [0, 2] }]);
    const reveals = getPrivateMessages(state, 'p1').filter(
      (m) => m.message.t === 'showdown:reveal',
    );
    expect(reveals.map((m) => m.message.t === 'showdown:reveal' && m.message.seatIndex)).toEqual([
      0, 2,
    ]);
    expect(
      new Set(
        [
          ...state.deck,
          ...state.burned,
          ...state.board,
          ...state.participants.flatMap((p) => p.holeCards),
        ].map(cardId),
      ).size,
    ).toBe(52);
  });
  it('rejects stale and duplicate commands while incrementing every new turn including same-seat streets', () => {
    const state = startHand(table(), context()).newState;
    const next = applyPlayerAction(
      state,
      'p0',
      { type: 'call' },
      state.handId,
      state.turnVersion,
      context(),
    ).newState;
    expect(next.turnVersion).toBe(state.turnVersion + 1);
    expect(() =>
      applyPlayerAction(next, 'p0', { type: 'call' }, state.handId, state.turnVersion, context()),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ACTION' }));
    expect(() =>
      applyPlayerAction(next, 'p1', { type: 'check' }, 'old', next.turnVersion, context()),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ACTION' }));
    const flop = act(next, 1, { type: 'check' }, 90);
    expect(flop.currentTurn).toBe(1);
    expect(flop.turnVersion).toBe(next.turnVersion + 1);
    expect(flop.deadline).toBe(30090);
  });
  it('uses exact deadlines at time zero, warns only in the final ten seconds, and auto folds/checks', () => {
    const initial = table();
    expect(tickTable(initial, context()).newState).toBe(initial);
    expect(getTimeoutWarning(initial, 0)).toBeNull();
    const state = startHand(initial, context()).newState;
    expect(getTimeoutWarning(state, 19999)).toBeNull();
    expect(getTimeoutWarning(state, 20000)).toEqual({
      playerId: 'p0',
      message: { t: 'timeoutWarning', remainingSec: 10 },
    });
    expect(getTimeoutWarning(state, 29001)?.message).toEqual({
      t: 'timeoutWarning',
      remainingSec: 1,
    });
    expect(getTimeoutWarning(state, 30000)).toBeNull();
    expect(tickTable(state, context(29999)).newState).toBe(state);
    const ended = tickTable(state, context(30000)).newState;
    expect(ended.phase).toBe('HAND_END');
    conserved(ended);
    expect(tickTable(ended, context(34999)).events).toEqual([]);
    expect(tickTable(ended, context(35000)).newState.handNo).toBe(2);
    const bb = act(state, 0, { type: 'call' });
    const flop = tickTable(bb, context(30000));
    expect(flop.events[0]).toMatchObject({
      t: 'action:made',
      seatIndex: 1,
      action: { type: 'check' },
    });
    expect(flop.newState.phase).toBe('FLOP');
  });
});
