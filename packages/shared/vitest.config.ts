import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared',
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/*.d.ts'],
      // RULES-SPEC 要求：规则引擎 100% 语句覆盖
      thresholds: {
        statements: 100,
        branches: 95,
        functions: 100,
        lines: 100,
      },
    },
  },
});
