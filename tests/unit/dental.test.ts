import { describe, it, expect } from 'vitest';
import { ALL_TEETH, isToothNumber, getTooth, parseToothReferences, PERMANENT_TEETH, PRIMARY_TEETH } from '../../src/domain/dental';

describe('dental domain', () => {
  it('has 32 permanent teeth', () => {
    expect(PERMANENT_TEETH.length).toBe(32);
  });

  it('has 20 primary teeth', () => {
    expect(PRIMARY_TEETH.length).toBe(20);
  });

  it('has 52 total teeth', () => {
    expect(ALL_TEETH.length).toBe(52);
  });

  it('validates tooth numbers', () => {
    expect(isToothNumber(11)).toBe(true);
    expect(isToothNumber(18)).toBe(true);
    expect(isToothNumber(48)).toBe(true);
    expect(isToothNumber(55)).toBe(true);
    expect(isToothNumber(85)).toBe(true);
    expect(isToothNumber(99)).toBe(false);
    expect(isToothNumber(0)).toBe(false);
  });

  it('gets tooth by number', () => {
    const tooth = getTooth(16);
    expect(tooth).not.toBeNull();
    expect(tooth?.number).toBe(16);
    expect(tooth?.dentition).toBe('permanent');
  });

  it('parses tooth references', () => {
    const { numbers, rejected } = parseToothReferences('16, 17, 18');
    expect(numbers).toEqual([16, 17, 18]);
    expect(rejected).toEqual([]);

    const { numbers: numbers2 } = parseToothReferences('16-18');
    expect(numbers2).toEqual([16, 17, 18]);

    const { rejected: rejected2 } = parseToothReferences('invalid');
    expect(rejected2.length).toBeGreaterThan(0);
  });
});
