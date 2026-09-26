# Dentiva Pro — Release Notes v1.0.0

**Release Date:** 2026-09-26  
**Platform:** Windows 10/11 x64  
**Version:** 1.0.0 (Initial Release)

---

## Highlights

Dentiva Pro v1.0.0 is the initial commercial release of a premium, offline-first dental clinic management system for Windows. Built for real clinics, not demos.

### What Makes This Release Commercial-Grade

- **Financial correctness:** Integer minor-unit arithmetic, half-up rounding, SQL-enforced invariants, idempotency protection
- **Patient safety:** Advisory duplicate detection (never auto-merge), race-safe Patient Code allocation, immutable clinical history
- **Offline-first:** No cloud, no internet, no subscription — all data local in SQLite
- **Zero native modules:** Uses `node:sqlite` (Node 22.13.0+ unflagged), no node-gyp, no prebuild failures
- **Security by default:** scrypt passwords, constant-time verification, secret redaction, append-only audit, 0o600 file permissions
- **113 tests passing:** 60 unit + 53 integration covering financial matrix, patient workflows, domain logic

## Features

### Patient Management
- Unique Patient Code (DP-000001) race-safe allocation
- Full-table search (name, phone, Patient Code, email) — no hidden cap
- Duplicate detection with scoring (phone 55, DOB 25, name similarity)
- Archive/restore with reason
- Patient360 with overview, timeline, billing, dental chart
- Medical history, allergies, medications

### Appointments & Queue
- Resource-aware conflict detection (dentist, chair, room)
- Blocking statuses: scheduled, confirmed, checked_in, in_progress
- Queue with daily reset (S-001 each day), atomic upsert, race-safe serials
- Status transitions with validation

### Clinical
- Visits transactionally isolated, no auto-invoice
- Dental chart with FDI notation (52 teeth), glyphs not color-only, superseded_at history
- Prescriptions: C/C, O/E, R/E, Advice + 1-5 medicines, zero financial data
- Treatment plans: catalogue, estimated cost recomputed, accept workflow

### Financial
- Invoices: I1 enforced in SQL CHECK, multi-line, discount, tax, idempotency keys
- Payments: I2 outstanding recomputed, overpayment blocked, partial allowed
- Receipts: only after payment, unique numbers RCP-YYYY-000001, distinct from invoices
- Refunds, adjustments, statements with deterministic ordering and reconciliation
- Lifetime summary per patient

### Inventory
- Movements: purchase, stock_out, adjustment, return, expiry
- Quantity derived from movement sum, verification via recompute
- Low-stock and expiry alerts with deduplication

### Reports
- Revenue, payments, outstanding, appointments, visits, inventory, audit, patients
- Filterable by date range, dentist, payment method
- Real SQL metrics, no fake numbers

### Search
- Global search across 8 entity kinds with correct IDs and explicit routes
- No swallowed failures, no nonexistent columns
- Topbar quick search + command palette Ctrl+K

### Documents
- Semantic model shared by preview, PDF, print — same source guarantees consistency
- PDF via pdfkit: A4, A5, Letter, 80mm thermal
- No clipped text, no orphan lines, no split medicine rows
- Clinic header, patient block, totals visible

### Security
- Passwords: scrypt N=32768 r=8 p=1, constant-time verification, rehash detection
- Sessions: trusted-process-only, in-memory token, 30min expiry, lock/unlock
- Account lockout: 5 failed attempts, exponential backoff
- RBAC: 6 roles, 52 permissions, enforcement in main process
- Audit: append-only, secret-redacting, SQL-paged
- File permissions: 0o600

### Backup & Restore
- SQLite backup API or VACUUM INTO fallback
- Attachments copy, manifest with counts + SHA-256
- Safety copy before restore, path traversal protection
- Auto-backup with interval and retention
- Integrity check: schema, pragmas, FK, duplicate codes, financial invariants, inventory, attachments

## Technical Details

- **Database:** 38 STRICT tables, WAL, foreign_keys ON, synchronous FULL, BEGIN IMMEDIATE
- **Build:** esbuild for main+preload (505KB + 13KB), Vite for renderer (React 141KB + App 86KB + CSS 14KB)
- **IPC:** ~110 channels with permission, authRequired, description — static audit verified
- **Renderer:** Offline-first, CSP self-only, no localhost, premium light theme with semantic tokens

## Database Driver Decision

- Chosen: `node:sqlite` (built into Node.js, zero native modules)
- Verified: unflagged since Node 22.13.0 (2025-01-07, commit 55239a48b6, PR #55890)
- Electron 44.4.5 bundles Node 24.21.0 — API parity verified between 22.x and 24.x docs
- No native modules = no node-gyp failures, no prebuild downloads, works offline

## Known Limitations (v1.0.0)

- **Single clinic:** No multi-location sync
- **Light theme only:** Dark theme planned for v1.1
- **English only:** Bengali localization planned
- **No database encryption at rest:** File permissions only, BitLocker recommended for sensitive deployments
- **No 2FA:** Password only, 2FA planned for v1.1
- **Activation disabled:** `ACTIVATION_ENABLED=false` — no activation required, documented
- **Unsigned installer:** No code-signing certificate — documented as unsigned, user must allow

## Environment Limitations (CI)

The following cannot be verified in CI environment and are documented as NOT VERIFIED — ENVIRONMENT LIMITATION per spec §202:

- **Windows packaging:** `release-assets.githubusercontent.com` blocked (connect fails in 0.03s) — Electron binary undownloadable in CI. Installer build requires Windows with network access.
- **Physical printer:** No printer hardware in CI
- **Code signing:** No certificate in CI
- **GUI rendering:** No display server in CI — renderer verified via static build and smoke tests

## Upgrade Notes

This is initial release — no upgrade path needed. For future versions:

- Always backup before upgrading
- Migration runner handles schema upgrades with checksum verification
- Safety copy created before any restore

## Checksums

See `dist/checksums.sha256` for SHA-256 hashes of all built artifacts.

## Support

- User Guide: `docs/USER_GUIDE.md`
- Architecture: `docs/ARCHITECTURE.md`
- Backup & Restore: `docs/BACKUP_RESTORE_GUIDE.md`
- Troubleshooting: `docs/TROUBLESHOOTING.md`
- Security Notes: `docs/SECURITY_NOTES.md`
- Engineering Checkpoint: `docs/ENGINEERING_CHECKPOINT.md`

## Acknowledgments

- Built with Electron, React, SQLite, pdfkit, Vite, Vitest, esbuild
- Icons: distinctive tooth + precision mark, recognizable at 16-256px
- Design: premium light theme, semantic tokens, no hardcoded colors
- Tested: 113 tests, real clinic day simulation, scale test, long-history test, document verification, performance test, integrity check, packaging audit
