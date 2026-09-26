/**
 * Dentiva Pro — treatment catalogue and treatment plan service.
 */

import { AppError, Errors } from '../../shared/errors';
import { newId } from '../../shared/id';
import type { Database, Transaction } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';
import { int, str, strOrNull } from '../repositories/row';

export interface TreatmentInput {
  code: string;
  name: string;
  category?: string | null;
  description?: string | null;
  durationMinutes?: number | null;
  standardPriceMinor?: number;
  notes?: string | null;
}

export interface TreatmentRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  durationMinutes: number | null;
  standardPriceMinor: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TreatmentPlanItemInput {
  treatmentId?: string | null;
  description: string;
  toothNumber?: number | null;
  quantity?: number;
  unitPriceMinor?: number;
  status?: 'planned' | 'in_progress' | 'completed' | 'cancelled';
}

export interface TreatmentPlanInput {
  patientId: string;
  dentistId?: string | null;
  visitId?: string | null;
  title?: string | null;
  diagnosis?: string | null;
  status?: 'proposed' | 'presented' | 'accepted' | 'in_progress' | 'completed' | 'declined' | 'cancelled';
  notes?: string | null;
  items: TreatmentPlanItemInput[];
}

export interface TreatmentPlanItemRow {
  id: string;
  treatmentId: string | null;
  treatmentName: string | null;
  description: string;
  toothNumber: number | null;
  orderIndex: number;
  quantity: number;
  unitPriceMinor: number;
  estimatedMinor: number;
  status: string;
  invoiceId: string | null;
}

export interface TreatmentPlanRow {
  id: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  dentistId: string | null;
  dentistName: string | null;
  visitId: string | null;
  title: string | null;
  diagnosis: string | null;
  status: string;
  estimatedMinor: number;
  acceptedAt: string | null;
  completedAt: string | null;
  notes: string | null;
  items: TreatmentPlanItemRow[];
  createdAt: string;
  updatedAt: string;
}

