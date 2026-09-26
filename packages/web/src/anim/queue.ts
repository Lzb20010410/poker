/**
 * 串行动画队列（SPEC §3.1）。
 *
 * ## 为什么要有这么一个东西
 *
 * 服务端的权威状态是**一次性落地**的：一个 patch 里公共牌从 0 张变成 3 张、底池从 30 变 210。
 * 画面要是照着 patch 直接画，玩家看到的就是"牌突然出现在桌上"。动画要的是过程，
 * 而过程只能一段一段放——所以需要有人记住"哪些变化还没放完"，并且在放完之前
 * 不许玩家再动手（`blocked`）。这个"有人"就是本文件，它同时是 M3 全部动画的**唯一节拍器**。
 *
 * ## 四条硬规则，对应 SPEC §3.1 的四个要点
 *
 * 1. **严格串行**：上一段 `done` 之前绝不启动下一段。
 * 2. **积压 > 5 直接作废**：重连或者服务端一口气跑完公共牌时，事件会成批到达。
 *    补播三十秒动画比画面跳一下糟得多（SPEC §2.3 原话），所以清空并渲染终态。
 * 3. **可跳过 / 可加速**：老玩家不需要看每一次发牌。
 * 4. **不许卡死**：一段动画同步抛错、或者永远不回调 `done`，都不能让 `blocked`
 *    永久挂住——玩家会看到一张"牌已发但按钮不能点"的桌子，那是 M4.4 明令禁止的现象。
 *    所以每段都有一个 `ANIM_WATCHDOG_MS` 的看门狗，到点强制推进。
 *
 * ## 迟到的回调一律作废
 *
 * 跳过之后，被中止那段动画的 `done` 仍可能事后到达（GSAP 的 `onComplete` 不一定被
 * `kill()` 挡住，浏览器标签页节流时更不可信）。每次状态迁移都换一个新的 `epoch`，
 * `done` 闭包捕获自己那一次的 `epoch`，对不上就当没发生过。
 * 不这么做的话，一次迟到的 `done` 会把正在播的那段提前算作播完，玩家看到的就是
 * 动画播到一半直接跳下一步——比不修更难查。
 *
 * ## `done` 可能在 `play` 内部被同步调用
 *
 * 零时长动画、以及单测里那些假任务都会这么做。开播时 `running` 先挂上、`play` 后调用，
 * 所以这次同步的 `stop` 能收掉这一代（`settled` 置真、`running` 置空、`epoch` 递增），
 * 顺手把下一段播起来。本函数在 `play` 返回之后要看这个 `settled` 标记：
 * 已经收过就不许再把看门狗挂上去，也不许把 `running` 按回去——否则会出现
 * 「上一段早就播完、队列却卡在它上面」的死锁。
 */

import type { AnimQueue, AnimQueueListener, AnimQueueState, AnimTask } from './types';

export type { AnimQueue, AnimQueueState, AnimTask } from './types';

/** 单段动画的兜底上限。最长的一个预设是 8 人发牌 ≈3.2s，留 1.8s 余量 */
export const ANIM_WATCHDOG_MS = 5_000;

/** 积压到第几个事件就判定"这是在补历史"，直接清空。SPEC §3.1 写的是 5 */
export const ANIM_BACKLOG_LIMIT = 5;

interface Live {
  readonly task: AnimTask;
  cancel: (() => void) | null;
  /**
   * 到点强制推进的看门狗。**注意它不是 `AnimTask` 的成员**：任务自己不知道有这东西，
   * 也不该知道——它是队列的兜底，所以归属队列，正常播完时由队列 `clearTimeout`。
   */
  watchdog: ReturnType<typeof setTimeout> | null;
  /**
   * 已经收尾过一次。`play` 可能在它返回**之前**就把这一播放完，那时 `closeRunning`
   * 已经在栈里下把这一代收掉了；等回到本函数就不能再挂看门狗，否则每段同步结束的动画
   * 都会留下一枚 5 秒后才炸的空定时器，`destroy()` 只清得掉「正在播的那段」，清不到它们。
   */
  settled: boolean;
}

