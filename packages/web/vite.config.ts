import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 监听 0.0.0.0，手机同局域网可访问
    port: 5173,
    proxy: {
      // Colyseus WebSocket 走 vite 代理，避免手机访问时的跨域与混合内容问题
      '/ws': {
        target: 'ws://localhost:2567',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
