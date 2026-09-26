# Dentiva Pro — User Guide

## Getting Started

### First Launch

1. **Install** Dentiva Pro using the Windows installer
2. **Launch** from Start Menu or Desktop shortcut
3. **First Run Setup:**
   - Enter clinic name, address, phone, email
   - Set timezone (default: Asia/Dhaka)
   - Set currency (default: BDT ৳)
   - Create Administrator account (username + password)
   - This account has full access to all features

### Login

- Enter username and password
- After 5 failed attempts, account locks with exponential backoff
- Sessions expire after 30 minutes of inactivity
- Use Lock (Ctrl+L) to lock without logging out

## Patient Management

### Creating a Patient

1. Go to **Patients** → **New Patient**
2. Enter:
   - **Name** (required, 2-120 chars)
   - **Sex** (required: male/female/other)
   - **Phone** (optional, Bangladeshi format 017XXXXXXXX)
   - **Email** (optional)
   - **Date of Birth** (optional, must not be future)
   - **Address** (optional)
   - **Medical History, Allergies, Current Medications** (optional)
3. Click **Create**
4. System assigns unique **Patient Code** (DP-000001 format)
5. If potential duplicate detected (same phone/name/DOB), review duplicates and either:
   - **Acknowledge** to create anyway, or
   - **Cancel** and use existing patient

### Patient Code

- Format: DP-000001, DP-000002, etc.
- Unique, never reused, race-safe
- Searchable — type DP-000001 in search to find patient
- Never derived from list position

### Patient360

Click any patient to open Patient360 with tabs:

- **Overview:** Demographics, medical history, lifetime summary (visits, billed, paid, outstanding)
- **Timeline:** All visits, appointments, prescriptions, invoices, payments in chronological order
- **Billing:** Invoices, payments, receipts, statement with opening/closing balance
- **Chart:** Dental chart history with FDI notation

### Searching Patients

- Type in search box: searches name, phone, Patient Code, email
- No hidden cap — all matching patients shown with pagination
- Global search (Ctrl+K): searches across patients, appointments, invoices, etc.

## Appointments

### Booking

1. Go to **Appointments** → **New Appointment**
2. Select patient, dentist, date, time, duration
3. Optionally assign chair and room
4. System checks for conflicts (same dentist/chair/room at overlapping times)
5. If conflict, shows conflicting appointment details — reschedule or choose different resource

### Statuses

- **Scheduled:** Initial booking
- **Confirmed:** Patient confirmed
- **Checked In:** Patient arrived, added to queue
- **In Progress:** Currently with dentist
- **Completed:** Finished
- **Cancelled:** Cancelled with reason
- **No Show:** Patient did not arrive

### Queue

- Go to **Queue** to see today's checked-in patients
- Serials: S-001, S-002, etc., reset daily
- Board ordering: by serial number
- Race-safe: atomic upsert prevents duplicate serials

## Clinical Workflows

### Visits

1. Go to patient → **New Visit** or from Queue → **Start Visit**
2. Enter:
   - **Chief Complaint (C/C)**
   - **On Examination (O/E)**
   - **Diagnosis**
   - **Procedures** (from treatment catalogue)
   - **Dental Chart** entries (FDI notation, tooth states)
   - **Notes**
3. Visits are transactionally isolated — no auto-invoice
4. Each visit is immutable history

### Dental Chart

- Uses FDI notation: 11-18, 21-28, 31-38, 41-48 (permanent), 51-85 (primary)
- Tooth states with glyphs (not color-only):
  - Healthy, Caries, Filled, Missing, Crown, Implant, etc.
- History preserved via superseded_at — old entries remain
- Parse tooth references: "16, 17, 18" or "16-18" ranges

### Prescriptions

1. Go to patient → **New Prescription** or from Visit → **Add Prescription**
2. Enter:
   - **C/C, O/E, R/E, Advice** (optional)
   - **Medicines:** 1-5 medicines with name, form, strength, dosage, duration, food relation, notes
3. Prescriptions have zero financial data — billing is separate
4. Preview, PDF (A4), Print

### Treatment Plans

1. Go to patient → **New Treatment Plan**
2. Add procedures with estimated cost
3. Workflow: Draft → Proposed → Accepted/Rejected
4. Estimated total recomputed from procedures
5. Does not auto-create invoice — create invoice separately when treatment performed

## Financial Workflows

### Invoices

