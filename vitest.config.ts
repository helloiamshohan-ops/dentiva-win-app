import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Test configuration.
 *
 * Tests run against the real SQLite engine (`node:sqlite`) — the same engine the production
 * application uses — and against real generated PDFs. Nothing is mocked at the database or
 * document layer.
 */
export default defineConfig({
  resolve: {
    alias: [
      // `node:sqlite` is a genuine Node builtin but is not present in `module.builtinModules`
      // while it remains experimental, so Vite's resolver cannot classify it and tries to load
      // it from disk. The shim re-exports the real module via `createRequire`; see
      // tests/support/node-sqlite-shim.mjs. No behaviour is substituted.
      { find: /^node:sqlite$/, replacement: fileURLToPath(new URL('./tests/support/node-sqlite-shim.mjs', import.meta.url)) },
      { find: '@shared', replacement: fileURLToPath(new URL('./src/shared', import.meta.url)) },
      { find: '@domain', replacement: fileURLToPath(new URL('./src/domain', import.meta.url)) },
      { find: '@main', replacement: fileURLToPath(new URL('./src/main', import.meta.url)) },
      { find: '@renderer', replacement: fileURLToPath(new URL('./src/renderer', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Forks rather than threads: SQLite handles are process-local and must not be shared.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
    reporters: ['default'],
  },
});
