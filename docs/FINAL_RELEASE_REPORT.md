# Dentiva Pro v1.0.0 — Final Windows Commercial Release Gate Report

**Date:** 2026-09-26
**Report status:** supersedes every earlier release report in this repository.
**Gate type:** final commercial release verification (no development work performed on the product).

---

FINAL STATUS:
BLOCKED — 3 P0 defects prevent the product from being usable or safe on a clean Windows machine.
(A) a clean install cannot create its first administrator; (B) no session token ever reaches the
renderer, so every authenticated action fails after sign-in; (C) the backup-restore feature
destroys the clinic database (measured: 25 patient records → 0) while reporting an error.
All three were reproduced from the frozen source with the real services and the real SQLite engine.

---

## RELEASE IDENTITY

| Item | Value |
|---|---|
| Tag | `v1.0.0` (annotated? no — lightweight tag object) |
| Commit pointed to by `v1.0.0` | `1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5` |
| Branch verified | `arena/01a0dd24-dentiva-win-app` (remote) = `1ff93dc…` |
| This session's branch | `arena/01a0dd90-dentiva-win-app` = `1ff93dc…` (same commit; enforced by session policy) |
| Product-code freeze commit | `0953e4965e142834fbec6460d16c883876b87efe` (parent of the tag) |
| Diff freeze → tag | `WINDOWS_RELEASE_GATE_REPORT.md` only (871 insertions, 0 deletions) — **consistent**, no product-code change after the freeze |
| Working tree at gate start | clean (`git status --porcelain` empty) |
| Commits in repository | 9 (history was shallow at clone time; un-shallowed during this gate) |

**Tag/commit verification (performed, not assumed):**

```
$ git rev-parse v1.0.0^{commit}          -> 1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5
$ git rev-list --parents -1 HEAD          -> 1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5 0953e4965e142834fbec6460d16c883876b87efe
$ git diff --stat 0953e496 1ff93dc         -> WINDOWS_RELEASE_GATE_REPORT.md | 871 +++++
$ git ls-remote origin                     -> refs/tags/v1.0.0 = 1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5
                                           -> refs/heads/arena/01a0dd24-dentiva-win-app = 1ff93dc…
```

**Historical hashes named in the gate instruction:**

| Expected value | Result |
|---|---|
| `866c61e1a08dd01cc2585cc1798a04cebd656dac` (expected tag target) | **does not exist** in this repository — not in `git cat-file`, and GitHub returns `422 No commit found for SHA` |
| `0953e4965e142834fbec6460d16c883876b87efe` (product-code freeze) | exists, is the parent of the tag, matches the freeze description |

No history was rewritten and no replacement tag was created.

---

