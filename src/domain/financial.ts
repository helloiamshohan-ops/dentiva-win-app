/**
 * Dentiva Pro — financial domain rules.
 *
 * Pure functions only: no database access, no I/O. Every rule here is unit-tested and is the
 * single authority for how invoice totals and outstanding balances are computed. Services and
 * the document engine both call into this module, so a printed invoice, a screen and a report
 * can never disagree.
 *
 * All amounts are integer minor currency units (see `@shared/money`).
 *
 * ── Definitions ───────────────────────────────────────────────────────────────────────────
 *   lineGross  = quantity × unitPrice
 *   lineNet    = lineGross − lineDiscount          (never negative)
 *   subtotal   = Σ lineNet
 *   discount   = invoiceDiscount                   (overall; clamped to subtotal)
 *   taxable    = subtotal − discount
 *   tax        = round(taxable × taxPercent / 100) (half-up, applied once)
 *   total      = taxable + tax
 *
 * ── Invariant I1 ── subtotal − discount + tax = total   (exact, integer)
 * ── Invariant I2 ── total − payments + refunds + adjustments = outstanding
 * ── Invariant I3 ── paid ≤ total unless an overpayment was explicitly permitted
 */

import {
  add,
  applyPercent,
  assertMinorAmount,
  multiplyByQuantity,
  sub,
  sum,
  type RoundingMode,
} from '../shared/money';
import { AppError, Errors } from '../shared/errors';

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS_DEFAULT = ['Cash', 'Bank', 'Card', 'bKash', 'Nagad', 'Rocket', 'Upay'] as const;

