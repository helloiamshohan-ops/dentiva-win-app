# Dentiva Pro — Architecture

## Overview

Dentiva Pro follows a layered architecture with strict separation between shared kernel, domain logic, main process services, and renderer UI.

```
┌─────────────────────────────────────────────────┐
│                   Renderer (React)               │
│  Offline-first, CSP self-only, no localhost      │
│  Premium light theme, semantic design tokens     │
└──────────────────────┬──────────────────────────┘
                       │ IPC via window.dentiva
                       │ (secure preload, structured errors)
┌──────────────────────▼──────────────────────────┐
│              Preload (Isolated)                  │
│  In-memory token only, no Node access            │
│  Preserves structured error wire                 │
└──────────────────────┬──────────────────────────┘
                       │ IPC channels (~110)
                       │ Auth guards per channel
┌──────────────────────▼──────────────────────────┐
│           Main Process (Electron)                │
│  ┌─────────────────────────────────────────┐    │
│  │ Services Layer                          │    │
│  │ patient, financial, scheduling, clinical│    │
│  │ inventory, treatment, staff, search,    │    │
│  │ notification, dashboard, report,        │    │
│  │ attachment, backup, import-export,      │    │
│  │ integrity, settings                     │    │
│  └──────────────────┬──────────────────────┘    │
│  ┌──────────────────▼──────────────────────┐    │
│  │ Security Layer                          │    │
│  │ password (scrypt), auth (sessions),     │    │
│  │ activation (HMAC), audit (append-only)  │    │
│  └──────────────────┬──────────────────────┘    │
│  ┌──────────────────▼──────────────────────┐    │
│  │ Data Layer                              │    │
│  │ sqlite adapter, migrations, repos       │    │
│  │ 38 STRICT tables, CHECK constraints     │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│           Shared Kernel + Domain                 │
│  money, errors, id, permissions, dates          │
│  financial, appointment, queue, dental,         │
│  inventory, patient, prescription               │
└─────────────────────────────────────────────────┘
```

## Shared Kernel (`src/shared/`)

The shared kernel contains code used by both main and renderer, with zero dependencies on Electron or Node.

### money.ts
- Integer minor-unit arithmetic (poisha)
- `toMinorUnits`: string/number → integer minor units with half-up rounding
- `formatMoney`: minor units → display string with grouping
- `apportion`: exact distribution of minor units across ratios
- No floating point in any financial calculation

### errors.ts
- Structured `AppError` with code, details, fieldErrors, entity
- Wire format preserved across IPC: `toWire()` / `fromWire()`
- Secret redaction: keys matching password/secret/token/credential/apiKey/privateKey/accessKey/sk_/pk_/Bearer are replaced with `[redacted]`
- `DUPLICATE_PATIENT` and `APPOINTMENT_CONFLICT` carry structured payloads that survive IPC intact

### id.ts
- Prefixed ULID: time component + 80-bit crypto random
- Patient Code: DP-000001 format, allocated via sequence table
- Document numbers: INV-YYYY-000001, RCP-YYYY-000001
- Prefixes: pat_, vis_, inv_, pay_, rcp_, apt_, que_, ch_, etc.

### permissions.ts
- 52 permissions across 6 roles: Administrator, Dentist, Receptionist, Accountant, Inventory Staff, Assistant
- ROLE_PERMISSIONS matrix defines exact capabilities per role
- `auditPermissionCoverage()` verifies every permission is assigned

### dates.ts
- Asia/Dhaka timezone handling via Intl API
- `dateKey`: YYYY-MM-DD in clinic timezone
- `dayRangeUtc`: converts clinic day to UTC range for queries
- `parseTimeOfDay`, `combineDateAndTime` for appointment scheduling

### ipc-contract.ts
- Inventory of all ~110 IPC channels
- Each channel: permission, authRequired, description
- `ALL_CHANNELS` array for static audit

## Domain Layer (`src/domain/`)

Pure business logic with no I/O, no database, no Electron.

### financial.ts
- Invoice invariant I1: `subtotal - discount + tax = total`
- I2: `outstanding = total - paid + refunded + adjusted`
- I3: Overpayment blocked unless allowed
- Payment validation, statement computation, immutability guards
- All invariants enforced in both domain logic and SQL CHECK constraints

