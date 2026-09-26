# Release Gate Evidence — Dentiva Pro v1.0.0

Raw, command-level evidence for `docs/FINAL_RELEASE_REPORT.md`. Everything below was executed in this
gate against the frozen commit `1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5`. No product source file was
modified.

## 1. Repository / tag / source identity

```
$ git fetch --unshallow --tags origin          -> OK (history was shallow; now complete: 9 commits)
$ git rev-parse v1.0.0^{commit}                -> 1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5
$ git rev-list --parents -1 HEAD               -> 1ff93dc… 0953e4965e142834fbec6460d16c883876b87efe
$ git diff --stat 0953e496 1ff93dc             -> WINDOWS_RELEASE_GATE_REPORT.md | 871 +++++++++
$ git ls-remote origin
   1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5  refs/heads/arena/01a0dd24-dentiva-win-app
   1ff93dc5cd916bba37f66e6c5b1f612ecdd78bb5  refs/tags/v1.0.0
$ gh api repos/…/commits/866c61e1a08dd01cc2585cc1798a04cebd656dac
   -> 422 "No commit found for SHA"
$ git status --porcelain                        -> (empty)
```

## 2. Environment probes

```
Debian GNU/Linux 12 (bookworm) | Linux 6.1.158+ | x86_64 | 2 vCPU @2.60 GHz | RAM 3939 MB | disk 19 GB
node v22.22.3 | npm 10.9.8 | git 2.39.5 | electron declared ^44.4.5 (binary NOT downloaded) | electron-builder ^26.15.3
$DISPLAY empty; no /dev/dri; no wine; no makensis
printer: none (no CUPS) | code-signing certificate: none

reachability:
  200  https://registry.npmjs.org/            0.06 s
  200  https://api.github.com/                0.27 s
  302  https://github.com/electron/electron/releases/download/v44.4.5/SHASUMS256.txt
  000  https://release-assets.githubusercontent.com/    (TLS reset, also with -k)
  000  https://objects.githubusercontent.com/
  000  https://raw.githubusercontent.com/  |  codeload 301 but downloads blocked
```

## 3. Build + artifacts

```
$ npm ci --ignore-scripts            -> exit 0, "added 439 packages ... 5 vulnerabilities (3 moderate, 1 high, 1 critical)"
$ npm audit --omit=dev               -> "found 0 vulnerabilities"
$ npm run typecheck                  -> exit 0 (7 s)
$ npm test                           -> exit 0, 10 files, 113 tests passed (4.5 s)
$ npm run static-audit               -> exit 0, 46 files, 0 issues
$ npm run smoke                      -> exit 0, 10 "checks" (file-existence only)
$ npm run integrity                  -> 20 ✅ printed; every check is `fn: () => true` (no DB opened)
$ npm run docs-verify                -> 20 ✅ printed; every entry is a hard-coded `status: 'PASS'`
$ npm run clinic-day                 -> "Test harness not available as ESM" + hard-coded checklist
$ npm run scale                      -> exit 1 ERR_MODULE_NOT_FOUND
$ npm run verify                     -> exit 0, 5/5 gates PASSED
$ npm run build                      -> exit 0 (3 s)
   dist/main/index.js                   517686
   dist/preload/index.js                 13529
   dist/renderer/index.html                629
   dist/renderer/assets/index-BRaMy8Vv.js 86923
   dist/renderer/assets/index-C04l9VUY.css 14689
   dist/renderer/assets/react-C8w-UNLI.js 141736
$ sha256sum <each file>              -> (see FINAL_RELEASE_REPORT.md table; identical to Node crypto recomputation)
$ npm run dist:win                   -> exit 1 after 33 s
   ⨯ unable to verify the first certificate  failedTask=build   (TLS reset reaching release-assets.githubusercontent.com)
   release/ -> 0 files, 0 bytes
```

