/**
 * 事件 → 动画的映射层单测（SPEC §3.2 的时长表 + §3.1 的「环境类不入队」）。
 *
 * 这一层是纯函数，所以这里能把它测干净；M3.3~M3.5 的 GSAP 代码在这个仓库里
 * 只能靠 `/dev/replay` 目视验收（jsdom 不算 layout、不动画）。**时长表是机器能钉的
 * 那部分**，所以钉死在这里，别让它漂到只有肉眼能看见的地方。
 */

import { describe, expect, it } from 'vitest';
import type { S2C_Broadcast } from '@poker-room/shared/view';
import type { RevealView } from '../src/net/types';
import { dealTimeline, planEvent, revealPlan } from '../src/anim/plan';

const WIDE = { narrow: false } as const;
const NARROW = { narrow: true } as const;

const ace = { rank: 14, suit: 's' } as const;
const king = { rank: 13, suit: 'h' } as const;

/** 只关心 `action.type` 决定哪一行时长，其余字段给合法值即可 */
const action = (type: 'fold' | 'check' | 'call' | 'raise' | 'allIn'): S2C_Broadcast => ({
  t: 'action:made',
  seatIndex: 3,
  action: type === 'raise' ? { type, totalBet: 60 } : { type },
  chipsDelta: 50,
});

describe('时长表逐条对上 SPEC §3.2', () => {
  it.each([
    [{ t: 'shuffle' }, 900],
    [{ t: 'board:deal', phase: 'flop', cards: [ace, king, { rank: 2, suit: 'd' }] }, 1400],
    [{ t: 'board:deal', phase: 'turn', cards: [ace] }, 700],
    [{ t: 'board:deal', phase: 'river', cards: [ace] }, 700],
    [action('fold'), 380],
    [action('check'), 300],
    [action('call'), 420],
    [action('raise'), 420],
    [action('allIn'), 420],
    [{ t: 'pot:awarded', potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] }, 1200],
    [{ t: 'hand:end', results: [] }, 2000],
  ] as const)('%o → %i ms', (event, expected) => {
    expect(planEvent(event, WIDE)?.durationMs).toBe(expected);
  });

  it('窄屏（<640px）整表 ×0.8，一条都不能漏', () => {
    const events: readonly S2C_Broadcast[] = [
      { t: 'shuffle' },
      { t: 'deal:start', count: 8, startSeat: 0 },
      { t: 'board:deal', phase: 'flop', cards: [ace, king, { rank: 2, suit: 'd' }] },
      { t: 'board:deal', phase: 'turn', cards: [ace] },
      action('fold'),
      action('check'),
      action('call'),
      { t: 'pot:awarded', potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] },
      { t: 'hand:end', results: [] },
    ];
    for (const event of events) {
      const wide = planEvent(event, WIDE);
      const narrow = planEvent(event, NARROW);
      // 整数毫秒：`.5` 这种值传到 GSAP 里会变成半帧的抖动，也是 `durationMs` 的契约
      expect(narrow?.durationMs).toBe(Math.round((wide?.durationMs ?? 0) * 0.8));
      expect(Number.isInteger(narrow?.durationMs)).toBe(true);
    }
  });
});

describe('发牌时长随人数（8 人 ≈3.2s、2 人 ≈1.1s 是 M3.3 的验收线）', () => {
  it('两个锚点各落在自己的档上', () => {
    expect(planEvent({ t: 'deal:start', count: 2, startSeat: 0 }, WIDE)?.durationMs).toBe(1100);
    expect(planEvent({ t: 'deal:start', count: 8, startSeat: 0 }, WIDE)?.durationMs).toBe(3200);
  });

  it('人越多越久，且不因为取整倒挂', () => {
    let previous = 0;
    for (let count = 2; count <= 8; count += 1) {
      const duration = planEvent({ t: 'deal:start', count, startSeat: 0 }, WIDE)?.durationMs ?? 0;
      expect(duration).toBeGreaterThan(previous);
      previous = duration;
    }
  });

  /**
   * 队列**预留**的时长和动画**实际播**的时长必须同源，否则两者一漂移就会出现
   * 「队列以为还在播、画面早停了」（按钮一直灰着）或反过来（牌还在飞、按钮能点了，
   * 玩家这一步打在画面上还没到的回合）。这里就是钉「同源」这一条。
   */
  it('总时长就是「单张 260ms + 逐张间隔」串起来的，动画层不需要自己再算一遍', () => {
    for (let count = 2; count <= 8; count += 1) {
      const { flightMs, intervalMs, totalMs } = dealTimeline(count);
      expect(flightMs).toBe(260);
      expect(flightMs + intervalMs * (2 * count - 1)).toBe(totalMs);
      expect(planEvent({ t: 'deal:start', count, startSeat: 0 }, WIDE)?.durationMs).toBe(totalMs);
    }
  });

  it('人数越界只按牌桌上限收敛，不炸也不播出一条负时长的任务', () => {
    expect(planEvent({ t: 'deal:start', count: 1, startSeat: 0 }, WIDE)?.durationMs).toBe(1100);
    expect(planEvent({ t: 'deal:start', count: 99, startSeat: 0 }, WIDE)?.durationMs).toBe(3200);
  });
});

