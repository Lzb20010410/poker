/**
 * 摊牌亮牌（SPEC §3.2 的 `showdown:reveal`，500ms）。
 *
 * ## 为什么它不走广播流
 *
 * 亮牌按 D-002 / D-013 是**定向消息**，攒在快照的 `reveals` 里，广播流中根本没有这条事件
 * （广播里如果有别人的底牌，就等于把牌同步给了所有客户端）。所以这一段演的是
 * `plan.ts` 里那个合成主题 `{ t: 'reveal', rows }`，由 `useAnimDirector` 在
 * `reveals` 长出新行时入队。
 *
 * ## 一次摊牌是一段，不是 N 段
 *
 * 三个人同时亮牌时 `rows` 有三行，它们共用一段 500ms：逐行排队会把摊牌拉成一分钟，
 * 而这段时间按钮是灰的、玩家什么也做不了。这里靠 `seatOrder * 2 + index` 的错峰
 * 让八张牌在同一秒里依次翻开，既有节奏又不拖。
 *
 * ## 牌面从 `rows` 里拿
 *
 * 别人的底牌在画面上一直是牌背，翻面之前 DOM 里没有任何地方写着它是哪张牌——
 * 只有这条定向消息知道。所以这里不像发牌那样读 DOM（那里读的是**我自己**已经亮着的两张），
 * 直接用 `row.cards`。
 */

import { type AnimJob } from '../job';
import type { AnimPlan } from '../plan';
import { FALLBACK_CARD_WIDTH, flipInner, type AnimScene } from '../scene';
import { holeKey, sceneJob } from './kit';

/** 单张翻面秒数（总长由 `fitTimeline` 归一到队列预留的 500ms） */
const FLIP_SEC = 0.3;
/** 逐张错峰 */
const STAGGER = 0.06;

export function revealJob(plan: AnimPlan, scene: AnimScene): AnimJob | null {
  if (plan.event.t !== 'reveal') return null;
  const { rows } = plan.event;
  return sceneJob(
    scene,
    () => rows.map((row) => holeKey(row.seatIndex)),
    (timeline, s, kit) => {
      let built = false;
      rows.forEach((row, seatOrder) => {
        const key = holeKey(row.seatIndex);
        row.cards.forEach((card, index) => {
          const at = s.cardCenter(key, index);
          if (at === null) return;
          const ghost = kit.track(s.flip(key, index, FALLBACK_CARD_WIDTH, card));
          s.center(ghost, at);
          timeline.to(
            flipInner(ghost),
            { rotationY: 180, duration: FLIP_SEC, ease: 'power2.inOut' },
            (seatOrder * row.cards.length + index) * STAGGER,
          );
          built = true;
        });
      });
      return built;
    },
  );
}
