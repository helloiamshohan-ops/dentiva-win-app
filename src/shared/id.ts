/**
 * Dentiva Pro — identifier generation.
 *
 * Primary keys are prefixed, time-sortable, collision-resistant identifiers (ULID layout:
 * 48-bit millisecond timestamp followed by 80 bits of cryptographic randomness, encoded in
 * Crockford base32).
 *
 * Why not autoincrement integers?
 *   - They leak record volume and creation order across clinics after a restore/import.
 *   - They collide when data is merged from a backup or an import.
 *   - They are not safe to embed in URLs, filenames or printed documents.
 *
 * Why not list position?
 *   - List position is not stable. Patient Code must never be derived from it.
 */

import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

export const ID_PREFIXES = [
  'adj', // financial adjustment
  'apt', // appointment
  'att', // attachment
  'aud', // audit log entry
  'bku', // backup record
  'chr', // chair
  'cli', // clinic
  'dnt', // dentist
  'exp', // expense
  'fol', // follow-up
  'inv', // invoice
  'ivi', // invoice line item
  'itm', // inventory item
  'mov', // inventory movement
  'ntf', // notification
  'pat', // patient
  'pmt', // payment
  'prx', // prescription
  'qeu', // queue entry
  'rcp', // receipt
  'ref', // referral
  'rfd', // refund
  'rmt', // room
  'set', // settings scope
  'stf', // staff member
  'sup', // supplier
  'tpl', // treatment plan
  'trt', // treatment (catalogue item)
  'usr', // user account
  'vis', // visit
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

function encodeTime(time: number, length: number): string {
  let out = '';
  let mod = time;
  for (let i = 0; i < length; i += 1) {
    out = ENCODING[mod % 32] + out;
    mod = Math.floor(mod / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ENCODING[(bytes[i % bytes.length] ?? 0) % 32];
  }
  return out;
}

/** Generate a new identifier body (26 characters, no prefix). */
export function newIdBody(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid timestamp for identifier generation');
  const rand = randomBytes(16);
  return encodeTime(now, 10) + encodeRandom(rand, 16);
}

/** Generate a new prefixed identifier, e.g. `pat_01J9Z4K8M2QWERTYUPASDFGHJK`. */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${newIdBody(now)}`;
}

const ID_PATTERN = /^([a-z]{3})_([0-9A-HJKMNP-TV-Z]{26})$/;

/** Validate an identifier's shape. Used by every IPC input validator. */
export function isWellFormedId(value: unknown, expectedPrefix?: IdPrefix): value is string {
  if (typeof value !== 'string') return false;
  const match = ID_PATTERN.exec(value);
  if (!match) return false;
  if (expectedPrefix !== undefined && match[1] !== expectedPrefix) return false;
  return true;
}

/** Extract the prefix from a well-formed identifier, or null. */
export function idPrefix(value: string): IdPrefix | null {
  const match = ID_PATTERN.exec(value);
  if (!match) return null;
  const prefix = match[1] as IdPrefix;
  return (ID_PREFIXES as readonly string[]).includes(prefix) ? prefix : null;
}

/**
 * Patient Code generation.
 *
 * Patient Codes are human-readable, stable, permanent and unique: `DP-000001`.
 * The numeric sequence is allocated from a database counter table inside the same
 * transaction that inserts the patient, which makes allocation race-safe. The code is
 * never recalculated, never reused and never derived from a row's position in a list.
 */
export const PATIENT_CODE_PREFIX = 'DP';
export const PATIENT_CODE_WIDTH = 6;

export function formatPatientCode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`Patient Code sequence must be a positive whole number, received ${sequence}`);
  }
  if (sequence > 10 ** PATIENT_CODE_WIDTH - 1) {
    throw new Error(`Patient Code sequence exceeds the supported range of ${10 ** PATIENT_CODE_WIDTH - 1}`);
  }
  return `${PATIENT_CODE_PREFIX}-${String(sequence).padStart(PATIENT_CODE_WIDTH, '0')}`;
}

const PATIENT_CODE_PATTERN = /^DP-(\d{6,})$/;

export function isWellFormedPatientCode(value: unknown): value is string {
  return typeof value === 'string' && PATIENT_CODE_PATTERN.test(value);
}

/**
 * Document number generation (invoice / receipt).
 *
 * Format: `<PREFIX>-<FYYYY>-<sequence>`, e.g. `INV-2026-000123`. The fiscal-year component is
 * included because clinics keep annual records and read document numbers aloud over the
 * phone; a bare running number is ambiguous across years.
 */
export type DocumentKind = 'invoice' | 'receipt';

export const DOCUMENT_PREFIX: Record<DocumentKind, string> = {
  invoice: 'INV',
  receipt: 'RCP',
};

export function formatDocumentNumber(kind: DocumentKind, fiscalYear: number, sequence: number): string {
  if (!Number.isSafeInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2999) {
    throw new Error(`Invalid fiscal year for ${kind} number: ${fiscalYear}`);
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`Invalid sequence for ${kind} number: ${sequence}`);
  }
  return `${DOCUMENT_PREFIX[kind]}-${fiscalYear}-${String(sequence).padStart(6, '0')}`;
}
