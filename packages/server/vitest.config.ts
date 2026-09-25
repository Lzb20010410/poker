import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Colyseus 集成测试要起真实服务端，放宽超时
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
