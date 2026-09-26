import { describe, expect, it } from 'vitest';
import { Database } from '../../src/main/db/sqlite';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, REQUIRED_TABLES, migrate, verifySchema, checksumOf } from '../../src/main/db/migrate';

describe('database schema and migration runner', () => {
  it('applies the initial schema to a fresh database', () => {
    const db = Database.inMemory();
    try {
      const result = migrate(db);
      expect(result.fresh).toBe(true);
      expect(result.applied).toEqual([1]);
      expect(result.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('creates every required table', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      const existing = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r.name)));
      const missing = REQUIRED_TABLES.filter((t) => !existing.has(t));
      expect(missing).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('seeds bootstrap configuration without any demo records', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      const clinic = db.get('SELECT id, name, time_zone, currency_code, currency_symbol FROM clinic') as Record<string, unknown>;
      expect(clinic).toBeDefined();
      // Clinic name is empty until setup: no fabricated clinic identity.
      expect(clinic.name).toBe('');
      expect(clinic.time_zone).toBe('Asia/Dhaka');
      expect(clinic.currency_code).toBe('BDT');
      expect(clinic.currency_symbol).toBe('৳');

      for (const table of ['patients', 'visits', 'prescriptions', 'invoices', 'payments', 'receipts', 'appointments', 'inventory_items', 'users', 'dentists', 'treatments']) {
        const row = db.get(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number };
        expect(row.n, `expected ${table} to start empty`).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it('is idempotent across restarts', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      const second = migrate(db);
      expect(second.applied).toEqual([]);
      expect(second.fresh).toBe(false);
      expect(second.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('verifies a healthy schema', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      const verification = verifySchema(db);
      expect(verification.missingTables).toEqual([]);
      expect(verification.integrity.ok).toBe(true);
      expect(verification.foreignKeyViolations).toBe(0);
      expect(verification.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('enforces foreign keys', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      db.verifyPragmas();
      expect(() =>
        db.run(
          `INSERT INTO visits (id, patient_id, occurred_at, created_at, updated_at)
           VALUES ('vis_x', 'pat_does_not_exist', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('enforces the financial invariant at the database layer', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      db.run(
        `INSERT INTO patients (id, patient_code, name, name_normalized, created_at, updated_at)
         VALUES ('pat_a', 'DP-000001', 'A', 'a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      );
      // subtotal - discount + tax must equal total
      expect(() =>
        db.run(
          `INSERT INTO invoices (id, number, patient_id, invoice_date, subtotal_minor, discount_minor, taxable_minor, tax_percent, tax_minor, total_minor, created_at, updated_at)
           VALUES ('inv_bad','INV-2026-000001','pat_a','2026-01-01', 10000, 0, 10000, 0, 0, 9999, '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        ),
      ).toThrow();

      // A consistent invoice is accepted.
      db.run(
        `INSERT INTO invoices (id, number, patient_id, invoice_date, subtotal_minor, discount_minor, taxable_minor, tax_percent, tax_minor, total_minor, created_at, updated_at)
         VALUES ('inv_ok','INV-2026-000002','pat_a','2026-01-01', 10000, 1000, 9000, 5, 450, 9450, '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      );
      const row = db.get('SELECT total_minor FROM invoices WHERE id = ?', 'inv_ok') as { total_minor: number };
      expect(row.total_minor).toBe(9450);
    } finally {
      db.close();
    }
  });

  it('enforces unique Patient Code and unique queue serial per counter key', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      db.run(
        `INSERT INTO patients (id, patient_code, name, name_normalized, created_at, updated_at)
         VALUES ('pat_a', 'DP-000001', 'A', 'a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      );
      expect(() =>
        db.run(
          `INSERT INTO patients (id, patient_code, name, name_normalized, created_at, updated_at)
           VALUES ('pat_b', 'DP-000001', 'B', 'b', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        ),
      ).toThrow();

      const insertQueue = (id: string, serial: number, counterKey: string) =>
        db.run(
          `INSERT INTO queue_entries (id, queue_date, serial, counter_key, patient_id, arrived_at, created_at, updated_at)
           VALUES (?, '2026-01-01', ?, ?, 'pat_a', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z')`,
          id,
          serial,
          counterKey,
        );
      insertQueue('q1', 1, '2026-01-01');
      expect(() => insertQueue('q2', 1, '2026-01-01')).toThrow();
      // Same serial on a different day is valid: the daily reset is by counter key.
      expect(() => insertQueue('q3', 1, '2026-01-02')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects an invalid status value', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      expect(() =>
        db.run(
          `INSERT INTO treatments (id, code, name, standard_price_minor, created_at, updated_at)
           VALUES ('trt_a','X1','x',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        ),
      ).not.toThrow();
      expect(() =>
        db.run(
          `INSERT INTO appointments (id, patient_id, starts_at, ends_at, duration_minutes, status, created_at, updated_at)
           VALUES ('apt_a','pat_a','2026-01-01T09:00:00.000Z','2026-01-01T09:30:00.000Z',30,'bogus','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects an appointment whose end precedes its start', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      db.run(
        `INSERT INTO patients (id, patient_code, name, name_normalized, created_at, updated_at)
         VALUES ('pat_a', 'DP-000001', 'A', 'a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      );
      expect(() =>
        db.run(
          `INSERT INTO appointments (id, patient_id, starts_at, ends_at, duration_minutes, status, created_at, updated_at)
           VALUES ('apt_a','pat_a','2026-01-01T09:30:00.000Z','2026-01-01T09:00:00.000Z',30,'scheduled','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rolls back a transaction that fails part way through', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      expect(() =>
        db.transaction((tx) => {
          tx.run(
            `INSERT INTO patients (id, patient_code, name, name_normalized, created_at, updated_at)
             VALUES ('pat_a','DP-000001','A','a','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
          );
          throw new Error('deliberate failure');
        }),
      ).toThrow();
      const row = db.get('SELECT COUNT(*) AS n FROM patients') as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rolls back when an inner participant marks the transaction rollback-only', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      expect(() =>
        db.transaction((tx) => {
          tx.run(
            `INSERT INTO patients (id, patient_code, name, name_normalized, created_at, updated_at)
             VALUES ('pat_a','DP-000001','A','a','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
          );
          tx.rollbackOnly('inner service rejected the write');
        }),
      ).toThrow(/rolled back/);
      const row = db.get('SELECT COUNT(*) AS n FROM patients') as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('has stable migration checksums', () => {
    for (const migration of MIGRATIONS) {
      const checksum = checksumOf(migration.up);
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(checksumOf(migration.up)).toBe(checksum);
    }
  });

  it('refuses to run when an applied migration has been altered', () => {
    const db = Database.inMemory();
    try {
      migrate(db);
      db.run('UPDATE schema_migrations SET checksum = ? WHERE version = 1', 'deadbeef');
      expect(() => migrate(db)).toThrow(/no longer matches/);
    } finally {
      db.close();
    }
  });
});
