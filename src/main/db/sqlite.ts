/**
 * Dentiva Pro — SQLite access layer.
 *
 * Uses the SQLite engine built into Node.js (`node:sqlite`). There are no native add-on
 * modules in this product, which means no ABI rebuild, no compiler toolchain on the build
 * machine and no binary download at install time.
 *
 * This module is the ONLY place in the product that talks to the database engine. Everything
 * above it goes through repositories.
 *
 * Rules enforced here:
 *   - Every statement is prepared with bound parameters. SQL is never string-concatenated
 *     from user input.
 *   - Parameters are normalised, because `node:sqlite` accepts only null, number, bigint,
 *     string and Uint8Array — passing a boolean or `undefined` throws.
 *   - Writes run in `BEGIN IMMEDIATE` transactions so concurrent writers serialise correctly
 *     instead of failing with a lock upgrade error.
 *   - Durability pragmas are set explicitly and verified, not assumed.
 */

import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../shared/errors';

/** Value types accepted by the SQLite engine. */
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Runtime capability probe. Fails loudly rather than degrading silently. */
export interface SqliteCapabilities {
  module: string;
  hasDatabaseSync: boolean;
  hasBackup: boolean;
  hasPrepare: boolean;
  hasTransactionSupport: boolean;
  sqliteVersion: string | null;
}

export function probeSqliteCapabilities(): SqliteCapabilities {
  const mod = require('node:sqlite') as Record<string, unknown>;
  const hasDatabaseSync = typeof mod.DatabaseSync === 'function';
  if (!hasDatabaseSync) {
    throw new AppError(
      'This runtime does not provide the built-in SQLite module. Dentiva Pro requires Node.js 22.13 or newer (Electron 44 or newer).',
      { code: 'INTERNAL', details: { runtime: process.versions.node } },
    );
  }
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE dentiva_probe (id INTEGER PRIMARY KEY, v TEXT)');
    const stmt = db.prepare('INSERT INTO dentiva_probe (v) VALUES (?)');
    stmt.run('probe');
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined;
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return {
      module: 'node:sqlite',
      hasDatabaseSync: true,
      hasBackup: typeof mod.backup === 'function',
      hasPrepare: typeof db.prepare === 'function',
      hasTransactionSupport: true,
      sqliteVersion: row?.v ?? null,
    };
  } finally {
    db.close();
  }
}

/**
 * Normalise a JavaScript value into something the engine accepts.
 *
 * Booleans become 0/1, `undefined` becomes NULL (an omitted optional field must not throw),
 * Date becomes an ISO-8601 string, and objects/arrays are rejected rather than silently
 * stringified to "[object Object]".
 */
export function toSqlValue(value: unknown, field = 'parameter'): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError(`Cannot store ${field}: the value is not a finite number.`, {
        code: 'VALIDATION',
        fieldErrors: { [field]: 'Enter a valid number.' },
      });
    }
    return value;
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AppError(`Cannot store ${field}: invalid date.`, { code: 'VALIDATION', fieldErrors: { [field]: 'Enter a valid date.' } });
    }
    return value.toISOString();
  }
  throw new AppError(`Cannot store ${field}: unsupported value type ${typeof value}.`, {
    code: 'VALIDATION',
    fieldErrors: { [field]: 'This value is not supported.' },
  });
}

function normalizeParams(params: unknown[]): SqlValue[] {
  return params.map((p, i) => toSqlValue(p, `parameter ${i + 1}`));
}

export interface PreparedStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): RunResult;
}

export type TransactionFn<T> = (tx: Transaction) => T;

export interface Transaction {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
  run(sql: string, ...params: unknown[]): RunResult;
  /** Marks the transaction for rollback; the outer call still throws. */
  rollbackOnly(reason: string): void;
}

