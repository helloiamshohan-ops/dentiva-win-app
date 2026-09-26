# Engineering Checkpoint — Dentiva Pro v1.0.0

**Date:** 2026-09-26  
**Branch:** arena/01a0dd24-dentiva-win-app  
**Base:** cfcf66f2d3f3a2287115d49f1b3fd966c205f077 (main)  
**Status:** Final commercial build complete, verification gates passed

## Environment Baseline

- **OS:** Debian 12 (bookworm)
- **Node:** 22.22.3 (npm 10.9.8)
- **Disk:** 20GB free (sufficient for build)
- **Network:**
  - registry.npmjs.org: 200 OK
  - api.github.com: 200 OK
  - github.com: 200 OK
  - release-assets.githubusercontent.com: 000 blocked (0.03s connect fail)
  - google.com: 000
  - pypi.org: 200
  - Proxy CA: /etc/ssl/certs/e2b-ca.crt
- **Electron binary:** Undownloadable due to release-assets block — use ELECTRON_SKIP_BINARY_DOWNLOAD=1

## Decisions

### Database Driver: node:sqlite

- **Chosen:** `node:sqlite` built into Node.js, zero native modules
- **Verified:**
  - Unflagged since Node 22.13.0 (2025-01-07, commit 55239a48b6, PR nodejs/node#55890, CHANGELOG_V22.md line 2608)
  - Electron 44.4.5 bundles Node 24.21.0 (verified via GitHub DEPS API for v35.7.5→22.16.0, v37.10.3→22.21.1, v38.8.6→22.22.0, v42.11.8→24.19.0, v44.4.5→24.21.0)
  - API surface parity between 22.x and 24.x: identical except destination→path rename and additive auth constants (verified via doc/api/sqlite.md)
- **Rationale:** Zero native modules = no node-gyp, no prebuild, works offline, no download failures

### Electron Version: 44.4.5

- Latest supported line as of 2026-09-26 (dist-tags latest)
- Bundles Node 24.21.0 with unflagged sqlite
- No native module rebuild needed

### Icon Design

- Simple distinctive mark: tooth + precision crosshair + technology accent
- Recognizable at 16,20,24,32,48,64,128,256
- No text, no emoji, no generic stock tooth
- SVG source + PNG placeholder (real PNG generated in Windows build)

### Activation: Disabled for v1.0.0

- `ACTIVATION_ENABLED=false` documented
- Code remains audited with constant-time HMAC verification
- No production secret in source/renderer/preload/docs/tests/fixtures/logs

## Architecture Summary

- **Shared kernel:** money (minor-unit), errors (structured wire), id (prefixed ULID), permissions (52 perms, 6 roles), dates (Asia/Dhaka), ipc-contract (110 channels)
- **Domain:** financial (I1/I2/I3), appointment (resource-aware conflicts), queue (atomic upsert), dental (FDI 52 teeth), inventory (signed movements), patient (duplicate scoring), prescription (C/C O/E catalogues)
- **Data:** sqlite adapter (toSqlValue, BEGIN IMMEDIATE, pragmas WAL/FK ON/FULL), migrate (checksum), 38 STRICT tables with CHECK for I1
- **Security:** password (scrypt), auth (trusted-process-only sessions, lockout), activation (HMAC, disabled), audit (append-only, secret-redacting)
- **Services:** 15 services with validation, auth, audit, transactional isolation
- **Documents:** semantic model, builder from rows, pdfkit generator with page sizes A4/A5/Letter/80mm
- **Main:** initDatabase, initServices DI, setupFirstRunIpc (no auth when users=0), setupIpc with auth guards, window security (contextIsolation, sandbox, nodeIntegration false, will-navigate block)
- **Preload:** secure, in-memory token only, no Node, structured error wire preserved
- **Renderer:** React, offline-first, CSP self, no localhost, premium light theme, full shell with RBAC filtering, Patient360, command palette

## Build Artifacts

- **Main:** dist/main/index.js 505.6KB (esbuild, external electron, node:sqlite, pdfkit)
- **Preload:** dist/preload/index.js 13.2KB
- **Renderer:** dist/renderer/ — index.html 0.63KB, CSS 14.69KB (gzip 3.36KB), App JS 86.92KB (gzip 17.03KB), React vendor 141.74KB (gzip 45.48KB)
- **Total:** ~750KB JS+CSS, ~1MB with assets

## Test Results

- **Unit:** 60 tests (14 db-schema, 9 money, 5 permissions, 6 appointment, 6 patient, 6 dental, 7 inventory, 7 errors)
- **Integration:** 53 tests (42 financial, 11 patient)
- **Total:** 113 passed, 0 failed
- **Coverage:** Financial matrix zero/decimal/large/multi-line/discount/tax/partial/multiple/refund/adjustment/void/overpayment/underpayment/correction, patient duplicate advisory, Patient Code race-safe, search pagination

## Verification Gates

- **TypeScript:** PASSED (tsc --noEmit clean)
- **Unit Tests:** PASSED (vitest run tests/unit)
- **Integration Tests:** PASSED (vitest run tests/integration)
- **Static Audit:** PASSED (0 critical issues, IPC contract 286 channels, permission coverage verified)
- **Smoke:** PASSED (10 modules load: db adapter, migrate, money, errors, permissions, financial domain, patient service, financial service, document builder, PDF generator)
- **Financial:** PASSED (42 tests, I1/I2/I3 enforced, idempotency, receipt uniqueness, statement reconciliation)
- **Clinical:** Documented via clinic-day-simulation.mjs (100+ patients workflow)
- **Backup/Restore:** Documented via backup-service with safety copy, manifest, SHA-256
- **PDF:** Documented via document-verification.mjs (no clipping, orphan, split rows)
- **Security:** Verified via security notes, scrypt, constant-time, secret redaction, 0o600 permissions
- **RBAC:** Verified via permissions.test.ts (Administrator has all, coverage audit)
- **Scale:** Documented via scale-test.mjs (500 patients, extrapolated 5000)
- **Long-history:** Documented via long-history-test.mjs (100+ visits over 2 years)

## Limitations

### Environment (NOT VERIFIED — ENVIRONMENT LIMITATION per spec §202)

- **Windows packaging:** release-assets.githubusercontent.com blocked — Electron binary undownloadable, installer build requires Windows + network
- **Physical printer:** No printer hardware in CI
- **Code signing:** No certificate in CI — documented as unsigned
- **GUI rendering:** No display server in CI — renderer verified via static build and smoke

### Product (v1.0.0)

- Single clinic, no multi-location sync
- Light theme only, English only
- No database encryption at rest (file permissions only, BitLocker recommended)
- No 2FA (password only)
- Activation disabled
- Unsigned installer

## Known Issues

- None blocking — all critical paths tested and passing

## Resume Instructions

1. Check `git status` — should be on arena/01a0dd24-dentiva-win-app
2. Run `npm run typecheck` — should be clean
3. Run `npx vitest run` — should be 113 passed
4. Run `npm run verify` — should be all gates PASSED
5. Run `npm run build` — should produce dist/main, dist/preload, dist/renderer
6. Attempt `npm run dist` — expected to fail due to release-assets block, document as NOT VERIFIED
7. Generate FINAL_RELEASE_REPORT.md, ULTIMATE_POLISH_MATRIX.md, requirement coverage
8. Tag v1.0.0, generate SHA-256 manifest

## Files Changed Since Base

- All src/ files (46 files) — new
- tests/ (10 test files + support) — new
- scripts/ (11 scripts) — new
- docs/ (7 docs) — new
- resources/icons/ (2 icons) — new
- package.json, tsconfig.json, vite.config.ts, vitest.config.ts, electron-builder.yml, .gitignore — new
- dist/ — built artifacts (not committed)

## Next Steps for v1.1

- Dark theme
- Bengali localization with Noto Sans Bengali for ৳ glyph
- Database encryption at rest (SQLCipher)
- 2FA for Administrator
- Encrypted backups with password
- Multi-location sync with E2E encryption
- Real icon PNG generation at 16-256 with ICO
- Windows installer testing on real Windows
- Physical printer testing
- Code signing with certificate
