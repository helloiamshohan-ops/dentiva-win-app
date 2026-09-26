/**
 * Dentiva Pro — notification service.
 */

import { Errors } from '../../shared/errors';
import { newId } from '../../shared/id';
import { todayKey, shiftDateKey } from '../../shared/dates';
import type { Database } from '../db/sqlite';
import { int, str, strOrNull } from '../repositories/row';

export type NotificationKind =
  | 'appointment_upcoming'
  | 'follow_up_due'
  | 'low_stock'
  | 'expiry_soon'
  | 'expiry_passed'
  | 'backup_completed'
  | 'backup_failed'
  | 'restore_completed'
  | 'system';

export type NotificationSeverity = 'info' | 'warning' | 'danger';

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  dedupeKey: string | null;
  readAt: string | null;
  createdAt: string;
}

export class NotificationService {
  constructor(private readonly db: Database, private readonly timeZone: () => string) {}

  /** Scan for conditions that warrant notifications. Called on startup and on a timer. */
  scan(): { created: number } {
    let created = 0;
    created += this.scanFollowUps();
    created += this.scanInventory();
    created += this.scanAppointments();
    return { created };
  }

  private scanFollowUps(): number {
    const tz = this.timeZone();
    const today = todayKey(tz);
    const upcoming = shiftDateKey(today, 7);
    const rows = this.db.all(
      `SELECT f.id, f.patient_id AS patientId, p.name AS patientName, p.patient_code AS patientCode, f.due_date_key AS dueDateKey
         FROM follow_ups f JOIN patients p ON p.id = f.patient_id
        WHERE f.status = 'pending' AND f.due_date_key <= ?`,
      upcoming,
    );
    let count = 0;
    for (const row of rows) {
      const dueDateKey = str(row, 'dueDateKey');
      const dedupeKey = `follow_up_due:${str(row, 'id')}:${dueDateKey}`;
      const existing = this.db.get('SELECT 1 AS ok FROM notifications WHERE dedupe_key = ?', dedupeKey);
      if (existing) continue;
      const overdue = dueDateKey < today;
      this.db.run(
        `INSERT INTO notifications (id, kind, severity, title, body, entity_type, entity_id, dedupe_key, created_at)
         VALUES (?, 'follow_up_due', ?, ?, ?, 'patient', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        newId('ntf'),
        overdue ? 'warning' : 'info',
        overdue ? `Follow-up overdue — ${str(row, 'patientName')}` : `Follow-up due — ${str(row, 'patientName')}`,
        `${str(row, 'patientName')} (${str(row, 'patientCode')}) has a follow-up due on ${dueDateKey}.`,
        str(row, 'patientId'),
        dedupeKey,
      );
      count += 1;
    }
    return count;
  }

  private scanInventory(): number {
    const tz = this.timeZone();
    const today = todayKey(tz);
    const warningDate = shiftDateKey(today, 60);
    let count = 0;

    const lowStock = this.db.all(
      `SELECT id, sku, name, quantity, min_quantity AS minQuantity FROM inventory_items
        WHERE active = 1 AND quantity <= min_quantity AND min_quantity > 0`,
    );
    for (const row of lowStock) {
      const dedupeKey = `low_stock:${str(row, 'id')}:${int(row, 'quantity')}`;
      if (this.db.get('SELECT 1 AS ok FROM notifications WHERE dedupe_key = ?', dedupeKey)) continue;
      this.db.run(
        `INSERT INTO notifications (id, kind, severity, title, body, entity_type, entity_id, dedupe_key, created_at)
         VALUES (?, 'low_stock', 'warning', ?, ?, 'inventory_item', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        newId('ntf'),
        `Low stock — ${str(row, 'name')} (${str(row, 'sku')})`,
        `${str(row, 'name')} is at ${int(row, 'quantity')} units (minimum ${int(row, 'minQuantity')}).`,
        str(row, 'id'),
        dedupeKey,
      );
      count += 1;
    }

    const expired = this.db.all(
      `SELECT id, sku, name, expiry_key AS expiryKey FROM inventory_items
        WHERE active = 1 AND expiry_key IS NOT NULL AND expiry_key < ?`,
      today,
    );
    for (const row of expired) {
      const dedupeKey = `expiry_passed:${str(row, 'id')}:${str(row, 'expiryKey')}`;
      if (this.db.get('SELECT 1 AS ok FROM notifications WHERE dedupe_key = ?', dedupeKey)) continue;
      this.db.run(
        `INSERT INTO notifications (id, kind, severity, title, body, entity_type, entity_id, dedupe_key, created_at)
         VALUES (?, 'expiry_passed', 'danger', ?, ?, 'inventory_item', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        newId('ntf'),
        `Expired — ${str(row, 'name')} (${str(row, 'sku')})`,
        `${str(row, 'name')} expired on ${str(row, 'expiryKey')}.`,
        str(row, 'id'),
        dedupeKey,
      );
      count += 1;
    }

    const expiring = this.db.all(
      `SELECT id, sku, name, expiry_key AS expiryKey FROM inventory_items
        WHERE active = 1 AND expiry_key IS NOT NULL AND expiry_key >= ? AND expiry_key <= ?`,
      today,
      warningDate,
    );
    for (const row of expiring) {
      const dedupeKey = `expiry_soon:${str(row, 'id')}:${str(row, 'expiryKey')}`;
      if (this.db.get('SELECT 1 AS ok FROM notifications WHERE dedupe_key = ?', dedupeKey)) continue;
      this.db.run(
        `INSERT INTO notifications (id, kind, severity, title, body, entity_type, entity_id, dedupe_key, created_at)
         VALUES (?, 'expiry_soon', 'warning', ?, ?, 'inventory_item', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        newId('ntf'),
        `Expiring soon — ${str(row, 'name')} (${str(row, 'sku')})`,
        `${str(row, 'name')} expires on ${str(row, 'expiryKey')}.`,
        str(row, 'id'),
        dedupeKey,
      );
      count += 1;
    }

    return count;
  }

  private scanAppointments(): number {
    const tz = this.timeZone();
    const today = todayKey(tz);
    const tomorrow = shiftDateKey(today, 1);
    const rows = this.db.all(
      `SELECT a.id, a.starts_at AS startsAt, p.name AS patientName, p.patient_code AS patientCode, p.id AS patientId
         FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.status IN ('scheduled','confirmed') AND substr(a.starts_at,1,10) IN (?, ?)`,
      today,
      tomorrow,
    );
    let count = 0;
    for (const row of rows) {
      const dedupeKey = `appointment_upcoming:${str(row, 'id')}:${str(row, 'startsAt').slice(0, 10)}`;
      if (this.db.get('SELECT 1 AS ok FROM notifications WHERE dedupe_key = ?', dedupeKey)) continue;
      this.db.run(
        `INSERT INTO notifications (id, kind, severity, title, body, entity_type, entity_id, dedupe_key, created_at)
         VALUES (?, 'appointment_upcoming', 'info', ?, ?, 'appointment', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        newId('ntf'),
        `Upcoming appointment — ${str(row, 'patientName')}`,
        `${str(row, 'patientName')} (${str(row, 'patientCode')}) has an appointment on ${str(row, 'startsAt')}.`,
        str(row, 'patientId'),
        dedupeKey,
      );
      count += 1;
    }
    return count;
  }

  createSystemNotification(title: string, body: string, severity: NotificationSeverity = 'info', dedupeKey?: string | null): string {
    if (dedupeKey) {
      const existing = this.db.get('SELECT 1 AS ok FROM notifications WHERE dedupe_key = ?', dedupeKey);
      if (existing) {
        const row = this.db.get('SELECT id FROM notifications WHERE dedupe_key = ?', dedupeKey) as { id: string };
        return str(row, 'id');
      }
    }
    const id = newId('ntf');
    this.db.run(
      `INSERT INTO notifications (id, kind, severity, title, body, dedupe_key, created_at)
       VALUES (?, 'system', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      id,
      severity,
      title.slice(0, 200),
      body.slice(0, 1000),
      dedupeKey ?? null,
    );
    return id;
  }

  list(params: { unreadOnly?: boolean; kind?: NotificationKind | null; limit: number; offset: number }): {
    rows: NotificationRow[];
    total: number;
    unreadCount: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.unreadOnly) clauses.push('read_at IS NULL');
    if (params.kind) {
      clauses.push('kind = ?');
      args.push(params.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM notifications ${where}`, ...args) as { n: number };
    const unreadRow = this.db.get('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL') as { n: number };
    const rows = this.db.all(
      `SELECT id, kind, severity, title, body, entity_type AS entityType, entity_id AS entityId,
              dedupe_key AS dedupeKey, read_at AS readAt, created_at AS createdAt
         FROM notifications ${where} ORDER BY read_at IS NOT NULL, created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        kind: str(r, 'kind') as NotificationKind,
        severity: str(r, 'severity') as NotificationSeverity,
        title: str(r, 'title'),
        body: str(r, 'body'),
        entityType: strOrNull(r, 'entityType'),
        entityId: strOrNull(r, 'entityId'),
        dedupeKey: strOrNull(r, 'dedupeKey'),
        readAt: strOrNull(r, 'readAt'),
        createdAt: str(r, 'createdAt'),
      })),
      total: int(totalRow, 'n'),
      unreadCount: int(unreadRow, 'n'),
    };
  }

  markRead(id: string): void {
    const row = this.db.get('SELECT 1 AS ok FROM notifications WHERE id = ?', id);
    if (!row) throw Errors.notFound('notification');
    this.db.run('UPDATE notifications SET read_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?', id);
  }

  markAllRead(): number {
    const result = this.db.run('UPDATE notifications SET read_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE read_at IS NULL');
    return result.changes;
  }

  deleteNotification(id: string): void {
    this.db.run('DELETE FROM notifications WHERE id = ?', id);
  }

  purgeRead(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = this.db.run('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?', cutoff);
    return result.changes;
  }
}
