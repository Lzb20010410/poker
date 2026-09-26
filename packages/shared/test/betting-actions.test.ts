import { describe, expect, it } from 'vitest';

import { RuleError, type ErrorCode } from '../src/engine';
import { type Action, type Phase } from '../src/types';
import { act, player, reject, state } from './betting-fixtures';

const actions: readonly Action[] = [
  { type: 'fold' },
  { type: 'check' },
  { type: 'call' },
  { type: 'raise', totalBet: 40 },
  { type: 'allIn' },
];

describe('下注动作与输入边界', () => {
  it.each(actions)('$type 拒绝非当前行动者', (action) => {
    reject(state(), 1, action, 'NOT_YOUR_TURN');
  });

  it.each(actions)('$type 拒绝已弃牌者', (action) => {
    reject(
      state({ players: [player(0, { folded: true }), player(1)] }),
      0,
      action,
      'ALREADY_FOLDED',
    );
  });

  it.each(actions)('$type 拒绝已全下者', (action) => {
    reject(
      state({ players: [player(0, { allIn: true, chips: 0 }), player(1)] }),
      0,
      action,
      'ALREADY_ALLIN',
    );
  });

  it.each(actions)('$type 拒绝离座者', (action) => {
    reject(
      state({ players: [player(0, { sittingOut: true }), player(1)] }),
      0,
      action,
      'INVALID_ACTION',
    );
  });

  it.each(actions)('$type 拒绝未入座者', (action) => {
    reject(state(), 7, action, 'NOT_SEATED');
  });

  it.each<Phase>(['IDLE', 'DEALING', 'SHOWDOWN', 'HAND_END'])('%s 阶段禁止行动', (phase) => {
    for (const action of actions) reject(state({ phase }), 0, action, 'HAND_NOT_STARTED');
  });

  it('没有当前行动者时拒绝动作', () => {
    reject(state({ currentTurn: null }), 0, { type: 'fold' }, 'HAND_NOT_STARTED');
  });

  it.each<Phase>(['PREFLOP', 'FLOP', 'TURN', 'RIVER'])('%s 阶段允许行动', (phase) => {
    expect(act(state({ phase }), 0, { type: 'call' }).chipsDelta).toBe(20);
  });

  it.each([
    undefined,
    null,
    true,
    1,
    'fold',
    [],
    ['fold'],
    {},
    { type: null },
    { type: 1 },
    { type: 'ALLIN' },
    { type: 'allin' },
    { type: ' fold' },
    { type: 'constructor' },
    { type: 'toString' },
    { type: 'bet' },
  ])('拒绝未知输入 %#', (input) => {
    reject(state(), 0, input, 'INVALID_ACTION');
  });

  it.each([
    undefined,
    null,
    '40',
    NaN,
    Infinity,
    -Infinity,
    -1,
    0,
    20.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('拒绝非法 raise 金额 %s', (totalBet) => {
    reject(state(), 0, { type: 'raise', totalBet }, 'INVALID_ACTION');
  });

  it('忽略客户端伪造的额外状态字段，返回规范动作', () => {
    const result = act(state(), 0, Object.freeze({ type: 'call', chipsDelta: -500, allIn: true }));
    expect(result.action).toEqual({ type: 'call' });
    expect(result.state.players[0]).toMatchObject({ chips: 980, allIn: false, hasActed: true });
  });

  it('fold 不扣筹码，推进到下一位', () => {
    const result = act(state(), 0, { type: 'fold' });
    expect(result.action).toEqual({ type: 'fold' });
    expect(result.chipsDelta).toBe(0);
    expect(result.state.players[0]).toMatchObject({ folded: true, hasActed: true, chips: 1000 });
    expect(result.state.currentTurn).toBe(1);
  });

  it('无需跟注也允许 fold', () => {
    expect(act(state({ currentBet: 0 }), 0, { type: 'fold' }).state.players[0]?.folded).toBe(true);
  });

  it('check 不投入但标记已行动', () => {
    const result = act(state({ currentBet: 0 }), 0, { type: 'check' });
    expect(result.action).toEqual({ type: 'check' });
    expect(result.chipsDelta).toBe(0);
    expect(result.state.players[0]?.hasActed).toBe(true);
  });

  it('欠注时不能 check', () => {
    reject(state(), 0, { type: 'check' }, 'INVALID_ACTION');
  });

  it('匹配后不能 call', () => {
    reject(state({ currentBet: 0 }), 0, { type: 'call' }, 'INVALID_ACTION');
  });

  it('call 只扣本街差额，不混同此前街的累计投入', () => {
    const result = act(
      state({
        players: [player(0, { committedThisStreet: 10, committedTotal: 210 }), player(1)],
      }),
      0,
      { type: 'call' },
    );
    expect(result.chipsDelta).toBe(10);
    expect(result.state.players[0]).toMatchObject({
      chips: 990,
      committedThisStreet: 20,
      committedTotal: 220,
    });
    expect(result.state.currentBet).toBe(20);
  });

  it.each([10, 20])('call 剩余 %i 筹码自动返回 allIn', (chips) => {
    const result = act(state({ players: [player(0, { chips }), player(1)] }), 0, { type: 'call' });
    expect(result.chipsDelta).toBe(chips);
    expect(result.action).toEqual({ type: 'allIn' });
    expect(result.state.players[0]).toMatchObject({
      allIn: true,
      chips: 0,
      committedThisStreet: chips,
    });
    expect(result.state.currentBet).toBe(20);
  });

  it('raise 使用目标总额，保留跨街累计投入', () => {
    const result = act(
      state({
        players: [player(0, { committedThisStreet: 10, committedTotal: 210 }), player(1)],
      }),
      0,
      { type: 'raise', totalBet: 60 },
    );
    expect(result.action).toEqual({ type: 'raise', totalBet: 60 });
    expect(result.chipsDelta).toBe(50);
    expect(result.state.players[0]).toMatchObject({
      chips: 950,
      committedThisStreet: 60,
      committedTotal: 260,
    });
    expect(result.state.currentBet).toBe(60);
    expect(result.state.lastRaiseSize).toBe(40);
  });

  it.each([10, 20])('非全下 raise 至 %i 未提高 currentBet', (totalBet) => {
    reject(state(), 0, { type: 'raise', totalBet }, 'INVALID_ACTION');
  });

  it('raise 不得把自己的本街投入倒扣为筹码', () => {
    reject(
      state({
        currentBet: 5,
        players: [player(0, { committedThisStreet: 50, committedTotal: 50 }), player(1)],
      }),
      0,
      { type: 'raise', totalBet: 30 },
      'INVALID_ACTION',
    );
  });

  it('非全下小于最小增量被拒', () => {
    reject(state(), 0, { type: 'raise', totalBet: 39 }, 'RAISE_TOO_SMALL');
  });

  it('恰好最小总额合法', () => {
    const result = act(state(), 0, { type: 'raise', totalBet: 40 });
    expect(result.state.currentBet).toBe(40);
    expect(result.state.lastRaiseSize).toBe(20);
  });

  it.each([50, Number.MAX_SAFE_INTEGER])('raise %s 截断到全部筹码并报告 allIn', (totalBet) => {
    const result = act(
      state({
        players: [player(0, { chips: 40, committedThisStreet: 10, committedTotal: 90 }), player(1)],
      }),
      0,
      { type: 'raise', totalBet },
    );
    expect(result.chipsDelta).toBe(40);
    expect(result.action).toEqual({ type: 'allIn' });
    expect(result.state.players[0]).toMatchObject({
      chips: 0,
      allIn: true,
      committedThisStreet: 50,
      committedTotal: 130,
    });
    expect(result.state.currentBet).toBe(50);
    expect(result.state.lastRaiseSize).toBe(30);
  });

  it.each([10, 20, 30])('超额 raise 截为 %i 的不足跟注、恰好跟注或短加注', (chips) => {
    const result = act(state({ players: [player(0, { chips }), player(1), player(2)] }), 0, {
      type: 'raise',
      totalBet: 1000,
    });
    expect(result.action).toEqual({ type: 'allIn' });
    expect(result.chipsDelta).toBe(chips);
    expect(result.state.currentBet).toBe(Math.max(20, chips));
    expect(result.state.lastRaiseSize).toBe(20);
  });

  it.each([10, 20, 30, 40, 60])('显式 allIn %i 正确分类', (chips) => {
    const result = act(state({ players: [player(0, { chips }), player(1), player(2)] }), 0, {
      type: 'allIn',
    });
    expect(result.action).toEqual({ type: 'allIn' });
    expect(result.chipsDelta).toBe(chips);
    expect(result.state.currentBet).toBe(Math.max(20, chips));
    expect(result.state.lastRaiseSize).toBe(chips >= 40 ? chips - 20 : 20);
    expect(result.state.players[0]).toMatchObject({ allIn: true, chips: 0, hasActed: true });
  });

  it.each<Action>([{ type: 'allIn' }, { type: 'raise', totalBet: 40 }])(
    '零余额不能主动 $type',
    (action) => {
      reject(
        state({ players: [player(0, { chips: 0 }), player(1)] }),
        0,
        action,
        'INSUFFICIENT_CHIPS',
      );
    },
  );

  it('短 BB 小于 SB 的实际投入时 check 合法且不改 currentBet', () => {
    const input = state({
      currentBet: 5,
      players: [player(0, { committedThisStreet: 10, committedTotal: 10 }), player(1)],
    });
    const result = act(input, 0, { type: 'check' });
    expect(result.chipsDelta).toBe(0);
    expect(result.state.currentBet).toBe(5);
    reject(input, 0, { type: 'call' }, 'INVALID_ACTION');
  });
});

describe('RuleError 协议错误码', () => {
  const codes: readonly ErrorCode[] = [
    'NOT_YOUR_TURN',
    'INVALID_ACTION',
    'RAISE_TOO_SMALL',
    'INSUFFICIENT_CHIPS',
    'ALREADY_FOLDED',
    'ALREADY_ALLIN',
    'HAND_NOT_STARTED',
    'NOT_SEATED',
    'NOT_HOST',
    'ROOM_FULL',
    'CONFIG_LOCKED',
  ];
  it.each(codes)('%s 保留 code/message 和 Error 原型', (code) => {
    const error = new RuleError(code, '测试规则错误');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RuleError);
    expect(error.name).toBe('RuleError');
    expect(error.code).toBe(code);
    expect(error.message).toBe('测试规则错误');
  });
});
