/**
 * 结算：底池飞向赢家（SPEC §3.2 的 `pot:awarded` / `hand:end` 两行）。
 *
 * ## 为什么筹码按赢家再拆一次
 *
 * 一个 12,345 的池三家均分时，照 `splitChips(12345)` 整堆飞给每个人是**说谎**——
 * 屏幕上会连飞三遍同样一摞。所以先按赢家把整数筹码切开（余数从前几位开始，
 * 保证加起来正好是 `amount`），再各自按面额分解。切分是算术，不是规则判定：
 * 谁赢多少由服务端算完广播过来（`amount` / `winners`），这里只负责画。
 *
 * ## `hand:end` 为什么一个遮罩都不上
 *
 * 这一段的活儿是「把刚才那手的账写在座位上」——每个座位浮一个 ±数额。
 * 座位上的筹码数字本身由 `ChipCount` 滚（SPEC §3.2「赢家数字滚动」说的就是它），
 * 它是一个自足的 tween，不需要同伴配合；再把整格座位遮掉反而会把头像、底牌、
 * 庄家钮一起藏两秒。所以这一档只加东西，不遮东西。
 *
 * 至于「下一手 Ns 后开始」，那是 `nextHandAt` 驱动的倒计时（`TablePage` 已经在走），
 * 属于状态不属于表演，队列在这里只负责把按钮按住两秒。
 */

import { splitChips } from '../chips';
import { arc, type AnimJob, type Timeline } from '../job';
import type { AnimPlan } from '../plan';
import type { AnimScene, Point } from '../scene';
import { formatChips } from '../../table/format';
import { sceneJob, seatKey, type Kit } from './kit';

/** 一枚筹码在赢家那一格里叠放的层间距，与 `action.ts` 同一口径 */
const LAYER_RISE = 3;
/** 单枚飞行秒数（总长由 `fitTimeline` 归一到队列预留的 1200ms） */
const FLIGHT_SEC = 0.42;
/** 几个赢家之间错开一点，同起同落会读成「一堵墙挪过去了」 */
const WINNER_STAGGER = 0.08;
/** 筹码盒子短的时候按它给个可读的筹码尺寸 */
const CHIP_SIZE = 18;

/** 均分整数筹码：余数依次给前面的赢家，加起来一定等于 `amount` */
function shareOf(amount: number, index: number, winners: number): number {
  const base = Math.floor(amount / winners);
  const remainder = amount - base * winners;
  return base + (index < remainder ? 1 : 0);
}

/** 一个赢家的一摞：按面额分叠，沿弧线落到他那格 */
function flyToSeat(
  timeline: Timeline,
  s: AnimScene,
  kit: Kit,
  from: Point,
  seat: number,
  amount: number,
  startSec: number,
): boolean {
  const to = s.box(seatKey(seat));
  if (to === null) return false;
  const landing: Point = { x: to.left + to.width / 2, y: to.top + to.height * 0.75 };
  const groups = splitChips(amount);
  let built = false;
  groups.forEach((group, order) => {
    const offset = (order - (groups.length - 1) / 2) * CHIP_SIZE * 1.2;
    for (let layer = 0; layer < group.ghosts; layer += 1) {
      const origin: Point = { x: from.x + offset * 0.2, y: from.y - layer * LAYER_RISE };
      const chip = kit.track(s.chip(group.denom, CHIP_SIZE));
      s.center(chip, origin);
      timeline.to(
        chip,
        {
          motionPath: {
            path: arc(origin, { x: landing.x + offset, y: landing.y - layer * LAYER_RISE }, 1).path,
            autoRotate: false,
          },
          duration: FLIGHT_SEC + layer * 0.02,
          ease: 'power2.inOut',
        },
        startSec + layer * 0.03,
      );
      built = true;
    }
    if (group.needsMultiplier) {
      const tag = kit.track(s.label(`×${String(group.count)}`, 'muted'));
      s.center(tag, { x: landing.x + offset, y: landing.y + CHIP_SIZE * 0.7 });
      timeline.fromTo(tag, { opacity: 0 }, { opacity: 1, duration: 0.14 }, startSec + FLIGHT_SEC * 0.7);
    }
  });
  return built;
}

/** `pot:awarded`：牌型名从底池弹出来，同时池里的筹码飞给赢家 */
export function awardJob(plan: AnimPlan, scene: AnimScene): AnimJob | null {
  if (plan.event.t !== 'pot:awarded') return null;
  const { winners, amount, handName } = plan.event;
  return sceneJob(scene, () => ['pot'], (timeline, s, kit) => {
    const pot = s.box('pot');
    if (pot === null || winners.length === 0 || amount <= 0) return false;
    const from: Point = { x: pot.left + pot.width / 2, y: pot.top + pot.height / 2 };

    // 牌型名是这一段的信息焦点：先它出来，筹码才动
    const tag = kit.track(s.label(`${handName} · ${formatChips(amount)}`, 'award'));
    s.center(tag, { x: from.x, y: from.y - pot.height * 0.9 });
    timeline.fromTo(
      tag,
      { opacity: 0, scale: 0.6 },
      { opacity: 1, scale: 1, duration: 0.22, ease: 'back.out(2)' },
      0,
    );
    timeline.to(tag, { opacity: 0, y: -10, duration: 0.3, ease: 'power1.in' }, FLIGHT_SEC + 0.5);

    let built = false;
    winners.forEach((seat, index) => {
      if (flyToSeat(timeline, s, kit, from, seat, shareOf(amount, index, winners.length), 0.12 + index * WINNER_STAGGER)) {
        built = true;
      }
    });
    return built;
  });
}

/** `hand:end`：每个座位浮一个本手盈亏 */
export function handEndJob(plan: AnimPlan, scene: AnimScene): AnimJob | null {
  if (plan.event.t !== 'hand:end') return null;
  const { results } = plan.event;
  return sceneJob(scene, () => [], (timeline, s, kit) => {
    let built = false;
    results.forEach((result, index) => {
      if (result.delta === 0) return;
      const box = s.box(seatKey(result.seatIndex));
      if (box === null) return;
      const won = result.delta > 0;
      const label = kit.track(s.label(`${won ? '+' : ''}${formatChips(result.delta)}`, won ? 'award' : 'muted'));
      s.center(label, { x: box.left + box.width / 2, y: box.top + box.height * 0.18 });
      const start = index * 0.06;
      timeline.fromTo(
        label,
        { opacity: 0, scale: 0.8 },
        { opacity: 1, scale: 1, duration: 0.2, ease: 'back.out(1.8)' },
        start,
      );
      // 赢得那一档往上浮、输的那一档往下沉：不看数字也知道是好消息还是坏消息
      timeline.to(label, { y: won ? -18 : 14, duration: 0.9, ease: 'power1.out' }, start + 0.2);
      timeline.to(label, { opacity: 0, duration: 0.5, ease: 'power1.in' }, start + 1.2);
      built = true;
    });
    return built;
  });
}
