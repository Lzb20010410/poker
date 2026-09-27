/**
 * 把一个筹码数额拆成「画得出来的几枚」（SPEC §3.5「筹码堆叠：最多 8 枚、面额 ×N」）。
 *
 * ## 为什么要拆，为什么不直接画一堆 1
 *
 * `pot:awarded` 里赢的是 12,345 枚。照实画就是一屏的小圆片，飞过去既看不清也拖慢动画。
 * 牌桌上一把筹码的真实读法是**面额 + 数量**，所以这里做两件事：
 * 按面额从大到小贪心分解（`1000 ×12 → 100 ×3 → 5 ×1`），再给这一堆分「画几枚」的预算。
 *
 * ## 预算是总额，不是每组
 *
 * 「最多 8 枚」是整个数字的上限，不是每个面额的上限——8 人桌派彩时屏幕上同时有两三堆，
 * 每堆各 8 枚就是二十几个节点在飞。所以先给每组一枚（组数最多 6，永远装得下），
 * 剩下的预算按面额从大到小补，大面额那一叠看着更厚，也更接近真人码筹码的样子。
 *
 * `count > ghosts` 时调用方要挂一个 `×N`：省掉的是节点，不能省掉「有多少」。
 */

import { CHIP_DENOMINATIONS, type ChipDenomination } from '../assets/chips';

/** 一整堆里最多画几枚幽灵筹码 */
export const MAX_CHIP_GHOSTS = 8;

/** 从大到小贪心，顺序即面额优先级 */
const DENOMINATIONS_DESC: readonly ChipDenomination[] = [...CHIP_DENOMINATIONS].sort(
  (left, right) => right - left,
);

export interface ChipGroup {
  readonly denom: ChipDenomination;
  /** 这个面额实际有多少枚 */
  readonly count: number;
  /** 这一叠画几枚 */
  readonly ghosts: number;
  /** 画不满、需要用 `×N` 补口径 */
  readonly needsMultiplier: boolean;
}

/**
 * `amount` 不是正整数时给空数组：金额单位是整数筹码，非整数是调用方的 bug，
 * 而不是这里该替它编出一堆筹码的理由。
 *
 * `maxGhosts` 默认就是动画那一份预算。底牌区那一叠静态筹码要的是另一个密度
 * （5 枚，见 `ChipStack`），分解规则一样，只是画得少一点。
 * 面额本身比预算还多时每种至少画一枚——那一叠是 6 枚，不是 5 枚，但少了哪一种都读不出这堆钱。
 */
export function splitChips(amount: number, maxGhosts = MAX_CHIP_GHOSTS): readonly ChipGroup[] {
  if (!Number.isInteger(amount) || amount <= 0) return [];

  const groups: { denom: ChipDenomination; count: number }[] = [];
  let left = amount;
  for (const denom of DENOMINATIONS_DESC) {
    const count = Math.floor(left / denom);
    if (count === 0) continue;
    groups.push({ denom, count });
    left -= count * denom;
  }

  let budget = Math.max(0, maxGhosts - groups.length);
  return groups.map((group) => {
    const extra = Math.max(0, Math.min(group.count - 1, budget));
    budget -= extra;
    const ghosts = 1 + extra;
    return {
      denom: group.denom,
      count: group.count,
      ghosts,
      needsMultiplier: group.count > ghosts,
    };
  });
}
