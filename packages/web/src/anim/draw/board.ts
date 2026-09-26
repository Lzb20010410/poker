/**
 * 公共牌：烧牌 + 飞入 + 逐张翻开（SPEC §3.2 的 `board:deal` 两行）。
 *
 * ## 牌面从事件里拿，不从 DOM 里读
 *
 * `board:deal` 直接带着这几次翻出来的 `Card`，而公共牌区的那五个格子是常驻的
 * （没发到的那一格画成 `card-view--empty` 占位）。所以这里用事件里的牌面，
 * 比等到 React 画完再回头读要稳：开播那一刻的 commit 可能还没落地，
 * 读 DOM 会得到「空位」，翻出一张背面朝上的公共牌。
 *
 * ## 落点索引按阶段算
 *
 * flop 占 0..2、turn 占 3、river 占 4。这一段自己算索引是允许的：
 * 它不是规则（谁赢、该不该发牌），只是「这几次飞到的格子是哪几个」的几何事实。
 * 引擎那边同样是这么数的。
 */

import { arc, type AnimJob } from '../job';
import type { AnimPlan } from '../plan';
import { FALLBACK_CARD_WIDTH, flipInner, type AnimScene } from '../scene';
import { boardKey, deckCenter, sceneJob } from './kit';

/**  flop 三张、turn / river 各一张，格子按这个偏移排 */
const BOARD_FIRST_SLOT: Record<'flop' | 'turn' | 'river', number> = {
  flop: 0,
  turn: 3,
  river: 4,
};

/** 逐张间隔（SPEC §3.2 的 180ms）与单张飞行、翻面的基准秒数。总长由 `fitTimeline` 归一 */
const GAP_SEC = 0.18;
const FLIGHT_SEC = 0.34;
const FLIP_SEC = 0.26;
const BURN_SEC = 0.2;

/** 牌从牌堆到公共牌区的弓高比发牌小：距离近，拱太高会飞出桌布 */
const BOARD_LIFT = 1;

export function boardJob(plan: AnimPlan, scene: AnimScene): AnimJob | null {
  if (plan.event.t !== 'board:deal') return null;
  const { phase, cards } = plan.event;
  const first = BOARD_FIRST_SLOT[phase];
  return sceneJob(
    scene,
    () => cards.map((_card, offset) => boardKey(first + offset)),
    (timeline, s, kit) => {
      const from = deckCenter(s);
      if (from === null) return false;

      // 烧牌：一张背面从牌堆 toss 出去淡掉。它是「牌堆动过」的信号，不是给玩家看的牌
      const burn = kit.track(s.card('deck', 0, null, FALLBACK_CARD_WIDTH));
      s.center(burn, from);
      timeline.to(
        burn,
        {
          motionPath: { path: arc(from, { x: from.x - 40, y: from.y + 26 }, 1).path, autoRotate: false },
          duration: BURN_SEC,
          ease: 'power1.out',
        },
        0,
      );
      timeline.to(burn, { opacity: 0, scale: 0.9, duration: BURN_SEC * 0.6, ease: 'power1.in' }, BURN_SEC * 0.4);

      cards.forEach((card, offset) => {
        const key = boardKey(first + offset);
        const to = s.cardCenter(key, 0);
        if (to === null) return;
        const start = BURN_SEC * 0.5 + offset * GAP_SEC;
        const ghost = kit.track(s.flip(key, 0, FALLBACK_CARD_WIDTH, card));
        s.center(ghost, from);
        timeline.to(
          ghost,
          {
            motionPath: { path: arc(from, to, BOARD_LIFT).path, autoRotate: false },
            duration: FLIGHT_SEC,
            ease: 'power1.inOut',
          },
          start,
        );
        timeline.to(
          flipInner(ghost),
          { rotationY: 180, duration: FLIP_SEC, ease: 'power2.inOut' },
          start + FLIGHT_SEC - 0.04,
        );
      });
      return true;
    },
  );
}
