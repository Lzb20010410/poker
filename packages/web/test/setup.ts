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