## ENVIRONMENT

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 12 (bookworm), kernel 6.1.158+, `e2b.local` |
| Architecture | x86_64 (Intel Xeon @ 2.60 GHz, 2 vCPU) |
| RAM / disk | 3 939 MB / 19 GB free |
| Node | v22.22.3 |
| npm | 10.9.8 |
| Electron (declared) | ^44.4.5 — package present in `node_modules`, **binary NOT downloaded** |
| electron-builder (declared) | ^26.15.3 |
| Git | 2.39.5 |
| Network | npm registry + api.github.com + pypi reachable (HTTP 200). `release-assets.githubusercontent.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `codeload…`, all mirrors → connection reset (TLS `SSL_ERROR_SYSCALL`; 000 in curl). Artefacts of first-party Electron distributions are therefore unreachable. |
| Windows | **NO** — no Windows host, no Wine, no display server, no GPU device |
| Printer | **NONE** — no CUPS, no physical printer |
| Code-signing certificate | **NONE** |
| Display server | none (`$DISPLAY` empty) → no GUI execution possible |

---

## BUILD

| Item | Result |
|---|---|
| Command | `npm run clean && npm run build` (i.e. `build:main` = esbuild, `build:renderer` = vite) |
| Result | **exit 0** |
| Duration | 3 s total (main 83 ms, preload 3 ms, renderer 1.58 s) |
| Output | `dist/main/index.js` 517 686 B, `dist/preload/index.js` 13 529 B, `dist/renderer/index.html` 629 B, `index-*.js` 86 923 B, `react-*.js` 141 736 B, `index-*.css` 14 689 B (777 KB total) |
| Source maps | none in `dist` (0 `.map`, 0 `.ts`) |

---

## TEST SUMMARY

All commands below were executed in this environment on the frozen commit. "Script present but not
functional" is stated plainly rather than reported as a pass.

| Area | Command | Result |
|---|---|---|
| Dependency install | `npm ci --ignore-scripts` | exit 0, 439 packages, 7 s, 5 dev-only advisories (`npm audit --omit=dev` → 0 vulnerabilities) |
| TypeScript | `npm run typecheck` | **PASS** (exit 0, 7 s) |
| Unit tests | `npm test` (vitest, 10 files) | **PASS 113/113** (4.5 s) |
| Integration tests | included above | **PASS** (financial 42, patient 11 …) |
| Static audit | `npm run static-audit` | exit 0 — but see LIMITATIONS: it asserts `console.log`/`localhost` policy with allow-lists and cannot detect the defects below |
| Smoke | `npm run smoke` | exit 0 — checks that 10 source files exist (file-existence check only) |
| Integrity | `npm run integrity` | prints 20 ✅ — **hard-coded `fn: () => true`**, no database is opened (see LIMITATIONS) |
| Document verification | `npm run docs-verify` | prints 20 ✅ — **hard-coded PASS strings**, no PDF is generated (see LIMITATIONS) |
| Clinic-day simulation | `npm run clinic-day` | does not run the harness (ESM import of `.ts` fails) and prints a hard-coded checklist |
| Scale | `npm run scale` | **exit 1** — `ERR_MODULE_NOT_FOUND: src/main/db/sqlite' imported from tests/support/harness.ts` (Node cannot load `.ts`) |
| Long history | `npm run long-history` | prints a hard-coded checklist; no test executes |
| Performance | `npm run perf` | prints **invented** benchmark numbers (e.g. "Application cold start 2100 ms") |
| Final gate | `npm run verify` | **PASS 5/5** (typecheck, unit, integration, static audit, smoke) |
| Independent gate harness (this session, outside the repository) | `01-core-workflow.ts` … `06-scale-history.ts` | see below |

### Independent gate harness — results

| Gate | Scope | Result |
|---|---|---|
| 01 core workflow | clinic setup, patients ×100, duplicates, archive/restore, visits, dental chart (FDI), prescriptions (label compliance), 80 appointments + conflicts, queue ×60, treatment plans, invoice invariants, 7 payment methods, refund/adjustment/void, statement, inventory, reports vs SQL, global search, notifications, attachments, integrity, schema, persistence | **PASS 26/33**; the 7 failures are the P0/P1 defects below plus 2 harness-field mistakes (see DEFECTS, notes) |
| 02 feature matrix | 57 write/read probes across every service | **47 OK / 6 rejected by business rules / 4 DEFECT** (the four are defects 2, 4, 5, 6) |
| 03 security / RBAC | 41 empty-state reads, role matrix, session handling, IPC surface, Electron hardening | **fresh-install reads 39/41** (2 crash = defect 6); **RBAC 5/5 forbidden blocked, 5/5 permitted allowed**; **preload ⇄ handler ⇄ contract: 151 channels, 0 dead, 0 unreachable**, but **2 orphan handlers outside the contract** (`firstRun:createAdmin`, `firstRun:check`); BrowserWindow `contextIsolation`/`sandbox`/`no nodeIntegration`/`webSecurity` all correct; CSP correct; no secrets or hard-coded activation serial in source |
| 04 documents | real PDF generation for prescription / invoice / receipt / statement × A4 / A5 / Letter / 80 mm + long prescription, then parse the produced PDFs | **PASS 21/21 structural**, **FAIL 2** money-text checks (defect 7). Multipage prescription = 3 pages, 5575 extracted chars, page numbering present, 30th medicine present (no truncation); A4 = 595×842 pt; 80 mm = 227 pt wide |
| 05 backup / restore | backup create → validate → restore → reopen → verify data; corrupt and missing backups | **PASS 4/20** — backup creation & validation OK; **restore destroys the data** (defect 3) |
| 06 scale + deep history | 500 patients, 300 visits, 300 chart records, 150 prescriptions, 200 invoices/payments, 120 stock movements; measured timings; deep-history reachability | **18/19 PASS** (1 = defect 6). No artificial caps found: invoices offset 190 reachable, timeline offset 300 reachable, 2024 records reachable |

