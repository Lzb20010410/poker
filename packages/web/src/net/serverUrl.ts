/**
 * 前端要连的 Colyseus origin 怎么算出来。
 *
 * ## 为什么不配 vite proxy（DECISIONS.md D-010）
 *
 * `@colyseus/sdk` 的连接不是一个固定的 WS 路径：它先
 * `POST {endpoint}/matchmake/{method}/{roomName}` 拿到 `{ roomId, processId, ... }`，
 * 再往 `{endpoint}/{processId}/{roomId}` 开 WebSocket。
 *
 * **注意：endpoint 里的路径前缀两段都会带上**（SDK 把 `new URL(endpoint)` 的
 * `pathname` 存进 settings，`Client.mjs` 的 `buildEndpoint()` / `getHttpEndpoint()`
 * 都拼了它）。所以「前缀代理盖不住根级 `processId`」这个说法是**错的**——
 * D-010 当时是照 SDK 0.14 的行为写的，0.18 已经支持。生产形态正是靠它：
 * 一个 nginx、`/ws` 反代到游戏服（见 D-043 与 SPEC §5.1）。
 *
 * dev 仍然不配 proxy，理由换成一条真实的：vite 的 proxy 会把 `/matchmake` 与
 * `/ws/...` 之外的东西（HMR、静态资源、`/health`）留在自己手里，同一个前缀既要给
 * 游戏服又要给 vite，规则越写越像谜语；而 Colyseus 默认放行跨域
 * （`Access-Control-Allow-Origin` 原样回显请求 Origin），直连什么都不用配。
 *
 * ## 推导优先级
 *
 * 1. `VITE_SERVER_URL` 有值 → 用它（绝对地址，或**以单个 `/` 开头的同源前缀**，
 *    后者按 `location.origin` 补全 —— 部署时不必把域名烧进构建产物）
 * 2. DEV → `${protocol}//${hostname}:2567`
 * 3. 其余（生产同源部署）→ `location.origin`
 *
 * 第 2 条用 `location.hostname` 而不是写死 `localhost`，是为了让「手机连同局域网」
 * 直接成立：vite 开了 `host: true`、server 绑 `0.0.0.0`，手机访问
 * `http://<电脑IP>:5173` 时 hostname 就是那个 IP，拼出来的 `http://<电脑IP>:2567`
 * 正好是同一个局域网地址。写死 `localhost` 的话手机会去连手机自己。
 */

/** Colyseus 的惯例端口，和 server 包的 FALLBACK_PORT 保持一致 */
export const DEFAULT_SERVER_PORT = 2567;

/**
 * 解析所需的环境。抽成参数而不是直接读 `window` / `import.meta`：
 * 这样单测不用改全局，jsdom 的默认 location 也不会干扰断言。
 */
export interface ServerUrlEnv {
  /** `import.meta.env.VITE_SERVER_URL` 的原始值，可能没配 */
  readonly override?: string;
  /** 是否 vite dev server（`import.meta.env.DEV`） */
  readonly isDev: boolean;
  /** `location.protocol`，带冒号，例如 `http:` */
  readonly protocol: string;
  /** `location.hostname`，不含端口 */
  readonly hostname: string;
  /** `location.origin` */
  readonly origin: string;
}

export function resolveServerUrl(env: ServerUrlEnv, port: number = DEFAULT_SERVER_PORT): string {
  const override = env.override?.trim();
  if (override !== undefined && override !== '') return sameOriginPrefix(override, env.origin);
  if (env.isDev) return `${env.protocol}//${env.hostname}:${port}`;
  return trimTrailingSlash(env.origin);
}

/**
 * 以单个 `/` 开头的配置值是「本页同源的那个前缀」，浏览器在运行时补全域名。
 *
 * 部署形态（SPEC §5.1）是 nginx 一个端口对外：静态产物自己端，`/ws` 反代给 Colyseus。
 * 于是构建参数只需要 `/ws`，域名留在运行时——**换域名不必重新 build 镜像**。
 *
 * `//other/ws` 不在此列：URL 语法里那是协议相对的**另一个**地址，拼到本页 origin 前面
 * 会得到一个谁都不指的东西。原样交出去让它显式失败，比悄悄改写强。
 */
function sameOriginPrefix(override: string, origin: string): string {
  if (!override.startsWith('/') || override.startsWith('//')) return trimTrailingSlash(override);
  return `${trimTrailingSlash(origin)}${trimTrailingSlash(override)}`;
}

/** 当前浏览器环境下要连的地址。整个前端只有这一个地方读 `import.meta` 和 `location` */
export function currentServerUrl(): string {
  return resolveServerUrl({
    override: import.meta.env.VITE_SERVER_URL,
    isDev: import.meta.env.DEV,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    origin: window.location.origin,
  });
}

/**
 * 去掉结尾的 `/`。
 *
 * SDK 内部会自己再删一次尾斜杠，但 `VITE_SERVER_URL` 是人手填的，
 * 填成 `https://x.com/` 太常见了；在这里就收敛掉，日志和错误提示里也不会出现双斜杠。
 */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
