import { describe, expect, it } from 'vitest';
import { applyBettingAction, getLegalActions, RuleError, type LegalActions } from '../src/engine';
import { type Action } from '../src/types';
import { act, freezeState, player, state } from './betting-fixtures';

const disabled: LegalActions = {
  canFold: false,
  canCheck: false,
  callAmount: 0,
  canRaise: false,
  minRaiseTotal: 0,
  maxRaiseTotal: 0,
  canAllIn: false,
};

describe('服务端权威合法动作提示', () => {
  it.each([
    { input: state(), seat: 1 },
    { input: state(), seat: 7 },
    { input: state({ phase: 'IDLE' }), seat: 0 },
    { input: state({ currentTurn: null }), seat: 0 },
    { input: state({ players: [player(0, { folded: true }), player(1)] }), seat: 0 },
    { input: state({ players: [player(0, { allIn: true }), player(1)] }), seat: 0 },
    { input: state({ players: [player(0, { sittingOut: true }), player(1)] }), seat: 0 },
  ])('不可行动者全禁用 %#', ({ input, seat }) => {
    expect(getLegalActions(freezeState(input), seat)).toEqual(disabled);
  });

  it.each([
    { chips: 100, committed: 0, acted: false, check: false, call: 20, raise: true, allIn: true },
    { chips: 100, committed: 20, acted: false, check: true, call: 0, raise: true, allIn: true },
    { chips: 10, committed: 0, acted: false, check: false, call: 10, raise: false, allIn: true },
    { chips: 20, committed: 0, acted: false, check: false, call: 20, raise: false, allIn: true },
    { chips: 30, committed: 0, acted: false, check: false, call: 20, raise: false, allIn: true },
    { chips: 40, committed: 0, acted: false, check: false, call: 20, raise: true, allIn: true },
    { chips: 100, committed: 10, acted: true, check: false, call: 10, raise: false, allIn: false },
    { chips: 5, committed: 10, acted: true, check: false, call: 5, raise: false, allIn: true },
    { chips: 10, committed: 10, acted: true, check: false, call: 10, raise: false, allIn: true },
    { chips: 15, committed: 10, acted: true, check: false, call: 10, raise: false, allIn: false },
    { chips: 0, committed: 20, acted: false, check: true, call: 0, raise: false, allIn: false },
    { chips: 100, committed: 30, acted: false, check: true, call: 0, raise: true, allIn: true },
  ])('余额=$chips 本街=$committed 已行动=$acted', (sample) => {
    const input = freezeState(
      state({
        players: [
          player(0, {
            chips: sample.chips,
            committedThisStreet: sample.committed,
            committedTotal: sample.committed + 100,
            hasActed: sample.acted,
          }),
          player(1),
          player(2),
        ],
      }),
    );
    const before = JSON.stringify(input);
    const legal = getLegalActions(input, 0);
    expect(legal).toEqual({
      canFold: true,
      canCheck: sample.check,
      callAmount: sample.call,
      canRaise: sample.raise,
      canAllIn: sample.allIn,
      minRaiseTotal: 40,
      maxRaiseTotal: sample.committed + sample.chips,
    });
    const candidates: readonly (readonly [Action, boolean])[] = [
      [{ type: 'fold' }, legal.canFold],
      [{ type: 'check' }, legal.canCheck],
      [{ type: 'call' }, legal.callAmount > 0],
      [{ type: 'allIn' }, legal.canAllIn],
    ];
    for (const [action, allowed] of candidates) {
      if (allowed) act(input, 0, action);
      else expect(() => applyBettingAction(input, 0, action)).toThrow(RuleError);
    }
    if (legal.canRaise) {
      act(input, 0, { type: 'raise', totalBet: legal.minRaiseTotal });
      act(input, 0, { type: 'raise', totalBet: legal.maxRaiseTotal });
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it('加注滑杆使用真实上次增量和本街筹码，而非固定 BB 或累计投入', () => {
    const input = state({
      currentBet: 60,
      lastRaiseSize: 40,
      players: [player(0, { chips: 150, committedThisStreet: 10, committedTotal: 210 }), player(1)],
    });
    expect(getLegalActions(input, 0)).toMatchObject({
      minRaiseTotal: 100,
      maxRaiseTotal: 160,
      callAmount: 50,
      canRaise: true,
    });
    expect(act(input, 0, { type: 'raise', totalBet: 100 }).state.currentBet).toBe(100);
    expect(() =>
      applyBettingAction(freezeState(input), 0, { type: 'raise', totalBet: 99 }),
    ).toThrow(RuleError);
  });
});
