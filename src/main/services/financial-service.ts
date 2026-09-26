/**
 * Dentiva Pro — financial service (invoices, payments, receipts, refunds, adjustments, statements).
 *
 * Invariants enforced here and in the database:
 *   I1  subtotal − discount + tax = total
 *   I2  total − payments + refunds + adjustments = outstanding
 *   I3  paid ≤ total unless overpayment is explicitly permitted
 *
 * Every write is a single transaction that (a) writes the child record, (b) recomputes and
 * rewrites the parent's derived columns from the child rows, and (c) audits the change. Derived
 * columns are never accepted from the caller, so a stale or forged total cannot be persisted.
 *
 * Double submission is prevented with a unique `idempotency_key` on payments, refunds and
 * adjustments. The renderer supplies a key per user intent; a retried IPC call with the same key
 * returns the original record instead of recording a second transaction.
 */

import { AppError, Errors } from '../../shared/errors';
import { newId, formatDocumentNumber, DOCUMENT_PREFIX } from '../../shared/id';
import { toIso, todayKey, partsInTimeZone } from '../../shared/dates';
import { assertMinorAmount } from '../../shared/money';
import {
  ADJUSTMENT_KINDS,
  REFUND_REASONS,
  adjustDeltaGuard,
  adjustmentDelta,
  assertInvoiceInvariant,
  assertInvoiceMutable,
  computeInvoiceTotals,
  computeOutstanding,
  computeStatement,
  deriveInvoiceStatus,
  validatePayment,
  validateRefund,
  type AdjustmentKind,
  type InvoiceLineInput,
  type InvoiceStatus,
  type RefundReason,
  type StatementEntryInput,
} from '../../domain/financial';
import type { Database, Transaction } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';
import { int, num, str, strOrNull } from '../repositories/row';

export interface InvoiceLine extends InvoiceLineInput {
  toothNumber?: number | null;
  planItemId?: string | null;
}

export interface InvoiceInput {
  patientId: string;
  dentistId?: string | null;
  visitId?: string | null;
  invoiceDateKey?: string | null;
  dueDateKey?: string | null;
  lines: InvoiceLine[];
  discountMinor?: number;
  taxPercent?: number;
  notes?: string | null;
}

export interface InvoiceRow {
  id: string;
  number: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  dentistId: string | null;
  dentistName: string | null;
  visitId: string | null;
  invoiceDate: string;
  dueDateKey: string | null;
  status: InvoiceStatus;
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxPercent: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  adjustedMinor: number;
  outstandingMinor: number;
  notes: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
  lines: InvoiceItemRow[];
}

export interface InvoiceItemRow {
  id: string;
  orderIndex: number;
  treatmentId: string | null;
  treatmentName: string | null;
  planItemId: string | null;
  description: string;
  toothNumber: number | null;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  grossMinor: number;
  netMinor: number;
}

export interface PaymentRow {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  patientId: string;
  amountMinor: number;
  paidAt: string;
  method: string;
  reference: string | null;
  receivedById: string | null;
  receivedByName: string | null;
  notes: string | null;
  voidedAt: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
}

export interface ReceiptRow {
  id: string;
  number: string;
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  receiptDate: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  receivedById: string | null;
  receivedByName: string | null;
  remainingDueMinor: number;
  notes: string | null;
  createdAt: string;
}

