/**
 * 玩家动作：下注 / 跟注 / 全下的筹码、弃牌的牌回牌堆、过牌的轻敲（SPEC §3.2 的三行）。
 *
 * ## 为什么下注那一档要遮底池
 *
 * 服务端一个 patch 里底池数字就变了，而筹码飞行的动画要 420ms 才落地。
 * 不遮的话玩家先看到底池从 1,234 跳到 1,454，再看到一串筹码慢悠悠飞过去——
 * 「数字在前、筹码在后」这个顺序一旦反过来，动画就变成了装饰而不是叙述。
 * 弃牌那一档遮的是底牌格，同一个道理。
 *
 * ## 轻敲动的是幽灵，不是座位
 *
 * SPEC 写的是「座位向下位移 4px 回弹」。真座位是 React 的节点，`layout.ts` 那套
 * 「无重叠」的验算按的是它原始的位置：动画期间挪一下，那一帧里跟它相邻的格子
 * 就重叠了（而且 `check` 每手要发生十几次）。所以这里画一个和座位框一样大的幽灵，
 * 挪它，玩家看到的是同一个位置在点头。
 *
 * ## 弃牌时「座位变暗」不在这里做
 *
 * 那一档的变暗是**状态**（快照里这个人已经 fold 了，`SeatView` 自己就把格子画暗），
 * 不是一段需要排练的表演：它没有"从 A 到 B"的过程，只有前一个 patch 和后一个 patch。
 * 遮罩把会跳变的底牌盖住交给动画，不该动的东西让 React 直接动。
 */

import { splitChips } from '../chips';
import { arc, type AnimJob, type Timeline } from '../job';
import type { AnimPlan } from '../plan';
import { FALLBACK_CARD_WIDTH, type AnimScene, type Box, type Point } from '../scene';
import { deckCenter, holeKey, sceneJob, seatKey, type Kit } from './kit';

/** 筹码叠在一起的层间距与落定时的横向抖动（SPEC §3.3「translateY(-Npx) + 轻微 translateX 抖动」） */
const LAYER_RISE = 3;
const LAYER_JITTER = 1.5;
/** 一叠筹码占的横向宽度，用于把几叠排开 */
const STACK_PITCH = 1.4;
/** 单枚筹码的飞行秒数（总时长由 `fitTimeline` 归一到队列预留的 420ms） */
const CHIP_FLIGHT_SEC = 0.28;
/** 弃牌那两张的弓高比筹码更大：它们要走更远的路回牌堆 */
const FOLD_LIFT = 0.6;

function clampChipSize(pot: Box): number {
  return Math.round(Math.min(22, Math.max(12, pot.height * 0.55)));
}

/**
 * 出点：座位盒子朝底池那一侧、往中心走 35% 的位置。
 *
 * 从座位正中心起飞的话，筹码一出来就压在头像和文字上（那一格里本来就有东西）；
 * 从边上出发才像「这个人把手里的筹码推出去」。
 */
function fromSeat(box: Box, toward: Point): Point {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return { x: cx + (toward.x - cx) * 0.35, y: cy + (toward.y - cy) * 0.35 };
}

