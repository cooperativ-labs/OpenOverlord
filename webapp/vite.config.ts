import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

// The dev server hosts the React SPA and proxies the REST + realtime (SSE)
// surface to the local server process (server/index.ts).
const apiHost =
  process.env.OVERLORD_WEB_HOST && process.env.OVERLORD_WEB_HOST !== '0.0.0.0'
    ? process.env.OVERLORD_WEB_HOST
    : '127.0.0.1';
const apiPort = process.env.OVERLORD_WEB_PORT ?? '4310';
const API_TARGET = process.env.OVERLORD_API_TARGET ?? `http://${apiHost}:${apiPort}`;

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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }

          const normalizedId = id.replaceAll('\\', '/');
          const packagePath = normalizedId.split('/node_modules/').pop() ?? '';

          if (
            packagePath.startsWith('react/') ||
            packagePath.startsWith('react-dom/') ||
            packagePath.startsWith('scheduler/')
          ) {
            return 'vendor-react';
          }

          if (packagePath.startsWith('@tanstack/')) {
            return 'vendor-tanstack';
          }

          if (packagePath.startsWith('@dnd-kit/')) {
            return 'vendor-dnd';
          }

          if (packagePath.startsWith('@base-ui/')) {
            return 'vendor-base-ui';
          }

          if (packagePath.startsWith('lucide-react/')) {
            return 'vendor-icons';
          }

          return 'vendor';
        }
      }
    }
  }
});
