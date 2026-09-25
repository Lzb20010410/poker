import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../src/index.js';

/**
 * M0.1 冒烟测试。
 *
 * 注意：架构守卫（shared 包零 IO / 零框架依赖 / 随机源可控）不放在这里，
 * 而在仓库根的 scripts/check-arch.mjs —— 因为守卫需要读文件系统，
 * 而 shared 包本身必须零 IO，把守卫写成 shared 的测试会自相矛盾。
 * 守卫通过 `pnpm lint` 一并运行。
 */
describe('shared 包元信息', () => {
  it('导出正确的包名', () => {
    expect(PACKAGE_NAME).toBe('@poker-room/shared');
  });

  it('导出合法的 semver 版本号', () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
