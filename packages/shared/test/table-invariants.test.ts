import { describe, expect, it } from 'vitest';
import { cardId, type Action } from '../src/types';
import { mulberry32 } from '../src/engine/random';
import { applyPlayerAction, getTableLegalActions, startHand, tickTable } from '../src/engine/table';
import { conserved, context, freeze, table } from './table-fixtures';

describe('seeded full-hand invariants (real rules, not payout oracles)', () => {
  it.each([2, 3, 4, 5, 6, 7, 8])(
    '%i players: 20 complete hands conserve assets after every accepted command',
    (count) => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const initial = table(Array.from({ length: count }, (_, i) => 30 + i * 25));
        let state = startHand(freeze(initial), context(0, seed)).newState;
        const rand = mulberry32(seed + 100);
        let steps = 0;
        while (state.currentTurn !== null && steps < 150) {
          const actor = state.participants.find((p) => p.seatIndex === state.currentTurn)!;
          const legal = getTableLegalActions(state, actor.playerId);
          const choice = rand();
          let action: Action = { type: legal.canCheck ? 'check' : 'call' };
          if (choice < 0.1) action = { type: 'fold' };
          else if (choice < 0.25 && legal.canAllIn) action = { type: 'allIn' };
          else if (choice < 0.4 && legal.canRaise)
            action = { type: 'raise', totalBet: legal.minRaiseTotal };
          const before = structuredClone(state);
          const applied = applyPlayerAction(
            freeze(state),
            actor.playerId,
            action,
            state.handId,
            state.turnVersion,
            context(steps),
          );
          expect(state).toEqual(before);
          expect(applied.events[0]?.t).toBe('action:made');
          state = applied.newState;
          conserved(state);
          steps += 1;
        }
        expect(state.phase).toBe('HAND_END');
        expect(state.accounts.reduce((sum, a) => sum + a.chips, 0)).toBe(initial.introducedChips);
        expect(state.results.reduce((sum, result) => sum + result.delta, 0)).toBe(0);
        expect(state.participants.every((p) => p.committedTotal === 0)).toBe(true);
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
        const next = tickTable(freeze(state), context(state.nextHandAt!, seed + 200)).newState;
        conserved(next);
        expect(next.introducedChips).toBe(initial.introducedChips);
      }
    },
  );
});
