/**
 * Build main process and preload with esbuild.
 * No native modules — pure JS bundle for Electron's Node runtime.
 */

import { build } from 'esbuild';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function buildMain() {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/main/index.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: fileURLToPath(new URL('../dist/main/index.js', import.meta.url)),
    external: ['electron', 'node:sqlite', 'pdfkit'],
    sourcemap: false,
    minify: false,
    logLevel: 'info',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  await build({
    entryPoints: [fileURLToPath(new URL('../src/preload/index.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: fileURLToPath(new URL('../dist/preload/index.js', import.meta.url)),
    external: ['electron'],
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });

  console.log('Main and preload built successfully.');
}

buildMain().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
