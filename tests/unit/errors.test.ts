import { describe, it, expect } from 'vitest';
import { AppError, Errors, isAppErrorWire, SECRET_KEY_PATTERN, sanitizeForWire } from '../../src/shared/errors';

describe('error contract', () => {
  it('creates validation error with field errors', () => {
    const error = Errors.validation('Validation failed', { name: 'Required' });
    expect(error.code).toBe('VALIDATION');
    expect(error.fieldErrors.name).toBe('Required');
    expect(error.message).toBe('Validation failed');
  });

  it('creates not found error', () => {
    const error = Errors.notFound('patient');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('patient');
  });

  it('serializes to wire format', () => {
    const error = new AppError('Test error', { code: 'VALIDATION', fieldErrors: { name: 'Required' }, details: { foo: 'bar' } });
    const wire = error.toWire();
    expect(wire.name).toBe('AppError');
    expect(wire.code).toBe('VALIDATION');
    expect(wire.message).toBe('Test error');
    expect(wire.fieldErrors.name).toBe('Required');
    expect(isAppErrorWire(wire)).toBe(true);
  });

  it('deserializes from wire', () => {
    const wire = { name: 'AppError' as const, code: 'VALIDATION' as const, message: 'Test', details: {}, fieldErrors: { name: 'Required' }, retryable: false };
    const error = AppError.fromWire(wire);
    expect(error.code).toBe('VALIDATION');
    expect(error.fieldErrors.name).toBe('Required');
  });

  it('redacts secrets', () => {
    expect(SECRET_KEY_PATTERN.test('password')).toBe(true);
    expect(SECRET_KEY_PATTERN.test('secret')).toBe(true);
    expect(SECRET_KEY_PATTERN.test('token')).toBe(true);
    expect(SECRET_KEY_PATTERN.test('name')).toBe(false);

    const sanitized = sanitizeForWire({ password: 'secret123', name: 'John' });
    expect(sanitized.password).toBe('[redacted]');
    expect(sanitized.name).toBe('John');
  });

  it('handles circular references', () => {
    const obj: any = { name: 'test' };
    obj.self = obj;
    const sanitized = sanitizeForWire(obj);
    expect(sanitized.self).toBe('[circular]');
  });

  it('fromUnknown normalizes errors', () => {
    const error = AppError.fromUnknown(new Error('Original'));
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('The operation could not be completed.');

    const error2 = AppError.fromUnknown('string error', 'Fallback message');
    expect(error2.message).toBe('Fallback message');
  });
});
