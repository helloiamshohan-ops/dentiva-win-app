/**
 * Dentiva Pro — data integrity diagnostics.
 */

import type { Database } from '../db/sqlite';
import { verifySchema, type SchemaVerification } from '../db/migrate';
import { int, str } from '../repositories/row';
import { recomputeQuantity } from '../../domain/inventory';
import { computeOutstanding } from '../../domain/financial';

export interface IntegrityIssue {
  kind: string;
  severity: 'error' | 'warning';
  entityType: string;
  entityId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IntegrityReport {
  schema: SchemaVerification;
  pragmas: { journalMode: string; foreignKeys: number; synchronous: number };
  integrityCheck: { ok: boolean; detail: string };
  foreignKeyViolations: { table: string; rowid: number; parent: number; fkid: number }[];
  issues: IntegrityIssue[];
  ok: boolean;
  checkedAt: string;
}

export class IntegrityService {
  constructor(private readonly db: Database, private readonly attachmentsDir: () => string) {}

  check(): IntegrityReport {
    const schema = verifySchema(this.db);
    const pragmas = this.db.verifyPragmas();
    const integrityCheck = this.db.integrityCheck();
    const foreignKeyViolations = this.db.foreignKeyCheck() as { table: string; rowid: number; parent: number; fkid: number }[];
    const issues: IntegrityIssue[] = [];

    if (!integrityCheck.ok) {
      issues.push({ kind: 'integrity_check', severity: 'error', entityType: 'database', message: `SQLite integrity check failed: ${integrityCheck.detail}` });
    }
    for (const v of foreignKeyViolations) {
      issues.push({
        kind: 'foreign_key',
        severity: 'error',
        entityType: v.table,
        entityId: String(v.rowid),
        message: `Foreign key violation in ${v.table} row ${v.rowid} (parent ${v.parent}, fkid ${v.fkid})`,
        details: v as unknown as Record<string, unknown>,
      });
    }
    if (schema.missingTables.length > 0) {
      for (const t of schema.missingTables) {
        issues.push({ kind: 'missing_table', severity: 'error', entityType: t, message: `Required table "${t}" is missing.` });
      }
    }

    // Duplicate Patient Codes
    const dupPatientCodes = this.db.all(
      `SELECT patient_code AS patientCode, COUNT(*) AS count FROM patients GROUP BY patient_code HAVING COUNT(*) > 1`,
    );
    for (const row of dupPatientCodes) {
      issues.push({
        kind: 'duplicate_patient_code',
        severity: 'error',
        entityType: 'patient',
        message: `Patient Code ${String(row.patientCode)} appears ${String(row.count)} times.`,
        details: { patientCode: String(row.patientCode), count: Number(row.count) },
      });
    }

    // Duplicate invoice numbers
    const dupInvoices = this.db.all(`SELECT number, COUNT(*) AS count FROM invoices GROUP BY number HAVING COUNT(*) > 1`);
    for (const row of dupInvoices) {
      issues.push({
        kind: 'duplicate_invoice_number',
        severity: 'error',
        entityType: 'invoice',
        message: `Invoice number ${String(row.number)} appears ${String(row.count)} times.`,
      });
    }

    // Duplicate receipt numbers
    const dupReceipts = this.db.all(`SELECT number, COUNT(*) AS count FROM receipts GROUP BY number HAVING COUNT(*) > 1`);
    for (const row of dupReceipts) {
      issues.push({
        kind: 'duplicate_receipt_number',
        severity: 'error',
        entityType: 'receipt',
        message: `Receipt number ${String(row.number)} appears ${String(row.count)} times.`,
      });
    }

    // Orphan visits (patient missing) — should be caught by FK, but double-check
    const orphanVisits = this.db.all(
      `SELECT v.id FROM visits v LEFT JOIN patients p ON p.id = v.patient_id WHERE p.id IS NULL`,
    );
    for (const row of orphanVisits) {
      issues.push({ kind: 'orphan_record', severity: 'error', entityType: 'visit', entityId: String(row.id), message: `Visit ${String(row.id)} references a missing patient.` });
    }

    // Invalid financial relationships: paid > total without overpayment allowed is not necessarily an error,
    // but we check for negative paid/refunded
    const invalidPayments = this.db.all(`SELECT id FROM payments WHERE amount_minor <= 0`);
    for (const row of invalidPayments) {
      issues.push({ kind: 'invalid_payment', severity: 'error', entityType: 'payment', entityId: String(row.id), message: `Payment ${String(row.id)} has an invalid amount.` });
    }

    // Invoice invariant check (recompute)
    const invoices = this.db.all(
      `SELECT id, number, subtotal_minor AS subtotalMinor, discount_minor AS discountMinor, taxable_minor AS taxableMinor, tax_minor AS taxMinor, total_minor AS totalMinor FROM invoices WHERE status <> 'void'`,
    );
    for (const inv of invoices) {
      const subtotal = int(inv, 'subtotalMinor');
      const discount = int(inv, 'discountMinor');
      const taxable = int(inv, 'taxableMinor');
      const tax = int(inv, 'taxMinor');
      const total = int(inv, 'totalMinor');
      if (subtotal - discount + tax !== total || taxable !== subtotal - discount) {
        issues.push({
          kind: 'financial_invariant',
          severity: 'error',
          entityType: 'invoice',
          entityId: str(inv, 'id'),
          message: `Invoice ${str(inv, 'number')} totals do not reconcile (I1 violation).`,
          details: { subtotal, discount, taxable, tax, total },
        });
      }
    }

    // Invoice balance vs child rows
    const balanceChecks = this.db.all(
      `SELECT i.id, i.number, i.paid_minor AS paidMinor, i.refunded_minor AS refundedMinor, i.adjusted_minor AS adjustedMinor,
              (SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE invoice_id = i.id AND voided_at IS NULL) AS computedPaid,
              (SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE invoice_id = i.id) AS computedRefunded,
              (SELECT COALESCE(SUM(delta_minor),0) FROM adjustments WHERE invoice_id = i.id) AS computedAdjusted
         FROM invoices i WHERE i.status <> 'void'`,
    );
    for (const row of balanceChecks) {
      const paid = int(row, 'paidMinor');
      const computedPaid = int(row, 'computedPaid');
      const refunded = int(row, 'refundedMinor');
      const computedRefunded = int(row, 'computedRefunded');
      const adjusted = int(row, 'adjustedMinor');
      const computedAdjusted = int(row, 'computedAdjusted');
      if (paid !== computedPaid || refunded !== computedRefunded || adjusted !== computedAdjusted) {
        issues.push({
          kind: 'balance_mismatch',
          severity: 'error',
          entityType: 'invoice',
          entityId: str(row, 'id'),
          message: `Invoice ${str(row, 'number')} derived balances do not match child records.`,
          details: { paid, computedPaid, refunded, computedRefunded, adjusted, computedAdjusted },
        });
      }
    }

    // Inventory quantity vs movements
    const inventoryItems = this.db.all('SELECT id, quantity FROM inventory_items');
    for (const item of inventoryItems) {
      const movements = this.db.all('SELECT signed_quantity AS signedQuantity FROM inventory_movements WHERE item_id = ?', String(item.id)) as {
        signedQuantity: number;
      }[];
      const computed = recomputeQuantity(movements);
      const stored = int(item, 'quantity');
      if (computed !== stored) {
        issues.push({
          kind: 'inventory_mismatch',
          severity: 'error',
          entityType: 'inventory_item',
          entityId: String(item.id),
          message: `Inventory item ${String(item.id)} quantity ${stored} does not match movement history ${computed}.`,
          details: { stored, computed },
        });
      }
    }

    // Missing attachments
    const attachments = this.db.all('SELECT id, stored_name AS storedName FROM attachments');
    const dir = this.attachmentsDir();
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    for (const att of attachments) {
      const filePath = join(dir, String(att.storedName));
      if (!existsSync(filePath)) {
        issues.push({
          kind: 'missing_attachment',
          severity: 'warning',
          entityType: 'attachment',
          entityId: String(att.id),
          message: `Attachment ${String(att.id)} file is missing from disk.`,
          details: { storedName: String(att.storedName) },
        });
      }
    }

    // Orphan attachments (patient_id set but patient missing) — FK would catch but check
    const orphanAttachments = this.db.all(
      `SELECT a.id FROM attachments a LEFT JOIN patients p ON p.id = a.patient_id WHERE a.patient_id IS NOT NULL AND p.id IS NULL`,
    );
    for (const row of orphanAttachments) {
      issues.push({
        kind: 'orphan_attachment',
        severity: 'error',
        entityType: 'attachment',
        entityId: String(row.id),
        message: `Attachment ${String(row.id)} references a missing patient.`,
      });
    }

    const ok = issues.filter((i) => i.severity === 'error').length === 0 && schema.ok && integrityCheck.ok && foreignKeyViolations.length === 0;

    return {
      schema,
      pragmas,
      integrityCheck,
      foreignKeyViolations,
      issues,
      ok,
      checkedAt: new Date().toISOString(),
    };
  }
}
