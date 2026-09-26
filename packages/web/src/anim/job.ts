/**
 * 把「一段动画」变成队列认识的任务（SPEC §3.1）。
 *
 * ## 幂等是这里唯一要紧的事
 *
 * 队列有三条路都会走到收尾：正常播完（动画自己回调 `done`）、玩家按跳过
 * （`cancel` 句柄 + `settle`）、积压超线或看门狗到点（同上）。三条路可能前后脚发生，
 * 而 `AnimTask` 的契约写明 `settle` 在 `cancel` **之后**还会再调一次。
 * 于是 `dispose` 里那三件事——杀 timeline、摘幽灵、放遮罩——必须做成调多少次都一样，
 * 否则第二次会把已经还原的 `visibility` 再写一遍、幽灵摘第二遍（不炸，但遮罩计数会跑偏，
 * 结果是画面上一块区域永久隐身）。
 *
 * ## 时长以队列给的为准
 *
 * `start(ms)` 收到的 `ms` 已经乘过倍速，而 timeline 是按「看着舒服」的节奏搭的。
 * 所以这里把 timeline 的 `timeScale` 反过来乘一次，让**墙钟时长**等于队列预留的时长。
 * 队列预留和实际播放不同源会出两种玩家都能感觉到的错：牌还在飞按钮就亮了，
 * 或者牌早停了按钮还灰着（像是卡住）。
 */

import type { AnimTask } from './types';
import { gsap } from './gsap';

/**
 * GSAP 时间轴的类型别名，在这里收一次口。
 *
 * `draw/` 下那几个文件只需要"能往时间轴上挂 tween"这件事，让它们各自去引用全局
 * `gsap` 命名空间，读代码的人就得先确认那个名字是值还是类型。
 */
export type Timeline = gsap.core.Timeline;

/** 一段动画：开播与收尾。收尾幂等，且可能在开播之前就被调用（待播段被清空） */
export interface AnimJob {
  readonly start: (durationMs: number, onEnd: () => void) => void;
  readonly dispose: () => void;
}

/**
 * 渲染层造出来的任务。
 *
 * `play` 在已经收尾过的时候直接放行：那种情况下再播一段「迟到的动画」，
 * 玩家看到的是一段早就该过去的表演挡在当前的操作前面。
 */
export function createAnimTask(id: number, durationMs: number, job: AnimJob): AnimTask {
  let closed = false;
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    job.dispose();
  };
  return {
    id,
    durationMs,
    play: (done, scaledMs) => {
      if (closed) {
        done();
        return;
      }
      job.start(scaledMs, () => {
        dispose();
        done();
      });
      return dispose;
    },
    settle: dispose,
  };
}

/** 什么都不播的任务：减弱动效、场景还没挂上、或者这一段压根没有落点可找 */
export function inertTask(id: number, durationMs: number): AnimTask {
  return {
    id,
    durationMs,
    play: (done) => {
      done();
    },
    settle: () => {
      /* 没有遮罩也没有幽灵，无事可收 */
    },
  };
}

/**
 * 把 timeline 的实际墙钟时长压到 `durationMs`。
 *
 * `natural` 为 0（一条空 timeline）时不动 `timeScale`：给 0 除下去会得到 `Infinity`，
 * GSAP 会把整条时间轴当成瞬间完成——那正是「什么都不播」想要的行为，但空 timeline 的
 * `onComplete` 要等 ticker 下一帧才触发（标签页被节流时根本不触发），所以调用方必须
 * 自己走 `inertTask` 那条路（见 `renderer.ts`）。
 */
export function fitTimeline(timeline: Timeline, durationMs: number): void {
  const natural = timeline.duration();
  if (natural <= 0 || durationMs <= 0) return;
  timeline.timeScale(natural / (durationMs / 1000));
}

/** 一段弧线上的点：起终点各按自己的盒子算，弓高按两点距离的比例给，横着飞和竖着飞一样弯 */
export interface Arc {
  /** 每次调用现造的一份字面量，除了交给 `motionPath` 没有别的去处 */
  readonly path: ArcPoint[];
}

/**
 * 弧线端点。
 *
 * 这里的两个字段**不带 `readonly`**，不是漏写：`motionPath` 的入参类型是 `Point2D[]`，
 * 而 GSAP 的声明里那一项是可变的。给它一个 `readonly x/y` 的对象数组要额外断言一次，
 * 而断言是"我相信类型系统在这一处说错了"——为一个类型噪音花掉一次信任不值得。
 * 数组本身在 `Arc` 里仍是 readonly，我们不往回塞点。
 */
export interface ArcPoint {
  x: number;
  y: number;
}

/**
 * 抛物线的**相对**坐标。
 *
 * `motionPath` 拿到的是 `x`/`y` 变换值，而幽灵的落脚位置是用 `left/top` 摆的，
 * 所以第一个点必须是 `{x:0,y:0}`——否则 tween 一开始就把幽灵按到绝对坐标上去，
 * 第一帧就跳位。`lift` 是弓高（正数往屏幕上方拱）。
 */
export function arc(from: { x: number; y: number }, to: { x: number; y: number }, lift: number): Arc {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const rise = Math.max(12, distance * 0.18) * (lift >= 0 ? -1 : 1);
  return {
    path: [
      { x: 0, y: 0 },
      { x: dx * 0.5, y: dy * 0.5 + rise },
      { x: dx, y: dy },
    ],
  };
}

/** 杀掉这条时间轴并把它碰过的元素变换清掉，免得残留一个 `translate` */
export function killTimeline(timeline: gsap.core.Timeline | null, nodes: readonly HTMLElement[]): void {
  if (timeline !== null) timeline.kill();
  for (const node of nodes) {
    gsap.set(node, { clearProps: 'transform,opacity' });
  }
}
