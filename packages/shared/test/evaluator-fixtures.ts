import { expect } from 'vitest';

import { compare, type HandResult } from '../src/engine';
import { cardId, parseCardId, type Card } from '../src/types';

export function cards(ids: string): Card[] {
  return ids.split(' ').map(parseCardId);
}

/** 先检查人工 fixture，避免把错误的发牌误当成评估器缺陷。 */
export function seven(ids: string): Card[] {
  const hand = cards(ids);
  expect(hand).toHaveLength(7);
  expect(new Set(hand.map(cardId)).size).toBe(7);
  return hand;
}

export function expectBestFive(result: HandResult, input: readonly Card[], expected: string): void {
  expect(result.bestFive.map(cardId)).toEqual(expected.split(' '));
  expect(result.bestFive).toHaveLength(5);
  expect(new Set(result.bestFive.map(cardId)).size).toBe(5);
  for (const card of result.bestFive) expect(input).toContainEqual(card);
  expect(Number.isSafeInteger(result.score)).toBe(true);
}

/** 每个比牌 fixture 都验证双向符号及 score 与平局的等价关系。 */
export function expectOrder(a: HandResult, b: HandResult, order: -1 | 0 | 1): void {
  expect(compare(a, b)).toBe(order);
  expect(compare(b, a)).toBe(order === 0 ? 0 : -order);
  expect(compare(a, a)).toBe(0);
  expect(compare(b, b)).toBe(0);
  expect(a.score === b.score).toBe(order === 0);
  expect(compare(a, b) === 0).toBe(a.score === b.score);
  expect(compare(b, a) === 0).toBe(b.score === a.score);
  if (order === 1) expect(a.score).toBeGreaterThan(b.score);
  if (order === -1) expect(a.score).toBeLessThan(b.score);
}
