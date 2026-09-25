/**
 * @poker-room/server — Colyseus 服务端。
 *
 * 分层职责（见 SPEC.md §1.2）：本包只做「权威判定 + 同步 + 房间生命周期」，
 * 游戏规则一律调用 @poker-room/shared/engine，禁止在这里重复实现。
 *
 * **本文件不产生副作用**：只导出工厂函数。真正 `listen()` 的地方在 `main.ts`。
 * 这样集成测试可以 import 这里拿到 `createGameServer`，交给
 * `@colyseus/testing` 去起，而不会顺带占掉 2567 端口。
 */

import { logger, Server } from 'colyseus';

import { PokerRoom } from './rooms/PokerRoom';
import { registerRoutes } from './routes';

export const SERVER_PACKAGE = '@poker-room/server' as const;

/** 房间类型名。客户端 `joinOrCreate('poker')` 用的就是它 */
export const ROOM_TYPE_POKER = 'poker' as const;

/** 开发环境默认端口。web 包的 vite proxy 指向这里，改动要同步 */
export const FALLBACK_PORT = 2567;

/**
 * 从环境变量解析端口。
 *
 * 显式抛错而不是回落到默认值：部署平台上 PORT 写错，
 * 静默用 2567 会让健康检查一直失败、日志里却看不出错在哪。
 */
export function resolvePort(raw: string | undefined = process.env['PORT']): number {
  if (raw === undefined || raw.trim() === '') return FALLBACK_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`环境变量 PORT 不是合法端口号：${JSON.stringify(raw)}`);
  }
  return port;
}

/** 组装好但**未监听**的 Colyseus Server。测试用 `@colyseus/testing` 接管它 */
export function createGameServer(): Server {
  const gameServer = new Server({ express: registerRoutes });
  gameServer.define(ROOM_TYPE_POKER, PokerRoom);
  return gameServer;
}

/** 启动并监听。`main.ts` 调它，返回实例方便优雅退出时拿句柄 */
export async function startServer(port: number = resolvePort()): Promise<Server> {
  const gameServer = createGameServer();
  await gameServer.listen(port);
  logger.info(
    `[poker-room] 已启动，监听端口 ${port}；WebSocket ws://localhost:${port}，健康检查 http://localhost:${port}/health`,
  );
  return gameServer;
}

export * from './rooms/PokerRoom';
export * from './routes';
export * from './schema/PokerRoomState';
