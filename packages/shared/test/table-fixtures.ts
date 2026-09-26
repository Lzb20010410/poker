import { expect } from 'vitest';
import { DEFAULT_TABLE_CONFIG, type Action } from '../src/types';
import { mulberry32 } from '../src/engine/random';
import { applyAction, createTable, type TableContext, type TableState } from '../src/engine/table';

export function context(now = 0, seed = 42): TableContext {
  return { now, rand: mulberry32(seed) };
}
export function table(
  chips: readonly number[] = [200, 200],
  seats = chips.map((_, i) => i),
): TableState {
  return createTable(
    DEFAULT_TABLE_CONFIG,
    chips.map((amount, i) => ({
      id: `p${String(i)}`,
      nickname: `Player${String(i)}`,
      avatarSeed: `seed${String(i)}`,
      seatIndex: seats[i]!,
      chips: amount,
    })),
  );
}
export function conserved(state: TableState): void {
  expect(
    state.accounts.reduce((sum, p) => sum + p.chips, 0) +
      state.participants.reduce((sum, p) => sum + p.committedTotal, 0),
  ).toBe(state.introducedChips);
  for (const p of state.accounts) {
    expect(Number.isSafeInteger(p.chips)).toBe(true);
    expect(p.chips).toBeGreaterThanOrEqual(0);
  }
}
export function act(state: TableState, seat: number, action: Action, now = 0): TableState {
  const update = applyAction(freeze(state), seat, freeze(action), context(now));
  conserved(update.newState);
  return update.newState;
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function checkDown(state: TableState): TableState {
  let next = state;
  for (let i = 0; i < 40 && next.currentTurn !== null; i += 1) {
    const p = next.participants.find((p) => p.seatIndex === next.currentTurn)!;
    next = act(next, p.seatIndex, {
      type: p.committedThisStreet < next.currentBet ? 'call' : 'check',
    });
  }
  expect(next.phase).toBe('HAND_END');
  conserved(next);
  return next;
}
