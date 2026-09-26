/**
 * 动画层读取的两个浏览器偏好（SPEC §3.3）。
 *
 * 单独一个文件是因为它们**只能在这里读**：`director.ts` 要保持不碰浏览器才能被
 * vitest 直接测，`plan.ts` 要保持纯函数才能被时长表钉住。
 * `readAnimEnv()` 也住在这里，因为线上和回放器必须读到**同一份**档。
 *
 * 两个都用 `matchMedia` 而不是量 `innerWidth`：理由和 `table/useIsPortrait.ts` 一样
 *（浏览器自己判、翻转与拖窗同一回调、与 CSS 媒体查询同一套解析规则），
 * 而且这里不需要在偏好变化时重渲染——时长是在**事件到达那一刻**取的，
 * 下一段动画自然用新的档。
 */

import type { AnimEnv } from './plan';

/**
 * 窄屏档：<640px（SPEC §3.3「手机：动画时长在窄屏（<640px）统一 ×0.8」）。
 *
 * 这和操作面板的竖屏档 `<768px`（`table/layout.ts` 的 `PORTRAIT_MAX_VIEWPORT_WIDTH`）
 * **不是同一档**，别合并：一个是「内容排版要换一套」，一个是「等待感要缩短」。
 * 639 而不是 640 是因为 `max-width` 含等号，而规格写的是「<640px」。
 */
export const ANIM_NARROW_MAX_VIEWPORT_PX = 639;

/** 当前是否窄屏档 */
export function isNarrowViewport(): boolean {
  return window.matchMedia(`(max-width: ${ANIM_NARROW_MAX_VIEWPORT_PX}px)`).matches;
}

/**
 * 系统要求减弱动态效果。
 *
 * 这是一条无障碍偏好，不是性能开关：前庭功能障碍的玩家会被飞行 / 缩放类移动干扰。
 * 命中时动画层**一段都不播**，画面跟着服务端 patch 直接落终态——信息一点不少，
 * 只是不再移动（和 `ChipCount` 跳过数字滚动同一个原则）。
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 导演每一次入队前要读的环境档 */
export interface AnimDirectorEnv extends AnimEnv {
  /**
   * `false` = 系统要求减弱动态效果：一段都不排。
   * 不排队的同时也不会遮罩，所以操作按钮不会因为动画而灰。
   */
  readonly animate: boolean;
}

/**
 * 在事件到达的那一刻现取，不缓存：横竖屏与系统偏好都可能在两段动画之间变。
 *
 * 线上（`useAnimDirector`）与回放器（`/dev/replay`）共用这一条读数，否则回放器验的
 * 是「窄屏 ×0.8 之后的时长」，线上却是另一套——那正是回放器失去意义的时刻。
 */
export function readAnimEnv(): AnimDirectorEnv {
  return { narrow: isNarrowViewport(), animate: !prefersReducedMotion() };
}
