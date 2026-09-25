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
     * 原计划是 `'/ws': { target: 'ws://localhost:2567', ws: true }`，实测行不通：
     * `@colyseus/sdk` 先 `POST /matchmake/{method}/{roomName}` 拿到
     * `{ roomId, processId }`，再往 `ws://host:port/{processId}/{roomId}` 开连接。
     * `processId` 是随机的**根级**路径段，前缀代理盖不住它；要盖住就得代理整个 `/`，
     * 那会把 vite 自己的 HMR、静态资源和 `/health` 全吞掉。
     *
     * 而且代理要解决的问题在 Colyseus 这边并不存在——它默认就放行跨域
     * （`Access-Control-Allow-Origin` 原样回显请求 Origin）。
     *
     * 所以前端直连服务端 origin，见 `src/net/serverUrl.ts` 与 DECISIONS.md D-010。
     * 附带好处：dev 和 prod 走同一条代码路径，验收时测的就是上线后跑的那条。
     */
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
