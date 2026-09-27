/**
 * 服务端进程入口 —— 本仓库里唯一有副作用的 server 文件。
 *
 * 为什么要和 `index.ts` 分开：`index.ts` 只导出工厂函数，集成测试 import 它
 * 拿 `createGameServer()` 交给 `@colyseus/testing` 起在随机端口上。
 * 如果监听逻辑写在 `index.ts` 里，测试一 import 就会抢占 2567。
 *
 * 进程入口：`tsx src/main.ts`（`pnpm --filter @poker-room/server start`，容器里同一个）。
 * 用 tsx 而不是先编译再跑，理由见 DECISIONS.md D-043 —— 一句话：`shared` 是
 * **源码导出**（D-006），且全仓的相对 import 都不写扩展名，`tsc` 直出的 ESM
 * 在 node 里根本解析不动；而跑 tsx 的这份代码就是那一千五百多条用例跑的那份。
 */

import { resolvePort, startServer } from './index';
import { createLogger, parseLogLevel } from './logging';

/**
 * 结构化 JSON 日志到 stdout（SPEC §5.2：「Docker 收走」）。
 *
 * 只在这一处装配：`index.ts` 被测试 import，日志门槛和写出目标都在进程入口定，
 * 单测才不会顺手改到真实 stdout。Colyseus 内部自己那几行仍是它的格式，
 * 因为它的 `logger` 没有格式开关（记在 D-043）。
 */
const log = createLogger({
  sink: (line) => void process.stdout.write(line),
  level: parseLogLevel(process.env['LOG_LEVEL']),
  now: () => Date.now(),
});

try {
  const port = resolvePort();
  await startServer(port);
  log.info('server started', { port, health: `http://localhost:${port}/health` });
} catch (error) {
  // 启动失败（最常见是端口被占）必须让进程以非零码退出，
  // 否则 pm2 / Docker / 部署平台会以为服务起来了，健康检查一直超时。
  log.error('server failed to start', { error });
  process.exitCode = 1;
}