### Measured performance (Gate 06, real timings, not estimates)

```
   1526.5 ms  create 500 patients               9.8 ms  invoice list (500 invoices)
   1213.5 ms  create 200 invoices+payments       9.4 ms  global search
    424.3 ms  create 120 inventory movements     6.9 ms  invoice list offset 150
    396.0 ms  create 300 visits (deep history)   4.6 ms  Patient 360 timeline page 1
    345.0 ms  create 300 dental chart entries    3.2 ms  Patient 360 timeline LAST page (offset 300)
    290.6 ms  create 150 prescriptions           2.7 ms  patient search across 500 patients
    179.1 ms  full backup of the data set        2.6 ms  visits list, oldest page (offset 250)
     67.5 ms  full integrity check               2.2 ms  revenue report over full range
     18.4 ms  PDF generation (prescription A4)   0.9 ms  patient lifetime summary
```

Design target is 100 000 patients. **NOT VERIFIED — not tested at 100 000**; the largest data set
actually exercised in this gate was 500 patients with 300 visits for one patient. The storage engine
(SQLite with indexes, paged reads, no caps in the query layer) is *design-supported* for that scale;
it is *not* measured.

---

## REGRESSION MATRIX (executed, area by area)

| Area | Result |
|---|---|
| A. Startup | **NOT VERIFIED (runtime)** — Electron binary absent and no display server. Source-level: no dev server, no localhost, no remote origin; CSP `default-src 'self'` |
| B. Clinic setup | PASS — name/address/phone/timezone `Asia/Dhaka`, currency `BDT`/`৳`, 7 payment methods, settings persisted |
| C. Authentication | **FAIL (P0-2)** — login itself works and RBAC/session logic is correct, but no token reaches the renderer. Lock/unlock/expiry/logout verified at service level (6/6) |
| D. RBAC | PASS — 142 privileged channels all require a permission held by ≥1 role; forbidden probes (Receptionist→staff.manage, Assistant→invoice.void, Accountant→visit.create, Receptionist→settings.manage, Assistant→backup.run) all rejected `PERMISSION_DENIED`; permitted probes all allowed |
| E. Patient management | PASS — unique sequential `DP-000001…DP-000100`, duplicate detection advisory (never merges), search by name/code, archive/restore, pagination totals |
| F. Patient 360 | PASS (service layer) — timeline 452 entries for the deep-history patient, last page reachable, 2024 records reachable, lifetime summary correct |
| G. Dental chart | PASS — FDI validation (99 rejected), primary tooth 85 accepted, history retained per tooth (19 entries for tooth 11) |
| H. Visits | PASS — create/update/retrieve/list |
| I. Treatments | **FAIL (P1-1)** — `createTreatment` throws `NOT NULL constraint failed: treatments.active` |
| J. Treatment plans | PASS — plan creation does **not** create an invoice (verified: invoice count unchanged); accept/update/list work |
| K. Prescriptions | PASS — all 6 C/C and 8 O/E labels match the specification exactly (`Pain On`, `G. Carries`, …, `Impected Teeth`, `Dry Socket`, `Attrition / Erosion`), R/E and Advice stored, no financial fields in the prescription document model |
| L. Appointments | **FAIL (P1-2)** — booking, conflicts and status changes work; `reschedule` always throws `ambiguous column name: id` |
| M. Queue | PARTIAL — 60 unique race-safe serials, distinct from Patient Code, duplicate check-in rejected; `queueSummary()` crashes on an empty day (P1-3) |
| N. Billing | PASS — `subtotal − discount + tax = total` re-derived independently for every invoice; partial payment/outstanding correct; overpayment rejected; idempotent retry produced no duplicate payment or receipt |
| O. Payment methods | PASS — Cash, Bank, Card, bKash, Nagad, Rocket, Upay all stored and re-read; unknown method rejected |
| P. Inventory | PASS — SKU/batch/expiry/min-level, purchase/issue/adjustment, quantity recomputed from movements, negative stock rejected |
| Q. Reports | PASS — revenue/payments/outstanding/visits/inventory/audit totals match independent SQL |
| R. Search | PASS — patient, Patient Code, invoice number and clinical text all found; `truncated` flag correct; bound parameters used |
| S. Notifications | PASS — scan creates follow-ups, read state persists, purge works |
| T. Attachments | PASS — traversal-safe storage name, byte-identical read, executable MIME rejected, delete cleans record, missing/orphan detection |
| U. Backup / restore | **FAIL (P0-3)** — see defect 3 |
| V. Documents | PASS with defect 7 (money glyphs) — 17 PDFs generated and parsed |
| W. Printing | **NOT VERIFIED — ENVIRONMENT LIMITATION** (no printer, no CUPS, no Windows spooler) |
| X. Database integrity | PASS — 42 tables (43 SQLite objects incl. `sqlite_sequence`), `PRAGMA integrity_check` ok, 0 FK violations, WAL + `foreign_keys=ON` + `synchronous=FULL`, migration idempotent, transaction rollback verified by the shipped unit tests |
| Y. Concurrency | PARTIAL — race-safe identifier allocation verified at unit level (`allocates sequential Patient Codes race-safely`, unique constraints on Patient Code and queue serial per day); no OS-level multi-process contention test was run |
| Z. Security | PASS (source/static level, see Gate 03) — note that the runtime security properties (sandbox, navigation blocking, CSP enforcement) were **NOT VERIFIED in a running Electron process** |

