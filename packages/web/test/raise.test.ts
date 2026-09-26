/**
 * 加注额度的算术（M2.4）。
 *
 * ## 为什么这点算术可以待在 `web`，不算「前端自己判定规则」
 *
 * AGENTS.md 的铁律是「谁能行动、下注是否合法」只存在于 `shared/engine`。
 * 这里做的是另一件事：**在服务端已经划好的 [min, max] 区间里，替人手不够的你
 * 把滑杆挪到某个刻度上**。算出来的数不决定任何合法性——发出去之后服务端
 * 照样重新判一遍，非法就回 `error`（SPEC §4.4 的「软提示」）。
 * 所以这些函数只管「落到哪个刻度」，一个字都不碰「能不能这么下」。
 *
 * ## 刻度对齐是滑杆与输入框不失配的根据
 *
 * `<input type="range">` 只能落在 `min + k * step` 上，而牌桌上 `max`
 * （= 筹码 + 本手已投，见 `betting.ts` 的 `legalActions`）一般不是整刻度。
 * 于是「全下」这个额度必须**原样保留**，不能被对齐吃掉——不然玩家以为自己全下了，
 * 实际还差 15 个筹码。`snapRaise` 里那条 `Math.min(max, ...)` 就是为这个。
 */

import { describe, expect, it } from 'vitest';

import { raiseBounds, raiseShortcuts, snapRaise } from '../src/table/raise';

/** min 40 / max 2000 / 步长 20：翻牌前 20/40 的盲注、我手里还有 1980 */
const BOUNDS = { min: 40, max: 2000, step: 20 };

describe('加注额度落到刻度', () => {
  it('区间内的值就近落到 min + k×步长', () => {
    expect(snapRaise(80, BOUNDS)).toBe(80);
    expect(snapRaise(89, BOUNDS)).toBe(80);
    expect(snapRaise(91, BOUNDS)).toBe(100);
  });

  it('越界往回收：低于最低加注额回到 min，高于上限回到 max', () => {
    expect(snapRaise(10, BOUNDS)).toBe(40);
    expect(snapRaise(99999, BOUNDS)).toBe(2000);
  });

  it('不是整刻度的上限也留得住：全下不会被对齐吃掉一截', () => {
    const offLattice = { min: 40, max: 1895, step: 20 };
    expect(snapRaise(1895, offLattice)).toBe(1895);
    expect(snapRaise(1900, offLattice)).toBe(1895);
    // 中间的普通值仍旧落在刻度上，不会因为兜住 max 而全线失准
    expect(snapRaise(1870, offLattice)).toBe(1880);
  });

  it('非数字按最低加注额处理：输入框清空时界面不能是空的', () => {
    expect(snapRaise(Number.NaN, BOUNDS)).toBe(40);
  });

  it('加不了注（max < min，短码）时一切都停在 min，不返回负数步长', () => {
    expect(snapRaise(500, { min: 400, max: 120, step: 20 })).toBe(400);
  });

  it('步长非法（0 或负）时不做对齐，免得除出 Infinity', () => {
    expect(snapRaise(83, { min: 40, max: 2000, step: 0 })).toBe(83);
  });
});

describe('滑杆范围取自服务端提示位', () => {
  it('min / max 就是 minRaiseTotal / maxRaiseTotal，前端不再算一遍规则', () => {
    const bounds = raiseBounds(
      {
        canFold: true,
        canCheck: false,
        callAmount: 20,
        canRaise: true,
        minRaiseTotal: 40,
        maxRaiseTotal: 1820,
        canAllIn: true,
      },
      20,
    );
    // SPEC §4.4：min = currentBet + lastRaiseSize，max = chips + committedThisStreet。
    // 这两个数由服务端的 engine 算（betting.ts:243），这里只是换个形状传给 <input type=range>
    expect(bounds).toEqual({ min: 40, max: 1820, step: 20 });
  });
});

describe('快捷加注的四档', () => {
  const context = { potTotal: 120, currentBet: 20 };

  it('池的比例加在 currentBet 之上，并且都落到刻度', () => {
    const totals = raiseShortcuts(BOUNDS, context).map((row) => [row.label, row.total] as const);
    expect(totals).toEqual([
      ['1/2 池', 80],
      ['2/3 池', 100],
      ['底池', 140],
      ['全下', 2000],
    ]);
  });

  it('池远大于筹码时四档一起收到上限，全下仍然精确停在 max', () => {
    const totals = raiseShortcuts({ min: 40, max: 100, step: 20 }, { potTotal: 1200, currentBet: 20 });
    expect(totals.map((row) => row.total)).toEqual([100, 100, 100, 100]);
  });

  it('大盲当步长时按比例算的额度就近吸附：1/2 池与 2/3 池可能撞到同一档', () => {
    const totals = raiseShortcuts({ min: 40, max: 2000, step: 50 }, { potTotal: 130, currentBet: 20 });
    // 20+65=85 → 90；20+87=107 → 90；底池 150 → 140；全下不吃对齐
    expect(totals.map((row) => row.total)).toEqual([90, 90, 140, 2000]);
  });
});
