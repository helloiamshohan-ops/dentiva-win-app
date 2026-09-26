/**
 * Dentiva Pro — clinical service (visits, dental chart, prescriptions, treatment plans,
 * follow-ups, referrals, patient notes).
 *
 * Clinical rules enforced here:
 *   - A visit is written in one transaction. Editing one visit can never mutate another: every
 *     statement is keyed by the visit id and the child rows are replaced as a set.
 *   - Recording procedures on a visit does NOT create an invoice. Billing is a separate,
 *     explicit action, so a clinician documenting treatment cannot accidentally charge a patient.
 *   - A prescription is an independent clinical record containing no financial data at all.
 *   - The dental chart keeps history: superseding a tooth condition marks the previous row
 *     superseded rather than deleting it.
 */

import { AppError, Errors } from '../../shared/errors';
import { newId } from '../../shared/id';
import { isDateKey, toIso, todayKey } from '../../shared/dates';
import {
  TOOTH_STATES,
  TOOTH_SURFACES,
  isToothNumber,
  parseToothReferences,
  type ToothState,
  type ToothSurface,
} from '../../domain/dental';
import {
  ADVICE_MAX,
  FOOD_RELATIONS,
  MEDICINE_FORMS,
  MEDICINE_NAME_MAX,
  MEDICINE_TEXT_MAX,
  isValidKey,
  type ClinicalFinding,
  type FoodRelation,
  type MedicineForm,
  type MedicineInput,
} from '../../domain/prescription';
import type { Database, Transaction } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';
import { int, json, str, strOrNull, toJson } from '../repositories/row';

// ── Visits ────────────────────────────────────────────────────────────────────────────────

export interface VisitProcedureInput {
  treatmentId?: string | null;
  toothNumber?: number | null;
  description: string;
  note?: string | null;
}

export interface VisitInput {
  patientId: string;
  dentistId?: string | null;
  appointmentId?: string | null;
  queueEntryId?: string | null;
  occurredAtIso?: string | null;
  chiefComplaint?: string | null;
  reason?: string | null;
  symptoms?: string | null;
  examination?: string | null;
  diagnosis?: string | null;
  treatmentPlanText?: string | null;
  treatmentPerformed?: string | null;
  toothReferences?: string | null;
  procedures?: VisitProcedureInput[];
  anesthesia?: string | null;
  medications?: string | null;
  advice?: string | null;
  referralNote?: string | null;
  followUpDateKey?: string | null;
  followUpNote?: string | null;
  notes?: string | null;
}

export interface VisitProcedureRow {
  id: string;
  treatmentId: string | null;
  treatmentName: string | null;
  toothNumber: number | null;
  description: string;
  note: string | null;
  orderIndex: number;
}

