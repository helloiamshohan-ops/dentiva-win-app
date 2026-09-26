/**
 * Dentiva Pro — appointment domain rules.
 *
 * Conflict detection is resource-aware: two appointments clash when their time intervals
 * overlap *and* they share a booked resource (dentist, chair or room).
 *
 * This module holds the rule. Enforcement happens in two places, both required:
 *   1. the service layer, inside a transaction, so a race cannot slip through;
 *   2. a partial unique index at the database layer as the final backstop.
 * UI-only checking is explicitly not sufficient.
 */

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  arrived: 'Arrived',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No show',
  rescheduled: 'Rescheduled',
};

/** Statuses that still occupy a resource and therefore participate in conflict detection. */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'arrived',
  'in_progress',
];

export function isBlockingStatus(status: AppointmentStatus): boolean {
  return BLOCKING_STATUSES.includes(status);
}

export const DEFAULT_DURATION_MINUTES = 30;
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 480;

export interface AppointmentInterval {
  id: string;
  /** Epoch milliseconds, UTC. */
  startMs: number;
  endMs: number;
  status: AppointmentStatus;
  dentistId: string | null;
  chairId: string | null;
  roomId: string | null;
  patientId: string;
  patientName?: string;
  patientCode?: string;
}

export type ConflictResource = 'dentist' | 'chair' | 'room';

export interface AppointmentConflict {
  resource: ConflictResource;
  resourceId: string;
  conflictingAppointmentId: string;
  conflictingStartMs: number;
  conflictingEndMs: number;
  patientName?: string;
  patientCode?: string;
}

/** Half-open interval overlap: [aStart, aEnd) vs [bStart, bEnd). */
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function validateDuration(minutes: unknown): number {
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes)) {
    throw new Error('Duration must be a whole number of minutes.');
  }
  if (minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
    throw new Error(`Duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`);
  }
  return minutes;
}

/**
 * Find every resource conflict for a candidate appointment against an existing set.
 *
 * `existing` must already be filtered to blocking statuses by the caller; this function also
 * re-checks, so an accidental caller mistake cannot silently weaken the rule.
 */
export function findConflicts(
  candidate: Omit<AppointmentInterval, 'id' | 'status'> & { id?: string; status?: AppointmentStatus },
  existing: AppointmentInterval[],
): AppointmentConflict[] {
  const candidateStatus = candidate.status ?? 'scheduled';
  if (!isBlockingStatus(candidateStatus)) return [];

  const conflicts: AppointmentConflict[] = [];
  for (const other of existing) {
    if (!isBlockingStatus(other.status)) continue;
    if (candidate.id !== undefined && other.id === candidate.id) continue;
    if (!intervalsOverlap(candidate.startMs, candidate.endMs, other.startMs, other.endMs)) continue;

    if (candidate.dentistId !== null && other.dentistId === candidate.dentistId) {
      conflicts.push(describe('dentist', candidate.dentistId, other));
    }
    if (candidate.chairId !== null && other.chairId === candidate.chairId) {
      conflicts.push(describe('chair', candidate.chairId, other));
    }
    if (candidate.roomId !== null && other.roomId === candidate.roomId) {
      conflicts.push(describe('room', candidate.roomId, other));
    }
  }
  // Deterministic ordering so the same input always produces the same conflict list.
  return conflicts.sort((a, b) =>
    a.resource === b.resource
      ? a.conflictingStartMs - b.conflictingStartMs || a.conflictingAppointmentId.localeCompare(b.conflictingAppointmentId)
      : a.resource.localeCompare(b.resource),
  );
}

function describe(resource: ConflictResource, resourceId: string, other: AppointmentInterval): AppointmentConflict {
  return {
    resource,
    resourceId,
    conflictingAppointmentId: other.id,
    conflictingStartMs: other.startMs,
    conflictingEndMs: other.endMs,
    ...(other.patientName !== undefined ? { patientName: other.patientName } : {}),
    ...(other.patientCode !== undefined ? { patientCode: other.patientCode } : {}),
  };
}

/** Human-readable explanation of a conflict set, used in the confirmation dialog. */
export function describeConflicts(conflicts: AppointmentConflict[], resourceNames: Record<string, string> = {}): string {
  if (conflicts.length === 0) return '';
  const parts = conflicts.map((c) => {
    const label = resourceNames[c.resourceId] ?? c.resourceId;
    const kind = c.resource === 'dentist' ? 'Dentist' : c.resource === 'chair' ? 'Chair' : 'Room';
    const who = c.patientName ? ` with ${c.patientName}` : '';
    return `${kind} ${label} is already booked${who}`;
  });
  return [...new Set(parts)].join('; ');
}

/** Allowed status transitions. Explicit so a workflow cannot skip a state by accident. */
const ALLOWED_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  scheduled: ['confirmed', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled'],
  confirmed: ['arrived', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled'],
  arrived: ['in_progress', 'completed', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: ['scheduled'],
  no_show: ['scheduled'],
  rescheduled: ['scheduled', 'confirmed', 'cancelled'],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Slot grid for a day view. Produces deterministic, evenly spaced slot start times. */
export function daySlots(dayStartMs: number, dayEndMs: number, slotMinutes: number): number[] {
  if (dayEndMs <= dayStartMs) return [];
  const step = validateDuration(slotMinutes) * 60_000;
  const slots: number[] = [];
  for (let t = dayStartMs; t + step <= dayEndMs; t += step) slots.push(t);
  return slots;
}
