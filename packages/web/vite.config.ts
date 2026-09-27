import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // 监听 0.0.0.0，手机同局域网可访问 `http://<电脑IP>:5173`。
    // 这一条和 `net/serverUrl.ts` 里用 `location.hostname` 推导服务端地址是配套的：
    // 两者一起才让「手机连同局域网」成立，少任何一个都只会连到手机自己。
    host: true,
    port: 5173,

    /**
     * 这里**故意没有 proxy**，不要加回来。
     *
     * `@colyseus/sdk` 先 `POST {endpoint}/matchmake/{method}/{roomName}` 拿到
     * `{ roomId, processId }`，再往 `{endpoint}/{processId}/{roomId}` 开 WebSocket，
     * 而 endpoint 里的**路径前缀两段都会带上**（`Client.mjs` 的 `buildEndpoint()`）。
     * 所以前缀代理技术上可行——生产上正是这么做的：nginx 把 `/ws` 反代给游戏服
     * （SPEC §5.1 / DECISIONS.md D-043）。
     *
     * dev 不跟着做，是因为 vite 这一侧要留的东西太多：HMR 的 `/`、`/@vite/*`、
     * 静态资源、还有直接打 `:2567/health` 的调试请求，同一个前缀既要给游戏服又要给
     * vite，规则越写越像谜语。何况 Colyseus 默认就放行跨域
     * （`Access-Control-Allow-Origin` 原样回显请求 Origin），直连什么都不用配。
     *
     * 所以前端直连服务端 origin，见 `src/net/serverUrl.ts` 与 DECISIONS.md D-010。
     */
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
