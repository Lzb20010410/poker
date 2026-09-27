/**
 * M3.1 · 动画事件队列。
 *
 * 这一层不认识 GSAP，也不认识 DOM：它只管「一次播一个、可以打断、不许卡死」。
 * 所以这里的任务全是假的 `play`——测试要它什么时候 `done` 它就什么时候 `done`，
 * 串行性、跳过、积压清空这三件事才能被机器验出来（SPEC §3.1 的四条规则）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANIM_WATCHDOG_MS, createAnimQueue, type AnimQueue, type AnimTask } from '../src/anim/queue';

/** 一个手动控制的假任务：`done()` 由测试按，`cancel` 记录被中止的次数 */
interface FakeTask {
  readonly task: AnimTask;
  readonly started: () => number;
  readonly cancels: () => number;
  readonly durations: () => readonly number[];
  readonly done: () => void;
  readonly settled: () => number;
}

function fakeTask(id: number, durationMs = 100): FakeTask {
  let starts = 0;
  let cancelCount = 0;
  let settleCount = 0;
  const durations: number[] = [];
  let resolveDone: (() => void) | null = null;

  return {
    durations: (): readonly number[] => durations,
    task: {
      id,
      durationMs,
      play: (onDone, ms) => {
        starts += 1;
        durations.push(ms);
        resolveDone = onDone;
        return () => {
          cancelCount += 1;
          resolveDone = null;
        };
      },
      settle: () => {
        settleCount += 1;
      },
    },
    started: () => starts,
    cancels: () => cancelCount,
    settled: () => settleCount,
    done: () => {
      const finish = resolveDone;
      resolveDone = null;
      finish?.();
    },
  };
}

describe('AnimQueue · 串行播放', () => {
  let queue: AnimQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = createAnimQueue();
  });

  afterEach(() => {
    queue.destroy();
    vi.useRealTimers();
  });

  it('上一个没播完之前，绝不启动下一个', () => {
    const a = fakeTask(1);
    const b = fakeTask(2);
    queue.push(a.task);
    queue.push(b.task);

    expect(a.started()).toBe(1);
    expect(b.started()).toBe(0);

    a.done();
    expect(b.started()).toBe(1);
  });

  it('全部播完以后 blocked 才回到 false', () => {
    const a = fakeTask(1);
    const b = fakeTask(2);
    queue.push(a.task);
    queue.push(b.task);
    expect(queue.state().blocked).toBe(true);

    a.done();
    // b 还在播，仍然不能操作
    expect(queue.state().blocked).toBe(true);
    b.done();
    expect(queue.state().blocked).toBe(false);
  });

  it('push 的同一帧就置 blocked，不等 play 真正跑起来', () => {
    const first = fakeTask(1);
    queue.push(first.task);
    const second = fakeTask(2);
    queue.push(second.task);

    expect(queue.state().blocked).toBe(true);
    expect(second.started()).toBe(0);
    expect(queue.state().pending.map((task) => task.id)).toEqual([2]);
  });

  it('注册订阅者时立刻推一次当前状态（和 net 层那三个订阅同一个规矩）', () => {
    const seen: boolean[] = [];
    const a = fakeTask(1);
    queue.push(a.task);

    const unsubscribe = queue.subscribe((state) => {
      seen.push(state.blocked);
    });
    expect(seen).toEqual([true]);

    a.done();
    expect(seen).toEqual([true, false]);
    unsubscribe();
  });

  it('时长倍速改变交给 play 的那个数，1 是原速、0.5 是加速', () => {
    const normal = fakeTask(1, 200);
    queue.push(normal.task);
    expect(normal.durations()).toEqual([200]);
    normal.done();

    queue.setSpeed(0.5);
    const fast = fakeTask(2, 200);
    queue.push(fast.task);
    expect(fast.durations()).toEqual([100]);
  });

  it('play 在回调里同步播完（零时长动画）：队列立刻接下一段，且不留定时器', () => {
    let played = 0;
    const instant: AnimTask = {
      id: 1,
      durationMs: 0,
      play: (onDone) => {
        played += 1;
        // 真的 GSAP 补间不会这样，但「一步到位」的任务（比如已经播过的牌直接落位）会。
        // 它必须在 `play` 返回之前就把这一代收干净，否则队列会永远压在这一段上。
        onDone();
      },
      settle: () => {},
    };
    const after = fakeTask(2, 100);

    queue.push(instant);
    queue.push(after.task);

    expect(played).toBe(1);
    expect(after.started()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(queue.state().active?.id).toBe(2);

    after.done();
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.state().blocked).toBe(false);
  });
});

