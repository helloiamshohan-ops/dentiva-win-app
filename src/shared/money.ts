/**
 * Dentiva Pro — monetary arithmetic.
 *
 * ALL monetary values in Dentiva Pro are represented as **integer minor currency units**
 * (for BDT: poisha, 1 BDT = 100 poisha). Floating point is never used for money: binary
 * floating point cannot represent most decimal fractions exactly, which produces balances
 * that drift by fractions of a unit and fail to reconcile.
 *
 * Rules enforced here:
 *   - Every monetary input is validated to be a safe integer of minor units.
 *   - Division that can produce fractions uses explicit, documented rounding (half-up).
 *   - Percentages are applied to integers with half-up rounding at the last step only,
 *     never compounded through intermediate floats.
 */

export const MINOR_UNITS_PER_MAJOR = 100;

export class MoneyError extends Error {
  readonly code = 'MONEY_INVALID';
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** True when `v` is a finite safe integer suitable for use as a minor-unit amount. */
export function isMinorAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Throws unless `v` is a valid minor-unit amount. */
export function assertMinorAmount(v: unknown, field = 'amount'): number {
  if (!isMinorAmount(v)) {
    throw new MoneyError(
      `${field} must be a whole number of minor currency units, received ${typeof v}: ${String(v)}`,
      { field, received: v },
    );
  }
  return v;
}

/** Rounding mode used for every monetary division in the product. */
export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

function roundToInteger(value: number, mode: RoundingMode): number {
  if (!Number.isFinite(value)) throw new MoneyError(`Non-finite value cannot be rounded: ${value}`);
  switch (mode) {
    case 'down':
      return Math.trunc(value);
    case 'up':
      return value < 0 ? Math.ceil(value) : Math.floor(value) * -1 === value ? value : Math.sign(value) * Math.ceil(Math.abs(value));
    case 'half-even': {
      const floor = Math.floor(value);
      const diff = value - floor;
      if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
      return Math.round(value);
    }
    case 'half-up':
    default:
      return value < 0 ? -Math.round(-value) : Math.round(value);
  }
}

/** Parse a decimal string or finite number expressed in major units into minor units. */
export function toMinorUnits(input: string | number | null | undefined, field = 'amount'): number {
  if (input === null || input === undefined || input === '') return 0;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`${field} must be finite`, { input });
    return roundToInteger(input * MINOR_UNITS_PER_MAJOR, 'half-up');
  }
  const raw = String(input).trim().replace(/,/g, '');
  if (raw === '') return 0;
  if (!/^-?\d{0,15}(\.\d{1,8})?$/.test(raw)) {
    throw new MoneyError(`${field} is not a valid decimal amount`, { input });
  }
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const [intPart = '0', fracPart = ''] = body.split('.');
  const frac = (fracPart + '00').slice(0, 2);
  const remainder = fracPart.length > 2 ? Number(fracPart.slice(2, 3)) : 0;
  let minor = Number(intPart) * MINOR_UNITS_PER_MAJOR + Number(frac);
  // Round any sub-poisha remainder half-up so 12.345 -> 1235 poisha.
  if (remainder >= 5) minor += 1;
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`${field} exceeds supported range`, { input });
  return negative ? -minor : minor;
}

/** Convert minor units to a fixed 2-decimal major-unit string. Never uses exponential form. */
export function toDecimalString(minor: number): string {
  assertMinorAmount(minor);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const major = Math.floor(abs / MINOR_UNITS_PER_MAJOR);
  const frac = abs % MINOR_UNITS_PER_MAJOR;
  return `${negative ? '-' : ''}${major}.${String(frac).padStart(2, '0')}`;
}

export type MoneyFormatOptions = {
  /** ISO-like currency code, e.g. "BDT". */
  currency?: string;
  /** Currency symbol, e.g. "৳". Falls back to the currency code when absent. */
  symbol?: string;
  /** Thousands grouping. Default true. */
  grouping?: boolean;
  /** Prefix a leading "+" for positive values. Used by statements/reports. */
  signed?: boolean;
};

