import { serwist } from '@serwist/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

import { loadRepoEnvForProfile } from './load-repo-env';

// Development reads `.env.local` only so it never collides with production `.env.prod`.
loadRepoEnvForProfile(path.resolve(__dirname, '..'), 'development');

// The dev server hosts the React SPA and proxies the REST + realtime (SSE)
// surface to the local backend process (backend/index.ts).
const apiHost =
  process.env.OVERLORD_WEB_HOST && process.env.OVERLORD_WEB_HOST !== '0.0.0.0'
    ? process.env.OVERLORD_WEB_HOST
    : '127.0.0.1';
const apiPort = process.env.OVERLORD_WEB_PORT ?? '4310';
const API_TARGET = process.env.OVERLORD_API_TARGET ?? `http://${apiHost}:${apiPort}`;

// The SPA dev-server port. Agents testing the webapp must set this (and a
// matching OVERLORD_WEB_PORT for the API) to a free port so they never collide
// with an instance the user already has running locally.
const devPort = Number(process.env.OVERLORD_WEB_DEV_PORT ?? '5173');

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    serwist({
      swSrc: 'web/sw.ts',
      swDest: 'sw.js',
      globDirectory: 'dist',
      injectionPoint: 'self.__SW_MANIFEST',
      rollupFormat: 'iife',
      disable: process.env.NODE_ENV === 'test'
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'web')
    }
  },
  server: {
    port: devPort,
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

          if (
            packagePath.startsWith('better-auth/') ||
            packagePath.startsWith('@better-auth/') ||
            packagePath.startsWith('@better-fetch/')
          ) {
            return 'vendor-auth';
          }

          if (packagePath.startsWith('zod/') || packagePath.startsWith('zod@')) {
            return 'vendor-zod';
          }

          if (
            packagePath.startsWith('@floating-ui/') ||
            packagePath.startsWith('class-variance-authority/') ||
            packagePath.startsWith('clsx/') ||
            packagePath.startsWith('tailwind-merge/') ||
            packagePath.startsWith('next-themes/')
          ) {
            return 'vendor-ui-utils';
          }

          return 'vendor';
        }
      }
    }
  }
});
