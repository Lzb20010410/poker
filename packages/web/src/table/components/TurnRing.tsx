/**
 * 倒计时环（M3.5）：轮到某人时，挂在他头像外圈的那一圈「还剩多少时间」。
 *
 * ## 为什么它自己掐表
 *
 * 秒数的**唯一来源**是 `snapshot.deadline`（服务端时钟下的绝对时刻）加上
 * `snapshot.clockOffsetMs`，这条与 `.table-timer` 那句文字完全一致。但文字的粒度是整秒，
 * 环要是一秒一跳就会看着像卡帧——所以这里读同一份数据、只把粒度调到 200ms
 * （见 `useCountdownMs`）。放在组件内部而不是提到 `TablePage` 去算，是为了让这一格以外
 * 的东西不必跟着重渲染：整桌只有行动者身上有环，也就只有一处每秒重画五次。
 *
 * ## 为什么分母要传进来
 *
 * 一圈代表「一步行动的时限」，那是房间配置（`config.actionTimeoutSec`），不是前端常量。
 * 写死 30 秒的后果是：房主把时限改成 20 秒后，环走得比实际慢三分之一，
 * 玩家以为还早，服务端已经替他弃牌了。
 *
 * ## 为什么 `aria-hidden`
 *
 * 同一件事已经由 `.table-timer` 那句话用文字说了一遍（「行动剩余 N 秒」）。读屏里再念一圈
 * 数字只是噪音；而 SVG 本身对读屏没有任何可念的东西，给它编个名字反而是把双倍的噪声。
 */

import { ACTION_WARNING_SEC } from '@poker-room/shared/view';
import type { ReactNode } from 'react';

import { useCountdownMs } from '../useCountdown';

/** viewBox 边长。CSS 把 svg 拉成正方形盒子，所以这里用 100 只是为了让 stroke 粗细好说话 */
const VIEW = 100;
const RADIUS = 46;
/** 描边中线周长：`stroke-dasharray` 与 `stroke-dashoffset` 都以它为全长 */
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface TurnRingProps {
  /** 服务端时钟下的行动截止时刻；`null` = 现在没人该行动，那一圈就不画 */
  readonly deadline: number | null;
  readonly clockOffsetMs: number;
  /** 一整圈等于多长时间（毫秒），来自 `config.actionTimeoutSec` */
  readonly totalMs: number;
  /** 只为测试注入；生产走 `Date.now` */
  readonly now?: () => number;
}

export function TurnRing({
  deadline,
  clockOffsetMs,
  totalMs,
  now = Date.now,
}: TurnRingProps): ReactNode {
  const remainingMs = useCountdownMs(deadline, clockOffsetMs, now);
  if (remainingMs === null) return null;

  /**
   * 走完的比例。两次收窄各有各的原因：
   * - `totalMs > 0`：配置被写成 0 时这里会除出 `Infinity`，SVG 收到非有限的
   *   `stroke-dashoffset` 会直接把属性丢掉，环就永远停在满的；
   * - `clamp01`：`deadline` 是本步的截止时刻，而环挂上去到服务端推新状态之间总有几十毫秒
   *   的窗口，那一段读出来是负数（`useCountdownMs` 已夹到 0，这里再防的是 totalMs 偏小的情况）。
   */
  const swept = totalMs > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / totalMs)) : 1;
  const warn = remainingMs <= ACTION_WARNING_SEC * 1000;
  const center = VIEW / 2;

  return (
    <svg
      className={`seat__ring${warn ? ' seat__ring--warn' : ''}`}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="seat__ring__track" cx={center} cy={center} r={RADIUS} />
      <circle
        className="seat__ring__progress"
        cx={center}
        cy={center}
        r={RADIUS}
        // 从 12 点开始顺时针收，而不是从 3 点：玩家对「表」的直觉是 12 点
        transform={`rotate(-90 ${center} ${center})`}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * swept}
      />
    </svg>
  );
}