---

## WINDOWS PACKAGE

| Deliverable | Result |
|---|---|
| NSIS installer | **NOT PRODUCED** |
| Portable EXE | **NOT PRODUCED** |
| ZIP | **NOT PRODUCED** |
| `release/` directory | exists, **0 files, 0 bytes** |

Command executed and its exact outcome:

```
$ npm run dist:win
  • electron-builder version=26.15.3 os=6.1.158+
  • loaded configuration file=electron-builder.yml
  • skipped dependencies rebuild reason=npmRebuild is set to false
  • packaging platform=win32 arch=x64 electron=44.4.5 appOutDir=release/win-unpacked
  ⨯ unable to verify the first certificate  failedTask=build
    RequestError: unable to verify the first certificate (got/dist/source/core/index.js:970)
EXIT=1   duration=33s
```

Root cause (verified, not assumed): electron-builder must download the Electron win32-x64
distribution and its NSIS/winCodeSign tooling from `release-assets.githubusercontent.com`.
That host is unreachable from this sandbox — the TCP connection succeeds and the TLS handshake is
then reset (`SSL_ERROR_SYSCALL` from curl, same from Node's TLS stack → the "certificate" message is
a symptom, not a CA configuration problem; the same request with `-k` also fails). `objects.githubusercontent.com`
returns 000 as well, and the npm proxy does not mirror Electron dist binaries.

**Windows packaging: NOT VERIFIED — ENVIRONMENT LIMITATION.**
Required environment: Windows 10/11 x64 (or Linux with access to the Electron distribution CDN) with
`npm ci` and `npm run dist:win`.

---

## WINDOWS RUNTIME

| Step | Result |
|---|---|
| Install (clean machine) | NOT VERIFIED — ENVIRONMENT LIMITATION (no installer, no Windows) |
| Launch / first run | NOT VERIFIED — ENVIRONMENT LIMITATION (no Electron binary, no display server) |
| Login / patient / clinical / prescription / billing / inventory / reports | NOT VERIFIED as a GUI — ENVIRONMENT LIMITATION. Equivalent logic exercised headlessly against the real services (see TEST SUMMARY) |
| Install / uninstall / reinstall | NOT VERIFIED — ENVIRONMENT LIMITATION |
| Restart persistence | Verified headlessly (rows identical after close/reopen); **NOT VERIFIED as an application restart** |
| Stability (crash/hang/memory) | NOT VERIFIED — ENVIRONMENT LIMITATION |
| Windows filesystem/permissions behaviour | NOT VERIFIED — ENVIRONMENT LIMITATION |
| Offline-first behaviour | Source-verified only (no network calls anywhere in `src/**`, CSP `default-src 'self'`); **NOT VERIFIED at runtime** |

