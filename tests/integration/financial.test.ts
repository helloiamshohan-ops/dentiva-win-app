import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createPatient, type Harness } from '../support/harness';
import { computeInvoiceTotals, computeOutstanding, computeStatement, deriveInvoiceStatus } from '../../src/domain/financial';
import { applyPercent, toMinorUnits, toDecimalString, formatMoney } from '../../src/shared/money';
import { AppError } from '../../src/shared/errors';

/**
 * Financial verification matrix.
 *
 * Covers the cases required by the specification: zero, decimal, large values, discounts, tax,
 * partial payment, multiple payments, refunds, adjustments, overpayment, underpayment,
 * cancellation (void) and correction. Every case reconciles invoice totals against payments.
 */

let h: Harness;
let patientId: string;

beforeEach(() => {
  h = createHarness();
  patientId = createPatient(h, { name: 'Ayesha Rahman' }).patient.id;
});

afterEach(() => h.close());

const line = (priceMinor: number, quantity = 1, discountMinor = 0) => ({
  description: 'Composite filling',
  quantity,
  unitPriceMinor: priceMinor,
  discountMinor,
});

describe('monetary arithmetic', () => {
  it('parses decimal strings exactly, with no floating point drift', () => {
    expect(toMinorUnits('0.1')).toBe(10);
    expect(toMinorUnits('0.2')).toBe(20);
    // 0.1 + 0.2 === 0.30000000000000004 in floating point; integer minor units are exact.
    expect(toMinorUnits('0.1') + toMinorUnits('0.2')).toBe(30);
    expect(toMinorUnits('1234567.89')).toBe(123_456_789);
    expect(toDecimalString(123_456_789)).toBe('1234567.89');
  });

  it('rounds sub-poisha remainders half-up', () => {
    expect(toMinorUnits('12.345')).toBe(1235);
    expect(toMinorUnits('12.344')).toBe(1234);
  });

  it('applies percentages with a single half-up rounding step', () => {
    expect(applyPercent(10_000, 5)).toBe(500);
    expect(applyPercent(9_999, 7.5)).toBe(750);
    expect(applyPercent(1, 50)).toBe(1); // 0.5 rounds half-up
    expect(applyPercent(0, 100)).toBe(0);
  });

  it('formats with the BDT symbol and thousands grouping', () => {
    expect(formatMoney(1_234_567_89, { symbol: '৳' })).toBe('৳ 1,234,567.89');
    expect(formatMoney(-5000, { symbol: '৳' })).toBe('৳ -50.00'.replace('৳ -', '-৳ '));
  });

  it('rejects non-finite amounts rather than storing NaN', () => {
    expect(() => toMinorUnits(Number.NaN)).toThrow();
    expect(() => applyPercent(Number.POSITIVE_INFINITY, 5)).toThrow();
  });
});

