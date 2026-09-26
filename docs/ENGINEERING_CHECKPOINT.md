# Engineering Checkpoint — Dentiva Pro v1.0.0 (FINAL RELEASE GATE)

**Date:** 2026-09-26 · **Version:** 1.0.0 · **Status:** FROZEN SOURCE, RELEASE BLOCKED

| Item | Value |
|---|---|
| Repository | `helloiamshohan-ops/dentiva-win-app` |
| Authoritative branch | `arena/01a0dd24-dentiva-win-app` → `1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5` |
| Tag | `v1.0.0` → `1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5` (verified with `git rev-parse`, `git ls-remote`) |
| Product-code freeze | `0953e4965e142834fbec6460d16c883876b87efe` (parent of the tag) |
| Diff freeze → tag | `WINDOWS_RELEASE_GATE_REPORT.md` only → tag/source relationship is consistent |
| `866c61e1a08dd01cc2585cc1798a04cebd656dac` | does not exist in this repository (git and GitHub API both confirm) |
| Working tree | clean before and after the gate; **no product source file was modified** |

Full results, evidence, hashes and limitations: **`docs/FINAL_RELEASE_REPORT.md`**.
Raw command-level evidence: **`docs/RELEASE_GATE_EVIDENCE.md`**.

## What was actually executed (this environment: Debian 12, Node 22.22.3, npm 10.9.8)

| Step | Result |
|---|---|
| `npm ci --ignore-scripts` | exit 0 — 439 packages, 7 s, 0 production vulnerabilities |
| `npm run typecheck` | PASS |
| `npm test` (vitest) | PASS 113/113 |
| `npm run static-audit`, `npm run smoke`, `npm run verify` | exit 0 (see limitation below) |
| `npm run build` | PASS — 6 files, 777 KB, hashes recorded |
| `npm run dist:win` | **FAILED** — Electron distribution CDN unreachable (TLS reset); `release/` empty |
| Independent gate harness (01–06, outside the repo) | 01: 26/33 · 02: 47/6/4 · 03: RBAC 5/5 + 5/5, 39/41 fresh reads · 04: 21/21 structural + 2 money failures · 05: 4/20 · 06: 18/19 |

## Release-blocking defects (do not ship)

* **P0-1** Clean install cannot create the first administrator (detection channel is auth-guarded; the fallback uses `require('electron')` in a sandboxed renderer; `firstRun:*` channels are outside the contract and the preload).
* **P0-2** No session token ever reaches the renderer → every authenticated action fails after sign-in.
* **P0-3** `restoreBackup()` always throws and its recovery path replaces the live database with a WAL-less copy → measured data loss of 100 % of rows (backups themselves are valid).
* **P1-1** `createTreatment` always fails (`NOT NULL constraint failed: treatments.active`).
* **P1-2** `reschedule` always fails (`ambiguous column name: id`).
* **P1-3** Dashboard / queue summary crash when the underlying tables are empty.
* **P1-4** ৳ renders as mojibake in invoice/receipt/statement PDFs (Helvetica has no taka glyph; no font is shipped).
* **P2-1** `integrity-check.mjs` / `document-verification.mjs` / `performance-test.mjs` / `clinic-day-simulation.mjs` / `long-history-test.mjs` print success without testing; `scale-test.mjs` exits 1.
* **P2-2** Placeholder navigation pages remain in the renderer.

## Not verified (environment)

Windows packaging, Windows runtime, installer/uninstall/reinstall, physical printing,
code signing, GUI behaviour, offline behaviour at runtime: **NOT VERIFIED — ENVIRONMENT LIMITATION**
(no Windows, no Electron binary, no display server, no printer, no certificate).
Scale beyond 500 patients: **not tested** (design-supported only).

## Next cycle (required before any release claim)

1. Fix P0-1 … P1-4 with the smallest correct changes; keep the tag/source relationship intact.
2. Re-run the full suite **and** the session-local gate harness, then add regression tests that fail before each fix.
3. Rebuild, recompute all hashes, invalidate every artifact listed in the superseded reports.
4. On a real Windows 10/11 x64 host with CDN access: `npm ci`, `npm run dist:win`, install/uninstall/reinstall,
   runtime stability, PDF and physical printing, and code signing — then re-issue this checkpoint.
