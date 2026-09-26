import { describe, expect, it } from 'vitest';

import { awardPots, calculatePots } from '../src/engine';
import { award, expectAwards, expectPots, player, rankedHands, tiedHands } from './sidepot-fixtures';

describe('awardPots — 真实手牌、整数派彩及按钮后零头', () => {
  it('7 短码最好只能拿主池，边池由第二强者取得', () => {
    const pots = expectPots([player(0, 50), player(1, 100), player(2, 100)], [
      { amount: 150, eligible: [0, 1, 2] }, { amount: 100, eligible: [1, 2] },
    ]);
    expectAwards(pots, rankedHands(), 2, [award(0, 150, [[0, 150]]), award(1, 100, [[1, 100]])]);
  });

  it.each(Array.from({ length: 8 }, (_, index) => index))('8 两人平分 201，按钮在 %i', (button) => {
    const first = button < 2 || button === 7 ? 2 : 7;
    const second = first === 2 ? 7 : 2;
    expectAwards([{ amount: 201, eligible: [7, 2] }], tiedHands(), button, [
      award(0, 201, [[first, 101], [second, 100]]),
    ]);
  });

  it.each([
    { button: 0, seats: [2, 7, 0] }, { button: 1, seats: [2, 7, 0] },
    { button: 2, seats: [7, 0, 2] }, { button: 3, seats: [7, 0, 2] },
    { button: 4, seats: [7, 0, 2] }, { button: 5, seats: [7, 0, 2] },
    { button: 6, seats: [7, 0, 2] }, { button: 7, seats: [0, 2, 7] },
  ])('9 三人平分 100，按钮在 $button', ({ button, seats }) => {
    expectAwards([{ amount: 100, eligible: [7, 0, 2] }], tiedHands(), button, [
      award(0, 100, seats.map((seat, index) => [seat, index === 0 ? 34 : 33])),
    ]);
  });

  it('余两枚时依次派给不同赢家，金额少于人数也守恒', () => {
    expectAwards([{ amount: 2, eligible: [0, 2, 7] }], tiedHands(), 2, [
      award(0, 2, [[7, 1], [0, 1], [2, 0]]),
    ]);
  });

  it('较强但不在 eligible 的手牌不会拿到池；先弱后强正确替换赢家', () => {
    expectAwards([{ amount: 100, eligible: [2, 1] }], rankedHands(), 0, [award(0, 100, [[1, 100]])]);
  });

  it('不同池各自找赢家，空池数组不派彩', () => {
    expectAwards([], rankedHands(), 0, []);
    expectAwards([{ amount: 0, eligible: [0] }], rankedHands(), 0, [award(0, 0, [[0, 0]])]);
  });

  it('冻结输入与手牌不被修改，返回数组不与输入共享', () => {
    const hands = tiedHands();
    const pot = Object.freeze({ amount: 99, eligible: Object.freeze([0, 2, 7]) });
    const result = expectAwards(Object.freeze([pot]), hands, 7, [award(0, 99, [[0, 33], [2, 33], [7, 33]])]);
    expect(result[0]!.winners).not.toBe(pot.eligible);
  });
});

describe('边池无效输入不得吞筹码', () => {
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('拒绝无效投入 %s', (amount) => {
    expect(() => calculatePots([player(0, amount)])).toThrow(RangeError);
    expect(() => awardPots([{ amount, eligible: [0] }], rankedHands(), 0)).toThrow(RangeError);
  });

  it.each([-1, 8, 1.5, NaN])('拒绝非法座位/按钮 %s', (seat) => {
    expect(() => calculatePots([player(seat, 1)])).toThrow(RangeError);
    expect(() => awardPots([{ amount: 1, eligible: [seat] }], rankedHands(), 0)).toThrow(RangeError);
    expect(() => awardPots([], rankedHands(), seat)).toThrow(RangeError);
  });

  it('重复座位不能重复计算投入或参与平分', () => {
    expect(() => calculatePots([player(0, 10), player(0, 20)])).toThrow(RangeError);
    expect(() => awardPots([{ amount: 10, eligible: [0, 0] }], rankedHands(), 0)).toThrow(RangeError);
  });

  it('每项安全但总额越界也拒绝', () => {
    expect(() => calculatePots([player(0, Number.MAX_SAFE_INTEGER), player(1, 1)])).toThrow(RangeError);
    expect(() => awardPots([
      { amount: Number.MAX_SAFE_INTEGER, eligible: [0] }, { amount: 1, eligible: [1] },
    ], rankedHands(), 0)).toThrow(RangeError);
  });

  it('规格的全弃牌防御路径保留总额，但没有资格者不能结算', () => {
    const pots = expectPots([player(0, 10, true), player(2, 30, true)], [{ amount: 40, eligible: [] }]);
    expect(() => awardPots(pots, rankedHands(), 0)).toThrow(RangeError);
  });

  it('任何 eligible 缺少手牌都必须拒绝，不能静默改赢家', () => {
    expect(() => awardPots([{ amount: 100, eligible: [0, 7] }], rankedHands(), 0)).toThrow(RangeError);
  });
});
