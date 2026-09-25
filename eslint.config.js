import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'eslint.config.js',
      'vitest.workspace.ts',
      'scripts/**',
    ],
  },

  js.configs.recommended,

  // 类型感知规则必须配 projectService，否则任何未被覆盖块匹配到的文件都会报错
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // AGENTS.md 铁律：禁止 any。确需时用 unknown + 类型收窄
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // web 包：浏览器环境 + React
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // shared 包：纯逻辑。ESLint 层再挡一道（scripts/check-arch.mjs 是主检查）
  {
    files: ['packages/shared/**/*.ts'],
    languageOptions: {
      globals: {},
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'shared 包必须零 IO、零环境依赖。' },
        { name: 'document', message: 'shared 包必须零 IO、零环境依赖。' },
        { name: 'process', message: 'shared 包必须零 IO、零环境依赖。' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: '禁止直接用 Math.random()，必须使用 engine/random.ts 里可注入的随机源。',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'colyseus', '@colyseus/*', 'express', 'node:*'], message: 'shared 包必须零 IO、零框架依赖（DECISIONS.md D-003）。' },
          ],
        },
      ],
    },
  },

  // 测试文件放宽 unsafe-* 与随机源限制
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts', '**/vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // 测试替身（stub / fake）常常写成 `async () => value`，里面没有 await 是刻意的：
      // 它的签名必须和被替换的异步接口一致。这条在 src 里仍然开着，真正有价值的
      // no-floating-promises 也仍然开着，所以放宽的只是噪音。
      '@typescript-eslint/require-await': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
