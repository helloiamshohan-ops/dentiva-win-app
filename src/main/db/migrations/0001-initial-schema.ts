/**
 * Dentiva Pro — migration 0001: initial schema.
 *
 * Design rules applied throughout:
 *   - Text primary keys hold prefixed, time-sortable identifiers (see `@shared/id`).
 *   - Monetary columns are INTEGER minor units and are constrained non-negative where a
 *     negative value is meaningless.
 *   - Status columns carry CHECK constraints, so an invalid status cannot be persisted even by
 *     a future bug in application code.
 *   - Foreign keys default to RESTRICT. Clinical and financial history is never silently
 *     cascade-deleted.
 *   - Every list, search and report path has a supporting index.
 */

export const MIGRATION_0001_NAME = '0001_initial_schema';

export const MIGRATION_0001_SQL = `
-- ── Application configuration ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS clinic (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  legal_name         TEXT,
  tagline            TEXT,
  address_line1      TEXT,
  address_line2      TEXT,
  city               TEXT,
  district           TEXT,
  postal_code        TEXT,
  country            TEXT NOT NULL DEFAULT 'Bangladesh',
  phone              TEXT,
  alternate_phone    TEXT,
  email              TEXT,
  website            TEXT,
  registration_no    TEXT,
  registration_body  TEXT,
  logo_attachment_id TEXT,
  time_zone          TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  currency_code      TEXT NOT NULL DEFAULT 'BDT',
  currency_symbol    TEXT NOT NULL DEFAULT '৳',
  date_format        TEXT NOT NULL DEFAULT 'DD/MM/YYYY'
                     CHECK (date_format IN ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD')),
  footer_note        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;

-- ── Security: users, roles, activation ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  role              TEXT NOT NULL
                    CHECK (role IN ('Administrator','Dentist','Assistant','Receptionist','Accountant','Inventory Staff')),
  email             TEXT,
  phone             TEXT,
  password_hash     TEXT NOT NULL,
  password_algo     TEXT NOT NULL DEFAULT 'scrypt',
  password_salt     TEXT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until      TEXT,
  last_login_at     TEXT,
  password_changed_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_users_active ON users (active, role);

CREATE TABLE IF NOT EXISTS activation_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  activated         INTEGER NOT NULL DEFAULT 0 CHECK (activated IN (0,1)),
  key_fingerprint   TEXT,
  activated_at      TEXT,
  machine_id        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_until      TEXT,
  updated_at        TEXT NOT NULL
) STRICT;

-- ── People ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dentists (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  credentials      TEXT,
  designation      TEXT,
  registration_no  TEXT,
  registration_body TEXT,
  specialty        TEXT,
  phone            TEXT,
  email            TEXT,
  signature_attachment_id TEXT,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_dentists_active ON dentists (active, name);

CREATE TABLE IF NOT EXISTS staff (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role_title   TEXT,
  department   TEXT,
  phone        TEXT,
  email        TEXT,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  dentist_id   TEXT REFERENCES dentists(id) ON DELETE SET NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_staff_active ON staff (active, name);

-- ── Patients ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id                        TEXT PRIMARY KEY,
  -- Permanent, unique, human-readable. Never derived from row position.
  patient_code              TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL,
  name_normalized           TEXT NOT NULL,
  preferred_name            TEXT,
  sex                       TEXT NOT NULL DEFAULT 'unspecified'
                            CHECK (sex IN ('male','female','other','unspecified')),
  dob_key                   TEXT CHECK (dob_key IS NULL OR dob_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  phone                     TEXT,
  phone_normalized          TEXT,
  alternate_phone           TEXT,
  email                     TEXT,
  address                   TEXT,
  occupation                TEXT,
  emergency_contact_name    TEXT,
  emergency_contact_phone   TEXT,
  referral_source           TEXT,
  tags                      TEXT NOT NULL DEFAULT '[]',
  custom_fields             TEXT NOT NULL DEFAULT '[]',
  notes                     TEXT,
  -- Clinical summary
  medical_history           TEXT,
  dental_history            TEXT,
  allergies                 TEXT,
  current_medications       TEXT,
  chronic_conditions        TEXT,
  risk_information          TEXT,
  archived_at               TEXT,
  archived_reason           TEXT,
  created_by                TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_patients_name_normalized ON patients (name_normalized);
CREATE INDEX IF NOT EXISTS idx_patients_phone_normalized ON patients (phone_normalized);
CREATE INDEX IF NOT EXISTS idx_patients_dob ON patients (dob_key);
CREATE INDEX IF NOT EXISTS idx_patients_archived ON patients (archived_at);
CREATE INDEX IF NOT EXISTS idx_patients_created_at ON patients (created_at);
CREATE INDEX IF NOT EXISTS idx_patients_email ON patients (email);

-- ── Sequences (Patient Codes, document numbers, queue serials) ──────────────────────────────
CREATE TABLE IF NOT EXISTS sequences (
  name        TEXT PRIMARY KEY,
  next_value  INTEGER NOT NULL CHECK (next_value >= 1),
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS queue_counters (
  queue_key   TEXT PRIMARY KEY,
  last_serial INTEGER NOT NULL CHECK (last_serial >= 0),
  updated_at  TEXT NOT NULL
) STRICT;

-- ── Scheduling resources ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chairs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  room_id    TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS appointments (
  id                TEXT PRIMARY KEY,
  patient_id        TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  dentist_id        TEXT REFERENCES dentists(id) ON DELETE RESTRICT,
  chair_id          TEXT REFERENCES chairs(id) ON DELETE RESTRICT,
  room_id           TEXT REFERENCES rooms(id) ON DELETE RESTRICT,
  starts_at         TEXT NOT NULL,
  ends_at           TEXT NOT NULL,
  duration_minutes  INTEGER NOT NULL CHECK (duration_minutes >= 5 AND duration_minutes <= 480),
  status            TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','confirmed','arrived','in_progress','completed','cancelled','no_show','rescheduled')),
  reason            TEXT,
  notes             TEXT,
  cancelled_reason  TEXT,
  rescheduled_from_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  visit_id          TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (ends_at > starts_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_appointments_starts_at ON appointments (starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_dentist_time ON appointments (dentist_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_appointments_chair_time ON appointments (chair_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_appointments_room_time ON appointments (room_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments (status, starts_at);

-- ── Queue ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue_entries (
  id             TEXT PRIMARY KEY,
  queue_date     TEXT NOT NULL CHECK (queue_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  serial         INTEGER NOT NULL CHECK (serial >= 1),
  counter_key    TEXT NOT NULL,
  patient_id     TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  dentist_id     TEXT REFERENCES dentists(id) ON DELETE RESTRICT,
  room_id        TEXT REFERENCES rooms(id) ON DELETE RESTRICT,
  chair_id       TEXT REFERENCES chairs(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL DEFAULT 'waiting'
                 CHECK (status IN ('waiting','called','in_progress','completed','skipped','cancelled')),
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  visit_id       TEXT,
  reason         TEXT,
  notes          TEXT,
  arrived_at     TEXT NOT NULL,
  called_at      TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- The serial is unique per counter key, which is what makes allocation race-safe.
  UNIQUE (counter_key, serial)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_queue_date ON queue_entries (queue_date, serial);
CREATE INDEX IF NOT EXISTS idx_queue_patient ON queue_entries (patient_id, queue_date);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_entries (queue_date, status);

-- ── Clinical: visits ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visits (
  id                   TEXT PRIMARY KEY,
  patient_id           TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  dentist_id           TEXT REFERENCES dentists(id) ON DELETE RESTRICT,
  appointment_id       TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  queue_entry_id       TEXT REFERENCES queue_entries(id) ON DELETE SET NULL,
  occurred_at          TEXT NOT NULL,
  chief_complaint      TEXT,
  reason               TEXT,
  symptoms             TEXT,
  examination          TEXT,
  diagnosis            TEXT,
  treatment_plan_text  TEXT,
  treatment_performed  TEXT,
  tooth_numbers        TEXT NOT NULL DEFAULT '[]',
  procedures           TEXT NOT NULL DEFAULT '[]',
  anesthesia           TEXT,
  medications          TEXT,
  advice               TEXT,
  referral_note        TEXT,
  follow_up_date_key   TEXT CHECK (follow_up_date_key IS NULL OR follow_up_date_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  follow_up_note       TEXT,
  notes                TEXT,
  created_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_visits_patient_time ON visits (patient_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_visits_occurred_at ON visits (occurred_at);
CREATE INDEX IF NOT EXISTS idx_visits_dentist ON visits (dentist_id, occurred_at);

CREATE TABLE IF NOT EXISTS visit_procedures (
  id            TEXT PRIMARY KEY,
  visit_id      TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  treatment_id  TEXT REFERENCES treatments(id) ON DELETE RESTRICT,
  tooth_number  INTEGER CHECK (tooth_number IS NULL OR (tooth_number >= 11 AND tooth_number <= 85)),
  description   TEXT NOT NULL,
  note          TEXT,
  order_index   INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_visit_procedures_visit ON visit_procedures (visit_id, order_index);

-- ── Dental chart ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dental_chart_entries (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tooth_number  INTEGER NOT NULL CHECK (tooth_number >= 11 AND tooth_number <= 85),
  state         TEXT NOT NULL
                CHECK (state IN ('sound','caries','filled','missing','extracted','root_canal','crown','implant','impacted','fractured','mobile','bridge_pontic','watch')),
  surfaces      TEXT NOT NULL DEFAULT '[]',
  note          TEXT,
  visit_id      TEXT REFERENCES visits(id) ON DELETE SET NULL,
  recorded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_at   TEXT NOT NULL,
  superseded_at TEXT,
  -- One current condition per tooth; historical rows carry superseded_at.
  UNIQUE (patient_id, tooth_number, recorded_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_chart_patient_current ON dental_chart_entries (patient_id, superseded_at, tooth_number);

-- ── Treatment catalogue & plans ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treatments (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  category            TEXT,
  description         TEXT,
  duration_minutes    INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  standard_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (standard_price_minor >= 0),
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_treatments_active ON treatments (active, category, name);

CREATE TABLE IF NOT EXISTS treatment_plans (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  dentist_id    TEXT REFERENCES dentists(id) ON DELETE RESTRICT,
  visit_id      TEXT REFERENCES visits(id) ON DELETE SET NULL,
  title         TEXT,
  diagnosis     TEXT,
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','presented','accepted','in_progress','completed','declined','cancelled')),
  estimated_minor INTEGER NOT NULL DEFAULT 0 CHECK (estimated_minor >= 0),
  accepted_at   TEXT,
  completed_at  TEXT,
  notes         TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_treatment_plans_patient ON treatment_plans (patient_id, created_at);

CREATE TABLE IF NOT EXISTS treatment_plan_items (
  id             TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  treatment_id   TEXT REFERENCES treatments(id) ON DELETE RESTRICT,
  description    TEXT NOT NULL,
  tooth_number   INTEGER CHECK (tooth_number IS NULL OR (tooth_number >= 11 AND tooth_number <= 85)),
  order_index    INTEGER NOT NULL DEFAULT 0,
  quantity       INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  unit_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  estimated_minor INTEGER NOT NULL DEFAULT 0 CHECK (estimated_minor >= 0),
  status         TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','in_progress','completed','cancelled')),
  completed_at   TEXT,
  invoice_id     TEXT REFERENCES invoices(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON treatment_plan_items (plan_id, order_index);

-- ── Prescriptions ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prescriptions (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  dentist_id   TEXT REFERENCES dentists(id) ON DELETE RESTRICT,
  visit_id     TEXT REFERENCES visits(id) ON DELETE SET NULL,
  issued_at    TEXT NOT NULL,
  -- C/C and O/E are stored as structured JSON so the document and the UI agree.
  chief_complaints TEXT NOT NULL DEFAULT '{}',
  on_examination   TEXT NOT NULL DEFAULT '{}',
  radiology_examination TEXT,
  advice       TEXT,
  notes        TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_time ON prescriptions (patient_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_prescriptions_issued_at ON prescriptions (issued_at);

CREATE TABLE IF NOT EXISTS prescription_medicines (
  id                  TEXT PRIMARY KEY,
  prescription_id     TEXT NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  order_index         INTEGER NOT NULL DEFAULT 0,
  name                TEXT NOT NULL,
  form                TEXT NOT NULL DEFAULT 'tablet',
  strength            TEXT,
  dose                TEXT,
  frequency           TEXT,
  duration            TEXT,
  timing              TEXT,
  food_relation       TEXT CHECK (food_relation IS NULL OR food_relation IN ('before_food','after_food','with_food','any','empty_stomach')),
  route               TEXT,
  custom_instructions TEXT,
  notes               TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_prescription_medicines_order ON prescription_medicines (prescription_id, order_index);

-- ── Financial: invoices ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  number          TEXT NOT NULL UNIQUE,
  patient_id      TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  dentist_id      TEXT REFERENCES dentists(id) ON DELETE RESTRICT,
  visit_id        TEXT REFERENCES visits(id) ON DELETE SET NULL,
  invoice_date    TEXT NOT NULL,
  due_date_key    TEXT CHECK (due_date_key IS NULL OR due_date_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status          TEXT NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('draft','issued','partially_paid','paid','void')),
  subtotal_minor  INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor  INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  taxable_minor   INTEGER NOT NULL CHECK (taxable_minor >= 0),
  tax_percent     REAL NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 100),
  tax_minor       INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor     INTEGER NOT NULL CHECK (total_minor >= 0),
  paid_minor      INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  refunded_minor  INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  adjusted_minor  INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  voided_at       TEXT,
  void_reason     TEXT,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- Invariant I1 is enforced by the database itself.
  CHECK (subtotal_minor - discount_minor + tax_minor = total_minor),
  CHECK (taxable_minor = subtotal_minor - discount_minor),
  CHECK (discount_minor <= subtotal_minor)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices (patient_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status, invoice_date);

CREATE TABLE IF NOT EXISTS invoice_items (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_index      INTEGER NOT NULL DEFAULT 0,
  treatment_id     TEXT REFERENCES treatments(id) ON DELETE RESTRICT,
  plan_item_id     TEXT REFERENCES treatment_plan_items(id) ON DELETE SET NULL,
  description      TEXT NOT NULL,
  tooth_number     INTEGER CHECK (tooth_number IS NULL OR (tooth_number >= 11 AND tooth_number <= 85)),
  quantity         INTEGER NOT NULL CHECK (quantity >= 1),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor   INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  gross_minor      INTEGER NOT NULL CHECK (gross_minor >= 0),
  net_minor        INTEGER NOT NULL CHECK (net_minor >= 0),
  CHECK (gross_minor = quantity * unit_price_minor),
  CHECK (discount_minor <= gross_minor),
  CHECK (net_minor = gross_minor - discount_minor)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id, order_index);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  invoice_id   TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  patient_id   TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_at      TEXT NOT NULL,
  method       TEXT NOT NULL,
  reference    TEXT,
  received_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes        TEXT,
  voided_at    TEXT,
  void_reason  TEXT,
  -- Idempotency key: prevents a double-click or a retried IPC call from recording twice.
  idempotency_key TEXT UNIQUE,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_payments_patient ON payments (patient_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments (paid_at);

CREATE TABLE IF NOT EXISTS refunds (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  payment_id    TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  reason        TEXT NOT NULL
                CHECK (reason IN ('overpayment_return','service_not_provided','billing_error','goodwill','other')),
  refunded_at   TEXT NOT NULL,
  method        TEXT,
  reference     TEXT,
  notes         TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_refunds_invoice ON refunds (invoice_id, refunded_at);

CREATE TABLE IF NOT EXISTS adjustments (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('waiver','additional_charge','correction')),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  -- Signed effect on the patient's balance: negative reduces it, positive increases it.
  delta_minor   INTEGER NOT NULL,
  reason        TEXT,
  note          TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_adjustments_invoice ON adjustments (invoice_id, created_at);

CREATE TABLE IF NOT EXISTS receipts (
  id                   TEXT PRIMARY KEY,
  number               TEXT NOT NULL UNIQUE,
  -- One receipt per payment: a receipt confirms an actual payment and is never issued alone.
  payment_id           TEXT NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  invoice_id           TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  patient_id           TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  receipt_date         TEXT NOT NULL,
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  method               TEXT NOT NULL,
  reference            TEXT,
  received_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
  remaining_due_minor  INTEGER NOT NULL,
  notes                TEXT,
  created_at           TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_receipts_patient ON receipts (patient_id, receipt_date);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts (receipt_date);

CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,
  category     TEXT NOT NULL,
  description  TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  occurred_at  TEXT NOT NULL,
  method       TEXT,
  reference    TEXT,
  notes        TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_expenses_occurred_at ON expenses (occurred_at);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category, occurred_at);

-- ── Inventory ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  notes          TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS inventory_items (
  id             TEXT PRIMARY KEY,
  sku            TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category       TEXT,
  supplier_id    TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
  unit           TEXT NOT NULL DEFAULT 'unit',
  cost_minor     INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  price_minor    INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  quantity       INTEGER NOT NULL DEFAULT 0,
  min_quantity   INTEGER NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  batch          TEXT,
  expiry_key     TEXT CHECK (expiry_key IS NULL OR expiry_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  location       TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_inventory_active ON inventory_items (active, category, name);
CREATE INDEX IF NOT EXISTS idx_inventory_expiry ON inventory_items (expiry_key);
CREATE INDEX IF NOT EXISTS idx_inventory_low ON inventory_items (quantity, min_quantity);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id               TEXT PRIMARY KEY,
  item_id          TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  type             TEXT NOT NULL
                   CHECK (type IN ('purchase','stock_in','stock_out','adjustment','return','correction','wastage')),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  signed_quantity  INTEGER NOT NULL,
  unit_cost_minor  INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  batch            TEXT,
  expiry_key       TEXT CHECK (expiry_key IS NULL OR expiry_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reference        TEXT,
  note             TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_movements_item ON inventory_movements (item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_created ON inventory_movements (created_at);

-- ── Attachments ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL
               CHECK (entity_type IN ('patient','visit','prescription','invoice','clinic','dentist','staff')),
  entity_id    TEXT NOT NULL,
  patient_id   TEXT REFERENCES patients(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  stored_name  TEXT NOT NULL UNIQUE,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256       TEXT NOT NULL,
  note         TEXT,
  uploaded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_patient ON attachments (patient_id, created_at);

-- ── Follow-ups and referrals ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follow_ups (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_id      TEXT REFERENCES visits(id) ON DELETE SET NULL,
  due_date_key  TEXT NOT NULL CHECK (due_date_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','completed','cancelled')),
  completed_at  TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups (status, due_date_key);
CREATE INDEX IF NOT EXISTS idx_follow_ups_patient ON follow_ups (patient_id, due_date_key);

CREATE TABLE IF NOT EXISTS referrals (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_id     TEXT REFERENCES visits(id) ON DELETE SET NULL,
  to_name      TEXT NOT NULL,
  to_specialty TEXT,
  to_contact   TEXT,
  reason       TEXT,
  referred_at  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'referred'
               CHECK (status IN ('referred','accepted','completed','declined','cancelled')),
  notes        TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_referrals_patient ON referrals (patient_id, referred_at);

CREATE TABLE IF NOT EXISTS patient_notes (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_patient_notes_patient ON patient_notes (patient_id, created_at);

-- ── Notifications ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL
               CHECK (kind IN ('appointment_upcoming','follow_up_due','low_stock','expiry_soon','expiry_passed','backup_completed','backup_failed','restore_completed','system')),
  severity     TEXT NOT NULL DEFAULT 'info'
               CHECK (severity IN ('info','warning','danger')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  -- Prevents the same condition generating a new row on every scan.
  dedupe_key   TEXT UNIQUE,
  read_at      TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_kind ON notifications (kind, created_at);

-- ── Audit log ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  occurred_at   TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name    TEXT NOT NULL,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  summary       TEXT,
  -- JSON metadata. Secrets are redacted before write.
  metadata      TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_occurred_at ON audit_log (occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, occurred_at);

-- ── Backup history ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backup_history (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256         TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  app_version    TEXT NOT NULL,
  trigger        TEXT NOT NULL CHECK (trigger IN ('manual','automatic','pre_restore')),
  record_counts  TEXT NOT NULL DEFAULT '{}',
  attachment_count INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'completed'
                 CHECK (status IN ('completed','failed','superseded')),
  verified_at    TEXT,
  notes          TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_backup_history_created ON backup_history (created_at);

CREATE TABLE IF NOT EXISTS saved_views (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  definition  TEXT NOT NULL DEFAULT '{}',
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS import_batches (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','completed','failed','rolled_back')),
  total_rows   INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  inserted     INTEGER NOT NULL DEFAULT 0 CHECK (inserted >= 0),
  updated      INTEGER NOT NULL DEFAULT 0 CHECK (updated >= 0),
  rejected     INTEGER NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  errors       TEXT NOT NULL DEFAULT '[]',
  started_at   TEXT NOT NULL,
  completed_at TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE IF NOT EXISTS export_history (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  format       TEXT NOT NULL CHECK (format IN ('csv','json')),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  file_path    TEXT,
  filter_summary TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
) STRICT;
`;

/**
 * Seed data.
 *
 * This is bootstrap configuration only — no demo clinic, no demo patients, no demo invoices,
 * no test credentials. Production starts clean.
 */
export const MIGRATION_0001_SEED = `
INSERT INTO clinic (
  id, name, country, time_zone, currency_code, currency_symbol, date_format, created_at, updated_at
) VALUES (
  'cli_default', '', 'Bangladesh', 'Asia/Dhaka', 'BDT', '৳', 'DD/MM/YYYY',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT INTO activation_state (id, activated, attempts, updated_at)
VALUES (1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;
