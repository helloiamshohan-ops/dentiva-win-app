import { describe, it, expect } from 'vitest';
import { toMinorUnits, toDecimalString, formatMoney, add, sub, sum, multiplyByQuantity, applyPercent, apportion } from '../../src/shared/money';

describe('money arithmetic', () => {
  it('converts decimal strings to minor units exactly', () => {
    expect(toMinorUnits('0')).toBe(0);
    expect(toMinorUnits('1')).toBe(100);
    expect(toMinorUnits('1.00')).toBe(100);
    expect(toMinorUnits('0.01')).toBe(1);
    expect(toMinorUnits('123.45')).toBe(12345);
    expect(toMinorUnits('0.1')).toBe(10);
    expect(toMinorUnits('0.2')).toBe(20);
  });

  it('handles 0.1 + 0.2 exactly', () => {
    const a = toMinorUnits('0.1');
    const b = toMinorUnits('0.2');
    expect(a + b).toBe(30);
    expect(toDecimalString(a + b)).toBe('0.30');
  });

  it('rounds sub-poisha half-up', () => {
    expect(toMinorUnits('12.345')).toBe(1235);
    expect(toMinorUnits('12.344')).toBe(1234);
    expect(toMinorUnits('12.3456')).toBe(1235);
  });

  it('formats with grouping', () => {
    expect(formatMoney(123456789, { symbol: '৳' })).toContain('1,234,567.89');
    expect(formatMoney(0, { symbol: '৳' })).toBe('৳ 0.00');
  });

  it('adds and subtracts safely', () => {
    expect(add(100, 200)).toBe(300);
    expect(sub(500, 200)).toBe(300);
    expect(sum([100, 200, 300])).toBe(600);
  });

  it('multiplies by quantity', () => {
    expect(multiplyByQuantity(1000, 3)).toBe(3000);
    expect(() => multiplyByQuantity(1000, -1)).toThrow();
    expect(() => multiplyByQuantity(1000, 1.5)).toThrow();
  });

  it('applies percent with half-up rounding', () => {
    expect(applyPercent(10000, 5)).toBe(500);
    expect(applyPercent(100, 50)).toBe(50);
    expect(applyPercent(1, 50)).toBe(1); // 0.5 rounds up
    expect(applyPercent(0, 100)).toBe(0);
  });

  it('apportions exactly', () => {
    const parts = apportion(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts.length).toBe(3);

    const parts2 = apportion(100, [50, 30, 20]);
    expect(parts2.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('rejects invalid inputs', () => {
    expect(() => toMinorUnits('invalid')).toThrow();
    expect(() => toMinorUnits(Number.NaN as any)).toThrow();
    expect(() => applyPercent(100, -5)).toThrow();
  });
});
