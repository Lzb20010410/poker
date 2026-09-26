import { describe, expect, it } from 'vitest';

import { createDeck, evaluate7 } from '../src/engine';
import { parseCardId } from '../src/types';
import { cards } from './evaluator-fixtures';

describe('evaluate7 输入校验', () => {
  it.each([0, 1, 5, 6, 8, 52])('拒绝 %i 张牌，提示必须恰好七张', (length) => {
    expect(() => evaluate7(createDeck().slice(0, length))).toThrow(/7.*张|七张/);
  });

  it('按牌值拒绝不同对象表示的重复牌', () => {
    expect(() => evaluate7(cards('As Kh Qd 9c 7s 4h As'))).toThrow(/重复.*As|As.*重复/);
  });

  it('拒绝同一张牌对象重复出现', () => {
    const ace = parseCardId('As');
    expect(() => evaluate7([ace, ...cards('Kh Qd 9c 7s 4h'), ace])).toThrow(/重复.*As|As.*重复/);
  });

  // 模拟 JS 调用方的非法属性，不用类型断言伪造合法 Card。
  it.each([1, 0, 15, -2, 2.5, NaN, Infinity, '14', undefined, null])('拒绝非法点数 %s', (rank) => {
    const card = parseCardId('As');
    Reflect.set(card, 'rank', rank);
    expect(() => evaluate7([card, ...cards('Kh Qd 9c 7s 4h 2d')])).toThrow(/非法.*点数/);
  });

  it.each(['x', 'S', 'spades', '', 0, null, undefined])('拒绝非法花色 %s', (suit) => {
    const card = parseCardId('As');
    Reflect.set(card, 'suit', suit);
    expect(() => evaluate7([card, ...cards('Kh Qd 9c 7s 4h 2d')])).toThrow(/非法.*花色/);
  });
});
