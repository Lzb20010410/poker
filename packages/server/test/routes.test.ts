/**
 * `/health` 与 `ALLOWED_ORIGINS` 这两件 HTTP 层的事。
 *
 * ## 这里能证的、和证不了的
 *
 * express 按注册顺序执行中间件，所以下面每一个用例都在证同一件事：
 * **`registerRoutes` 之后才挂上去的路由，一律在闸门后面**（那个假的 `/matchmake`
 * 就是「后面才注册的路由」的替身）。
 *
 * 但真实的 Colyseus 不是这个顺序：它先把 cors 和 matchmake 挂好，**之后**才调用
 * 我们传的 `express` 回调。实测带恶意 Origin 的 `POST /matchmake/create/poker`
 * 照样建了房，同一个 Origin 打 `/health` 才是 403。所以这道闸覆盖不到真正要紧的
 * 入口，部署形态下的同源校验写在 nginx（`deploy/nginx/*.conf`）。
 * 完整证据与取舍记在 DECISIONS.md D-043——这里不把「挡得住 matchmake」当成结论写死，
 * 是因为那句话错过一次真实测量就会被当成事实传下去。
 *
 * ## 为什么这里起真 express、不用假 req/res
 *
 * 要验的就是「一个带着 Origin 头的 HTTP 请求会发生什么」。拿 `{status(){…}}`
 * 那种手搓替身去测，测的是我怎么写的那个对象，不是 express 的行为。
 * `listen(0)` 让内核挑端口，不会和 2567 / 2568–2570 那几个撞上。
 */

import type { Server } from 'node:http';

import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';

import { createOriginGate, registerRoutes, resolveAllowedOrigins, type HealthResponse } from '../src/routes';

const openServers: Server[] = [];

/** 起一个装了这道闸的真 express 实例，返回它的 base URL */
async function serveWith(allowedOrigins: readonly string[]): Promise<string> {
  const app = express();
  // 生产环境的闸在 `registerRoutes` 里面，它读 `process.env`；这里要按用例换名单，
  // 所以先把同一道闸用参数注一遍。`registerRoutes` 那一道在测试里读到的是空名单=不限制，
  // 两道闸叠加不改变行为，只改变「名单从哪来」。
  app.use(createOriginGate(allowedOrigins));
  registerRoutes(app);
  /** 假装自己是 matchmake：闸只管放行或拒，后面的路由是谁的不重要 */
  app.post('/matchmake/joinOrCreate/poker', (_req, res) => {
    res.status(200).json({ seatReservation: true });
  });

  const server = app.listen(0);
  openServers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('拿不到端口');
  return `http://127.0.0.1:${address.port}`;
}

afterAll(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

function post(base: string, origin?: string): Promise<Response> {
  return fetch(`${base}/matchmake/joinOrCreate/poker`, {
    method: 'POST',
    headers: origin === undefined ? {} : { Origin: origin },
  });
}

describe('resolveAllowedOrigins', () => {
  it('未设置或全空时是空名单，含义是「不限制」', () => {
    expect(resolveAllowedOrigins(undefined)).toEqual([]);
    expect(resolveAllowedOrigins('')).toEqual([]);
    expect(resolveAllowedOrigins('  ,  ')).toEqual([]);
  });

  it('逗号分隔，首尾空白与结尾斜杠都收掉，并统一小写', () => {
    expect(resolveAllowedOrigins(' https://A.Example.com/ ,http://localhost:5173')).toEqual([
      'https://a.example.com',
      'http://localhost:5173',
    ]);
  });

  it('重复项只留一份（两处配置写成同一个域名不是错误）', () => {
    expect(resolveAllowedOrigins('https://a.com,https://a.com/')).toEqual(['https://a.com']);
  });

  it('`*` 是唯一被承认的通配值，别的带星号的写法原样留着（它就该匹配不上）', () => {
    expect(resolveAllowedOrigins('*')).toEqual(['*']);
    expect(resolveAllowedOrigins('https://*.example.com')).toEqual(['https://*.example.com']);
  });
});

describe('Origin 闸门', () => {
  it('名单为空时谁的 Origin 都放行（默认不改变现状）', async () => {
    const base = await serveWith(resolveAllowedOrigins(undefined));
    expect((await post(base, 'https://anywhere.example')).status).toBe(200);
    expect((await post(base)).status).toBe(200);
  });

  it('名单里的 Origin 放行，`*` 时全放行', async () => {
    const listed = await serveWith(resolveAllowedOrigins('https://poker.example.com'));
    expect((await post(listed, 'https://poker.example.com')).status).toBe(200);

    const wildcard = await serveWith(resolveAllowedOrigins('*'));
    expect((await post(wildcard, 'https://anything.at.all')).status).toBe(200);
  });

  it('名单外的 Origin 拒 403，且响应体说清是哪一类拒绝', async () => {
    const base = await serveWith(resolveAllowedOrigins('https://poker.example.com'));
    const res = await post(base, 'https://evil.test');
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'origin-not-allowed' });
  });

  /**
   * 容器健康检查、`curl`、服务端探活脚本都不带 Origin。
   * 把「没有 Origin」当坏 Origin 拒掉，等于让 `docker compose up` 的健康检查红着。
   */
  it('不带 Origin 的请求一律放行', async () => {    const base = await serveWith(resolveAllowedOrigins('https://poker.example.com'));
    expect((await post(base)).status).toBe(200);
  });

  it('`/health` 也在这道闸后面（它由 registerRoutes 自己注册）', async () => {
    const base = await serveWith(resolveAllowedOrigins('https://poker.example.com'));
    expect((await fetch(`${base}/health`, { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
  });

  it('`/health` 在闸门装着的时候照旧 200', async () => {
    const base = await serveWith(resolveAllowedOrigins('https://poker.example.com'));
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as HealthResponse)
      .toMatchObject({ service: 'poker-room-server' });
  });
});