describe('invoice totals', () => {
  it('handles a zero-value invoice', () => {
    const computed = computeInvoiceTotals({ lines: [line(0)] });
    expect(computed.totals.subtotalMinor).toBe(0);
    expect(computed.totals.totalMinor).toBe(0);
  });

  it('handles decimal unit prices', () => {
    const computed = computeInvoiceTotals({ lines: [line(toMinorUnits('250.75'), 3)] });
    expect(computed.totals.subtotalMinor).toBe(75_225);
    expect(toDecimalString(computed.totals.totalMinor)).toBe('752.25');
  });

  it('handles large values without overflow', () => {
    const computed = computeInvoiceTotals({ lines: [line(toMinorUnits('9999999.99'), 1000)] });
    expect(computed.totals.totalMinor).toBe(9_999_999_990_00);
    expect(Number.isSafeInteger(computed.totals.totalMinor)).toBe(true);
  });

  it('handles multiple line items', () => {
    const computed = computeInvoiceTotals({
      lines: [line(10_000, 2), line(25_000, 1, 5_000), line(1_500, 4)],
    });
    // 20000 + (25000-5000) + 6000 = 46000
    expect(computed.totals.subtotalMinor).toBe(46_000);
    expect(computed.totals.lineCount).toBe(3);
  });

  it('applies an overall discount and tax in the documented order', () => {
    const computed = computeInvoiceTotals({ lines: [line(100_000)], discountMinor: 10_000, taxPercent: 5 });
    expect(computed.totals.subtotalMinor).toBe(100_000);
    expect(computed.totals.discountMinor).toBe(10_000);
    expect(computed.totals.taxableMinor).toBe(90_000);
    expect(computed.totals.taxMinor).toBe(4_500);
    expect(computed.totals.totalMinor).toBe(94_500);
    // Invariant I1
    expect(computed.totals.subtotalMinor - computed.totals.discountMinor + computed.totals.taxMinor).toBe(
      computed.totals.totalMinor,
    );
  });

  it('rejects a discount larger than the subtotal', () => {
    expect(() => computeInvoiceTotals({ lines: [line(10_000)], discountMinor: 20_000 })).toThrow(/greater than the subtotal/);
  });

  it('rejects a line discount larger than the line total', () => {
    expect(() => computeInvoiceTotals({ lines: [line(10_000, 1, 10_001)] })).toThrow();
  });

  it('rejects zero or negative quantity and negative unit price', () => {
    expect(() => computeInvoiceTotals({ lines: [line(10_000, 0)] })).toThrow();
    expect(() => computeInvoiceTotals({ lines: [line(10_000, -1)] })).toThrow();
    expect(() => computeInvoiceTotals({ lines: [line(-1)] })).toThrow();
  });

  it('rejects an empty invoice', () => {
    expect(() => computeInvoiceTotals({ lines: [] })).toThrow(/at least one line item/);
  });

  it('rejects tax outside 0-100', () => {
    expect(() => computeInvoiceTotals({ lines: [line(1000)], taxPercent: -1 })).toThrow();
    expect(() => computeInvoiceTotals({ lines: [line(1000)], taxPercent: 101 })).toThrow();
  });
});