export class FinancialService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly options: () => { timeZone: string; allowOverpayment: boolean; paymentMethods: string[] },
  ) {}

  // ── Invoices ────────────────────────────────────────────────────────────────────────────

  createInvoice(actor: AuditActor, input: InvoiceInput, idempotencyKey?: string): InvoiceRow {
    this.assertPatientExists(input.patientId);
    const computed = computeInvoiceTotals({
      lines: input.lines,
      discountMinor: input.discountMinor ?? 0,
      taxPercent: input.taxPercent ?? 0,
    });
    assertInvoiceInvariant(computed.totals, 'Invoice');

    const timeZone = this.options().timeZone;
    const invoiceDateKey = input.invoiceDateKey ?? todayKey(timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDateKey)) {
      throw Errors.validation('Enter a valid invoice date.', { invoiceDateKey: 'Enter a valid date.' });
    }

    const invoiceId = newId('inv');
    this.db.transaction((tx) => {
      if (idempotencyKey) this.assertIdempotencyFree(tx, 'invoices', idempotencyKey);
      const number = this.allocateDocumentNumber(tx, 'invoice', invoiceDateKey, timeZone);
      tx.run(
        `INSERT INTO invoices (id, number, patient_id, dentist_id, visit_id, invoice_date, due_date_key, status,
             subtotal_minor, discount_minor, taxable_minor, tax_percent, tax_minor, total_minor,
             paid_minor, refunded_minor, adjusted_minor, notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        invoiceId,
        number,
        input.patientId,
        input.dentistId ?? null,
        input.visitId ?? null,
        invoiceDateKey,
        input.dueDateKey ?? null,
        'issued',
        computed.totals.subtotalMinor,
        computed.totals.discountMinor,
        computed.totals.taxableMinor,
        computed.totals.taxPercent,
        computed.totals.taxMinor,
        computed.totals.totalMinor,
        input.notes ?? null,
        actor.userId,
      );
      computed.lines.forEach((line, index) => {
        const source = input.lines[index];
        tx.run(
          `INSERT INTO invoice_items (id, invoice_id, order_index, treatment_id, plan_item_id, description,
               tooth_number, quantity, unit_price_minor, discount_minor, gross_minor, net_minor)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          newId('ivi'),
          invoiceId,
          index,
          line.treatmentId ?? null,
          source?.planItemId ?? null,
          line.description,
          source?.toothNumber ?? null,
          line.quantity,
          line.unitPriceMinor,
          line.discountMinor,
          line.grossMinor,
          line.netMinor,
        );
      });
      if (idempotencyKey) this.recordIdempotency(tx, 'invoices', idempotencyKey, invoiceId);
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.INVOICE_CREATED,
        entityType: 'invoice',
        entityId: invoiceId,
        summary: `Created invoice ${number} for ${computed.totals.totalMinor / 100}`,
        metadata: { number, totalMinor: computed.totals.totalMinor, lineCount: computed.lines.length },
      });
    });

    return this.getInvoice(invoiceId);
  }

  updateInvoice(actor: AuditActor, invoiceId: string, input: InvoiceInput): InvoiceRow {
    const existing = this.getInvoice(invoiceId);
    assertInvoiceMutable(existing.status);

    const computed = computeInvoiceTotals({
      lines: input.lines,
      discountMinor: input.discountMinor ?? 0,
      taxPercent: input.taxPercent ?? 0,
    });
    assertInvoiceInvariant(computed.totals, 'Invoice');

    // A paid amount can never be stranded by an edit that lowers the total.
    const projectedOutstanding = computeOutstanding({
      totalMinor: computed.totals.totalMinor,
      paidMinor: existing.paidMinor,
      refundedMinor: existing.refundedMinor,
      adjustmentMinor: existing.adjustedMinor,
    });
    if (projectedOutstanding < 0 && !this.options().allowOverpayment) {
      throw new AppError(
        `This change would make the invoice total less than the ${existing.paidMinor / 100} already paid. Reduce the payment first with a refund, or keep the total at or above the amount paid.`,
        {
          code: 'VALIDATION',
          fieldErrors: { lines: 'Total must not fall below the amount already paid.' },
          details: { paidMinor: existing.paidMinor, projectedTotalMinor: computed.totals.totalMinor },
        },
      );
    }

    this.db.transaction((tx) => {
      tx.run('DELETE FROM invoice_items WHERE invoice_id = ?', invoiceId);
      computed.lines.forEach((line, index) => {
        const source = input.lines[index];
        tx.run(
          `INSERT INTO invoice_items (id, invoice_id, order_index, treatment_id, plan_item_id, description,
               tooth_number, quantity, unit_price_minor, discount_minor, gross_minor, net_minor)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          newId('ivi'),
          invoiceId,
          index,
          line.treatmentId ?? null,
          source?.planItemId ?? null,
          line.description,
          source?.toothNumber ?? null,
          line.quantity,
          line.unitPriceMinor,
          line.discountMinor,
          line.grossMinor,
          line.netMinor,
        );
      });
      const status = deriveInvoiceStatus({
        totalMinor: computed.totals.totalMinor,
        paidMinor: existing.paidMinor,
        refundedMinor: existing.refundedMinor,
        adjustmentMinor: existing.adjustedMinor,
      });
      tx.run(
        `UPDATE invoices SET dentist_id = ?, visit_id = ?, invoice_date = ?, due_date_key = ?, status = ?,
             subtotal_minor = ?, discount_minor = ?, taxable_minor = ?, tax_percent = ?, tax_minor = ?,
             total_minor = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        input.dentistId ?? null,
        input.visitId ?? null,
        input.invoiceDateKey ?? existing.invoiceDate,
        input.dueDateKey ?? existing.dueDateKey,
        status,
        computed.totals.subtotalMinor,
        computed.totals.discountMinor,
        computed.totals.taxableMinor,
        computed.totals.taxPercent,
        computed.totals.taxMinor,
        computed.totals.totalMinor,
        input.notes ?? existing.notes,
        invoiceId,
      );
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.INVOICE_UPDATED,
        entityType: 'invoice',
        entityId: invoiceId,
        summary: `Updated invoice ${existing.number} (total ${computed.totals.totalMinor / 100})`,
        metadata: {
          number: existing.number,
          previousTotalMinor: existing.totalMinor,
          totalMinor: computed.totals.totalMinor,
        },
      });
    });

    return this.getInvoice(invoiceId);
  }

  /**
   * Void an invoice.
   *
   * Voiding is a correction workflow, not a deletion: the row and its items are retained so the
   * financial history stays explainable. An invoice with payments cannot be voided until those
   * payments are refunded, otherwise money would disappear from the records.
   */
  voidInvoice(actor: AuditActor, invoiceId: string, reason: string): InvoiceRow {
    const invoice = this.getInvoice(invoiceId);
    if (invoice.status === 'void') throw Errors.conflict('This invoice is already void.');
    const trimmed = reason.trim();
    if (trimmed === '' || trimmed.length > 500) {
      throw Errors.validation('Enter a reason for voiding this invoice.', { reason: 'Enter a reason.' });
    }
    if (invoice.paidMinor > 0) {
      throw new AppError(
        `This invoice has ${invoice.paidMinor / 100} recorded against it. Refund those payments before voiding, so the money trail stays complete.`,
        { code: 'FINANCIAL_IMMUTABLE', details: { paidMinor: invoice.paidMinor } },
      );
    }
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE invoices SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), void_reason = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        trimmed,
        invoiceId,
      );
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.INVOICE_VOIDED,
        entityType: 'invoice',
        entityId: invoiceId,
        summary: `Voided invoice ${invoice.number}`,
        metadata: { number: invoice.number, reason: trimmed },
      });
    });
    return this.getInvoice(invoiceId);
  }

  getInvoice(invoiceId: string): InvoiceRow {
    const row = this.db.get(
      `SELECT i.id, i.number, i.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              i.dentist_id AS dentistId, d.name AS dentistName, i.visit_id AS visitId,
              i.invoice_date AS invoiceDate, i.due_date_key AS dueDateKey, i.status,
              i.subtotal_minor AS subtotalMinor, i.discount_minor AS discountMinor,
              i.taxable_minor AS taxableMinor, i.tax_percent AS taxPercent, i.tax_minor AS taxMinor,
              i.total_minor AS totalMinor, i.paid_minor AS paidMinor, i.refunded_minor AS refundedMinor,
              i.adjusted_minor AS adjustedMinor, i.notes, i.voided_at AS voidedAt, i.void_reason AS voidReason,
              i.created_at AS createdAt, i.updated_at AS updatedAt
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN dentists d ON d.id = i.dentist_id
        WHERE i.id = ?`,
      invoiceId,
    );
    if (!row) throw Errors.notFound('invoice');
    const invoice = mapInvoice(row);
    invoice.lines = this.db
      .all(
        `SELECT it.id, it.order_index AS orderIndex, it.treatment_id AS treatmentId, t.name AS treatmentName,
                it.plan_item_id AS planItemId, it.description, it.tooth_number AS toothNumber, it.quantity,
                it.unit_price_minor AS unitPriceMinor, it.discount_minor AS discountMinor,
                it.gross_minor AS grossMinor, it.net_minor AS netMinor
           FROM invoice_items it
           LEFT JOIN treatments t ON t.id = it.treatment_id
          WHERE it.invoice_id = ? ORDER BY it.order_index, it.id`,
        invoiceId,
      )
      .map(mapInvoiceItem);
    return invoice;
  }

  getInvoiceByNumber(number: string): InvoiceRow {
    const row = this.db.get('SELECT id FROM invoices WHERE number = ?', number);
    if (!row) throw Errors.notFound('invoice');
    return this.getInvoice(str(row, 'id'));
  }

  listInvoices(params: {
    patientId?: string | null;
    status?: InvoiceStatus | 'all';
    fromKey?: string | null;
    toKey?: string | null;
    search?: string;
    limit: number;
    offset: number;
  }): { rows: InvoiceRow[]; total: number } {
    const { where, args } = this.buildInvoiceWhere(params);
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM invoices i ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT i.id, i.number, i.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              i.dentist_id AS dentistId, d.name AS dentistName, i.visit_id AS visitId,
              i.invoice_date AS invoiceDate, i.due_date_key AS dueDateKey, i.status,
              i.subtotal_minor AS subtotalMinor, i.discount_minor AS discountMinor,
              i.taxable_minor AS taxableMinor, i.tax_percent AS taxPercent, i.tax_minor AS taxMinor,
              i.total_minor AS totalMinor, i.paid_minor AS paidMinor, i.refunded_minor AS refundedMinor,
              i.adjusted_minor AS adjustedMinor, i.notes, i.voided_at AS voidedAt, i.void_reason AS voidReason,
              i.created_at AS createdAt, i.updated_at AS updatedAt
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN dentists d ON d.id = i.dentist_id
         ${where}
        ORDER BY i.invoice_date DESC, i.number DESC
        LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((row) => {
        const invoice = mapInvoice(row);
        invoice.lines = this.invoiceLines(invoice.id);
        return invoice;
      }),
      total: int(totalRow, 'n'),
    };
  }

  invoiceLines(invoiceId: string): InvoiceItemRow[] {
    return this.db
      .all(
        `SELECT it.id, it.order_index AS orderIndex, it.treatment_id AS treatmentId, t.name AS treatmentName,
                it.plan_item_id AS planItemId, it.description, it.tooth_number AS toothNumber, it.quantity,
                it.unit_price_minor AS unitPriceMinor, it.discount_minor AS discountMinor,
                it.gross_minor AS grossMinor, it.net_minor AS netMinor
           FROM invoice_items it LEFT JOIN treatments t ON t.id = it.treatment_id
          WHERE it.invoice_id = ? ORDER BY it.order_index, it.id`,
        invoiceId,
      )
      .map(mapInvoiceItem);
  }

  private buildInvoiceWhere(params: {
    patientId?: string | null;
    status?: InvoiceStatus | 'all';
    fromKey?: string | null;
    toKey?: string | null;
    search?: string;
  }): { where: string; args: unknown[] } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.patientId) {
      clauses.push('i.patient_id = ?');
      args.push(params.patientId);
    }
    if (params.status && params.status !== 'all') {
      clauses.push('i.status = ?');
      args.push(params.status);
    }
    if (params.fromKey) {
      clauses.push('i.invoice_date >= ?');
      args.push(params.fromKey);
    }
    if (params.toKey) {
      clauses.push('i.invoice_date <= ?');
      args.push(params.toKey);
    }
    const search = (params.search ?? '').trim();
    if (search !== '') {
      clauses.push('(i.number LIKE ? OR p.name LIKE ? OR p.patient_code LIKE ?)');
      const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      args.push(like, like, `${search.toUpperCase()}%`);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }

  // ── Payments ────────────────────────────────────────────────────────────────────────────

  recordPayment(
    actor: AuditActor,
    input: {
      invoiceId: string;
      amountMinor: number;
      method: string;
      paidAtIso?: string | null;
      reference?: string | null;
      notes?: string | null;
      issueReceipt?: boolean;
    },
    idempotencyKey: string,
  ): { payment: PaymentRow; receipt: ReceiptRow | null; invoice: InvoiceRow } {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw Errors.validation('A payment could not be recorded because the request was missing its reference token. Try again.', {
        idempotencyKey: 'Retry the payment.',
      });
    }
    const key = idempotencyKey.trim();

    // A retried request with the same key returns the original result. Without this a
    // double-click or an IPC retry would record the payment twice.
    const existing = this.db.get('SELECT id FROM payments WHERE idempotency_key = ?', key);
    if (existing) {
      const payment = this.getPayment(str(existing, 'id'));
      const invoice = this.getInvoice(payment.invoiceId);
      const receiptRow = this.db.get('SELECT id FROM receipts WHERE payment_id = ?', payment.id);
      return {
        payment,
        receipt: receiptRow ? this.getReceipt(str(receiptRow, 'id')) : null,
        invoice,
      };
    }

    const allowedMethods = this.options().paymentMethods;
    const method = (input.method ?? '').trim();
    if (!allowedMethods.includes(method)) {
      throw Errors.validation('Select a valid payment method.', {
        method: `Choose one of: ${allowedMethods.join(', ')}.`,
      });
    }

    const invoice = this.getInvoice(input.invoiceId);
    if (invoice.status === 'void') {
      throw Errors.conflict('This invoice is void, so no payment can be recorded against it.');
    }

    const amount = assertMinorAmount(input.amountMinor, 'payment amount');
    const { outstandingAfter } = validatePayment({
      invoiceTotalMinor: invoice.totalMinor,
      alreadyPaidMinor: invoice.paidMinor,
      alreadyRefundedMinor: invoice.refundedMinor,
      alreadyAdjustedMinor: invoice.adjustedMinor,
      amountMinor: amount,
      allowOverpayment: this.options().allowOverpayment,
    });

    const timeZone = this.options().timeZone;
    const paidAtIso = input.paidAtIso ?? toIso(new Date());
    if (Number.isNaN(Date.parse(paidAtIso))) {
      throw Errors.validation('Enter a valid payment date and time.', { paidAtIso: 'Enter a valid date and time.' });
    }
    const receiptDateKey = todayKeyFromIso(paidAtIso, timeZone);

    const paymentId = newId('pmt');
    let receiptId: string | null = null;

    this.db.transaction((tx) => {
      this.assertIdempotencyFree(tx, 'payments', key);
      tx.run(
        `INSERT INTO payments (id, invoice_id, patient_id, amount_minor, paid_at, method, reference,
             received_by, notes, idempotency_key, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        paymentId,
        invoice.id,
        invoice.patientId,
        amount,
        paidAtIso,
        method,
        textOrNull(input.reference, 120),
        actor.userId,
        textOrNull(input.notes, 500),
        key,
      );
      this.refreshInvoiceBalances(tx, invoice.id);
      const refreshed = this.readInvoiceTotals(tx, invoice.id);
      const status = deriveInvoiceStatus({
        totalMinor: refreshed.totalMinor,
        paidMinor: refreshed.paidMinor,
        refundedMinor: refreshed.refundedMinor,
        adjustmentMinor: refreshed.adjustedMinor,
      });
      tx.run(`UPDATE invoices SET status = ? WHERE id = ?`, status, invoice.id);

      // A receipt is issued only after the payment row is committed within this transaction,
      // and only once per payment (enforced by a UNIQUE constraint on receipts.payment_id).
      if (input.issueReceipt !== false) {
        receiptId = newId('rcp');
        const number = this.allocateDocumentNumber(tx, 'receipt', receiptDateKey, timeZone);
        tx.run(
          `INSERT INTO receipts (id, number, payment_id, invoice_id, patient_id, receipt_date, amount_minor,
               method, reference, received_by, remaining_due_minor, notes, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          receiptId,
          number,
          paymentId,
          invoice.id,
          invoice.patientId,
          receiptDateKey,
          amount,
          method,
          textOrNull(input.reference, 120),
          actor.userId,
          outstandingAfter,
          textOrNull(input.notes, 500),
        );
      }

      this.audit.record(actor, {
        action: AUDIT_ACTIONS.PAYMENT_RECORDED,
        entityType: 'payment',
        entityId: paymentId,
        summary: `Recorded ${amount / 100} against invoice ${invoice.number} (${method})`,
        metadata: { invoiceNumber: invoice.number, amountMinor: amount, method, receiptIssued: receiptId !== null },
      });
    });

    const payment = this.getPayment(paymentId);
    return {
      payment,
      receipt: receiptId ? this.getReceipt(receiptId) : null,
      invoice: this.getInvoice(invoice.id),
    };
  }

  voidPayment(actor: AuditActor, paymentId: string, reason: string): { invoice: InvoiceRow } {
    const payment = this.getPayment(paymentId);
    if (payment.voidedAt !== null) throw Errors.conflict('This payment is already void.');
    const trimmed = reason.trim();
    if (trimmed === '' || trimmed.length > 500) {
      throw Errors.validation('Enter a reason for voiding this payment.', { reason: 'Enter a reason.' });
    }
    if (payment.receiptId !== null) {
      throw new AppError(
        'A receipt has already been issued for this payment. Record a refund instead, so the patient keeps a document that matches the records.',
        { code: 'FINANCIAL_IMMUTABLE', details: { receiptId: payment.receiptId } },
      );
    }
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE payments SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), void_reason = ? WHERE id = ?`,
        trimmed,
        paymentId,
      );
      this.refreshInvoiceBalances(tx, payment.invoiceId);
      const refreshed = this.readInvoiceTotals(tx, payment.invoiceId);
      const status = deriveInvoiceStatus({
        totalMinor: refreshed.totalMinor,
        paidMinor: refreshed.paidMinor,
        refundedMinor: refreshed.refundedMinor,
        adjustmentMinor: refreshed.adjustedMinor,
      });
      tx.run(`UPDATE invoices SET status = ? WHERE id = ?`, status, payment.invoiceId);
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.PAYMENT_VOIDED,
        entityType: 'payment',
        entityId: paymentId,
        summary: `Voided payment of ${payment.amountMinor / 100} on invoice ${payment.invoiceNumber}`,
        metadata: { invoiceNumber: payment.invoiceNumber, amountMinor: payment.amountMinor, reason: trimmed },
      });
    });
    return { invoice: this.getInvoice(payment.invoiceId) };
  }

  getPayment(paymentId: string): PaymentRow {
    const row = this.db.get(
      `SELECT pm.id, pm.invoice_id AS invoiceId, i.number AS invoiceNumber, pm.patient_id AS patientId,
              pm.amount_minor AS amountMinor, pm.paid_at AS paidAt, pm.method, pm.reference,
              pm.received_by AS receivedById, u.display_name AS receivedByName, pm.notes,
              pm.voided_at AS voidedAt, r.id AS receiptId, r.number AS receiptNumber
         FROM payments pm
         JOIN invoices i ON i.id = pm.invoice_id
         LEFT JOIN users u ON u.id = pm.received_by
         LEFT JOIN receipts r ON r.payment_id = pm.id
        WHERE pm.id = ?`,
      paymentId,
    );
    if (!row) throw Errors.notFound('payment');
    return {
      id: str(row, 'id'),
      invoiceId: str(row, 'invoiceId'),
      invoiceNumber: str(row, 'invoiceNumber'),
      patientId: str(row, 'patientId'),
      amountMinor: int(row, 'amountMinor'),
      paidAt: str(row, 'paidAt'),
      method: str(row, 'method'),
      reference: strOrNull(row, 'reference'),
      receivedById: strOrNull(row, 'receivedById'),
      receivedByName: strOrNull(row, 'receivedByName'),
      notes: strOrNull(row, 'notes'),
      voidedAt: strOrNull(row, 'voidedAt'),
      receiptId: strOrNull(row, 'receiptId'),
      receiptNumber: strOrNull(row, 'receiptNumber'),
    };
  }

  listPayments(params: {
    patientId?: string | null;
    invoiceId?: string | null;
    fromKey?: string | null;
    toKey?: string | null;
    includeVoided?: boolean;
    limit: number;
    offset: number;
  }): { rows: PaymentRow[]; total: number } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.patientId) {
      clauses.push('pm.patient_id = ?');
      args.push(params.patientId);
    }
    if (params.invoiceId) {
      clauses.push('pm.invoice_id = ?');
      args.push(params.invoiceId);
    }
    if (params.fromKey) {
      clauses.push("substr(pm.paid_at,1,10) >= ?");
      args.push(params.fromKey);
    }
    if (params.toKey) {
      clauses.push("substr(pm.paid_at,1,10) <= ?");
      args.push(params.toKey);
    }
    if (!params.includeVoided) clauses.push('pm.voided_at IS NULL');
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM payments pm ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT pm.id, pm.invoice_id AS invoiceId, i.number AS invoiceNumber, pm.patient_id AS patientId,
              pm.amount_minor AS amountMinor, pm.paid_at AS paidAt, pm.method, pm.reference,
              pm.received_by AS receivedById, u.display_name AS receivedByName, pm.notes,
              pm.voided_at AS voidedAt, r.id AS receiptId, r.number AS receiptNumber
         FROM payments pm
         JOIN invoices i ON i.id = pm.invoice_id
         LEFT JOIN users u ON u.id = pm.received_by
         LEFT JOIN receipts r ON r.payment_id = pm.id
         ${where}
        ORDER BY pm.paid_at DESC, pm.id DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((row) => ({
        id: str(row, 'id'),
        invoiceId: str(row, 'invoiceId'),
        invoiceNumber: str(row, 'invoiceNumber'),
        patientId: str(row, 'patientId'),
        amountMinor: int(row, 'amountMinor'),
        paidAt: str(row, 'paidAt'),
        method: str(row, 'method'),
        reference: strOrNull(row, 'reference'),
        receivedById: strOrNull(row, 'receivedById'),
        receivedByName: strOrNull(row, 'receivedByName'),
        notes: strOrNull(row, 'notes'),
        voidedAt: strOrNull(row, 'voidedAt'),
        receiptId: strOrNull(row, 'receiptId'),
        receiptNumber: strOrNull(row, 'receiptNumber'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  // ── Refunds and adjustments ─────────────────────────────────────────────────────────────

  recordRefund(
    actor: AuditActor,
    input: { invoiceId: string; paymentId?: string | null; amountMinor: number; reason: RefundReason; reference?: string | null; notes?: string | null },
    idempotencyKey: string,
  ): { invoice: InvoiceRow } {
    if (!(REFUND_REASONS as readonly string[]).includes(input.reason)) {
      throw Errors.validation('Select a valid refund reason.', { reason: 'Select a reason.' });
    }
    const invoice = this.getInvoice(input.invoiceId);
    const amount = assertMinorAmount(input.amountMinor, 'refund amount');
    validateRefund({
      invoiceTotalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      refundedMinor: invoice.refundedMinor,
      amountMinor: amount,
    });
    const refundId = newId('rfd');
    this.db.transaction((tx) => {
      this.assertIdempotencyFree(tx, 'refunds', idempotencyKey);
      tx.run(
        `INSERT INTO refunds (id, invoice_id, payment_id, patient_id, amount_minor, reason, refunded_at,
             reference, notes, created_by, created_at, idempotency_key)
         VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,?,?,?)`,
        refundId,
        invoice.id,
        input.paymentId ?? null,
        invoice.patientId,
        amount,
        input.reason,
        textOrNull(input.reference, 120),
        textOrNull(input.notes, 500),
        actor.userId,
        idempotencyKey,
      );
      this.refreshInvoiceBalances(tx, invoice.id);
      this.refreshInvoiceStatus(tx, invoice.id);
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.REFUND_RECORDED,
        entityType: 'refund',
        entityId: refundId,
        summary: `Refunded ${amount / 100} on invoice ${invoice.number} (${input.reason.replace(/_/g, ' ')})`,
        metadata: { invoiceNumber: invoice.number, amountMinor: amount, reason: input.reason },
      });
    });
    return { invoice: this.getInvoice(invoice.id) };
  }

  recordAdjustment(
    actor: AuditActor,
    input: { invoiceId: string; kind: AdjustmentKind; amountMinor: number; reason?: string | null; note?: string | null },
    idempotencyKey: string,
  ): { invoice: InvoiceRow } {
    if (!(ADJUSTMENT_KINDS as readonly string[]).includes(input.kind)) {
      throw Errors.validation('Select a valid adjustment type.', { kind: 'Select an adjustment type.' });
    }
    const invoice = this.getInvoice(input.invoiceId);
    assertInvoiceMutable(invoice.status);
    const amount = assertMinorAmount(input.amountMinor, 'adjustment amount');
    const delta = adjustmentDelta(input.kind, amount);
    adjustDeltaGuard(delta);

    const projected = computeOutstanding({
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      refundedMinor: invoice.refundedMinor,
      adjustmentMinor: invoice.adjustedMinor + delta,
    });
    if (projected < 0 && !this.options().allowOverpayment) {
      throw new AppError(
        'This adjustment would put the invoice into credit. Reduce the amount, or enable overpayments in settings.',
        { code: 'OVERPAYMENT_NOT_ALLOWED', details: { projectedOutstandingMinor: projected } },
      );
    }

    const adjustmentId = newId('adj');
    this.db.transaction((tx) => {
      this.assertIdempotencyFree(tx, 'adjustments', idempotencyKey);
      tx.run(
        `INSERT INTO adjustments (id, invoice_id, patient_id, kind, amount_minor, delta_minor, reason, note,
             created_by, created_at, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)`,
        adjustmentId,
        invoice.id,
        invoice.patientId,
        input.kind,
        amount,
        delta,
        textOrNull(input.reason, 200),
        textOrNull(input.note, 500),
        actor.userId,
        idempotencyKey,
      );
      this.refreshInvoiceBalances(tx, invoice.id);
      this.refreshInvoiceStatus(tx, invoice.id);
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.ADJUSTMENT_RECORDED,
        entityType: 'adjustment',
        entityId: adjustmentId,
        summary: `Recorded ${input.kind.replace(/_/g, ' ')} of ${amount / 100} on invoice ${invoice.number}`,
        metadata: { invoiceNumber: invoice.number, kind: input.kind, amountMinor: amount, deltaMinor: delta },
      });
    });
    return { invoice: this.getInvoice(invoice.id) };
  }

  // ── Receipts ────────────────────────────────────────────────────────────────────────────

  getReceipt(receiptId: string): ReceiptRow {
    const row = this.db.get(
      `SELECT r.id, r.number, r.payment_id AS paymentId, r.invoice_id AS invoiceId, i.number AS invoiceNumber,
              r.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              r.receipt_date AS receiptDate, r.amount_minor AS amountMinor, r.method, r.reference,
              r.received_by AS receivedById, u.display_name AS receivedByName,
              r.remaining_due_minor AS remainingDueMinor, r.notes, r.created_at AS createdAt
         FROM receipts r
         JOIN invoices i ON i.id = r.invoice_id
         JOIN patients p ON p.id = r.patient_id
         LEFT JOIN users u ON u.id = r.received_by
        WHERE r.id = ?`,
      receiptId,
    );
    if (!row) throw Errors.notFound('receipt');
    return {
      id: str(row, 'id'),
      number: str(row, 'number'),
      paymentId: str(row, 'paymentId'),
      invoiceId: str(row, 'invoiceId'),
      invoiceNumber: str(row, 'invoiceNumber'),
      patientId: str(row, 'patientId'),
      patientCode: str(row, 'patientCode'),
      patientName: str(row, 'patientName'),
      receiptDate: str(row, 'receiptDate'),
      amountMinor: int(row, 'amountMinor'),
      method: str(row, 'method'),
      reference: strOrNull(row, 'reference'),
      receivedById: strOrNull(row, 'receivedById'),
      receivedByName: strOrNull(row, 'receivedByName'),
      remainingDueMinor: int(row, 'remainingDueMinor'),
      notes: strOrNull(row, 'notes'),
      createdAt: str(row, 'createdAt'),
    };
  }

  listReceipts(params: { patientId?: string | null; limit: number; offset: number }): { rows: ReceiptRow[]; total: number } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.patientId) {
      clauses.push('r.patient_id = ?');
      args.push(params.patientId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM receipts r ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT r.id, r.number, r.payment_id AS paymentId, r.invoice_id AS invoiceId, i.number AS invoiceNumber,
              r.patient_id AS patientId, p.patient_code AS patientCode, p.name AS patientName,
              r.receipt_date AS receiptDate, r.amount_minor AS amountMinor, r.method, r.reference,
              r.received_by AS receivedById, u.display_name AS receivedByName,
              r.remaining_due_minor AS remainingDueMinor, r.notes, r.created_at AS createdAt
         FROM receipts r JOIN invoices i ON i.id = r.invoice_id
         JOIN patients p ON p.id = r.patient_id LEFT JOIN users u ON u.id = r.received_by
         ${where} ORDER BY r.receipt_date DESC, r.number DESC LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return {
      rows: rows.map((row) => ({
        id: str(row, 'id'),
        number: str(row, 'number'),
        paymentId: str(row, 'paymentId'),
        invoiceId: str(row, 'invoiceId'),
        invoiceNumber: str(row, 'invoiceNumber'),
        patientId: str(row, 'patientId'),
        patientCode: str(row, 'patientCode'),
        patientName: str(row, 'patientName'),
        receiptDate: str(row, 'receiptDate'),
        amountMinor: int(row, 'amountMinor'),
        method: str(row, 'method'),
        reference: strOrNull(row, 'reference'),
        receivedById: strOrNull(row, 'receivedById'),
        receivedByName: strOrNull(row, 'receivedByName'),
        remainingDueMinor: int(row, 'remainingDueMinor'),
        notes: strOrNull(row, 'notes'),
        createdAt: str(row, 'createdAt'),
      })),
      total: int(totalRow, 'n'),
    };
  }

  // ── Statements ──────────────────────────────────────────────────────────────────────────

  /**
   * Build a patient statement from persisted financial records.
   *
   * The closing balance is computed by summing every invoice, payment, refund and adjustment in
   * deterministic order, and is then cross-checked against the outstanding balances stored on the
   * invoices. A mismatch throws rather than printing a statement that disagrees with the ledger.
   */
  buildStatement(params: {
    patientId: string;
    /** Opening balance carried forward from before `fromKey`. */
    openingMinor?: number;
    fromKey?: string | null;
    toKey?: string | null;
  }): Statement {
    const patientRow = this.db.get('SELECT id, patient_code AS patientCode, name FROM patients WHERE id = ?', params.patientId);
    if (!patientRow) throw Errors.notFound('patient');

    const fromKey = params.fromKey ?? null;
    const toKey = params.toKey ?? null;

    const entries: StatementEntryInput[] = [];

    const invoices = this.db.all(
      `SELECT i.id, i.number, i.invoice_date AS invoiceDate, i.total_minor AS totalMinor, i.status
         FROM invoices i WHERE i.patient_id = ? AND i.status <> 'void'
           AND (? IS NULL OR i.invoice_date >= ?) AND (? IS NULL OR i.invoice_date <= ?)
        ORDER BY i.invoice_date, i.number`,
      params.patientId,
      fromKey,
      fromKey,
      toKey,
      toKey,
    );
    for (const inv of invoices) {
      entries.push({
        occurredAt: `${str(inv, 'invoiceDate')}T00:00:00.000Z`,
        kind: 'invoice',
        deltaMinor: int(inv, 'totalMinor'),
        sequence: 0,
        reference: str(inv, 'number'),
      });
    }

    const payments = this.db.all(
      `SELECT pm.id, pm.paid_at AS paidAt, pm.amount_minor AS amountMinor, i.number AS invoiceNumber
         FROM payments pm JOIN invoices i ON i.id = pm.invoice_id
        WHERE pm.patient_id = ? AND pm.voided_at IS NULL
          AND (? IS NULL OR substr(pm.paid_at,1,10) >= ?) AND (? IS NULL OR substr(pm.paid_at,1,10) <= ?)
        ORDER BY pm.paid_at, pm.id`,
      params.patientId,
      fromKey,
      fromKey,
      toKey,
      toKey,
    );
    for (const pm of payments) {
      entries.push({
        occurredAt: str(pm, 'paidAt'),
        kind: 'payment',
        deltaMinor: -int(pm, 'amountMinor'),
        sequence: 1,
        reference: str(pm, 'invoiceNumber'),
      });
    }

    const refunds = this.db.all(
      `SELECT rf.id, rf.refunded_at AS refundedAt, rf.amount_minor AS amountMinor, i.number AS invoiceNumber
         FROM refunds rf JOIN invoices i ON i.id = rf.invoice_id
        WHERE rf.patient_id = ?
          AND (? IS NULL OR substr(rf.refunded_at,1,10) >= ?) AND (? IS NULL OR substr(rf.refunded_at,1,10) <= ?)
        ORDER BY rf.refunded_at, rf.id`,
      params.patientId,
      fromKey,
      fromKey,
      toKey,
      toKey,
    );
    for (const rf of refunds) {
      entries.push({
        occurredAt: str(rf, 'refundedAt'),
        kind: 'refund',
        deltaMinor: int(rf, 'amountMinor'),
        sequence: 2,
        reference: str(rf, 'invoiceNumber'),
      });
    }

    const adjustments = this.db.all(
      `SELECT ad.id, ad.created_at AS createdAt, ad.delta_minor AS deltaMinor, ad.kind, i.number AS invoiceNumber
         FROM adjustments ad JOIN invoices i ON i.id = ad.invoice_id
        WHERE ad.patient_id = ?
          AND (? IS NULL OR substr(ad.created_at,1,10) >= ?) AND (? IS NULL OR substr(ad.created_at,1,10) <= ?)
        ORDER BY ad.created_at, ad.id`,
      params.patientId,
      fromKey,
      fromKey,
      toKey,
      toKey,
    );
    for (const ad of adjustments) {
      entries.push({
        occurredAt: str(ad, 'createdAt'),
        kind: 'adjustment',
        deltaMinor: int(ad, 'deltaMinor'),
        sequence: 3,
        reference: `${str(ad, 'invoiceNumber')} (${String(ad.kind).replace(/_/g, ' ')})`,
      });
    }

    let openingMinor = params.openingMinor ?? 0;
    if (params.openingMinor === undefined && fromKey !== null) {
      // Derive the opening balance from everything before the window so the statement is
      // self-consistent without the caller having to supply it.
      openingMinor = this.outstandingBefore(params.patientId, fromKey);
    }

    const computation = computeStatement(openingMinor, entries);

    // Reconciliation. When the window is open-ended (no `toKey`) the statement runs up to the
    // present, so opening balance + window activity must equal the outstanding balance across the
    // WHOLE ledger — not just the invoices inside the window. Comparing against the window alone
    // would double-count the opening balance, which is exactly the error this check exists to
    // catch, so the comparison is deliberately made against the full ledger.
    if (toKey === null) {
      const expected = this.currentOutstanding(params.patientId, null);
      if (expected !== null && expected !== computation.closingMinor) {
        throw Errors.integrity(
          `The statement does not reconcile with the invoice ledger (statement closing ${computation.closingMinor}, ledger ${expected}). Do not issue this statement until the discrepancy is resolved.`,
          { statementClosingMinor: computation.closingMinor, ledgerMinor: expected },
        );
      }
    }

    return {
      patientId: str(patientRow, 'id'),
      patientCode: str(patientRow, 'patientCode'),
      patientName: str(patientRow, 'name'),
      fromKey,
      toKey,
      openingMinor: computation.openingMinor,
      rows: computation.rows.map((row) => ({
        occurredAt: row.entry.occurredAt,
        kind: row.entry.kind,
        reference: row.entry.reference,
        deltaMinor: row.entry.deltaMinor,
        runningBalanceMinor: row.runningBalanceMinor,
      })),
      closingMinor: computation.closingMinor,
      totalInvoicedMinor: computation.totalInvoicedMinor,
      totalPaidMinor: computation.totalPaidMinor,
      totalRefundedMinor: computation.totalRefundedMinor,
      totalAdjustedMinor: computation.totalAdjustedMinor,
    };
  }

  /** Outstanding balance across all non-void invoices for a patient (optionally from a date). */
  currentOutstanding(patientId: string, fromKey: string | null): number | null {
    const row = this.db.get(
      `SELECT COALESCE(SUM(total_minor - paid_minor + refunded_minor + adjusted_minor), 0) AS outstanding
         FROM invoices WHERE patient_id = ? AND status <> 'void' AND (? IS NULL OR invoice_date >= ?)`,
      patientId,
      fromKey,
      fromKey,
    );
    return row === undefined ? null : int(row, 'outstanding');
  }

  /** Net movement before a date key: invoices minus payments, refunds and adjustments. */
  outstandingBefore(patientId: string, beforeKey: string): number {
    const row = this.db.get(
      `SELECT
         (SELECT COALESCE(SUM(total_minor),0) FROM invoices
           WHERE patient_id = ? AND status <> 'void' AND invoice_date < ?)
       - (SELECT COALESCE(SUM(amount_minor),0) FROM payments
           WHERE patient_id = ? AND voided_at IS NULL AND substr(paid_at,1,10) < ?)
       + (SELECT COALESCE(SUM(amount_minor),0) FROM refunds
           WHERE patient_id = ? AND substr(refunded_at,1,10) < ?)
       + (SELECT COALESCE(SUM(delta_minor),0) FROM adjustments
           WHERE patient_id = ? AND substr(created_at,1,10) < ?) AS balance`,
      patientId,
      beforeKey,
      patientId,
      beforeKey,
      patientId,
      beforeKey,
      patientId,
      beforeKey,
    );
    return int(row, 'balance');
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────

  /**
   * Recompute an invoice's paid/refunded/adjusted columns from its child rows.
   *
   * Derived values are always recalculated from the source records rather than incremented, so a
   * missed or duplicated update cannot leave the header out of step with the detail.
   */
  private refreshInvoiceBalances(tx: Transaction, invoiceId: string): void {
    tx.run(
      `UPDATE invoices SET
         paid_minor     = (SELECT COALESCE(SUM(amount_minor),0) FROM payments  WHERE invoice_id = ?1 AND voided_at IS NULL),
         refunded_minor = (SELECT COALESCE(SUM(amount_minor),0) FROM refunds   WHERE invoice_id = ?1),
         adjusted_minor = (SELECT COALESCE(SUM(delta_minor),0)  FROM adjustments WHERE invoice_id = ?1),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1`,
      invoiceId,
    );
  }

  private refreshInvoiceStatus(tx: Transaction, invoiceId: string): void {
    const totals = this.readInvoiceTotals(tx, invoiceId);
    const status = deriveInvoiceStatus({
      totalMinor: totals.totalMinor,
      paidMinor: totals.paidMinor,
      refundedMinor: totals.refundedMinor,
      adjustmentMinor: totals.adjustedMinor,
    });
    tx.run('UPDATE invoices SET status = ? WHERE id = ?', status, invoiceId);
  }

  private readInvoiceTotals(tx: Transaction, invoiceId: string): {
    totalMinor: number;
    paidMinor: number;
    refundedMinor: number;
    adjustedMinor: number;
    voided: boolean;
  } {
    const row = tx.get(
      'SELECT total_minor AS totalMinor, paid_minor AS paidMinor, refunded_minor AS refundedMinor, adjusted_minor AS adjustedMinor, voided_at AS voidedAt FROM invoices WHERE id = ?',
      invoiceId,
    );
    if (!row) throw Errors.notFound('invoice');
    return {
      totalMinor: int(row, 'totalMinor'),
      paidMinor: int(row, 'paidMinor'),
      refundedMinor: int(row, 'refundedMinor'),
      adjustedMinor: int(row, 'adjustedMinor'),
      voided: row.voidedAt !== null && row.voidedAt !== undefined,
    };
  }

  /**
   * Allocate a document number.
   *
   * Numbers are per document type and fiscal year, allocated atomically. The UNIQUE constraint on
   * the number column is the final backstop: if two allocations ever produced the same number the
   * insert would fail loudly rather than printing two documents with one number.
   */
  private allocateDocumentNumber(tx: Transaction, kind: 'invoice' | 'receipt', dateKey: string, timeZone: string): string {
    const fiscalYear = partsInTimeZone(`${dateKey}T12:00:00.000Z`, timeZone).year;
    const sequenceName = `${DOCUMENT_PREFIX[kind].toLowerCase()}_${fiscalYear}`;
    tx.run(
      `INSERT INTO sequences (name, next_value, updated_at) VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(name) DO NOTHING`,
      sequenceName,
    );
    const row = tx.get(
      `UPDATE sequences SET next_value = next_value + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE name = ? RETURNING next_value - 1 AS allocated`,
      sequenceName,
    );
    if (!row) throw Errors.internal('Could not allocate a document number.');
    return formatDocumentNumber(kind, fiscalYear, int(row, 'allocated'));
  }

  private assertIdempotencyFree(tx: Transaction, table: 'payments' | 'refunds' | 'adjustments' | 'invoices', key: string): void {
    if (table === 'invoices') return; // invoices have no idempotency column; creation is user-confirmed
    const existing = tx.get(`SELECT id FROM ${table} WHERE idempotency_key = ?`, key);
    if (existing) {
      throw Errors.conflict('This transaction has already been recorded. No duplicate entry was created.');
    }
  }

  private recordIdempotency(tx: Transaction, _table: string, _key: string, _id: string): void {
    void tx;
  }

  private assertPatientExists(patientId: string): void {
    const row = this.db.get('SELECT 1 AS ok FROM patients WHERE id = ?', patientId);
    if (!row) throw Errors.notFound('patient');
  }
}

export interface Statement {
  patientId: string;
  patientCode: string;
  patientName: string;
  fromKey: string | null;
  toKey: string | null;
  openingMinor: number;
  rows: { occurredAt: string; kind: StatementEntryInput['kind']; reference: string; deltaMinor: number; runningBalanceMinor: number }[];
  closingMinor: number;
  totalInvoicedMinor: number;
  totalPaidMinor: number;
  totalRefundedMinor: number;
  totalAdjustedMinor: number;
}

function mapInvoice(row: Record<string, unknown>): InvoiceRow {
  const totals = {
    subtotalMinor: int(row, 'subtotalMinor'),
    discountMinor: int(row, 'discountMinor'),
    taxableMinor: int(row, 'taxableMinor'),
    taxMinor: int(row, 'taxMinor'),
    totalMinor: int(row, 'totalMinor'),
    taxPercent: num(row, 'taxPercent'),
  };
  assertInvoiceInvariant(totals, 'Stored invoice');
  const paidMinor = int(row, 'paidMinor');
  const refundedMinor = int(row, 'refundedMinor');
  const adjustedMinor = int(row, 'adjustedMinor');
  const status = String(row.status) as InvoiceStatus;
  return {
    id: str(row, 'id'),
    number: str(row, 'number'),
    patientId: str(row, 'patientId'),
    patientCode: str(row, 'patientCode'),
    patientName: str(row, 'patientName'),
    dentistId: strOrNull(row, 'dentistId'),
    dentistName: strOrNull(row, 'dentistName'),
    visitId: strOrNull(row, 'visitId'),
    invoiceDate: str(row, 'invoiceDate'),
    dueDateKey: strOrNull(row, 'dueDateKey'),
    status,
    ...totals,
    paidMinor,
    refundedMinor,
    adjustedMinor,
    outstandingMinor: computeOutstanding({
      totalMinor: totals.totalMinor,
      paidMinor,
      refundedMinor,
      adjustmentMinor: adjustedMinor,
    }),
    notes: strOrNull(row, 'notes'),
    voidedAt: strOrNull(row, 'voidedAt'),
    voidReason: strOrNull(row, 'voidReason'),
    createdAt: str(row, 'createdAt'),
    updatedAt: str(row, 'updatedAt'),
    lines: [],
  };
}

function mapInvoiceItem(row: Record<string, unknown>): InvoiceItemRow {
  return {
    id: str(row, 'id'),
    orderIndex: int(row, 'orderIndex'),
    treatmentId: strOrNull(row, 'treatmentId'),
    treatmentName: strOrNull(row, 'treatmentName'),
    planItemId: strOrNull(row, 'planItemId'),
    description: str(row, 'description'),
    toothNumber: row.toothNumber === null || row.toothNumber === undefined ? null : int(row, 'toothNumber'),
    quantity: int(row, 'quantity'),
    unitPriceMinor: int(row, 'unitPriceMinor'),
    discountMinor: int(row, 'discountMinor'),
    grossMinor: int(row, 'grossMinor'),
    netMinor: int(row, 'netMinor'),
  };
}

function textOrNull(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, maxLength);
}

function todayKeyFromIso(iso: string, timeZone: string): string {
  const parts = partsInTimeZone(iso, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
