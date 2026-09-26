/**
 * Dentiva Pro — global search.
 *
 * Every result carries the correct underlying identifier and an explicit result-kind handling
 * path. Search never swallows a query failure and returns an empty result; failures throw so the
 * UI can report them. No nonexistent columns are queried.
 */

import { AppError, Errors } from '../../shared/errors';
import { isWellFormedId } from '../../shared/id';
import { normalizeName, normalizePhone } from '../../domain/patient';
import type { Database } from '../db/sqlite';
import { int, str, strOrNull } from '../repositories/row';

export type SearchResultKind = 'patient' | 'appointment' | 'visit' | 'prescription' | 'invoice' | 'payment' | 'treatment' | 'inventory_item';

export interface SearchResult {
  kind: SearchResultKind;
  id: string;
  title: string;
  subtitle: string;
  patientId: string | null;
  patientCode: string | null;
  occurredAt: string | null;
  score: number;
  route: string;
}

export interface SearchParams {
  query: string;
  kinds?: SearchResultKind[];
  limit: number;
}

export class SearchService {
  constructor(private readonly db: Database) {}

  search(params: SearchParams): { results: SearchResult[]; truncated: boolean } {
    const query = (params.query ?? '').trim();
    if (query === '') return { results: [], truncated: false };
    if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
      throw Errors.validation('Search limit must be between 1 and 100.', { limit: 'Enter a value between 1 and 100.' });
    }
    const kinds = params.kinds && params.kinds.length > 0 ? params.kinds : (['patient', 'appointment', 'visit', 'prescription', 'invoice', 'payment'] as SearchResultKind[]);
    const results: SearchResult[] = [];

    try {
      if (kinds.includes('patient')) results.push(...this.searchPatients(query, params.limit));
      if (kinds.includes('appointment')) results.push(...this.searchAppointments(query, params.limit));
      if (kinds.includes('visit')) results.push(...this.searchVisits(query, params.limit));
      if (kinds.includes('prescription')) results.push(...this.searchPrescriptions(query, params.limit));
      if (kinds.includes('invoice')) results.push(...this.searchInvoices(query, params.limit));
      if (kinds.includes('payment')) results.push(...this.searchPayments(query, params.limit));
      if (kinds.includes('treatment')) results.push(...this.searchTreatments(query, params.limit));
      if (kinds.includes('inventory_item')) results.push(...this.searchInventory(query, params.limit));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.fromUnknown(error, 'The search could not be completed. Try a different search term.');
    }