describe('invoice lifecycle and payments', () => {
  it('creates an invoice and reports it as issued with the full balance outstanding', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    expect(invoice.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(invoice.status).toBe('issued');
    expect(invoice.totalMinor).toBe(50_000);
    expect(invoice.paidMinor).toBe(0);
    expect(invoice.outstandingMinor).toBe(50_000);
    expect(invoice.lines).toHaveLength(1);
  });

  it('records a partial payment and moves the invoice to partially_paid', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    const { payment, receipt, invoice: updated } = h.financial.recordPayment(
      h.admin,
      { invoiceId: invoice.id, amountMinor: 20_000, method: 'Cash' },
      'key-partial-1',
    );
    expect(payment.amountMinor).toBe(20_000);
    expect(updated.status).toBe('partially_paid');
    expect(updated.paidMinor).toBe(20_000);
    expect(updated.outstandingMinor).toBe(30_000);
    expect(receipt).not.toBeNull();
    expect(receipt?.remainingDueMinor).toBe(30_000);
    expect(receipt?.number).toMatch(/^RCP-\d{4}-\d{6}$/);
  });

  it('settles the invoice on full payment', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 20_000, method: 'Cash' }, 'k1');
    const { invoice: settled } = h.financial.recordPayment(
      h.admin,
      { invoiceId: invoice.id, amountMinor: 30_000, method: 'bKash' },
      'k2',
    );
    expect(settled.status).toBe('paid');
    expect(settled.paidMinor).toBe(50_000);
    expect(settled.outstandingMinor).toBe(0);
  });

  it('rejects an overpayment by default and reports the exact amounts', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    let caught: AppError | null = null;
    try {
      h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 60_000, method: 'Cash' }, 'k-over');
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('OVERPAYMENT_NOT_ALLOWED');
    expect(caught?.details).toMatchObject({ amountMinor: 60_000, outstandingBeforeMinor: 50_000, overByMinor: 10_000 });
    // No payment was written.
    const count = h.db.get('SELECT COUNT(*) AS n FROM payments') as { n: number };
    expect(count.n).toBe(0);
  });

  it('permits an overpayment when the clinic allows it, producing a credit balance', () => {
    const permissive = createHarness({ allowOverpayment: true });
    try {
      const pid = createPatient(permissive).patient.id;
      const invoice = permissive.financial.createInvoice(permissive.admin, { patientId: pid, lines: [line(50_000)] });
      const { invoice: updated } = permissive.financial.recordPayment(
        permissive.admin,
        { invoiceId: invoice.id, amountMinor: 60_000, method: 'Cash' },
        'k-over-ok',
      );
      expect(updated.status).toBe('paid');
      expect(updated.outstandingMinor).toBe(-10_000);
    } finally {
      permissive.close();
    }
  });

  it('prevents duplicate payment from a double click using the idempotency key', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    const key = 'double-click-key';
    const first = h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 25_000, method: 'Cash' }, key);
    const second = h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 25_000, method: 'Cash' }, key);
    expect(second.payment.id).toBe(first.payment.id);
    const count = h.db.get('SELECT COUNT(*) AS n FROM payments') as { n: number };
    expect(count.n).toBe(1);
    const receipts = h.db.get('SELECT COUNT(*) AS n FROM receipts') as { n: number };
    expect(receipts.n).toBe(1);
    expect(second.invoice.paidMinor).toBe(25_000);
  });

  it('rejects a zero or negative payment amount', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    expect(() => h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 0, method: 'Cash' }, 'kz')).toThrow();
    expect(() => h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: -100, method: 'Cash' }, 'kn')).toThrow();
  });

  it('rejects an unconfigured payment method', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    expect(() =>
      h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 1000, method: 'Crypto' }, 'km'),
    ).toThrow(/valid payment method/);
  });

  it('issues exactly one receipt per payment and never a receipt without a payment', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 10_000, method: 'Cash' }, 'r1');
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 10_000, method: 'Card' }, 'r2');
    const payments = h.db.get('SELECT COUNT(*) AS n FROM payments') as { n: number };
    const receipts = h.db.get('SELECT COUNT(*) AS n FROM receipts') as { n: number };
    expect(payments.n).toBe(2);
    expect(receipts.n).toBe(2);
    // The UNIQUE(payment_id) constraint makes a second receipt for one payment impossible.
    expect(() =>
      h.db.run(
        `INSERT INTO receipts (id, number, payment_id, invoice_id, patient_id, receipt_date, amount_minor,
             method, received_by, remaining_due_minor, created_at)
         SELECT 'rcp_dup', 'RCP-2026-999999', payment_id, invoice_id, patient_id, '2026-01-01', 1, 'Cash', NULL, 0,
                strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM payments LIMIT 1`,
      ),
    ).toThrow();
  });

  it('refunds part of a payment and increases the outstanding balance', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 50_000, method: 'Cash' }, 'p-full');
    const { invoice: refunded } = h.financial.recordRefund(
      h.admin,
      { invoiceId: invoice.id, amountMinor: 15_000, reason: 'billing_error' },
      'rf1',
    );
    expect(refunded.refundedMinor).toBe(15_000);
    expect(refunded.outstandingMinor).toBe(15_000);
    expect(refunded.status).toBe('partially_paid');
  });

  it('refuses a refund larger than what is still refundable', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 20_000, method: 'Cash' }, 'p-part');
    let caught: AppError | null = null;
    try {
      h.financial.recordRefund(h.admin, { invoiceId: invoice.id, amountMinor: 30_000, reason: 'billing_error' }, 'rf2');
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.details).toMatchObject({ paidMinor: 20_000, alreadyRefundedMinor: 0, refundableMinor: 20_000 });
  });

  it('applies a waiver adjustment that reduces the balance', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    const { invoice: adjusted } = h.financial.recordAdjustment(
      h.admin,
      { invoiceId: invoice.id, kind: 'waiver', amountMinor: 10_000, reason: 'Goodwill discount' },
      'adj1',
    );
    expect(adjusted.adjustedMinor).toBe(-10_000);
    expect(adjusted.outstandingMinor).toBe(40_000);
  });

  it('applies an additional charge adjustment that increases the balance', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    const { invoice: adjusted } = h.financial.recordAdjustment(
      h.admin,
      { invoiceId: invoice.id, kind: 'additional_charge', amountMinor: 5_000 },
      'adj2',
    );
    expect(adjusted.adjustedMinor).toBe(5_000);
    expect(adjusted.outstandingMinor).toBe(55_000);
  });

  it('voids an unpaid invoice and excludes it from the statement', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    const voided = h.financial.voidInvoice(h.admin, invoice.id, 'Entered in error');
    expect(voided.status).toBe('void');
    expect(voided.voidReason).toBe('Entered in error');
    const statement = h.financial.buildStatement({ patientId });
    expect(statement.closingMinor).toBe(0);
    expect(statement.rows).toHaveLength(0);
  });

  it('refuses to void an invoice that still has payments, protecting the money trail', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 10_000, method: 'Cash' }, 'pv');
    let caught: AppError | null = null;
    try {
      h.financial.voidInvoice(h.admin, invoice.id, 'Mistake');
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught?.code).toBe('FINANCIAL_IMMUTABLE');
  });

  it('refuses to edit a fully paid invoice, requiring a correction workflow instead', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 50_000, method: 'Cash' }, 'psettle');
    let caught: AppError | null = null;
    try {
      h.financial.updateInvoice(h.admin, invoice.id, { patientId, lines: [line(40_000)] });
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught?.code).toBe('FINANCIAL_IMMUTABLE');
  });

  it('refuses an edit that would drop the total below the amount already paid', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 30_000, method: 'Cash' }, 'pp');
    let caught: AppError | null = null;
    try {
      h.financial.updateInvoice(h.admin, invoice.id, { patientId, lines: [line(20_000)] });
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught?.code).toBe('VALIDATION');
    expect(caught?.details).toMatchObject({ paidMinor: 30_000, projectedTotalMinor: 20_000 });
  });

  it('voids a payment that has no receipt and restores the balance', () => {
    const noReceipt = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    const { payment } = h.financial.recordPayment(
      h.admin,
      { invoiceId: noReceipt.id, amountMinor: 20_000, method: 'Cash', issueReceipt: false },
      'pnoreceipt',
    );
    const { invoice } = h.financial.voidPayment(h.admin, payment.id, 'Entered twice at the desk');
    expect(invoice.paidMinor).toBe(0);
    expect(invoice.outstandingMinor).toBe(50_000);
    expect(invoice.status).toBe('issued');
  });

  it('blocks a payment against a void invoice', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.voidInvoice(h.admin, invoice.id, 'Duplicate');
    expect(() => h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 1000, method: 'Cash' }, 'kvoid')).toThrow(
      /void/,
    );
  });
});

