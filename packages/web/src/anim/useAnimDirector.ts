/**
 * 动画导演的 React 胶水：把**连接上**的事件流接进队列（SPEC §3.1）。
 *
 * 零件在 `rig.ts`（场景盒子、队列状态、亮牌增量），这一层只多两件只有线上才有的事：
 * 订阅 `connection.onEvent`，以及在掉线时把遮罩塌回终态。回放器不从这里走，
 * 因为它的事件不来自连接——那正是这些零件要能单独拿出去用的理由。
 *
 * ## 为什么这里不碰 DOM
 *
 * 导演只**转接**，不**画**。怎么画是 `renderer` 的事（M3.3~M3.5 的 GSAP 层），
 * 由调用方注入。于是这一层可以在 jsdom 里用假渲染器测干净——队列遮不遮罩、
 * 掉线时塌不塌回终态，这些都是「顺序」问题，而顺序是机器能证明的东西。
 *
 * ## 卸载时 `flush` 而不是 `destroy`
 *
 * React 19 的 StrictMode 在 dev 下会把 effect 跑两遍（挂载 → 清理 → 再挂载），
 * 而 `useMemo` 造出来的导演在两次之间是同一个。清理里要是调 `destroy()`，
 * 第二次挂载拿到的就是一枚永久停摆的队列：**开发环境下动画一次都不会播**，
 * 而所有单测照样全绿（单测里挂的是真 StrictMode，但队列停摆这件事没有断言能看见）。
 * `flush()` 达到同样的目的——中止当前段、清掉它的看门狗、把待播段全部落终态——
 * 而且幂等，再来事件时队列照常工作。回放器换场景走的是 React 的 `key` 整棵重挂，
 * 新组件自带一枚新队列，所以那里同样只用 `flush`。
 */

import { useEffect, useMemo } from 'react';

import type { RevealView } from '../net/types';
import { useRoom } from '../state/RoomContext';

import { createAnimDirector, type AnimRenderer } from './director';
import { readAnimEnv } from './env';
import { useAnimQueueState, useRevealAnimation } from './rig';

export interface AnimControls {
  /**
   * 队列里还有没播完的段。**非空时操作按钮必须禁用**（SPEC §3.1），
   * 否则会出现「牌还没飞到、这一步已经发出去了」的割裂。
   */
  readonly blocked: boolean;
  readonly speed: number;
  readonly skip: () => void;
  readonly setSpeed: (speed: number) => void;
}

export function useAnimDirector(
  renderer: AnimRenderer,
  /** 快照里已亮牌的那些人。`null` = 还没有快照，见 `revealDelta.ts` */
  reveals: readonly RevealView[] | null,
): AnimControls {
  const { onEvent, link } = useRoom();

  const director = useMemo(() => createAnimDirector({ renderer, env: readAnimEnv }), [renderer]);
  const { queue } = director;
  const state = useAnimQueueState(queue);

  useEffect(() => onEvent(director.handle), [onEvent, director]);

  useRevealAnimation(director, reveals);

  /**
   * 掉线即遮罩塌回终态。
   *
   * 断线期间快照是**过期**的，重连后服务端会补推一份新的；此时接着播掉线前攒下的
   * 动画，玩家看到的是一段「上一世的表演」，而按钮全灰。刷新页面走的是同一条保证：
   * 事件通道不重放（见 `net/types.ts` 的 `onEvent`），新连接一上来队列就是空的。
   */
  useEffect(() => {
    if (link === 'online') return;
    queue.flush();
  }, [link, queue]);

  /**
   * 卸载即收摊：中止正在播的那段并清掉它的看门狗。
   *
   * 不收的后果不是泄漏一个定时器这么简单——玩家退回大厅后服务端还在广播，
   * 队列会对着已经不存在的画面层继续排动画，那枚 5 秒看门狗也会跟着活到超时。
   * 为什么这里用 `flush` 而不是 `destroy`，见文件头。
   */
  useEffect(() => () => queue.flush(), [queue]);

  // 队列的这两个方法是闭包而不是原型方法，解构出来不会丢上下文。
  return { blocked: state.blocked, speed: state.speed, skip: queue.skip, setSpeed: queue.setSpeed };
}