describe('AnimQueue · 跳过与清空', () => {
  let queue: AnimQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = createAnimQueue();
  });

  afterEach(() => {
    queue.destroy();
    vi.useRealTimers();
  });

  it('skip 中止当前、清空待播，并且立刻不再 blocked', () => {
    const a = fakeTask(1);
    const b = fakeTask(2);
    const c = fakeTask(3);
    queue.push(a.task);
    queue.push(b.task);
    queue.push(c.task);

    queue.skip();

    expect(a.cancels()).toBe(1);
    // 跳过不等于"把这一段播完"：被作废的任务一个都不许再开播，
    // 否则 b 会在画面已经跳到终态的那一帧上又叠一段动画。
    expect(b.started()).toBe(0);
    expect(queue.state().blocked).toBe(false);
    expect(queue.state().pending).toHaveLength(0);
    expect(queue.state().active).toBeNull();
  });

  it('skip 让每个任务都 settle 一次——画面要靠它落到终态', () => {
    const a = fakeTask(1);
    const b = fakeTask(2);
    queue.push(a.task);
    queue.push(b.task);

    queue.skip();

    // 跳过之后队列必须是空的：这一段是「重连/积压清空」那条路的样板，
    // 留着任何一项，`blocked` 就会一直挂着，玩家再也点不动按钮。
    expect(queue.state().pending).toHaveLength(0);
    expect(queue.state().active).toBeNull();
    expect(a.settled()).toBe(1);
    expect(b.settled()).toBe(1);
  });

  it('skip 之后迟到的 done 不会把队列重新拖成忙碌', () => {
    const a = fakeTask(1);
    const b = fakeTask(2);
    queue.push(a.task);
    queue.push(b.task);

    queue.skip();
    // 被中止的那段动画事后仍然回调了（GSAP 的 onComplete 未必被 cancel 挡住）
    a.done();
    b.done();

    expect(queue.state().blocked).toBe(false);
    expect(queue.state().active).toBeNull();
    expect(b.started()).toBe(0);
  });

  /**
   * 边界刻意写死数字、不用 `ANIM_BACKLOG_LIMIT` 去推：这条用例的作用是**逼下一个改数的人**
   * 回来回答「12 段排在屏幕上是多少秒」。为什么会有这条上限记在 DECISIONS.md D-035，
   * 为什么是 12 记在 D-036，出口是页面上那颗「跳过动画」——积压期间它一直可点。
   */
  it('积压超过 12 段：直接清空渲染终态，而不是把一屏幕动画排到明天', () => {
    const tasks = Array.from({ length: 13 }, (_unused, index) => fakeTask(index + 1));
    for (const item of tasks) queue.push(item.task);

    // 前 12 个（含正在播的那个）被允许留下，第 13 个一来就整体作废
    expect(queue.state().blocked).toBe(false);
    expect(queue.state().pending).toHaveLength(0);
    expect(queue.state().active).toBeNull();
    expect(tasks[0]?.cancels()).toBe(1);
    expect(tasks[12]?.started()).toBe(0);
    expect(tasks[12]?.settled()).toBe(1);
  });

  it('正好 12 段不算积压，照旧排队播放', () => {
    const tasks = Array.from({ length: 12 }, (_unused, index) => fakeTask(index + 1));
    for (const item of tasks) queue.push(item.task);

    expect(queue.state().blocked).toBe(true);
    expect(queue.state().pending).toHaveLength(11);
  });

  it('flush 是「重连后直接渲染终态」那条路：不播、但一律 settle', () => {
    const a = fakeTask(1);
    const b = fakeTask(2);
    queue.push(a.task);
    queue.push(b.task);

    queue.flush();

    expect(a.cancels()).toBe(1);
    expect(b.settled()).toBe(1);
    expect(queue.state().blocked).toBe(false);
  });

  it('空队列上 skip / flush 都是空操作，不报错也不推状态', () => {
    let pushes = 0;
    const unsubscribe = queue.subscribe(() => {
      pushes += 1;
    });
    queue.skip();
    queue.flush();
    // 注册时那一次是同步推的当前值，之后不该再有
    expect(pushes).toBe(1);
    unsubscribe();
  });
});