export const REFUND_REASONS = ['overpayment_return', 'service_not_provided', 'billing_error', 'goodwill', 'other'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const ADJUSTMENT_KINDS = ['waiver', 'additional_charge', 'correction'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export interface InvoiceLineInput {
  id?: string;
  treatmentId?: string | null;
  description: string;
  quantity: number;
  /** Unit price in minor units. */
  unitPriceMinor: number;
  /** Per-line discount in minor units. */
  discountMinor?: number;
}

export interface ComputedLine {
  id: string | null;
  treatmentId: string | null;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  grossMinor: number;
  netMinor: number;
}

export interface InvoiceTotals {
  lineCount: number;
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxPercent: number;
  taxMinor: number;
  totalMinor: number;
  /** Sum of Σ(quantity × unitPrice) before any discount — informational. */
  grossMinor: number;
  /** Sum of per-line discounts — informational. */
  lineDiscountMinor: number;
}

export interface InvoiceComputation {
  lines: ComputedLine[];
  totals: InvoiceTotals;
}

export interface InvoiceTotalsInput {
  lines: InvoiceLineInput[];
  /** Overall invoice discount in minor units. */
  discountMinor?: number;
  /** Tax percentage, e.g. 5 for 5%. */
  taxPercent?: number;
}

const MAX_TAX_PERCENT = 100;

export function computeInvoiceTotals(input: InvoiceTotalsInput): InvoiceComputation {
  const lines = input.lines ?? [];
  if (lines.length === 0) {
    throw Errors.validation('An invoice must contain at least one line item.', { lines: 'Add at least one line item.' });
  }

  const computed: ComputedLine[] = lines.map((line, index) => {
    const position = `Line ${index + 1}`;
    const description = (line.description ?? '').trim();
    if (description === '') {
      throw Errors.validation(`${position} needs a description.`, { [`lines.${index}.description`]: 'Enter a description.' });
    }
    if (description.length > 300) {
      throw Errors.validation(`${position} description is too long (maximum 300 characters).`, {
        [`lines.${index}.description`]: 'Shorten the description.',
      });
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw Errors.validation(`${position} quantity must be a whole number of 1 or more.`, {
        [`lines.${index}.quantity`]: 'Quantity must be 1 or more.',
      });
    }
    if (line.quantity > 100_000) {
      throw Errors.validation(`${position} quantity is unreasonably large.`, {
        [`lines.${index}.quantity`]: 'Quantity must be 100,000 or fewer.',
      });
    }
    assertMinorAmount(line.unitPriceMinor, `${position} unit price`);
    if (line.unitPriceMinor < 0) {
      throw Errors.validation(`${position} unit price cannot be negative.`, {
        [`lines.${index}.unitPriceMinor`]: 'Unit price cannot be negative.',
      });
    }
    const discountMinor = line.discountMinor ?? 0;
    assertMinorAmount(discountMinor, `${position} discount`);
    if (discountMinor < 0) {
      throw Errors.validation(`${position} discount cannot be negative. Use a negative line price instead.`, {
        [`lines.${index}.discountMinor`]: 'Discount cannot be negative.',
      });
    }
    const grossMinor = multiplyByQuantity(line.unitPriceMinor, line.quantity);
    if (discountMinor > grossMinor) {
      throw Errors.validation(`${position} discount is larger than the line total.`, {
        [`lines.${index}.discountMinor`]: 'Discount cannot exceed the line total.',
      });
    }
    return {
      id: line.id ?? null,
      treatmentId: line.treatmentId ?? null,
      description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor,
      grossMinor,
      netMinor: sub(grossMinor, discountMinor),
    };
  });

  const grossMinor = sum(computed.map((l) => l.grossMinor));
  const lineDiscountMinor = sum(computed.map((l) => l.discountMinor));
  const subtotalMinor = sum(computed.map((l) => l.netMinor));

  const requestedDiscount = input.discountMinor ?? 0;
  assertMinorAmount(requestedDiscount, 'invoice discount');
  if (requestedDiscount < 0) {
    throw Errors.validation('Invoice discount cannot be negative.', { discountMinor: 'Discount cannot be negative.' });
  }
  if (requestedDiscount > subtotalMinor) {
    throw Errors.validation('Invoice discount cannot be greater than the subtotal.', {
      discountMinor: 'Discount cannot exceed the subtotal.',
    });
  }

  const taxPercent = input.taxPercent ?? 0;
  if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > MAX_TAX_PERCENT) {
    throw Errors.validation(`Tax percentage must be between 0 and ${MAX_TAX_PERCENT}.`, {
      taxPercent: `Enter a value between 0 and ${MAX_TAX_PERCENT}.`,
    });
  }

  const taxableMinor = sub(subtotalMinor, requestedDiscount);
  const taxMinor = applyPercent(taxableMinor, taxPercent);
  const totalMinor = add(taxableMinor, taxMinor);

  return {
    lines: computed,
    totals: {
      lineCount: computed.length,
      subtotalMinor,
      discountMinor: requestedDiscount,
      taxableMinor,
      taxPercent,
      taxMinor,
      totalMinor,
      grossMinor,
      lineDiscountMinor,
    },
  };
}

/**
 * Invariant I1. Throws when a persisted or computed invoice no longer satisfies
 * `subtotal − discount + tax = total`. Used by integrity diagnostics and by every write path.
 */
/** The subset of totals the invariant depends on. */
export interface InvoiceInvariantInput {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export function assertInvoiceInvariant(t: InvoiceInvariantInput, label = 'Invoice'): void {
  const expected = add(sub(t.subtotalMinor, t.discountMinor), t.taxMinor);
  if (expected !== t.totalMinor) {
    throw Errors.integrity(
      `${label} totals do not reconcile: subtotal − discount + tax is ${expected} but the stored total is ${t.totalMinor}.`,
      {
        subtotalMinor: t.subtotalMinor,
        discountMinor: t.discountMinor,
        taxMinor: t.taxMinor,
        totalMinor: t.totalMinor,
        expected,
        invariant: 'I1',
      },
    );
  }
  if (t.taxableMinor !== sub(t.subtotalMinor, t.discountMinor)) {
    throw Errors.integrity(`${label} taxable base does not match subtotal − discount.`, {
      taxableMinor: t.taxableMinor,
      subtotalMinor: t.subtotalMinor,
      discountMinor: t.discountMinor,
      invariant: 'I1b',
    });
  }
}

export interface BalanceInput {
  totalMinor: number;
  /** Sum of persisted, non-voided payments. */
  paidMinor: number;
  /** Sum of persisted refunds (always stored positive; they increase the balance). */
  refundedMinor?: number;
  /** Signed sum of adjustments: positive increases the balance, negative reduces it. */
  adjustmentMinor?: number;
}

/** Invariant I2: outstanding = total − payments + refunds + adjustments. */
export function computeOutstanding(input: BalanceInput): number {
  const total = assertMinorAmount(input.totalMinor, 'total');
  const paid = assertMinorAmount(input.paidMinor, 'paid');
  const refunded = assertMinorAmount(input.refundedMinor ?? 0, 'refunded');
  const adjustment = assertMinorAmount(input.adjustmentMinor ?? 0, 'adjustment');
  if (paid < 0) throw Errors.validation('Recorded payments cannot be negative.');
  if (refunded < 0) throw Errors.validation('Recorded refunds cannot be negative.');
  return sub(add(add(total, refunded), adjustment), paid);
}

/** Derive the stored invoice status from totals and balance. */
export function deriveInvoiceStatus(input: BalanceInput & { voided?: boolean }): InvoiceStatus {
  if (input.voided) return 'void';
  const outstanding = computeOutstanding(input);
  if (input.paidMinor === 0 && (input.adjustmentMinor ?? 0) === 0) return 'issued';
  if (outstanding <= 0) return 'paid';
  return 'partially_paid';
}

export interface PaymentValidationInput {
  invoiceTotalMinor: number;
  alreadyPaidMinor: number;
  alreadyRefundedMinor: number;
  alreadyAdjustedMinor: number;
  amountMinor: number;
  /** When true the clinic permits credit balances. Default false. */
  allowOverpayment?: boolean;
}

/**
 * Validate a payment before it is written.
 *
 * Returns the outstanding balance the payment is applied against. Rejections are explicit and
 * carry the numbers involved so the UI can explain the problem instead of failing silently.
 */
export function validatePayment(input: PaymentValidationInput): { outstandingBefore: number; outstandingAfter: number } {
  const amount = assertMinorAmount(input.amountMinor, 'payment amount');
  if (amount <= 0) {
    throw Errors.validation('Payment amount must be greater than zero.', {
      amountMinor: 'Enter an amount greater than zero.',
    });
  }
  const outstandingBefore = computeOutstanding({
    totalMinor: input.invoiceTotalMinor,
    paidMinor: input.alreadyPaidMinor,
    refundedMinor: input.alreadyRefundedMinor,
    adjustmentMinor: input.alreadyAdjustedMinor,
  });
  const outstandingAfter = sub(outstandingBefore, amount);
  if (outstandingAfter < 0 && !input.allowOverpayment) {
    throw new AppError(
      `This payment is ${-outstandingAfter / 100 > 0 ? '' : ''}larger than the outstanding balance of ${outstandingBefore / 100}. Record the exact amount due, or enable overpayments in settings.`,
      {
        code: 'OVERPAYMENT_NOT_ALLOWED',
        details: {
          amountMinor: amount,
          outstandingBeforeMinor: outstandingBefore,
          overByMinor: -outstandingAfter,
        },
      },
    );
  }
  return { outstandingBefore, outstandingAfter };
}

/** Validate a refund. Refunds are stored as positive amounts and increase the balance. */
export function validateRefund(input: {
  invoiceTotalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  amountMinor: number;
}): void {
  const amount = assertMinorAmount(input.amountMinor, 'refund amount');
  if (amount <= 0) {
    throw Errors.validation('Refund amount must be greater than zero.', { amountMinor: 'Enter an amount greater than zero.' });
  }
  const refundable = sub(input.paidMinor, input.refundedMinor);
  if (amount > refundable) {
    throw new AppError(
      `Only ${refundable / 100} of this invoice is still refundable. ${input.refundedMinor / 100} has already been refunded.`,
      {
        code: 'VALIDATION',
        fieldErrors: { amountMinor: 'Refund exceeds the refundable amount.' },
        details: {
          amountMinor: amount,
          paidMinor: input.paidMinor,
          alreadyRefundedMinor: input.refundedMinor,
          refundableMinor: refundable,
        },
      },
    );
  }
}

/** Guard that a computed adjustment delta stayed a safe integer (guards against overflow). */
export function adjustDeltaGuard(delta: number): number {
  if (!Number.isSafeInteger(delta)) {
    throw new AppError('The adjustment amount is outside the supported range.', {
      code: 'VALIDATION',
      fieldErrors: { amountMinor: 'Enter a smaller amount.' },
    });
  }
  return delta;
}

/** Signed delta for an adjustment: a waiver reduces the balance, a charge increases it. */
export function adjustmentDelta(kind: AdjustmentKind, amountMinor: number): number {
  const amount = assertMinorAmount(amountMinor, 'adjustment amount');
  if (amount <= 0) throw Errors.validation('Adjustment amount must be greater than zero.');
  switch (kind) {
    case 'waiver':
      return -amount;
    case 'additional_charge':
    case 'correction':
      return amount;
    default:
      throw Errors.validation(`Unknown adjustment kind: ${String(kind)}`);
  }
}

/**
 * Recompute a statement's running balance from its persisted transactions.
 *
 * The statement never invents figures: opening balance plus every invoice, payment, refund and
 * adjustment, applied in deterministic order, must equal the closing balance.
 */
export interface StatementEntryInput {
  /** ISO instant used for deterministic ordering. */
  occurredAt: string;
  kind: 'opening' | 'invoice' | 'payment' | 'refund' | 'adjustment';
  /** Positive = increases the patient's balance. Negative = reduces it. */
  deltaMinor: number;
  sequence: number;
  reference: string;
}

export interface StatementRow {
  entry: StatementEntryInput;
  runningBalanceMinor: number;
}

export interface StatementComputation {
  openingMinor: number;
  rows: StatementRow[];
  closingMinor: number;
  totalInvoicedMinor: number;
  totalPaidMinor: number;
  totalRefundedMinor: number;
  totalAdjustedMinor: number;
}

export function computeStatement(openingMinor: number, entries: StatementEntryInput[]): StatementComputation {
  assertMinorAmount(openingMinor, 'opening balance');
  // Deterministic ordering: time, then kind rank, then sequence. Without a total order two
  // statements generated moments apart could show different running balances.
  const kindRank: Record<StatementEntryInput['kind'], number> = {
    opening: 0,
    invoice: 1,
    adjustment: 2,
    payment: 3,
    refund: 4,
  };
  const sorted = [...entries].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
    const rank = kindRank[a.kind] - kindRank[b.kind];
    if (rank !== 0) return rank;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;
  });

  let running = openingMinor;
  const rows: StatementRow[] = [];
  let totalInvoiced = 0;
  let totalPaid = 0;
  let totalRefunded = 0;
  let totalAdjusted = 0;

  for (const entry of sorted) {
    assertMinorAmount(entry.deltaMinor, 'statement entry');
    running = add(running, entry.deltaMinor);
    rows.push({ entry, runningBalanceMinor: running });
    switch (entry.kind) {
      case 'invoice':
        totalInvoiced = add(totalInvoiced, entry.deltaMinor);
        break;
      case 'payment':
        totalPaid = add(totalPaid, -entry.deltaMinor);
        break;
      case 'refund':
        totalRefunded = add(totalRefunded, entry.deltaMinor);
        break;
      case 'adjustment':
        totalAdjusted = add(totalAdjusted, entry.deltaMinor);
        break;
      case 'opening':
        break;
    }
  }

  return {
    openingMinor,
    rows,
    closingMinor: running,
    totalInvoicedMinor: totalInvoiced,
    totalPaidMinor: totalPaid,
    totalRefundedMinor: totalRefunded,
    totalAdjustedMinor: totalAdjusted,
  };
}

/** Rounding mode used across the financial engine — declared once so it cannot drift. */
export const FINANCIAL_ROUNDING: RoundingMode = 'half-up';

/** Whether an invoice may still be edited. Completed financial records are immutable. */
export function isInvoiceEditable(status: InvoiceStatus): boolean {
  return status === 'draft' || status === 'issued' || status === 'partially_paid';
}

/**
 * Guard for edits to a financially completed record.
 *
 * Once an invoice is paid or voided its original prices must not be silently overwritten;
 * corrections must go through refund, adjustment or a new invoice so history stays explainable.
 */
export function assertInvoiceMutable(status: InvoiceStatus): void {
  if (!isInvoiceEditable(status)) {
    throw new AppError(
      status === 'paid'
        ? 'This invoice is fully paid, so its items and prices can no longer be changed. Use a refund, an adjustment or a new invoice to correct it.'
        : 'This invoice is void and can no longer be changed. Create a new invoice if further billing is required.',
      { code: 'FINANCIAL_IMMUTABLE', details: { status } },
    );
  }
}
