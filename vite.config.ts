import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backend = `http://localhost:${process.env.PAPERLESS_AI_PORT ?? 3000}`;

export default defineConfig({
  root: 'src/web',
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, 'src/shared') } },
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/health': backend,
      '/chat/': backend,
    },
  },
});
