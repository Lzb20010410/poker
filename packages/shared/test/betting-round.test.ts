import { describe, expect, it } from 'vitest';
import {
  getRoundStatus,
  getTimeoutAction,
  nextToAct,
  RuleError,
  type RoundStatus,
} from '../src/engine';
import { act, freezeState, player, reject, state } from './betting-fixtures';

const ongoing: RoundStatus = { roundEnded: false, runOutBoard: false, winnerSeat: null };
const ended: RoundStatus = { roundEnded: true, runOutBoard: false, winnerSeat: null };
const runout: RoundStatus = { roundEnded: true, runOutBoard: true, winnerSeat: null };

describe('BB option 与结束条件顺序', () => {
  it('全员只 call 到 BB，BB 仍可 check 或 raise', () => {
    const input = state({
      currentTurn: 2,
      players: [
        player(0, { committedThisStreet: 10, committedTotal: 10 }),
        player(1, { committedThisStreet: 20, committedTotal: 20 }),
        player(2),
      ],
    });
    const utg = act(input, 2, { type: 'call' });
    expect(utg.state.currentTurn).toBe(0);
    const sb = act(utg.state, 0, { type: 'call' });
    expect(sb).toMatchObject(ongoing);
    expect(sb.state.currentTurn).toBe(1);
    expect(sb.state.players[1]?.hasActed).toBe(false);
    const check = act(sb.state, 1, { type: 'check' });
    expect(check).toMatchObject(ended);
    expect(check.state.currentTurn).toBeNull();
    const raise = act(sb.state, 1, { type: 'raise', totalBet: 40 });
    expect(raise).toMatchObject(ongoing);
    expect(raise.state.currentTurn).toBe(2);
    expect(raise.state.players.map((entry) => entry.hasActed)).toEqual([false, true, false]);
  });

  /**
   * 规则边界（M1 审查提出、复核后维持原判定）：翻牌前的大盲 option 指的是
   * "没人加注时他还可以过牌或加注"，前提是**后面还有人能跟**。
   * 这里小盲已弃牌、后位只剩不足额全下的一人，大盲是唯一还有筹码的人 ——
   * 他加注没人能跟，所以本街直接关门跑公共牌，多出来的那部分由 §4.2 的
   * "未跟到的钱退回原主"处理。刻意留着这条测试：把它改成"给大盲一次行动机会"
   * 看起来更像真扑克，实际会让大盲能对着空气下注。
   */
  it('小盲弃牌 + 后位不足额全下时，大盲不再被问一次，直接跑完公共牌', () => {
    const preflop = state({
      currentTurn: 2,
      players: [
        player(0, { committedThisStreet: 10, committedTotal: 10, folded: true }),
        player(1, { committedThisStreet: 20, committedTotal: 20 }),
        player(2, { chips: 15 }),
      ],
    });
    const shove = act(preflop, 2, { type: 'allIn' });
    expect(shove).toMatchObject(runout);
    expect(shove.state.currentTurn).toBeNull();
    expect(shove.state.currentBet).toBe(20);
    // 大盲不能对空气下注：这一步必须被拒
    reject(shove.state, 1, { type: 'raise', totalBet: 40 }, 'HAND_NOT_STARTED');
  });

  it('翻牌后只剩一人能行动时不给他多余的行动机会，直接跑完公共牌', () => {
    const flop = state({
      phase: 'FLOP',
      currentTurn: 0,
      currentBet: 0,
      players: [
        player(0, { chips: 1000 }),
        player(1, { allIn: true, chips: 0 }),
        player(2, { folded: true }),
      ],
    });
    expect(getRoundStatus(freezeState(flop))).toEqual(runout);
  });

  it('最后一个对手 fold，立即结束且不亮牌，即使赢家已经 allIn', () => {
    const result = act(
      state({
        players: [
          player(0, {
            holeCards: [
              { rank: 14, suit: 's' },
              { rank: 14, suit: 'h' },
            ],
          }),
          player(7, { allIn: true, chips: 0, committedThisStreet: 20, committedTotal: 20 }),
        ],
      }),
      0,
      { type: 'fold' },
    );
    expect(result).toEqual({
      state: result.state,
      action: { type: 'fold' },
      chipsDelta: 0,
      roundEnded: true,
      runOutBoard: false,
      winnerSeat: 7,
    });
    expect(result.state.currentTurn).toBeNull();
  });

  it('最后一人 allIn 后终止并清空 currentTurn', () => {
    const result = act(
      state({
        players: [
          player(0, { chips: 20 }),
          player(1, { allIn: true, chips: 0, committedThisStreet: 20, committedTotal: 20 }),
        ],
      }),
      0,
      { type: 'call' },
    );
    expect(result).toMatchObject(runout);
    expect(result.state.currentTurn).toBeNull();
  });

  it('空桌没有结束事件', () => {
    expect(getRoundStatus(freezeState(state({ players: [] })))).toEqual(ongoing);
  });

  it('顺时针查询不会修改无序座位数组，并从 7 wrap 到 1', () => {
    const input = freezeState(state({ players: [player(7), player(3), player(1)] }));
    expect(nextToAct(input, 0)).toBe(1);
    expect(nextToAct(input, 1)).toBe(3);
    expect(nextToAct(input, 7)).toBe(1);
    expect(input.players.map((entry) => entry.seatIndex)).toEqual([7, 3, 1]);
  });
});

describe('超时托管', () => {
  it.each([0, 10, 20, 30])('当前玩家本街投入 %i 时自动 check/fold', (committedThisStreet) => {
    const input = freezeState(
      state({
        currentTurn: 7,
        players: [
          player(0),
          player(7, { committedThisStreet, committedTotal: committedThisStreet }),
        ],
      }),
    );
    const before = JSON.stringify(input);
    const action = getTimeoutAction(input);
    expect(action).toEqual({ type: committedThisStreet >= 20 ? 'check' : 'fold' });
    expect(JSON.stringify(input)).toBe(before);
    expect(act(input, 7, action).chipsDelta).toBe(0);
  });

  it('无当前行动者时报 RuleError', () => {
    expect(() => getTimeoutAction(state({ currentTurn: null }))).toThrow(RuleError);
    expect(() => getTimeoutAction(state({ currentTurn: null }))).toThrow(
      expect.objectContaining({ code: 'HAND_NOT_STARTED' }),
    );
  });

  it('当前座位非法时同样复用行动资格校验', () => {
    expect(() => getTimeoutAction(state({ currentTurn: 7 }))).toThrow(
      expect.objectContaining({ code: 'NOT_SEATED' }),
    );
  });
});
