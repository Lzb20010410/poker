/**
 * 当前视口是不是竖屏档（M2.4）。
 *
 * ## 为什么 UI 要知道自己在哪个视口
 *
 * 操作面板在竖屏时把额度那一排收进抽屉（SPEC §4.4）。收起必须真的收——
 * 压在下面的东西不该还能被 Tab 聚焦、被读屏念到，所以靠的是 `hidden` 属性，
 * 而 `hidden` 是 React 画的，CSS 媒体查询够不着它。于是断点这件事有两处：
 * CSS 决定长什么样，这里决定渲染成什么。
 *
 * 两处用同一个数：`PORTRAIT_MAX_VIEWPORT_WIDTH` 来自 `layout.ts`，
 * 牌桌几何也是按它摆座位的。改的时候两边一起改，否则会出现
 * 「座位按竖屏排了，抽屉却当自己是桌面」那种对不上号的界面。
 *
 * ## 为什么用 matchMedia 而不是量 innerWidth
 *
 * `innerWidth` 只能在 resize 事件里轮询，还得自己去抖；`matchMedia` 是浏览器
 * 自己判的，横竖屏翻转、桌面拖窗口都在同一个回调里给答案，且与 CSS 那条
 * 媒体查询用的是同一套解析规则。
 */

import { useEffect, useState } from 'react';

import { PORTRAIT_MAX_VIEWPORT_WIDTH } from './layout';

/** 与 `global.css` 里 `@media (max-width: 767px)` 严格同档：768 本身算横屏 */
const PORTRAIT_QUERY = `(max-width: ${PORTRAIT_MAX_VIEWPORT_WIDTH - 1}px)`;

export function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(() => window.matchMedia(PORTRAIT_QUERY).matches);

  useEffect(() => {
    const list = window.matchMedia(PORTRAIT_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setPortrait(event.matches);
    list.addEventListener('change', onChange);
    return () => {
      list.removeEventListener('change', onChange);
    };
  }, []);

  return portrait;
}
