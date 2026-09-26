import { expect } from 'vitest';

import {
  applyBettingAction,
  RuleError,
  type BettingState,
  type BettingUpdate,
  type ErrorCode,
} from '../src/engine';
import { type PlayerHandState } from '../src/types';

export function player(
  seatIndex: number,
  overrides: Partial<PlayerHandState> = {},
): PlayerHandState {
  return {
    seatIndex,
    chips: 1000,
    holeCards: [],
    folded: false,
    allIn: false,
    committedThisStreet: 0,
    committedTotal: 0,
    hasActed: false,
    sittingOut: false,
    ...overrides,
  };
}

export function state(overrides: Partial<BettingState> = {}): BettingState {
  return {
    players: [player(0), player(1), player(2)],
    phase: 'PREFLOP',
    currentBet: 20,
    lastRaiseSize: 20,
    currentTurn: 0,
    ...overrides,
  };
}

export function freezeState(input: BettingState): BettingState {
  for (const entry of input.players) {
    for (const card of entry.holeCards) Object.freeze(card);
    Object.freeze(entry.holeCards);
    Object.freeze(entry);
  }
  Object.freeze(input.players);
  return Object.freeze(input);
}

export function act(input: BettingState, seatIndex: number, action: unknown): BettingUpdate {
  const before = JSON.stringify(input);
  const result = applyBettingAction(freezeState(input), seatIndex, action);
  expect(JSON.stringify(input)).toBe(before);
  expect(result.state).not.toBe(input);
  expect(result.state.players).not.toBe(input.players);
  expect(result.state.players.map((entry) => entry.seatIndex)).toEqual(
    input.players.map((entry) => entry.seatIndex),
  );
  let spent = 0;
  for (const entry of result.state.players) {
    const original = input.players.find((candidate) => candidate.seatIndex === entry.seatIndex)!;
    expect(entry.chips + entry.committedTotal).toBe(original.chips + original.committedTotal);
    expect(entry.committedTotal - original.committedTotal).toBe(
      entry.committedThisStreet - original.committedThisStreet,
    );
    expect(entry.holeCards).toEqual(original.holeCards);
    for (const amount of [entry.chips, entry.committedTotal, entry.committedThisStreet]) {
      expect(Number.isSafeInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThanOrEqual(0);
    }
    spent += original.chips - entry.chips;
  }
  expect(result.chipsDelta).toBe(spent);
  expect(result.state.phase).toBe(input.phase);
  return result;
}

export function reject(
  input: BettingState,
  seatIndex: number,
  action: unknown,
  code: ErrorCode,
): void {
  const before = JSON.stringify(input);
  expect(() => applyBettingAction(freezeState(input), seatIndex, action)).toThrow(RuleError);
  expect(() => applyBettingAction(input, seatIndex, action)).toThrow(
    expect.objectContaining({ code }),
  );
  expect(JSON.stringify(input)).toBe(before);
}
