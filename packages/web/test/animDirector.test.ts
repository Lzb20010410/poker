/**
 * 事件 → 队列胶水的单测。
 *
 * 渲染层这里用假的：这一段要钉的是**分流**（哪些事件进队列、以什么时长、什么 id），
 * 不是画得对不对。真 GSAP 的验收在 `/dev/replay`（M3.2）用眼睛做。
 */

import { describe, expect, it, vi } from 'vitest';
import type { S2C_Broadcast } from '@poker-room/shared/view';

import { createAnimDirector } from '../src/anim/director';
import type { AnimDirectorEnv } from '../src/anim/env';
import type { AnimPlan } from '../src/anim/plan';
import type { AnimTask } from '../src/anim/types';

function fakeRenderer(plans: AnimPlan[]) {
  let done: (() => void) | null = null;
  const task = (plan: AnimPlan, id: number): AnimTask => ({
    id,
    durationMs: plan.durationMs,
    play: (onDone) => {
      done = onDone;
      return () => {
        done = null;
      };
    },
    settle: () => {
      done = null;
    },
  });
  return {
    render: (plan: AnimPlan, id: number): AnimTask => {
      plans.push(plan);
      return task(plan, id);
    },
    /** 让正在播的那一段立刻结束，好把下一段从 pending 推到 active */
    finish: (): void => {
      const callback = done;
      done = null;
      callback?.();
    },
  };
}

const WIDE: AnimDirectorEnv = { narrow: false, animate: true };
const NARROW: AnimDirectorEnv = { narrow: true, animate: true };

function directorFor(env: AnimDirectorEnv, plans: AnimPlan[]) {
  const fake = fakeRenderer(plans);
  return { ...fake, director: createAnimDirector({ renderer: fake.render, env: () => env }) };
}

describe('分流：只有会变画面的事件才排队', () => {
  it('发牌、公共牌、动作、派彩、本手结束各入一段', () => {
    const plans: AnimPlan[] = [];
    const { director } = directorFor(WIDE, plans);
    const events: readonly S2C_Broadcast[] = [
      { t: 'shuffle' },
      { t: 'deal:start', count: 6, startSeat: 0 },
      { t: 'board:deal', phase: 'flop', cards: [{ rank: 14, suit: 's' }] },
      { t: 'action:made', seatIndex: 2, action: { type: 'call' }, chipsDelta: 20 },
      { t: 'pot:awarded', potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] },
      { t: 'hand:end', results: [] },
    ];
    for (const event of events) director.handle(event);
    expect(plans.map((plan) => plan.kind)).toEqual(['shuffle', 'deal', 'board', 'action', 'award', 'handEnd']);
  });

  /**
   * 这条比上面那条重要。`turn:change` 一手牌里要出现十几次，每次几秒——
   * 一旦排进队列，玩家看到的就是「按钮一直灰着」，而且跳过动画变成唯一的出口。
   * `player:emoji` 同理：表情是飘在画面上的，不该挡住下一段牌。
   */
  it('回合迁移、阶段标记、进出座、表情、补筹码一段都不排', () => {
    const plans: AnimPlan[] = [];
    const { director } = directorFor(WIDE, plans);
    const ambient: readonly S2C_Broadcast[] = [
      { t: 'hand:start', handId: 'h1', dealerSeat: 0, sbSeat: 1, bbSeat: 2 },
      { t: 'turn:change', seatIndex: 2, deadline: 1_800_000_030_000 },
      { t: 'round:end', phase: 'PREFLOP' },
      { t: 'showdown:start', pots: [{ amount: 300, eligible: [0] }] },
      { t: 'player:joined', seatIndex: 0, profile: { id: 'a', nickname: 'A', avatarSeed: 'a' } },
      { t: 'player:left', seatIndex: 0 },
      { t: 'player:emoji', seatIndex: 0, emoji: '👍' },
      { t: 'chips:rebuy', seatIndex: 0 },
    ];
    for (const event of ambient) director.handle(event);
    expect(plans).toEqual([]);
    expect(director.queue.state().blocked).toBe(false);
  });
});

describe('档位：入队时就把视口系数算进去', () => {
  it('窄屏的时长是宽屏的 0.8，队列拿到的是已经缩放的数', () => {
    const wide: AnimPlan[] = [];
    const narrow: AnimPlan[] = [];
    directorFor(WIDE, wide).director.handle({ t: 'shuffle' });
    directorFor(NARROW, narrow).director.handle({ t: 'shuffle' });
    expect(wide[0]?.durationMs).toBe(900);
    expect(narrow[0]?.durationMs).toBe(720);
  });

  it('系统要求减弱动态效果：一段都不排，按钮也不会因动画而灰', () => {
    const plans: AnimPlan[] = [];
    const { director } = directorFor({ narrow: false, animate: false }, plans);
    director.handle({ t: 'deal:start', count: 8, startSeat: 0 });
    director.handle({ t: 'pot:awarded', potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] });
    expect(plans).toEqual([]);
    expect(director.queue.state().blocked).toBe(false);
  });

  it('横竖屏在两次动画之间翻转，后一段用的是新档', () => {
    let env: AnimDirectorEnv = WIDE;
    const plans: AnimPlan[] = [];
    const fake = fakeRenderer(plans);
    const director = createAnimDirector({ renderer: fake.render, env: () => env });
    director.handle({ t: 'shuffle' });
    env = NARROW;
    fake.finish();
    director.handle({ t: 'shuffle' });
    fake.finish();
    expect(plans.map((plan) => plan.durationMs)).toEqual([900, 720]);
  });
});

describe('任务身份', () => {
  it('id 逐段递增，且原始事件原样带给渲染层', () => {
    const plans: AnimPlan[] = [];
    const ids: number[] = [];
    const fake = fakeRenderer(plans);
    const director = createAnimDirector({
      renderer: (plan, id) => {
        ids.push(id);
        return fake.render(plan, id);
      },
      env: () => WIDE,
    });
    const event: S2C_Broadcast = { t: 'shuffle' };
    director.handle(event);
    director.handle({ t: 'shuffle' });
    expect(ids).toEqual([1, 2]);
    expect(plans[0]?.event).toBe(event);
  });

  it(`积压到第 6 段就整条作废：重连补历史时画面直接给终态`, () => {
    const plans: AnimPlan[] = [];
    const { director } = directorFor(WIDE, plans);
    for (let i = 0; i < 6; i += 1) director.handle({ t: 'shuffle' });
    expect(director.queue.state().blocked).toBe(false);
    expect(director.queue.state().pending).toEqual([]);
    // 作废不等于丢弃：六段都到过终态，渲染层的清理钩子一段都不能少
    expect(plans).toHaveLength(6);
  });
});

/** 队列自己的规则（串行、看门狗、倍速）在 `animQueue.test.ts` 里钉，这里只验胶水把门传对了 */
describe('胶水透传队列控制', () => {
  it('跳过与倍速从 director 也能走到队列', () => {
    const plans: AnimPlan[] = [];
    const { director } = directorFor(WIDE, plans);
    director.handle({ t: 'deal:start', count: 8, startSeat: 0 });
    expect(director.queue.state().blocked).toBe(true);
    const setSpeed = vi.spyOn(director.queue, 'setSpeed');
    director.queue.setSpeed(0.5);
    expect(setSpeed).toHaveBeenCalledWith(0.5);
    director.queue.skip();
    expect(director.queue.state().blocked).toBe(false);
  });
});
