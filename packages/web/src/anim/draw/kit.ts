/**
 * 各段动画共用的外壳：遮罩、幽灵登记、时间轴搭与拆。
 *
 * ## 为什么遮罩要「补扫」，不能只上一次
 *
 * 队列的节拍器和 React 的渲染不在同一帧上：广播事件到达时我们**同步**入队并开播，
 * 而这一变化对应的画面（新落的两张底牌、新翻出来的公共牌）要等 Colyseus 的 state patch
 * 走完 setState → commit 才出现在 DOM 里，通常是下一帧。
 *
 * 于是「开播那一刻上遮罩」会漏：遮的是一个还不存在的节点，等它真出现时没人管它了，
 * 玩家看到牌已经落在座位里、而飞行动画才刚开始——这正是 M3 要消掉的那种割裂。
 * 已经存在的节点（底池那一行、座位框）没有这个问题，构造时就遮得住。
 *
 * 所以这里在开头 `MASK_RESCAN_FRAMES` 帧里补扫：每次补扫都走 `scene.mask` 的引用计数，
 * 重复无害，收尾时按拿到的解除函数逐条归还。超过这个窗口还没出现的元素就是**真的不会出现**
 * （比如那一格的人已经离桌），那时候让终态直接可见才是对的。
 *
 * ## `body` 返回 false 就是「这一帧没东西可播」
 *
 * 找不到落点（座位空了、牌堆被几何挤掉了）时不要造一条空时间轴：空时间轴的
 * `onComplete` 要等 ticker 下一帧才触发，而标签页被节流、ticker 睡着时它压根不来，
 * 队列只能靠 5 秒看门狗才放行按钮，玩家会觉得牌桌卡住了。
 * 这里直接把 `false` 透出去，由 `sceneJob` 同步收尾并放行。
 */

import { gsap } from '../gsap';
import { fitTimeline, type AnimJob } from '../job';
import { DECK_BEARING, DECK_RADIUS, feltPointAt } from '../../table/layout';
import { boxCenter, type AnimScene, type Box, type MaskRelease, type Point } from '../scene';

/** 补扫窗口。10 帧 ≈166ms，足够覆盖一次 commit，又短到不会有「遮了半天结果不播」的观感 */
export const MASK_RESCAN_FRAMES = 10;

export interface Kit {
  /** 造好的幽灵挂进层里并登记，收尾时统一摘掉 */
  readonly track: (node: HTMLElement) => HTMLElement;
  /** 量一个锚点（开播时量，不缓存） */
  readonly box: (key: string) => Box | null;
  readonly cardCenter: (key: string, index: number) => Point | null;
  readonly isSelf: (key: string) => boolean;
  /** 临时要遮的东西（body 里才发现的落点），同样计入补扫名单 */
  readonly mask: (key: string) => void;
}

/** 搭一条时间轴。返回 `false` = 这一帧没有可播的东西，直接放行下一段 */
export type JobBody = (timeline: gsap.core.Timeline, scene: AnimScene, kit: Kit) => boolean;

/**
 * 遮罩名单是个**函数**不是数组：要看遮哪些格子，每次都得从 DOM 现读。
 * 构造那一刻画面还是上一帧的（底牌格压根没长出来），等到补扫时名单必须已经
 * 能把刚长出来的格子算进去——静态数组做不到这件事，而这是这套遮罩能不能生效的分界线。
 */
export function sceneJob(scene: AnimScene, maskKeys: () => readonly string[], body: JobBody): AnimJob {
  const releases: MaskRelease[] = [];
  const ghosts: HTMLElement[] = [];
  /** body 中途点名要遮的键（例如刚决定落座的那一格） */
  const extra = new Set<string>();
  let timeline: gsap.core.Timeline | null = null;
  let rescan: (() => void) | null = null;
  let closed = false;

  const hold = (key: string): void => {
    releases.push(scene.mask(key));
  };

  const scan = (): void => {
    for (const key of maskKeys()) hold(key);
    for (const key of [...extra]) hold(key);
  };
  scan();

  const stopRescan = (): void => {
    if (rescan === null) return;
    gsap.ticker.remove(rescan);
    rescan = null;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    stopRescan();
    if (timeline !== null) {
      timeline.kill();
      timeline = null;
    }
    for (const ghost of ghosts.splice(0, ghosts.length)) ghost.remove();
    for (const release of releases.splice(0, releases.length)) release();
    extra.clear();
  };

  const kit: Kit = {
    track: (node) => {
      scene.add(node);
      ghosts.push(node);
      return node;
    },
    box: (key) => scene.box(key),
    cardCenter: (key, index) => scene.cardCenter(key, index),
    isSelf: (key) => scene.isSelf(key),
    mask: (key) => {
      extra.add(key);
      hold(key);
    },
  };

  return {
    start: (durationMs, onEnd) => {
      if (closed) return;
      // 开播这一刻补扫一遍：排队的几百毫秒里 React 早就把终态画完了
      scan();
      let frames = 0;
      rescan = () => {
        frames += 1;
        if (frames > MASK_RESCAN_FRAMES) {
          stopRescan();
          return;
        }
        scan();
      };
      gsap.ticker.add(rescan);

      const built = gsap.timeline();
      timeline = built;
      let ok = false;
      try {
        ok = body(built, scene, kit);
      } catch {
        ok = false;
      }
      if (!ok) {
        close();
        onEnd();
        return;
      }
      fitTimeline(built, durationMs);
      built.eventCallback('onComplete', () => {
        close();
        onEnd();
      });
    },
    dispose: close,
  };
}

