import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * 手动挂载 cleanup。
 *
 * `vitest.config.ts` 里 `globals: false`，而 @testing-library/react 的自动清理
 * 是靠「全局有没有 afterEach」来判断的——没有全局它就静默不注册。
 * 结果是每个测试的 DOM 都留在 `document.body` 里，
 * 下一个测试的 `getByText` 会一次找到七八个同样的元素。
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom 不提供 `matchMedia`，而浏览器里它一定存在。
 *
 * 需要它的是 `ChipCount`：那里用它判断「系统要求减弱动效」时要不要跳过数字滚动。
 * 桩给的是 `matches: false`，也就是**不**减弱——这样测试跑的是真的动画分支，
 * 而不是一个永远不会在产品里走到的降级分支。
 */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
