import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Renderer build configuration.
 *
 * The renderer is bundled to static files and loaded from disk via `file://` in production.
 * It has no server dependency, no dev-server dependency and no network dependency: the
 * product is offline-first.
 *
 * Test configuration lives in `vitest.config.ts`.
 */
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    // No source maps in the packaged renderer.
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