export interface VisitRow {
  id: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  dentistId: string | null;
  dentistName: string | null;
  appointmentId: string | null;
  queueEntryId: string | null;
  occurredAt: string;
  chiefComplaint: string | null;
  reason: string | null;
  symptoms: string | null;
  examination: string | null;
  diagnosis: string | null;
  treatmentPlanText: string | null;
  treatmentPerformed: string | null;
  toothNumbers: number[];
  procedures: VisitProcedureRow[];
  anesthesia: string | null;
  medications: string | null;
  advice: string | null;
  referralNote: string | null;
  followUpDateKey: string | null;
  followUpNote: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Prescriptions ─────────────────────────────────────────────────────────────────────────

export interface PrescriptionInput {
  patientId: string;
  dentistId?: string | null;
  visitId?: string | null;
  issuedAtIso?: string | null;
  chiefComplaints?: ClinicalFinding[];
  onExamination?: ClinicalFinding[];
  radiologyExamination?: string | null;
  advice?: string | null;
  notes?: string | null;
  medicines: MedicineInput[];
}

export interface MedicineRow {
  id: string;
  orderIndex: number;
  name: string;
  form: MedicineForm;
  customForm: string | null;
  strength: string | null;
  dose: string | null;
  frequency: string | null;
  duration: string | null;
  timing: string | null;
  foodRelation: FoodRelation | null;
  route: string | null;
  customInstructions: string | null;
  notes: string | null;
}

export interface PrescriptionRow {
  id: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  patientSex: string;
  patientDobKey: string | null;
  dentistId: string | null;
  dentistName: string | null;
  dentistCredentials: string | null;
  dentistDesignation: string | null;
  dentistRegistrationNo: string | null;
  visitId: string | null;
  issuedAt: string;
  chiefComplaints: ClinicalFinding[];
  onExamination: ClinicalFinding[];
  radiologyExamination: string | null;
  advice: string | null;
  notes: string | null;
  medicines: MedicineRow[];
  createdAt: string;
  updatedAt: string;
}

// ── Dental chart ──────────────────────────────────────────────────────────────────────────

export interface ToothConditionInput {
  toothNumber: number;
  state: ToothState;
  surfaces?: ToothSurface[];
  note?: string | null;
  visitId?: string | null;
}

export interface ToothConditionRow {
  id: string;
  toothNumber: number;
  state: ToothState;
  surfaces: ToothSurface[];
  note: string | null;
  visitId: string | null;
  recordedAt: string;
  supersededAt: string | null;
}

export class ClinicalService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly timeZone: () => string,
  ) {}

  // ── Visits ──────────────────────────────────────────────────────────────────────────────

  createVisit(actor: AuditActor, input: VisitInput): VisitRow {
    const normalized = this.normalizeVisit(input);
    const visitId = newId('vis');

    this.db.transaction((tx) => {
      this.assertPatient(tx, normalized.patientId);
      if (normalized.dentistId) this.assertDentist(tx, normalized.dentistId);
      tx.run(
        `INSERT INTO visits (id, patient_id, dentist_id, appointment_id, queue_entry_id, occurred_at,
             chief_complaint, reason, symptoms, examination, diagnosis, treatment_plan_text,
             treatment_performed, tooth_numbers, procedures, anesthesia, medications, advice,
             referral_note, follow_up_date_key, follow_up_note, notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        visitId,
        normalized.patientId,
        normalized.dentistId,
        normalized.appointmentId,
        normalized.queueEntryId,
        normalized.occurredAtIso,
        normalized.chiefComplaint,
        normalized.reason,
        normalized.symptoms,
        normalized.examination,
        normalized.diagnosis,
        normalized.treatmentPlanText,
        normalized.treatmentPerformed,
        toJson(normalized.toothNumbers),
        toJson(normalized.procedures.map((p) => p.description)),
        normalized.anesthesia,
        normalized.medications,
        normalized.advice,
        normalized.referralNote,
        normalized.followUpDateKey,
        normalized.followUpNote,
        normalized.notes,
        actor.userId,
      );
      normalized.procedures.forEach((procedure, index) => {
        tx.run(
          `INSERT INTO visit_procedures (id, visit_id, treatment_id, tooth_number, description, note, order_index)
           VALUES (?,?,?,?,?,?,?)`,
          newId('vpr'),
          visitId,
          procedure.treatmentId ?? null,
          procedure.toothNumber ?? null,
          procedure.description,
          procedure.note ?? null,
          index,
        );
      });
      // Link the appointment and queue entry so the workflow stays connected.
      if (normalized.appointmentId) {
        tx.run(
          `UPDATE appointments SET status = 'completed', visit_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ? AND status IN ('scheduled','confirmed','arrived','in_progress')`,
          visitId,
          normalized.appointmentId,
        );
      }
      if (normalized.queueEntryId) {
        tx.run(
          `UPDATE queue_entries SET status = 'completed', visit_id = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ? AND status IN ('waiting','called','in_progress')`,
          visitId,
          normalized.queueEntryId,
        );
      }
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.VISIT_CREATED,
        entityType: 'visit',
        entityId: visitId,
        summary: 'Recorded a visit',
        metadata: { patientId: normalized.patientId, procedureCount: normalized.procedures.length },
      });
    });

    return this.getVisit(visitId);
  }

  updateVisit(actor: AuditActor, visitId: string, input: VisitInput): VisitRow {
    const existing = this.getVisit(visitId);
    const normalized = this.normalizeVisit({ ...input, patientId: input.patientId || existing.patientId });

    this.db.transaction((tx) => {
      tx.run(
        `UPDATE visits SET patient_id = ?, dentist_id = ?, occurred_at = ?, chief_complaint = ?, reason = ?,
             symptoms = ?, examination = ?, diagnosis = ?, treatment_plan_text = ?, treatment_performed = ?,
             tooth_numbers = ?, procedures = ?, anesthesia = ?, medications = ?, advice = ?, referral_note = ?,
             follow_up_date_key = ?, follow_up_note = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        normalized.patientId,
        normalized.dentistId,
        normalized.occurredAtIso,
        normalized.chiefComplaint,
        normalized.reason,
        normalized.symptoms,
        normalized.examination,
        normalized.diagnosis,
        normalized.treatmentPlanText,
        normalized.treatmentPerformed,
        toJson(normalized.toothNumbers),
        toJson(normalized.procedures.map((p) => p.description)),
        normalized.anesthesia,
        normalized.medications,
        normalized.advice,
        normalized.referralNote,
        normalized.followUpDateKey,
        normalized.followUpNote,
        normalized.notes,
        visitId,
      );
      // Replace the procedure set for THIS visit only. The WHERE clause is the visit id, so no
      // other visit's rows can be touched.
      tx.run('DELETE FROM visit_procedures WHERE visit_id = ?', visitId);
      normalized.procedures.forEach((procedure, index) => {
        tx.run(
          `INSERT INTO visit_procedures (id, visit_id, treatment_id, tooth_number, description, note, order_index)
           VALUES (?,?,?,?,?,?,?)`,
          newId('vpr'),
          visitId,
          procedure.treatmentId ?? null,
          procedure.toothNumber ?? null,
          procedure.description,
          procedure.note ?? null,
          index,
        );
      });
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.VISIT_UPDATED,
        entityType: 'visit',
        entityId: visitId,
        summary: 'Updated a visit',
        metadata: { patientId: normalized.patientId, procedureCount: normalized.procedures.length },
      });
    });

    return this.getVisit(visitId);
  }

  getVisit(visitId: string): VisitRow {
    const row = this.db.get(
      `SELECT v.id, v.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              v.dentist_id AS dentistId, d.name AS dentistName, v.appointment_id AS appointmentId,
              v.queue_entry_id AS queueEntryId, v.occurred_at AS occurredAt, v.chief_complaint AS chiefComplaint,
              v.reason, v.symptoms, v.examination, v.diagnosis, v.treatment_plan_text AS treatmentPlanText,
              v.treatment_performed AS treatmentPerformed, v.tooth_numbers AS toothNumbers, v.anesthesia,
              v.medications, v.advice, v.referral_note AS referralNote, v.follow_up_date_key AS followUpDateKey,
              v.follow_up_note AS followUpNote, v.notes, v.created_at AS createdAt, v.updated_at AS updatedAt
         FROM visits v
         JOIN patients p ON p.id = v.patient_id
         LEFT JOIN dentists d ON d.id = v.dentist_id
        WHERE v.id = ?`,
      visitId,
    );
    if (!row) throw Errors.notFound('visit');
    const visit = mapVisit(row);
    visit.procedures = this.visitProcedures(visitId);
    return visit;
  }

  visitProcedures(visitId: string): VisitProcedureRow[] {
    return this.db
      .all(
        `SELECT vp.id, vp.treatment_id AS treatmentId, t.name AS treatmentName, vp.tooth_number AS toothNumber,
                vp.description, vp.note, vp.order_index AS orderIndex
           FROM visit_procedures vp LEFT JOIN treatments t ON t.id = vp.treatment_id
          WHERE vp.visit_id = ? ORDER BY vp.order_index, vp.id`,
        visitId,
      )
      .map((row) => ({
        id: str(row, 'id'),
        treatmentId: strOrNull(row, 'treatmentId'),
        treatmentName: strOrNull(row, 'treatmentName'),
        toothNumber: row.toothNumber === null || row.toothNumber === undefined ? null : int(row, 'toothNumber'),
        description: str(row, 'description'),
        note: strOrNull(row, 'note'),
        orderIndex: int(row, 'orderIndex'),
      }));
  }

  listVisits(params: { patientId?: string | null; fromIso?: string | null; toIso?: string | null; limit: number; offset: number }): {
    rows: VisitRow[];
    total: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.patientId) {
      clauses.push('v.patient_id = ?');
      args.push(params.patientId);
    }
    if (params.fromIso) {
      clauses.push('v.occurred_at >= ?');
      args.push(params.fromIso);
    }
    if (params.toIso) {
      clauses.push('v.occurred_at <= ?');
      args.push(params.toIso);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM visits v ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT v.id, v.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              v.dentist_id AS dentistId, d.name AS dentistName, v.appointment_id AS appointmentId,
              v.queue_entry_id AS queueEntryId, v.occurred_at AS occurredAt, v.chief_complaint AS chiefComplaint,
              v.reason, v.symptoms, v.examination, v.diagnosis, v.treatment_plan_text AS treatmentPlanText,
              v.treatment_performed AS treatmentPerformed, v.tooth_numbers AS toothNumbers, v.anesthesia,
              v.medications, v.advice, v.referral_note AS referralNote, v.follow_up_date_key AS followUpDateKey,
              v.follow_up_note AS followUpNote, v.notes, v.created_at AS createdAt, v.updated_at AS updatedAt
         FROM visits v JOIN patients p ON p.id = v.patient_id LEFT JOIN dentists d ON d.id = v.dentist_id
         ${where} ORDER BY v.occurred_at DESC, v.id DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return { rows: rows.map(mapVisit), total: int(totalRow, 'n') };
  }

  // ── Dental chart ────────────────────────────────────────────────────────────────────────

  chart(patientId: string): ToothConditionRow[] {
    this.assertPatientById(patientId);
    return this.db
      .all(
        `SELECT id, tooth_number AS toothNumber, state, surfaces, note, visit_id AS visitId,
                recorded_at AS recordedAt, superseded_at AS supersededAt
           FROM dental_chart_entries
          WHERE patient_id = ? AND superseded_at IS NULL
          ORDER BY tooth_number`,
        patientId,
      )
      .map(mapToothCondition);
  }

  chartHistory(patientId: string, toothNumber: number): ToothConditionRow[] {
    if (!isToothNumber(toothNumber)) throw Errors.validation('That tooth number is not valid.', { toothNumber: 'Select a valid tooth.' });
    return this.db
      .all(
        `SELECT id, tooth_number AS toothNumber, state, surfaces, note, visit_id AS visitId,
                recorded_at AS recordedAt, superseded_at AS supersededAt
           FROM dental_chart_entries
          WHERE patient_id = ? AND tooth_number = ?
          ORDER BY recorded_at DESC`,
        patientId,
        toothNumber,
      )
      .map(mapToothCondition);
  }

  recordToothConditions(actor: AuditActor, patientId: string, conditions: ToothConditionInput[]): ToothConditionRow[] {
    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw Errors.validation('Select at least one tooth to record.', { conditions: 'Select at least one tooth.' });
    }
    this.assertPatientById(patientId);
    const validated = conditions.map((condition) => {
      if (!isToothNumber(condition.toothNumber)) {
        throw Errors.validation(`Tooth ${condition.toothNumber} is not a valid FDI tooth number.`, {
          toothNumber: 'Select a valid tooth.',
        });
      }
      if (!(TOOTH_STATES as readonly string[]).includes(condition.state)) {
        throw Errors.validation(`"${condition.state}" is not a valid tooth state.`, { state: 'Select a valid state.' });
      }
      const surfaces = (condition.surfaces ?? []).filter((s): s is ToothSurface => (TOOTH_SURFACES as readonly string[]).includes(s));
      const note = (condition.note ?? '').trim();
      if (note.length > 500) throw Errors.validation('Tooth notes must be 500 characters or fewer.', { note: 'Use 500 characters or fewer.' });
      return {
        toothNumber: condition.toothNumber,
        state: condition.state,
        surfaces: [...new Set(surfaces)],
        note: note === '' ? null : note,
        visitId: condition.visitId ?? null,
      };
    });

    const recordedAt = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const condition of validated) {
        // Supersede the previous current condition for this tooth; history is preserved.
        tx.run(
          `UPDATE dental_chart_entries SET superseded_at = ?
            WHERE patient_id = ? AND tooth_number = ? AND superseded_at IS NULL`,
          recordedAt,
          patientId,
          condition.toothNumber,
        );
        tx.run(
          `INSERT INTO dental_chart_entries (id, patient_id, tooth_number, state, surfaces, note, visit_id,
               recorded_by, recorded_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          newId('cht'),
          patientId,
          condition.toothNumber,
          condition.state,
          toJson(condition.surfaces),
          condition.note,
          condition.visitId,
          actor.userId,
          recordedAt,
        );
      }
      this.audit.record(actor, {
        action: 'chart.updated',
        entityType: 'patient',
        entityId: patientId,
        summary: `Updated the dental chart (${validated.length} tooth/teeth)`,
        metadata: { teeth: validated.map((c) => c.toothNumber) },
      });
    });

    return this.chart(patientId);
  }

  // ── Prescriptions ───────────────────────────────────────────────────────────────────────

  createPrescription(actor: AuditActor, input: PrescriptionInput): PrescriptionRow {
    const normalized = this.normalizePrescription(input);
    const prescriptionId = newId('prx');

    this.db.transaction((tx) => {
      this.assertPatient(tx, normalized.patientId);
      if (normalized.dentistId) this.assertDentist(tx, normalized.dentistId);
      tx.run(
        `INSERT INTO prescriptions (id, patient_id, dentist_id, visit_id, issued_at, chief_complaints,
             on_examination, radiology_examination, advice, notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        prescriptionId,
        normalized.patientId,
        normalized.dentistId,
        normalized.visitId,
        normalized.issuedAtIso,
        toJson(normalized.chiefComplaints),
        toJson(normalized.onExamination),
        normalized.radiologyExamination,
        normalized.advice,
        normalized.notes,
        actor.userId,
      );
      normalized.medicines.forEach((medicine, index) => {
        tx.run(
          `INSERT INTO prescription_medicines (id, prescription_id, order_index, name, form, strength, dose,
               frequency, duration, timing, food_relation, route, custom_instructions, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          newId('prm'),
          prescriptionId,
          index,
          medicine.name,
          medicine.form,
          medicine.strength,
          medicine.dose,
          medicine.frequency,
          medicine.duration,
          medicine.timing,
          medicine.foodRelation,
          medicine.route,
          medicine.customInstructions,
          medicine.notes,
        );
      });
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.PRESCRIPTION_CREATED,
        entityType: 'prescription',
        entityId: prescriptionId,
        summary: `Issued a prescription with ${normalized.medicines.length} medicine(s)`,
        metadata: { patientId: normalized.patientId, medicineCount: normalized.medicines.length },
      });
    });

    return this.getPrescription(prescriptionId);
  }

  updatePrescription(actor: AuditActor, prescriptionId: string, input: PrescriptionInput): PrescriptionRow {
    const existing = this.getPrescription(prescriptionId);
    const normalized = this.normalizePrescription({ ...input, patientId: input.patientId || existing.patientId });

    this.db.transaction((tx) => {
      tx.run(
        `UPDATE prescriptions SET dentist_id = ?, visit_id = ?, issued_at = ?, chief_complaints = ?,
             on_examination = ?, radiology_examination = ?, advice = ?, notes = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        normalized.dentistId,
        normalized.visitId,
        normalized.issuedAtIso,
        toJson(normalized.chiefComplaints),
        toJson(normalized.onExamination),
        normalized.radiologyExamination,
        normalized.advice,
        normalized.notes,
        prescriptionId,
      );
      tx.run('DELETE FROM prescription_medicines WHERE prescription_id = ?', prescriptionId);
      normalized.medicines.forEach((medicine, index) => {
        tx.run(
          `INSERT INTO prescription_medicines (id, prescription_id, order_index, name, form, strength, dose,
               frequency, duration, timing, food_relation, route, custom_instructions, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          newId('prm'),
          prescriptionId,
          index,
          medicine.name,
          medicine.form,
          medicine.strength,
          medicine.dose,
          medicine.frequency,
          medicine.duration,
          medicine.timing,
          medicine.foodRelation,
          medicine.route,
          medicine.customInstructions,
          medicine.notes,
        );
      });
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.PRESCRIPTION_UPDATED,
        entityType: 'prescription',
        entityId: prescriptionId,
        summary: `Updated a prescription (${normalized.medicines.length} medicine(s))`,
      });
    });

    return this.getPrescription(prescriptionId);
  }

  getPrescription(prescriptionId: string): PrescriptionRow {
    const row = this.db.get(
      `SELECT rx.id, rx.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              p.sex AS patientSex, p.dob_key AS patientDobKey, rx.dentist_id AS dentistId, d.name AS dentistName,
              d.credentials AS dentistCredentials, d.designation AS dentistDesignation,
              d.registration_no AS dentistRegistrationNo, rx.visit_id AS visitId, rx.issued_at AS issuedAt,
              rx.chief_complaints AS chiefComplaints, rx.on_examination AS onExamination,
              rx.radiology_examination AS radiologyExamination, rx.advice, rx.notes,
              rx.created_at AS createdAt, rx.updated_at AS updatedAt
         FROM prescriptions rx
         JOIN patients p ON p.id = rx.patient_id
         LEFT JOIN dentists d ON d.id = rx.dentist_id
        WHERE rx.id = ?`,
      prescriptionId,
    );
    if (!row) throw Errors.notFound('prescription');
    const prescription: PrescriptionRow = {
      id: str(row, 'id'),
      patientId: str(row, 'patientId'),
      patientCode: str(row, 'patientCode'),
      patientName: str(row, 'patientName'),
      patientSex: str(row, 'patientSex'),
      patientDobKey: strOrNull(row, 'patientDobKey'),
      dentistId: strOrNull(row, 'dentistId'),
      dentistName: strOrNull(row, 'dentistName'),
      dentistCredentials: strOrNull(row, 'dentistCredentials'),
      dentistDesignation: strOrNull(row, 'dentistDesignation'),
      dentistRegistrationNo: strOrNull(row, 'dentistRegistrationNo'),
      visitId: strOrNull(row, 'visitId'),
      issuedAt: str(row, 'issuedAt'),
      chiefComplaints: json<ClinicalFinding[]>(row, 'chiefComplaints', []),
      onExamination: json<ClinicalFinding[]>(row, 'onExamination', []),
      radiologyExamination: strOrNull(row, 'radiologyExamination'),
      advice: strOrNull(row, 'advice'),
      notes: strOrNull(row, 'notes'),
      medicines: [],
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
    prescription.medicines = this.db
      .all(
        `SELECT id, order_index AS orderIndex, name, form, strength, dose, frequency, duration, timing,
                food_relation AS foodRelation, route, custom_instructions AS customInstructions, notes
           FROM prescription_medicines WHERE prescription_id = ? ORDER BY order_index, id`,
        prescriptionId,
      )
      .map((medicineRow) => ({
        id: str(medicineRow, 'id'),
        orderIndex: int(medicineRow, 'orderIndex'),
        name: str(medicineRow, 'name'),
        form: String(medicineRow.form) as MedicineForm,
        customForm: null,
        strength: strOrNull(medicineRow, 'strength'),
        dose: strOrNull(medicineRow, 'dose'),
        frequency: strOrNull(medicineRow, 'frequency'),
        duration: strOrNull(medicineRow, 'duration'),
        timing: strOrNull(medicineRow, 'timing'),
        foodRelation: (strOrNull(medicineRow, 'foodRelation') as FoodRelation | null),
        route: strOrNull(medicineRow, 'route'),
        customInstructions: strOrNull(medicineRow, 'customInstructions'),
        notes: strOrNull(medicineRow, 'notes'),
      }));
    return prescription;
  }

  listPrescriptions(params: { patientId?: string | null; limit: number; offset: number }): { rows: PrescriptionRow[]; total: number } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.patientId) {
      clauses.push('rx.patient_id = ?');
      args.push(params.patientId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM prescriptions rx ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT rx.id, rx.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              p.sex AS patientSex, p.dob_key AS patientDobKey, rx.dentist_id AS dentistId, d.name AS dentistName,
              d.credentials AS dentistCredentials, d.designation AS dentistDesignation,
              d.registration_no AS dentistRegistrationNo, rx.visit_id AS visitId, rx.issued_at AS issuedAt,
              rx.chief_complaints AS chiefComplaints, rx.on_examination AS onExamination,
              rx.radiology_examination AS radiologyExamination, rx.advice, rx.notes,
              rx.created_at AS createdAt, rx.updated_at AS updatedAt
         FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id LEFT JOIN dentists d ON d.id = rx.dentist_id
         ${where} ORDER BY rx.issued_at DESC, rx.id DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => {
        const prescription = this.getPrescription(str(r, 'id'));
        return prescription;
      }),
      total: int(totalRow, 'n'),
    };
  }

  // ── Follow-ups, referrals, notes ────────────────────────────────────────────────────────

  createFollowUp(actor: AuditActor, input: { patientId: string; visitId?: string | null; dueDateKey: string; reason?: string | null }): void {
    if (!isDateKey(input.dueDateKey)) throw Errors.validation('Enter a valid follow-up date.', { dueDateKey: 'Enter a valid date.' });
    this.assertPatientById(input.patientId);
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO follow_ups (id, patient_id, visit_id, due_date_key, reason, status, created_by, created_at)
         VALUES (?,?,?,?,?,'pending',?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        newId('fol'),
        input.patientId,
        input.visitId ?? null,
        input.dueDateKey,
        textOrNull(input.reason, 300),
        actor.userId,
      );
      this.audit.record(actor, {
        action: 'followup.created',
        entityType: 'patient',
        entityId: input.patientId,
        summary: `Scheduled a follow-up for ${input.dueDateKey}`,
      });
    });
  }

  completeFollowUp(actor: AuditActor, followUpId: string): void {
    this.db.transaction((tx) => {
      const row = tx.get('SELECT patient_id AS patientId, status FROM follow_ups WHERE id = ?', followUpId);
      if (!row) throw Errors.notFound('follow-up');
      if (String(row.status) === 'completed') throw Errors.conflict('This follow-up is already marked complete.');
      tx.run(
        `UPDATE follow_ups SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        followUpId,
      );
      this.audit.record(actor, {
        action: 'followup.completed',
        entityType: 'patient',
        entityId: String(row.patientId),
        summary: 'Marked a follow-up complete',
      });
    });
  }

  listFollowUps(params: { patientId?: string | null; status?: 'pending' | 'completed' | 'all'; dueBy?: string | null; limit: number; offset: number }): {
    rows: FollowUpRow[];
    total: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.patientId) {
      clauses.push('f.patient_id = ?');
      args.push(params.patientId);
    }
    if (params.status && params.status !== 'all') {
      clauses.push('f.status = ?');
      args.push(params.status);
    }
    if (params.dueBy) {
      clauses.push('f.due_date_key <= ?');
      args.push(params.dueBy);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM follow_ups f ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT f.id, f.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              f.visit_id AS visitId, f.due_date_key AS dueDateKey, f.reason, f.status, f.completed_at AS completedAt
         FROM follow_ups f JOIN patients p ON p.id = f.patient_id ${where}
        ORDER BY f.due_date_key, f.id LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        patientId: str(r, 'patientId'),
        patientCode: str(r, 'patientCode'),
        patientName: str(r, 'patientName'),
        visitId: strOrNull(r, 'visitId'),
        dueDateKey: str(r, 'dueDateKey'),
        reason: strOrNull(r, 'reason'),
        status: String(r.status) as 'pending' | 'completed' | 'cancelled',
        completedAt: strOrNull(r, 'completedAt'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  createReferral(
    actor: AuditActor,
    input: { patientId: string; visitId?: string | null; toName: string; toSpecialty?: string | null; toContact?: string | null; reason?: string | null },
  ): void {
    const toName = (input.toName ?? '').trim();
    if (toName === '' || toName.length > 150) {
      throw Errors.validation('Enter who the patient is being referred to.', { toName: 'Enter a name.' });
    }
    this.assertPatientById(input.patientId);
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO referrals (id, patient_id, visit_id, to_name, to_specialty, to_contact, reason,
             referred_at, status, created_by, created_at)
         VALUES (?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'referred', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        newId('ref'),
        input.patientId,
        input.visitId ?? null,
        toName,
        textOrNull(input.toSpecialty, 120),
        textOrNull(input.toContact, 120),
        textOrNull(input.reason, 1000),
        actor.userId,
      );
      this.audit.record(actor, {
        action: 'referral.created',
        entityType: 'patient',
        entityId: input.patientId,
        summary: `Referred the patient to ${toName}`,
      });
    });
  }

  listReferrals(patientId: string): ReferralRow[] {
    return this.db
      .all(
        `SELECT id, to_name AS toName, to_specialty AS toSpecialty, to_contact AS toContact, reason,
                referred_at AS referredAt, status
           FROM referrals WHERE patient_id = ? ORDER BY referred_at DESC, id DESC`,
        patientId,
      )
      .map((r) => ({
        id: str(r, 'id'),
        toName: str(r, 'toName'),
        toSpecialty: strOrNull(r, 'toSpecialty'),
        toContact: strOrNull(r, 'toContact'),
        reason: strOrNull(r, 'reason'),
        referredAt: str(r, 'referredAt'),
        status: String(r.status),
      }));
  }

  addNote(actor: AuditActor, patientId: string, body: string, pinned = false): void {
    const trimmed = body.trim();
    if (trimmed === '' || trimmed.length > 5000) {
      throw Errors.validation('Enter a note of up to 5000 characters.', { body: 'Enter a note.' });
    }
    this.assertPatientById(patientId);
    this.db.run(
      `INSERT INTO patient_notes (id, patient_id, body, pinned, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      newId('nte'),
      patientId,
      trimmed,
      pinned ? 1 : 0,
      actor.userId,
    );
  }

  listNotes(patientId: string, limit = 200, offset = 0): { rows: NoteRow[]; total: number } {
    const totalRow = this.db.get('SELECT COUNT(*) AS n FROM patient_notes WHERE patient_id = ?', patientId) as { n: number };
    const rows = this.db.all(
      `SELECT n.id, n.body, n.pinned, n.created_at AS createdAt, u.display_name AS authorName
         FROM patient_notes n LEFT JOIN users u ON u.id = n.created_by
        WHERE n.patient_id = ? ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
      patientId,
      limit,
      offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        body: str(r, 'body'),
        pinned: Number(r.pinned) === 1,
        createdAt: str(r, 'createdAt'),
        authorName: strOrNull(r, 'authorName'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  /**
   * Chronological clinical timeline for Patient 360.
   *
   * Built with a UNION over the real event tables and ordered deterministically in SQL. Nothing is
   * truncated at the source: the caller pages with limit/offset and receives the true total.
   */
  timeline(patientId: string, limit: number, offset: number): { rows: TimelineEntry[]; total: number } {
    this.assertPatientById(patientId);
    const union = `
      SELECT 'visit' AS kind, v.id AS id, v.occurred_at AS occurredAt,
             COALESCE(NULLIF(v.chief_complaint,''), NULLIF(v.diagnosis,''), 'Visit') AS title,
             NULLIF(v.diagnosis,'') AS detail
        FROM visits v WHERE v.patient_id = ?1
      UNION ALL
      SELECT 'prescription', rx.id, rx.issued_at, 'Prescription',
             (SELECT COUNT(*) || ' medicine(s)' FROM prescription_medicines m WHERE m.prescription_id = rx.id)
        FROM prescriptions rx WHERE rx.patient_id = ?1
      UNION ALL
      SELECT 'appointment', a.id, a.starts_at, 'Appointment (' || replace(a.status,'_',' ') || ')', NULLIF(a.reason,'')
        FROM appointments a WHERE a.patient_id = ?1
      UNION ALL
      SELECT 'invoice', i.id, i.invoice_date || 'T00:00:00.000Z', 'Invoice ' || i.number, NULLIF(i.notes,'')
        FROM invoices i WHERE i.patient_id = ?1
      UNION ALL
      SELECT 'payment', pm.id, pm.paid_at, 'Payment (' || pm.method || ')', NULLIF(pm.reference,'')
        FROM payments pm WHERE pm.patient_id = ?1
      UNION ALL
      SELECT 'follow_up', f.id, f.due_date_key || 'T00:00:00.000Z', 'Follow-up', NULLIF(f.reason,'')
        FROM follow_ups f WHERE f.patient_id = ?1
      UNION ALL
      SELECT 'referral', r.id, r.referred_at, 'Referral to ' || r.to_name, NULLIF(r.reason,'')
        FROM referrals r WHERE r.patient_id = ?1
      UNION ALL
      SELECT 'treatment_plan', tp.id, tp.created_at, 'Treatment plan (' || replace(tp.status,'_',' ') || ')', NULLIF(tp.diagnosis,'')
        FROM treatment_plans tp WHERE tp.patient_id = ?1`;

    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM (${union})`, patientId) as { n: number };
    const rows = this.db.all(
      `SELECT kind, id, occurredAt, title, detail FROM (${union})
        ORDER BY occurredAt DESC, kind ASC, id DESC LIMIT ? OFFSET ?`,
      patientId,
      limit,
      offset,
    );
    return {
      rows: rows.map((r) => ({
        kind: str(r, 'kind'),
        id: str(r, 'id'),
        occurredAt: str(r, 'occurredAt'),
        title: str(r, 'title'),
        detail: strOrNull(r, 'detail'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────

  private normalizeVisit(input: VisitInput) {
    const patientId = input.patientId;
    if (typeof patientId !== 'string' || patientId === '') throw Errors.notFound('patient');
    const occurredAtIso = input.occurredAtIso ?? toIso(new Date());
    if (Number.isNaN(Date.parse(occurredAtIso))) {
      throw Errors.validation('Enter a valid visit date and time.', { occurredAtIso: 'Enter a valid date and time.' });
    }
    const parsedTeeth = parseToothReferences(input.toothReferences ?? '');
    if (parsedTeeth.rejected.length > 0) {
      throw Errors.validation(
        `These tooth references could not be read: ${parsedTeeth.rejected.join(', ')}. Use FDI numbers such as 16 or 36.`,
        { toothReferences: 'Use FDI tooth numbers, for example 16, 36.' },
      );
    }
    const procedures = (input.procedures ?? []).map((procedure, index) => {
      const description = (procedure.description ?? '').trim();
      if (description === '') {
        throw Errors.validation(`Procedure ${index + 1} needs a description.`, {
          [`procedures.${index}.description`]: 'Enter a description.',
        });
      }
      if (description.length > 300) {
        throw Errors.validation(`Procedure ${index + 1} description is too long.`, {
          [`procedures.${index}.description`]: 'Use 300 characters or fewer.',
        });
      }
      if (procedure.toothNumber !== null && procedure.toothNumber !== undefined && !isToothNumber(procedure.toothNumber)) {
        throw Errors.validation(`Procedure ${index + 1} refers to an invalid tooth number.`, {
          [`procedures.${index}.toothNumber`]: 'Select a valid tooth.',
        });
      }
      return {
        treatmentId: procedure.treatmentId ?? null,
        toothNumber: procedure.toothNumber ?? null,
        description,
        note: textOrNull(procedure.note, 500),
      };
    });
    if (input.followUpDateKey !== null && input.followUpDateKey !== undefined && !isDateKey(input.followUpDateKey)) {
      throw Errors.validation('Enter a valid follow-up date.', { followUpDateKey: 'Enter a valid date.' });
    }
    return {
      patientId,
      dentistId: input.dentistId ?? null,
      appointmentId: input.appointmentId ?? null,
      queueEntryId: input.queueEntryId ?? null,
      occurredAtIso,
      chiefComplaint: textOrNull(input.chiefComplaint, 2000),
      reason: textOrNull(input.reason, 1000),
      symptoms: textOrNull(input.symptoms, 2000),
      examination: textOrNull(input.examination, 4000),
      diagnosis: textOrNull(input.diagnosis, 2000),
      treatmentPlanText: textOrNull(input.treatmentPlanText, 4000),
      treatmentPerformed: textOrNull(input.treatmentPerformed, 4000),
      toothNumbers: parsedTeeth.numbers,
      procedures,
      anesthesia: textOrNull(input.anesthesia, 1000),
      medications: textOrNull(input.medications, 2000),
      advice: textOrNull(input.advice, 2000),
      referralNote: textOrNull(input.referralNote, 1000),
      followUpDateKey: input.followUpDateKey ?? null,
      followUpNote: textOrNull(input.followUpNote, 1000),
      notes: textOrNull(input.notes, 5000),
    };
  }

  private normalizePrescription(input: PrescriptionInput) {
    const patientId = input.patientId;
    if (typeof patientId !== 'string' || patientId === '') throw Errors.notFound('patient');
    const issuedAtIso = input.issuedAtIso ?? toIso(new Date());
    if (Number.isNaN(Date.parse(issuedAtIso))) {
      throw Errors.validation('Enter a valid prescription date.', { issuedAtIso: 'Enter a valid date.' });
    }

    const normalizeFindings = (
      findings: ClinicalFinding[] | undefined,
      section: 'chiefComplaints' | 'onExamination',
    ): ClinicalFinding[] =>
      (findings ?? [])
        .filter((finding) => finding && isValidKey(section, finding.key))
        .map((finding) => ({
          key: finding.key,
          detail: (finding.detail ?? '').trim().slice(0, 500),
          teeth: (finding.teeth ?? []).filter((tooth): tooth is number => isToothNumber(tooth)),
        }));

    const medicines = (input.medicines ?? []).map((medicine, index) => {
      const name = (medicine.name ?? '').trim();
      if (name === '') {
        throw Errors.validation(`Medicine ${index + 1} needs a name.`, { [`medicines.${index}.name`]: 'Enter a medicine name.' });
      }
      if (name.length > MEDICINE_NAME_MAX) {
        throw Errors.validation(`Medicine ${index + 1} name is too long.`, {
          [`medicines.${index}.name`]: `Use ${MEDICINE_NAME_MAX} characters or fewer.`,
        });
      }
      const form = (MEDICINE_FORMS as readonly string[]).includes(medicine.form) ? medicine.form : ('tablet' as MedicineForm);
      if (medicine.foodRelation !== null && medicine.foodRelation !== undefined && !(FOOD_RELATIONS as readonly string[]).includes(medicine.foodRelation)) {
        throw Errors.validation(`Medicine ${index + 1} has an invalid food instruction.`, {
          [`medicines.${index}.foodRelation`]: 'Select a valid option.',
        });
      }
      return {
        name,
        form,
        strength: textOrNull(medicine.strength, MEDICINE_TEXT_MAX),
        dose: textOrNull(medicine.dose, MEDICINE_TEXT_MAX),
        frequency: textOrNull(medicine.frequency, MEDICINE_TEXT_MAX),
        duration: textOrNull(medicine.duration, MEDICINE_TEXT_MAX),
        timing: textOrNull(medicine.timing, MEDICINE_TEXT_MAX),
        foodRelation: medicine.foodRelation ?? null,
        route: textOrNull(medicine.route, MEDICINE_TEXT_MAX),
        customInstructions: textOrNull(medicine.customInstructions, MEDICINE_TEXT_MAX),
        notes: textOrNull(medicine.notes, MEDICINE_TEXT_MAX),
      };
    });

    if (medicines.length === 0) {
      throw Errors.validation('Add at least one medicine to the prescription.', {
        medicines: 'Add at least one medicine.',
      });
    }

    const advice = textOrNull(input.advice, ADVICE_MAX);
    return {
      patientId,
      dentistId: input.dentistId ?? null,
      visitId: input.visitId ?? null,
      issuedAtIso,
      chiefComplaints: normalizeFindings(input.chiefComplaints, 'chiefComplaints'),
      onExamination: normalizeFindings(input.onExamination, 'onExamination'),
      radiologyExamination: textOrNull(input.radiologyExamination, 2000),
      advice,
      notes: textOrNull(input.notes, 2000),
      medicines,
    };
  }

  private assertPatient(tx: Transaction, patientId: string): void {
    if (!tx.get('SELECT 1 AS ok FROM patients WHERE id = ?', patientId)) throw Errors.notFound('patient');
  }

  private assertPatientById(patientId: string): void {
    if (!this.db.get('SELECT 1 AS ok FROM patients WHERE id = ?', patientId)) throw Errors.notFound('patient');
  }

  private assertDentist(tx: Transaction, dentistId: string): void {
    if (!tx.get('SELECT 1 AS ok FROM dentists WHERE id = ?', dentistId)) throw Errors.notFound('dentist');
  }
}

function textOrNull(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed.slice(0, maxLength);
}

function mapVisit(row: Record<string, unknown>): VisitRow {
  return {
    id: str(row, 'id'),
    patientId: str(row, 'patientId'),
    patientCode: str(row, 'patientCode'),
    patientName: str(row, 'patientName'),
    dentistId: strOrNull(row, 'dentistId'),
    dentistName: strOrNull(row, 'dentistName'),
    appointmentId: strOrNull(row, 'appointmentId'),
    queueEntryId: strOrNull(row, 'queueEntryId'),
    occurredAt: str(row, 'occurredAt'),
    chiefComplaint: strOrNull(row, 'chiefComplaint'),
    reason: strOrNull(row, 'reason'),
    symptoms: strOrNull(row, 'symptoms'),
    examination: strOrNull(row, 'examination'),
    diagnosis: strOrNull(row, 'diagnosis'),
    treatmentPlanText: strOrNull(row, 'treatmentPlanText'),
    treatmentPerformed: strOrNull(row, 'treatmentPerformed'),
    toothNumbers: json<number[]>(row, 'toothNumbers', []),
    procedures: [],
    anesthesia: strOrNull(row, 'anesthesia'),
    medications: strOrNull(row, 'medications'),
    advice: strOrNull(row, 'advice'),
    referralNote: strOrNull(row, 'referralNote'),
    followUpDateKey: strOrNull(row, 'followUpDateKey'),
    followUpNote: strOrNull(row, 'followUpNote'),
    notes: strOrNull(row, 'notes'),
    createdAt: str(row, 'createdAt'),
    updatedAt: str(row, 'updatedAt'),
  };
}

function mapToothCondition(row: Record<string, unknown>): ToothConditionRow {
  return {
    id: str(row, 'id'),
    toothNumber: int(row, 'toothNumber'),
    state: String(row.state) as ToothState,
    surfaces: json<ToothSurface[]>(row, 'surfaces', []),
    note: strOrNull(row, 'note'),
    visitId: strOrNull(row, 'visitId'),
    recordedAt: str(row, 'recordedAt'),
    supersededAt: strOrNull(row, 'supersededAt'),
  };
}

export interface FollowUpRow {
  id: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  visitId: string | null;
  dueDateKey: string;
  reason: string | null;
  status: 'pending' | 'completed' | 'cancelled';
  completedAt: string | null;
}

export interface ReferralRow {
  id: string;
  toName: string;
  toSpecialty: string | null;
  toContact: string | null;
  reason: string | null;
  referredAt: string;
  status: string;
}

export interface NoteRow {
  id: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  authorName: string | null;
}

export interface TimelineEntry {
  kind: string;
  id: string;
  occurredAt: string;
  title: string;
  detail: string | null;
}

export { AppError, todayKey };