/**
 * Format minor units for display and for documents.
 *
 * Grouping is implemented directly rather than via `Intl.NumberFormat` so that the output is
 * byte-identical in the UI, in PDF text extraction and on every platform. Consistency of
 * financial rendering across preview, PDF and print is a release requirement.
 */
export function formatMoney(minor: number, options: MoneyFormatOptions = {}): string {
  const { currency = 'BDT', symbol, grouping = true, signed = false } = options;
  assertMinorAmount(minor);
  const negative = minor < 0;
  let digits = toDecimalString(Math.abs(minor));
  if (grouping) {
    const [intPart, fracPart] = digits.split('.');
    const grouped = (intPart ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    digits = fracPart === undefined ? grouped : `${grouped}.${fracPart}`;
  }
  const sign = negative ? '-' : signed ? '+' : '';
  const label = symbol ?? currency;
  return `${sign}${label} ${digits}`.replace(`${label} `, `${label} `);
}

/** Plain numeric string without any currency label, e.g. "1,234.56". */
export function formatAmountOnly(minor: number, grouping = true): string {
  return formatMoney(minor, { symbol: '', grouping }).trim();
}

export function add(a: number, b: number): number {
  const r = assertMinorAmount(a, 'a') + assertMinorAmount(b, 'b');
  return assertMinorAmount(r, 'result');
}

export function sub(a: number, b: number): number {
  const r = assertMinorAmount(a, 'a') - assertMinorAmount(b, 'b');
  return assertMinorAmount(r, 'result');
}

/** Sum any number of minor-unit amounts. */
export function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total = add(total, v);
  return total;
}

/** Multiply a unit price by a whole-number quantity. */
export function multiplyByQuantity(unitMinor: number, quantity: number): number {
  assertMinorAmount(unitMinor, 'unitPrice');
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MoneyError('quantity must be a non-negative whole number', { quantity });
  }
  return assertMinorAmount(unitMinor * quantity, 'lineTotal');
}

/**
 * Apply a percentage to a minor-unit amount with half-up rounding applied once, at the end.
 * `percent` is expressed in percent (e.g. 12.5 means 12.5%).
 */
export function applyPercent(amountMinor: number, percent: number, mode: RoundingMode = 'half-up'): number {
  assertMinorAmount(amountMinor);
  if (!Number.isFinite(percent) || percent < 0) {
    throw new MoneyError('percent must be a finite non-negative number', { percent });
  }
  // Scale to integer arithmetic where possible: (amount * percentBasis) / 10000
  const percentBasis = Math.round(percent * 100);
  if (!Number.isSafeInteger(percentBasis)) throw new MoneyError('percent is out of supported range', { percent });
  const numerator = amountMinor * percentBasis;
  if (!Number.isSafeInteger(numerator)) throw new MoneyError('percentage calculation overflowed', { percent });
  return assertMinorAmount(roundToInteger(numerator / 10_000, mode), 'result');
}

/** Distribute `totalMinor` across `parts` weights so the parts sum exactly to the total. */
export function apportion(totalMinor: number, weights: number[]): number[] {
  assertMinorAmount(totalMinor);
  if (weights.length === 0) return [];
  const totalWeight = weights.reduce((acc, w) => {
    if (!Number.isFinite(w) || w < 0) throw new MoneyError('weights must be finite and non-negative', { weights });
    return acc + w;
  }, 0);
  if (totalWeight === 0) throw new MoneyError('weights must sum to a positive value', { weights });
  const result: number[] = [];
  let allocated = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i] ?? 0;
    if (i === weights.length - 1) {
      result.push(totalMinor - allocated);
    } else {
      const share = roundToInteger((totalMinor * w) / totalWeight, 'half-up');
      result.push(share);
      allocated += share;
    }
  }
  return result;
}

/** Clamp helper used by discount validation. */
export function clampToAmount(amount: number, ceiling: number): number {
  assertMinorAmount(amount);
  assertMinorAmount(ceiling);
  if (amount < 0) return 0;
  return amount > ceiling ? ceiling : amount;
}
