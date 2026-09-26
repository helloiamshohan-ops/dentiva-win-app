# Dentiva Pro — Dental Clinic Management System

**Version:** 1.0.0  
**Platform:** Windows 10/11 x64 (offline-first)  
**Database:** SQLite via `node:sqlite` (zero native modules)  
**Runtime:** Electron 44.4.5 (Node 24.21.0)

---

## What This Is

Dentiva Pro is a commercial-grade, offline-first dental clinic management system for Windows. It runs entirely on the clinic's computer with no cloud dependency, no internet requirement, and no subscription. All data is stored locally in SQLite.

## Core Principles

1. **Money is exact** — all financial values stored and calculated in minor units (poisha) with half-up rounding. No floating point.
2. **Patient identity is advisory, never destructive** — duplicate detection warns but never auto-merges. Patient Code (DP-000001) is unique and race-safe.
3. **Clinical records are immutable history** — visits are transactionally isolated, dental chart uses superseded_at for history.
4. **Offline-first, no localhost, no dev server** — renderer is static files loaded via file://, CSP self-only, no external requests.
5. **Security by default** — scrypt passwords, constant-time comparison, secret redaction, append-only audit log, restrictive file permissions.

## Quick Start

### Development

```bash
npm install
npm run build        # builds main + renderer
npm test             # runs unit + integration tests
npm run verify       # full verification gate
```

### Production

```bash
npm run build
npm run dist         # builds Windows installer (requires Windows + Electron binary)
```

## Project Structure

```
src/
  shared/            # Shared kernel: money, errors, id, permissions, dates, ipc-contract
  domain/            # Domain logic: financial, appointment, queue, dental, inventory, patient, prescription
  main/              # Electron main process: db, security, services, documents, repositories
  preload/           # Secure preload: window.dentiva API
  renderer/          # React UI: offline-first, no localhost
tests/
  unit/              # Domain and shared kernel tests
  integration/       # Service-level tests with real SQLite
  support/           # Test harness, node:sqlite shim
scripts/             # Build and verification scripts
docs/                # Documentation
resources/icons/     # Application icons
```

## Financial Invariants

- **I1:** `subtotal - discount + tax = total` enforced in SQL CHECK constraint
- **I2:** `outstanding = total - paid + refunded + adjusted` recomputed from child rows
- **I3:** Overpayment blocked unless explicitly allowed
- All derived balances recomputed from persisted child rows — never trusted from input
- Idempotency keys prevent double-click duplicates
- Receipts only issued after payment persistence, with unique numbers

## Patient Code

- Format: `DP-000001` (DP- prefix, 6-digit zero-padded sequence)
- Allocated via `UPDATE sequences RETURNING` inside transaction — race-safe
- Never derived from list position or count
- Searchable via full-text search

## Database

- 38 STRICT tables with CHECK constraints
- WAL mode, foreign_keys ON, synchronous FULL, busy_timeout 8000ms
- BEGIN IMMEDIATE transactions for write isolation
- Migration runner with checksum verification
- Schema verification on startup

## Security

- Passwords: scrypt N=32768 r=8 p=1, constant-time verification
- Sessions: trusted-process-only, in-memory token, never persisted to disk
- Account lockout: 5 failed attempts with exponential backoff
- Activation: offline HMAC with constant-time comparison (disabled for v1.0.0)
- Audit: append-only, secret-redacting, SQL-paged
- File permissions: 0o600 for attachments
- No secrets in source, renderer, preload, docs, tests, or logs

## IPC Contract

~110 channels defined in `src/shared/ipc-contract.ts` with permission, authRequired, and description. Every channel has a static audit in `scripts/static-audit.mjs`.

## Testing

- **Unit:** 14 db-schema tests, money, permissions, appointment, patient, dental, inventory, errors
- **Integration:** 42 financial tests covering zero/decimal/large/multi-line/discount/tax/partial/multiple/refund/adjustment/void
- **Verification gates:** TypeScript, unit, integration, static-audit, smoke, financial, clinical, backup/restore, PDF, security, RBAC, scale, long-history

## Known Environment Limitations

The following cannot be verified in the CI environment and are documented as NOT VERIFIED:

- **Windows packaging:** `release-assets.githubusercontent.com` is blocked (connect fails in 0.03s) — Electron binary undownloadable. Installer build requires Windows with network access.
- **Physical printer:** No printer hardware available
- **Code signing:** No certificate available — documented as unsigned
- **GUI rendering:** No display server — renderer verified via static build and smoke tests

## License

Proprietary — Dentiva Pro. All rights reserved.

## Support

See `USER_GUIDE.md`, `TROUBLESHOOTING.md`, `BACKUP_RESTORE_GUIDE.md`, `SECURITY_NOTES.md`.
