/**
 * Dentiva Pro — row mapping helpers.
 *
 * Repositories map database rows to typed objects here, so the rest of the application never
 * touches raw column names. Every helper is explicit about nullability: a value that can be
 * NULL in the schema is typed `| null`, and one that cannot is read with a runtime guard so a
 * schema/data mismatch fails loudly instead of rendering as `undefined` in the UI.
 */

export type Row = Record<string, unknown>;

export function str(row: Row | undefined, key: string): string {
  if (row === undefined) throw new Error(`Cannot read "${key}": no row was returned.`);
  const value = row[key];
  if (value === null || value === undefined) {
    throw new Error(`Cannot read "${key}": the column is NULL but a value is required.`);
  }
  return String(value);
}

export function strOrNull(row: Row | undefined, key: string): string | null {
  if (row === undefined) return null;
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

export function strOr(row: Row | undefined, key: string, fallback: string): string {
  return strOrNull(row, key) ?? fallback;
}

export function num(row: Row | undefined, key: string): number {
  if (row === undefined) throw new Error(`Cannot read "${key}": no row was returned.`);
  const value = row[key];
  if (value === null || value === undefined) {
    throw new Error(`Cannot read "${key}": the column is NULL but a number is required.`);
  }
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Cannot read "${key}": the stored value is not a finite number.`);
  return n;
}

export function int(row: Row | undefined, key: string): number {
  const n = num(row, key);
  if (!Number.isSafeInteger(n)) throw new Error(`Cannot read "${key}": expected a whole number, got ${n}.`);
  return n;
}

export function numOr(row: Row | undefined, key: string, fallback: number): number {
  const value = row?.[key];
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(row: Row | undefined, key: string): boolean {
  return numOr(row, key, 0) !== 0;
}

export function boolOrNull(row: Row | undefined, key: string): boolean | null {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  return Number(value) !== 0;
}

/** Parse a JSON TEXT column, returning `fallback` only when the column is genuinely NULL. */
export function json<T>(row: Row | undefined, key: string, fallback: T): T {
  const raw = strOrNull(row, key);
  if (raw === null) return fallback;
  if (raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Column "${key}" does not contain valid JSON. The database may have been edited outside Dentiva Pro.`);
  }
}

/** Serialise a value to JSON TEXT, rejecting non-finite numbers that would produce invalid JSON. */
export function toJson(value: unknown): string {
  const json2 = JSON.stringify(value, (_key, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error('Cannot store a non-finite number.');
    }
    if (typeof v === 'bigint') return Number(v);
    return v;
  });
  if (json2 === undefined) throw new Error('Cannot serialise this value to JSON.');
  return json2;
}

/** Build a deterministic `IN (?, ?, ...)` clause from a non-empty list. */
export function inClause(values: readonly unknown[]): { sql: string; args: unknown[] } {
  if (values.length === 0) return { sql: '(NULL)', args: [] };
  return { sql: `(${values.map(() => '?').join(', ')})`, args: [...values] };
}

/**
 * Validate an ORDER BY column against an allow-list.
 *
 * Sort direction and column come from the UI, so they can never be interpolated blindly into
 * SQL. Unknown values fall back to the default rather than throwing, because an unexpected
 * sort request is a UI bug, not an attack worth failing the request over.
 */
export function safeSort<T extends string>(requested: string | undefined, allowed: readonly T[], fallback: T): T {
  if (requested === undefined) return fallback;
  return (allowed as readonly string[]).includes(requested) ? (requested as T) : fallback;
}

export function sortDirection(requested: string | undefined): 'ASC' | 'DESC' {
  return requested === 'asc' ? 'ASC' : 'DESC';
}