Statements such as "Windows compatible" are deliberately **not** made: no Windows process ever ran
this build.

---

## ARTIFACTS

Only the Linux production bundle exists. It is **not** a Windows release artifact.

| Filename | Size (bytes) | SHA-256 |
|---|---|---|
| `dist/main/index.js` | 517 686 | `574aab011fcb31a2524f58370a7efd2186143f1e6c0b8caede0f24b655769e23` |
| `dist/preload/index.js` | 13 529 | `f85f9047d8ddaba96947486d068f8ba468d388dd1c10c7c9b4a524a378cf9ff1` |
| `dist/renderer/index.html` | 629 | `0c197d2602b418f6517e69c88e77268b4216da2f7b9909938d6d12023d35b68e` |
| `dist/renderer/assets/index-BRaMy8Vv.js` | 86 923 | `898ab5654713cb7e7471a816731b46e355841e458e0df9e3b8664ede62dce491` |
| `dist/renderer/assets/index-C04l9VUY.css` | 14 689 | `7a7ee318cedb188e35c465d764d9f8588913222dc4e97c65268c0b2c995c822d` |
| `dist/renderer/assets/react-C8w-UNLI.js` | 141 736 | `e3433df4feab965bf9eddd674fcf1eab77c0329b3cd1469ba2cbab2498bb9dc3` |

Hashes were produced with `sha256sum` and independently recomputed with Node's `crypto` — the two
calculations agree. `npm run checksums` reports nothing because `release/` is empty.

**Bundle forensics (`dist/**`):** `localhost` 0, `127.0.0.1` 0, `:5173` 0, `ws://` 0,
`sourceMappingURL` 0, `devtools`/`devTools` 0, demo/test-credential strings 0, private keys 0,
`sk_live_`/`AKIA…`/`ghp_…` 0. The 3 `http://` and 1 `https://` hits are inside React's bundled
error-decoder URL and XML namespace constants (third-party library strings, not product network
calls). 4 `console.log` calls remain in `dist/main/index.js` (migration result, SQLite capabilities,
expired sessions, automatic backup) — main process only, no secrets.

---

## SIGNING

**UNSIGNED — NO PRODUCTION CODE-SIGNING CERTIFICATE AVAILABLE.**
No signing was attempted, no certificate exists in this environment, and
`electron-builder.yml` sets `signAndEditExecutable: false`. No signature, chain or timestamp can be
reported. Nothing in this report should be read as a signing claim.

---

## DEFECTS

### P0 — release-blocking

