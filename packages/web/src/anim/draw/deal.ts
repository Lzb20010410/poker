/**
 * 洗牌与发牌（SPEC §3.2 的前两行）。
 *
 * ## 发牌顺序为什么从画面里读
 *
 * `deal:start` 只说「发几个人、从几号位开始」。座位号得回到 DOM 里现读（`holeSeats`）：
 * 快照里离桌的人本手还在打（D-014），可他的底牌格已经没了，照 `count` 硬排就会往一个
 * 不存在的格子里塞一张牌。读 DOM 不是偷懒，是因为「哪一格现在能放牌」这件事只有画面知道。
 *
 * ## 两张两张轮着发，不是一个人发两张
 *
 * 真人发牌是轮两圈，节奏感也来自这里（`round * seats.length + position` 那个式子）。
 * 反过来按人发会让第 1 家的第二张比第 8 家的第一张早到两秒，看着像牌堆偏心。
 *
 * ## 只有我自己的两张会翻面
 *
 * SPEC §3.2 那句「自己的两张落地后 `rotateY` 3D 翻面」在这里靠 `scene.isSelf` +
 * `scene.faceOf` 判定：那一格标了 `data-self`、而且此刻亮着一张正面，才值得翻。
 * 别人的底牌在画面上本来就是牌背，翻它等于翻一张什么都没有的牌。
 */

import { arc, type AnimJob } from '../job';
import { dealTimeline, type AnimPlan } from '../plan';
import { FALLBACK_CARD_WIDTH, flipInner, type AnimScene } from '../scene';
import { dealOrder, deckCenter, holeKey, holeSeats, sceneJob } from './kit';

/** 发牌弧线的弓高方向：向上拱（负 y） */
const DEAL_LIFT = 1;

/** 洗牌：两叠牌左右错开抖两下、交错换边，再合回牌堆 */
export function shuffleJob(plan: AnimPlan, scene: AnimScene): AnimJob {
  void plan;
  return sceneJob(scene, () => [], (timeline, s, kit) => {
    const at = deckCenter(s);
    if (at === null) return false;
    const measured = s.cardBox('deck', 0);
    const width = measured === null || measured.width === 0 ? FALLBACK_CARD_WIDTH : measured.width;
    const near = kit.track(s.card('deck', 0, null, FALLBACK_CARD_WIDTH));
    const far = kit.track(s.card('deck', 0, null, FALLBACK_CARD_WIDTH));
    s.center(near, at);
    s.center(far, { x: at.x, y: at.y - 3 });

    const half = Math.max(10, width * 0.4);
    timeline
      .to(near, { x: -half, rotation: -7, duration: 0.2, ease: 'power2.out' }, 0)
      .to(far, { x: half, y: -7, rotation: 7, duration: 0.2, ease: 'power2.out' }, 0)
      // 交错回来时左右互换，这是「洗牌洗过了」这个读感的全部来源
      .to(near, { x: half * 0.6, rotation: 4, duration: 0.18, ease: 'power2.inOut' }, 0.26)
      .to(far, { x: -half * 0.6, y: -3, rotation: -4, duration: 0.18, ease: 'power2.inOut' }, 0.26)
      .to([near, far], { x: 0, y: 0, rotation: 0, duration: 0.24, ease: 'power2.out' }, 0.5);
    return true;
  });
}

export function dealJob(plan: AnimPlan, scene: AnimScene): AnimJob | null {
  if (plan.event.t !== 'deal:start') return null;
  const { count, startSeat } = plan.event;
  return sceneJob(
    scene,
    () => holeSeats(scene).map(holeKey),
    (timeline, s, kit) => {
      const from = deckCenter(s);
      if (from === null) return false;
      const seats = dealOrder(holeSeats(s), startSeat, count);
      if (seats.length === 0) return false;
      const { flightMs, intervalMs } = dealTimeline(seats.length);
      let built = false;

      seats.forEach((seat, position) => {
        const key = holeKey(seat);
        for (let round = 0; round < 2; round += 1) {
          const to = s.cardCenter(key, round);
          if (to === null) continue;
          const step = round * seats.length + position;
          const start = (step * intervalMs) / 1000;
          const reveals = round === 1 && s.isSelf(key) && s.faceOf(key, round) !== null;
          const ghost = kit.track(
            reveals
              ? s.flip(key, round, FALLBACK_CARD_WIDTH, null)
              : s.card(key, round, null, FALLBACK_CARD_WIDTH),
          );
          s.center(ghost, from);
          timeline.to(
            ghost,
            {
              motionPath: { path: arc(from, to, DEAL_LIFT).path, autoRotate: false },
              duration: flightMs / 1000,
              ease: 'power1.inOut',
            },
            start,
          );
          if (reveals) {
            timeline.to(
              flipInner(ghost),
              { rotationY: 180, duration: 0.24, ease: 'power2.inOut' },
              start + flightMs / 1000 + 0.04,
            );
          }
          built = true;
        }
      });
      return built;
    },
  );
}
