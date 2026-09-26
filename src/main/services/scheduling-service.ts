/**
 * Dentiva Pro — scheduling service (appointments, queue, chairs, rooms).
 *
 * Appointment conflict detection runs in the trusted layer inside a transaction, and is backed by
 * a database-level re-check, so two receptionists booking the same dentist at the same instant
 * cannot both succeed. Checking only in the UI would allow exactly that.
 *
 * Queue serials are allocated with a single atomic upsert keyed by the clinic day (and optionally
 * the dentist), which is what makes the daily reset explicit and race-safe.
 */

import { AppError, Errors } from '../../shared/errors';
import { newId } from '../../shared/id';
import { dateKey, todayKey, toIso, combineDateAndTime, formatTime, partsInTimeZone } from '../../shared/dates';
import {
  APPOINTMENT_STATUSES,
  BLOCKING_STATUSES,
  DEFAULT_DURATION_MINUTES,
  canTransition,
  findConflicts,
  validateDuration,
  type AppointmentInterval,
  type AppointmentStatus,
  type ConflictResource,
} from '../../domain/appointment';
import {
  ACTIVE_QUEUE_STATUSES,
  MAX_SERIALS_PER_DAY,
  canTransitionQueue,
  formatSerial,
  queueCounterKey,
  type QueueSerialScope,
  type QueueStatus,
} from '../../domain/queue';
import type { Database, Transaction } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';
import { int, str, strOrNull } from '../repositories/row';

export interface AppointmentInput {
  patientId: string;
  dentistId?: string | null;
  chairId?: string | null;
  roomId?: string | null;
  dateKey: string;
  time: string;
  durationMinutes?: number;
  reason?: string | null;
  notes?: string | null;
}

