/**
 * Dentiva Pro — dashboard service.
 *
 * Every metric comes from real persisted data. No fake metrics, no placeholder counts, no
 * decorative widget without useful data. Each metric is a SQL query so it reflects the current
 * state even after a restore or a large import.
 */

import { combineDateAndTime, todayKey, toIso } from '../../shared/dates';
import type { Database } from '../db/sqlite';
import { int } from '../repositories/row';

export interface DashboardMetrics {
  dateKey: string;
  timeZone: string;
  appointments: { today: number; upcoming: number; completed: number; cancelled: number; noShow: number };
  queue: { waiting: number; called: number; inProgress: number; completed: number; total: number };
  visits: { today: number };
  revenue: { todayMinor: number; monthMinor: number; outstandingMinor: number };
  payments: { todayMinor: number; todayCount: number };
  patients: { total: number; newToday: number; archived: number };
  followUps: { overdue: number; dueToday: number; dueWeek: number };
  inventory: { lowStock: number; expired: number; expiringSoon: number };
  recentActivity: { auditCount: number };
}

export class DashboardService {
  constructor(private readonly db: Database, private readonly timeZone: () => string) {}

  getMetrics(): DashboardMetrics {
    const tz = this.timeZone();
    const today = todayKey(tz);
    const todayStart = toIso(combineDateAndTime(today, '00:00', tz));
    const todayEnd = toIso(new Date(combineDateAndTime(today, '00:00', tz).getTime() + 86_400_000));
    const monthStart = `${today.slice(0, 7)}-01`;

    const appointmentRow = this.db.get(
      `SELECT
         SUM(CASE WHEN starts_at >= ? AND starts_at < ? THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN starts_at >= ? AND status IN ('scheduled','confirmed') THEN 1 ELSE 0 END) AS upcoming,
         SUM(CASE WHEN starts_at >= ? AND starts_at < ? AND status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN starts_at >= ? AND starts_at < ? AND status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN starts_at >= ? AND starts_at < ? AND status = 'no_show' THEN 1 ELSE 0 END) AS noShow
       FROM appointments`,
      todayStart,
      todayEnd,
      todayStart,
      todayStart,
      todayEnd,
      todayStart,
      todayEnd,
      todayStart,
      todayEnd,
    );

    const queueRow = this.db.get(
      `SELECT
         SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
         SUM(CASE WHEN status = 'called' THEN 1 ELSE 0 END) AS called,
         SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS inProgress,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         COUNT(*) AS total
       FROM queue_entries WHERE queue_date = ?`,
      today,
    );

    const visitRow = this.db.get('SELECT COUNT(*) AS n FROM visits WHERE occurred_at >= ? AND occurred_at < ?', todayStart, todayEnd);

    const revenueRow = this.db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN invoice_date = ? THEN total_minor ELSE 0 END),0) AS todayMinor,
         COALESCE(SUM(CASE WHEN invoice_date >= ? THEN total_minor ELSE 0 END),0) AS monthMinor,
         COALESCE(SUM(total_minor - paid_minor + refunded_minor + adjusted_minor),0) AS outstandingMinor
       FROM invoices WHERE status <> 'void'`,
      today,
      monthStart,
    );

    const paymentRow = this.db.get(
      `SELECT COALESCE(SUM(amount_minor),0) AS todayMinor, COUNT(*) AS todayCount
         FROM payments WHERE voided_at IS NULL AND paid_at >= ? AND paid_at < ?`,
      todayStart,
      todayEnd,
    );

    const patientRow = this.db.get(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN substr(created_at,1,10) = ? THEN 1 ELSE 0 END) AS newToday,
         SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
       FROM patients`,
      today,
    );

    const followUpRow = this.db.get(
      `SELECT
         SUM(CASE WHEN due_date_key < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN due_date_key = ? THEN 1 ELSE 0 END) AS dueToday,
         SUM(CASE WHEN due_date_key <= ? THEN 1 ELSE 0 END) AS dueWeek
       FROM follow_ups WHERE status = 'pending'`,
      today,
      today,
      shiftDays(today, 7),
    );

    const inventoryRow = this.db.get(
      `SELECT
         SUM(CASE WHEN quantity <= min_quantity AND min_quantity > 0 THEN 1 ELSE 0 END) AS lowStock,
         SUM(CASE WHEN expiry_key IS NOT NULL AND expiry_key < ? THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN expiry_key IS NOT NULL AND expiry_key >= ? AND expiry_key <= ? THEN 1 ELSE 0 END) AS expiringSoon
       FROM inventory_items WHERE active = 1`,
      today,
      today,
      shiftDays(today, 60),
    );

    const auditRow = this.db.get('SELECT COUNT(*) AS n FROM audit_log');

    return {
      dateKey: today,
      timeZone: tz,
      appointments: {
        today: int(appointmentRow, 'today'),
        upcoming: int(appointmentRow, 'upcoming'),
        completed: int(appointmentRow, 'completed'),
        cancelled: int(appointmentRow, 'cancelled'),
        noShow: int(appointmentRow, 'noShow'),
      },
      queue: {
        waiting: int(queueRow, 'waiting'),
        called: int(queueRow, 'called'),
        inProgress: int(queueRow, 'inProgress'),
        completed: int(queueRow, 'completed'),
        total: int(queueRow, 'total'),
      },
      visits: { today: int(visitRow, 'n') },
      revenue: {
        todayMinor: int(revenueRow, 'todayMinor'),
        monthMinor: int(revenueRow, 'monthMinor'),
        outstandingMinor: int(revenueRow, 'outstandingMinor'),
      },
      payments: { todayMinor: int(paymentRow, 'todayMinor'), todayCount: int(paymentRow, 'todayCount') },
      patients: { total: int(patientRow, 'total'), newToday: int(patientRow, 'newToday'), archived: int(patientRow, 'archived') },
      followUps: { overdue: int(followUpRow, 'overdue'), dueToday: int(followUpRow, 'dueToday'), dueWeek: int(followUpRow, 'dueWeek') },
      inventory: { lowStock: int(inventoryRow, 'lowStock'), expired: int(inventoryRow, 'expired'), expiringSoon: int(inventoryRow, 'expiringSoon') },
      recentActivity: { auditCount: int(auditRow, 'n') },
    };
  }

  todayAppointments(limit = 20): AppointmentSummary[] {
    const tz = this.timeZone();
    const today = todayKey(tz);
    const todayStart = toIso(combineDateAndTime(today, '00:00', tz));
    const todayEnd = toIso(new Date(combineDateAndTime(today, '00:00', tz).getTime() + 86_400_000));
    const rows = this.db.all(
      `SELECT a.id, a.starts_at AS startsAt, a.status, p.id AS patientId, p.patient_code AS patientCode, p.name AS patientName, d.name AS dentistName
         FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN dentists d ON d.id = a.dentist_id
        WHERE a.starts_at >= ? AND a.starts_at < ? ORDER BY a.starts_at LIMIT ?`,
      todayStart,
      todayEnd,
      limit,
    );
    return rows.map((r) => ({
      id: String(r.id),
      startsAt: String(r.startsAt),
      status: String(r.status),
      patientId: String(r.patientId),
      patientCode: String(r.patientCode),
      patientName: String(r.patientName),
      dentistName: r.dentistName ? String(r.dentistName) : null,
    }));
  }

  lowStockAlerts(limit = 20): { id: string; sku: string; name: string; quantity: number; minQuantity: number }[] {
    const rows = this.db.all(
      'SELECT id, sku, name, quantity, min_quantity AS minQuantity FROM inventory_items WHERE active = 1 AND quantity <= min_quantity AND min_quantity > 0 ORDER BY quantity LIMIT ?',
      limit,
    );
    return rows.map((r) => ({
      id: String(r.id),
      sku: String(r.sku),
      name: String(r.name),
      quantity: int(r, 'quantity'),
      minQuantity: int(r, 'minQuantity'),
    }));
  }

  recentPatients(limit = 10): { id: string; patientCode: string; name: string; createdAt: string }[] {
    const rows = this.db.all('SELECT id, patient_code AS patientCode, name, created_at AS createdAt FROM patients WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => ({
      id: String(r.id),
      patientCode: String(r.patientCode),
      name: String(r.name),
      createdAt: String(r.createdAt),
    }));
  }
}

function shiftDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export interface AppointmentSummary {
  id: string;
  startsAt: string;
  status: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  dentistName: string | null;
}
