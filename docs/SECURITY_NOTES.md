# Dentiva Pro — Security Notes

## Threat Model

Dentiva Pro is an offline-first desktop application for a single clinic. Threats considered:

- **Unauthorized access:** Other users on same machine, stolen laptop, shoulder surfing
- **Data tampering:** Malicious modification of financial records, patient data
- **Data theft:** Copying database, attachments, backups
- **Injection:** SQL injection, XSS, prototype pollution
- **Secret leakage:** Passwords, tokens, keys in logs, source, or renderer

Out of scope for v1.0.0 (documented limitations):

- **Network attacks:** No network, no cloud, no internet — offline-first
- **Physical disk theft:** Requires BitLocker or similar — file permissions only
- **Malware on machine:** If OS compromised, application cannot protect data
- **Insider with admin access:** Administrator role has full access by design

## Authentication

### Password Hashing

- Algorithm: scrypt N=32768 r=8 p=1, 32-byte salt, 64-byte derived key
- Format: `scrypt$32768$8$1$salt$hash`
- Salt: 32 random bytes, base64 encoded
- Verification: constant-time comparison (timing-safe)
- Rehash: `needsRehash` detects outdated parameters, rehashes on login

### Sessions

- **Trusted-process-only:** Sessions stored in-memory Map, never persisted to disk
- Token: 32 random bytes, base64url, in-memory only
- Preload holds token in-memory, never writes to disk, never exposes to renderer via global
- Expiry: 30 minutes inactivity, swept every minute
- Lock: User can lock (Ctrl+L) without logging out — requires password to unlock

### Account Lockout

- MAX_FAILED = 5 failed login attempts
- Exponential backoff: 1s, 2s, 4s, 8s, 16s after each failure
- Lockout resets on successful login
- Prevents brute-force

### Activation

- Offline activation with HMAC-SHA256 verifier
- Constant-time comparison for HMAC (prevents timing attacks)
- `ACTIVATION_ENABLED=false` for v1.0.0 — no activation required, documented
- No production secret in source, renderer, preload, docs, tests, fixtures, logs

## Authorization

### RBAC

- 6 roles: Administrator, Dentist, Receptionist, Accountant, Inventory Staff, Assistant
- 52 permissions: patient.read, patient.create, invoice.create, etc.
- ROLE_PERMISSIONS matrix defines exact capabilities per role
- Every IPC channel has permission + authRequired in contract
- Main process enforces: `auth.requirePermission(role, permission)` before service calls
- Renderer filters UI by role — sidebar, buttons, pages hidden if no permission
- But enforcement is in main — renderer hiding is UX, not security

### Audit

- Append-only: no update, no delete, only insert
- Secret-redacting: keys matching password/secret/token/credential/apiKey/privateKey/accessKey/sk_/pk_/Bearer replaced with `[redacted]`
- Actions: canonical names (PATIENT_CREATED, INVOICE_CREATED, etc.)
- Query: SQL-paged, filterable by date, user, action, entity
- No audit log modification via UI — only via direct DB access (requires file access)

## Data Protection

### File Permissions

- Database: 0o600 (owner read/write only)
- Attachments: 0o600
- Backups: 0o600
- Prevents other users on same machine from reading clinic data
- On Windows, ACLs used — equivalent to owner-only

### No Secrets in Bundles

- Static audit scans for private keys, API keys, secrets in bundles
- No `BEGIN PRIVATE KEY`, no `sk_live_`, no `AKIA...` in dist/
- Verified in packaging-audit.mjs

### Input Validation

- All inputs validated via zod schemas in services
- Patient: name 2-120 chars, sex enum, phone Bangladeshi format, email format, dob not future
- Financial: amounts integer minor units, quantities positive integer, percentages 0-100
- Appointment: start < end, duration positive, date not too far past/future
- Inventory: quantity non-negative unless allowed, movement type enum
- Search: no SQL injection — parameterized queries, safeSort allowlist

### SQL Injection Prevention

