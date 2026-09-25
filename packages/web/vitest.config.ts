import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    root: import.meta.dirname,
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