describe('AnimQueue · 不许卡死', () => {
  let queue: AnimQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = createAnimQueue();
  });

  afterEach(() => {
    queue.destroy();
    vi.useRealTimers();
  });

  it('play 同步抛错，队列继续往下走（一段动画写坏了不能锁住整张桌）', () => {
    const broken: AnimTask = {
      id: 1,
      durationMs: 100,
      play: () => {
        throw new Error('boom');
      },
      settle: () => undefined,
    };
    const next = fakeTask(2);

    queue.push(broken);
    queue.push(next.task);

    expect(next.started()).toBe(1);
    expect(queue.state().blocked).toBe(true);
    next.done();
    expect(queue.state().blocked).toBe(false);
  });

  it('play 一直不 done：看门狗到点强制推进，并中止那一段', () => {
    const stuck = fakeTask(1, 100);
    const after = fakeTask(2);
    queue.push(stuck.task);
    queue.push(after.task);

    vi.advanceTimersByTime(ANIM_WATCHDOG_MS);

    expect(stuck.cancels()).toBe(1);
    expect(after.started()).toBe(1);
  });

  it('看门狗留下的那段动画，事后 done 也不会让队列多推进一次', () => {
    const stuck = fakeTask(1, 100);
    const after = fakeTask(2, 100);
    queue.push(stuck.task);
    queue.push(after.task);

    vi.advanceTimersByTime(ANIM_WATCHDOG_MS);
    expect(after.started()).toBe(1);
    // 卡住那段突然活过来
    stuck.done();
    expect(queue.state().active?.id).toBe(2);

    after.done();
    expect(queue.state().blocked).toBe(false);
  });

  it('destroy 之后看门狗不再开火', () => {
    const stuck = fakeTask(1, 100);
    queue.push(stuck.task);
    queue.destroy();

    vi.advanceTimersByTime(ANIM_WATCHDOG_MS * 2);
    expect(stuck.cancels()).toBe(0);
  });

  it('播完即撤：已收尾的那段不许留下待炸的定时器', () => {
    const a = fakeTask(1, 100);
    const b = fakeTask(2, 100);
    queue.push(a.task);
    queue.push(b.task);

    a.done();
    // 此刻队列里只该有 b 那一段的看门狗。a 的那枚如果不撤，它会一直活到 5 秒后，
    // 而 `destroy()` 只清得掉「正在播的那段」——离开牌桌页面时它就漏在页面上了。
    // （它开火时会被 `epoch` 守卫挡回来，所以红不了的是计数，不是行为。）
    expect(vi.getTimerCount()).toBe(1);

    b.done();
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.state().blocked).toBe(false);
  });

  it('迟到的看门狗打不动正在播的那一段', () => {
    const a = fakeTask(1, 100);
    const b = fakeTask(2, 100);
    const c = fakeTask(3, 100);
    queue.push(a.task);
    queue.push(b.task);
    queue.push(c.task);

    a.done();
    vi.advanceTimersByTime(ANIM_WATCHDOG_MS / 2);
    b.done();
    expect(c.started()).toBe(1);

    // 走到 t=5000：a、b 那两代的看门狗在这里到点，`epoch` 守卫必须把它们判成过期
    vi.advanceTimersByTime(ANIM_WATCHDOG_MS / 2);
    expect(a.cancels()).toBe(0);
    expect(b.cancels()).toBe(0);
    expect(c.cancels()).toBe(0);
    expect(queue.state().active?.id).toBe(3);
    expect(queue.state().blocked).toBe(true);

    // c 自己的看门狗（t=2500 挂上、t=7500 到点）不能因为撤了旧的一起消失
    vi.advanceTimersByTime(ANIM_WATCHDOG_MS);
    expect(c.cancels()).toBe(1);
    expect(queue.state().blocked).toBe(false);
  });
});