- All queries parameterized — no string concatenation
- `inClause` helper: generates `?, ?, ?` placeholders, values array
- `safeSort`: allowlist of sortable columns, direction enum
- No raw user input in SQL

### XSS Prevention

- React escapes by default — no dangerouslySetInnerHTML
- CSP: default-src 'self', no external scripts
- No eval, no new Function, no innerHTML with user data
- Preload: no Node access, contextIsolation true, sandbox true

### Prototype Pollution Prevention

- No `__proto__`, no `constructor`, no `prototype` in user data
- Object.assign with validated schemas only
- No recursive merge of user data
- Fixed: removed Object.prototype defineProperty hack in scheduling-service

## Electron Security

### Window Configuration

- `contextIsolation: true` — renderer cannot access Node
- `sandbox: true` — renderer sandboxed
- `nodeIntegration: false` — no Node in renderer
- `webSecurity: true` — same-origin policy enforced
- `allowRunningInsecureContent: false`
- `experimentalFeatures: false`

### Navigation

- `will-navigate` blocked — no navigation to external URLs
- `new-window` blocked — no popups
- `will-attach-webview` blocked — no webviews
- Only file:// URLs allowed for renderer

### Preload

- Exposes only `window.dentiva` with typed methods
- In-memory token only — never writes to disk
- No Node, no fs, no child_process, no require
- Preserves structured error wire — AppError survives IPC intact

## Financial Integrity

### Invariants Enforced in SQL

- I1: `CHECK(total_minor = subtotal_minor - discount_minor + tax_minor)` — subtotal - discount + tax = total
- Prevents invalid invoices at database level, not just application

### Derived Balances

- Paid amount = sum of payments — recomputed from child rows, never trusted from input
- Outstanding = total - paid + refunded + adjusted — recomputed
- Prevents tampering via direct DB edit of derived fields

### Idempotency

- Invoices, payments, receipts have idempotency_key unique constraint
- Double-click, retry, network glitch — same key returns existing record, no duplicate
- Keys: client-generated UUID, stored and checked

### Immutability

- Invoices: no edit after creation — only void via adjustment
- Payments: no edit — only refund
- Receipts: no edit — immutable proof of payment
- Visits: no edit of past visits — only new visits

## Backup Security

- Path traversal protection: no `../`, no absolute paths outside allowed dirs
- Filename sanitization: no path separators in attachment names
- Hash-derived storedName: no user-controlled file paths
- SHA-256 manifest: detects corruption, tampering
- Safety copy before restore: preserves current data if restore fails

## Logging

- No secrets in logs — password, token, key redacted
- No patient PII in logs unless necessary — and then redacted in production
- Logs: `%APPDATA%/Dentiva Pro/logs/`, rotated, 0o600 permissions

## Dependencies

- Zero native modules — no node-gyp, no prebuild
- `node:sqlite` built into Node — no external dependency
- pdfkit: pure JS, no native
- Electron: pinned version 44.4.5, verified via DEPS API
- All dependencies audited via `npm audit` — no high/critical vulnerabilities

## Reporting Vulnerabilities

If you find a security issue:

1. Do not disclose publicly
2. Email: security@dentiva.example (placeholder — configure in production)
3. Include: description, steps to reproduce, impact, suggested fix
4. We will respond within 48 hours, fix within 30 days for critical issues

## Security Checklist for Deployment

- [ ] Enable Windows BitLocker for full-disk encryption
- [ ] Set strong Administrator password (12+ chars, mixed case, numbers, symbols)
- [ ] Create individual user accounts — no shared passwords
- [ ] Enable auto-backup daily
- [ ] Copy backups to external encrypted drive
- [ ] Restrict physical access to clinic computer
- [ ] Keep Dentiva Pro updated — check for security patches
- [ ] Review audit log weekly for suspicious actions
- [ ] Run integrity check monthly
- [ ] Train staff on password security, lock when away (Ctrl+L)

## Future Enhancements

- Database encryption at rest (SQLCipher or similar)
- 2FA for Administrator role
- Biometric login (Windows Hello)
- Encrypted backups with password
- Network sync with E2E encryption (for multi-location clinics)
