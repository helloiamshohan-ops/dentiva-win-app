/**
 * Test-harness shim for `node:sqlite`.
 *
 * `node:sqlite` is a real Node.js builtin, but because it is still marked experimental it is
 * NOT listed in `module.builtinModules`. Vite's resolver uses that list to decide whether an
 * import is a builtin, so it tries to load `node:sqlite` from disk and fails.
 *
 * This shim is referenced only by `vitest.config.ts` via a resolve alias. It re-exports the
 * genuine module obtained through `createRequire`, so tests exercise the exact same
 * `DatabaseSync` class the production application uses — nothing is mocked or substituted.
 *
 * The production bundle (built with esbuild) does not use this file; esbuild treats
 * `node:sqlite` as an external builtin for `platform: node`.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
export const constants = sqlite.constants;
export const backup = sqlite.backup;
export default sqlite;
