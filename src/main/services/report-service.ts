/**
 * Dentiva Pro — reporting service.
 *
 * Every report uses real persisted data and supports filtering. Results are never truncated
 * silently: the total is always reported alongside the page.
 */

import { Errors } from '../../shared/errors';
import type { Database } from '../db/sqlite';
import { int, str, strOrNull } from '../repositories/row';

export interface ReportParams {
  fromKey?: string | null;
  toKey?: string | null;
  dentistId?: string | null;
  patientId?: string | null;
  status?: string | null;
  limit: number;
  offset: number;
}

export class ReportService {
  constructor(private readonly db: Database) {}

  revenue(params: ReportParams): { rows: RevenueRow[]; total: number; summary: RevenueSummary } {
    const { where, args } = this.buildWhere(params, 'i.invoice_date', 'i.dentist_id', 'i.patient_id', 'i.status');
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM invoices i ${where}`, ...args) as { n: number };
    const summaryRow = this.db.get(
      `SELECT COALESCE(SUM(i.subtotal_minor),0) AS subtotalMinor, COALESCE(SUM(i.discount_minor),0) AS discountMinor,
              COALESCE(SUM(i.tax_minor),0) AS taxMinor, COALESCE(SUM(i.total_minor),0) AS totalMinor,
              COALESCE(SUM(i.paid_minor),0) AS paidMinor, COALESCE(SUM(i.total_minor - i.paid_minor + i.refunded_minor + i.adjusted_minor),0) AS outstandingMinor
         FROM invoices i ${where}`,
      ...args,
    );
    const rows = this.db.all(
      `SELECT i.id, i.number, i.invoice_date AS invoiceDate, i.status, i.total_minor AS totalMinor,
              i.paid_minor AS paidMinor, i.discount_minor AS discountMinor, i.tax_minor AS taxMinor,
              p.patient_code AS patientCode, p.name AS patientName, d.name AS dentistName
         FROM invoices i JOIN patients p ON p.id = i.patient_id LEFT JOIN dentists d ON d.id = i.dentist_id
         ${where} ORDER BY i.invoice_date DESC, i.number DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        number: str(r, 'number'),
        invoiceDate: str(r, 'invoiceDate'),
        status: str(r, 'status'),
        totalMinor: int(r, 'totalMinor'),
        paidMinor: int(r, 'paidMinor'),
        discountMinor: int(r, 'discountMinor'),
        taxMinor: int(r, 'taxMinor'),
        patientCode: str(r, 'patientCode'),
        patientName: str(r, 'patientName'),
        dentistName: strOrNull(r, 'dentistName'),
      })),
      total: int(totalRow, 'n'),
      summary: {
        subtotalMinor: int(summaryRow, 'subtotalMinor'),
        discountMinor: int(summaryRow, 'discountMinor'),
        taxMinor: int(summaryRow, 'taxMinor'),
        totalMinor: int(summaryRow, 'totalMinor'),
        paidMinor: int(summaryRow, 'paidMinor'),
        outstandingMinor: int(summaryRow, 'outstandingMinor'),
      },
    };
  }

  payments(params: ReportParams): { rows: PaymentReportRow[]; total: number; summary: { totalMinor: number } } {
    const { where, args } = this.buildWhere(params, 'substr(pm.paid_at,1,10)', null, 'pm.patient_id', null, 'pm');
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM payments pm ${where} AND pm.voided_at IS NULL`, ...args) as { n: number };
    const summaryRow = this.db.get(`SELECT COALESCE(SUM(pm.amount_minor),0) AS totalMinor FROM payments pm ${where} AND pm.voided_at IS NULL`, ...args) as {
      totalMinor: number;
    };
    const rows = this.db.all(
      `SELECT pm.id, pm.paid_at AS paidAt, pm.amount_minor AS amountMinor, pm.method, pm.reference,
              i.number AS invoiceNumber, p.patient_code AS patientCode, p.name AS patientName
         FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN patients p ON p.id = pm.patient_id
         ${where} AND pm.voided_at IS NULL ORDER BY pm.paid_at DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        paidAt: str(r, 'paidAt'),
        amountMinor: int(r, 'amountMinor'),
        method: str(r, 'method'),
        reference: strOrNull(r, 'reference'),
        invoiceNumber: str(r, 'invoiceNumber'),
        patientCode: str(r, 'patientCode'),
        patientName: str(r, 'patientName'),
      })),
      total: int(totalRow, 'n'),
      summary: { totalMinor: int(summaryRow, 'totalMinor') },
    };
  }

  outstanding(params: ReportParams): { rows: OutstandingRow[]; total: number; summary: { outstandingMinor: number } } {
    const { where, args } = this.buildWhere(params, 'i.invoice_date', 'i.dentist_id', 'i.patient_id', null);
    const whereOutstanding = where ? `${where} AND (i.total_minor - i.paid_minor + i.refunded_minor + i.adjusted_minor) > 0` : 'WHERE (i.total_minor - i.paid_minor + i.refunded_minor + i.adjusted_minor) > 0 AND i.status <> \'void\'';
    const whereWithVoid = where ? `${where} AND i.status <> 'void' AND (i.total_minor - i.paid_minor + i.refunded_minor + i.adjusted_minor) > 0` : 'WHERE i.status <> \'void\' AND (i.total_minor - i.paid_minor + i.refunded_minor + i.adjusted_minor) > 0';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM invoices i ${whereWithVoid}`, ...args) as { n: number };
    const summaryRow = this.db.get(
      `SELECT COALESCE(SUM(i.total_minor - i.paid_minor + i.refunded_minor + i.adjusted_minor),0) AS outstandingMinor FROM invoices i ${whereWithVoid}`,
      ...args,
    );
    const rows = this.db.all(
      `SELECT i.id, i.number, i.invoice_date AS invoiceDate, i.total_minor AS totalMinor,
              (i.total_minor - i.paid_minor + i.refunded_minor + i.adjusted_minor) AS outstandingMinor,
              p.patient_code AS patientCode, p.name AS patientName, p.phone
         FROM invoices i JOIN patients p ON p.id = i.patient_id ${whereOutstanding}
        ORDER BY i.invoice_date DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        number: str(r, 'number'),
        invoiceDate: str(r, 'invoiceDate'),
        totalMinor: int(r, 'totalMinor'),
        outstandingMinor: int(r, 'outstandingMinor'),
        patientCode: str(r, 'patientCode'),
        patientName: str(r, 'patientName'),
        phone: strOrNull(r, 'phone'),
      })),
      total: int(totalRow, 'n'),
      summary: { outstandingMinor: int(summaryRow, 'outstandingMinor') },
    };
  }

  appointments(params: ReportParams): { rows: AppointmentReportRow[]; total: number } {
    const { where, args } = this.buildWhere(params, 'substr(a.starts_at,1,10)', 'a.dentist_id', 'a.patient_id', 'a.status', 'a');
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM appointments a ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT a.id, a.starts_at AS startsAt, a.ends_at AS endsAt, a.status, a.reason,
              p.patient_code AS patientCode, p.name AS patientName, d.name AS dentistName
         FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN dentists d ON d.id = a.dentist_id
         ${where} ORDER BY a.starts_at DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        startsAt: str(r, 'startsAt'),
        endsAt: str(r, 'endsAt'),
        status: str(r, 'status'),
        reason: strOrNull(r, 'reason'),
        patientCode: str(r, 'patientCode'),
        patientName: str(r, 'patientName'),
        dentistName: strOrNull(r, 'dentistName'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  visits(params: ReportParams): { rows: VisitReportRow[]; total: number } {
    const { where, args } = this.buildWhere(params, 'substr(v.occurred_at,1,10)', 'v.dentist_id', 'v.patient_id', null, 'v');
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM visits v ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT v.id, v.occurred_at AS occurredAt, v.diagnosis, p.patient_code AS patientCode, p.name AS patientName, d.name AS dentistName
         FROM visits v JOIN patients p ON p.id = v.patient_id LEFT JOIN dentists d ON d.id = v.dentist_id
         ${where} ORDER BY v.occurred_at DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        occurredAt: str(r, 'occurredAt'),
        diagnosis: strOrNull(r, 'diagnosis'),
        patientCode: str(r, 'patientCode'),
        patientName: str(r, 'patientName'),
        dentistName: strOrNull(r, 'dentistName'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  inventory(params: { search?: string; category?: string | null; lowOnly?: boolean; expiredOnly?: boolean; limit: number; offset: number }): {
    rows: InventoryReportRow[];
    total: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.search) {
      const s = `%${params.search.replace(/[%_\\]/g, '\\$&')}%`;
      clauses.push('(it.name LIKE ? OR it.sku LIKE ?)');
      args.push(s, s);
    }
    if (params.category) {
      clauses.push('it.category = ?');
      args.push(params.category);
    }
    if (params.lowOnly) clauses.push('it.quantity <= it.min_quantity AND it.min_quantity > 0');
    if (params.expiredOnly) clauses.push('it.expiry_key IS NOT NULL AND it.expiry_key < date(\'now\')');
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM inventory_items it ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT it.id, it.sku, it.name, it.category, it.quantity, it.min_quantity AS minQuantity, it.expiry_key AS expiryKey, it.cost_minor AS costMinor, it.price_minor AS priceMinor
         FROM inventory_items it ${where} ORDER BY it.name LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        sku: str(r, 'sku'),
        name: str(r, 'name'),
        category: strOrNull(r, 'category'),
        quantity: int(r, 'quantity'),
        minQuantity: int(r, 'minQuantity'),
        expiryKey: strOrNull(r, 'expiryKey'),
        costMinor: int(r, 'costMinor'),
        priceMinor: int(r, 'priceMinor'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  audit(params: { fromIso?: string | null; toIso?: string | null; action?: string | null; entityType?: string | null; limit: number; offset: number }): {
    rows: AuditReportRow[];
    total: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.fromIso) {
      clauses.push('occurred_at >= ?');
      args.push(params.fromIso);
    }
    if (params.toIso) {
      clauses.push('occurred_at <= ?');
      args.push(params.toIso);
    }
    if (params.action) {
      clauses.push('action = ?');
      args.push(params.action);
    }
    if (params.entityType) {
      clauses.push('entity_type = ?');
      args.push(params.entityType);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM audit_log ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT id, occurred_at AS occurredAt, actor_name AS actorName, action, entity_type AS entityType, entity_id AS entityId, summary
         FROM audit_log ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        occurredAt: str(r, 'occurredAt'),
        actorName: str(r, 'actorName'),
        action: str(r, 'action'),
        entityType: strOrNull(r, 'entityType'),
        entityId: strOrNull(r, 'entityId'),
        summary: strOrNull(r, 'summary'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  patients(params: { search?: string; sex?: string | null; archived?: boolean | null; limit: number; offset: number }): {
    rows: PatientReportRow[];
    total: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.search) {
      const s = `%${params.search.replace(/[%_\\]/g, '\\$&')}%`;
      clauses.push('(name LIKE ? OR patient_code LIKE ? OR phone LIKE ?)');
      args.push(s, s, s);
    }
    if (params.sex) {
      clauses.push('sex = ?');
      args.push(params.sex);
    }
    if (params.archived === true) clauses.push('archived_at IS NOT NULL');
    else if (params.archived === false) clauses.push('archived_at IS NULL');
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM patients ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT id, patient_code AS patientCode, name, sex, phone, dob_key AS dobKey, created_at AS createdAt, archived_at AS archivedAt
         FROM patients ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        patientCode: str(r, 'patientCode'),
        name: str(r, 'name'),
        sex: str(r, 'sex'),
        phone: strOrNull(r, 'phone'),
        dobKey: strOrNull(r, 'dobKey'),
        createdAt: str(r, 'createdAt'),
        archivedAt: strOrNull(r, 'archivedAt'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  private buildWhere(
    params: { fromKey?: string | null; toKey?: string | null; dentistId?: string | null; patientId?: string | null; status?: string | null },
    dateColumn: string,
    dentistColumn: string | null,
    patientColumn: string | null,
    statusColumn: string | null,
    alias = 'i',
  ): { where: string; args: unknown[] } {
    void alias;
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.fromKey) {
      clauses.push(`${dateColumn} >= ?`);
      args.push(params.fromKey);
    }
    if (params.toKey) {
      clauses.push(`${dateColumn} <= ?`);
      args.push(params.toKey);
    }
    if (params.dentistId && dentistColumn) {
      clauses.push(`${dentistColumn} = ?`);
      args.push(params.dentistId);
    }
    if (params.patientId && patientColumn) {
      clauses.push(`${patientColumn} = ?`);
      args.push(params.patientId);
    }
    if (params.status && statusColumn) {
      clauses.push(`${statusColumn} = ?`);
      args.push(params.status);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }
}

export interface RevenueRow {
  id: string;
  number: string;
  invoiceDate: string;
  status: string;
  totalMinor: number;
  paidMinor: number;
  discountMinor: number;
  taxMinor: number;
  patientCode: string;
  patientName: string;
  dentistName: string | null;
}
export interface RevenueSummary {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
}
export interface PaymentReportRow {
  id: string;
  paidAt: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  invoiceNumber: string;
  patientCode: string;
  patientName: string;
}
export interface OutstandingRow {
  id: string;
  number: string;
  invoiceDate: string;
  totalMinor: number;
  outstandingMinor: number;
  patientCode: string;
  patientName: string;
  phone: string | null;
}
export interface AppointmentReportRow {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  reason: string | null;
  patientCode: string;
  patientName: string;
  dentistName: string | null;
}
export interface VisitReportRow {
  id: string;
  occurredAt: string;
  diagnosis: string | null;
  patientCode: string;
  patientName: string;
  dentistName: string | null;
}
export interface InventoryReportRow {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  quantity: number;
  minQuantity: number;
  expiryKey: string | null;
  costMinor: number;
  priceMinor: number;
}
export interface AuditReportRow {
  id: string;
  occurredAt: string;
  actorName: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
}
export interface PatientReportRow {
  id: string;
  patientCode: string;
  name: string;
  sex: string;
  phone: string | null;
  dobKey: string | null;
  createdAt: string;
  archivedAt: string | null;
}
