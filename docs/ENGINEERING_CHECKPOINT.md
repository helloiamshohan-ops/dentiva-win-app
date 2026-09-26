# Engineering Checkpoint — Dentiva Pro v1.0.0 FINAL

**Date:** 2026-09-26  
**Version:** 1.0.0  
**Tag:** v1.0.0  
**Commit:** 3a2814b3ed6277b4e286cd65b9778abfa8f68756  
**Branch:** arena/01a0dd24-dentiva-win-app  
**Base:** cfcf66f2d3f3a2287115d49f1b3fd966c205f077 (main)  
**Status:** FROZEN — Linux-verifiable build COMPLETE, Windows packaging BLOCKED with evidence, no V2 per instructions

---

## Final Windows Packaging Operation — 2026-09-26

**Instruction:** Run final Windows packaging operation only, on real Windows 10/11 x64 environment with network access, checkout exact v1.0.0 tag, npm ci from lockfile, npm run dist:win, produce NSIS installer + portable exe + ZIP, verify launch, first launch, persistence, PDF, backup/restore, uninstall/reinstall, printer if available, code-sign if certificate available otherwise document UNSIGNED, calculate SHA-256 fresh, record byte sizes, verify artifact ↔ build ↔ tag ↔ commit, update docs, do not reuse hashes, do not claim passed unless artifacts generated, freeze product, final status FINAL RELEASE VERIFIED or BLOCKED with evidence.

**Attempted Environment:**
- OS: Linux e2b.local 6.1.158+ x86_64 GNU/Linux, Debian 12 bookworm — NOT Windows 10/11 x64
- Node: 22.22.3, npm: 10.9.8
- Network: registry.npmjs.org 200 0.11s, api.github.com 200 0.20s, release-assets.githubusercontent.com 000 0.03s BLOCKED
- Proxy CA: /etc/ssl/certs/e2b-ca.crt

**Steps Executed:**

1. **Checkout exact v1.0.0:**
   ```
   $ git checkout v1.0.0
   HEAD is now at 3a2814b feat: complete commercial build v1.0.0
   $ git describe --tags --exact-match HEAD
   v1.0.0
   $ git rev-parse HEAD
   3a2814b3ed6277b4e286cd65b9778abfa8f68756
   ```
   ✅ Verified exact tag and commit

2. **Install dependencies exactly from lockfile:**
   ```
   $ npm ci --ignore-scripts
   added 439 packages in 5s
   ```
   ✅ Verified 439 packages from package-lock.json 260K

3. **Run npm run dist:win:**
   ```
   $ npm run dist:win
   > build:main 505.6KB 42ms, preload 13.2KB 2ms
   > build:renderer Vite 27 modules, 985ms, index.html 0.63KB, CSS 14.69KB, App JS 86.92KB, React 141.74KB
   > electron-builder version=26.15.3 os=6.1.158+ loaded config electron-builder.yml
   > packaging platform=win32 arch=x64 electron=44.4.5 appOutDir=release/win-unpacked
   ⨯ unable to verify the first certificate failedTask=build
     at ClientRequest.<anonymous> (got/dist/source/core/index.js:970:111)
     at TLSSocket.onConnectSecure (tls/wrap:1701:34)
   EXIT_CODE:1
   ```
   ❌ FAILED at packaging step — build succeeds, packaging fails due to TLS cert verification behind proxy and release-assets block

4. **Produce artifacts:**
   ```
   $ ls -R release/
   release/: (empty, 0 files, 0 bytes)
   ```
   ❌ BLOCKED — No NSIS installer, no portable exe, no ZIP — 0 files, 0 bytes

5-12. **Verify launch, first launch, persistence, PDF, backup/restore, uninstall/reinstall, printer, code-sign:**
   - Launch: ❌ NOT VERIFIED — no artifacts, Linux not Windows, no display server
   - First launch: ❌ NOT VERIFIED — requires Windows artifacts
   - Persistence: ✅ VERIFIED via Linux build — 113 tests passing, SQLite WAL/FK ON/FULL
   - PDF: ✅ VERIFIED via Linux build — document-verification.mjs 20 checks PASS
   - Backup/restore: ✅ VERIFIED via Linux build — backup-service + integrity-check.mjs 20 checks PASS
   - Uninstall/reinstall: ❌ NOT VERIFIED — requires Windows NSIS
   - Printer: ❌ NOT VERIFIED — no printer hardware, documented per spec §202
   - Code-sign: UNSIGNED — honestly documented, no certificate available, electron-builder.yml signAndEditExecutable: false with comment "Unsigned: no production code-signing certificate is available. This is declared, not hidden."

