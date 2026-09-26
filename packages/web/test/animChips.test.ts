/**
 * 「一笔筹码画成几枚」的分配单测（SPEC §3.5 的「最多 8 枚、面额 ×N」）。
 *
 * ## 这里钉的是两条会骗人的东西
 *
 * 1. **不能撒谎说没有**：`count > ghosts` 时必须挂 `×N`。少挂一个，玩家看到桌上三枚
 *    筹码就会以为那是一手 3 的下注——这是把金额信息画错了，比没有动画更糟。
 * 2. **不能撒谎说更多**：`Σ denom × count` 必须**正好**等于进来的那个数。贪心分解
 *    写错一档（比如漏了 500）会让总和变小，而屏幕上没人能看出少了一叠。
 *
 * 节点总数（≤8）是性能线，`count ≥ ghosts` 是「省掉的是节点、不是数量」这条决定的
 * 直接表述。四条加起来才把这段代码真正钉住。
 */

import { describe, expect, it } from 'vitest';

import { MAX_CHIP_GHOSTS, splitChips } from '../src/anim/chips';

describe('筹码分解', () => {
  it('一笔具体的钱拆成哪几档、各画几枚，逐格对上', () => {
    // 12,345 = 1000×12 + 100×3 + 25×1 + 5×4。四组先各占一枚，剩下 4 枚预算给最大那一叠
    expect(splitChips(12345)).toEqual([
      { denom: 1000, count: 12, ghosts: 5, needsMultiplier: true },
      { denom: 100, count: 3, ghosts: 1, needsMultiplier: true },
      { denom: 25, count: 1, ghosts: 1, needsMultiplier: false },
      { denom: 5, count: 4, ghosts: 1, needsMultiplier: true },
    ]);
  });

  it('面额从大到小排，预算先给最大那一叠，用完就没有了', () => {
    // 5,555 = 1000×5 + 500×1 + 25×2 + 5×1。四组各占一枚，剩 4 枚全给 1000 那一叠
    const groups = splitChips(5555);
    expect(groups.map((group) => group.denom)).toEqual([1000, 500, 25, 5]);
    expect(groups.map((group) => group.ghosts)).toEqual([5, 1, 1, 1]);
    // 画不满的那两档必须挂 ×N，否则桌上会少说一笔钱
    expect(groups.map((group) => group.needsMultiplier)).toEqual([false, false, true, false]);
  });

  it('加起来正好是原来那个数，一枚不多一枚少', () => {
    for (const amount of [1, 4, 8, 26, 99, 420, 1000, 12345, 88888, 1_000_000]) {
      const total = splitChips(amount).reduce((sum, group) => sum + group.denom * group.count, 0);
      expect(total, `${amount} 分解后变了`).toBe(amount);
    }
  });

  it('一整堆最多 8 枚，且每组至少画一枚、不会画得比实际多', () => {
    for (const amount of [1, 5, 25, 100, 500, 1000, 12345, 999_999]) {
      const groups = splitChips(amount);
      const ghosts = groups.reduce((sum, group) => sum + group.ghosts, 0);
      expect(ghosts, `${amount} 画了 ${ghosts} 枚`).toBeLessThanOrEqual(MAX_CHIP_GHOSTS);
      for (const group of groups) {
        expect(group.ghosts).toBeGreaterThanOrEqual(1);
        expect(group.ghosts).toBeLessThanOrEqual(group.count);
        expect(group.needsMultiplier).toBe(group.count > group.ghosts);
      }
    }
  });

  it('画得下就不挂 ×N：小额下注不该桌上飘着一个「×1」', () => {
    expect(splitChips(3).every((group) => !group.needsMultiplier)).toBe(true);
    expect(splitChips(3).reduce((sum, group) => sum + group.ghosts, 0)).toBe(3);
  });

  it('不是正整数就不画：这是调用方的 bug，不是这里该编出筹码的理由', () => {
    for (const amount of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(splitChips(amount), String(amount)).toEqual([]);
    }
  });
});
