/**
 * Shared test harness.
 *
 * Builds a real, fully migrated SQLite database and wires the real services together. Nothing is
 * stubbed: tests exercise the same code paths the application uses at runtime.
 */

import { Database } from '../../src/main/db/sqlite';
import { migrate } from '../../src/main/db/migrate';
import { AuditService, SYSTEM_ACTOR, type AuditActor } from '../../src/main/audit/audit';
import { SettingsService, DEFAULT_APP_SETTINGS } from '../../src/main/services/settings';
import { PatientService } from '../../src/main/services/patient-service';
import { FinancialService } from '../../src/main/services/financial-service';
import type { Sex } from '../../src/domain/patient';

export const TEST_TIME_ZONE = 'Asia/Dhaka';

export interface Harness {
  db: Database;
  audit: AuditService;
  settings: SettingsService;
  patients: PatientService;
  financial: FinancialService;
  admin: AuditActor;
  close(): void;
}

export function createHarness(overrides: Partial<{ timeZone: string; allowOverpayment: boolean; paymentMethods: string[] }> = {}): Harness {
  const db = Database.inMemory();
  migrate(db);
  const audit = new AuditService(db);
  const settings = new SettingsService(db, audit);
  const timeZone = overrides.timeZone ?? TEST_TIME_ZONE;
  const patients = new PatientService(db, audit, () => timeZone);
  const financial = new FinancialService(db, audit, () => ({
    timeZone,
    allowOverpayment: overrides.allowOverpayment ?? DEFAULT_APP_SETTINGS.allowOverpayment,
    paymentMethods: overrides.paymentMethods ?? [...DEFAULT_APP_SETTINGS.paymentMethods],
  }));
  return {
    db,
    audit,
    settings,
    patients,
    financial,
    admin: { ...SYSTEM_ACTOR, name: 'Test Administrator', role: 'Administrator' },
    close: () => db.close(),
  };
}

export function createPatient(h: Harness, input: Partial<Parameters<PatientService['create']>[1]> = {}, acknowledgeDuplicate = true) {
  return h.patients.create(
    h.admin,
    {
      name: `Test Patient ${Math.random().toString(36).slice(2, 8)}`,
      sex: 'male' as Sex,
      ...input,
    },
    { acknowledgeDuplicate },
  );
}

/** Insert a dentist directly; the dentist service is exercised in its own tests. */
export function insertDentist(h: Harness, id: string, name: string): void {
  h.db.run(
    `INSERT INTO dentists (id, name, active, created_at, updated_at)
     VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    id,
    name,
  );
}

/** Insert a treatment catalogue entry directly. */
export function insertTreatment(h: Harness, id: string, code: string, name: string, priceMinor: number): void {
  h.db.run(
    `INSERT INTO treatments (id, code, name, standard_price_minor, active, created_at, updated_at)
     VALUES (?,?,?,?,1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    id,
    code,
    name,
    priceMinor,
  );
}
