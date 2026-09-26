import { describe, expect, it } from 'vitest';
import { getRoundStatus, type RoundStatus } from '../src/engine';
import { freezeState, player, state } from './betting-fixtures';

const ongoing: RoundStatus = { roundEnded: false, runOutBoard: false, winnerSeat: null };
const ended: RoundStatus = { roundEnded: true, runOutBoard: false, winnerSeat: null };
const runout: RoundStatus = { roundEnded: true, runOutBoard: true, winnerSeat: null };

describe('结束条件', () => {
  it.each([
    [false, 10, false, ongoing],
    [false, 20, false, ongoing],
    [false, 10, true, ongoing],
    [false, 20, true, ended],
    [false, 30, true, ended],
    [true, 10, true, ongoing],
    [true, 20, false, runout],
    [true, 30, false, runout],
  ] as const)('对手 allIn=%s，本人投入=%s，已行动=%s', (allIn, committed, hasActed, expected) => {
    const input = freezeState(
      state({
        players: [
          player(0, { committedThisStreet: committed, hasActed }),
          player(7, { committedThisStreet: 20, hasActed: true, allIn }),
        ],
      }),
    );
    const before = JSON.stringify(input);
    expect(getRoundStatus(input)).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([10, 20])('所有人 allIn，投入 %i 不影响 runout', (committedThisStreet) => {
    expect(
      getRoundStatus(
        state({
          players: [
            player(0, { allIn: true, chips: 0, committedThisStreet }),
            player(7, { allIn: true, chips: 0, committedThisStreet: 20 }),
          ],
        }),
      ),
    ).toEqual(runout);
  });

  it('fold/sittingOut 不阻塞正常结束', () => {
    expect(
      getRoundStatus(
        state({
          players: [
            player(0, { committedThisStreet: 20, hasActed: true }),
            player(2, { committedThisStreet: 20, hasActed: true }),
            player(4, { folded: true }),
            player(7, { sittingOut: true }),
          ],
        }),
      ),
    ).toEqual(ended);
  });

  it('sittingOut 不算有行动能力', () => {
    expect(
      getRoundStatus(
        state({
          players: [player(0, { committedThisStreet: 20 }), player(7, { sittingOut: true })],
        }),
      ),
    ).toEqual(runout);
  });
});
