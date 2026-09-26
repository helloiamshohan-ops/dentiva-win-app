/**
 * Dentiva Pro — patient service.
 *
 * Business rules for patients: field validation, duplicate detection, Patient Code allocation,
 * archiving and the Patient 360 aggregate.
 *
 * Duplicate handling is advisory by design. When a likely duplicate is found the save is
 * rejected with a structured `DUPLICATE_PATIENT` error carrying the full match list, so the
 * receptionist can review it. Patients are never merged or overwritten automatically. The caller
 * may pass `acknowledgedDuplicateOf` to confirm that the new patient is genuinely a different
 * person; that acknowledgement is recorded in the audit log.
 */

import { AppError, Errors } from '../../shared/errors';
import { newId } from '../../shared/id';
import { isDateKey, todayKey } from '../../shared/dates';
import {
  SEXES,
  isValidEmail,
  isValidPhone,
  normalizeName,
  normalizePhone,
  rankDuplicates,
  validateDateOfBirth,
  validateName,
  type DuplicateCandidateInput,
  type Sex,
} from '../../domain/patient';
import type { Database } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditService, type AuditActor } from '../audit/audit';
import {
  PatientRepository,
  type CustomField,
  type PatientListQuery,
  type PatientRow,
} from '../repositories/patient-repo';

export interface PatientInput {
  name: string;
  preferredName?: string | null;
  sex: Sex;
  dobKey?: string | null;
  phone?: string | null;
  alternatePhone?: string | null;
  email?: string | null;
  address?: string | null;
  occupation?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  referralSource?: string | null;
  tags?: string[];
  customFields?: CustomField[];
  notes?: string | null;
  medicalHistory?: string | null;
  dentalHistory?: string | null;
  allergies?: string | null;
  currentMedications?: string | null;
  chronicConditions?: string | null;
  riskInformation?: string | null;
}

export interface PatientCreateResult {
  patient: PatientRow;
  duplicates: DuplicateReview[];
}

export interface DuplicateReview {
  patientId: string;
  patientCode: string;
  name: string;
  phone: string | null;
  email: string | null;
  dobKey: string | null;
  score: number;
  signals: { field: string; description: string }[];
}

export interface PatientCreateOptions {
  /** Set when the user has reviewed the warning and confirmed this is a different person. */
  acknowledgeDuplicate?: boolean;
}

const TEXT_LIMITS = {
  preferredName: 100,
  address: 400,
  occupation: 120,
  emergencyContactName: 120,
  emergencyContactPhone: 32,
  referralSource: 200,
  notes: 5000,
  medicalHistory: 5000,
  dentalHistory: 5000,
  allergies: 2000,
  currentMedications: 2000,
  chronicConditions: 2000,
  riskInformation: 2000,
} as const;