Bundle forensics (`dist/**`), counts of matching lines:
`localhost` 0 · `127.0.0.1` 0 · `:5173` 0 · `ws://` 0 · `sourceMappingURL` 0 · `devtools` 0 ·
`DEMO` 0 · "test credential" 0 · `BEGIN RSA` 0 · `sk_live_` 0 · `.map` files 0 · `.ts` files 0.
`http://` 3 and `https://` 1 occur only inside React's bundled error-decoder URL and XML namespace
constants. `console.log` appears 4× in `dist/main/index.js` (migration result, SQLite capabilities,
expired sessions, automatic backup).

## 4. Gate harness (session-local, outside the repository)

The harness imports the product's real services directly (`src/main/**`) and runs them against the
real `node:sqlite` engine. It was deliberately kept out of the repository so the frozen product could
not be modified by the verification itself.

```
cc0ad337259bddb6d989fea1f353c85fd6878cd438069aa46fc31c3172ae1e15  lib.ts
f3b34dc615339bd42a6ff45addf9bd2501d9ec5899e3e0f35c9f866c227afa3b  01-core-workflow.ts
9ae5ba8b70d0c3430f1eca64352ffc21bf259e8ae8036ca5341521eb8517c85a  02-feature-matrix.ts
2291a59e28a86048223a3ecd8235df0dd43e6da0993e3368f3016cd38783f57a  03-security-rbac.ts
2a0959aa7db4d6cc3aca99d84cebf468d58ebaf288f4e575325fe420ca48b081  04-documents.ts
f0d39c63d9ee58eeab1e85a7acd93719b7013e275470b22ec31f4f1fb2f3d4d9  05-backup-restore.ts
f733a73c369a9bc7278653c49cd058f44da2ca6ebc2a052fb2cfc1e252775ebf  06-scale-history.ts
491c98bae6b01c47cfe864176d3f69b33c53c4cc8a05f583e40f3dbe2800d860  defect-proof-token.ts
5bca4dba486e81890927c3f5818b13405fc5aa090c591e9efaf1276aad345916  defect-proof-firstrun.ts
62298933230589f8a5001068261e8aefb1a433fca58efae587349bfabd2de117  defect-proof-dashboard.ts
9b5aeb3be51d9110284a2c494f7f4fb84d269217cf0b2bd3d603e8fc4a00f3bb  defect-proof-restore.ts
599cb7a1aab218a2abcae12b088847831cfb92f244ca3af706c3970e3242849a  probe.ts
c1e0b4cf8706e67168e04c450d09a1aa44d02e652f76da3c278f337081c1a66b  probe2.ts
0cba6298b5636f5d4c113b4e3404e944ed829c474e89293c75cfee40843a11c8  probe3.ts
a9ee4dd2142e0c3296cbe87e3b096d4aed796f48ba0b00dbfc6858a64c876eed  probe4.ts
5bc3c798b5d559a8d9ba89d43568aa5467776902606c0a98a134225c7f23d61a  probe5.ts
d8d9089c34c77cdf788a5adbc7b88a22bb4563da42c351986dd1b88e8f06138d  probe6.ts
```

Key raw outputs (verbatim):

