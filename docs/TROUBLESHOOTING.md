# Dentiva Pro — Troubleshooting

## Application Won't Start

### Symptoms
- Double-click icon, nothing happens
- Error dialog on launch
- Splash screen then crash

### Solutions

1. **Check logs:** `%APPDATA%/Dentiva Pro/logs/` — look for error messages
2. **Run as administrator:** Right-click → Run as administrator
3. **Check disk space:** Need at least 500MB free
4. **Reinstall:** Uninstall, then install latest version — data preserved in %APPDATA%
5. **Database corrupted:** Try backup restore — see BACKUP_RESTORE_GUIDE.md
6. **Antivirus blocking:** Add Dentiva Pro to antivirus allowlist

## Database Errors

### "Database is locked" or "SQLITE_BUSY"

- Close other instances of Dentiva Pro
- Wait 10 seconds, retry
- If persists, restart computer
- Check for other processes using dentiva.sqlite (Task Manager → Details)

### "Foreign key constraint failed"

- Data integrity issue — run Diagnostics → Integrity Check
- If integrity check fails, restore from backup
- Report to support with logs

### "CHECK constraint failed: total_minor = subtotal_minor - discount_minor + tax_minor"

- Invoice invariant violation — should never happen via UI
- If via import, check invoice data: subtotal - discount + tax must equal total
- All amounts in minor units (poisha), integer, no floating point

## Login Issues

### "Invalid username or password"

- Check caps lock, check username spelling
- After 5 failed attempts, account locks with backoff — wait 30 seconds, retry
- If forgot password, Administrator can reset: Staff → Users → Reset Password

### "Account locked"

- Wait for backoff period (1s, 2s, 4s, 8s, 16s after each failure)
- Or Administrator can unlock: Staff → Users → Unlock Account
- If Administrator locked, delete `%APPDATA%/Dentiva Pro/dentiva.sqlite` and restore from backup (last resort — loses data since backup)

### "Session expired"

- Login again — sessions expire after 30 minutes inactivity
- Use Lock (Ctrl+L) instead of logout to keep session

## Patient Issues

### "Patient may already be registered" (Duplicate Warning)

- System detected potential duplicate by phone/name/DOB
- Review duplicates shown — if same person, use existing patient
- If different person with same name, click Acknowledge to create anyway
- Duplicate detection is advisory, never auto-merge

### Patient Code not sequential

- Patient Codes allocated race-safely via sequence table — gaps possible if transaction rolls back
- Gaps are normal, not an error — codes never reused
- Never derived from list position

### Patient search not finding patient

- Search searches name, phone, Patient Code, email — check spelling
- Archived patients not shown by default — check "Include archived" filter
- No hidden cap — all matching patients shown with pagination

## Appointment Issues

### "Appointment conflicts with existing"

- Same dentist/chair/room booked at overlapping time
- Details show conflicting appointment — reschedule or choose different resource
- Blocking statuses: scheduled, confirmed, checked_in, in_progress — cancelled/completed don't block

### Queue serial duplicate

- Should never happen — atomic upsert prevents duplicates
- If occurs, report to support — database issue
- Serials reset daily — S-001 each day

## Financial Issues

### Invoice total incorrect

- Check: subtotal = sum of line items (quantity × unit price)
- Total = subtotal - discount + tax — must match exactly
- All amounts in minor units — no floating point
- If still incorrect, run integrity check

### Overpayment blocked

- System blocks payment if amount > outstanding, unless "Allow overpayment" enabled in Settings → Clinic
- Check outstanding amount — may have been paid already
- Partial payments allowed — pay less than outstanding

### Receipt not issued

- Receipts only issued after payment persistence — check payment saved first
- Receipt numbers unique — if duplicate, system returns existing receipt (idempotency)
- Check Payments page — payment may exist without receipt if error during receipt creation

### Statement reconciliation fails

- Statement should have: closing = opening + billed - paid + refunded + adjusted
- If fails, run integrity check — financial invariants may be violated
- Check for manual DB edits — derived balances must be recomputed from child rows

## Inventory Issues

### Stock quantity incorrect

- Quantity = sum of signed movements — derived, never direct edit
- Run `verifyQuantity` — compares current quantity vs movement sum
- If mismatch, check for manual DB edits or failed transactions
- Movements: purchase (+), stock_out (-), adjustment (±delta), return (-), expiry (-)

### Low stock alert not showing

- Check reorder level configured for item
- Alert when quantity ≤ reorder level
- Notifications deduplicated — same alert not shown repeatedly (dedupe_key)

### Expiry alert not showing

- Check expiry date configured for item
- Alert when expired or expiring soon (threshold configurable)
- Threshold: default 60 days before expiry

## Backup & Restore Issues

### Backup fails

- **Disk full:** Free space, need database size × 2 + attachments
- **Permission denied:** Check backup directory writable
- **Database locked:** Close other instances, wait for transactions

### Restore fails

- **Corrupted backup:** SHA-256 mismatch — try older backup
- **Incompatible version:** Backup from newer version — upgrade first
- **Safety copy exists:** Delete or move safety copy, retry
- See BACKUP_RESTORE_GUIDE.md for details

## PDF & Printing Issues

### PDF not generating

- Check logs for pdfkit errors
- Try different page size (A4, A5, Letter, 80mm)
- Check clinic name/address configured — required for header

### PDF clipped or orphaned lines

- Should never happen — layout rules prevent clipping, orphans, split rows
- If occurs, report to support with document type and data
- Try different page size

### Printing not working

- Check printer connected, powered on, has paper
- Try PDF first — if PDF works but print fails, printer issue
- Physical printer not verifiable in all environments — documented as NOT VERIFIED

## Performance Issues

### Slow search

- With 5000 patients, search should be < 500ms
- If slow, check disk health, free space, RAM
- Indexes on name_normalized, phone_normalized, patientCode — should be fast
- Try restart — may be memory leak (report if persists)

### Slow backup

- Backup time proportional to database size + attachments
- 1000 patients ~ 1800ms, 5000 patients ~ 9000ms — normal
- If much slower, check disk health, antivirus scanning backup directory

### Application freezes

- Check Task Manager — high CPU or memory?
- Try lock/unlock (Ctrl+L) — may unblock UI
- If persists, force close, restart, check logs
- Report to support with logs and steps to reproduce

## Update Issues

### Update fails

- Close Dentiva Pro before updating
- Run installer as administrator
- If fails, uninstall old version, install new — data preserved in %APPDATA%
- Always backup before updating

### Data missing after update

- Data stored in %APPDATA%/Dentiva Pro/ — not deleted on uninstall
- Check %APPDATA%/Dentiva Pro/dentiva.sqlite exists
- If not, restore from backup
- If exists but not loading, check logs, run integrity check

## Getting Help

1. **Check logs:** `%APPDATA%/Dentiva Pro/logs/`
2. **Run diagnostics:** Settings → Diagnostics → Run All Checks
3. **Export diagnostics report:** Settings → Diagnostics → Export Report
4. **Contact support:** Include diagnostics report, logs, steps to reproduce, screenshots

### Logs Location

- Windows: `%APPDATA%/Dentiva Pro/logs/`
- File: `dentiva-YYYY-MM-DD.log`
- Contains: errors, warnings, info — no secrets, no PII (redacted)

### Diagnostics

- Settings → Diagnostics
- Checks: schema, pragmas, FK violations, duplicate codes, financial invariants, inventory, attachments
- Run All Checks — shows pass/fail for each
- Export Report — saves to file for support
