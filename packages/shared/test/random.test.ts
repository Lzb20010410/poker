import { describe, expect, it } from 'vitest';

import { cryptoRandom, mulberry32, randomInt } from '../src/engine/random';

describe('mulberry32', () => {
  it('同一 seed 产生完全相同的序列（可复现是回归测试的前提）', () => {
    const a = mulberry32(20260925);
    const b = mulberry32(20260925);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('不同 seed 产生不同序列', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('输出始终落在 [0, 1)', () => {
    const rand = mulberry32(123456);
    for (let i = 0; i < 100_000; i += 1) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('连续调用不会卡住（不是常量序列）', () => {
    const rand = mulberry32(7);
    const uniq = new Set(Array.from({ length: 1000 }, () => rand()));
    expect(uniq.size).toBe(1000);
  });
});

describe('cryptoRandom', () => {
  it('输出落在 [0, 1)', () => {
    for (let i = 0; i < 5000; i += 1) {
      const v = cryptoRandom();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('每次调用都不同（真随机源，非伪随机）', () => {
    const uniq = new Set(Array.from({ length: 1000 }, () => cryptoRandom()));
    expect(uniq.size).toBe(1000);
  });

  it('运行时没有 globalThis.crypto 时给出可操作的错误，而不是抛 TypeError', () => {
    const saved = globalThis.crypto;
    Reflect.deleteProperty(globalThis, 'crypto');
    try {
      expect(() => cryptoRandom()).toThrow(/globalThis\.crypto/);
      expect(() => cryptoRandom()).toThrow(/注入 RandomSource/);
    } finally {
      Reflect.set(globalThis, 'crypto', saved);
    }
    // 恢复后仍然可用
    expect(cryptoRandom()).toBeLessThan(1);
  });
});

describe('randomInt', () => {
  it('结果落在 [0, n)', () => {
    const rand = mulberry32(99);
    for (let n = 1; n <= 52; n += 1) {
      for (let i = 0; i < 200; i += 1) {
        const v = randomInt(rand, n);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(n);
      }
    }
  });

  it('n = 1 时恒为 0（洗牌循环的边界）', () => {
    const rand = mulberry32(5);
    for (let i = 0; i < 100; i += 1) expect(randomInt(rand, 1)).toBe(0);
  });

  it('分布大致均匀：52 个桶各约 1/52', () => {
    const rand = mulberry32(2024);
    const buckets = new Map<number, number>();
    const total = 52 * 4000;
    for (let i = 0; i < total; i += 1) {
      const key = randomInt(rand, 52);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    expect(buckets.size).toBe(52);
    const expected = total / 52;
    for (const count of buckets.values()) {
      // ±25% 容差：足以抓住系统性偏差，又不会因随机波动误报
      expect(count).toBeGreaterThan(expected * 0.75);
      expect(count).toBeLessThan(expected * 1.25);
    }
  });

  it('随机源越界（返回 1、负数或 NaN）时抛错，而不是静默产出非法下标', () => {
    expect(() => randomInt(() => 1, 52)).toThrow(/随机源/);
    expect(() => randomInt(() => -0.1, 52)).toThrow(/随机源/);
    expect(() => randomInt(() => 1.5, 52)).toThrow(/随机源/);
    expect(() => randomInt(() => Number.NaN, 52)).toThrow(/随机源/);
  });

  it('n <= 0 或非整数时抛错', () => {
    const rand = mulberry32(1);
    expect(() => randomInt(rand, 0)).toThrow(/上界/);
    expect(() => randomInt(rand, -3)).toThrow(/上界/);
    expect(() => randomInt(rand, 1.5)).toThrow(/上界/);
  });
});