13. **SHA-256 fresh (not reused):**
   ```
   58c7482dd87ced4b95b95ce9b0a7a948fd7e1a869e70105edeeec999e565eea2  dist/main/index.js
   f85f9047d8ddaba96947486d068f8ba468d388dd1c10c7c9b4a524a378cf9ff1  dist/preload/index.js
   0c197d2602b418f6517e69c88e77268b4216da2f7b9909938d6d12023d35b68e  dist/renderer/index.html
   7a7ee318cedb188e35c465d764d9f8588913222dc4e97c65268c0b2c995c822d  dist/renderer/assets/index-C04l9VUY.css
   898ab5654713cb7e7471a816731b46e355841e458e0df9e3b8664ede62dce491  dist/renderer/assets/index-BRaMy8Vv.js
   e3433df4feab965bf9eddd674fcf1eab77c0329b3cd1469ba2cbab2498bb9dc3  dist/renderer/assets/react-C8w-UNLI.js
   80b504b2496d244728f9869c5702f5b8f43e36e6fc3d54eb30f788f8e77d7831  dist/checksums.sha256
   Windows artifacts: NOT PRODUCED — SHA-256 N/A
   ```

14. **Exact byte sizes:**
   ```
   517702 dist/main/index.js (505.6KB)
   13529 dist/preload/index.js (13.2KB)
   629 dist/renderer/index.html
   14689 dist/renderer/assets/index-C04l9VUY.css
   86923 dist/renderer/assets/index-BRaMy8Vv.js
   141736 dist/renderer/assets/react-C8w-UNLI.js
   668 dist/checksums.sha256
   Total: 763876 bytes
   release/: 0 files, 0 bytes — NOT PRODUCED
   ```

15. **Verify artifact ↔ build ↔ v1.0.0 tag ↔ exact final commit:**
   ```
   ✅ Tag v1.0.0 ↔ Commit 3a2814b3ed6277b4e286cd65b9778abfa8f68756 — verified via git tag --points-at
   ✅ Commit ↔ Build dist/ — built from 3a2814b via npm run build
   ✅ Build ↔ Artifact dist/ — SHA-256 fresh calculated not reused
   ❌ Artifact ↔ Windows — Windows artifacts NOT PRODUCED — release/ empty — chain broken at packaging
   ```

16. **Update docs:** FINAL_RELEASE_REPORT.md, ENGINEERING_CHECKPOINT.md, ULTIMATE_POLISH_MATRIX.md, REQUIREMENT_COVERAGE.md — updated with fresh hashes, byte sizes, evidence, BLOCKED status

17. **Do not reuse hashes:** Fresh SHA-256 calculated 2026-09-26 11:17 UTC, not reused from any previous/superseded build — verified via find dist -type f -exec sha256sum

18. **Do not claim Windows packaging passed unless artifacts generated:** Windows artifacts NOT generated — release/ 0 files 0 bytes — do NOT claim passed — report BLOCKED

19. **Do not make non-release-critical code changes:** No code changes — only docs updated with evidence, dist/ rebuilt from exact v1.0.0 tag, no features, no redesign, no V2

20. **Freeze product:** Product FROZEN at v1.0.0 commit 3a2814b3ed6277b4e286cd65b9778abfa8f68756 — no V2, no additional feature cycle, no future engineering cycle

**Final Status:** BLOCKED — Windows packaging requires real Windows 10/11 x64 environment with network access to release-assets.githubusercontent.com; current environment is Debian 12 Linux, release-assets returns HTTP 000 in 0.03s, Electron binary undownloadable, electron-builder fails with "unable to verify the first certificate", release/ directory 0 files 0 bytes, no NSIS installer, no portable exe, no ZIP produced

---

## Environment Baseline — Final Attempt

- **OS:** Debian 12 (bookworm), Linux e2b.local 6.1.158+ x86_64 GNU/Linux — NOT Windows 10/11 x64
- **Node:** 22.22.3 (npm 10.9.8)
- **Disk:** 20GB free
- **Network:**
  - registry.npmjs.org: 200 OK 0.11s
  - api.github.com: 200 OK 0.20s
  - github.com: 200 OK
  - release-assets.githubusercontent.com: 000 BLOCKED 0.03s connect fail — PRIMARY BLOCKER
  - google.com: 000
  - pypi.org: 200
  - Proxy CA: /etc/ssl/certs/e2b-ca.crt
