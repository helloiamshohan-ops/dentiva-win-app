/**
 * Dentiva Pro — inventory domain rules.
 *
 * Stock is derived from movements, never edited directly. Every movement is an immutable row,
 * so the quantity on hand is always explainable and auditable, and a corrupted quantity can be
 * recomputed from history.
 */

export const MOVEMENT_TYPES = [
  'purchase',
  'stock_in',
  'stock_out',
  'adjustment',
  'return',
  'correction',
  'wastage',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  purchase: 'Purchase',
  stock_in: 'Stock in',
  stock_out: 'Stock out',
  adjustment: 'Adjustment',
  return: 'Return',
  correction: 'Correction',
  wastage: 'Wastage',
};

/** Movement types that increase quantity on hand. */
const INBOUND: ReadonlySet<MovementType> = new Set<MovementType>(['purchase', 'stock_in', 'return']);
/** Movement types that decrease quantity on hand. */
const OUTBOUND: ReadonlySet<MovementType> = new Set<MovementType>(['stock_out', 'wastage']);

export function movementDirection(type: MovementType): 'in' | 'out' | 'signed' {
  if (INBOUND.has(type)) return 'in';
  if (OUTBOUND.has(type)) return 'out';
  return 'signed';
}

export interface MovementInput {
  type: MovementType;
  /** Always stored as a positive quantity; direction comes from the movement type. */
  quantity: number;
  /** Signed delta, only for `adjustment` and `correction`. */
  delta?: number;
  batch?: string | null;
  expiry?: string | null;
}

export interface ResolvedMovement {
  type: MovementType;
  quantity: number;
  /** Signed effect on quantity on hand. */
  signedQuantity: number;
  batch: string | null;
  expiry: string | null;
}

const MAX_QUANTITY = 10_000_000;

/** Resolve a movement into its signed effect, rejecting anything that would corrupt stock. */
export function resolveMovement(input: MovementInput): ResolvedMovement {
  if (!(MOVEMENT_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(`Unknown movement type: ${String(input.type)}`);
  }
  const direction = movementDirection(input.type);
  const batch = (input.batch ?? '').trim() === '' ? null : (input.batch as string).trim().slice(0, 80);
  const expiry = (input.expiry ?? '').trim() === '' ? null : (input.expiry as string).trim();

  if (direction === 'signed') {
    const delta = input.delta ?? 0;
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new Error('An adjustment or correction must have a non-zero whole-number quantity.');
    }
    if (Math.abs(delta) > MAX_QUANTITY) throw new Error('Adjustment quantity exceeds the supported range.');
    return { type: input.type, quantity: Math.abs(delta), signedQuantity: delta, batch, expiry };
  }

  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw new Error(`${MOVEMENT_TYPE_LABEL[input.type]} quantity must be a whole number greater than zero.`);
  }
  if (input.quantity > MAX_QUANTITY) throw new Error('Movement quantity exceeds the supported range.');
  const signed = direction === 'in' ? input.quantity : -input.quantity;
  return { type: input.type, quantity: input.quantity, signedQuantity: signed, batch, expiry };
}

export interface StockCheckInput {
  currentQuantity: number;
  movement: ResolvedMovement;
  /** When false, an operation that would drive stock negative is rejected. */
  allowNegative: boolean;
}

/**
 * Reject operations that would produce negative stock unless the clinic has explicitly enabled
 * negative stock. Silent negative stock hides data-entry errors and breaks valuation.
 */
export function checkStock(input: StockCheckInput): number {
  const next = input.currentQuantity + input.movement.signedQuantity;
  if (next < 0 && !input.allowNegative) {
    throw new Error(
      `This operation would reduce stock below zero (current ${input.currentQuantity}, change ${input.movement.signedQuantity}). Record the correct quantity or enable negative stock in settings.`,
    );
  }
  return next;
}

/** Recompute quantity on hand from a movement history. Used by integrity diagnostics. */
export function recomputeQuantity(movements: Iterable<{ signedQuantity: number }>): number {
  let total = 0;
  for (const m of movements) {
    if (!Number.isSafeInteger(m.signedQuantity)) throw new Error('Movement history contains a non-integer quantity.');
    total += m.signedQuantity;
  }
  return total;
}

export const EXPIRY_WARNING_DAYS_DEFAULT = 60;

export type ExpiryStatus = 'expired' | 'expiring_soon' | 'ok' | 'no_expiry';

export function expiryStatus(expiryKey: string | null, todayKey: string, warningDays: number = EXPIRY_WARNING_DAYS_DEFAULT): ExpiryStatus {
  if (expiryKey === null || expiryKey === '') return 'no_expiry';
  if (expiryKey < todayKey) return 'expired';
  const warnUntil = addDaysKey(todayKey, warningDays);
  return expiryKey <= warnUntil ? 'expiring_soon' : 'ok';
}

function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Low-stock classification. Threshold of 0 means "alert only when empty". */
export function isLowStock(quantity: number, minQuantity: number): boolean {
  if (!Number.isFinite(minQuantity) || minQuantity <= 0) return quantity <= 0;
  return quantity <= minQuantity;
}
