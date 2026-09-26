/**
 * 幽灵层：一块 React 不往里放任何东西的画布（SPEC §3）。
 *
 * ## 为什么要单独一个组件
 *
 * 动画节点是命令式 `appendChild` 进来的，React 一旦 reconcile 这个容器就会把它们
 * 连同 GSAP 正在 tween 的引用一起摘掉（现象是"牌飞到一半凭空消失"）。
 * 所以这个 `<div>` 永远是空的：`children` 一个都不写，React 每次 diff 都觉得它没变。
 *
 * ## 为什么挂在 `.table-page` 而不是 `.felt-stage`
 *
 * 我自己的两条底牌在 `.hole-strip` 里，它在桌面之外（SPEC §4.2 要它在竖屏放大到屏宽 22%，
 * 座位框给不起那么大）。挂在桌面里就会有一部分飞行目标落在坐标系外，
 * 发牌动画飞到桌面边缘停下。挂在外层意味着 `scene.ts` 要找锚点得从 `.table-page` 往下找——
 * 这就是 `createAnimScene` 里那句 `layer.parentElement` 的由来。
 *
 * ## `pointer-events: none` 是硬要求
 *
 * 这一层 `inset: 0` 铺满整页，不关掉指针事件就等于在座位上盖了一张全屏的膜，
 * 手机上"入座"按钮一个都点不动。它只做显示，不做交互。
 */

import { useEffect, useRef, type ReactNode } from 'react';

import { createAnimScene, type AnimScene } from '../../anim/scene';

export interface AnimLayerProps {
  /**
   * 场景挂上时给实例，摘掉时给 `null`。
   *
   * 用回调而不是 ref 往上冒，是因为调用方要的是「现在能不能画」这个**状态**，
   * 而 ref 变了不会让任何人重渲染；渲染器每次造任务时现读一次这个值就够了。
   */
  readonly onScene: (scene: AnimScene | null) => void;
}

export function AnimLayer({ onScene }: AnimLayerProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const scene = createAnimScene(host);
    onScene(scene);
    return () => {
      onScene(null);
      // 卸载时必须放开遮罩：真元素的 `visibility` 是我们改的，不还原就永久隐身
      scene.destroy();
    };
  }, [onScene]);

  return <div className="anim-layer" ref={hostRef} aria-hidden="true" />;
}
