/**
 * 加注额度的算术（M2.4）。纯函数，不碰 DOM、不碰网络。
 *
 * ## 为什么这点算术可以待在 `web`，不算「前端自己判定规则」
 *
 * AGENTS.md 的铁律是「谁能行动、下注是否合法」只存在于 `shared/engine`。
 * 这里做的是另一件事：**在服务端已经划好的 [min, max] 区间里，把额度挪到某个刻度上**，
 * 好让滑杆、输入框和四个快捷按钮说的是同一个数。算出来的值不决定合法性——
 * 发出去之后服务端照样重判一遍，非法就回 `error`（SPEC §4.4 的「软提示」）。
 * 所以这些函数只管「落到哪个刻度」，一个字都不碰「能不能这么下」。
 *
 * ## 范围为什么读 `legal` 而不是自己按盲注推
 *
 * `betting.ts` 里 `minRaiseTotal = currentBet + lastRaiseSize`、
 * `maxRaiseTotal = committedThisStreet + chips`（正是 SPEC §4.4 给滑杆写的那两条）。
 * 前端照抄这两个数，就等于照抄服务端的口径；自己按 `bigBlind` 推一遍，
 * 就多了一处会和引擎漂移的地方。
 *
 * ## 刻度对齐与「全下」的冲突
 *
 * `<input type="range">` 只能落在 `min + k × step` 上，而 `max`（筹码 + 已投）
 * 一般不是整刻度。于是「全下」这个额度必须原样保留，不能被对齐吃掉——
 * 不然玩家以为自己全下了，实际还差十几个筹码。`snapRaise` 里那句
 * `Math.min(max, …)` 就是为这个；`raiseShortcuts` 的全下干脆不过 `snapRaise`。
 */

import type { LegalActionsView } from '../net/types';

/** 滑杆的范围与刻度 */
export interface RaiseBounds {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** 一桌当前的池面。只用于算「1/2 池」这类建议额度 */
export interface PotContext {
  readonly potTotal: number;
  readonly currentBet: number;
}

export interface RaiseShortcut {
  readonly label: string;
  readonly total: number;
}

export function raiseBounds(legal: LegalActionsView, bigBlind: number): RaiseBounds {
  return { min: legal.minRaiseTotal, max: legal.maxRaiseTotal, step: bigBlind };
}

/** 把一个任意来源的额度收进 [min, max] 并落到刻度上。见文件头对 `max` 的说明 */
export function snapRaise(value: number, bounds: RaiseBounds): number {
  const { min, max, step } = bounds;
  if (!Number.isFinite(value) || max < min) return min;
  const clamped = Math.min(max, Math.max(min, Math.round(value)));
  if (step <= 0) return clamped;
  return Math.min(max, min + Math.round((clamped - min) / step) * step);
}

/**
 * 四个快捷档位（SPEC §4.4）。
 *
 * 比例算的是「这一街要下出去的注」，所以都加在 `currentBet` 之上——跟真人喊
 * 「半池」时说的数一致。三档都过 `snapRaise`（池可能是小数、可能超出自家筹码），
 * 唯独全下不过：它必须正好是 `max`。
 */
export function raiseShortcuts(bounds: RaiseBounds, pot: PotContext): readonly RaiseShortcut[] {
  const { potTotal, currentBet } = pot;
  return [
    { label: '1/2 池', total: snapRaise(currentBet + potTotal / 2, bounds) },
    { label: '2/3 池', total: snapRaise(currentBet + (potTotal * 2) / 3, bounds) },
    { label: '底池', total: snapRaise(currentBet + potTotal, bounds) },
    { label: '全下', total: Math.max(bounds.min, bounds.max) },
  ];
}