- **Electron binary:** Undownloadable due to release-assets block + TLS cert verification failure — SECONDARY BLOCKER

---

## Decisions — Frozen at v1.0.0

### Database Driver: node:sqlite
- **Chosen:** `node:sqlite` built into Node.js, zero native modules
- **Verified:** Unflagged since Node 22.13.0 (2025-01-07, commit 55239a48b6, PR nodejs/node#55890, CHANGELOG_V22.md line 2608), Electron 44.4.5 bundles Node 24.21.0 (verified via GitHub DEPS API for v35.7.5→22.16.0, v37.10.3→22.21.1, v38.8.6→22.22.0, v42.11.8→24.19.0, v44.4.5→24.21.0), API surface parity between 22.x and 24.x: identical except destination→path rename and additive auth constants (verified via doc/api/sqlite.md)
- **Rationale:** Zero native modules = no node-gyp, no prebuild, works offline, no download failures

### Electron Version: 44.4.5
- Latest supported line as of 2026-09-26 (dist-tags latest), bundles Node 24.21.0 with unflagged sqlite, no native module rebuild needed

### Icon Design
- Simple distinctive mark: tooth + precision crosshair + technology accent, recognizable at 16,20,24,32,48,64,128,256, no text, no emoji, no generic stock tooth, SVG source + PNG placeholder (real PNG generated in Windows build)

### Activation: Disabled for v1.0.0
- `ACTIVATION_ENABLED=false` documented, code remains audited with constant-time HMAC verification, no production secret in source/renderer/preload/docs/tests/fixtures/logs

---

## Architecture Summary — Frozen

- **Shared kernel:** money (minor-unit), errors (structured wire), id (prefixed ULID), permissions (52 perms, 6 roles), dates (Asia/Dhaka), ipc-contract (110 channels, 286 found)
- **Domain:** financial (I1/I2/I3), appointment (resource-aware conflicts), queue (atomic upsert), dental (FDI 52 teeth), inventory (signed movements), patient (duplicate scoring), prescription (C/C O/E catalogues)
- **Data:** sqlite adapter (toSqlValue, BEGIN IMMEDIATE, pragmas WAL/FK ON/FULL), migrate (checksum), 38 STRICT tables with CHECK for I1
- **Security:** password (scrypt), auth (trusted-process-only sessions, lockout), activation (HMAC, disabled), audit (append-only, secret-redacting)
- **Services:** 15 services with validation, auth, audit, transactional isolation
- **Documents:** semantic model, builder from rows, pdfkit generator with page sizes A4/A5/Letter/80mm
- **Main:** initDatabase, initServices DI, setupFirstRunIpc (no auth when users=0), setupIpc with auth guards, window security (contextIsolation, sandbox, nodeIntegration false, will-navigate block)
- **Preload:** secure, in-memory token only, no Node, structured error wire preserved
- **Renderer:** React, offline-first, CSP self, no localhost, premium light theme, full shell with RBAC filtering, Patient360, command palette

---

## Build Artifacts — Final Fresh 2026-09-26 11:17 UTC

- **Main:** dist/main/index.js 517702 bytes (505.6KB) SHA-256 58c7482dd87ced4b95b95ce9b0a7a948fd7e1a869e70105edeeec999e565eea2 (esbuild 42ms)
- **Preload:** dist/preload/index.js 13529 bytes (13.2KB) SHA-256 f85f9047d8ddaba96947486d068f8ba468d388dd1c10c7c9b4a524a378cf9ff1 (esbuild 2ms)
- **Renderer:** dist/renderer/ — index.html 629 bytes SHA-256 0c197d2602b418f6517e69c88e77268b4216da2f7b9909938d6d12023d35b68e, CSS 14689 bytes SHA-256 7a7ee318cedb188e35c465d764d9f8588913222dc4e97c65268c0b2c995c822d, App JS 86923 bytes SHA-256 898ab5654713cb7e7471a816731b46e355841e458e0df9e3b8664ede62dce491, React vendor 141736 bytes SHA-256 e3433df4feab965bf9eddd674fcf1eab77c0329b3cd1469ba2cbab2498bb9dc3 — Vite 985ms
- **Total:** 763876 bytes (746KB) JS+CSS+HTML, ~1MB with assets
- **Checksums:** dist/checksums.sha256 668 bytes SHA-256 80b504b2496d244728f9869c5702f5b8f43e36e6fc3d54eb30f788f8e77d7831 — fresh, not reused
- **Windows artifacts:** NOT PRODUCED — release/ 0 files 0 bytes — NSIS installer, portable exe, ZIP distribution require Windows 10/11 x64 + network access to release-assets.githubusercontent.com
- **Icons:** resources/icons/icon.svg 1.1KB, icon.png 70B placeholder (real PNG in Windows build)

---

## Test Results — Frozen

- **Unit:** 60 tests (14 db-schema, 9 money, 5 permissions, 6 appointment, 6 patient, 6 dental, 7 inventory, 7 errors) — PASSED
- **Integration:** 53 tests (42 financial, 11 patient) — PASSED
- **Total:** 113 passed, 0 failed
- **Coverage:** Financial matrix zero/decimal/large/multi-line/discount/tax/partial/multiple/refund/adjustment/void/overpayment/underpayment/correction, patient duplicate advisory, Patient Code race-safe, search pagination

---

## Verification Gates — Final

- **TypeScript:** PASSED (tsc --noEmit clean)
- **Unit Tests:** PASSED (vitest run tests/unit)
- **Integration Tests:** PASSED (vitest run tests/integration)
- **Static Audit:** PASSED (0 critical issues, IPC contract 286 channels, permission coverage verified)
- **Smoke:** PASSED (10 modules load: db adapter, migrate, money, errors, permissions, financial domain, patient service, financial service, document builder, PDF generator)
- **Financial:** PASSED (42 tests, I1/I2/I3 enforced, idempotency, receipt uniqueness, statement reconciliation)
- **Clinical:** PASSED (100+ patients simulation via clinic-day-simulation.mjs)
- **Backup/Restore:** PASSED (manifest, SHA-256, safety copy, path traversal protection)
- **PDF:** PASSED (20 checks via document-verification.mjs, no clipping/orphan/split)
- **Security:** PASSED (scrypt, constant-time, secret redaction, 0o600, Electron security, no secrets in bundles)
- **RBAC:** PASSED (52 perms, 6 roles, coverage audit)
- **Scale:** PASSED (500 patients via scale-test.mjs, extrapolated 5000)
- **Long-history:** PASSED (100+ visits over 2 years via long-history-test.mjs)
- **Performance:** PASSED (14 benchmarks via performance-test.mjs, all within target)
- **Integrity:** PASSED (20 checks via integrity-check.mjs, all consistent)
- **Packaging (dist/):** PASSED (763876 bytes, 7 files, SHA-256 fresh, no secrets)
- **Packaging (Windows):** BLOCKED (release/ 0 files 0 bytes, requires Windows 10/11 x64 + network access to release-assets.githubusercontent.com, current env Debian 12, release-assets 000 in 0.03s, Electron binary undownloadable, electron-builder fails "unable to verify first certificate")

---

## Limitations — Final

### Environment — BLOCKED for Windows Packaging (Evidence-Backed Blocker)

- **Windows packaging:** BLOCKED — release-assets.githubusercontent.com returns HTTP 000 in 0.03s (connect failure), Electron binary undownloadable, electron-builder fails "unable to verify the first certificate" behind proxy, release/ 0 files 0 bytes, no NSIS installer, no portable exe, no ZIP. Requires real Windows 10/11 x64 with network access to release-assets.githubusercontent.com.
- **Physical printer:** NOT VERIFIED — No printer hardware in CI, PDF generation verified same path, documented per spec §202
- **Code signing:** UNSIGNED — No certificate in CI, honestly documented as UNSIGNED, electron-builder.yml signAndEditExecutable: false, requires certificate and Windows signtool, documented per instructions
- **GUI rendering:** NOT VERIFIED — No display server in CI, renderer verified via static build and smoke, documented per spec §202

### Product — v1.0.0 Frozen

- Single clinic, no multi-location sync — planned v1.1 E2E encrypted sync
- Light theme only — planned v1.1 dark theme
- English only — planned v1.1 Bengali with Noto Sans Bengali for ৳ glyph
- No database encryption at rest — file permissions only, BitLocker recommended, planned v1.1 SQLCipher
- No 2FA — password only, planned v1.1 2FA for Administrator
- Activation disabled — ACTIVATION_ENABLED=false, no activation required, documented
- Unsigned installer — no certificate, honestly documented as UNSIGNED, requires certificate

---

## Known Issues — Final

- None blocking for Linux-verifiable build — all critical paths tested and passing, 113 tests PASSED
- Windows packaging BLOCKED by environment, not by code — code frozen and ready for Windows packaging on Windows with network access

---

## Resume Instructions — Final (Product Frozen)

1. Check `git status` — should be on arena/01a0dd24-dentiva-win-app, commit 3a2814b3ed6277b4e286cd65b9778abfa8f68756, tag v1.0.0
2. Verify tag: `git describe --tags --exact-match HEAD` should return v1.0.0
3. Verify commit: `git rev-parse HEAD` should return 3a2814b3ed6277b4e286cd65b9778abfa8f68756
4. Run `npm ci --ignore-scripts` — 439 packages from lockfile
5. Run `npm run build` — should produce dist/main 517702 bytes, dist/preload 13529 bytes, dist/renderer 3 files + index.html, total 763876 bytes
6. Run `npm run typecheck` — should be clean
7. Run `npx vitest run` — should be 113 passed
8. Run `npm run verify` — should be all gates PASSED
9. Calculate fresh SHA-256: `find dist -type f -exec sha256sum {} \; | sort` — should match fresh hashes above, not reused
10. Attempt `npm run dist:win` — expected to fail with "unable to verify the first certificate" and release/ 0 files due to environment limitation — document as BLOCKED with evidence
11. On real Windows 10/11 x64 with network access to release-assets.githubusercontent.com: run `npm run dist:win` to produce NSIS installer + portable exe + ZIP, verify launch, first launch, persistence, PDF, backup/restore, uninstall/reinstall, printer if available, code-sign if certificate available otherwise document UNSIGNED, calculate SHA-256 fresh, record byte sizes, verify artifact ↔ build ↔ tag ↔ commit
12. Product is FROZEN — no V2, no additional feature cycle, no future engineering cycle

---

## Files Changed Since Base — Frozen

- All src/ files (46 files) — new
- tests/ (10 test files + support) — new
- scripts/ (11 scripts) — new
- docs/ (7 docs) — new
- resources/icons/ (2 icons) — new
- package.json, tsconfig.json, vite.config.ts, vitest.config.ts, electron-builder.yml, .gitignore — new
- dist/ — built artifacts 763876 bytes, 7 files, fresh SHA-256 (not committed, generated via npm run build)
- release/ — NOT PRODUCED — 0 files 0 bytes — requires Windows packaging

---

## Next Steps — Final (Requires Windows)

1. **Windows Packaging:** Requires real Windows 10/11 x64 with network access to release-assets.githubusercontent.com — run `npm ci` exact from lockfile, `npm run dist:win` on Windows to build NSIS installer + portable + zip, verify launch, first launch, persistence, PDF, backup/restore, uninstall/reinstall, printer if available, code-sign if certificate available otherwise document UNSIGNED honestly, calculate SHA-256 fresh not reused, record exact byte sizes, verify artifact ↔ build ↔ v1.0.0 tag ↔ exact final commit 3a2814b3ed6277b4e286cd65b9778abfa8f68756
2. **Tag Verification:** Already at v1.0.0 tag, commit 3a2814b — frozen
3. **SHA-256 Manifest:** Fresh hashes calculated 2026-09-26 11:17 UTC for dist/ build — for Windows artifacts, generate after Windows build via `find release -type f -exec sha256sum {} \; | sort`
4. **Release:** Create GitHub release with Windows artifacts, fresh checksums, release notes, FINAL_RELEASE_REPORT.md with BLOCKED or FINAL RELEASE VERIFIED status
5. **Freeze:** Product FROZEN at v1.0.0 — no V2 per instructions

---

## Final Status — FROZEN

**BLOCKED — Windows packaging requires real Windows 10/11 x64 environment with network access to release-assets.githubusercontent.com; current environment is Debian 12 Linux, release-assets returns HTTP 000 in 0.03s, Electron binary undownloadable, electron-builder fails with "unable to verify the first certificate", release/ directory 0 files 0 bytes, no NSIS installer, no portable exe, no ZIP produced — requires Windows 10/11 x64 machine with network access to produce artifacts — Linux-verifiable build COMPLETE and VERIFIED with fresh SHA-256 hashes and exact byte sizes — ready for Windows packaging on Windows with network access — product FROZEN at v1.0.0 commit 3a2814b3ed6277b4e286cd65b9778abfa8f68756 — no V2, no additional feature cycle, no future engineering cycle after this per instructions.**
