import { describe, it, expect } from 'vitest';
import { normalizePhone, normalizeName, tokenSimilarity, scoreDuplicate, isValidPhone, isValidEmail } from '../../src/domain/patient';

describe('patient domain', () => {
  it('normalizes Bangladeshi phone numbers', () => {
    expect(normalizePhone('01712345678')).toBe('01712345678');
    expect(normalizePhone('+8801712345678')).toBe('01712345678');
    expect(normalizePhone('8801712345678')).toBe('01712345678');
    expect(normalizePhone('1712345678')).toBe('01712345678');
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('validates phone numbers', () => {
    expect(isValidPhone('01712345678')).toBe(true);
    expect(isValidPhone('')).toBe(true); // optional
    expect(isValidPhone(null)).toBe(true);
    expect(isValidPhone('123')).toBe(false);
  });

  it('validates email', () => {
    expect(isValidEmail('test@example.com')).toBe(true);
    expect(isValidEmail('')).toBe(true);
    expect(isValidEmail(null)).toBe(true);
    expect(isValidEmail('invalid')).toBe(false);
  });

  it('normalizes names', () => {
    expect(normalizeName('John Doe')).toBe('john doe');
    expect(normalizeName('  John   Doe  ')).toBe('john doe');
    expect(normalizeName("O'Brien")).toBe('o brien');
    expect(normalizeName('')).toBe('');
  });

  it('calculates token similarity', () => {
    expect(tokenSimilarity('John Doe', 'John Doe')).toBe(1);
    expect(tokenSimilarity('John Doe', 'Doe John')).toBe(1);
    expect(tokenSimilarity('John Doe', 'Jane Doe')).toBeGreaterThan(0);
    expect(tokenSimilarity('John Doe', 'Jane Smith')).toBe(0);
  });

  it('scores duplicates with phone dominating', () => {
    const incoming = { name: 'John Doe', phone: '01712345678', email: null, dobKey: '1990-01-01' };
    const candidate = { id: 'pat_1', name: 'John Doe', phone: '01712345678', email: null, dobKey: '1990-01-01', patientCode: 'DP-000001' };
    const match = scoreDuplicate(incoming, candidate);
    expect(match.score).toBeGreaterThan(80);
    expect(match.signals.some((s) => s.field === 'phone')).toBe(true);
  });
});