/** 下注 / 跟注 / 全下：按面额分成几叠，一起沿弧线进底池 */
function chipsToPot(timeline: Timeline, s: AnimScene, kit: Kit, amount: number, seat: number): boolean {
  const pot = s.box('pot');
  const seatBox = s.box(seatKey(seat));
  if (pot === null || seatBox === null) return false;
  const groups = splitChips(amount);
  if (groups.length === 0) return false;

  const to: Point = { x: pot.left + pot.width / 2, y: pot.top + pot.height / 2 };
  const from = fromSeat(seatBox, to);
  const size = clampChipSize(pot);

  groups.forEach((group, order) => {
    // 面额大的那一叠放中间，往两侧排开：读「谁下了多少」时先看中间
    const offset = (order - (groups.length - 1) / 2) * size * STACK_PITCH;
    for (let layer = 0; layer < group.ghosts; layer += 1) {
      const origin: Point = { x: from.x + offset * 0.25, y: from.y - layer * LAYER_RISE };
      const landing: Point = { x: to.x + offset, y: to.y - layer * LAYER_RISE };
      const chip = kit.track(s.chip(group.denom, size));
      s.center(chip, origin);
      timeline.to(
        chip,
        {
          motionPath: { path: arc(origin, landing, 1).path, autoRotate: false },
          duration: CHIP_FLIGHT_SEC + layer * 0.02,
          ease: 'power2.out',
        },
        layer * 0.03,
      );
      // 落定那一下的错位：整整齐齐一摞是图形，歪一点才是筹码
      const nudge = layer % 2 === 0 ? LAYER_JITTER : -LAYER_JITTER;
      timeline.to(chip, { x: `+=${String(nudge)}`, duration: 0.06, ease: 'power1.out' }, CHIP_FLIGHT_SEC + layer * 0.02);
    }
    if (group.needsMultiplier) {
      const tag = kit.track(s.label(`×${String(group.count)}`, 'muted'));
      s.center(tag, { x: to.x + offset, y: to.y + size * 0.7 });
      timeline.fromTo(tag, { opacity: 0 }, { opacity: 1, duration: 0.12 }, CHIP_FLIGHT_SEC * 0.8);
    }
  });
  return true;
}

/** 弃牌：两张底牌翻回牌堆并淡掉 */
function holeToDeck(timeline: Timeline, s: AnimScene, kit: Kit, seat: number): boolean {
  const to = deckCenter(s);
  if (to === null) return false;
  const key = holeKey(seat);
  let built = false;
  for (const index of [0, 1]) {
    const start = s.cardCenter(key, index);
    if (start === null) continue;
    const ghost = kit.track(s.card(key, index, null, FALLBACK_CARD_WIDTH));
    s.center(ghost, start);
    timeline.to(
      ghost,
      { motionPath: { path: arc(start, to, FOLD_LIFT).path, autoRotate: false }, duration: 0.26, ease: 'power2.in' },
      index * 0.05,
    );
    timeline.to(ghost, { opacity: 0, duration: 0.12, ease: 'power1.in' }, 0.16 + index * 0.05);
    built = true;
  }
  return built;
}

/** 过牌：一枚与座位同框的幽灵点一下头 + 「过牌」气泡 */
function tapSeat(timeline: Timeline, s: AnimScene, kit: Kit, seat: number): boolean {
  const seatBox = s.box(seatKey(seat));
  if (seatBox === null) return false;

  const tap = kit.track(s.frame('tap'));
  tap.style.width = `${String(Math.round(seatBox.width))}px`;
  tap.style.height = `${String(Math.round(seatBox.height))}px`;
  s.place(tap, seatBox);
  timeline.fromTo(tap, { y: 0 }, { y: 4, duration: 0.1, ease: 'power2.in' }, 0);
  timeline.to(tap, { y: 0, duration: 0.18, ease: 'elastic.out(1, 0.4)' }, 0.1);

  const bubble = kit.track(s.label('过牌', 'muted'));
  s.center(bubble, { x: seatBox.left + seatBox.width / 2, y: seatBox.top - 8 });
  timeline.fromTo(
    bubble,
    { opacity: 0, scale: 0.7 },
    { opacity: 1, scale: 1, duration: 0.14, ease: 'back.out(2)' },
    0.04,
  );
  timeline.to(bubble, { opacity: 0, y: -8, duration: 0.16, ease: 'power1.in' }, 0.2);
  return true;
}

export function actionJob(plan: AnimPlan, scene: AnimScene): AnimJob | null {
  if (plan.event.t !== 'action:made') return null;
  const { seatIndex, chipsDelta } = plan.event;
  const type = plan.event.action.type;
  return sceneJob(
    scene,
    () => (type === 'fold' ? [holeKey(seatIndex)] : type === 'check' ? [] : ['pot']),
    (timeline, s, kit) => {
      if (type === 'fold') return holeToDeck(timeline, s, kit, seatIndex);
      if (type === 'check') return tapSeat(timeline, s, kit, seatIndex);
      return chipsToPot(timeline, s, kit, chipsDelta, seatIndex);
    },
  );
}
