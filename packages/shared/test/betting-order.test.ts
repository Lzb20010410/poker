import { describe, expect, it } from 'vitest';
import { nextToAct } from '../src/engine';
import { freezeState, player, state } from './betting-fixtures';

describe('查找仍需行动的玩家', () => {
  it.each([
    {
      name: '跳过 fold/allIn/sittingOut',
      players: [
        player(1, { folded: true }),
        player(2, { allIn: true }),
        player(3, { sittingOut: true }),
        player(6),
      ],
      after: 0,
      next: 6,
    },
    {
      name: '跳过已匹配且已行动',
      players: [player(1, { hasActed: true, committedThisStreet: 20 }), player(6)],
      after: 0,
      next: 6,
    },
    {
      name: '已行动仍欠注',
      players: [player(3, { hasActed: true, committedThisStreet: 10 })],
      after: 0,
      next: 3,
    },
    {
      name: 'BB 未行动仍有 option',
      players: [player(3, { committedThisStreet: 20 })],
      after: 0,
      next: 3,
    },
    { name: '整圈可回到自己', players: [player(3)], after: 3, next: 3 },
    {
      name: '超额匹配且已行动',
      players: [player(3, { hasActed: true, committedThisStreet: 30 })],
      after: 0,
      next: null,
    },
    {
      name: '全部跳过',
      players: [player(3, { folded: true }), player(7, { allIn: true })],
      after: 0,
      next: null,
    },
    { name: '空桌', players: [], after: 0, next: null },
  ])('$name', ({ players, after, next }) => {
    const input = freezeState(state({ players }));
    const before = JSON.stringify(input);
    expect(nextToAct(input, after)).toBe(next);
    expect(JSON.stringify(input)).toBe(before);
  });
});