describe('statements', () => {
  it('reconciles opening balance, invoices, payments, refunds and adjustments', () => {
    const inv1 = h.financial.createInvoice(h.admin, { patientId, lines: [line(30_000)] });
    const inv2 = h.financial.createInvoice(h.admin, { patientId, lines: [line(20_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: inv1.id, amountMinor: 30_000, method: 'Cash' }, 's1');
    h.financial.recordPayment(h.admin, { invoiceId: inv2.id, amountMinor: 5_000, method: 'Card' }, 's2');
    h.financial.recordRefund(h.admin, { invoiceId: inv1.id, amountMinor: 5_000, reason: 'goodwill' }, 'sr1');
    h.financial.recordAdjustment(h.admin, { invoiceId: inv2.id, kind: 'waiver', amountMinor: 2_000 }, 'sa1');

    const statement = h.financial.buildStatement({ patientId });
    expect(statement.openingMinor).toBe(0);
    expect(statement.totalInvoicedMinor).toBe(50_000);
    expect(statement.totalPaidMinor).toBe(35_000);
    expect(statement.totalRefundedMinor).toBe(5_000);
    expect(statement.totalAdjustedMinor).toBe(-2_000);
    // 50000 - 35000 + 5000 - 2000 = 18000
    expect(statement.closingMinor).toBe(18_000);

    // Cross-check against the ledger.
    const ledger = h.financial.currentOutstanding(patientId, null);
    expect(ledger).toBe(statement.closingMinor);
  });

  it('carries an opening balance derived from activity before the window', () => {
    const early = h.financial.createInvoice(h.admin, {
      patientId,
      lines: [line(40_000)],
      invoiceDateKey: '2025-01-15',
    });
    void early;
    const later = h.financial.createInvoice(h.admin, {
      patientId,
      lines: [line(25_000)],
      invoiceDateKey: '2026-03-10',
    });
    void later;
    const statement = h.financial.buildStatement({ patientId, fromKey: '2026-01-01' });
    expect(statement.openingMinor).toBe(40_000);
    expect(statement.totalInvoicedMinor).toBe(25_000);
    expect(statement.closingMinor).toBe(65_000);
  });

  it('produces a deterministic row order across repeated builds', () => {
    const invoice = h.financial.createInvoice(h.admin, { patientId, lines: [line(50_000)] });
    h.financial.recordPayment(h.admin, { invoiceId: invoice.id, amountMinor: 10_000, method: 'Cash' }, 'd1');
    h.financial.recordAdjustment(h.admin, { invoiceId: invoice.id, kind: 'waiver', amountMinor: 1_000 }, 'd2');
    const a = h.financial.buildStatement({ patientId });
    const b = h.financial.buildStatement({ patientId });
    expect(a.rows.map((r) => `${r.kind}:${r.reference}`)).toEqual(b.rows.map((r) => `${r.kind}:${r.reference}`));
    expect(a.closingMinor).toBe(b.closingMinor);
  });

  it('returns an empty statement with a zero balance for a patient with no financial history', () => {
    const statement = h.financial.buildStatement({ patientId });
    expect(statement.rows).toHaveLength(0);
    expect(statement.openingMinor).toBe(0);
    expect(statement.closingMinor).toBe(0);
  });
});

describe('financial invariants', () => {
  it('computeOutstanding satisfies invariant I2', () => {
    expect(computeOutstanding({ totalMinor: 10_000, paidMinor: 0 })).toBe(10_000);
    expect(computeOutstanding({ totalMinor: 10_000, paidMinor: 10_000 })).toBe(0);
    expect(computeOutstanding({ totalMinor: 10_000, paidMinor: 4_000, refundedMinor: 1_000 })).toBe(7_000);
    expect(computeOutstanding({ totalMinor: 10_000, paidMinor: 0, adjustmentMinor: -2_500 })).toBe(7_500);
  });

  it('deriveInvoiceStatus reflects the balance', () => {
    expect(deriveInvoiceStatus({ totalMinor: 100, paidMinor: 0 })).toBe('issued');
    expect(deriveInvoiceStatus({ totalMinor: 100, paidMinor: 40 })).toBe('partially_paid');
    expect(deriveInvoiceStatus({ totalMinor: 100, paidMinor: 100 })).toBe('paid');
    expect(deriveInvoiceStatus({ totalMinor: 100, paidMinor: 0, voided: true })).toBe('void');
  });

  it('computeStatement running balance always ends at the closing balance', () => {
    const entries = [
      { occurredAt: '2026-01-01T00:00:00.000Z', kind: 'invoice' as const, deltaMinor: 5000, sequence: 0, reference: 'INV-A' },
      { occurredAt: '2026-01-02T00:00:00.000Z', kind: 'payment' as const, deltaMinor: -2000, sequence: 1, reference: 'INV-A' },
      { occurredAt: '2026-01-03T00:00:00.000Z', kind: 'adjustment' as const, deltaMinor: -500, sequence: 2, reference: 'INV-A' },
    ];
    const result = computeStatement(1000, entries);
    expect(result.rows[result.rows.length - 1]?.runningBalanceMinor).toBe(result.closingMinor);
    expect(result.closingMinor).toBe(3500);
  });

  it('the database rejects an invoice row that violates invariant I1', () => {
    expect(() =>
      h.db.run(
        `INSERT INTO invoices (id, number, patient_id, invoice_date, subtotal_minor, discount_minor, taxable_minor,
             tax_percent, tax_minor, total_minor, created_at, updated_at)
         VALUES ('inv_bad','INV-2026-900001',?,'2026-01-01',1000,0,1000,0,0,999,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        patientId,
      ),
    ).toThrow();
  });
});
