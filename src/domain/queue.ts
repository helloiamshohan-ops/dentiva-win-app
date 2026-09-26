/**
 * Dentiva Pro — queue / serial domain rules.
 *
 * A queue serial is a same-day operational token. It is *not* a Patient Code and must never be
 * confused with one: serials reset every clinic day and are reused across days, whereas Patient
 * Codes are permanent.
 *
 * Serial allocation is race-safe by construction: the counter is advanced with a single atomic
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement inside the creating transaction,
 * so two receptionists clicking at the same instant cannot receive the same serial.
 */

export const QUEUE_STATUSES = ['waiting', 'called', 'in_progress', 'completed', 'skipped', 'cancelled'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const QUEUE_STATUS_LABEL: Record<QueueStatus, string> = {
  waiting: 'Waiting',
  called: 'Called',
  in_progress: 'In progress',
  completed: 'Completed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

/** Statuses that mean the patient is still physically in the queue. */
export const ACTIVE_QUEUE_STATUSES: readonly QueueStatus[] = ['waiting', 'called', 'in_progress'];

export type QueueSerialScope = 'clinic' | 'dentist';

/**
 * Build the counter key for a queue date and scope.
 *
 * The key is what makes the daily reset explicit: a new clinic day simply means a new key, so
 * the previous day's counter is never mutated and its history stays intact.
 */
export function queueCounterKey(queueDateKey: string, scope: QueueSerialScope, dentistId: string | null): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(queueDateKey)) throw new Error(`Invalid queue date: ${queueDateKey}`);
  if (scope === 'dentist') {
    if (!dentistId) throw new Error('A dentist must be selected when the queue uses per-dentist serials.');
    return `${queueDateKey}|${dentistId}`;
  }
  return queueDateKey;
}

const QUEUE_TRANSITIONS: Record<QueueStatus, readonly QueueStatus[]> = {
  waiting: ['called', 'in_progress', 'completed', 'skipped', 'cancelled'],
  called: ['in_progress', 'completed', 'waiting', 'skipped', 'cancelled'],
  in_progress: ['completed', 'waiting', 'skipped', 'cancelled'],
  completed: [],
  skipped: ['waiting', 'called', 'cancelled'],
  cancelled: ['waiting'],
};

export function canTransitionQueue(from: QueueStatus, to: QueueStatus): boolean {
  if (from === to) return true;
  return QUEUE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Render a serial for display: `S-014`. Zero-padded so board sorting is visually correct. */
export function formatSerial(serial: number): string {
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error(`Invalid queue serial: ${serial}`);
  return `S-${String(serial).padStart(3, '0')}`;
}

/** Maximum serials per counter key per day. A technical safety bound, not a business limit. */
export const MAX_SERIALS_PER_DAY = 99_999;

/** Ordering used for the queue board: waiting first, then by serial. Deterministic. */
export function queueBoardOrder(a: { status: QueueStatus; serial: number }, b: { status: QueueStatus; serial: number }): number {
  const rank: Record<QueueStatus, number> = {
    in_progress: 0,
    called: 1,
    waiting: 2,
    skipped: 3,
    completed: 4,
    cancelled: 5,
  };
  const r = rank[a.status] - rank[b.status];
  if (r !== 0) return r;
  return a.serial - b.serial;
}

/** Count how long a patient has been waiting, in whole minutes. */
export function waitingMinutes(arrivedAtIso: string, nowIso: string): number {
  const arrived = Date.parse(arrivedAtIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(arrived) || Number.isNaN(now)) throw new Error('Invalid timestamp while calculating waiting time.');
  return Math.max(0, Math.floor((now - arrived) / 60_000));
}
