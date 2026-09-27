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

import type { Application, NextFunction, Request, Response } from 'express';

/** 健康检查的响应体。部署平台（Fly.io / Render 等）拿这个探活 */
export interface HealthResponse {
  readonly ok: true;
  readonly service: 'poker-room-server';
  /** 进程启动至今的秒数，取整。用来一眼看出是不是刚重启过 */
  readonly uptimeSec: number;
}

/**
 * `ALLOWED_ORIGINS` 的解析结果。**空数组的含义是「不限制」**，不是「什么都不许」：
 * 没配这个变量的部署（本机、局域网手机局）必须照旧能连，否则每次起容器都要先猜域名。
 */
export function resolveAllowedOrigins(raw: string | undefined = process.env['ALLOWED_ORIGINS']): string[] {
  if (raw === undefined) return [];
  const origins = new Set<string>();
  for (const item of raw.split(',')) {
    const origin = normalizeOrigin(item);
    if (origin !== '') origins.add(origin);
  }
  return [...origins];
}

/**
 * Origin 闸门。
 *
 * **它挡不住 `/matchmake`。** 实测：`ALLOWED_ORIGINS=https://ok.example` 起进程后，
 * 带 `Origin: https://evil.example` 的 `POST /matchmake/create/poker` 照样返回了
 * `{ roomId, processId }`，而同一个头打 `/health` 是 403。原因是 Colyseus 0.18
 * 先把 cors 和 matchmake 那批路由挂到自己的 app 上，**之后**才调用我们传的
 * `express` 回调；express 按注册顺序执行，所以我们后注册的中间件根本轮不到。
 * `ServerOptions` 里也没有任何 CORS/来源开关可改（14 个键全探过：
 * `publicAddress / presence / driver / transport / gracefullyShutdown / logger /
 * beforeListen / database / express / auth / selectProcessIdToCreateRoom /
 * isStandaloneMatchMaker / devMode / greet`）。证据与取舍记在 DECISIONS.md D-043。
 *
 * 那这道门还有什么用：**部署形态下真正的咽喉在 nginx**（`deploy/nginx/*.conf` 里
 * `/ws/` 的同源校验），这里留的是第二道——它管得住本文件注册的所有路由，
 * 也保证「有人把 2567 直接 `ports:` 暴露出去」时 `ALLOWED_ORIGINS`（SPEC §5.2
 * 点名的环境变量）仍然有意义，而不是一个只在文档里生效的开关。
 */
export function createOriginGate(
  allowedOrigins: readonly string[],
): (req: Request, res: Response, next: NextFunction) => void {
  const allowed = new Set(allowedOrigins.map(normalizeOrigin));
  const unrestricted = allowed.size === 0 || allowed.has('*');

  return (req: Request, res: Response, next: NextFunction): void => {
    if (unrestricted) {
      next();
      return;
    }
    /**
     * 没有 Origin 头的请求一律放行：`curl`、容器健康检查、探活脚本都不带它。
     * 把「没带」当成「坏 Origin」，`docker compose up` 的健康检查会一直红着。
     */
    const origin = req.headers.origin;
    if (origin === undefined || allowed.has(normalizeOrigin(origin))) {
      next();
      return;
    }
    res.status(403).json({ error: 'origin-not-allowed' });
  };
}

/** Origin 的比较口径：小写、去首尾空白、去结尾斜杠。`*` 之外的星号写法原样留着（它就该匹配不上） */
function normalizeOrigin(raw: string): string {
  return raw.trim().toLowerCase().replace(/\/+$/, '');
}

export function registerRoutes(app: Application): void {
  app.use(createOriginGate(resolveAllowedOrigins()));

  app.get('/health', (_req: Request, res: Response<HealthResponse>) => {
    res.status(200).json({
      ok: true,
      service: 'poker-room-server',
      uptimeSec: Math.floor(process.uptime()),
    });
  });
}
