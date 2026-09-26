# Dentiva Pro — Engineering Checkpoint

> This file is the authoritative resume point. If the session stops, read this file and
> continue exactly from the recorded point. Do not repeat completed work.

## Current phase

**PHASE 1 — Foundation: architecture, shared kernel, domain rules, database layer.**

## Release target

- Product: Dentiva Pro
- Version: 1.0.0
- Platform: Windows x64 desktop (Electron)
- Language: English only
- Operating model: offline-first / local-first
- Database: embedded SQLite via Node.js built-in `node:sqlite`

## Environment baseline (measured, not assumed)

| Item | Measured value | How measured |
|---|---|---|
| Repository start state | 1 file (`README.md`, 78 bytes), 1 commit `cfcf66f` | `find . -not -path './.git/*'`, `git log` |
| Host OS | Debian GNU/Linux 12 (bookworm), Linux 6.1.158 x86_64 | `uname -a`, `/etc/os-release` |
| CPU / RAM / disk | 2 cores / 3939 MB / 20 GB free | `nproc`, `free -m`, `df -h` |
| Node.js | v22.22.3 | `node --version` |
| npm | 10.9.8 | `npm --version` |
| TypeScript | 5.9.3 | `tsc --version` |
| Vite / Vitest / esbuild | 6.4.3 / 2.1.9 / 0.24.2 | binary `--version` |
| Electron package | 44.4.5 (binary **not** downloaded) | `node_modules/electron/package.json` |
| Electron 44 bundled Node | v24.21.0 | GitHub `electron/electron` `DEPS` @ `v44.4.5` |

## Verified technical decisions

1. **Database driver = Node built-in `node:sqlite`.**
   - Evidence: `node -e "require('node:sqlite')"` succeeds **without** `--experimental-sqlite`
     on Node v22.22.3; exports `DatabaseSync`, `StatementSync`, `constants`, `backup`.
   - Node official changelog: sqlite module unflagged in **v22.13.0** (2025-01-07, commit
     `55239a48b6`, PR nodejs/node#55890).
   - Electron 44.4.5 bundles Node v24.21.0 (>= 22.13.0), so unflagged there too.
   - API-contract parity between Node 22.x (test runtime) and Node 24.x (production runtime)
     verified by diffing `doc/api/sqlite.md` on branches `v22.x` and `v24.x`. Only
     differences: doc parameter rename `destination` -> `path` on `sqlite.backup`, and
     additive v24 features (authorization constants). No breaking change to the surface used.
   - Consequence: **zero native modules.** No node-gyp, no ABI rebuild, no Windows
     cross-compilation, no prebuilt-binary download. This removes the single largest
     packaging risk for a Windows x64 release.

2. **Electron 44.4.5** chosen over 38.x/35.x because it is the current supported line
   (security updates) for a medical-data product.

## Environment limitations (must never be reported as PASSED)

| Limitation | Evidence |
|---|---|
| **No Windows environment.** Host is Linux x86_64. | `uname -a` |
| **Electron runtime cannot be downloaded or executed here.** `release-assets.githubusercontent.com` is unreachable (`curl` connect fails, http_code `000`, 0.03 s). GitHub `api.github.com` and `github.com` return `200`, but release *assets* are blocked, so `electron` and `electron-builder` cannot fetch the Electron dist zip / NSIS / winCodeSign binaries. | direct `curl` probes |
| **No physical printer.** | No print subsystem on host |
| **No code-signing certificate.** | None available |
| **No GUI / no display server.** Electron window rendering cannot be visually verified here. | headless container |

These are recorded per specification §202 and will be reported as
`NOT VERIFIED — ENVIRONMENT LIMITATION`, never as `PASSED`.

## Completed

- [x] Repository baseline established and measured
- [x] Toolchain installed and version-pinned
- [x] Database driver decision made and verified against upstream sources
- [x] Electron version decision made and verified against upstream sources
- [x] Network allowlist characterised (npm registry, github.com, api.github.com, pypi.org reachable; raw/CDN/release-asset hosts blocked)

## Active work

- [ ] Shared kernel (`src/shared`): money, errors, ids, permissions, dates, validation, IPC contract
- [ ] Domain layer (`src/domain`): financial, appointment, inventory, patient, dental, queue
- [ ] Database layer (`src/main/db`): adapter, migration runner, schema
- [ ] Repositories
- [ ] Services
- [ ] Security (auth, RBAC, lock, activation)
- [ ] Document engine (prescription/invoice/receipt/statement) + PDF
- [ ] Backup / restore
- [ ] Attachments
- [ ] IPC layer with authorization
- [ ] Preload + renderer + design system + all screens
- [ ] Tests (unit, integration, static gates)
- [ ] Packaging configuration
- [ ] Documentation

## Discovered issues

| ID | Severity | Finding | Status |
|---|---|---|---|
| E-001 | Blocker (env) | Electron binary + electron-builder binaries undownloadable in sandbox | Documented as environment limitation; Windows packaging cannot be executed or verified here |

## Next action

Implement `src/shared` kernel, then `src/domain`, then the database layer with migrations.

## Final commit / tag / release status

Not yet determined — engineering in progress.
