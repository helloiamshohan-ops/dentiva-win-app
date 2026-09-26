import { describe, it, expect } from 'vitest';
import { resolveMovement, checkStock, recomputeQuantity, expiryStatus, isLowStock } from '../../src/domain/inventory';

describe('inventory domain', () => {
  it('resolves inbound movements', () => {
    const movement = resolveMovement({ type: 'purchase', quantity: 10 });
    expect(movement.signedQuantity).toBe(10);
    expect(movement.quantity).toBe(10);
  });

  it('resolves outbound movements', () => {
    const movement = resolveMovement({ type: 'stock_out', quantity: 5 });
    expect(movement.signedQuantity).toBe(-5);
  });

  it('resolves adjustment with signed delta', () => {
    const movement = resolveMovement({ type: 'adjustment', quantity: 0, delta: -3 });
    expect(movement.signedQuantity).toBe(-3);
  });

  it('checks stock prevents negative without permission', () => {
    const movement = resolveMovement({ type: 'stock_out', quantity: 10 });
    expect(() => checkStock({ currentQuantity: 5, movement, allowNegative: false })).toThrow();
    expect(checkStock({ currentQuantity: 5, movement, allowNegative: true })).toBe(-5);
  });

  it('recomputes quantity from history', () => {
    const movements = [{ signedQuantity: 10 }, { signedQuantity: -3 }, { signedQuantity: 5 }];
    expect(recomputeQuantity(movements)).toBe(12);
  });

  it('determines expiry status', () => {
    expect(expiryStatus(null, '2026-01-01')).toBe('no_expiry');
    expect(expiryStatus('2025-12-31', '2026-01-01')).toBe('expired');
    expect(expiryStatus('2026-01-15', '2026-01-01', 60)).toBe('expiring_soon');
    expect(expiryStatus('2026-12-31', '2026-01-01', 60)).toBe('ok');
  });

  it('detects low stock', () => {
    expect(isLowStock(5, 10)).toBe(true);
    expect(isLowStock(10, 10)).toBe(true);
    expect(isLowStock(11, 10)).toBe(false);
    expect(isLowStock(0, 0)).toBe(true);
    expect(isLowStock(1, 0)).toBe(false);
  });
});
