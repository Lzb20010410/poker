/**
 * 前端要连的 Colyseus origin 怎么算出来。
 *
 * ## 为什么不配 vite proxy（DECISIONS.md D-010）
 *
 * `@colyseus/sdk` 的连接不是一个固定的 WS 路径：它先
 * `POST /matchmake/{method}/{roomName}` 拿到 `{ roomId, processId, ... }`，
 * 再往 `ws://host:port/{processId}/{roomId}` 开 WebSocket。`processId` 是随机的
 * **根级**路径段，路径前缀代理盖不住它；而 Colyseus 本来就默认放行跨域
 * （`Access-Control-Allow-Origin` 原样回显请求 Origin）。所以直连。
 *
 * 直连的额外好处：dev 和 prod 走的是同一条代码路径，验收时测的就是上线后跑的那条。
 *
 * ## 推导优先级
 *
 * 1. `VITE_SERVER_URL` 有值 → 用它（部署到线上、或本地想连远端时的开关）
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
  if (override !== undefined && override !== '') return trimTrailingSlash(override);
  if (env.isDev) return `${env.protocol}//${env.hostname}:${port}`;
  return trimTrailingSlash(env.origin);
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
