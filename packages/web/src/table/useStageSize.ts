/**
 * 量桌面区域（M2.2）。
 *
 * ## 为什么量元素而不是量 `window`
 *
 * `.felt-stage` 的高度是 CSS 给的（`aspect-ratio` + `max-height`），它在不同视口下
 * 拿到的实际盒子才是几何的输入。量 `innerWidth/innerHeight` 会算出另一套坐标，
 * 表现就是座位贴到卡片边框外面去。
 *
 * ## 为什么量不到时要保留上一份
 *
 * `getBoundingClientRect()` 在容器还没参与布局时返回 `0×0`（jsdom 里则**永远**是 0）。
 * 把 0 写进 state 会让整桌坍成一个点，所以这种读数直接丢掉，初值用 `FALLBACK_STAGE`。
 *
 * ## `useLayoutEffect`
 *
 * 用它是为了在**首帧绘制之前**就把真实尺寸写进去。用 `useEffect` 会先按回退尺寸画一帧，
 * 转桌时能看到一次明显的跳位。
 */

import { useLayoutEffect, useRef, useState } from 'react';

import { FALLBACK_STAGE, type StageSize } from './layout';

export interface StageMeasure {
  readonly ref: { readonly current: HTMLDivElement | null };
  readonly size: StageSize;
}

export function useStageSize(): StageMeasure {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<StageSize>(FALLBACK_STAGE);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;

    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      if (next.width <= 0 || next.height <= 0) return;
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };

    measure();

    // jsdom 没有 ResizeObserver；退化成监听 window 的 resize，测试里至少不炸
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return { ref, size };
}