### appointment.ts
- Resource-aware conflict detection: dentist, chair, room
- `BLOCKING_STATUSES`: scheduled, confirmed, checked_in, in_progress
- `intervalsOverlap`: half-open interval [start, end)
- `canTransition`: valid status transitions

### queue.ts
- Race-safe serial via atomic upsert: `queueCounterKey = clinicDay`
- `MAX_SERIALS_PER_DAY = 999`
- Board ordering: by serial number

### dental.ts
- FDI notation: 11-18, 21-28, 31-38, 41-48 (permanent), 51-55, 61-65, 71-75, 81-85 (primary)
- 52 teeth definitions with position, type, dentition
- Tooth states with glyphs (not color-only): healthy, caries, filled, missing, etc.
- `parseToothReferences`: parses "16, 17, 18" and "16-18" ranges

### inventory.ts
- Movement types: purchase, stock_out, adjustment, return, expiry
- `resolveMovement`: converts to signed quantity
- `checkStock`: prevents negative unless allowed
- `recomputeQuantity`: sums signed quantities
- `expiryStatus`: no_expiry, ok, expiring_soon, expired

### patient.ts
- Duplicate scoring: phone 55, dob 25, name similarity up to 20
- `normalizePhone`: Bangladeshi format 017XXXXXXXX
- `rankDuplicates`: sorts by score descending

### prescription.ts
- C/C (chief complaint) and O/E (on examination) catalogues
- Medicine forms: tablet, capsule, syrup, etc.
- FOOD_RELATIONS: before/after/with food
- COMMON_MEDICINES: curated list

## Data Layer (`src/main/db/`)

### sqlite.ts — Adapter
- Wraps `node:sqlite` DatabaseSync (Node 22.13.0+ unflagged)
- `toSqlValue`: normalizes bool→0/1, undefined→null, Date→ISO
- Transactions: BEGIN IMMEDIATE for write isolation, rollbackOnly propagation
- Pragma verification: WAL, foreign_keys ON, synchronous FULL, busy_timeout 8000
- No ORM, no query builder — raw SQL with typed row helpers

### migrate.ts — Migration Runner
- Tracks version via PRAGMA user_version
- Checksum verification: detects modified migrations
- `verifySchema`: checks all 38 tables exist

### migrations/0001-initial-schema.ts
- 38 STRICT tables with CHECK constraints
- Financial I1 enforced in SQL: `CHECK(total_minor = subtotal_minor - discount_minor + tax_minor)`
- Unique constraints: patient_code, queue serial per counter_key
- Sequences table for Patient Code allocation
- Queue counters for daily serial reset

## Security Layer (`src/main/security/`)

### password.ts
- scrypt N=32768 r=8 p=1, 32-byte salt, 64-byte derived key
- `hashPassword`: returns `scrypt$N$r$p$salt$hash`
- `verifyPassword`: constant-time comparison
- `needsRehash`: detects outdated parameters

### auth.ts
- Trusted-process-only sessions: in-memory Map, token never persisted
- Account lockout: MAX_FAILED=5, exponential backoff (1s, 2s, 4s, 8s, 16s)
- Inactivity expiry: 30 minutes
- Permission enforcement point: checks roleCan before service calls

### activation.ts
- Offline activation with HMAC-SHA256 verifier
- Constant-time comparison for HMAC
- `ACTIVATION_ENABLED=false` for v1.0.0 — documented

## Services Layer (`src/main/services/`)

Each service encapsulates business operations with validation, authorization, and audit.

### patient-service.ts
- Validation: name, sex, phone, email, dob
- Advisory duplicate detection: returns DUPLICATE_PATIENT structured error, never auto-merges
- Race-safe Patient Code allocation via UPDATE...RETURNING
- Full-table search: name_normalized, phone_normalized, patientCode, email — no hidden cap
- Archive/restore with reason

### financial-service.ts
- Invoices: idempotency keys prevent double-click duplicates, derived balances recomputed
- Payments: overpayment blocked, partial payments allowed
- Receipts: only after payment persistence, unique numbers
- Refunds/adjustments: linked to invoice, audited
- Statements: deterministic ordering, full ledger vs windowed comparison