    // Deterministic ordering: score desc, then kind, then title.
    const sorted = results
      .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
      .slice(0, params.limit);
    return { results: sorted, truncated: results.length > params.limit };
  }

  private searchPatients(query: string, limit: number): SearchResult[] {
    const normalized = normalizeName(query);
    const phone = normalizePhone(query);
    const like = `%${escapeLike(normalized)}%`;
    const clauses: string[] = [];
    const args: unknown[] = [];
    clauses.push('(p.name_normalized LIKE ? OR p.patient_code LIKE ?)');
    args.push(like, `${query.toUpperCase()}%`);
    if (phone) {
      clauses.push('p.phone_normalized = ?');
      args.push(phone);
    }
    if (query.includes('@')) {
      clauses.push('p.email LIKE ?');
      args.push(`%${escapeLike(query.toLowerCase())}%`);
    }
    const rows = this.db.all(
      `SELECT p.id, p.patient_code AS patientCode, p.name, p.phone, p.archived_at AS archivedAt
         FROM patients p WHERE ${clauses.join(' OR ')} ORDER BY p.name LIMIT ?`,
      ...args,
      limit,
    );
    return rows.map((r) => {
      const id = str(r, 'id');
      const code = str(r, 'patientCode');
      return {
        kind: 'patient' as const,
        id,
        title: `${str(r, 'name')} — ${code}`,
        subtitle: strOrNull(r, 'phone') ?? (r.archivedAt ? 'Archived' : ''),
        patientId: id,
        patientCode: code,
        occurredAt: null,
        score: code === query.toUpperCase() ? 100 : 70,
        route: `/patients/${id}`,
      };
    });
  }

  private searchAppointments(query: string, limit: number): SearchResult[] {
    if (/^DP-/i.test(query) || /^\d{2,}$/.test(query.replace(/\D/g, ''))) {
      // Patient Code or phone search: join patients.
      const rows = this.db.all(
        `SELECT a.id, a.starts_at AS startsAt, p.id AS patientId, p.patient_code AS patientCode, p.name AS patientName, a.status
           FROM appointments a JOIN patients p ON p.id = a.patient_id
          WHERE p.patient_code LIKE ? OR p.phone LIKE ? OR p.name LIKE ?
          ORDER BY a.starts_at DESC LIMIT ?`,
        `${query.toUpperCase()}%`,
        `%${query}%`,
        `%${query}%`,
        limit,
      );
      return rows.map((r) => ({
        kind: 'appointment' as const,
        id: str(r, 'id'),
        title: `Appointment — ${str(r, 'patientName')} (${str(r, 'patientCode')})`,
        subtitle: `${str(r, 'status').replace('_', ' ')} — ${str(r, 'startsAt')}`,
        patientId: str(r, 'patientId'),
        patientCode: str(r, 'patientCode'),
        occurredAt: str(r, 'startsAt'),
        score: 50,
        route: `/appointments?open=${str(r, 'id')}`,
      }));
    }
    return [];
  }

  private searchVisits(query: string, limit: number): SearchResult[] {
    const rows = this.db.all(
      `SELECT v.id, v.occurred_at AS occurredAt, p.id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              COALESCE(v.diagnosis, v.chief_complaint, '') AS summary
         FROM visits v JOIN patients p ON p.id = v.patient_id
        WHERE p.patient_code LIKE ? OR p.name LIKE ? OR v.diagnosis LIKE ? OR v.chief_complaint LIKE ?
        ORDER BY v.occurred_at DESC LIMIT ?`,
      `${query.toUpperCase()}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      limit,
    );
    return rows.map((r) => ({
      kind: 'visit' as const,
      id: str(r, 'id'),
      title: `Visit — ${str(r, 'patientName')} (${str(r, 'patientCode')})`,
      subtitle: str(r, 'summary').slice(0, 120),
      patientId: str(r, 'patientId'),
      patientCode: str(r, 'patientCode'),
      occurredAt: str(r, 'occurredAt'),
      score: 45,
      route: `/patients/${str(r, 'patientId')}?tab=visits&open=${str(r, 'id')}`,
    }));
  }

  private searchPrescriptions(query: string, limit: number): SearchResult[] {
    const rows = this.db.all(
      `SELECT rx.id, rx.issued_at AS issuedAt, p.id AS patientId, p.patient_code AS patientCode, p.name AS patientName
         FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id
        WHERE p.patient_code LIKE ? OR p.name LIKE ?
        ORDER BY rx.issued_at DESC LIMIT ?`,
      `${query.toUpperCase()}%`,
      `%${query}%`,
      limit,
    );
    return rows.map((r) => ({
      kind: 'prescription' as const,
      id: str(r, 'id'),
      title: `Prescription — ${str(r, 'patientName')} (${str(r, 'patientCode')})`,
      subtitle: str(r, 'issuedAt'),
      patientId: str(r, 'patientId'),
      patientCode: str(r, 'patientCode'),
      occurredAt: str(r, 'issuedAt'),
      score: 40,
      route: `/patients/${str(r, 'patientId')}?tab=prescriptions&open=${str(r, 'id')}`,
    }));
  }

  private searchInvoices(query: string, limit: number): SearchResult[] {
    const rows = this.db.all(
      `SELECT i.id, i.number, i.invoice_date AS invoiceDate, i.total_minor AS totalMinor, i.status,
              p.id AS patientId, p.patient_code AS patientCode, p.name AS patientName
         FROM invoices i JOIN patients p ON p.id = i.patient_id
        WHERE i.number LIKE ? OR p.patient_code LIKE ? OR p.name LIKE ?
        ORDER BY i.invoice_date DESC LIMIT ?`,
      `%${query.toUpperCase()}%`,
      `${query.toUpperCase()}%`,
      `%${query}%`,
      limit,
    );
    return rows.map((r) => ({
      kind: 'invoice' as const,
      id: str(r, 'id'),
      title: `Invoice ${str(r, 'number')} — ${str(r, 'patientName')}`,
      subtitle: `${str(r, 'status')} — ${int(r, 'totalMinor') / 100}`,
      patientId: str(r, 'patientId'),
      patientCode: str(r, 'patientCode'),
      occurredAt: str(r, 'invoiceDate'),
      score: query.toUpperCase().startsWith('INV-') ? 90 : 55,
      route: `/invoices?open=${str(r, 'id')}`,
    }));
  }

  private searchPayments(query: string, limit: number): SearchResult[] {
    if (!/^DP-|RCP-|INV-/i.test(query) && query.length < 3) return [];
    const rows = this.db.all(
      `SELECT pm.id, pm.paid_at AS paidAt, pm.amount_minor AS amountMinor, pm.method,
              p.id AS patientId, p.patient_code AS patientCode, p.name AS patientName, i.number AS invoiceNumber
         FROM payments pm JOIN patients p ON p.id = pm.patient_id JOIN invoices i ON i.id = pm.invoice_id
        WHERE i.number LIKE ? OR p.patient_code LIKE ? OR p.name LIKE ? OR pm.reference LIKE ?
        ORDER BY pm.paid_at DESC LIMIT ?`,
      `%${query.toUpperCase()}%`,
      `${query.toUpperCase()}%`,
      `%${query}%`,
      `%${query}%`,
      limit,
    );
    return rows.map((r) => ({
      kind: 'payment' as const,
      id: str(r, 'id'),
      title: `Payment ${int(r, 'amountMinor') / 100} — ${str(r, 'patientName')}`,
      subtitle: `${str(r, 'method')} — ${str(r, 'invoiceNumber')}`,
      patientId: str(r, 'patientId'),
      patientCode: str(r, 'patientCode'),
      occurredAt: str(r, 'paidAt'),
      score: 35,
      route: `/invoices?open=${str(r, 'id')}&tab=payments`,
    }));
  }

  private searchTreatments(query: string, limit: number): SearchResult[] {
    const rows = this.db.all(
      `SELECT id, code, name, category FROM treatments
        WHERE code LIKE ? OR name LIKE ? OR category LIKE ? ORDER BY name LIMIT ?`,
      `%${query.toUpperCase()}%`,
      `%${query}%`,
      `%${query}%`,
      limit,
    );
    return rows.map((r) => ({
      kind: 'treatment' as const,
      id: str(r, 'id'),
      title: `${str(r, 'name')} (${str(r, 'code')})`,
      subtitle: strOrNull(r, 'category') ?? '',
      patientId: null,
      patientCode: null,
      occurredAt: null,
      score: 30,
      route: `/treatments?open=${str(r, 'id')}`,
    }));
  }

  private searchInventory(query: string, limit: number): SearchResult[] {
    const rows = this.db.all(
      `SELECT id, sku, name, category FROM inventory_items
        WHERE sku LIKE ? OR name LIKE ? OR category LIKE ? ORDER BY name LIMIT ?`,
      `%${query.toUpperCase()}%`,
      `%${query}%`,
      `%${query}%`,
      limit,
    );
    return rows.map((r) => ({
      kind: 'inventory_item' as const,
      id: str(r, 'id'),
      title: `${str(r, 'name')} (${str(r, 'sku')})`,
      subtitle: strOrNull(r, 'category') ?? '',
      patientId: null,
      patientCode: null,
      occurredAt: null,
      score: 25,
      route: `/inventory?open=${str(r, 'id')}`,
    }));
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export { isWellFormedId };
