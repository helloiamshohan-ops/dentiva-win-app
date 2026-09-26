/**
 * Dentiva Pro — audit logging.
 *
 * Significant events are recorded with actor, action, entity and redacted metadata. Audit rows
 * are append-only: nothing in the product updates or deletes them, so the history can be trusted
 * during a dispute or an inspection.
 *
 * Two hard rules:
 *   - Secrets are redacted before write (see `@shared/errors` SECRET_KEY_PATTERN).
 *   - Free-text clinical content is never written to the audit log. Only identifiers and short
 *     factual summaries are recorded, so the log cannot become an unprotected copy of the chart.
 */

import { AppError, sanitizeForWire } from '../../shared/errors';
import { newId } from '../../shared/id';
import { toIso } from '../../shared/dates';
import type { Database } from '../db/sqlite';

export interface AuditActor {
  userId: string | null;
  name: string;
  role: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, name: 'System', role: null };

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

/** Maximum metadata size persisted, to keep the log bounded. */
const MAX_METADATA_JSON = 8000;
/** Maximum summary length. */
const MAX_SUMMARY = 300;

export class AuditService {
  constructor(private readonly db: Database) {}

  record(actor: AuditActor, entry: AuditEntry, at: Date = new Date()): string {
    if (typeof entry.action !== 'string' || entry.action.trim() === '') {
      throw new AppError('An audit action is required.', { code: 'VALIDATION' });
    }
    const metadata = sanitizeForWire(entry.metadata ?? {});
    let metadataJson = JSON.stringify(metadata);
    if (metadataJson.length > MAX_METADATA_JSON) {
      metadataJson = JSON.stringify({ truncated: true, keys: Object.keys(metadata) });
    }
    const summary = entry.summary ? String(entry.summary).slice(0, MAX_SUMMARY) : null;
    const id = newId('aud');
    this.db.run(
      `INSERT INTO audit_log (id, occurred_at, actor_user_id, actor_name, actor_role, action, entity_type, entity_id, summary, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      toIso(at),
      actor.userId,
      actor.name,
      actor.role,
      entry.action.trim(),
      entry.entityType ?? null,
      entry.entityId ?? null,
      summary,
      metadataJson,
    );
    return id;
  }

  /**
   * Query the audit log.
   *
   * Filtering and pagination happen in SQL so a clinic with years of history can still page
   * through it. Results are never truncated silently: `total` reports the full match count.
   */
  query(params: {
    fromIso?: string | null;
    toIso?: string | null;
    action?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    actorUserId?: string | null;
    limit: number;
    offset: number;
  }): { rows: AuditRow[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.fromIso) {
      where.push('occurred_at >= ?');
      args.push(params.fromIso);
    }
    if (params.toIso) {
      where.push('occurred_at <= ?');
      args.push(params.toIso);
    }
    if (params.action) {
      where.push('action = ?');
      args.push(params.action);
    }
    if (params.entityType) {
      where.push('entity_type = ?');
      args.push(params.entityType);
    }
    if (params.entityId) {
      where.push('entity_id = ?');
      args.push(params.entityId);
    }
    if (params.actorUserId) {
      where.push('actor_user_id = ?');
      args.push(params.actorUserId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM audit_log ${clause}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT id, occurred_at AS occurredAt, actor_user_id AS actorUserId, actor_name AS actorName,
              actor_role AS actorRole, action, entity_type AS entityType, entity_id AS entityId,
              summary, metadata
         FROM audit_log ${clause}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    ) as unknown as AuditRow[];
    return { rows, total: Number(totalRow?.n ?? 0) };
  }

  count(): number {
    const row = this.db.get('SELECT COUNT(*) AS n FROM audit_log') as { n: number };
    return Number(row?.n ?? 0);
  }

  /** Distinct actions, used to populate the audit filter. */
  actions(): string[] {
    return this.db
      .all('SELECT DISTINCT action FROM audit_log ORDER BY action')
      .map((r) => String(r.action));
  }
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorName: string;
  actorRole: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
  metadata: string;
}

/** Canonical action names. Kept in one place so reports and filters agree. */
export const AUDIT_ACTIONS = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  LOCK: 'auth.lock',
  UNLOCK: 'auth.unlock',
  UNLOCK_FAILED: 'auth.unlock_failed',
  PASSWORD_CHANGED: 'auth.password_changed',
  PATIENT_CREATED: 'patient.created',
  PATIENT_UPDATED: 'patient.updated',
  PATIENT_ARCHIVED: 'patient.archived',
  PATIENT_RESTORED: 'patient.restored',
  VISIT_CREATED: 'visit.created',
  VISIT_UPDATED: 'visit.updated',
  PRESCRIPTION_CREATED: 'prescription.created',
  PRESCRIPTION_UPDATED: 'prescription.updated',
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_UPDATED: 'appointment.updated',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  QUEUE_STATE_CHANGED: 'queue.state_changed',
  INVOICE_CREATED: 'invoice.created',
  INVOICE_UPDATED: 'invoice.updated',
  INVOICE_VOIDED: 'invoice.voided',
  PAYMENT_RECORDED: 'payment.recorded',
  PAYMENT_VOIDED: 'payment.voided',
  REFUND_RECORDED: 'refund.recorded',
  ADJUSTMENT_RECORDED: 'adjustment.recorded',
  INVENTORY_CHANGED: 'inventory.changed',
  STAFF_CREATED: 'staff.created',
  STAFF_UPDATED: 'staff.updated',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  SETTINGS_UPDATED: 'settings.updated',
  CLINIC_UPDATED: 'clinic.updated',
  BACKUP_CREATED: 'backup.created',
  BACKUP_FAILED: 'backup.failed',
  RESTORE_STARTED: 'restore.started',
  RESTORE_COMPLETED: 'restore.completed',
  RESTORE_FAILED: 'restore.failed',
  IMPORT_COMPLETED: 'import.completed',
  EXPORT_COMPLETED: 'export.completed',
  DOCUMENT_GENERATED: 'document.generated',
  ACTIVATION_SUCCEEDED: 'activation.succeeded',
  ACTIVATION_FAILED: 'activation.failed',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
