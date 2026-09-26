import { describe, it, expect } from 'vitest';
import { findConflicts, intervalsOverlap, canTransition, BLOCKING_STATUSES } from '../../src/domain/appointment';

describe('appointment domain', () => {
  it('detects interval overlap', () => {
    expect(intervalsOverlap(0, 10, 5, 15)).toBe(true);
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false); // half-open: [0,10) and [10,20) don't overlap
    expect(intervalsOverlap(0, 10, 11, 20)).toBe(false);
    expect(intervalsOverlap(5, 15, 0, 10)).toBe(true);
  });

  it('finds dentist conflicts', () => {
    const candidate = { startMs: 100, endMs: 200, dentistId: 'dnt_1', chairId: null, roomId: null, patientId: 'pat_1' };
    const existing = [
      { id: 'apt_1', startMs: 150, endMs: 250, status: 'scheduled' as const, dentistId: 'dnt_1', chairId: null, roomId: null, patientId: 'pat_2' },
    ];
    const conflicts = findConflicts(candidate, existing);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.resource).toBe('dentist');
  });

  it('ignores non-blocking statuses', () => {
    const candidate = { startMs: 100, endMs: 200, dentistId: 'dnt_1', chairId: null, roomId: null, patientId: 'pat_1' };
    const existing = [
      { id: 'apt_1', startMs: 150, endMs: 250, status: 'cancelled' as const, dentistId: 'dnt_1', chairId: null, roomId: null, patientId: 'pat_2' },
    ];
    const conflicts = findConflicts(candidate, existing);
    expect(conflicts.length).toBe(0);
  });

  it('allows same id to be excluded (rescheduling)', () => {
    const candidate = { id: 'apt_1', startMs: 100, endMs: 200, dentistId: 'dnt_1', chairId: null, roomId: null, patientId: 'pat_1' };
    const existing = [
      { id: 'apt_1', startMs: 100, endMs: 200, status: 'scheduled' as const, dentistId: 'dnt_1', chairId: null, roomId: null, patientId: 'pat_1' },
    ];
    const conflicts = findConflicts(candidate, existing);
    expect(conflicts.length).toBe(0);
  });

  it('validates status transitions', () => {
    expect(canTransition('scheduled', 'confirmed')).toBe(true);
    expect(canTransition('scheduled', 'completed')).toBe(true);
    expect(canTransition('completed', 'scheduled')).toBe(false);
    expect(canTransition('cancelled', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'scheduled')).toBe(true);
  });

  it('blocking statuses are correct', () => {
    expect(BLOCKING_STATUSES.includes('scheduled')).toBe(true);
    expect(BLOCKING_STATUSES.includes('confirmed')).toBe(true);
    expect(BLOCKING_STATUSES.includes('cancelled')).toBe(false);
    expect(BLOCKING_STATUSES.includes('completed')).toBe(false);
  });
});