```
defect-proof-token.ts
  1) auth:login IPC data keys : userId, username, displayName, role, permissions, startedAt,
                               lastActivityAt, expiresAt, locked
     result.token              : undefined
     result.session            : undefined
  3) preload payload for patients:list  : {"query":{}}
  4) guard result            : BLOCKED -> Your session has ended. … | code: UNAUTHENTICATED
  5) contract channels containing "token": false

defect-proof-firstrun.ts
  1) fresh database: users = {"n":0}
  2) diagnostics:counts without a session: UNAUTHENTICATED
  3) auth:login on a userless database: The username or password is incorrect.
  4) renderer fallback uses require("electron"): true | window.dentiva has a firstRun method: false
     | BrowserWindow sandbox: true | firstRun channels declared in the IPC contract: false

defect-proof-dashboard.ts
  getMetrics THROWS: Cannot read "today": the column is NULL but a number is required.
  raw SQL result (empty table): {"overdue":null}

defect-proof-restore.ts
  live patients                       : 40
  wal file present before close       : true 3444352 bytes
  tables in the safety copy           : 0
  patients visible in the safety copy : NO patients table at all <-- STALE/EMPTY COPY
  restoreBackup                       : THREW -> INTERNAL The database connection is closed.

05-backup-restore.ts (after a successful backup of 25 patients)
  PASS  backup validates as restorable
  FAIL  backup.restoreBackup completes without error — INTERNAL The database connection is closed.
  FAIL  restored row counts match the backup source
        before={"patients":25,"visits":1,"prescriptions":1,"invoices":1,"payments":1,"receipts":1,
                "items":1,"movements":2,"attachments":1}
        after ={"patients":0,"visits":0,"prescriptions":0,"invoices":0,"payments":0,"receipts":0,
                "items":0,"movements":0,"attachments":0}
  (post-mortem artefact inspection)
    backup source database.sqlite   : 43 tables, 25 patients, migration applied 12:04:21.812Z
    live database after restore     : 43 tables,  0 patients, migration applied 12:04:22.067Z  <-- schema re-created
    safety copy main file           : 4096 bytes with its -wal beside it (never replayed by the rollback)

03-security-rbac.ts
  PASS  trusted layer blocks forbidden role actions (5 probes) — 5/5 PERMISSION_DENIED
  PASS  trusted layer allows permitted role actions (5 probes) — 5/5 allowed
  PASS  session security (bogus / missing / locked / logged-out / expired) — 6 checks
  PASS  preload exposes no channel without a main-process handler — 151 preload, 153 handlers
  FAIL  no main-process handler outside the IPC contract — ["firstRun:createAdmin","firstRun:check"]
  PASS  BrowserWindow hardened — contextIsolation/sandbox/no-nodeIntegration/webSecurity all correct
  PASS  renderer CSP restricts scripts to self

04-documents.ts + pypdf analysis
  17 PDFs generated (prescription / invoice / receipt / statement × A4, A5, Letter, 80 mm + 3-page long prescription)
  PASS  prescription A4 carries clinic, patient code, dentist, every C/C and O/E label, Advice
  PASS  prescription contains NO currency amount
  PASS  long prescription = 3 pages, 5575 chars, page numbering, "Medicine number 30" present
  PASS  A4 = 595×842 pt; 80 mm receipt = 227 pt wide
  FAIL  invoice A4 shows currency symbol — False
        'Subtotal: Ÿ2\x03\x132Ãƒ\x03\x02ã\x03\x00'   'Total: Ÿ2\x03\x132Ã“cRã\x03\x00'
  FAIL  receipt A4 shows payment method + amount — bKash=True, ৳ missing
  (rendered invoice page stored as out/pdf/invoice-A4-p1.png and inspected visually: every amount is garbage)

06-scale-history.ts
  Data set: 500 patients · 300 visits for one patient · 300 chart entries · 150 prescriptions ·
            200 invoices · 200 payments · 20 inventory items · 2.6 MB database
  18/19 checks PASS — deep-history pages at offset 300/250/190 all reachable, pre-2025 records reachable,
  revenue report == SQL total (85 880 800), backup of the full set OK (2 737 302 bytes),
  integrity_check ok, 0 FK violations, no artificial row cap
  FAIL  dashboard metrics load at scale — Cannot read "today": the column is NULL …
  measured timings listed in FINAL_RELEASE_REPORT.md (slowest: create 500 patients 1526 ms)
```

## 5. Cross-check of hashes

Every artifact hash in `FINAL_RELEASE_REPORT.md` was produced twice — once with `sha256sum` and once
with Node's `crypto.createHash('sha256')` — from the same files; both runs agree. `npm run checksums`
reports an empty release directory, which is consistent with `release/` containing 0 files.
