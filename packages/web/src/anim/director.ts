/**
 * 事件 → 队列的那一层胶水（SPEC §3.1）。
 *
 * `plan.ts` 决定「要不要排、排多久」，`queue.ts` 决定「一次播一个、能打断、不卡死」，
 * 中间这三件事得有人做：**按当前视口档算出计划、把计划变成能播的任务、把 id 发出去**。
 *
 * 故意不做的事：
 * - 不订阅连接。订阅归 React 那边（`useAnimDirector`），因为退订时机跟着组件寿命走。
 * - 不读浏览器。视口档与减弱动态偏好都在 `env.ts` 的 `readAnimEnv()` 里现取，
 *   这里只接一个函数——所以 vitest 能直接喂一份假的档进来。
 * - 不缓存已播事件。重连后补播历史动画是最糟糕的失败模式（玩家要的是当前局面，
 *   不是上一手的发牌表演），而「不缓存」是这条保证唯一不需要额外代码的写法。
 */

import type { S2C_Broadcast } from '@poker-room/shared/view';

import type { RevealView } from '../net/types';
import type { AnimDirectorEnv } from './env';
import { planEvent, revealPlan, type AnimPlan } from './plan';
import { createAnimQueue } from './queue';
import type { AnimQueue, AnimTask } from './types';

/**
 * 渲染层工厂：把一条计划变成能播、能立刻落终态的任务。
 *
 * `id` 由 director 递增发出（队列拿它做日志与断言标识，渲染层不需要解释）。
 * M3.3~M3.5 的 GSAP 实现按 `plan.kind` 分头接活。
 */
export type AnimRenderer = (plan: AnimPlan, id: number) => AnimTask;

export interface AnimDirector {
  /** 挂到连接的事件通道上：`connection.onEvent(director.handle)` */
  readonly handle: (event: S2C_Broadcast) => void;
  /**
   * 刚到达的摊牌亮牌 → 一段翻牌动画。
   *
   * 单独一个入口而不是塞进 `handle`：亮牌按 D-002 / D-013 是定向消息，
   * 根本不在广播流里（见 `plan.ts` 的 `revealPlan`），硬要统一就会在广播类型里
   * 凭空造一个服务端从未发过的事件名。
   */
  readonly reveal: (rows: readonly RevealView[]) => void;
  readonly queue: AnimQueue;
}

export function createAnimDirector(deps: {
  readonly renderer: AnimRenderer;
  /** 取当前档。是函数而不是值，因为横竖屏可能在两次动画之间翻转 */
  readonly env: () => AnimDirectorEnv;
}): AnimDirector {
  const queue = createAnimQueue();
  let nextId = 1;

  const enqueue = (plan: AnimPlan | null): void => {
    if (plan === null) return;
    queue.push(deps.renderer(plan, nextId));
    nextId += 1;
  };

  return {
    handle: (event) => {
      const env = deps.env();
      if (!env.animate) return;
      enqueue(planEvent(event, env));
    },
    reveal: (rows) => {
      const env = deps.env();
      if (!env.animate) return;
      enqueue(revealPlan(rows, env));
    },
    queue,
  };
}
