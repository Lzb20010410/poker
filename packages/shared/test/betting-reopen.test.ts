import { describe, expect, it } from 'vitest';
import { act, player, reject, state } from './betting-fixtures';

describe('完整加注与短全下的行动权', () => {
  it('short allIn 保留增量，已行动者只能 call/fold', () => {
    const short = act(
      state({
        players: [
          player(0, { chips: 30 }),
          player(1, { hasActed: true, committedThisStreet: 20, committedTotal: 20 }),
          player(2),
        ],
      }),
      0,
      { type: 'allIn' },
    );
    expect(short.state.lastRaiseSize).toBe(20);
    expect(short.state.players.map((entry) => entry.hasActed)).toEqual([true, true, false]);
    expect(short.state.currentTurn).toBe(1);
    reject(short.state, 1, { type: 'raise', totalBet: 50 }, 'INVALID_ACTION');
    reject(short.state, 1, { type: 'allIn' }, 'INVALID_ACTION');
    expect(act(short.state, 1, { type: 'call' }).chipsDelta).toBe(10);
    expect(act(short.state, 1, { type: 'fold' }).state.players[1]?.folded).toBe(true);
  });

  it('完整 raise 只重开其他仍可行动者', () => {
    const result = act(
      state({
        players: [
          player(0),
          player(7, { hasActed: true }),
          player(2, { hasActed: true, folded: true }),
          player(3, { hasActed: true, allIn: true, chips: 0 }),
          player(4, { hasActed: true, sittingOut: true }),
          player(5),
        ],
      }),
      0,
      { type: 'raise', totalBet: 60 },
    );
    expect(result.state.players.map((entry) => entry.hasActed)).toEqual([
      true,
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(result.state.currentTurn).toBe(5);
    expect(result.state.lastRaiseSize).toBe(40);
  });

  it('short 后未行动者可完整 raise 并重开之前玩家', () => {
    const short = act(
      state({
        players: [
          player(0, { chips: 30 }),
          player(1),
          player(2, { hasActed: true, committedThisStreet: 20, committedTotal: 20 }),
        ],
      }),
      0,
      { type: 'allIn' },
    );
    reject(short.state, 1, { type: 'raise', totalBet: 49 }, 'RAISE_TOO_SMALL');
    const full = act(short.state, 1, { type: 'raise', totalBet: 50 });
    expect(full.state.players[2]?.hasActed).toBe(false);
    expect(act(full.state, 2, { type: 'raise', totalBet: 70 }).state.currentBet).toBe(70);
  });

  it.each([40, 60])('完整 allIn %i 重开已行动者并设置真实增量', (chips) => {
    const result = act(
      state({ players: [player(0, { chips }), player(1, { hasActed: true }), player(2)] }),
      0,
      { type: 'allIn' },
    );
    expect(result.state.players[1]?.hasActed).toBe(false);
    expect(result.state.lastRaiseSize).toBe(chips - 20);
    const minTotal = chips + (chips - 20);
    expect(act(result.state, 1, { type: 'raise', totalBet: minTotal }).state.currentBet).toBe(
      minTotal,
    );
  });

  it.each([5, 10])('已行动者剩余 %i 仍可全下不足/恰好跟注', (chips) => {
    const input = state({
      currentBet: 30,
      players: [
        player(0, { chips, hasActed: true, committedThisStreet: 20, committedTotal: 20 }),
        player(1),
        player(2),
      ],
    });
    for (const action of [{ type: 'allIn' }, { type: 'raise', totalBet: 999 }, { type: 'call' }]) {
      const result = act(input, 0, action);
      expect(result.chipsDelta).toBe(chips);
      expect(result.action).toEqual({ type: 'allIn' });
      expect(result.state.currentBet).toBe(30);
    }
  });

  it('已行动者不能借短码 allIn 或超额 raise 再加注', () => {
    const input = state({
      currentBet: 30,
      players: [
        player(0, { chips: 15, hasActed: true, committedThisStreet: 20, committedTotal: 20 }),
        player(1),
        player(2),
      ],
    });
    reject(input, 0, { type: 'allIn' }, 'INVALID_ACTION');
    reject(input, 0, { type: 'raise', totalBet: 999 }, 'INVALID_ACTION');
  });
});