/**
 * 这几条事件**不该**占用动画队列：它们描述的是「现在是什么样」而不是「刚才发生了什么」，
 * 画面由快照直接呈现。入队的代价很实在——`turn:change` 每手要发十几次，
 * 全排进队列就意味着玩家每次都要等一圈动画才能点按钮，而且跳过按钮会变成唯一的出口。
 */
describe('环境类事件不入队', () => {
  it.each([
    [{ t: 'hand:start', handId: 'h1', dealerSeat: 0, sbSeat: 1, bbSeat: 2 }],
    [{ t: 'turn:change', seatIndex: 2, deadline: 1_800_000_030_000 }],
    [{ t: 'round:end', phase: 'PREFLOP' }],
    [{ t: 'showdown:start', pots: [{ amount: 300, eligible: [0] }] }],
    [{ t: 'player:joined', seatIndex: 0, profile: { id: 'a', nickname: 'A', avatarSeed: 'a' } }],
    [{ t: 'player:left', seatIndex: 0 }],
    [{ t: 'player:emoji', seatIndex: 0, emoji: '👍' }],
    [{ t: 'chips:rebuy', seatIndex: 0 }],
  ] as const)('%o → null', (event) => {
    expect(planEvent(event, WIDE)).toBeNull();
  });
});

/** 渲染层按 `kind` 找播法，所以每条入队的事件都必须带一个能对上注册表的 kind */
describe('每条动画都归到一个 kind', () => {
  it('发牌 / 公共牌 / 动作 / 派彩 / 本手结束 各自成组', () => {
    expect(planEvent({ t: 'shuffle' }, WIDE)?.kind).toBe('shuffle');
    expect(planEvent({ t: 'deal:start', count: 2, startSeat: 0 }, WIDE)?.kind).toBe('deal');
    expect(planEvent({ t: 'board:deal', phase: 'flop', cards: [ace] }, WIDE)?.kind).toBe('board');
    expect(planEvent(action('fold'), WIDE)?.kind).toBe('action');
    expect(
      planEvent(
        { t: 'pot:awarded', potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] },
        WIDE,
      )?.kind,
    ).toBe('award');
    expect(planEvent({ t: 'hand:end', results: [] }, WIDE)?.kind).toBe('handEnd');
  });

  it('原始事件原样带下去，渲染层不用再校验一遍', () => {
    const event: S2C_Broadcast = { t: 'shuffle' };
    expect(planEvent(event, WIDE)?.event).toBe(event);
  });
});

/**
 * 摊牌亮牌的时长与「一次 patch 只排一段」。
 *
 * 它不走 `planEvent`：按 D-002 / D-013，亮牌是**定向消息**，永远不在广播流里，
 * 所以渲染层拿到的是一段 `reveals` 的增量（`revealPlan` 的入参），而不是事件。
 * 「多人同时摊牌只播一段 500ms」是这条链路上唯一会被写坏的地方——按人排的话，
 * 8 人桌一次摊牌要把按钮灰住 4 秒，而画面上的牌早就翻完了。
 */
describe('摊牌亮牌（定向消息，不经 planEvent）', () => {
  const reveal = (seatIndex: number): RevealView => ({
    playerId: `p-${seatIndex}`,
    seatIndex,
    cards: [ace, king],
  });

  it('SPEC §3.2 的 500ms，窄屏同样 ×0.8', () => {
    expect(revealPlan([reveal(3)], WIDE)?.durationMs).toBe(500);
    expect(revealPlan([reveal(3)], NARROW)?.durationMs).toBe(400);
  });

  it('kind 是 reveal，事件类型与广播流分开', () => {
    const plan = revealPlan([reveal(3)], WIDE);
    expect(plan?.kind).toBe('reveal');
    expect(plan?.event.t).toBe('reveal');
  });

  it('几个人同一次摊牌也只是一段，行全带下去供渲染层逐格翻', () => {
    const rows = [reveal(1), reveal(3), reveal(5)];
    const plan = revealPlan(rows, WIDE);
    expect(plan?.durationMs).toBe(500);
    expect(plan?.event.t === 'reveal' && plan.event.rows).toBe(rows);
  });

  it('增量为空不入队：没有新翻的牌却要灰 500ms 按钮，是纯亏', () => {
    expect(revealPlan([], WIDE)).toBeNull();
  });
});