### scheduling-service.ts
- Appointment creation with conflict detection inside transaction
- Structured APPOINTMENT_CONFLICT details survive IPC
- Queue serial atomic upsert keyed by clinic day
- Resources: chairs, rooms

### clinical-service.ts
- Visits: transactionally isolated, procedure set replaced only for that visit id
- No auto-invoice: clinical and financial are separate
- Dental chart history via superseded_at
- Prescriptions: zero financial data

### Other Services
- inventory: stock derived from movements, low-stock/expiry alerts
- treatment: catalogue + plans, estimated recomputed, accept workflow
- staff: dentists, staff, users, password reset
- search: global search across 8 kinds, correct ids, explicit routes
- notification: scan followUps, lowStock, expiry, appointments, dedupe_key prevents spam
- dashboard: real SQL metrics, no fake numbers
- report: revenue/payments/outstanding/appointments/visits/inventory/audit/patients
- attachment: safe filename, hash-derived storedName, 25MB limit, ALLOWED_MIMES
- backup: SQLite backup API or VACUUM INTO, attachments copy, manifest with counts+sha256
- import-export: patients with validation, duplicate phone check, transactional
- integrity: schema, pragma, FK violations, duplicate codes, financial invariants, inventory, attachments

## Document Engine (`src/main/documents/`)

### document-model.ts
- Semantic model shared by preview, PDF, and print
- No rendering logic — pure data structure

### document-builder.ts
- Transforms persisted rows to semantic docs
- Same source for all renderings — guarantees consistency

### pdf-generator.ts
- pdfkit engine, no external dependencies
- PAGE_DIMENSIONS: A4, A5, Letter, 80mm thermal
- Layout rules: no clipping, no orphan lines, no split medicine rows
- Clinic header, patient block, medicine table
- Colors from design system

## Renderer (`src/renderer/`)

### Architecture
- React 18 with StrictMode
- Offline-first: static files loaded via file://, no dev server
- CSP: default-src 'self', no external requests
- No localhost, no 127.0.0.1 — all data via window.dentiva IPC
- Premium light theme: semantic design tokens, no hardcoded colors

### App.tsx (1920 lines)
- Full shell: sidebar with RBAC filtering, topbar search, command palette Ctrl+K
- Pages: login, lock, setup, first-run, dashboard, patients, Patient360, appointments, queue, prescriptions, invoices, payments, inventory, treatments, staff, reports, settings, backup, diagnostics, search
- Patient360: tabs overview/timeline/billing/chart with real data
- All forms: validation, duplicate review, conflict handling

### Security
- contextIsolation: true, sandbox: true, nodeIntegration: false
- will-navigate blocked, new-window blocked
- Preload exposes only window.dentiva with in-memory token

## Build System

### Main Process
- esbuild: bundles main + preload, external electron, node:sqlite, pdfkit
- Output: dist/main/index.js, dist/preload/index.js

### Renderer Process
- Vite: builds to dist/renderer/, offline file:// compatible
- Chunk splitting: react vendor chunk

### Packaging
- electron-builder: Windows x64 NSIS + portable + zip
- asar: true, npmRebuild: false
- Icon: resources/icons/icon.ico (256px, distinctive mark)

## Testing Strategy

- **Unit:** Domain logic with no I/O — money, permissions, appointment, patient, dental, inventory, errors, db-schema
- **Integration:** Services with real SQLite in-memory — financial (42 tests), patient
- **Verification gates:** TypeScript, unit, integration, static-audit, smoke, financial, clinical, backup/restore, PDF, security, RBAC, scale, long-history
- **No mocks for database:** Real node:sqlite DatabaseSync in tests
- **Shim for Vite 5:** node:sqlite not in builtinModules, fixed via createRequire

## Environment Limitations

- Windows packaging requires Windows + network access to release-assets.githubusercontent.com (blocked in CI)
- Physical printer, code-signing, GUI rendering cannot be verified in CI
- All documented as NOT VERIFIED — ENVIRONMENT LIMITATION per spec §202
