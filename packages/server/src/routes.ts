/**
 * HTTP 路由。
 *
 * Colyseus 0.18 的 `new Server({ express })` 接的是一个**回调**而不是 express
 * 实例：传输层自己创建 app 再传进来。所以这里导出的是
 * `(app: Application) => void`，可以直接塞给 `Server` 选项，
 * 也可以塞给 `@colyseus/testing` 的 `boot({ initializeExpress })`。
 *
 * 配对码解析**不需要** HTTP 端点：配对码就是 roomId（D-009），
 * 客户端直接 `joinById(配对码)`，码不存在时 Colyseus 自己会返回
 * `MatchMakeError code=522 room "..." not found`。
 */

import type { Application, Request, Response } from 'express';

/** 健康检查的响应体。部署平台（Fly.io / Render 等）拿这个探活 */
export interface HealthResponse {
  readonly ok: true;
  readonly service: 'poker-room-server';
  /** 进程启动至今的秒数，取整。用来一眼看出是不是刚重启过 */
  readonly uptimeSec: number;
}

export function registerRoutes(app: Application): void {
  app.get('/health', (_req: Request, res: Response<HealthResponse>) => {
    res.status(200).json({
      ok: true,
      service: 'poker-room-server',
      uptimeSec: Math.floor(process.uptime()),
    });
  });
}