export function createAnimQueue(): AnimQueue {
  const listeners = new Set<AnimQueueListener>();
  const pending: AnimTask[] = [];
  let running: Live | null = null;
  let speed = 1;
  let epoch = 0;
  let destroyed = false;
  let last: AnimQueueState = { blocked: false, pending: [], active: null, speed: 1 };

  const view = (): AnimQueueState => ({
    blocked: running !== null || pending.length > 0,
    pending: [...pending],
    active: running?.task ?? null,
    speed,
  });

  /**
   * 状态没变就不推。`push` 会先入队再立刻开播，那中间如果各推一次，
   * 订阅方（React）就会在同一帧里被叫醒两次，第二次还是同样的值。
   */
  const emit = (): void => {
    if (destroyed) return;
    const next = view();
    const unchanged =
      next.blocked === last.blocked &&
      next.active === last.active &&
      next.speed === last.speed &&
      next.pending.length === last.pending.length &&
      next.pending.every((task, index) => task === last.pending[index]);
    if (unchanged) return;
    last = next;
    for (const listener of [...listeners]) listener(next);
  };

  /**
   * 收掉当前段：撤看门狗、作废这一代。`interrupted` 区分两条路——
   * 正常播完（动画自己已经收尾，不必再 `cancel`）与被中止（要 `cancel` + `settle`）。
   *
   * 两条路都要撤掉看门狗。忘了撤不会立刻出错——它开火时会被下面的 `epoch` 守卫挡回来——
   * 代价是每收一段就留下一枚 5 秒后才炸的空定时器，而 `destroy()` 只清得掉「正在播的那段」：
   * 玩家离开牌桌后，这些定时器还带着这一代的闭包活在页面上。
   */
  function closeRunning(interrupted: boolean): void {
    if (running === null) return;
    const { task, cancel, watchdog } = running;
    // 标记这一代已经收过：`play` 同步播完时，开播那一层的栈还在下面等着挂看门狗，
    // 看到这个标记就不该再挂——否则每次同步结束都留下一枚 5 秒后才炸的空定时器。
    running.settled = true;
    if (watchdog !== null) clearTimeout(watchdog);
    running = null;
    epoch += 1;
    if (!interrupted) return;
    try {
      cancel?.();
    } catch {
      // 中止句柄自己抛错也不能拦后面的推进——此刻最重要的是把操作按钮还回来。
    }
    task.settle();
  }

  /** 一段播完 / 看门狗到点：收掉它，然后接着放下一段 */
  function stop(token: number, interrupted: boolean): void {
    if (destroyed || token !== epoch) return;
    closeRunning(interrupted);
    startNext();
    emit();
  }

  /**
   * 作废一切：中止当前段、清空待播，每一份都落到终态。
   *
   * 和 `stop` 的区别是**这里绝不 `startNext()`**：跳过 / 重连 / 积压清空要的是
   * "整条队列现在就没了"，顺手把下一段播起来等于在已经跳到终态的画面上再叠一段动画。
   */
  function clearAll(): void {
    if (running === null && pending.length === 0) return;
    closeRunning(true);
    for (const task of pending.splice(0, pending.length)) task.settle();
    emit();
  }

  function startNext(): void {
    if (destroyed || running !== null) return;
    const task = pending.shift();
    if (task === undefined) return;
    const token = epoch;
    const live: Live = { task, cancel: null, watchdog: null, settled: false };
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stop(token, false);
    };
    // 先挂上再播：`play` 可能同步就把这一播放完（零时长动画、单测里的假任务），
    // 那时 `stop` 要能找到并收掉这一代，而本函数在 `settled` 之后就不再碰 `running`。
    running = live;
    try {
      live.cancel = task.play(finish, Math.round(task.durationMs * speed)) ?? null;
    } catch {
      // 这段动画压根没起来。它的终态也得有人收尾，否则遮罩会永远压着画面。
      finished = true;
      closeRunning(true);
      startNext();
      return;
    }
    if (live.settled) return;
    live.watchdog = setTimeout(() => {
      stop(token, true);
    }, ANIM_WATCHDOG_MS);
  }

  return {
    push: (task) => {
      if (destroyed) return;
      pending.push(task);
      if (pending.length + (running === null ? 0 : 1) > ANIM_BACKLOG_LIMIT) {
        // 补历史：当前段和待播段全部作废，画面直接给终态。
        clearAll();
        return;
      }
      startNext();
      emit();
    },
    skip: clearAll,
    flush: clearAll,
    setSpeed: (next) => {
      const value = Number.isFinite(next) && next > 0 ? next : 1;
      if (value === speed) return;
      speed = value;
      emit();
    },
    state: view,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(view());
      return (): void => {
        listeners.delete(listener);
      };
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      if (running !== null && running.watchdog !== null) clearTimeout(running.watchdog);
      running = null;
      pending.length = 0;
      listeners.clear();
    },
  };
}
