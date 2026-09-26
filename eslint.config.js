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

  // 包内的 Node 脚本（目前只有 packages/web/scripts/play-peer.mjs 这个本地联调牌手）：
  // 它不进浏览器、不进构建产物，所以给的是 Node 全局而不是 browser。
  // 不直接 ignore 掉：ignore 会让这个文件里的未定义变量、未用变量从此没人管。
  {
    files: ['packages/*/scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
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

  // web 源码的两道边界（只管 src：scripts/ 下的联调牌手不进产物）
  //   1. DECISIONS.md D-019 —— 前端只准从 `@poker-room/shared/view` 取东西。
  //      主入口带着规则引擎，而 pokersolver 是 CommonJS，tree-shaking 切不动，
  //      一次误用就把整个引擎打进首屏。
  //   2. DECISIONS.md D-020 —— 头像库必须留在动态 import 里。
  //      用 no-restricted-syntax 而不是 no-restricted-imports：后者也管 `import()`，
  //      会把 `avatar.ts` 里那个**刻意写成动态**的加载一起杀掉。
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 只能整条用 regex：`group` 是前缀匹配，写 '@poker-room/shared' 会连
              // '/view' 一起挡掉，而 pattern 里没有 allow 可以放行。
              // 这条正则的语义：主入口本身、以及除 /view 之外的任何子路径都算违规。
              regex: '^@poker-room/shared(/(?!view$).*)?$',
              message: '前端只依赖 @poker-room/shared/view，主入口会把规则引擎带进首屏（D-019）。',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: ":matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value=/^@dicebear/]",
          message: '头像库约占首屏 gzip 45%，只能通过 await import() 按需加载，唯一入口是 src/avatar.ts（D-020）。',
        },
      ],
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
