/**
 * 动画任务外壳的单测（`src/anim/job.ts`）。
 *
 * ## 幂等是这里唯一值得测的事
 *
 * 队列有三条路都会走到同一段的收尾：正常播完、玩家按跳过（先中止句柄再 `settle`）、
 * 积压清空或 5 秒看门狗到点。三条路前后脚发生是常态，不是异常。
 * 于是 `dispose` 里那几件事必须做成调多少次都一样——写错一次的后果不是崩，是
 * **遮罩计数少还一次**，那块区域从此永久隐身（`scene.ts` 的引用计数）。
 *
 * 另外两件事各自拦一个具体的坑：
 * - `inertTask` / 「这一帧没东西可播」必须**同步**放行：空 timeline 不保证回调
 *   `onComplete`，异步等下去就只能等看门狗，玩家会觉得牌桌卡住了；
 * - `fitTimeline` 把墙钟时长压成队列预留的时长，倍速那一档才不会「牌还在飞按钮就亮」。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  arc,
  createAnimTask,
  fitTimeline,
  inertTask,
  killTimeline,
  type AnimJob,
} from '../src/anim/job';
import { gsap } from '../src/anim/gsap';

afterEach(() => {
  gsap.globalTimeline.clear();
});

/**
 * 记账用的假 job。
 *
 * 收尾回调放在返回值上而不是塞进数组：测试要的是「什么时候能让它播完」这件事，
 * 用一个数组兼职装函数会把类型搞脏。
 */
function probeJob(log: string[]): AnimJob & { end: () => void } {
  const job: AnimJob & { end: () => void } = {
    start: (durationMs, onEnd) => {
      log.push(`start:${String(durationMs)}`);
      job.end = onEnd;
    },
    dispose: () => {
      log.push('dispose');
    },
    end: () => undefined,
  };
  return job;
}

describe('任务收尾幂等', () => {
  it('播完的次序是「先收尾、再放行下一段」，且只收尾一次', () => {
    const log: string[] = [];
    const job = probeJob(log);
    const task = createAnimTask(7, 420, job);
    task.play(() => log.push('done'), 420);
    expect(log).toEqual(['start:420']);

    job.end();
    task.settle();
    expect(log).toEqual(['start:420', 'dispose', 'done']);
  });

  it('跳过 = 中止句柄 + settle 两条路，job.dispose 只发生一次', () => {
    const log: string[] = [];
    const task = createAnimTask(1, 100, probeJob(log));
    const cancel = task.play(vi.fn(), 100);
    cancel?.();
    task.settle();
    task.settle();
    expect(log).toEqual(['start:100', 'dispose']);
  });

  it('settle 之后 play：不播迟到的动画，直接放行下一段', () => {
    const log: string[] = [];
    const job = probeJob(log);
    const task = createAnimTask(1, 100, job);
    task.settle();
    const done = vi.fn();
    task.play(done, 100);
    expect(log).toEqual(['dispose']);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('id 与时长原样透给队列', () => {
    const task = createAnimTask(12, 900, probeJob([]));
    expect(task.id).toBe(12);
    expect(task.durationMs).toBe(900);
  });
});

describe('什么都不播的那一段', () => {
  it('inertTask 同步放行，settle 无事发生也不炸', () => {
    const done = vi.fn();
    const task = inertTask(3, 1200);
    task.play(done, 960);
    expect(done).toHaveBeenCalledTimes(1);
    expect(() => task.settle()).not.toThrow();
  });
});

describe('时长归一', () => {
  it('把墙钟时长压到队列预留的那个数', () => {
    const timeline = gsap.timeline();
    timeline.to({ value: 0 }, { value: 1, duration: 2 });
    expect(timeline.duration()).toBe(2);
    fitTimeline(timeline, 1000);
    // 2 秒的内容要在 1 秒里放完 → 2 倍速
    expect(timeline.timeScale()).toBe(2);
    fitTimeline(timeline, 4000);
    expect(timeline.timeScale()).toBeCloseTo(0.5, 10);
    timeline.kill();
  });

  it('空时间轴不动 timeScale：除下去会得到 Infinity，整条轴被当成瞬间完成', () => {
    const timeline = gsap.timeline();
    expect(timeline.duration()).toBe(0);
    fitTimeline(timeline, 500);
    expect(timeline.timeScale()).toBe(1);
    timeline.kill();
  });

  it('预留时长为 0 时同样不改速，免得给 0 除', () => {
    const timeline = gsap.timeline();
    timeline.to({ value: 0 }, { value: 1, duration: 1 });
    fitTimeline(timeline, 0);
    expect(timeline.timeScale()).toBe(1);
    timeline.kill();
  });
});

describe('弧线', () => {
  it('第一个点恒在原点：幽灵的落脚位置是 left/top，motionPath 给的是位移', () => {
    // 首点若不是 {0,0}，tween 第一帧就把幽灵按到绝对坐标上，牌会先跳一下再飞
    expect(arc({ x: 120, y: 340 }, { x: 500, y: 200 }, 1).path[0]).toEqual({ x: 0, y: 0 });
  });

  it('中间点是位移中点加弓高，终点是净位移', () => {
    const { path } = arc({ x: 10, y: 20 }, { x: 110, y: 20 }, 1);
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: -18 },
      { x: 100, y: 0 },
    ]);
  });

  it('lift 的符号决定往哪边拱', () => {
    expect(arc({ x: 0, y: 0 }, { x: 0, y: 100 }, 1).path[1]?.y).toBeLessThan(50);
    expect(arc({ x: 0, y: 0 }, { x: 0, y: 100 }, -1).path[1]?.y).toBeGreaterThan(50);
  });

  it('再近的路也至少拱 12px：两点几乎重合时不该画成一条直线', () => {
    expect(arc({ x: 0, y: 0 }, { x: 6, y: 0 }, 1).path[1]?.y).toBe(-12);
  });
});

describe('收尾时不留下半截变换', () => {
  it('杀掉时间轴，并把碰过的元素上的变换与透明度抹干净', () => {
    const ghost = document.createElement('div');
    const timeline = gsap.timeline();
    timeline.to(ghost, { x: 40, opacity: 0.2, duration: 5 });
    gsap.set(ghost, { x: 40 });
    expect(ghost.style.transform).not.toBe('');

    killTimeline(timeline, [ghost]);
    expect(ghost.style.transform).toBe('');
    expect(ghost.style.opacity).toBe('');
    expect(gsap.getTweensOf(ghost)).toHaveLength(0);
  });

  it('时间轴还没造出来（body 就失败了）也要能清元素', () => {
    const ghost = document.createElement('div');
    gsap.set(ghost, { x: 12 });
    killTimeline(null, [ghost]);
    expect(ghost.style.transform).toBe('');
  });
});
