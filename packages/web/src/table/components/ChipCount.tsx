/**
 * 筹码数（M2.3）：千分位 + 变化时滚过去。
 *
 * ## 为什么文本是命令式写进 DOM 的
 *
 * 如果 JSX 里写 `{formatChips(value)}`，React 会在 value 变的那一帧直接把文本换成
 * 新值， tween 就没有可播的东西了 —— 玩家看到的仍是瞬变。所以这个 `<span>` 在 JSX
 * 里**没有子节点**，文本从头到尾由动画自己写。React 之后也不会来覆盖：它没有渲染过
 * 任何 children，就没有 diff 可做。
 *
 * ## 为什么首帧不滚
 *
 * 进场时 `shownRef` 就是当前值，`from === target` 直接落文本。否则每个人一开桌
 * 都会看到满屏数字从 0 跳到 1,000，那是发牌动画该做的事（M3），不是这里。
 *
 * ## 系统开了「减弱动态效果」就跳过 tween
 *
 * 这是一条无障碍偏好，不是性能开关：前庭功能障碍的玩家会被这类移动干扰。
 * 跳过之后数字照样更新，只是不再滚。
 */

import { gsap } from 'gsap';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { prefersReducedMotion } from '../../anim/env';
import { formatChips } from '../format';

/** 滚一档的时长。再长会在连续两次结算时互相追尾 */
const ROLL_SECONDS = 0.45;

export interface ChipCountProps {
  readonly value: number;
}

export function ChipCount({ value }: ChipCountProps): ReactNode {
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  /** 此刻屏幕上那个数。tween 每一帧都写回这里，所以中途换目标是从**当前显示值**接着走 */
  const shownRef = useRef(value);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;
    const target = value;
    const from = shownRef.current;
    if (from === target || prefersReducedMotion()) {
      shownRef.current = target;
      node.textContent = formatChips(target);
      return;
    }
    const counter = { value: from };
    const paint = (rounded: number): void => {
      shownRef.current = rounded;
      node.textContent = formatChips(rounded);
    };
    const tween = gsap.to(counter, {
      value: target,
      duration: ROLL_SECONDS,
      ease: 'power2.out',
      onUpdate: () => {
        paint(Math.round(counter.value));
      },
    });
    return () => {
      tween.kill();
    };
  }, [value]);

  return <span className="seat__chips" ref={nodeRef} />;
}
