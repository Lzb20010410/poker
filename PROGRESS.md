# PROGRESS.md — 进度账本

> **AI 每完成一个任务必须在此追加一条记录。** 这是跨会话不丢进度的唯一保险。
> 最新的记录写在最上面（倒序）。
> 不要删除历史记录，只追加。

---

## 当前状态速览

| 项 | 值 |
|---|---|
| 当前里程碑 | M0 · 骨架 |
| 下一个任务 | `M0.2 · 领域类型与洗牌` |
| 已完成任务数 | 1 / 24 |
| 测试状态 | 全绿（5 passed / 3 包） |
| 构建状态 | 全绿（`pnpm verify` 退出码 0） |
| 最后更新 | 2026-09-25 |

---

## 遗留问题（未修）

> 已知但没修的问题都记在这里。修复后移到下方「已解决」。
> 格式：`[严重程度 高/中/低] 问题描述 —— 发现于哪个任务 —— 是否阻塞下一里程碑`

- **[低] server 生产构建（`node dist/index.js`）当前不可用** —— M0.1 —— 不阻塞 M0-M3，**M4.3 必须解决**。
  原因见 `DECISIONS.md` D-006：shared 包用源码导出模式，dev 走 tsx 没问题，但 server 用 `tsc` 产出的 JS 会在运行时解析到 `.ts` 文件。M4.3 加 tsup 打包即可，不需要返工前面的代码。
- **[低] `uuid@8.3.2` 是 deprecated 的间接依赖** —— M0.1 —— 不阻塞。来自 Colyseus 依赖链，非本项目直接引入，无法自行升级。记录备查。
- **[低] npm 将 `eslint@9.39.5` 标记为 deprecated（10.11.0 可用）** —— M0.1 —— 不阻塞。
  暂未升 10：需先确认 `typescript-eslint@8.70.1` 是否声明支持 eslint 10 的 peer。留到 M4 打磨期统一处理依赖升级。

---

## 建议（AI 提出但超出当前范围的想法）

> AI 觉得有价值但不属于当前任务的想法记这里，用户在里程碑验收时决定是否采纳。
> **AI 不得自行实现这里的任何条目。**

_（暂无）_

---

## 任务记录

### 模板（复制这个格式追加）

```
### 【任务号 · 任务名】 — 完成日期 YYYY-MM-DD

**做了什么**
- 简明列出实际改动（文件级别），不要复述任务描述

**测试结果**
- 命令：`pnpm --filter shared test`
- 通过：X passed / Y total
- 覆盖率：statements XX%
- （UI 任务改为：手动验证步骤与结果）

**验收标准自检**
- ✅ / ❌ 逐条对应 TASKS.md 里该任务的验收标准

**遗留问题**
- （无 / 具体描述，并同步登记到上方「遗留问题」章节）

**给下一个任务的提示**
- （踩过的坑、需要注意的地方、和规格里写的不太一样的实际做法）
```

---

### M0.1 · Monorepo 初始化 — 2026-09-25

**做了什么**
- 根配置：`package.json`（scripts: dev/build/test/test:cov/lint/lint:arch/verify/typecheck）、`pnpm-workspace.yaml`、`tsconfig.base.json`（strict + noUncheckedIndexedAccess + experimentalDecorators + verbatimModuleSyntax）、`vitest.workspace.ts`、`eslint.config.js`（flat config + 类型感知规则 + 分层限制）、`.prettierrc.json`、`.npmrc`、`.gitignore`、`README.md`（含合规声明）
- `packages/shared`：包骨架 + `src/index.ts` 占位 + `vitest.config.ts`（**覆盖率门槛已设死：statements/functions/lines 100%、branches 95%**）+ 冒烟测试
- `packages/server`：包骨架 + `src/index.ts` 占位 + vitest 配置（集成测试超时放宽到 30s）+ 冒烟测试
- `packages/web`：Vite + React 19 + `index.html`（含 viewport-fit=cover 与合规 meta）+ `App.tsx` 占位 + vite proxy `/ws` → `localhost:2567` + `server.host: true`（手机同局域网可访问）+ jsdom 测试环境 + 冒烟测试
- `scripts/check-arch.mjs`：新增架构守卫，6 项检查，作为 `pnpm lint` 第二步

**测试结果**
- 命令：`pnpm verify`（= lint + typecheck + test + build），**退出码 0**
- ESLint：零 error 零 warning
- 架构守卫：5 项全通过（deps / purity / types / placeholder / selftest）
- vitest：`shared 2 passed` + `server 2 passed` + `web 1 passed` = **5 passed / 5 total**，3 个 test file 全绿
- build：shared tsc ✅、server tsc ✅、web `tsc --noEmit && vite build` ✅（产物 222.80 kB / gzip 69.61 kB）
- 依赖安装：438 包，pnpm 9.15，耗时 2m58s

**验收标准自检**（对应 TASKS.md M0.1）
- ✅ `pnpm install` 成功，lockfile 已生成
- ✅ `pnpm -r build` 通过（三个包都能编译）
- ✅ `pnpm -r test` 通过（vitest 能跑起来，5 个测试全绿）
- ✅ `pnpm lint` 零 error
- ✅ `tsconfig` 确认 `strict: true`；shared 包 `dependencies` 为**空**，无 react/colyseus —— 且这一点现在由 `check-arch.mjs` 自动守卫，不靠人工检查
- ✅ `.gitignore` 覆盖 node_modules / dist / coverage / .env

**遗留问题**
- 三项低优先级，已登记到上方「遗留问题」章节（server 生产构建、uuid 间接依赖 deprecated、eslint 9 被标 deprecated）

**给下一个任务的提示**
- **版本已按实测生态修正，不要照抄 SPEC 初稿**：TS 5.9.3（不是 7.0.2）、Vite 7.3.6（不是 8）、React 19.3.0（不是 18）、客户端包名是 `@colyseus/sdk`（不是 `colyseus.js`，后者停在 0.16）。详见 `DECISIONS.md` D-005。
- **shared 包新增依赖前先看 `check-arch.mjs` 的 `ALLOWED_RUNTIME_DEPS` 白名单**。M1.1 要加 `pokersolver`，加完守卫会自动放行（已在白名单里）。
- **`Math.random()` 在 shared 包里被 ESLint 和守卫双重禁止**，M0.2 的随机源必须走注入。守卫还禁止 `window`/`document`/`process` 和 `node:*` 导入。
- shared 的 `tsconfig.json` 设了 `"types": []`，意味着**不能依赖任何 @types 全局**。写测试时用 `import { describe, expect, it } from 'vitest'` 显式导入，不要用 globals。
- `verbatimModuleSyntax: true` 已开启，类型导入必须写 `import type { X }`，否则编译报错。
- 守卫脚本区分「剥离注释后的源码」（查代码构造）和「原始源码」（查 `@ts-ignore`/`TODO`）。**改这个脚本前先读它的头部注释**，那里记了第一版误报的坑。
