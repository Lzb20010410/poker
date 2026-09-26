/**
 * `plan.kind` → 播法（SPEC §3.1 渲染层，M3.3~M3.5）。
 *
 * ## 为什么这里只有一张表
 *
 * 队列认识的是「任务」，事件流认识的是「计划」，`draw/` 里那六个文件认识的是「怎么画」。
 * 这张表是它们唯一的接缝：新增一类动画就是在 `AnimKind` 加一个键、这里挂一个函数，
 * 编译器会逼着把每一类都补齐（`Record<AnimKind, Builder>` 少一个键就是类型错误），
 * 于是「忘接一类」不会变成一个上线后才看见的黑洞。
 *
 * ## 三种"这一段不播"
 *
 * - **场景还没挂上**：`getScene()` 给 `null`（React 还没 mount 幽灵层，或已经退回大厅）。
 *   这一刻连量都量不到，任何落点都是猜的。
 * - **这一类没有播法**：表里查不到（正常不会发生，是防御 `kind` 与事件不匹配）。
 * - **建不出东西来**：builder 返回 `null`（事件载荷和 `kind` 对不上）。
 *
 * 三者都退化成 `inertTask`：不遮罩、不占时长、立刻放行下一段。
 * 这里不改成「造一条空 timeline 交出去」：空 timeline 的 `onComplete` 要等 ticker 下一帧
 * 才触发，标签页被节流时那一帧压根不来，队列只能靠 5 秒看门狗才放行按钮（见 `queue.ts`
 * 的 `ANIM_WATCHDOG_MS`）。既然什么东西都不画，晚一帧和晚五秒都不如**当时就结束**。
 *
 * ## 为什么 `getScene` 是函数
 *
 * 幽灵层跟着 `TablePage` 生灭，而导演对象活得更久（它在 `useMemo` 里，跨过多次数值变化）。
 * 每次造任务时现取，才不会出现「拿着一份已被 React 摘掉的 layer 继续画」。
 */

import type { AnimRenderer } from './director';
import { createAnimTask, inertTask, type AnimJob } from './job';
import type { AnimKind, AnimPlan } from './plan';
import type { AnimScene } from './scene';
import { actionJob } from './draw/action';
import { awardJob, handEndJob } from './draw/award';
import { boardJob } from './draw/board';
import { dealJob, shuffleJob } from './draw/deal';
import { revealJob } from './draw/reveal';

/** 一类动画的造法。返回 `null` = 这一条计划画不出东西来 */
type Builder = (plan: AnimPlan, scene: AnimScene) => AnimJob | null;

const BUILDERS: Record<AnimKind, Builder> = {
  shuffle: shuffleJob,
  deal: dealJob,
  board: boardJob,
  action: actionJob,
  award: awardJob,
  handEnd: handEndJob,
  reveal: revealJob,
};

export function createRenderer(getScene: () => AnimScene | null): AnimRenderer {
  return (plan, id) => {
    const scene = getScene();
    if (scene === null) return inertTask(id, plan.durationMs);
    const job = BUILDERS[plan.kind](plan, scene);
    if (job === null) return inertTask(id, plan.durationMs);
    return createAnimTask(id, plan.durationMs, job);
  };
}
