# Dentiva Pro — Backup & Restore Guide

## Overview

Dentiva Pro stores all data locally in SQLite (`dentiva.sqlite`) plus attachments (images, reports). Backups include both database and attachments with integrity verification.

## Backup Locations

- **Database:** `%APPDATA%/Dentiva Pro/dentiva.sqlite` (Windows)
- **Attachments:** `%APPDATA%/Dentiva Pro/attachments/`
- **Backups:** `%APPDATA%/Dentiva Pro/backups/` (default, configurable)
- **Logs:** `%APPDATA%/Dentiva Pro/logs/`

## Manual Backup

1. Go to **Settings** → **Backup**
2. Click **Create Backup Now**
3. System:
   - Uses SQLite backup API (or VACUUM INTO as fallback)
   - Copies attachments directory
   - Creates manifest with:
     - Timestamp
     - Table counts (patients, invoices, etc.)
     - SHA-256 hash of database file
     - Attachment count and total size
   - Saves as `dentiva-backup-YYYY-MM-DD-HHMMSS.dentivabak`
4. Backup appears in **Backup History** with verification status

## Auto Backup

1. Go to **Settings** → **Backup**
2. Enable **Auto Backup**
3. Configure:
   - **Interval:** Hourly, Daily, Weekly (default: Daily)
   - **Retention:** Number of backups to keep (default: 30)
   - **Location:** Backup directory (default: `%APPDATA%/Dentiva Pro/backups/`)
4. System creates backups automatically in background
5. Old backups pruned based on retention

## Backup Manifest

Each backup includes `manifest.json`:

```json
{
  "version": "1.0.0",
  "timestamp": "2026-09-26T05:00:00.000Z",
  "database": {
    "sha256": "abc123...",
    "size": 1048576,
    "tables": {
      "patients": 150,
      "invoices": 300,
      "payments": 450
    }
  },
  "attachments": {
    "count": 25,
    "totalSize": 5242880,
    "sha256": "def456..."
  }
}
```

## Restore

### From Backup File

1. Go to **Settings** → **Backup**
2. Click **Restore from Backup**
3. Select backup file (`.dentivabak`)
4. System:
   - Creates safety copy of current database (`dentiva.sqlite.safety-YYYY-MM-DD-HHMMSS`)
   - Verifies backup integrity (SHA-256, manifest)
   - Restores database via SQLite restore
   - Restores attachments
   - Verifies restored data (counts, checksums)
   - Shows result: success or error with details
5. **Restart application** after restore

### Safety Copy

Before any restore, system creates safety copy:

- Location: Same directory as database
- Name: `dentiva.sqlite.safety-YYYY-MM-DD-HHMMSS`
- Contains current database before restore
- If restore fails, safety copy preserved for manual recovery
- Delete safety copies manually after verifying restore

### Path Traversal Protection

- Backup file paths validated — no `../` or absolute paths outside allowed directories
- Attachment filenames sanitized — no path separators
- Stored names hash-derived — no user-controlled paths

## Verification

### Backup Verification

- SHA-256 hash of database file computed and stored in manifest
- On restore, hash recomputed and compared
- Mismatch = corrupted backup, restore blocked

### Integrity Check

After restore, run **Diagnostics** → **Integrity Check**:

- Schema version
- 38 tables exist
- Pragmas: WAL, foreign_keys ON, synchronous FULL
- FK violations: none
- Patient Code uniqueness
- Financial invariants I1, I2
- Inventory quantities
- Attachments existence

## Best Practices

1. **Regular Backups:** Enable auto-backup daily, plus manual before major operations
2. **Off-Device Copy:** Copy backup files to external drive or cloud storage (manual)
3. **Test Restore:** Periodically test restore on separate machine to verify backups work
4. **Retention:** Keep at least 7 daily backups, 4 weekly, 12 monthly (configure in settings)
5. **Before Upgrade:** Always backup before upgrading Dentiva Pro
6. **Multiple Locations:** Store backups in at least 2 locations (local + external)

## Troubleshooting

### Backup Fails

- **Disk full:** Free space, check backup location has enough space (database size × 2 + attachments)
- **Permission denied:** Check backup directory writable, run as administrator if needed
- **Database locked:** Close other instances, wait for transactions to complete

### Restore Fails

- **Corrupted backup:** SHA-256 mismatch — try older backup, check disk health
- **Incompatible version:** Backup from newer version — upgrade Dentiva Pro first
- **Safety copy exists:** Previous restore left safety copy — delete or move it, then retry
- **Attachments missing:** Backup incomplete — check manifest, try different backup

### Data Loss

- **No backup:** If no backup exists and database corrupted, data may be unrecoverable — always enable auto-backup
- **Partial backup:** If backup interrupted, may be incomplete — verify manifest before restore
- **Safety copy:** If restore fails, safety copy contains pre-restore data — copy it back manually

## Emergency Recovery

If application won't start and no backup:

1. Locate database file: `%APPDATA%/Dentiva Pro/dentiva.sqlite`
2. Copy it to safe location
3. Try opening with SQLite browser (DB Browser for SQLite)
4. If corrupted, try `.recover` command in sqlite3 CLI
5. Contact support with logs: `%APPDATA%/Dentiva Pro/logs/`

## File Permissions

- Database file: 0o600 (owner read/write only)
- Attachment files: 0o600
- Backup files: 0o600
- Prevents other users on same machine from reading clinic data

## Encryption (Future)

v1.0.0 does not encrypt database at rest — file permissions protect against other users, but not against disk theft. For sensitive deployments:

- Use Windows BitLocker for full-disk encryption
- Store backups in encrypted location
- Future version may add database encryption

## Support

If backup/restore fails and you need help:

1. Check logs: `%APPDATA%/Dentiva Pro/logs/`
2. Run diagnostics: **Settings** → **Diagnostics**
3. Export diagnostics report
4. Contact support with report and manifest