export class TreatmentService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  // ── Catalogue ──────────────────────────────────────────────────────────────────────────

  createTreatment(actor: AuditActor, input: TreatmentInput): TreatmentRow {
    const normalized = this.normalizeCatalogue(input);
    const id = newId('trt');
    this.db.transaction((tx) => {
      if (tx.get('SELECT 1 AS ok FROM treatments WHERE code = ?', normalized.code)) {
        throw Errors.alreadyExists(`A treatment with code "${normalized.code}" already exists.`);
      }
      tx.run(
        `INSERT INTO treatments (id, code, name, category, description, duration_minutes, standard_price_minor, active, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        normalized.code,
        normalized.name,
        normalized.category,
        normalized.description,
        normalized.durationMinutes,
        normalized.standardPriceMinor,
        normalized.notes,
      );
      this.audit.record(actor, {
        action: 'treatment.created',
        entityType: 'treatment',
        entityId: id,
        summary: `Added treatment "${normalized.name}" (${normalized.code})`,
      });
    });
    return this.getTreatment(id);
  }

  updateTreatment(actor: AuditActor, id: string, input: Partial<TreatmentInput> & { active?: boolean }): TreatmentRow {
    const existing = this.getTreatment(id);
    const merged = { ...existing, ...input, id } as TreatmentInput & { id: string; active?: boolean };
    const normalized = this.normalizeCatalogue(merged);
    const active = input.active ?? existing.active;
    this.db.transaction((tx) => {
      const clash = tx.get('SELECT id FROM treatments WHERE code = ? AND id <> ?', normalized.code, id);
      if (clash) throw Errors.alreadyExists(`Another treatment already uses code "${normalized.code}".`);
      tx.run(
        `UPDATE treatments SET code = ?, name = ?, category = ?, description = ?, duration_minutes = ?,
             standard_price_minor = ?, active = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        normalized.code,
        normalized.name,
        normalized.category,
        normalized.description,
        normalized.durationMinutes,
        normalized.standardPriceMinor,
        active ? 1 : 0,
        normalized.notes,
        id,
      );
      this.audit.record(actor, {
        action: 'treatment.updated',
        entityType: 'treatment',
        entityId: id,
        summary: `Updated treatment "${normalized.name}"`,
      });
    });
    return this.getTreatment(id);
  }

  getTreatment(id: string): TreatmentRow {
    const row = this.db.get('SELECT id, code, name, category, description, duration_minutes AS durationMinutes, standard_price_minor AS standardPriceMinor, active, notes, created_at AS createdAt, updated_at AS updatedAt FROM treatments WHERE id = ?', id);
    if (!row) throw Errors.notFound('treatment');
    return {
      id: str(row, 'id'),
      code: str(row, 'code'),
      name: str(row, 'name'),
      category: strOrNull(row, 'category'),
      description: strOrNull(row, 'description'),
      durationMinutes: row.durationMinutes === null || row.durationMinutes === undefined ? null : int(row, 'durationMinutes'),
      standardPriceMinor: int(row, 'standardPriceMinor'),
      active: int(row, 'active') === 1,
      notes: strOrNull(row, 'notes'),
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
  }

  listTreatments(params: { search?: string; category?: string | null; includeInactive?: boolean; limit: number; offset: number }): {
    rows: TreatmentRow[];
    total: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (!params.includeInactive) clauses.push('active = 1');
    if (params.category) {
      clauses.push('category = ?');
      args.push(params.category);
    }
    if (params.search) {
      const s = `%${params.search.replace(/[%_\\]/g, '\\$&')}%`;
      clauses.push('(name LIKE ? OR code LIKE ? OR category LIKE ?)');
      args.push(s, s, s);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM treatments ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT id, code, name, category, description, duration_minutes AS durationMinutes,
              standard_price_minor AS standardPriceMinor, active, notes, created_at AS createdAt, updated_at AS updatedAt
         FROM treatments ${where} ORDER BY name LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        code: str(r, 'code'),
        name: str(r, 'name'),
        category: strOrNull(r, 'category'),
        description: strOrNull(r, 'description'),
        durationMinutes: r.durationMinutes === null || r.durationMinutes === undefined ? null : int(r, 'durationMinutes'),
        standardPriceMinor: int(r, 'standardPriceMinor'),
        active: int(r, 'active') === 1,
        notes: strOrNull(r, 'notes'),
        createdAt: str(r, 'createdAt'),
        updatedAt: str(r, 'updatedAt'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  categories(): string[] {
    return this.db.all('SELECT DISTINCT category FROM treatments WHERE category IS NOT NULL AND category <> \'\' ORDER BY category').map((r) => str(r, 'category'));
  }

  // ── Treatment plans ────────────────────────────────────────────────────────────────────

  createPlan(actor: AuditActor, input: TreatmentPlanInput): TreatmentPlanRow {
    const normalized = this.normalizePlan(input);
    const planId = newId('tpl');
    this.db.transaction((tx) => {
      this.assertPatient(tx, normalized.patientId);
      if (normalized.dentistId && !tx.get('SELECT 1 AS ok FROM dentists WHERE id = ?', normalized.dentistId)) {
        throw Errors.notFound('dentist');
      }
      const estimated = normalized.items.reduce((sum, item) => sum + (item.unitPriceMinor ?? 0) * (item.quantity ?? 1), 0);
      tx.run(
        `INSERT INTO treatment_plans (id, patient_id, dentist_id, visit_id, title, diagnosis, status, estimated_minor, notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        planId,
        normalized.patientId,
        normalized.dentistId,
        normalized.visitId,
        normalized.title,
        normalized.diagnosis,
        normalized.status,
        estimated,
        normalized.notes,
        actor.userId,
      );
      normalized.items.forEach((item, index) => {
        const price = item.unitPriceMinor ?? 0;
        tx.run(
          `INSERT INTO treatment_plan_items (id, plan_id, treatment_id, description, tooth_number, order_index, quantity, unit_price_minor, estimated_minor, status)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          newId('tpi'),
          planId,
          item.treatmentId ?? null,
          item.description,
          item.toothNumber ?? null,
          index,
          item.quantity ?? 1,
          price,
          price * (item.quantity ?? 1),
          item.status ?? 'planned',
        );
      });
      this.audit.record(actor, {
        action: 'treatment_plan.created',
        entityType: 'treatment_plan',
        entityId: planId,
        summary: `Created treatment plan with ${normalized.items.length} item(s)`,
      });
    });
    return this.getPlan(planId);
  }

  updatePlan(actor: AuditActor, planId: string, input: Partial<TreatmentPlanInput>): TreatmentPlanRow {
    const existing = this.getPlan(planId);
    if (input.items) {
      // Replace items.
      const normalized = this.normalizePlan({ ...existing, ...input, patientId: input.patientId ?? existing.patientId } as TreatmentPlanInput);
      this.db.transaction((tx) => {
        tx.run('DELETE FROM treatment_plan_items WHERE plan_id = ?', planId);
        normalized.items.forEach((item, index) => {
          const price = item.unitPriceMinor ?? 0;
          tx.run(
            `INSERT INTO treatment_plan_items (id, plan_id, treatment_id, description, tooth_number, order_index, quantity, unit_price_minor, estimated_minor, status)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            newId('tpi'),
            planId,
            item.treatmentId ?? null,
            item.description,
            item.toothNumber ?? null,
            index,
            item.quantity ?? 1,
            price,
            price * (item.quantity ?? 1),
            item.status ?? 'planned',
          );
        });
        const estimated = normalized.items.reduce((sum, it) => sum + (it.unitPriceMinor ?? 0) * (it.quantity ?? 1), 0);
        tx.run(
          `UPDATE treatment_plans SET title = ?, diagnosis = ?, status = ?, estimated_minor = ?, notes = ?,
                  dentist_id = COALESCE(?, dentist_id), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
          normalized.title,
          normalized.diagnosis,
          normalized.status ?? existing.status,
          estimated,
          normalized.notes ?? existing.notes,
          normalized.dentistId ?? null,
          planId,
        );
        this.audit.record(actor, { action: 'treatment_plan.updated', entityType: 'treatment_plan', entityId: planId, summary: 'Updated treatment plan' });
      });
    } else {
      this.db.run(
        `UPDATE treatment_plans SET title = COALESCE(?, title), diagnosis = COALESCE(?, diagnosis),
                status = COALESCE(?, status), notes = COALESCE(?, notes),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        input.title ?? null,
        input.diagnosis ?? null,
        input.status ?? null,
        input.notes ?? null,
        planId,
      );
    }
    return this.getPlan(planId);
  }

  acceptPlan(actor: AuditActor, planId: string): TreatmentPlanRow {
    this.db.transaction((tx) => {
      const row = tx.get('SELECT status FROM treatment_plans WHERE id = ?', planId);
      if (!row) throw Errors.notFound('treatment plan');
      const status = String(row.status);
      if (status === 'accepted' || status === 'in_progress' || status === 'completed') {
        throw Errors.conflict(`This plan is already ${status.replace('_', ' ')}.`);
      }
      tx.run(
        `UPDATE treatment_plans SET status = 'accepted', accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        planId,
      );
      this.audit.record(actor, { action: 'treatment_plan.accepted', entityType: 'treatment_plan', entityId: planId, summary: 'Treatment plan accepted' });
    });
    return this.getPlan(planId);
  }

  getPlan(planId: string): TreatmentPlanRow {
    const row = this.db.get(
      `SELECT tp.id, tp.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              tp.dentist_id AS dentistId, d.name AS dentistName, tp.visit_id AS visitId, tp.title, tp.diagnosis,
              tp.status, tp.estimated_minor AS estimatedMinor, tp.accepted_at AS acceptedAt, tp.completed_at AS completedAt,
              tp.notes, tp.created_at AS createdAt, tp.updated_at AS updatedAt
         FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id LEFT JOIN dentists d ON d.id = tp.dentist_id
        WHERE tp.id = ?`,
      planId,
    );
    if (!row) throw Errors.notFound('treatment plan');
    const plan: TreatmentPlanRow = {
      id: str(row, 'id'),
      patientId: str(row, 'patientId'),
      patientCode: str(row, 'patientCode'),
      patientName: str(row, 'patientName'),
      dentistId: strOrNull(row, 'dentistId'),
      dentistName: strOrNull(row, 'dentistName'),
      visitId: strOrNull(row, 'visitId'),
      title: strOrNull(row, 'title'),
      diagnosis: strOrNull(row, 'diagnosis'),
      status: str(row, 'status'),
      estimatedMinor: int(row, 'estimatedMinor'),
      acceptedAt: strOrNull(row, 'acceptedAt'),
      completedAt: strOrNull(row, 'completedAt'),
      notes: strOrNull(row, 'notes'),
      items: [],
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
    plan.items = this.db
      .all(
        `SELECT tpi.id, tpi.treatment_id AS treatmentId, t.name AS treatmentName, tpi.description,
                tpi.tooth_number AS toothNumber, tpi.order_index AS orderIndex, tpi.quantity,
                tpi.unit_price_minor AS unitPriceMinor, tpi.estimated_minor AS estimatedMinor, tpi.status, tpi.invoice_id AS invoiceId
           FROM treatment_plan_items tpi LEFT JOIN treatments t ON t.id = tpi.treatment_id
          WHERE tpi.plan_id = ? ORDER BY tpi.order_index, tpi.id`,
        planId,
      )
      .map((r) => ({
        id: str(r, 'id'),
        treatmentId: strOrNull(r, 'treatmentId'),
        treatmentName: strOrNull(r, 'treatmentName'),
        description: str(r, 'description'),
        toothNumber: r.toothNumber === null || r.toothNumber === undefined ? null : int(r, 'toothNumber'),
        orderIndex: int(r, 'orderIndex'),
        quantity: int(r, 'quantity'),
        unitPriceMinor: int(r, 'unitPriceMinor'),
        estimatedMinor: int(r, 'estimatedMinor'),
        status: str(r, 'status'),
        invoiceId: strOrNull(r, 'invoiceId'),
      }));
    return plan;
  }

  listPlans(params: { patientId?: string | null; status?: string | null; limit: number; offset: number }): {
    rows: TreatmentPlanRow[];
    total: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.patientId) {
      clauses.push('tp.patient_id = ?');
      args.push(params.patientId);
    }
    if (params.status) {
      clauses.push('tp.status = ?');
      args.push(params.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM treatment_plans tp ${where}`, ...args) as { n: number };
    const ids = this.db.all(`SELECT tp.id FROM treatment_plans tp ${where} ORDER BY tp.created_at DESC, tp.id DESC LIMIT ? OFFSET ?`, ...args, params.limit, params.offset).map((r) => str(r, 'id'));
    return { rows: ids.map((id) => this.getPlan(id)), total: int(totalRow, 'n') };
  }

  private normalizeCatalogue(input: TreatmentInput): Required<Omit<TreatmentInput, 'notes'>> & { notes: string | null } {
    const code = (input.code ?? '').trim().toUpperCase();
    if (code === '' || code.length > 30) throw Errors.validation('Enter a treatment code of up to 30 characters.', { code: 'Enter a code.' });
    const name = (input.name ?? '').trim();
    if (name === '' || name.length > 200) throw Errors.validation('Enter a treatment name of up to 200 characters.', { name: 'Enter a name.' });
    if (input.durationMinutes !== null && input.durationMinutes !== undefined) {
      if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 1000) {
        throw Errors.validation('Duration must be between 1 and 1000 minutes.', { durationMinutes: 'Enter a valid duration.' });
      }
    }
    const price = input.standardPriceMinor ?? 0;
    if (!Number.isSafeInteger(price) || price < 0) throw Errors.validation('Standard price must be zero or greater.', { standardPriceMinor: 'Enter a valid price.' });
    return {
      code,
      name,
      category: input.category?.trim()?.slice(0, 80) ?? null,
      description: input.description?.trim()?.slice(0, 1000) ?? null,
      durationMinutes: input.durationMinutes ?? null,
      standardPriceMinor: price,
      notes: input.notes?.trim()?.slice(0, 1000) ?? null,
    };
  }

  private normalizePlan(input: TreatmentPlanInput): Required<Omit<TreatmentPlanInput, 'title' | 'diagnosis' | 'notes' | 'dentistId' | 'visitId' | 'status'>> & {
    title: string | null;
    diagnosis: string | null;
    notes: string | null;
    dentistId: string | null;
    visitId: string | null;
    status: string;
  } {
    if (!input.patientId) throw Errors.notFound('patient');
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw Errors.validation('Add at least one item to the treatment plan.', { items: 'Add at least one item.' });
    }
    const items = input.items.map((item, idx) => {
      const description = (item.description ?? '').trim();
      if (description === '' || description.length > 300) {
        throw Errors.validation(`Item ${idx + 1} needs a description of up to 300 characters.`, { [`items.${idx}.description`]: 'Enter a description.' });
      }
      const qty = item.quantity ?? 1;
      if (!Number.isSafeInteger(qty) || qty < 1) throw Errors.validation(`Item ${idx + 1} quantity must be 1 or more.`, { [`items.${idx}.quantity`]: 'Enter a valid quantity.' });
      const price = item.unitPriceMinor ?? 0;
      if (!Number.isSafeInteger(price) || price < 0) throw Errors.validation(`Item ${idx + 1} price must be zero or greater.`, { [`items.${idx}.unitPriceMinor`]: 'Enter a valid price.' });
      return {
        treatmentId: item.treatmentId ?? null,
        description,
        toothNumber: item.toothNumber ?? null,
        quantity: qty,
        unitPriceMinor: price,
        status: item.status ?? 'planned',
      };
    });
    return {
      patientId: input.patientId,
      dentistId: input.dentistId ?? null,
      visitId: input.visitId ?? null,
      title: input.title?.trim()?.slice(0, 200) ?? null,
      diagnosis: input.diagnosis?.trim()?.slice(0, 2000) ?? null,
      status: input.status ?? 'proposed',
      notes: input.notes?.trim()?.slice(0, 2000) ?? null,
      items,
    };
  }

  private assertPatient(tx: Transaction, patientId: string): void {
    if (!tx.get('SELECT 1 AS ok FROM patients WHERE id = ?', patientId)) throw Errors.notFound('patient');
  }
}
