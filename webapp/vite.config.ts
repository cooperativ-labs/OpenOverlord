import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

// The dev server hosts the React SPA and proxies the REST + realtime (SSE)
// surface to the local server process (server/index.ts).
const API_TARGET = process.env.OVERLORD_API_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'web')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // SSE must stream, never buffer.
        configure: proxy => {
          proxy.on('proxyReq', proxyReq => proxyReq.setHeader('connection', 'keep-alive'));
        }
      }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});
