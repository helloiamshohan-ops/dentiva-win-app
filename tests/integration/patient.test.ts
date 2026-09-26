import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHarness, type Harness } from '../support/harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => h.close());

describe('patient service', () => {
  it('creates a patient with unique Patient Code', () => {
    const result = h.patients.create(h.admin, { name: 'Test Patient', sex: 'male' });
    expect(result.patient.patientCode).toMatch(/^DP-\d{6}$/);
    expect(result.patient.name).toBe('Test Patient');
  });

  it('allocates sequential Patient Codes race-safely', () => {
    const p1 = h.patients.create(h.admin, { name: 'Patient One', sex: 'male' });
    const p2 = h.patients.create(h.admin, { name: 'Patient Two', sex: 'female' });
    const code1 = parseInt(p1.patient.patientCode.split('-')[1]!, 10);
    const code2 = parseInt(p2.patient.patientCode.split('-')[1]!, 10);
    expect(code2).toBe(code1 + 1);
  });

  it('detects duplicate patients by phone', () => {
    h.patients.create(h.admin, { name: 'John Doe', sex: 'male', phone: '01712345678' });
    expect(() => {
      h.patients.create(h.admin, { name: 'John Doe', sex: 'male', phone: '01712345678' });
    }).toThrow(/may already be registered/);
  });

  it('allows duplicate with acknowledgement', () => {
    h.patients.create(h.admin, { name: 'John Doe', sex: 'male', phone: '01712345678' });
    const result = h.patients.create(h.admin, { name: 'John Doe', sex: 'male', phone: '01712345678' }, { acknowledgeDuplicate: true });
    expect(result.patient.id).toBeDefined();
    expect(result.duplicates.length).toBeGreaterThan(0);
  });

  it('lists patients with pagination', () => {
    for (let i = 0; i < 5; i++) {
      h.patients.create(h.admin, { name: `Patient ${i}`, sex: 'male' }, { acknowledgeDuplicate: true });
    }
    const page1 = h.patients.list({ limit: 2, offset: 0 });
    expect(page1.rows.length).toBe(2);
    expect(page1.total).toBe(5);

    const page2 = h.patients.list({ limit: 2, offset: 2 });
    expect(page2.rows.length).toBe(2);
    expect(page2.rows[0]!.id).not.toBe(page1.rows[0]!.id);
  });

  it('searches patients by name', () => {
    h.patients.create(h.admin, { name: 'Ayesha Rahman', sex: 'female' });
    h.patients.create(h.admin, { name: 'Karim Ahmed', sex: 'male' });

    const results = h.patients.list({ search: 'Ayesha', limit: 10, offset: 0 });
    expect(results.rows.length).toBe(1);
    expect(results.rows[0]!.name).toBe('Ayesha Rahman');
  });

  it('searches patients by Patient Code', () => {
    const p = h.patients.create(h.admin, { name: 'Test', sex: 'male' });
    const results = h.patients.list({ search: p.patient.patientCode, limit: 10, offset: 0 });
    expect(results.rows.length).toBe(1);
    expect(results.rows[0]!.patientCode).toBe(p.patient.patientCode);
  });

  it('archives and restores patient', () => {
    const p = h.patients.create(h.admin, { name: 'Test', sex: 'male' });
    h.patients.archive(h.admin, p.patient.id, 'Test archiving');
    const archived = h.patients.get(p.patient.id);
    expect(archived.archivedAt).not.toBeNull();

    const activeList = h.patients.list({ limit: 10, offset: 0 });
    expect(activeList.rows.find((r) => r.id === p.patient.id)).toBeUndefined();

    h.patients.restore(h.admin, p.patient.id);
    const restored = h.patients.get(p.patient.id);
    expect(restored.archivedAt).toBeNull();
  });

  it('computes lifetime summary', () => {
    const p = h.patients.create(h.admin, { name: 'Test', sex: 'male' });
    const summary = h.patients.summary(p.patient.id);
    expect(summary.lifetime.visitCount).toBe(0);
    expect(summary.lifetime.billedMinor).toBe(0);
  });

  it('validates required fields', () => {
    expect(() => h.patients.create(h.admin, { name: '', sex: 'male' } as any)).toThrow();
    expect(() => h.patients.create(h.admin, { name: 'A', sex: 'male' } as any)).toThrow();
  });

  it('rejects future date of birth', () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const futureKey = future.toISOString().slice(0, 10);
    expect(() => h.patients.create(h.admin, { name: 'Test', sex: 'male', dobKey: futureKey } as any)).toThrow();
  });
});