1. Go to **Invoices** → **New Invoice** or from Patient → **New Invoice**
2. Add line items: description, quantity, unit price
3. Apply discount and tax (percentage or fixed)
4. System enforces: `subtotal - discount + tax = total` (I1)
5. Idempotency key prevents double-click duplicates
6. Preview, PDF (A4/A5), Print

### Payments

1. Go to invoice → **Record Payment** or **Payments** → **New Payment**
2. Enter amount, method (cash, card, mobile banking, etc.), date, notes
3. System checks: no overpayment unless allowed
4. Partial payments allowed — outstanding = total - paid + refunded + adjusted (I2)
5. Derived balances recomputed from child rows — never trusted from input

### Receipts

- Only issued after payment persistence
- Unique receipt numbers: RCP-YYYY-000001 format
- Distinct from invoices — receipt proves payment, invoice proves billing
- Preview, PDF (A4/80mm thermal), Print

### Refunds & Adjustments

- **Refund:** Returns money to patient, linked to invoice
- **Adjustment:** Corrects invoice (e.g., discount applied late), can be positive or negative
- Both audited, both affect outstanding

### Statements

- Go to patient → **Billing** → **Statement**
- Shows opening balance, transactions in date range, closing balance
- Deterministic ordering — same statement always same
- Reconciliation: closing = opening + billed - paid + refunded + adjusted

## Inventory

### Stock Management

- Go to **Inventory**
- **Movements:**
  - **Purchase:** Adds stock (inbound)
  - **Stock Out:** Removes stock (outbound, e.g., used in procedure)
  - **Adjustment:** Corrects stock (signed delta)
  - **Return:** Returns to supplier
  - **Expiry:** Removes expired stock
- Stock quantity = sum of signed movement quantities — derived, never direct edit
- Verification: `verifyQuantity` checks against movement history

### Alerts

- **Low Stock:** Quantity ≤ reorder level
- **Expiry:** Expired or expiring soon (configurable threshold)
- Notifications deduplicated via dedupe_key — no spam

## Reports

Go to **Reports** and select:

- **Revenue:** By date range, dentist, payment method
- **Payments:** By date, method, status
- **Outstanding:** Patients with unpaid balances
- **Appointments:** By date, dentist, status
- **Visits:** By date, dentist, procedure
- **Inventory:** Stock levels, movements, low-stock, expiry
- **Audit:** All actions with filtering
- **Patients:** Demographics, registration trends

All reports filterable by date range, exportable.

## Settings

### Clinic

- Name, address, phone, email, logo
- Timezone (Asia/Dhaka default)
- Currency (BDT ৳ default)
- Date format, time format
- Financial: allow overpayment, default tax rate, etc.

### Preferences

- Theme (light only in v1.0.0)
- Language (English only in v1.0.0)
- Date/currency display

### Payment Methods

- Configure payment methods: Cash, Card, bKash, Nagad, etc.
- Active/inactive toggle

### Backup

- **Manual Backup:** Creates backup now with manifest (counts + SHA-256)
- **Auto Backup:** Configurable interval, retention
- **Restore:** From backup file with safety copy before restore
- **History:** List of backups with date, size, verification

## Search

- **Topbar Search:** Quick patient search
- **Command Palette (Ctrl+K):** Global search across 8 entity types
- **Search Page:** Full search with filters, navigates to correct destination
- No swallowed failures — errors shown
- No nonexistent columns — verified against schema

## Keyboard Shortcuts

- **Ctrl+K:** Command palette / Global search
- **Ctrl+L:** Lock application
- **Ctrl+N:** New patient (from Patients page)
- **Esc:** Close dialog

## Roles & Permissions

- **Administrator:** All permissions
- **Dentist:** Clinical, patients, appointments, prescriptions, treatment plans, dental chart
- **Receptionist:** Patients, appointments, queue, invoices, payments, receipts
- **Accountant:** Financial reports, invoices, payments, receipts, statements
- **Inventory Staff:** Inventory only
- **Assistant:** Patients, appointments, queue, clinical assistance

Each action checks permission — unauthorized actions blocked with clear error.

## Tips

- **Patient Code** is the most reliable identifier — use it for search
- **Duplicate warning** is advisory — if same person with same phone, acknowledge; if different person with same name, create new
- **Appointments:** Always check for conflicts — system prevents double-booking same dentist/chair/room
- **Queue:** Serials reset daily — S-001 each day
- **Financial:** Always verify totals before saving — subtotal, discount, tax, total must match
- **Backup:** Run manual backup before major operations, enable auto-backup for safety
- **Integrity:** Run diagnostics periodically to verify database consistency
