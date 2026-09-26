/**
 * Dentiva Pro — patient data access.
 *
 * This repository owns every SQL statement that touches patient rows. It contains no business
 * rules: validation, duplicate policy and audit live in `PatientService`.
 *
 * Two properties matter here:
 *   - Search always runs against the full table. There is no hidden row cap; the caller supplies
 *     LIMIT/OFFSET explicitly for paging, and a separate COUNT query reports the true total.
 *   - Identifier columns are selected explicitly. `SELECT *` is never used, so a schema change
 *     cannot silently alter what the UI receives.
 */

import { AppError } from '../../shared/errors';
import { isWellFormedId, isWellFormedPatientCode, formatPatientCode } from '../../shared/id';
import { normalizeName, normalizePhone } from '../../domain/patient';
import type { Database } from '../db/sqlite';
import type { Transaction } from '../db/sqlite';
import { bool, int, json, num, str, strOrNull, toJson } from './row';
import type { Sex } from '../../domain/patient';

export interface PatientRow {
  id: string;
  patientCode: string;
  name: string;
  preferredName: string | null;
  sex: Sex;
  dobKey: string | null;
  phone: string | null;
  alternatePhone: string | null;
  email: string | null;
  address: string | null;
  occupation: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  referralSource: string | null;
  tags: string[];
  customFields: CustomField[];
  notes: string | null;
  medicalHistory: string | null;
  dentalHistory: string | null;
  allergies: string | null;
  currentMedications: string | null;
  chronicConditions: string | null;
  riskInformation: string | null;
  archivedAt: string | null;
  archivedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomField {
  label: string;
  value: string;
}

const PATIENT_COLUMNS = `
  id, patient_code AS patientCode, name, preferred_name AS preferredName, sex, dob_key AS dobKey,
  phone, alternate_phone AS alternatePhone, email, address, occupation,
  emergency_contact_name AS emergencyContactName, emergency_contact_phone AS emergencyContactPhone,
  referral_source AS referralSource, tags, custom_fields AS customFields, notes,
  medical_history AS medicalHistory, dental_history AS dentalHistory, allergies,
  current_medications AS currentMedications, chronic_conditions AS chronicConditions,
  risk_information AS riskInformation, archived_at AS archivedAt, archived_reason AS archivedReason,
  created_at AS createdAt, updated_at AS updatedAt
`;

export function mapPatient(row: Record<string, unknown>): PatientRow {
  return {
    id: str(row, 'id'),
    patientCode: str(row, 'patientCode'),
    name: str(row, 'name'),
    preferredName: strOrNull(row, 'preferredName'),
    sex: (strOr(row, 'sex', 'unspecified') as Sex),
    dobKey: strOrNull(row, 'dobKey'),
    phone: strOrNull(row, 'phone'),
    alternatePhone: strOrNull(row, 'alternatePhone'),
    email: strOrNull(row, 'email'),
    address: strOrNull(row, 'address'),
    occupation: strOrNull(row, 'occupation'),
    emergencyContactName: strOrNull(row, 'emergencyContactName'),
    emergencyContactPhone: strOrNull(row, 'emergencyContactPhone'),
    referralSource: strOrNull(row, 'referralSource'),
    tags: json<string[]>(row, 'tags', []),
    customFields: json<CustomField[]>(row, 'customFields', []),
    notes: strOrNull(row, 'notes'),
    medicalHistory: strOrNull(row, 'medicalHistory'),
    dentalHistory: strOrNull(row, 'dentalHistory'),
    allergies: strOrNull(row, 'allergies'),
    currentMedications: strOrNull(row, 'currentMedications'),
    chronicConditions: strOrNull(row, 'chronicConditions'),
    riskInformation: strOrNull(row, 'riskInformation'),
    archivedAt: strOrNull(row, 'archivedAt'),
    archivedReason: strOrNull(row, 'archivedReason'),
    createdAt: str(row, 'createdAt'),
    updatedAt: str(row, 'updatedAt'),
  };
}

function strOr(row: Record<string, unknown>, key: string, fallback: string): string {
  const value = row[key];
  return value === null || value === undefined ? fallback : String(value);
}

export interface PatientListQuery {
  search?: string;
  sex?: Sex | 'all';
  includeArchived?: boolean;
  onlyArchived?: boolean;
  sortBy?: 'name' | 'patientCode' | 'createdAt' | 'dob' | 'phone';
  sortDir?: 'asc' | 'desc';
  limit: number;
  offset: number;
  /** Restrict to an explicit set of ids (used by exports of a filtered selection). */
  ids?: string[];
}

export const PATIENT_SORT_COLUMNS = ['name', 'patientCode', 'createdAt', 'dob', 'phone'] as const;

export class PatientRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): PatientRow | null {
    if (!isWellFormedId(id, 'pat')) return null;
    const row = this.db.get(`SELECT ${PATIENT_COLUMNS} FROM patients WHERE id = ?`, id);
    return row ? mapPatient(row) : null;
  }

  findByCode(patientCode: string): PatientRow | null {
    if (!isWellFormedPatientCode(patientCode)) return null;
    const row = this.db.get(`SELECT ${PATIENT_COLUMNS} FROM patients WHERE patient_code = ?`, patientCode);
    return row ? mapPatient(row) : null;
  }

  existsByCode(patientCode: string, excludeId?: string): boolean {
    const row = this.db.get(
      `SELECT 1 AS found FROM patients WHERE patient_code = ? AND (? IS NULL OR id <> ?) LIMIT 1`,
      patientCode,
      excludeId ?? null,
      excludeId ?? null,
    );
    return row !== undefined;
  }

  count(includeArchived = true): number {
    const row = this.db.get(includeArchived ? 'SELECT COUNT(*) AS n FROM patients' : 'SELECT COUNT(*) AS n FROM patients WHERE archived_at IS NULL') as { n: number };
    return int(row, 'n');
  }

  /**
   * Paged patient directory.
   *
   * The COUNT and the page query share the same WHERE clause, so the reported total always
   * matches the rows being paged. Search uses an index-friendly prefix match on the normalised
   * name plus a phone/patient-code match.
   */
  list(query: PatientListQuery): { rows: PatientRow[]; total: number } {
    const { where, args } = this.buildWhere(query);
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM patients ${where}`, ...args) as { n: number };
    const sortColumn = (PATIENT_SORT_COLUMNS as readonly string[]).includes(query.sortBy ?? '')
      ? (query.sortBy as (typeof PATIENT_SORT_COLUMNS)[number])
      : 'name';
    const direction = query.sortDir === 'desc' ? 'DESC' : 'ASC';
    const orderExpr =
      sortColumn === 'name'
        ? `name COLLATE NOCASE ${direction}, patient_code ASC`
        : sortColumn === 'patientCode'
          ? `patient_code ${direction}`
          : sortColumn === 'createdAt'
            ? `created_at ${direction}, id ${direction}`
            : sortColumn === 'dob'
              ? // NULLs (unknown date of birth) sort last regardless of direction.
                `dob_key IS NULL, dob_key ${direction}, patient_code ASC`
              : `phone_normalized IS NULL, phone_normalized ${direction}, patient_code ASC`;

    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 5000) {
      throw new AppError('Page size must be between 1 and 5000.', { code: 'VALIDATION' });
    }
    if (!Number.isSafeInteger(query.offset) || query.offset < 0) {
      throw new AppError('Page offset must be zero or greater.', { code: 'VALIDATION' });
    }

    const rows = this.db.all(
      `SELECT ${PATIENT_COLUMNS} FROM patients ${where} ORDER BY ${orderExpr} LIMIT ? OFFSET ?`,
      ...args,
      query.limit,
      query.offset,
    );
    return { rows: rows.map(mapPatient), total: int(totalRow, 'n') };
  }

  private buildWhere(query: PatientListQuery): { where: string; args: unknown[] } {
    const clauses: string[] = [];
    const args: unknown[] = [];

    if (query.onlyArchived) {
      clauses.push('archived_at IS NOT NULL');
    } else if (!query.includeArchived) {
      clauses.push('archived_at IS NULL');
    }
    if (query.sex && query.sex !== 'all') {
      clauses.push('sex = ?');
      args.push(query.sex);
    }
    if (query.ids && query.ids.length > 0) {
      clauses.push(`id IN (${query.ids.map(() => '?').join(', ')})`);
      args.push(...query.ids);
    }
    const search = (query.search ?? '').trim();
    if (search !== '') {
      // Patient Code lookup is exact-prefix; name is a normalised prefix/substring match; phone
      // is matched on the normalised digits. All three run in SQL against the full table.
      const normalized = normalizeName(search);
      const phone = normalizePhone(search);
      const like = `%${escapeLike(normalized)}%`;
      const orParts: string[] = [`name_normalized LIKE ?`];
      const orArgs: unknown[] = [like];
      if (/^DP-\d*$/i.test(search)) {
        orParts.push('patient_code LIKE ?');
        orArgs.push(`${search.toUpperCase()}%`);
      }
      if (phone !== null) {
        orParts.push('phone_normalized = ?');
        orArgs.push(phone);
        orParts.push('phone_normalized LIKE ?');
        orArgs.push(`${escapeLike(phone)}%`);
      }
      if (search.includes('@')) {
        orParts.push('email LIKE ?');
        orArgs.push(`%${escapeLike(search.toLowerCase())}%`);
      }
      clauses.push(`(${orParts.join(' OR ')})`);
      args.push(...orArgs);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }

  /**
   * Candidates for duplicate detection.
   *
   * The pre-filter is deliberately broad (matching phone, date of birth, email or a shared name
   * token) and the precise scoring happens in the domain layer. It is capped only to bound work,
   * and the cap is reported to the caller rather than hidden.
   */
  duplicateCandidates(input: {
    name: string;
    phone: string | null;
    email: string | null;
    dobKey: string | null;
    excludeId?: string | null;
    limit?: number;
  }): { rows: DuplicateCandidateRow[]; truncated: boolean } {
    const limit = input.limit ?? 200;
    const clauses: string[] = [];
    const args: unknown[] = [];
    const phone = normalizePhone(input.phone);
    const normalized = normalizeName(input.name);
    const tokens = normalized.split(' ').filter((t) => t.length > 2);

    if (phone !== null) {
      clauses.push('phone_normalized = ?');
      args.push(phone);
    }
    if (input.dobKey) {
      clauses.push('dob_key = ?');
      args.push(input.dobKey);
    }
    if (input.email) {
      clauses.push('email = ?');
      args.push(input.email.trim().toLowerCase());
    }
    if (normalized !== '') {
      clauses.push('name_normalized = ?');
      args.push(normalized);
    }
    for (const token of tokens.slice(0, 3)) {
      clauses.push('name_normalized LIKE ?');
      args.push(`%${escapeLike(token)}%`);
    }
    if (clauses.length === 0) return { rows: [], truncated: false };

    const where = `WHERE (${clauses.join(' OR ')})${input.excludeId ? ' AND id <> ?' : ''}`;
    if (input.excludeId) args.push(input.excludeId);

    const countRow = this.db.get(`SELECT COUNT(*) AS n FROM patients ${where}`, ...args) as { n: number };
    const total = int(countRow, 'n');

    args.push(limit + 1);
    const rows = this.db.all(
      `SELECT id, patient_code AS patientCode, name, phone, email, dob_key AS dobKey
         FROM patients ${where} ORDER BY patient_code LIMIT ?`,
      ...args,
    ) as unknown as DuplicateCandidateRow[];

    const truncated = rows.length > limit;
    return { rows: truncated ? rows.slice(0, limit) : rows, truncated: total > limit };
  }

  /**
   * Allocate the next Patient Code.
   *
   * A single atomic UPDATE ... RETURNING inside the caller's transaction. Two concurrent
   * creations cannot receive the same code, because SQLite serialises the write lock.
   */
  allocatePatientCode(tx: Transaction): string {
    tx.run(
      `INSERT INTO sequences (name, next_value, updated_at) VALUES ('patient_code', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(name) DO NOTHING`,
    );
    const row = tx.get(
      `UPDATE sequences SET next_value = next_value + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE name = 'patient_code' RETURNING next_value - 1 AS allocated`,
    );
    if (!row) throw new AppError('Could not allocate a Patient Code. The sequence table is unavailable.', { code: 'INTERNAL' });
    const sequence = int(row, 'allocated');
    return formatPatientCode(sequence);
  }

  insert(tx: Transaction, patient: PatientInsert): void {
    tx.run(
      `INSERT INTO patients (
         id, patient_code, name, name_normalized, preferred_name, sex, dob_key, phone, phone_normalized,
         alternate_phone, email, address, occupation, emergency_contact_name, emergency_contact_phone,
         referral_source, tags, custom_fields, notes, medical_history, dental_history, allergies,
         current_medications, chronic_conditions, risk_information, created_by, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      patient.id,
      patient.patientCode,
      patient.name,
      normalizeName(patient.name),
      patient.preferredName,
      patient.sex,
      patient.dobKey,
      patient.phone,
      normalizePhone(patient.phone),
      patient.alternatePhone,
      patient.email,
      patient.address,
      patient.occupation,
      patient.emergencyContactName,
      patient.emergencyContactPhone,
      patient.referralSource,
      toJson(patient.tags ?? []),
      toJson(patient.customFields ?? []),
      patient.notes,
      patient.medicalHistory,
      patient.dentalHistory,
      patient.allergies,
      patient.currentMedications,
      patient.chronicConditions,
      patient.riskInformation,
      patient.createdBy,
    );
  }

  update(tx: Transaction, patient: PatientUpdate): void {
    tx.run(
      `UPDATE patients SET
         name = ?, name_normalized = ?, preferred_name = ?, sex = ?, dob_key = ?, phone = ?,
         phone_normalized = ?, alternate_phone = ?, email = ?, address = ?, occupation = ?,
         emergency_contact_name = ?, emergency_contact_phone = ?, referral_source = ?, tags = ?,
         custom_fields = ?, notes = ?, medical_history = ?, dental_history = ?, allergies = ?,
         current_medications = ?, chronic_conditions = ?, risk_information = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      patient.name,
      normalizeName(patient.name),
      patient.preferredName,
      patient.sex,
      patient.dobKey,
      patient.phone,
      normalizePhone(patient.phone),
      patient.alternatePhone,
      patient.email,
      patient.address,
      patient.occupation,
      patient.emergencyContactName,
      patient.emergencyContactPhone,
      patient.referralSource,
      toJson(patient.tags ?? []),
      toJson(patient.customFields ?? []),
      patient.notes,
      patient.medicalHistory,
      patient.dentalHistory,
      patient.allergies,
      patient.currentMedications,
      patient.chronicConditions,
      patient.riskInformation,
      patient.id,
    );
  }

  setArchived(tx: Transaction, id: string, archivedAt: string | null, reason: string | null): void {
    tx.run('UPDATE patients SET archived_at = ?, archived_reason = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?', archivedAt, reason, id);
  }

  /** Lifetime aggregate used by Patient 360. Computed in SQL so no history is truncated. */
  lifetimeSummary(patientId: string): LifetimeSummary {
    const row = this.db.get(
      `SELECT
         (SELECT COUNT(*) FROM visits WHERE patient_id = ?) AS visitCount,
         (SELECT MIN(occurred_at) FROM visits WHERE patient_id = ?) AS firstVisitAt,
         (SELECT MAX(occurred_at) FROM visits WHERE patient_id = ?) AS lastVisitAt,
         (SELECT COUNT(*) FROM prescriptions WHERE patient_id = ?) AS prescriptionCount,
         (SELECT COUNT(*) FROM appointments WHERE patient_id = ?) AS appointmentCount,
         (SELECT COUNT(*) FROM invoices WHERE patient_id = ? AND status <> 'void') AS invoiceCount,
         (SELECT COALESCE(SUM(total_minor),0) FROM invoices WHERE patient_id = ? AND status <> 'void') AS billedMinor,
         (SELECT COALESCE(SUM(paid_minor),0) FROM invoices WHERE patient_id = ? AND status <> 'void') AS paidMinor,
         (SELECT COALESCE(SUM(refunded_minor),0) FROM invoices WHERE patient_id = ? AND status <> 'void') AS refundedMinor,
         (SELECT COALESCE(SUM(adjusted_minor),0) FROM invoices WHERE patient_id = ? AND status <> 'void') AS adjustedMinor,
         (SELECT COUNT(*) FROM attachments WHERE patient_id = ?) AS attachmentCount,
         (SELECT COUNT(*) FROM follow_ups WHERE patient_id = ? AND status = 'pending') AS pendingFollowUps,
         (SELECT COUNT(*) FROM treatment_plans WHERE patient_id = ?) AS treatmentPlanCount,
         (SELECT COUNT(*) FROM referrals WHERE patient_id = ?) AS referralCount`,
      ...Array(14).fill(patientId),
    );
    if (!row) throw new AppError('Could not compute the patient summary.', { code: 'INTERNAL' });
    const billed = int(row, 'billedMinor');
    const paid = int(row, 'paidMinor');
    const refunded = int(row, 'refundedMinor');
    const adjusted = int(row, 'adjustedMinor');
    return {
      visitCount: int(row, 'visitCount'),
      firstVisitAt: strOrNull(row, 'firstVisitAt'),
      lastVisitAt: strOrNull(row, 'lastVisitAt'),
      prescriptionCount: int(row, 'prescriptionCount'),
      appointmentCount: int(row, 'appointmentCount'),
      invoiceCount: int(row, 'invoiceCount'),
      billedMinor: billed,
      paidMinor: paid,
      refundedMinor: refunded,
      adjustedMinor: adjusted,
      // outstanding = billed − paid + refunded + adjustments (invariant I2)
      outstandingMinor: billed - paid + refunded + adjusted,
      attachmentCount: int(row, 'attachmentCount'),
      pendingFollowUps: int(row, 'pendingFollowUps'),
      treatmentPlanCount: int(row, 'treatmentPlanCount'),
      referralCount: int(row, 'referralCount'),
    };
  }

  /** Duplicate Patient Code diagnostic, used by the integrity check. */
  findDuplicatePatientCodes(): { patientCode: string; count: number }[] {
    return this.db.all(
      `SELECT patient_code AS patientCode, COUNT(*) AS count FROM patients
        GROUP BY patient_code HAVING COUNT(*) > 1 ORDER BY patient_code`,
    ) as unknown as { patientCode: string; count: number }[];
  }

  /** Every patient code and id, for export. Streamed by the caller in pages. */
  allIds(): string[] {
    return this.db.all('SELECT id FROM patients ORDER BY patient_code').map((r) => str(r, 'id'));
  }
}

export interface DuplicateCandidateRow {
  id: string;
  patientCode: string;
  name: string;
  phone: string | null;
  email: string | null;
  dobKey: string | null;
}

export interface LifetimeSummary {
  visitCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  prescriptionCount: number;
  appointmentCount: number;
  invoiceCount: number;
  billedMinor: number;
  paidMinor: number;
  refundedMinor: number;
  adjustedMinor: number;
  outstandingMinor: number;
  attachmentCount: number;
  pendingFollowUps: number;
  treatmentPlanCount: number;
  referralCount: number;
}

export interface PatientInsert {
  id: string;
  patientCode: string;
  name: string;
  preferredName: string | null;
  sex: Sex;
  dobKey: string | null;
  phone: string | null;
  alternatePhone: string | null;
  email: string | null;
  address: string | null;
  occupation: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  referralSource: string | null;
  tags: string[];
  customFields: CustomField[];
  notes: string | null;
  medicalHistory: string | null;
  dentalHistory: string | null;
  allergies: string | null;
  currentMedications: string | null;
  chronicConditions: string | null;
  riskInformation: string | null;
  createdBy: string | null;
}

export type PatientUpdate = Omit<PatientInsert, 'id' | 'patientCode' | 'createdBy'> & { id: string };

/** Escape LIKE wildcards in user input so a search for "100%" does not match everything. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export { num, bool };