| # | Defect | Evidence |
|---|---|---|
| P0-1 | **A clean installation cannot create its first administrator.** The sign-in screen detects first run by calling `diagnostics:counts`, which is `authRequired: true` + `permission: 'diagnostics.read'` and therefore fails without a session; the fallback path calls `require('electron')` inside a renderer created with `sandbox: true`; the only channel that could help (`firstRun:createAdmin`) is not in the IPC contract, not in `IPC_CHANNEL_META`, and is not exposed by the preload. Net effect: no route exists from a fresh install to a working account. | `defect-proof-firstrun.ts`: `diagnostics:counts` → `UNAUTHENTICATED`; `auth:login` → "username or password is incorrect"; `require('electron')` present in renderer, `sandbox: true`, `firstRun` channels in contract = false. The underlying service call succeeds from the trusted layer, proving the gap is the renderer/main wiring. |
| P0-2 | **No session token is ever handed to the renderer.** `auth:login` returns a `SessionView` with no token; `App.tsx` and `lib/api.ts` read `result.token`/`result.session.token` (both `undefined`); the preload therefore attaches no `_token`, and every authenticated action returns `UNAUTHENTICATED` ("Your session has ended…"). No channel in the contract returns a token. | `defect-proof-token.ts` (5 steps: login keys, renderer value, preload payload, guard result, contract scan), reproduced in gates 02 and 03. |
| P0-3 | **Restore destroys the database.** `restoreBackup()` closes the connection (line 535) and then writes an audit record (line 597) → it always throws `INTERNAL The database connection is closed.` The failure-recovery path then copies the *pre-restore safety copy* — taken with a raw `copyFileSync` of an open WAL database, so the copy holds the schema but none of the committed rows (rows live in the `-wal`, which is stored under a different name and never replayed) — over the live database. Measured result: 25 patients, 1 visit, 1 prescription, 1 invoice, 1 payment, 1 receipt, inventory and the attachment all become **0**; `schema_migrations.applied_at` changes to a timestamp created *after* the restore, proving the schema was re-created on an empty file. Backups themselves are sound (the backup's `database.sqlite` was verified to contain all 25 patients). | `05-backup-restore.ts` (4/20 PASS), `defect-proof-restore.ts` (safety copy: `tables = 0`, `restoreBackup → THREW INTERNAL`), and a direct inspection of the artefacts after the run: `dentiva.sqlite` patients = 0 vs backup patients = 25. |

### P1 — critical

| # | Defect | Evidence |
|---|---|---|
| P1-1 | `TreatmentService.createTreatment` cannot succeed: the INSERT lists 11 columns but binds 8 values, leaving `active`/`created_at`/`updated_at` shifted → `NOT NULL constraint failed: treatments.active`. `updateTreatment` is correct, so no treatment can ever be created but existing ones can be edited. | `02-feature-matrix.ts`, `01-core-workflow.ts`, `probe5.ts` (8-value insert fails with "cannot store TEXT value in INTEGER column treatments.active"). |
| P1-2 | `SchedulingService.reschedule` always fails: `detectConflicts` builds `id <> ?` against a query that LEFT JOINs `chairs`/`rooms`, so SQLite raises `ambiguous column name: id`. | `probe2/probe4`, gates 01/02; a hand-written fully-qualified version of the same query succeeds. |
| P1-3 | `DashboardService.getMetrics()` and `SchedulingService.queueSummary()` crash whenever the underlying tables are empty (`SUM(CASE …)` returns NULL and the row reader requires a number): a brand-new clinic, or the start of a day with nothing checked in, throws instead of showing zeroes. | `defect-proof-dashboard.ts` (`Cannot read "today": the column is NULL`; raw SQL returns `{"overdue": null}` on an empty table), gate 03 fresh-install sweep (39/41). |
| P1-4 | All money amounts in invoice / receipt / statement PDFs render as mojibake. `formatMoney` emits `৳` but every string is drawn with PDFKit's built-in Helvetica, which has no Bengali-taka glyph, and `resources/` contains no font to embed. Extracted text: `Subtotal: Ÿ2\x03\x132Ãƒ\x03\x02ã\x03\x00`; rendered image of `invoice-A4.pdf` shows the same garbage in every amount cell. Prescription PDFs are unaffected (they carry no money). | Gate 04 + pypdf text extraction + a 2.2× PDFium render, `out/pdf/invoice-A4-p1.png`. |

### P2 — major (not release-blocking on their own)

| # | Defect | Evidence |
|---|---|---|
| P2-1 | The repository's own verification commands give false assurance: `integrity-check.mjs` and `document-verification.mjs` print ✅ for checks whose implementation is `fn: () => true` or a hard-coded `status: 'PASS'`; `performance-test.mjs` prints invented latency numbers; `clinic-day-simulation.mjs` and `long-history-test.mjs` print checklists without executing the workflows; `scale-test.mjs` exits 1 with `ERR_MODULE_NOT_FOUND` (Node cannot import `.ts`). | Source of each script + executed output recorded in this gate. |
| P2-2 | `App.tsx` renders placeholder pages for parts of the navigation ("Placeholder pages for remaining sections") while the command palette claims "Every command actually works, no dead commands". | `src/renderer/App.tsx:1314`, `:1892`. |

### P3 — minor

| # | Defect | Evidence |
|---|---|---|
| P3-1 | `firstRun:createAdmin` / `firstRun:check` remain as handlers outside the IPC contract and permission model (dead surface once P0-1 is fixed). | Gate 03 orphan-handler check. |
| P3-2 | Earlier release documents in this repository state a tag/commit pair (`3a2814b`) that the shipped `v1.0.0` tag does not point to; they are superseded by this report. | `git rev-parse v1.0.0^{commit}` = `1ff93dc…`. |

### Severity totals

| Severity | Count |
|---|---|
| P0 | 3 |
| P1 | 4 |
| P2 | 2 |
| P3 | 2 |

The release requirement is P0 = P1 = P2 = 0. **It is not met.**

---

## PROVENANCE

```
tag  v1.0.0
  └─ commit 1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5      (remote branch arena/01a0dd24-dentiva-win-app)
       └─ parent 0953e4965e142834fbec6460d16c883876b87efe  (product-code freeze; only .md added after it)
            └─ working tree (clean) ── npm ci --ignore-scripts (439 pkgs)
                 └─ npm run build  ──>  dist/**  ──>  SHA-256 (6 files, hashes above)
                      └─ npm run dist:win  ──>  FAILED (environment)  ──>  release/ empty  ──>  NO Windows artifacts
```

Every hash in this report belongs to the build produced from `1ff93dc…` in this session. No earlier
hash, build, commit or report is reused. Because no source file changed, the product artifacts remain
identical to the frozen commit; nothing was rebuilt to make a test pass.

---

## LIMITATIONS

1. **Windows packaging** — NOT VERIFIED — ENVIRONMENT LIMITATION (Linux host; Electron distribution CDN unreachable). Needs Windows 10/11 x64 or unrestricted access to `release-assets.githubusercontent.com`.
2. **Windows runtime, installer, uninstall, reinstall, reboot persistence, filesystem/permissions, crash/hang/memory stability, GUI verification (blank screens, dead buttons, dialogs, keyboard focus, DPI)** — NOT VERIFIED — ENVIRONMENT LIMITATION (no Electron binary, no display server, no Windows).
3. **Physical printing (A4 and 80 mm thermal)** — NOT VERIFIED — ENVIRONMENT LIMITATION (no printer hardware, no Windows spooler).
4. **Code signing** — UNSIGNED — NO PRODUCTION CODE-SIGNING CERTIFICATE AVAILABLE.
5. **Scale at the design target of 100 000 patients** — NOT VERIFIED — not tested; 500 patients / 300 visits per patient is what was actually measured. Design-supported, not measured.
6. **The repository's own verification scripts do not verify the product** (see P2-1), so they cannot be cited as evidence of correctness; only `npm test`, `npm run typecheck` and the session-local gate harness produce real results.
7. The independent gate harness lives **outside** the repository (`/home/user/release-gate`) on purpose: the release gate was not allowed to modify the frozen product. Harness sources and their SHA-256 values are listed in `docs/RELEASE_GATE_EVIDENCE.md`.
8. Two initial harness expectations were wrong and were corrected, not hidden: the shipped schema has 42 application tables (43 SQLite objects), not the 38 named in an earlier draft; and `buildStatement` returns `patientName`/`closingMinor` rather than a literal "outstanding" field. Neither is a product defect.

---

## FINAL DECISION

**BLOCKED — 3 P0 defects.**

Dentiva Pro v1.0.0 cannot be released as a commercial Windows product in its frozen state:

1. a clean installation has no way to create its first administrator (P0-1);
2. no session token reaches the renderer, so every authenticated action fails immediately after sign-in (P0-2);
3. the backup-restore feature — the clinic's only data-safety mechanism — destroys the database it is restoring, while reporting an error (P0-3).

In addition, treatment creation, appointment rescheduling, the dashboard/queue on empty data and all
money amounts in financial PDFs are broken (P1), and the repository's own verification scripts report
success without testing anything (P2).

No product code was modified during this gate; the defects are reported exactly as found, with
reproductions. A fix cycle, a full re-test, a rebuild, fresh hashes and a complete re-run of this gate
(including, on a real Windows host, packaging, install/uninstall/reinstall, runtime stability,
printing and signing) are required before any release claim can be made.
