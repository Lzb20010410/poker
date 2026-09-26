/**
 * 渲染层（`src/anim/draw/`）的单测：遮罩名单、补扫、找不到落点时的退化。
 *
 * ## jsdom 能验什么、不能验什么
 *
 * **不能**：牌有没有飞到位、翻面好不好看——那是 `/dev/replay` 的肉眼活（D-028）。
 * **能**：三件写坏了会立刻在真机上咬人的事，全部与渲染无关：
 *
 * 1. **每一类遮的是哪些格子**。遮多了，玩家看不到终态；遮少了，他先看到底池数字跳变、
 *    再看筹码慢悠悠飞过去。名单是 `maskKeys()` 的返回值，可枚举、可钉死。
 * 2. **补扫**。`start` 那一刻 React 可能刚 commit 完，新格子这时候才存在；窗口关掉之后
 *    必须停手，否则一段动画会一直往里加遮罩，收尾时少还几个（见 `kit.ts` 文件头）。
 * 3. **落点找不到时整段不演**。这一条是「按钮不会灰 5 秒」的唯一保证：body 返回 `false`
 *    必须**同步**放行并把自己上过的遮罩全部还原。
 *
 * 顺带钉住 `renderer.ts` 那张注册表：`kind` 与事件对不上时退化成 `inertTask`，
 * 而不是把一条画不出东西的时间轴塞进队列。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { S2C_Broadcast } from '@poker-room/shared/view';

import type { RevealView } from '../src/net/types';
import { gsap } from '../src/anim/gsap';
import type { AnimJob } from '../src/anim/job';
import { actionJob } from '../src/anim/draw/action';
import { awardJob, handEndJob } from '../src/anim/draw/award';
import { boardJob } from '../src/anim/draw/board';
import { dealJob, shuffleJob } from '../src/anim/draw/deal';
import { revealJob } from '../src/anim/draw/reveal';
import {
  MASK_RESCAN_FRAMES,
  boardKey,
  dealOrder,
  deckCenter,
  holeKey,
  holeSeats,
  sceneJob,
  seatKey,
} from '../src/anim/draw/kit';
import type { AnimKind, AnimPlan } from '../src/anim/plan';
import { createAnimScene, type AnimScene } from '../src/anim/scene';
import { createRenderer } from '../src/anim/renderer';

const LAYER = '100,50,800,600';

/** 一张 2-3 人的迷你牌桌：所有锚点都在，尺寸各不相同（否则「坐标只有一个原点」测不出来） */
const HTML = `
<div id="page" style="position:relative">
  <div data-anim="deck" data-rect="520,120,40,56"></div>
  <div data-anim="pot" data-rect="360,300,120,28"></div>
  <div data-anim="seat-0" data-rect="140,420,120,70"></div>
  <div data-anim="seat-1" data-rect="620,420,120,70"></div>
  <span data-anim="hole-0" data-self data-rect="150,490,90,56">
    <img class="card-view card-view--s" data-rect="150,490,40,56" src="data:image/svg+xml,%3Csvg/%3E" />
    <img class="card-view card-view--back" data-rect="196,490,40,56" src="data:image/svg+xml,%3Csvg/%3E" />
  </span>
  <span data-anim="hole-1" data-rect="630,490,90,56">
    <span class="card-view card-view--back" data-rect="630,490,40,56"></span>
    <span class="card-view card-view--back" data-rect="676,490,40,56"></span>
  </span>
  ${[0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<div data-anim="board-${String(i)}" data-rect="${String(300 + i * 46)},240,40,56">
           <span class="card-view card-view--empty" data-rect="${String(300 + i * 46)},240,40,56"></span>
         </div>`,
    )
    .join('')}
  <b data-anim="hole-o"></b>
  <div id="layer" class="anim-layer" data-rect="${LAYER}"></div>
