/**
 * Dentiva Pro — import and export service.
 */

import { newId } from '../../shared/id';
import { AppError, Errors } from '../../shared/errors';
import { normalizeName, normalizePhone } from '../../domain/patient';
import type { Database } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';
import { int, str } from '../repositories/row';

export interface ImportResult {
  batchId: string;
  totalRows: number;
  inserted: number;
  updated: number;
  rejected: number;
  errors: string[];
}

export interface ExportResult {
  id: string;
  recordCount: number;
  filePath: string | null;
}

export class ImportExportService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  /**
   * Import patients from JSON.
   * Validates, detects duplicates, preserves identifiers, reports errors, handles large datasets
   * transactionally.
   */
  importPatients(actor: AuditActor, data: unknown[]): ImportResult {
    const batchId = newId('imp');
    const errors: string[] = [];
    let inserted = 0;
    let rejected = 0;

    this.db.run(
      `INSERT INTO import_batches (id, kind, status, total_rows, started_at, created_by)
       VALUES (?, 'patient', 'running', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`,
      batchId,
      data.length,
      actor.userId,
    );

    try {
      this.db.transaction((tx) => {
        for (let i = 0; i < data.length; i++) {
          const row = data[i] as Record<string, unknown>;
          try {
            if (!row || typeof row !== 'object') throw new Error('Row is not an object');
            const name = String(row.name ?? '').trim();
            if (name === '' || name.length < 2) throw new Error('Name is required and must be at least 2 characters');
            if (name.length > 150) throw new Error('Name must be 150 characters or fewer');

            const phone = row.phone ? String(row.phone).trim() : null;
            const email = row.email ? String(row.email).trim().toLowerCase() : null;
            const dobKey = row.dobKey ? String(row.dobKey).trim() : null;
            if (dobKey && !/^\d{4}-\d{2}-\d{2}$/.test(dobKey)) throw new Error(`Invalid dobKey: ${dobKey}`);

            // Check duplicate by phone
            if (phone) {
              const normalized = normalizePhone(phone);
              if (normalized) {
                const existing = tx.get('SELECT id FROM patients WHERE phone_normalized = ?', normalized);
                if (existing) {
                  errors.push(`Row ${i + 1}: duplicate phone ${phone}, skipped`);
                  rejected += 1;
                  continue;
                }
              }
            }

            // Allocate patient code
            tx.run(
              `INSERT INTO sequences (name, next_value, updated_at) VALUES ('patient_code', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO NOTHING`,
            );
            const seqRow = tx.get(
              `UPDATE sequences SET next_value = next_value + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = 'patient_code' RETURNING next_value - 1 AS allocated`,
            );
            const seq = int(seqRow, 'allocated');
            const patientCode = `DP-${String(seq).padStart(6, '0')}`;
            const id = (row.id && typeof row.id === 'string' && row.id.startsWith('pat_') ? row.id : newId('pat')) as string;

            tx.run(
              `INSERT INTO patients (id, patient_code, name, name_normalized, sex, dob_key, phone, phone_normalized, email, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
              id,
              patientCode,
              name,
              normalizeName(name),
              (row.sex as string) || 'unspecified',
              dobKey,
              phone,
              normalizePhone(phone),
              email,
            );
            inserted += 1;
          } catch (error) {
            errors.push(`Row ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
            rejected += 1;
          }
        }
      });

      this.db.run(`UPDATE import_batches SET status = 'completed', inserted = ?, rejected = ?, errors = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, inserted, rejected, JSON.stringify(errors.slice(0, 100)), batchId);

      this.audit.record(actor, {
        action: AUDIT_ACTIONS.IMPORT_COMPLETED,
        entityType: 'import_batch',
        entityId: batchId,
        summary: `Imported ${inserted} patients (${rejected} rejected)`,
      });

      return { batchId, totalRows: data.length, inserted, updated: 0, rejected, errors };
    } catch (error) {
      this.db.run(`UPDATE import_batches SET status = 'failed', errors = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, JSON.stringify([String(error)]), batchId);
      throw AppError.fromUnknown(error, 'The import failed. No records were changed.');
    }
  }

  exportPatients(actor: AuditActor, filter: { search?: string; limit?: number }): ExportResult {
    const id = newId('xpt');
    const limit = filter.limit ?? 100000;
    let query = 'SELECT id, patient_code AS patientCode, name, sex, dob_key AS dobKey, phone, email, created_at AS createdAt FROM patients WHERE archived_at IS NULL';
    const args: unknown[] = [];
    if (filter.search) {
      query += ' AND (name LIKE ? OR patient_code LIKE ? OR phone LIKE ?)';
      const s = `%${filter.search}%`;
      args.push(s, s, s);
    }
    query += ' ORDER BY patient_code LIMIT ?';
    args.push(limit);

    const rows = this.db.all(query, ...args);
    const recordCount = rows.length;

    this.db.run(
      `INSERT INTO export_history (id, kind, format, record_count, filter_summary, created_by, created_at)
       VALUES (?, 'patient', 'json', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      id,
      recordCount,
      filter.search ? `search=${filter.search}` : 'all',
      actor.userId,
    );

    this.audit.record(actor, {
      action: AUDIT_ACTIONS.EXPORT_COMPLETED,
      entityType: 'export',
      entityId: id,
      summary: `Exported ${recordCount} patients`,
    });

    return { id, recordCount, filePath: null };
  }

  getExportData(exportId: string): unknown[] {
    const exportRow = this.db.get('SELECT kind FROM export_history WHERE id = ?', exportId);
    if (!exportRow) throw Errors.notFound('export');
    // For patients, return all matching (in real app, would stream from file)
    const rows = this.db.all('SELECT id, patient_code AS patientCode, name, sex, dob_key AS dobKey, phone, email, address, created_at AS createdAt FROM patients ORDER BY patient_code');
    return rows;
  }

  listImports(limit = 20, offset = 0): { rows: ImportBatchRow[]; total: number } {
    const totalRow = this.db.get('SELECT COUNT(*) AS n FROM import_batches') as { n: number };
    const rows = this.db.all('SELECT id, kind, status, total_rows AS totalRows, inserted, updated, rejected, started_at AS startedAt, completed_at AS completedAt FROM import_batches ORDER BY started_at DESC LIMIT ? OFFSET ?', limit, offset);
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        kind: str(r, 'kind'),
        status: str(r, 'status') as 'running' | 'completed' | 'failed' | 'rolled_back',
        totalRows: int(r, 'totalRows'),
        inserted: int(r, 'inserted'),
        updated: int(r, 'updated'),
        rejected: int(r, 'rejected'),
        startedAt: str(r, 'startedAt'),
        completedAt: r.completedAt ? String(r.completedAt) : null,
      })),
      total: int(totalRow, 'n'),
    };
  }

  listExports(limit = 20, offset = 0): { rows: ExportHistoryRow[]; total: number } {
    const totalRow = this.db.get('SELECT COUNT(*) AS n FROM export_history') as { n: number };
    const rows = this.db.all('SELECT id, kind, format, record_count AS recordCount, file_path AS filePath, created_at AS createdAt FROM export_history ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset);
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        kind: str(r, 'kind'),
        format: str(r, 'format') as 'csv' | 'json',
        recordCount: int(r, 'recordCount'),
        filePath: r.filePath ? String(r.filePath) : null,
        createdAt: str(r, 'createdAt'),
      })),
      total: int(totalRow, 'n'),
    };
  }
}

export interface ImportBatchRow {
  id: string;
  kind: string;
  status: 'running' | 'completed' | 'failed' | 'rolled_back';
  totalRows: number;
  inserted: number;
  updated: number;
  rejected: number;
  startedAt: string;
  completedAt: string | null;
}

export interface ExportHistoryRow {
  id: string;
  kind: string;
  format: 'csv' | 'json';
  recordCount: number;
  filePath: string | null;
  createdAt: string;
}
