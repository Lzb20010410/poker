/**
 * 一页牌桌要接的那几根**共用**线（M3.1 + M3.2）。
 *
 * ## 为什么单独一个文件
 *
 * 线上牌桌（`TablePage` → `useAnimDirector`）和回放器（`/dev/replay`）拼的是同一套零件：
 * 一只场景盒子、一份队列状态、一条亮牌增量。区别只在**事件从哪来**——前者订阅连接，
 * 后者读硬编码帧。所以这几根住在这里，两边各自组装；`useRoom` 一点都进不来，
 * 于是回放器不必伪造一条连接就能复用线上那套接线。
 *
 * ## 这里不判定任何事
 *
 * 排不排队是 `plan.ts` 的事，什么时候轮到下一段是 `queue.ts` 的事。这一层只做 React
 * 那一侧的搬运：把值变成 state，把 effect 挂对依赖。
 */

import { useEffect, useMemo, useState } from 'react';

import type { RevealView } from '../net/types';

import type { AnimDirector, AnimRenderer } from './director';
import { createRenderer } from './renderer';
import { createRevealTracker } from './revealDelta';
import type { AnimScene } from './scene';
import type { AnimQueue, AnimQueueState } from './types';

/** 原速 */
export const ANIM_SPEED_NORMAL = 1;
/** 加速档：SPEC §3.1「加速开关（0.5× 时长）」 */
export const ANIM_SPEED_FAST = 0.5;

/**
 * 幽灵层 → 场景 → 渲染器的那只闭包盒子。
 *
 * 场景**不是 state**：幽灵层挂上/摘掉都不该让牌桌重渲染一次，所以它住在一个只建一次的
 * 闭包盒子里（`useState` 的惰性初值），渲染器每次造任务时现读一次，读到 `null` 就退化成
 * 「不播、不占时长」的任务（见 `anim/renderer.ts`）。
 *
 * 为什么不用 `useRef`：这个读函数是在 render 期间交给 `createRenderer` 的，
 * `react-hooks/refs` 把「把 ref 递进一个可能在 render 里被调的函数」判成违规——
 * 而盒子换成闭包变量后语义完全一样（引用稳定、不参与渲染），没有理由留着警告。
 *
 * 返回值本身也稳定（`useState` 的初值对象），所以 `setScene` 可以直接当 `AnimLayer`
 * 的 `onScene` 传下去，不必再包一层 `useCallback`。
 */
export interface AnimRig {
  readonly renderer: AnimRenderer;
  readonly setScene: (scene: AnimScene | null) => void;
}

export function useAnimRig(): AnimRig {
  const [rig] = useState<AnimRig>(() => {
    let scene: AnimScene | null = null;
    return {
      renderer: createRenderer(() => scene),
      setScene: (next: AnimScene | null): void => {
        scene = next;
      },
    };
  });
  return rig;
}

/** 队列状态回流组件。`subscribe` 注册时立刻同步推一次，所以初值与首个回调一致，没有空窗帧 */
export function useAnimQueueState(queue: AnimQueue): AnimQueueState {
  const [state, setState] = useState<AnimQueueState>(() => queue.state());
  useEffect(() => queue.subscribe(setState), [queue]);
  return state;
}

/**
 * 快照的 `reveals` 增量 → 一段亮牌动画。
 *
 * 亮牌不在广播流里（D-002 / D-013），所以这一段没有事件可订阅，只能从快照增量里推。
 * 规则本身在 `revealDelta.ts`——线上与回放器推的是同一件事，那份实现必须只有一份。
 */
export function useRevealAnimation(director: AnimDirector, reveals: readonly RevealView[] | null): void {
  const tracker = useMemo(() => createRevealTracker(), []);
  useEffect(() => {
    const fresh = tracker.observe(reveals);
    if (fresh.length === 0) return;
    director.reveal(fresh);
  }, [reveals, director, tracker]);
}