export class PatientService {
  readonly repo: PatientRepository;

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly timeZone: () => string,
  ) {
    this.repo = new PatientRepository(db);
  }

  get(patientId: string): PatientRow {
    const patient = this.repo.findById(patientId);
    if (!patient) throw Errors.notFound('patient');
    return patient;
  }

  /** Convenience lookup used by deep links that may carry either an id or a Patient Code. */
  resolve(reference: string): PatientRow {
    if (reference.startsWith('pat_')) return this.get(reference);
    const byCode = this.repo.findByCode(reference);
    if (!byCode) throw Errors.notFound('patient');
    return byCode;
  }

  list(query: PatientListQuery): { rows: PatientRow[]; total: number } {
    return this.repo.list(query);
  }

  create(actor: AuditActor, input: PatientInput, options: PatientCreateOptions = {}): PatientCreateResult {
    const normalized = this.validate(input, true);
    const review = this.detectDuplicates(normalized, null);

    if (review.length > 0 && !options.acknowledgeDuplicate) {
      const strongest = review[0];
      throw new AppError(
        review.length === 1
          ? `A patient who may already be registered was found: ${strongest?.name} (${strongest?.patientCode}). Review it before saving, or confirm this is a different person.`
          : `${review.length} patients who may already be registered were found. Review them before saving, or confirm this is a different person.`,
        {
          code: 'DUPLICATE_PATIENT',
          details: { duplicates: review },
        },
      );
    }

    const id = newId('pat');
    const patient = this.db.transaction((tx) => {
      const patientCode = this.repo.allocatePatientCode(tx);
      this.repo.insert(tx, {
        id,
        patientCode,
        ...normalized,
        createdBy: actor.userId,
      });
      const row = tx.get('SELECT 1 AS ok FROM patients WHERE id = ?', id);
      if (!row) {
        tx.rollbackOnly('the patient row was not written');
      }
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.PATIENT_CREATED,
        entityType: 'patient',
        entityId: id,
        summary: `Registered patient ${patientCode} (${normalized.name})`,
        metadata: {
          patientCode,
          ...(options.acknowledgeDuplicate && review.length > 0
            ? { acknowledgedDuplicates: review.map((d) => d.patientCode) }
            : {}),
        },
      });
      return patientCode;
    });

    const created = this.repo.findById(id);
    if (!created) throw Errors.internal('The patient was created but could not be read back.');
    void patient;
    return { patient: created, duplicates: review };
  }

  update(actor: AuditActor, patientId: string, input: PatientInput): PatientRow {
    const existing = this.get(patientId);
    const normalized = this.validate(input, false);
    const review = this.detectDuplicates(normalized, patientId);

    this.db.transaction((tx) => {
      this.repo.update(tx, { id: patientId, ...normalized });
      const changed: string[] = [];
      for (const key of Object.keys(normalized) as (keyof typeof normalized)[]) {
        const before = existing[key as keyof PatientRow];
        const after = normalized[key];
        if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) changed.push(String(key));
      }
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.PATIENT_UPDATED,
        entityType: 'patient',
        entityId: patientId,
        summary: `Updated patient ${existing.patientCode}${changed.length > 0 ? ` (${changed.join(', ')})` : ''}`,
        metadata: { fields: changed, patientCode: existing.patientCode },
      });
    });

    return this.get(patientId);
  }

  archive(actor: AuditActor, patientId: string, reason: string): void {
    const patient = this.get(patientId);
    if (patient.archivedAt !== null) throw Errors.conflict('This patient is already archived.');
    const trimmed = reason.trim();
    if (trimmed === '' || trimmed.length > 500) {
      throw Errors.validation('Enter a reason for archiving (up to 500 characters).', {
        reason: 'Enter a reason for archiving.',
      });
    }
    this.db.transaction((tx) => {
      this.repo.setArchived(tx, patientId, new Date().toISOString(), trimmed);
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.PATIENT_ARCHIVED,
        entityType: 'patient',
        entityId: patientId,
        summary: `Archived patient ${patient.patientCode}`,
        metadata: { patientCode: patient.patientCode, reason: trimmed },
      });
    });
  }

  restore(actor: AuditActor, patientId: string): void {
    const patient = this.get(patientId);
    if (patient.archivedAt === null) throw Errors.conflict('This patient is not archived.');
    this.db.transaction((tx) => {
      this.repo.setArchived(tx, patientId, null, null);
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.PATIENT_RESTORED,
        entityType: 'patient',
        entityId: patientId,
        summary: `Restored patient ${patient.patientCode}`,
        metadata: { patientCode: patient.patientCode },
      });
    });
  }

  /**
   * Duplicate detection.
   *
   * Returns matches above the review threshold, strongest first. `candidateLimitTruncated`
   * reports whether the SQL pre-filter matched more rows than were scored, so the UI can say so
   * instead of implying the list is complete when it is not.
   */
  detectDuplicates(
    input: { name: string; phone: string | null; email: string | null; dobKey: string | null },
    excludeId: string | null,
  ): DuplicateReview[] {
    const { rows, truncated } = this.repo.duplicateCandidates({
      name: input.name,
      phone: input.phone,
      email: input.email,
      dobKey: input.dobKey,
      ...(excludeId ? { excludeId } : {}),
    });
    const candidates: DuplicateCandidateInput[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      dobKey: r.dobKey,
      patientCode: r.patientCode,
    }));
    const matches = rankDuplicates(input, candidates);
    if (truncated && matches.length > 0) {
      // Surface the truncation without inventing matches.
      matches[matches.length - 1] = {
        ...matches[matches.length - 1]!,
        signals: [
          ...matches[matches.length - 1]!.signals,
          { field: 'search', weight: 0, description: 'More possible matches exist; narrow the search to review them all.' },
        ],
      };
    }
    return matches.map((m) => ({
      patientId: m.candidate.id,
      patientCode: m.candidate.patientCode,
      name: m.candidate.name,
      phone: m.candidate.phone,
      email: m.candidate.email,
      dobKey: m.candidate.dobKey,
      score: m.score,
      signals: m.signals.map((s) => ({ field: s.field, description: s.description })),
    }));
  }

  /** Validate and normalise every patient field. Rejects rather than silently coercing. */
  private validate(input: PatientInput, isCreate: boolean): NormalizedPatient {
    void isCreate;
    const fieldErrors: Record<string, string> = {};
    const name = (() => {
      try {
        return validateName(input.name, 'Patient name');
      } catch (error) {
        fieldErrors.name = error instanceof Error ? error.message : 'Enter a valid name.';
        return '';
      }
    })();

    if (!(SEXES as readonly string[]).includes(input.sex)) {
      fieldErrors.sex = 'Select a valid option.';
    }

    const today = todayKey(this.timeZone());
    let dobKey: string | null = null;
    try {
      dobKey = validateDateOfBirth(input.dobKey ?? null, today);
    } catch (error) {
      fieldErrors.dobKey = error instanceof Error ? error.message : 'Enter a valid date of birth.';
    }

    const phone = textOrNull(input.phone, 'phone', 32, fieldErrors);
    if (phone !== null && !isValidPhone(phone)) fieldErrors.phone = 'Enter a valid phone number.';
    const alternatePhone = textOrNull(input.alternatePhone, 'alternatePhone', 32, fieldErrors);
    if (alternatePhone !== null && !isValidPhone(alternatePhone)) {
      fieldErrors.alternatePhone = 'Enter a valid phone number.';
    }
    if (phone !== null && alternatePhone !== null && normalizePhone(phone) === normalizePhone(alternatePhone)) {
      fieldErrors.alternatePhone = 'The alternate phone number is the same as the primary number.';
    }

    const email = textOrNull(input.email, 'email', 200, fieldErrors);
    if (email !== null && !isValidEmail(email)) fieldErrors.email = 'Enter a valid email address.';

    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((t) => String(t).trim()).filter((t) => t !== ''))].slice(0, 50)
      : [];
    if (tags.some((t) => t.length > 40)) fieldErrors.tags = 'Each tag must be 40 characters or fewer.';

    const customFields: CustomField[] = Array.isArray(input.customFields)
      ? input.customFields
          .map((f) => ({ label: String(f?.label ?? '').trim().slice(0, 60), value: String(f?.value ?? '').trim().slice(0, 500) }))
          .filter((f) => f.label !== '')
          .slice(0, 30)
      : [];

    if (Object.keys(fieldErrors).length > 0) {
      throw Errors.validation('Some patient details need attention before this record can be saved.', fieldErrors);
    }

    const preferredName = textOrNull(input.preferredName, 'preferredName', TEXT_LIMITS.preferredName, fieldErrors);

    return {
      name,
      sex: input.sex,
      preferredName,
      dobKey,
      phone,
      alternatePhone,
      email,
      address: textOrNull(input.address, 'address', TEXT_LIMITS.address, fieldErrors),
      occupation: textOrNull(input.occupation, 'occupation', TEXT_LIMITS.occupation, fieldErrors),
      emergencyContactName: textOrNull(input.emergencyContactName, 'emergencyContactName', TEXT_LIMITS.emergencyContactName, fieldErrors),
      emergencyContactPhone: textOrNull(input.emergencyContactPhone, 'emergencyContactPhone', TEXT_LIMITS.emergencyContactPhone, fieldErrors),
      referralSource: textOrNull(input.referralSource, 'referralSource', TEXT_LIMITS.referralSource, fieldErrors),
      tags,
      customFields,
      notes: textOrNull(input.notes, 'notes', TEXT_LIMITS.notes, fieldErrors),
      medicalHistory: textOrNull(input.medicalHistory, 'medicalHistory', TEXT_LIMITS.medicalHistory, fieldErrors),
      dentalHistory: textOrNull(input.dentalHistory, 'dentalHistory', TEXT_LIMITS.dentalHistory, fieldErrors),
      allergies: textOrNull(input.allergies, 'allergies', TEXT_LIMITS.allergies, fieldErrors),
      currentMedications: textOrNull(input.currentMedications, 'currentMedications', TEXT_LIMITS.currentMedications, fieldErrors),
      chronicConditions: textOrNull(input.chronicConditions, 'chronicConditions', TEXT_LIMITS.chronicConditions, fieldErrors),
      riskInformation: textOrNull(input.riskInformation, 'riskInformation', TEXT_LIMITS.riskInformation, fieldErrors),
    };
  }

  /** Lifetime summary for Patient 360. Every value is derived from persisted rows. */
  summary(patientId: string) {
    const patient = this.get(patientId);
    return { patient, lifetime: this.repo.lifetimeSummary(patientId) };
  }

  /**
   * Quick clinical header used across screens so the patient context is never re-typed and never
   * silently changes: callers pass the id they already hold.
   */
  header(patientId: string): { id: string; patientCode: string; name: string; sex: Sex; dobKey: string | null; archived: boolean } {
    const patient = this.get(patientId);
    return {
      id: patient.id,
      patientCode: patient.patientCode,
      name: patient.name,
      sex: patient.sex,
      dobKey: patient.dobKey,
      archived: patient.archivedAt !== null,
    };
  }
}

/** Fully validated patient fields. Optional strings are resolved to `string | null`. */
export interface NormalizedPatient {
  name: string;
  sex: Sex;
  preferredName: string | null;
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
}

function textOrNull(
  value: unknown,
  field: string,
  maxLength: number,
  fieldErrors: Record<string, string>,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim().replace(/\s+/g, ' ');
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    fieldErrors[field] = `Use ${maxLength} characters or fewer.`;
    return trimmed.slice(0, maxLength);
  }
  return trimmed;
}

export { isDateKey };
