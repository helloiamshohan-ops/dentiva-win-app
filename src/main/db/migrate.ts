/**
 * Dentiva Pro — schema migration runner.
 *
 * Guarantees:
 *   - Each migration runs inside its own transaction. SQLite DDL is transactional, so a failed
 *     migration rolls back completely: there is never a half-applied schema.
 *   - Applied migrations are checksummed. If the SQL of an already-applied migration no longer
 *     matches, startup refuses to continue rather than running against a schema that differs
 *     from what the code expects.
 *   - The schema version is recorded both in `schema_migrations` and in `PRAGMA user_version`,
 *     so it can be read without opening the table.
 *   - Migrations are append-only. An existing migration is never edited after release.
 */

import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { Database } from './sqlite';
import { MIGRATION_0001_NAME, MIGRATION_0001_SEED, MIGRATION_0001_SQL } from './migrations/0001-initial-schema';

export interface Migration {
  /** Monotonically increasing version. */
  version: number;
  name: string;
  /** SQL to apply. Multiple statements are allowed; they all run in one transaction. */
  up: string;
  /** Optional seed/bootstrap statements, applied in the same transaction. */
  seed?: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: MIGRATION_0001_NAME, up: MIGRATION_0001_SQL, seed: MIGRATION_0001_SEED },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length > 0 ? (MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0) : 0;

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
  fresh: boolean;
}

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
`;

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function readAppliedMigrations(db: Database): AppliedMigration[] {
  const rows = db.all('SELECT version, name, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY version');
  return rows.map((r) => ({
    version: Number(r.version),
    name: String(r.name),
    checksum: String(r.checksum),
    appliedAt: String(r.appliedAt),
  }));
}

export function currentSchemaVersion(db: Database): number {
  const row = db.get('PRAGMA user_version') as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Apply all pending migrations.
 *
 * Safe to call on every startup and safe to interrupt: an interrupted migration leaves the
 * database exactly as it was, and the next startup simply retries it.
 */
export function migrate(db: Database): MigrationResult {
  db.exec(MIGRATION_TABLE_SQL);
  const applied = readAppliedMigrations(db);
  const appliedVersions = new Set(applied.map((m) => m.version));
  const fresh = applied.length === 0;

  // Verify already-applied migrations have not been altered.
  for (const record of applied) {
    const definition = MIGRATIONS.find((m) => m.version === record.version);
    if (!definition) {
      throw new AppError(
        `The database was created by a newer version of Dentiva Pro (schema version ${record.version}). Install that version, or restore a backup taken by this version.`,
        { code: 'RESTORE_INCOMPATIBLE', details: { schemaVersion: record.version, knownVersion: CURRENT_SCHEMA_VERSION } },
      );
    }
    const expected = checksumOf(definition.up);
    if (expected !== record.checksum) {
      throw new AppError(
        `Migration "${record.name}" no longer matches the version that was applied to this database. The database files may have been modified outside Dentiva Pro. Restore from a backup before continuing.`,
        { code: 'INTEGRITY_VIOLATION', details: { migration: record.name, expected, actual: record.checksum } },
      );
    }
  }

  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort((a, b) => a.version - b.version);
  const appliedNow: number[] = [];

  for (const migration of pending) {
    const startedAt = Date.now();
    // Each migration is atomic. If any statement fails, the whole migration is undone.
    db.transaction((tx) => {
      tx.run(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at, duration_ms)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`,
        migration.version,
        migration.name,
        checksumOf(migration.up),
        0,
      );
      tx.run('SELECT 1'); // ensure the transaction is materialised before DDL
      db.exec(migration.up);
      if (migration.seed) db.exec(migration.seed);
      tx.run('PRAGMA user_version = ' + Number(migration.version));
      tx.run('UPDATE schema_migrations SET duration_ms = ? WHERE version = ?', Date.now() - startedAt, migration.version);
    });
    appliedNow.push(migration.version);
  }

  if (appliedNow.length > 0) {
    // Refresh planner statistics after a schema change.
    db.analyze();
  }

  return {
    applied: appliedNow,
    currentVersion: currentSchemaVersion(db),
    fresh,
  };
}

/**
 * Full verification used by diagnostics and by the release gate.
 *
 * Checks that the schema version matches the code, that foreign keys are intact, that SQLite
 * reports the file as structurally sound, and that required tables exist.
 */
export interface SchemaVerification {
  ok: boolean;
  schemaVersion: number;
  expectedVersion: number;
  integrity: { ok: boolean; detail: string };
  foreignKeyViolations: number;
  missingTables: string[];
}

export const REQUIRED_TABLES = [
  'activation_state',
  'adjustments',
  'appointments',
  'attachments',
  'audit_log',
  'backup_history',
  'chairs',
  'clinic',
  'dental_chart_entries',
  'dentists',
  'expenses',
  'export_history',
  'follow_ups',
  'import_batches',
  'inventory_items',
  'inventory_movements',
  'invoice_items',
  'invoices',
  'patient_notes',
  'patients',
  'payments',
  'prescription_medicines',
  'prescriptions',
  'queue_counters',
  'queue_entries',
  'receipts',
  'referrals',
  'rooms',
  'saved_views',
  'sequences',
  'staff',
  'suppliers',
  'treatment_plan_items',
  'treatment_plans',
  'treatments',
  'users',
  'visit_procedures',
  'visits',
] as const;

export function verifySchema(db: Database): SchemaVerification {
  const schemaVersion = currentSchemaVersion(db);
  const integrity = db.integrityCheck();
  const violations = db.foreignKeyCheck();
  const existing = new Set(
    db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r.name)),
  );
  const missingTables = REQUIRED_TABLES.filter((t) => !existing.has(t));

  return {
    ok:
      integrity.ok &&
      violations.length === 0 &&
      missingTables.length === 0 &&
      schemaVersion === CURRENT_SCHEMA_VERSION,
    schemaVersion,
    expectedVersion: CURRENT_SCHEMA_VERSION,
    integrity,
    foreignKeyViolations: violations.length,
    missingTables,
  };
}