export interface AppointmentRow {
  id: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  patientPhone: string | null;
  dentistId: string | null;
  dentistName: string | null;
  chairId: string | null;
  chairName: string | null;
  roomId: string | null;
  roomName: string | null;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  cancelledReason: string | null;
  visitId: string | null;
  rescheduledFromId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConflictDetail {
  resource: ConflictResource;
  resourceId: string;
  resourceName: string;
  appointmentId: string;
  patientName: string | null;
  patientCode: string | null;
  startsAt: string;
  endsAt: string;
}

export class SchedulingService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly options: () => { timeZone: string; queueSerialScope: QueueSerialScope },
  ) {}

  // ── Appointments ────────────────────────────────────────────────────────────────────────

  createAppointment(actor: AuditActor, input: AppointmentInput): AppointmentRow {
    const planned = this.plan(input);
    const appointmentId = newId('apt');

    this.db.transaction((tx) => {
      this.assertResourcesExist(tx, planned);
      const conflicts = this.detectConflicts(tx, planned, null);
      if (conflicts.length > 0) throw conflictError(conflicts);
      tx.run(
        `INSERT INTO appointments (id, patient_id, dentist_id, chair_id, room_id, starts_at, ends_at,
             duration_minutes, status, reason, notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'scheduled', ?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        appointmentId,
        planned.patientId,
        planned.dentistId,
        planned.chairId,
        planned.roomId,
        planned.startsAt,
        planned.endsAt,
        planned.durationMinutes,
        planned.reason,
        planned.notes,
        actor.userId,
      );
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.APPOINTMENT_CREATED,
        entityType: 'appointment',
        entityId: appointmentId,
        summary: `Booked an appointment for ${planned.dateKey} at ${planned.time}`,
        metadata: { dateKey: planned.dateKey, time: planned.time, durationMinutes: planned.durationMinutes },
      });
    });

    return this.getAppointment(appointmentId);
  }

  reschedule(actor: AuditActor, appointmentId: string, input: AppointmentInput): AppointmentRow {
    const existing = this.getAppointment(appointmentId);
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      throw Errors.conflict(`A ${existing.status.replace('_', ' ')} appointment cannot be rescheduled.`);
    }
    const planned = this.plan({ ...input, patientId: input.patientId || existing.patientId });

    this.db.transaction((tx) => {
      this.assertResourcesExist(tx, planned);
      const conflicts = this.detectConflicts(tx, planned, appointmentId);
      if (conflicts.length > 0) throw conflictError(conflicts);
      tx.run(
        `UPDATE appointments SET patient_id = ?, dentist_id = ?, chair_id = ?, room_id = ?, starts_at = ?,
             ends_at = ?, duration_minutes = ?, status = 'rescheduled', reason = ?, notes = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        planned.patientId,
        planned.dentistId,
        planned.chairId,
        planned.roomId,
        planned.startsAt,
        planned.endsAt,
        planned.durationMinutes,
        planned.reason ?? existing.reason,
        planned.notes ?? existing.notes,
        appointmentId,
      );
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.APPOINTMENT_UPDATED,
        entityType: 'appointment',
        entityId: appointmentId,
        summary: `Rescheduled appointment from ${existing.startsAt} to ${planned.startsAt}`,
        metadata: { from: existing.startsAt, to: planned.startsAt },
      });
    });

    return this.getAppointment(appointmentId);
  }

  changeStatus(actor: AuditActor, appointmentId: string, status: AppointmentStatus, reason?: string | null): AppointmentRow {
    if (!(APPOINTMENT_STATUSES as readonly string[]).includes(status)) {
      throw Errors.validation('That appointment status is not recognised.', { status: 'Select a valid status.' });
    }
    const existing = this.getAppointment(appointmentId);
    if (!canTransition(existing.status, status)) {
      throw Errors.conflict(
        `An appointment that is ${existing.status.replace(/_/g, ' ')} cannot be changed to ${status.replace(/_/g, ' ')}.`,
      );
    }
    const trimmedReason = (reason ?? '').trim();
    if ((status === 'cancelled' || status === 'no_show') && trimmedReason === '') {
      throw Errors.validation('Enter a reason so the change is recorded clearly.', {
        reason: 'Enter a reason.',
      });
    }
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE appointments SET status = ?, cancelled_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        status,
        trimmedReason === '' ? null : trimmedReason.slice(0, 500),
        appointmentId,
      );
      this.audit.record(actor, {
        action: status === 'cancelled' ? AUDIT_ACTIONS.APPOINTMENT_CANCELLED : AUDIT_ACTIONS.APPOINTMENT_UPDATED,
        entityType: 'appointment',
        entityId: appointmentId,
        summary: `Appointment marked ${status.replace(/_/g, ' ')}`,
        ...(trimmedReason === '' ? {} : { metadata: { reason: trimmedReason } }),
      });
    });
    return this.getAppointment(appointmentId);
  }

  getAppointment(appointmentId: string): AppointmentRow {
    const row = this.db.get(
      `SELECT a.id, a.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              p.phone AS patientPhone, a.dentist_id AS dentistId, d.name AS dentistName,
              a.chair_id AS chairId, c.name AS chairName, a.room_id AS roomId, r.name AS roomName,
              a.starts_at AS startsAt, a.ends_at AS endsAt, a.duration_minutes AS durationMinutes,
              a.status, a.reason, a.notes, a.cancelled_reason AS cancelledReason, a.visit_id AS visitId,
              a.rescheduled_from_id AS rescheduledFromId, a.created_at AS createdAt, a.updated_at AS updatedAt
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         LEFT JOIN dentists d ON d.id = a.dentist_id
         LEFT JOIN chairs c ON c.id = a.chair_id
         LEFT JOIN rooms r ON r.id = a.room_id
        WHERE a.id = ?`,
      appointmentId,
    );
    if (!row) throw Errors.notFound('appointment');
    return mapAppointment(row);
  }

  listAppointments(params: {
    dateKey?: string | null;
    fromKey?: string | null;
    toKey?: string | null;
    dentistId?: string | null;
    patientId?: string | null;
    status?: AppointmentStatus | 'all';
    limit: number;
    offset: number;
  }): { rows: AppointmentRow[]; total: number } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    const tz = this.options().timeZone;

    if (params.dateKey) {
      // Half-open day range in the clinic time zone, so an appointment at 23:30 Dhaka time
      // appears on the correct day regardless of the machine's own zone.
      const start = combineDateAndTime(params.dateKey, '00:00', tz);
      const end = new Date(start.getTime() + 86_400_000);
      clauses.push('a.starts_at >= ? AND a.starts_at < ?');
      args.push(toIso(start), toIso(end));
    }
    if (params.fromKey) {
      clauses.push('a.starts_at >= ?');
      args.push(toIso(combineDateAndTime(params.fromKey, '00:00', tz)));
    }
    if (params.toKey) {
      clauses.push('a.starts_at < ?');
      args.push(toIso(new Date(combineDateAndTime(params.toKey, '00:00', tz).getTime() + 86_400_000)));
    }
    if (params.dentistId) {
      clauses.push('a.dentist_id = ?');
      args.push(params.dentistId);
    }
    if (params.patientId) {
      clauses.push('a.patient_id = ?');
      args.push(params.patientId);
    }
    if (params.status && params.status !== 'all') {
      clauses.push('a.status = ?');
      args.push(params.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM appointments a ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT a.id, a.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              p.phone AS patientPhone, a.dentist_id AS dentistId, d.name AS dentistName,
              a.chair_id AS chairId, c.name AS chairName, a.room_id AS roomId, r.name AS roomName,
              a.starts_at AS startsAt, a.ends_at AS endsAt, a.duration_minutes AS durationMinutes,
              a.status, a.reason, a.notes, a.cancelled_reason AS cancelledReason, a.visit_id AS visitId,
              a.rescheduled_from_id AS rescheduledFromId, a.created_at AS createdAt, a.updated_at AS updatedAt
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         LEFT JOIN dentists d ON d.id = a.dentist_id
         LEFT JOIN chairs c ON c.id = a.chair_id
         LEFT JOIN rooms r ON r.id = a.room_id
         ${where}
        ORDER BY a.starts_at, a.id LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return { rows: rows.map(mapAppointment), total: int(totalRow, 'n') };
  }

  /** Day agenda grouped for the schedule view. */
  agenda(dayKey: string): { dateKey: string; rows: AppointmentRow[]; counts: Record<string, number> } {
    const { rows } = this.listAppointments({ dateKey: dayKey, limit: 1000, offset: 0 });
    const counts: Record<string, number> = {};
    for (const status of APPOINTMENT_STATUSES) counts[status] = 0;
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return { dateKey: dayKey, rows, counts };
  }

  // ── Queue ───────────────────────────────────────────────────────────────────────────────

  addToQueue(
    actor: AuditActor,
    input: { patientId: string; dentistId?: string | null; roomId?: string | null; chairId?: string | null; appointmentId?: string | null; reason?: string | null },
  ): QueueEntryRow {
    const timeZone = this.options().timeZone;
    const scope = this.options().queueSerialScope;
    const queueDate = todayKey(timeZone);
    const counterKey = queueCounterKey(queueDate, scope, input.dentistId ?? null);
    const now = new Date();
    const entryId = newId('qeu');

    this.db.transaction((tx) => {
      const patient = tx.get('SELECT id, name FROM patients WHERE id = ?', input.patientId);
      if (!patient) throw Errors.notFound('patient');

      // One active queue entry per patient per day: a second check-in updates the existing row
      // instead of giving the patient two serials.
      const existing = tx.get(
        `SELECT id FROM queue_entries
          WHERE patient_id = ? AND queue_date = ? AND status IN ('waiting','called','in_progress')`,
        input.patientId,
        queueDate,
      );
      if (existing) {
        throw Errors.conflict(
          `${String(patient.name)} is already in today's queue. Move the existing entry instead of adding a second one.`,
        );
      }

      const serialRow = tx.get(
        `INSERT INTO queue_counters (queue_key, last_serial, updated_at)
         VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(queue_key) DO UPDATE SET last_serial = last_serial + 1, updated_at = excluded.updated_at
         RETURNING last_serial AS serial`,
        counterKey,
      );
      if (!serialRow) throw Errors.internal('Could not allocate a queue serial.');
      const serial = int(serialRow, 'serial');
      if (serial > MAX_SERIALS_PER_DAY) {
        throw new AppError(
          `Today's queue has reached the technical limit of ${MAX_SERIALS_PER_DAY} serials. Close the queue for the day and start a new one.`,
          { code: 'VALIDATION' },
        );
      }

      tx.run(
        `INSERT INTO queue_entries (id, queue_date, serial, counter_key, patient_id, dentist_id, room_id,
             chair_id, status, appointment_id, reason, arrived_at, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,'waiting',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        entryId,
        queueDate,
        serial,
        counterKey,
        input.patientId,
        input.dentistId ?? null,
        input.roomId ?? null,
        input.chairId ?? null,
        input.appointmentId ?? null,
        (input.reason ?? '').trim() === '' ? null : (input.reason as string).trim().slice(0, 300),
        actor.userId,
      );
      if (input.appointmentId) {
        tx.run(`UPDATE appointments SET status = 'arrived', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status IN ('scheduled','confirmed')`, input.appointmentId);
      }
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.QUEUE_STATE_CHANGED,
        entityType: 'queue_entry',
        entityId: entryId,
        summary: `Added ${String(patient.name)} to the queue as ${formatSerial(serial)}`,
        metadata: { serial, queueDate },
      });
    });

    void now;
    return this.getQueueEntry(entryId);
  }

  changeQueueStatus(actor: AuditActor, entryId: string, status: QueueStatus): QueueEntryRow {
    const existing = this.getQueueEntry(entryId);
    if (!canTransitionQueue(existing.status, status)) {
      throw Errors.conflict(
        `A queue entry that is ${existing.status.replace(/_/g, ' ')} cannot be changed to ${status.replace(/_/g, ' ')}.`,
      );
    }
    this.db.transaction((tx) => {
      const stamps: string[] = [];
      if (status === 'called' && existing.calledAt === null) {
        stamps.push("called_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      }
      if (status === 'in_progress' && existing.startedAt === null) {
        stamps.push("started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      }
      if (status === 'completed') {
        stamps.push("completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      }
      const stampSql = stamps.length > 0 ? `, ${stamps.join(', ')}` : '';
      tx.run(`UPDATE queue_entries SET status = ?${stampSql}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, status, entryId);
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.QUEUE_STATE_CHANGED,
        entityType: 'queue_entry',
        entityId: entryId,
        summary: `Queue ${existing.serialLabel} marked ${status.replace(/_/g, ' ')}`,
        metadata: { from: existing.status, to: status, serial: existing.serial },
      });
    });
    return this.getQueueEntry(entryId);
  }

  getQueueEntry(entryId: string): QueueEntryRow {
    const row = this.db.get(
      `SELECT q.id, q.queue_date AS queueDate, q.serial, q.counter_key AS counterKey, q.patient_id AS patientId,
              p.patient_code AS patientCode, p.name AS patientName, p.phone AS patientPhone,
              q.dentist_id AS dentistId, d.name AS dentistName, q.room_id AS roomId, r.name AS roomName,
              q.chair_id AS chairId, c.name AS chairName, q.status, q.appointment_id AS appointmentId,
              q.visit_id AS visitId, q.reason, q.notes, q.arrived_at AS arrivedAt, q.called_at AS calledAt,
              q.started_at AS startedAt, q.completed_at AS completedAt, q.created_at AS createdAt
         FROM queue_entries q
         JOIN patients p ON p.id = q.patient_id
         LEFT JOIN dentists d ON d.id = q.dentist_id
         LEFT JOIN rooms r ON r.id = q.room_id
         LEFT JOIN chairs c ON c.id = q.chair_id
        WHERE q.id = ?`,
      entryId,
    );
    if (!row) throw Errors.notFound('queue entry');
    return mapQueueEntry(row);
  }

  listQueue(params: { dateKey?: string | null; dentistId?: string | null; status?: QueueStatus | 'active' | 'all' } = {}): QueueEntryRow[] {
    const timeZone = this.options().timeZone;
    const queueDate = params.dateKey ?? todayKey(timeZone);
    const clauses: string[] = ['q.queue_date = ?'];
    const args: unknown[] = [queueDate];
    if (params.dentistId) {
      clauses.push('q.dentist_id = ?');
      args.push(params.dentistId);
    }
    if (params.status === 'active') {
      clauses.push(`q.status IN (${ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ')})`);
      args.push(...ACTIVE_QUEUE_STATUSES);
    } else if (params.status && params.status !== 'all') {
      clauses.push('q.status = ?');
      args.push(params.status);
    }
    const rows = this.db.all(
      `SELECT q.id, q.queue_date AS queueDate, q.serial, q.counter_key AS counterKey, q.patient_id AS patientId,
              p.patient_code AS patientCode, p.name AS patientName, p.phone AS patientPhone,
              q.dentist_id AS dentistId, d.name AS dentistName, q.room_id AS roomId, r.name AS roomName,
              q.chair_id AS chairId, c.name AS chairName, q.status, q.appointment_id AS appointmentId,
              q.visit_id AS visitId, q.reason, q.notes, q.arrived_at AS arrivedAt, q.called_at AS calledAt,
              q.started_at AS startedAt, q.completed_at AS completedAt, q.created_at AS createdAt
         FROM queue_entries q
         JOIN patients p ON p.id = q.patient_id
         LEFT JOIN dentists d ON d.id = q.dentist_id
         LEFT JOIN rooms r ON r.id = q.room_id
         LEFT JOIN chairs c ON c.id = q.chair_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY CASE q.status WHEN 'in_progress' THEN 0 WHEN 'called' THEN 1 WHEN 'waiting' THEN 2
                               WHEN 'skipped' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END,
                 q.serial`,
      ...args,
    );
    return rows.map(mapQueueEntry);
  }

  /** Queue statistics for the board header. */
  queueSummary(dayKey?: string | null): { dateKey: string; waiting: number; called: number; inProgress: number; completed: number; total: number } {
    const timeZone = this.options().timeZone;
    const queueDate = dayKey ?? todayKey(timeZone);
    const row = this.db.get(
      `SELECT
         SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
         SUM(CASE WHEN status = 'called' THEN 1 ELSE 0 END) AS called,
         SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS inProgress,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         COUNT(*) AS total
       FROM queue_entries WHERE queue_date = ?`,
      queueDate,
    );
    return {
      dateKey: queueDate,
      waiting: int(row, 'waiting'),
      called: int(row, 'called'),
      inProgress: int(row, 'inProgress'),
      completed: int(row, 'completed'),
      total: int(row, 'total'),
    };
  }

  // ── Resources ───────────────────────────────────────────────────────────────────────────

  listDentists(includeInactive = false): ResourceRow[] {
    return this.db
      .all(
        `SELECT id, name, designation, active FROM dentists ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`,
      )
      .map((r) => ({ id: str(r, 'id'), name: str(r, 'name'), detail: strOrNull(r, 'designation'), active: Number(r.active) === 1 }));
  }

  listChairs(includeInactive = false): ResourceRow[] {
    return this.db
      .all(`SELECT id, name, active FROM chairs ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`)
      .map((r) => ({ id: str(r, 'id'), name: str(r, 'name'), detail: null, active: Number(r.active) === 1 }));
  }

  listRooms(includeInactive = false): ResourceRow[] {
    return this.db
      .all(`SELECT id, name, active FROM rooms ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`)
      .map((r) => ({ id: str(r, 'id'), name: str(r, 'name'), detail: null, active: Number(r.active) === 1 }));
  }

  createResource(actor: AuditActor, kind: 'chair' | 'room', name: string): ResourceRow {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 80) {
      throw Errors.validation('Enter a name of up to 80 characters.', { name: 'Enter a name.' });
    }
    const id = newId(kind === 'chair' ? 'chr' : 'rmt');
    const table = kind === 'chair' ? 'chairs' : 'rooms';
    this.db.transaction((tx) => {
      const clash = tx.get(`SELECT id FROM ${table} WHERE name = ?`, trimmed);
      if (clash) throw Errors.alreadyExists(`A ${kind} named "${trimmed}" already exists.`);
      tx.run(
        `INSERT INTO ${table} (id, name, active, created_at) VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        trimmed,
      );
      this.audit.record(actor, {
        action: 'settings.resource_created',
        entityType: kind,
        entityId: id,
        summary: `Added ${kind} "${trimmed}"`,
      });
    });
    return { id, name: trimmed, detail: null, active: true };
  }

  setResourceActive(actor: AuditActor, kind: 'chair' | 'room', id: string, active: boolean): void {
    const table = kind === 'chair' ? 'chairs' : 'rooms';
    this.db.transaction((tx) => {
      const row = tx.get(`SELECT name FROM ${table} WHERE id = ?`, id);
      if (!row) throw Errors.notFound(kind);
      tx.run(`UPDATE ${table} SET active = ? WHERE id = ?`, active ? 1 : 0, id);
      this.audit.record(actor, {
        action: 'settings.resource_updated',
        entityType: kind,
        entityId: id,
        summary: `${active ? 'Enabled' : 'Disabled'} ${kind} "${String(row.name)}"`,
      });
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────

  private plan(input: AppointmentInput): {
    patientId: string;
    dentistId: string | null;
    chairId: string | null;
    roomId: string | null;
    startsAt: string;
    endsAt: string;
    startMs: number;
    endMs: number;
    durationMinutes: number;
    dateKey: string;
    time: string;
    reason: string | null;
    notes: string | null;
  } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateKey ?? '')) {
      throw Errors.validation('Enter a valid appointment date.', { dateKey: 'Enter a valid date.' });
    }
    const durationMinutes = validateDuration(input.durationMinutes ?? DEFAULT_DURATION_MINUTES);
    const tz = this.options().timeZone;
    let starts: Date;
    try {
      starts = combineDateAndTime(input.dateKey, input.time, tz);
    } catch {
      throw Errors.validation('Enter a valid start time in 24-hour format, for example 09:30.', {
        time: 'Enter a valid time (HH:MM).',
      });
    }
    const patient = this.db.get('SELECT id FROM patients WHERE id = ?', input.patientId);
    if (!patient) throw Errors.notFound('patient');

    const startMs = starts.getTime();
    const endMs = startMs + durationMinutes * 60_000;
    return {
      patientId: input.patientId,
      dentistId: input.dentistId ?? null,
      chairId: input.chairId ?? null,
      roomId: input.roomId ?? null,
      startsAt: toIso(starts),
      endsAt: toIso(new Date(endMs)),
      startMs,
      endMs,
      durationMinutes,
      dateKey: input.dateKey,
      time: formatTime(starts, tz),
      reason: textOrNull(input.reason, 300),
      notes: textOrNull(input.notes, 1000),
    };
  }

  private assertResourcesExist(tx: Transaction, planned: { dentistId: string | null; chairId: string | null; roomId: string | null }): void {
    if (planned.dentistId && !tx.get('SELECT 1 AS ok FROM dentists WHERE id = ?', planned.dentistId)) {
      throw Errors.notFound('dentist');
    }
    if (planned.chairId && !tx.get('SELECT 1 AS ok FROM chairs WHERE id = ?', planned.chairId)) {
      throw Errors.notFound('chair');
    }
    if (planned.roomId && !tx.get('SELECT 1 AS ok FROM rooms WHERE id = ?', planned.roomId)) {
      throw Errors.notFound('room');
    }
  }

  /**
   * Resource-aware conflict detection, evaluated inside the write transaction.
   *
   * Only blocking statuses are considered; a cancelled or completed appointment no longer
   * occupies the resource.
   */
  private detectConflicts(
    tx: Transaction,
    planned: {
      startMs: number;
      endMs: number;
      startsAt: string;
      endsAt: string;
      dentistId: string | null;
      chairId: string | null;
      roomId: string | null;
      patientId: string;
    },
    excludeId: string | null,
  ): ConflictDetail[] {
    const clauses: string[] = [
      `status IN (${BLOCKING_STATUSES.map(() => '?').join(', ')})`,
      'starts_at < ?',
      'ends_at > ?',
    ];
    // Overlap test on half-open intervals: the existing appointment must start before the
    // candidate ends AND end after the candidate starts.
    const args: unknown[] = [...BLOCKING_STATUSES, planned.endsAt, planned.startsAt];
    const resources: Array<[ConflictResource, string | null, string]> = [
      ['dentist', planned.dentistId, 'dentist_id'],
      ['chair', planned.chairId, 'chair_id'],
      ['room', planned.roomId, 'room_id'],
    ];
    const resourceClauses = resources
      .filter(([, value]) => value !== null)
      .map(([, , column]) => `${column} = ?`);
    if (resourceClauses.length === 0) return [];
    clauses.push(`(${resourceClauses.join(' OR ')})`);
    for (const [, value] of resources) if (value !== null) args.push(value);
    if (excludeId) {
      clauses.push('id <> ?');
      args.push(excludeId);
    }

    const rows = tx.all(
      `SELECT a.id, a.starts_at AS startsAt, a.ends_at AS endsAt, a.dentist_id AS dentistId,
              a.chair_id AS chairId, a.room_id AS roomId, d.name AS dentistName, c.name AS chairName,
              r.name AS roomName, p.name AS patientName, p.patient_code AS patientCode
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         LEFT JOIN dentists d ON d.id = a.dentist_id
         LEFT JOIN chairs c ON c.id = a.chair_id
         LEFT JOIN rooms r ON r.id = a.room_id
        WHERE ${clauses.join(' AND ')}`,
      ...args,
    );

    const details: ConflictDetail[] = [];
    for (const row of rows) {
      for (const [resource, value, column] of resources) {
        if (value === null) continue;
        if (String(row[column === 'dentist_id' ? 'dentistId' : column === 'chair_id' ? 'chairId' : 'roomId'] ?? '') !== value) continue;
        details.push({
          resource,
          resourceId: value,
          resourceName:
            resource === 'dentist'
              ? String(row.dentistName ?? value)
              : resource === 'chair'
                ? String(row.chairName ?? value)
                : String(row.roomName ?? value),
          appointmentId: str(row, 'id'),
          patientName: strOrNull(row, 'patientName'),
          patientCode: strOrNull(row, 'patientCode'),
          startsAt: str(row, 'startsAt'),
          endsAt: str(row, 'endsAt'),
        });
      }
    }
    return details;
  }
}

function conflictError(conflicts: ConflictDetail[]): AppError {
  const first = conflicts[0];
  const kindLabel = first?.resource === 'dentist' ? 'Dentist' : first?.resource === 'chair' ? 'Chair' : 'Room';
  const summary = conflicts
    .map((c) => `${c.resource === 'dentist' ? 'Dentist' : c.resource === 'chair' ? 'Chair' : 'Room'} ${c.resourceName} is already booked${c.patientName ? ` with ${c.patientName}` : ''}`)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join('; ');
  return new AppError(
    `This slot clashes with an existing booking. ${summary}. Choose another time or another ${kindLabel?.toLowerCase()}.`,
    { code: 'APPOINTMENT_CONFLICT', details: { conflicts } },
  );
}

function textOrNull(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed.slice(0, maxLength);
}

function mapAppointment(row: Record<string, unknown>): AppointmentRow {
  return {
    id: str(row, 'id'),
    patientId: str(row, 'patientId'),
    patientCode: str(row, 'patientCode'),
    patientName: str(row, 'patientName'),
    patientPhone: strOrNull(row, 'patientPhone'),
    dentistId: strOrNull(row, 'dentistId'),
    dentistName: strOrNull(row, 'dentistName'),
    chairId: strOrNull(row, 'chairId'),
    chairName: strOrNull(row, 'chairName'),
    roomId: strOrNull(row, 'roomId'),
    roomName: strOrNull(row, 'roomName'),
    startsAt: str(row, 'startsAt'),
    endsAt: str(row, 'endsAt'),
    durationMinutes: int(row, 'durationMinutes'),
    status: String(row.status) as AppointmentStatus,
    reason: strOrNull(row, 'reason'),
    notes: strOrNull(row, 'notes'),
    cancelledReason: strOrNull(row, 'cancelledReason'),
    visitId: strOrNull(row, 'visitId'),
    rescheduledFromId: strOrNull(row, 'rescheduledFromId'),
    createdAt: str(row, 'createdAt'),
    updatedAt: str(row, 'updatedAt'),
  };
}

export interface QueueEntryRow {
  id: string;
  queueDate: string;
  serial: number;
  serialLabel: string;
  counterKey: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  patientPhone: string | null;
  dentistId: string | null;
  dentistName: string | null;
  roomId: string | null;
  roomName: string | null;
  chairId: string | null;
  chairName: string | null;
  status: QueueStatus;
  appointmentId: string | null;
  visitId: string | null;
  reason: string | null;
  notes: string | null;
  arrivedAt: string;
  calledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

function mapQueueEntry(row: Record<string, unknown>): QueueEntryRow {
  const serial = int(row, 'serial');
  return {
    id: str(row, 'id'),
    queueDate: str(row, 'queueDate'),
    serial,
    serialLabel: formatSerial(serial),
    counterKey: str(row, 'counterKey'),
    patientId: str(row, 'patientId'),
    patientCode: str(row, 'patientCode'),
    patientName: str(row, 'patientName'),
    patientPhone: strOrNull(row, 'patientPhone'),
    dentistId: strOrNull(row, 'dentistId'),
    dentistName: strOrNull(row, 'dentistName'),
    roomId: strOrNull(row, 'roomId'),
    roomName: strOrNull(row, 'roomName'),
    chairId: strOrNull(row, 'chairId'),
    chairName: strOrNull(row, 'chairName'),
    status: String(row.status) as QueueStatus,
    appointmentId: strOrNull(row, 'appointmentId'),
    visitId: strOrNull(row, 'visitId'),
    reason: strOrNull(row, 'reason'),
    notes: strOrNull(row, 'notes'),
    arrivedAt: str(row, 'arrivedAt'),
    calledAt: strOrNull(row, 'calledAt'),
    startedAt: strOrNull(row, 'startedAt'),
    completedAt: strOrNull(row, 'completedAt'),
    createdAt: str(row, 'createdAt'),
  };
}

export interface ResourceRow {
  id: string;
  name: string;
  detail: string | null;
  active: boolean;
}

export { findConflicts, type AppointmentInterval };
export { dateKey, partsInTimeZone };
