/**
 * 服务端进程入口 —— 本仓库里唯一有副作用的 server 文件。
 *
 * 为什么要和 `index.ts` 分开：`index.ts` 只导出工厂函数，集成测试 import 它
 * 拿 `createGameServer()` 交给 `@colyseus/testing` 起在随机端口上。
 * 如果监听逻辑写在 `index.ts` 里，测试一 import 就会抢占 2567。
 *
 * `pnpm --filter server dev` → `tsx watch src/main.ts`
 */

import { logger } from 'colyseus';

import { startServer } from './index';

try {
  await startServer();
} catch (error) {
  // 启动失败（最常见是端口被占）必须让进程以非零码退出，
  // 否则 pm2 / Docker / 部署平台会以为服务起来了，健康检查一直超时。
  logger.error(error);
  process.exitCode = 1;
}