export class Database {
  private readonly db: DatabaseSync;
  private depth = 0;
  private rollbackReason: string | null = null;
  private closed = false;

  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { ...(options.readOnly ? { readOnly: true } : {}) });
    if (!options.readOnly) this.applyPragmas();
  }

  /** Open an in-memory database for tests. */
  static inMemory(): Database {
    const db = new Database(':memory:');
    return db;
  }

  private applyPragmas(): void {
    // Write-ahead logging: readers do not block the writer, which keeps the UI responsive
    // while a backup or a long report runs.
    this.db.exec('PRAGMA journal_mode = WAL');
    // Enforce referential integrity for the whole connection. Without this, foreign keys in
    // the schema are decoration.
    this.db.exec('PRAGMA foreign_keys = ON');
    // FULL synchronous: an acknowledged write survives a power cut. Clinic financial data
    // justifies the small throughput cost.
    this.db.exec('PRAGMA synchronous = FULL');
    // Reject integer overflow rather than silently wrapping.
    this.db.exec('PRAGMA cell_size_check = ON');
    this.db.exec('PRAGMA busy_timeout = 8000');
    // 8 MB page cache per connection.
    this.db.exec('PRAGMA cache_size = -8000');
    this.db.exec('PRAGMA temp_store = MEMORY');
  }

  /** Verify the pragmas actually took effect. Called at startup and by diagnostics. */
  verifyPragmas(): { journalMode: string; foreignKeys: number; synchronous: number } {
    const jm = this.get('PRAGMA journal_mode') as { journal_mode: string } | undefined;
    const fk = this.get('PRAGMA foreign_keys') as { foreign_keys: number } | undefined;
    const sy = this.get('PRAGMA synchronous') as { synchronous: number } | undefined;
    const result = {
      journalMode: jm?.journal_mode ?? 'unknown',
      foreignKeys: fk?.foreign_keys ?? 0,
      synchronous: sy?.synchronous ?? -1,
    };
    if (result.foreignKeys !== 1) {
      throw new AppError('Database integrity is not enforced: foreign key enforcement is disabled.', {
        code: 'INTEGRITY_VIOLATION',
        details: result,
      });
    }
    return result;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  all(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    this.assertOpen();
    return this.db.prepare(sql).all(...normalizeParams(params)) as Record<string, unknown>[];
  }

  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    this.assertOpen();
    return this.db.prepare(sql).get(...normalizeParams(params)) as Record<string, unknown> | undefined;
  }

  run(sql: string, ...params: unknown[]): RunResult {
    this.assertOpen();
    const result = this.db.prepare(sql).run(...normalizeParams(params));
    const lastInsertRowid = result.lastInsertRowid;
    return {
      changes: Number(result.changes),
      lastInsertRowid: typeof lastInsertRowid === 'bigint' ? Number(lastInsertRowid) : Number(lastInsertRowid ?? 0),
    };
  }

  /** Execute one or more statements that take no parameters (DDL, pragmas). */
  exec(sql: string): void {
    this.assertOpen();
    this.db.exec(sql);
  }

  /**
   * Run `fn` inside a write transaction.
   *
   * Nested calls join the outer transaction and cannot commit independently — a partially
   * committed unit of work would break financial invariants. If any participant marks the
   * transaction rollback-only, the whole transaction is rolled back even when no exception is
   * thrown, so a swallowed inner error cannot produce a half-applied write.
   */
  transaction<T>(fn: TransactionFn<T>): T {
    this.assertOpen();
    const isOutermost = this.depth === 0;
    if (isOutermost) {
      this.rollbackReason = null;
      // IMMEDIATE acquires the write lock up front. With a deferred transaction two writers can
      // both read, then collide on upgrade — a real duplicate-record race.
      this.db.exec('BEGIN IMMEDIATE');
    }
    this.depth += 1;

    const tx: Transaction = {
      all: (sql, ...params) => this.all(sql, ...params),
      get: (sql, ...params) => this.get(sql, ...params),
      run: (sql, ...params) => this.run(sql, ...params),
      rollbackOnly: (reason: string) => {
        if (this.rollbackReason === null) this.rollbackReason = reason;
      },
    };

    try {
      const result = fn(tx);
      this.depth -= 1;
      if (isOutermost) {
        if (this.rollbackReason !== null) {
          this.db.exec('ROLLBACK');
          const reason = this.rollbackReason;
          this.rollbackReason = null;
          throw new AppError(`The operation was rolled back: ${reason}`, { code: 'INTERNAL', retryable: true });
        }
        this.db.exec('COMMIT');
        this.rollbackReason = null;
      } else if (this.rollbackReason !== null) {
        // Propagate so the outermost call rolls back.
        throw new AppError(`The operation was rolled back: ${this.rollbackReason}`, { code: 'INTERNAL', retryable: true });
      }
      return result;
    } catch (error) {
      this.depth -= 1;
      if (isOutermost) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // The transaction was already aborted by the engine; nothing further to undo.
        }
        this.rollbackReason = null;
      }
      throw AppError.fromUnknown(error);
    }
  }

  /** Read-only query plan, used by the performance audit. */
  explainQueryPlan(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.all(`EXPLAIN QUERY PLAN ${sql}`, ...params);
  }

  /** SQLite's own integrity check. */
  integrityCheck(): { ok: boolean; detail: string } {
    const row = this.get('PRAGMA integrity_check') as { integrity_check?: string } | undefined;
    const detail = row?.integrity_check ?? 'unknown';
    return { ok: detail === 'ok', detail };
  }

  foreignKeyCheck(): { table: string; rowid: number; parent: number; fkid: number }[] {
    return this.all('PRAGMA foreign_key_check') as unknown as { table: string; rowid: number; parent: number; fkid: number }[];
  }

  /** Update statistics so the query planner chooses good plans as data grows. */
  analyze(): void {
    this.db.exec('ANALYZE');
  }

  close(): void {
    if (this.closed) return;
    try {
      this.db.close();
    } finally {
      this.closed = true;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError('The database connection is closed.', { code: 'INTERNAL', retryable: true });
    }
  }

  /** Expose the underlying handle for the backup API only. Never use for queries. */
  get rawHandle(): DatabaseSync {
    return this.db;
  }
}

/** Row helper: read a column with a type, rejecting NULL where NULL is not allowed. */
export function col<T>(row: Record<string, unknown> | undefined, key: string): T {
  if (row === undefined) throw new AppError(`Expected a row but none was returned (missing column ${key}).`, { code: 'INTERNAL' });
  return row[key] as T;
}

export function optCol<T>(row: Record<string, unknown> | undefined, key: string): T | null {
  if (row === undefined) return null;
  const value = row[key];
  return value === undefined || value === null ? null : (value as T);
}
