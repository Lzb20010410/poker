/**
 * 倒计时那条外部 store 的**取值契约**（M3.2 造回放器时抓到的，产品路径同样受影响）。
 *
 * `useSyncExternalStore` 在 commit 阶段会再读一次 store，和渲染时读到的那次比对，
 * 不一样就强制重渲染。所以「取值现算 `deadline - Date.now()`」这件事本身是有前提的：
 * **一帧之内读两次必须给同一个答案**。而墙上时钟不给——牌桌那种重页面渲染一次就是几毫秒，
 * 两次读数跨过一个毫秒边界几乎必然发生，于是：重渲染 → 再读 → 又变了 → 再重渲染……
 * React 开发模式跑到第 50 层就抛 `Maximum update depth exceeded`。
 *
 * 线上牌桌（`TablePage`）读的是真时钟，所以这条不是回放器独有的毛病，只是回放器的测试
 * 用真定时器、渲染又最重，第一个把它撞出来了。`seatTimer.test.tsx` 一直用 `vi.useFakeTimers()`
 * 把时钟冻住，恰好绕过了这条路径。
 *
 * 修法是把读数**归档到 tick**：一秒一跳的文字只可能在整秒边界上改口，200ms 一档的环同理。
 * 显示值与修之前完全一致（整秒那档本来就是 `ceil`），变的是「一帧之内不许改口」。
 */

import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useCountdown, useCountdownMs } from '../src/table/useCountdown';

/**
 * 每读一次就走 1ms 的表。
 *
 * 用它而不是真 `Date.now`：要复现的是「同一帧里读两次，答案不一样」，
 * 真时钟也撞得上，但看运气；这张表是钉死的。
 */
function advancingClock(start: number): () => number {
  let clock = start;
  return () => {
    clock += 1;
    return clock;
  };
}

function TextProbe({ deadline, now }: { deadline: number; now: () => number }): ReactNode {
  const left = useCountdown(deadline, 0, now);
  return <span data-testid="left">{String(left)}</span>;
}

function RingProbe({ deadline, now }: { deadline: number; now: () => number }): ReactNode {
  const left = useCountdownMs(deadline, 0, now);
  return <span data-testid="ring">{String(left)}</span>;
}

/**
 * 一次挂载允许读几趟表。渲染一趟 + commit 比对一趟，个位数封顶；
 * 转起循环的那一版要读到第 50 层嵌套更新才被 React 掐断。
 */
const READ_BUDGET = 20;

describe('倒计时的取值在一帧之内必须稳定', () => {
  it('时钟每读一次都在走，也不许把渲染拖成死循环（整秒那档）', () => {
    const now = vi.fn(advancingClock(1_000_000));
    render(<TextProbe deadline={1_050_000} now={now} />);
    expect(now.mock.calls.length).toBeLessThan(READ_BUDGET);
  });

  it('归档不改显示值：还剩 49.999 秒读出来还是 50', () => {
    render(<TextProbe deadline={1_050_000} now={advancingClock(1_000_000)} />);
    expect(screen.getByTestId('left').textContent).toBe('50');
  });

  it('环那一档同理，且落点在 200ms 的格子上', () => {
    const now = vi.fn(advancingClock(1_000_000));
    render(<RingProbe deadline={1_050_000} now={now} />);
    expect(now.mock.calls.length).toBeLessThan(READ_BUDGET);
    expect(Number(screen.getByTestId('ring').textContent)).toBe(50_000);
  });
});