</div>`;

/** jsdom 没有 layout：`getBoundingClientRect()` 恒为全 0，桩把 `data-rect` 当视口坐标吐出来 */
function stubRects(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const raw = this.getAttribute('data-rect');
    const [left = 0, top = 0, width = 0, height = 0] =
      raw === null ? [] : raw.split(',').map((part) => Number(part));
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
  });
}

function mount(): AnimScene {
  document.body.innerHTML = HTML;
  const layer = document.querySelector<HTMLElement>('#layer');
  if (layer === null) throw new Error('fixture 没挂上');
  return createAnimScene(layer);
}

afterEach(() => {
  gsap.globalTimeline.clear();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** 此刻被遮住的锚点键名。只看 `[data-anim]` 本身，格子内部的牌不算一条独立名单 */
function masked(scene: AnimScene): string[] {
  const scope = scene.layer.parentElement;
  if (scope === null) throw new Error('layer 没有父级');
  return [...scope.querySelectorAll<HTMLElement>('[data-anim]')]
    .filter((el) => el.style.visibility === 'hidden')
    .map((el) => el.dataset['anim'] ?? '')
    .sort();
}

function ghosts(scene: AnimScene): number {
  return scene.layer.querySelectorAll<HTMLElement>('[data-anim-ghost]').length;
}

const ace = { rank: 14, suit: 's' } as const;
const king = { rank: 13, suit: 'h' } as const;
const deuce = { rank: 2, suit: 'd' } as const;

function plan(kind: AnimKind, event: S2C_Broadcast | { t: 'reveal'; rows: readonly RevealView[] }): AnimPlan {
  return { kind, durationMs: 600, event };
}

const row = (seatIndex: number): RevealView => ({
  playerId: `p-${String(seatIndex)}`,
  seatIndex,
  cards: [ace, king],
});

/* ------------------------------------------------------------------ 键名契约 */

describe('锚点键名是 DOM 契约唯一的拼字符串处', () => {
  it('三类锚点各一个前缀', () => {
    expect(holeKey(3)).toBe('hole-3');
    expect(seatKey(3)).toBe('seat-3');
    expect(boardKey(2)).toBe('board-2');
  });
});

/* ------------------------------------------------------------------ 从画面读事实 */

describe('发牌顺序从画面里读', () => {
  it('现读场上有哪些底牌格：坏键名跳过，顺序升序', () => {
    stubRects();
    const scene = mount();
    // fixture 里那个 `hole-o` 模拟一个坏/半截的键名：parseInt 得到 NaN，不能变成座位号
    expect(holeSeats(scene)).toEqual([0, 1]);
  });

  it('牌堆被几何挤掉时起点是 null，不猜一个屏幕中心', () => {
    stubRects();
    const scene = mount();
    // deck 在视口 520,120，layer 在 100,50 → 相对原点 420,70，加半张牌
    expect(deckCenter(scene)).toEqual({ x: 440, y: 98 });
    scene.find('deck')?.remove();
    expect(deckCenter(scene)).toBeNull();
  });

  it('从 startSeat 起顺时针数，越界回绕', () => {
    expect(dealOrder([0, 1, 2, 3], 2, 4)).toEqual([2, 3, 0, 1]);
    expect(dealOrder([0, 2, 5], 1, 3)).toEqual([2, 5, 0]);
    expect(dealOrder([0, 1, 2], 0, 2)).toEqual([0, 1]);
    expect(dealOrder([0, 1, 2], 0, 0)).toEqual([]);
    // 服务端给的 count 比实际座位多（离桌的人本手还在打）时不炸，只数到数完
    expect(dealOrder([0, 1], 0, 8)).toEqual([0, 1]);
  });
});

/* ------------------------------------------------------------------ 补扫窗口 */

describe('遮罩补扫', () => {
  it('构造时还不存在的格子，开播前 commit 落地了也会被遮上', () => {
    stubRects();
    const scene = mount();
    const job = sceneJob(scene, () => ['late'], () => true);
    expect(masked(scene)).toEqual([]);

    const page = scene.layer.parentElement;
    if (page === null) throw new Error('fixture 没有父级');
    const late = document.createElement('div');
    late.dataset['anim'] = 'late';
    page.insertBefore(late, scene.layer);

    job.start(600, vi.fn());
    expect(masked(scene)).toEqual(['late']);
    job.dispose();
    expect(late.style.visibility).toBe('');
  });

  it('窗口关掉之后不再遮新节点：否则收尾会少还遮罩，那块区域永久隐身', () => {
    stubRects();
    const scene = mount();
    const page = scene.layer.parentElement;
    if (page === null) throw new Error('fixture 没有父级');
    const addKeyed = (key: string): void => {
      const el = document.createElement('div');
      el.dataset['anim'] = key;
      page.insertBefore(el, scene.layer);
    };

    /** 名单是活的：真机上它随 React 的 commit 长，这里用同一个形状模拟 */
    const live: string[] = [];
    const job = sceneJob(scene, () => [...live], (timeline) => {
      // 挂一条 30 秒的 tween：没有内容的时间轴会在下一帧立刻"播完"并收尾，
      // 那样就测不到窗口了（见 `kit.ts` 对空时间轴的说明）
      timeline.to({}, { duration: 30 });
      return true;
    });
    job.start(600, vi.fn());

    live.push('a');
    addKeyed('a');
    gsap.ticker.tick();
    expect(masked(scene)).toEqual(['a']);

    // 把剩下的窗口烧掉（第 MASK_RESCAN_FRAMES+1 帧触发停手）
    for (let frame = 1; frame <= MASK_RESCAN_FRAMES; frame += 1) gsap.ticker.tick();
    live.push('b');
    addKeyed('b');
    gsap.ticker.tick();
    gsap.ticker.tick();
    expect(masked(scene)).toEqual(['a']);

    job.dispose();
    expect(masked(scene)).toEqual([]);
  });

  it('dispose 幂等，且把幽灵摘干净', () => {
    stubRects();
    const scene = mount();
    const job = sceneJob(scene, () => ['pot'], (timeline, s, kit) => {
      kit.track(s.chip(100, 20));
      timeline.to({}, { duration: 30 });
      return true;
    });
    const done = vi.fn();
    job.start(600, done);
    expect(ghosts(scene)).toBe(1);
    expect(done).not.toHaveBeenCalled();

    job.dispose();
    job.dispose();
    expect(ghosts(scene)).toBe(0);
    expect(masked(scene)).toEqual([]);
    expect(done).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ 找不到落点 */

describe('找不到落点就整段不演', () => {
  it('body 返回 false → 同步放行，并且把自己上过的遮罩全部还原', () => {
    stubRects();
    const scene = mount();
    const done = vi.fn();
    const job = sceneJob(
      scene,
      () => ['pot', 'hole-0'],
      (timeline, s, kit) => {
        kit.track(s.chip(5, 18));
        timeline.to({}, { duration: 30 });
        return false;
      },
    );
    expect(masked(scene)).toEqual(['hole-0', 'pot']);
    job.start(600, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(ghosts(scene)).toBe(0);
    expect(masked(scene)).toEqual([]);
  });

  it('牌堆没了 → 发牌与公共牌都不演', () => {
    stubRects();
    const scene = mount();
    scene.find('deck')?.remove();
    // 一段一段来：两段的遮罩名单不一样，同时挂在台上会互相干扰 masked() 的读数
    const cases: readonly [AnimPlan, (subject: AnimPlan, stage: AnimScene) => AnimJob | null][] = [
      [plan('deal', { t: 'deal:start', count: 2, startSeat: 0 }), dealJob],
      [plan('board', { t: 'board:deal', phase: 'flop', cards: [ace, king, deuce] }), boardJob],
    ];
    for (const [subject, make] of cases) {
      const job = make(subject, scene);
      if (job === null) throw new Error(`${subject.event.t}：计划本身是合法的，不该在 builder 就返回 null`);
      const done = vi.fn();
      job.start(600, done);
      expect(done, subject.event.t).toHaveBeenCalledTimes(1);
      expect(masked(scene), subject.event.t).toEqual([]);
      expect(ghosts(scene), subject.event.t).toBe(0);
    }
  });

  it('底池没了 → 下注与派彩都不演（遮罩名单里的键不存在时无害）', () => {
    stubRects();
    const scene = mount();
    scene.find('pot')?.remove();
    const jobs = [
      actionJob(plan('action', { t: 'action:made', seatIndex: 0, action: { type: 'call' }, chipsDelta: 40 }), scene),
      awardJob(
        plan('award', { t: 'pot:awarded', potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] }),
        scene,
      ),
    ];
    for (const job of jobs) {
      if (job === null) throw new Error('计划本身是合法的，不该在 builder 就返回 null');
      const done = vi.fn();
      job.start(600, done);
      expect(done).toHaveBeenCalledTimes(1);
      expect(masked(scene)).toEqual([]);
    }
  });

  it('一笔钱都没有 / 一个赢家都没有 → 不演', () => {
    stubRects();
    const scene = mount();
    const cases: readonly S2C_Broadcast[] = [
      { t: 'pot:awarded', potIndex: 0, winners: [], amount: 300, handName: '两对', bestFive: [] },
      { t: 'pot:awarded', potIndex: 0, winners: [0], amount: 0, handName: '两对', bestFive: [] },
      { t: 'hand:end', results: [{ playerId: 'p-0', seatIndex: 0, chips: 1000, delta: 0 }] },
    ];
    for (const event of cases) {
      const job = event.t === 'hand:end' ? handEndJob(plan('handEnd', event), scene) : awardJob(plan('award', event), scene);
      if (job === null) throw new Error('计划本身是合法的，不该在 builder 就返回 null');
      const done = vi.fn();
      job.start(600, done);
      expect(done, JSON.stringify(event)).toHaveBeenCalledTimes(1);
    }
  });
});

/* ------------------------------------------------------------------ 每类遮什么 */

interface Case {
  readonly title: string;
  readonly plan: AnimPlan;
  readonly masked: readonly string[];
}

const CASES: readonly Case[] = [
  { title: '洗牌不遮任何东西（牌堆本来就在演）', plan: plan('shuffle', { t: 'shuffle' }), masked: [] },
  {
    title: '发牌遮场上所有底牌格',
    plan: plan('deal', { t: 'deal:start', count: 2, startSeat: 0 }),
    masked: ['hole-0', 'hole-1'],
  },
  {
    title: '翻公共牌只遮这三格',
    plan: plan('board', { t: 'board:deal', phase: 'flop', cards: [ace, king, deuce] }),
    masked: ['board-0', 'board-1', 'board-2'],
  },
  {
    title: 'turn 那一格（索引按阶段偏移）',
    plan: plan('board', { t: 'board:deal', phase: 'turn', cards: [ace] }),
    masked: ['board-3'],
  },
  {
    title: '下注遮底池：数字不能先于筹码跳',
    plan: plan('action', { t: 'action:made', seatIndex: 0, action: { type: 'raise', totalBet: 120 }, chipsDelta: 100 }),
    masked: ['pot'],
  },
  {
    title: '弃牌遮那个人的底牌格',
    plan: plan('action', { t: 'action:made', seatIndex: 0, action: { type: 'fold' }, chipsDelta: 0 }),
    masked: ['hole-0'],
  },
  {
    title: '过牌什么都不遮（只有一枚幽灵点一下头）',
    plan: plan('action', { t: 'action:made', seatIndex: 1, action: { type: 'check' }, chipsDelta: 0 }),
    masked: [],
  },
  {
    title: '派彩遮底池',
    plan: plan('award', { t: 'pot:awarded', potIndex: 0, winners: [0, 1], amount: 1234, handName: '葫芦', bestFive: [] }),
    masked: ['pot'],
  },
  {
    title: '本手盈亏只加东西，不遮东西（数字归 ChipCount 滚）',
    plan: plan('handEnd', {
      t: 'hand:end',
      results: [
        { playerId: 'p-0', seatIndex: 0, chips: 1400, delta: 400 },
        { playerId: 'p-1', seatIndex: 1, chips: 600, delta: -400 },
      ],
    }),
    masked: [],
  },
  {
    title: '摊牌亮牌遮亮牌那几格',
    plan: plan('reveal', { t: 'reveal', rows: [row(0), row(1)] }),
    masked: ['hole-0', 'hole-1'],
  },
];

describe('每一类动画遮该遮的东西、并且真的建出了东西', () => {
  for (const item of CASES) {
    it(item.title, () => {
      stubRects();
      const scene = mount();
      const job = build(item.plan, scene);
      if (job === null) throw new Error(`${item.title}：builder 交不出 job`);
      const done = vi.fn();
      job.start(item.plan.durationMs, done);

      expect(masked(scene)).toEqual([...item.masked].sort());
      expect(ghosts(scene), '一类动画一个幽灵都没造出来').toBeGreaterThan(0);
      // 建出了时间轴 → 这一段是 asynchronous 的，不该同步放行下一段
      expect(done).not.toHaveBeenCalled();

      job.dispose();
      expect(masked(scene)).toEqual([]);
      expect(ghosts(scene)).toBe(0);
    });
  }
});

/**
 * 按 `kind` 找 builder——和 `renderer.ts` 那张表同一份对应关系。
 *
 * 这里切 `kind` 而不是 `event.t`：后者那一维还带着不入队的那些事件（`turn:change` 等），
 * 切它这条函数就永远有个"走不到的分支"要写；`kind` 恰好是那七类，一一对得上。
 * 事件与 kind 对不上时的退化由下面「注册表」那一组直接测各 builder。
 */
function build(subject: AnimPlan, scene: AnimScene): AnimJob | null {
  switch (subject.kind) {
    case 'shuffle':
      return shuffleJob(subject, scene);
    case 'deal':
      return dealJob(subject, scene);
    case 'board':
      return boardJob(subject, scene);
    case 'action':
      return actionJob(subject, scene);
    case 'award':
      return awardJob(subject, scene);
    case 'handEnd':
      return handEndJob(subject, scene);
    case 'reveal':
      return revealJob(subject, scene);
  }
}

/* ------------------------------------------------------------------ 注册表 */

describe('事件与 kind 对不上时不硬演', () => {
  it('每个 builder 只认自己那一种事件', () => {
    stubRects();
    const scene = mount();
    const noise: S2C_Broadcast = { t: 'shuffle' };
    expect(dealJob(plan('deal', noise), scene)).toBeNull();
    expect(boardJob(plan('board', noise), scene)).toBeNull();
    expect(actionJob(plan('action', noise), scene)).toBeNull();
    expect(awardJob(plan('award', noise), scene)).toBeNull();
    expect(handEndJob(plan('handEnd', noise), scene)).toBeNull();
    expect(
      revealJob(plan('reveal', { t: 'deal:start', count: 2, startSeat: 0 }), scene),
    ).toBeNull();
  });

  it('场景还没挂上（大厅 / 已经退回）→ inert 任务同步放行', () => {
    const renderer = createRenderer(() => null);
    const done = vi.fn();
    const task = renderer({ kind: 'deal', durationMs: 1100, event: { t: 'deal:start', count: 2, startSeat: 0 } }, 4);
    task.play(done, 880);
    expect(done).toHaveBeenCalledTimes(1);
    expect(() => task.settle()).not.toThrow();
  });

  it('builder 交不出东西 → 同样退化成 inert，而不是塞一条空时间轴进队列', () => {
    stubRects();
    const scene = mount();
    const renderer = createRenderer(() => scene);
    const task = renderer({ kind: 'action', durationMs: 420, event: { t: 'shuffle' } }, 5);
    const done = vi.fn();
    task.play(done, 420);
    expect(done).toHaveBeenCalledTimes(1);
    expect(ghosts(scene)).toBe(0);
  });

  it('接得上时走真任务：不是同步放行', () => {
    stubRects();
    const scene = mount();
    const renderer = createRenderer(() => scene);
    const task = renderer({ kind: 'award', durationMs: 1200, event: { t: 'pot:awarded', potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] } }, 6);
    const done = vi.fn();
    task.play(done, 1200);
    expect(done).not.toHaveBeenCalled();
    expect(ghosts(scene)).toBeGreaterThan(0);
    task.settle();
    expect(ghosts(scene)).toBe(0);
    expect(masked(scene)).toEqual([]);
  });

  it('落点找不到时，真任务也会同步收尾并放还遮罩', () => {
    stubRects();
    const scene = mount();
    scene.find('seat-0')?.remove();
    const renderer = createRenderer(() => scene);
    const task = renderer(
      { kind: 'action', durationMs: 300, event: { t: 'action:made', seatIndex: 0, action: { type: 'check' }, chipsDelta: 0 } },
      7,
    );
    const done = vi.fn();
    task.play(done, 300);
    expect(done).toHaveBeenCalledTimes(1);
    expect(masked(scene)).toEqual([]);
  });
});
