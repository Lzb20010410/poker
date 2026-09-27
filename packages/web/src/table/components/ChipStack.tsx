/**
 * 一叠静态筹码 + 数字（D-038）：摆在「我的底牌」旁边，不再摆在座位格里。
 *
 * ## 为什么挪过来
 *
 * 竖屏满桌时座位框只有 104×56，`1,234,567` 这种数字在格子里是被裁掉的（D-029 之后
 * 那一档的紧凑版式只保名字和角标）。而他真正要盯的那一份余额，视线路径就在自己两张牌旁边。
 * 挪过来之后同一数额只出现一次——`SeatList` 里我那一格不再画 `ChipCount`。
 *
 * ## 为什么码成几枚而不是一个数字
 *
 * 牌桌上读一把筹码的正确方式本来就是「面额 + 有多少枚」。分解用的是 `splitChips`
 * 那一份（和派彩时飞出去的幽灵筹码同一个口径），只是预算收到 5 枚：这一叠是常驻画面，
 * 不是零点几秒飞过去的一闪，太厚会把两张牌挤远。画不满的部分挂 `×N`。
 *
 * ## 0 筹码
 *
 * 那一叠没了（没有筹码可码），但数字还在：`0` 是「被清空」这件事本身，旁观者一眼要能看到。
 */

import type { ReactNode } from 'react';

import { chipDataUri } from '../../assets/chips';
import { splitChips } from '../../anim/chips';
import { ChipCount } from './ChipCount';

/** 这一叠最多码几枚。派彩动画的预算是 8（`MAX_CHIP_GHOSTS`），常驻画面要的是更薄的一叠 */
export const CHIPS_IN_STACK = 5;

export interface ChipStackProps {
  readonly value: number;
}

export function ChipStack({ value }: ChipStackProps): ReactNode {
  const groups = splitChips(value, CHIPS_IN_STACK);
  return (
    <span className="chip-stack">
      {groups.length > 0 && (
        <span className="chip-stack__pile" aria-hidden="true">
          {groups.map((group) => (
            <span className="chip-stack__group" key={group.denom}>
              {Array.from({ length: group.ghosts }, (_unused, index) => (
                <img
                  className="chip-stack__chip"
                  data-denom={String(group.denom)}
                  src={chipDataUri(group.denom)}
                  alt=""
                  key={`chip-${String(group.denom)}-${String(index)}`}
                />
              ))}
              {group.needsMultiplier && <span className="chip-stack__more">{`×${String(group.count)}`}</span>}
            </span>
          ))}
        </span>
      )}
      <ChipCount className="chip-stack__amount" value={value} />
    </span>
  );
}