/* ---------- 锚点键名：DOM 契约只有这一处拼字符串 ---------- */

/** 座位号 → 底牌格。我自己那条 `.hole-strip` 用的也是这个键（`TablePage` 里挂的） */
export function holeKey(seatIndex: number): string {
  return `hole-${seatIndex}`;
}

export function seatKey(seatIndex: number): string {
  return `seat-${seatIndex}`;
}

export function boardKey(index: number): string {
  return `board-${index}`;
}

/**
 * 牌堆中心，飞行类动画的公共起点。
 *
 * 窄屏满桌时几何会把牌堆挤掉（`layout.deck === null`，SPEC §4.2「宁可少一个装饰」）——
 * 那一刻**牌堆那一格不画，但起飞点还得有**。所以退一步从桌面椭圆算「牌堆本来该在哪」：
 * `feltPointAt(felt, DECK_RADIUS, DECK_BEARING)` 正是 `layout.ts` 搜索的第一档，
 * 两条路算同一个点，有没有那摞牌背都不会让牌的轨迹跳一截。
 *
 * 桌面也量不到时才返回 `null`（那一刻真的没有任何位置可依据）。调用方拿到 `null`
 * 就该让整段不播（`body` 返回 false），而不是把起点猜成屏幕中心——
 * 从屏幕中央飞出来的牌比没有动画更怪。
 * 为什么不画一个占位牌堆、为什么用第一档：记在 DECISIONS.md D-037（D-029 那条的返工）。
 */
export function deckCenter(scene: AnimScene): Point | null {
  const deck = scene.box('deck');
  if (deck !== null) return boxCenter(deck);
  const felt = scene.box('felt');
  if (felt === null) return null;
  /*
   * 两个 `Box` 不是一回事：动画层量到的是 `{left, top, width, height}`（相对幽灵层原点），
   * `layout.ts` 那套是 `{x, y, w, h}`。这里只做一次换名，不做换算——层原点已经减掉了，
   * 两个坐标系本来就是同一个。
   */
  const anchor = feltPointAt(
    { x: felt.left, y: felt.top, w: felt.width, h: felt.height },
    DECK_RADIUS,
    DECK_BEARING,
  );
  // 与 layout 同一口径：坐标最终是 CSS 的 px，两位小数
  return { x: Math.round(anchor.x * 100) / 100, y: Math.round(anchor.y * 100) / 100 };
}

/**
 * 场上现在有哪些底牌格。
 *
 * `deal:start` 只给「发几个人、从谁开始」，座位号得从画面上现读：
 * 「谁的底牌格已经渲染出来了」正是这件事的唯一事实来源——快照里离桌的人
 * 本手还在打（D-014），但他那一格已经没了，往那儿飞一张牌就是凭空多出一张。
 */
export function holeSeats(scene: AnimScene): readonly number[] {
  const scope = scene.layer.parentElement ?? scene.layer;
  const seats: number[] = [];
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[data-anim]'))) {
    const value = el.dataset['anim'] ?? '';
    if (!value.startsWith('hole-')) continue;
    const seat = Number.parseInt(value.slice('hole-'.length), 10);
    if (Number.isInteger(seat)) seats.push(seat);
  }
  return seats.sort((left, right) => left - right);
}

/** 从 `startSeat` 起顺时针数 `count` 个座位（座位号升序、越界回绕） */
export function dealOrder(seats: readonly number[], startSeat: number, count: number): readonly number[] {
  const fromStart = seats.filter((seat) => seat >= startSeat);
  const wrapped = seats.filter((seat) => seat < startSeat);
  return [...fromStart, ...wrapped].slice(0, Math.max(0, count));
}
