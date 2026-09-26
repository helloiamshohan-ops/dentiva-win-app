/**
 * Dentiva Pro — patient domain rules.
 *
 * Duplicate detection is advisory: it computes a score and the reasons behind it. Patients are
 * never merged automatically, because merging clinical records without clinician review is a
 * patient-safety hazard. The structured result is surfaced intact to the UI.
 */

export const SEXES = ['male', 'female', 'other', 'unspecified'] as const;
export type Sex = (typeof SEXES)[number];

export const SEX_LABEL: Record<Sex, string> = {
  male: 'Male',
  female: 'Female',
  other: 'Other',
  unspecified: 'Not specified',
};

/** Abbreviation used on clinical documents. */
export const SEX_ABBREVIATION: Record<Sex, string> = {
  male: 'M',
  female: 'F',
  other: 'O',
  unspecified: '—',
};

export const NAME_MAX_LENGTH = 150;
export const PHONE_MAX_LENGTH = 32;
export const EMAIL_MAX_LENGTH = 200;

/**
 * Normalise a phone number for duplicate matching.
 *
 * Bangladeshi numbers are commonly written as 01XXXXXXXXX, +8801XXXXXXXXX or 8801XXXXXXXXX.
 * All three refer to the same subscriber, so matching normalises to the local 11-digit form.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, '');
  if (digits === '') return null;
  if (digits.startsWith('880') && digits.length === 13) return `0${digits.slice(3)}`;
  if (digits.length === 10 && digits.startsWith('1')) return `0${digits}`;
  if (digits.length === 11 && digits.startsWith('01')) return digits;
  return digits;
}

/** Validate a phone number for entry (not for matching). */
export function isValidPhone(input: string | null | undefined): boolean {
  if (input === null || input === undefined || String(input).trim() === '') return true; // optional
  const normalized = normalizePhone(input);
  if (normalized === null) return false;
  if (normalized.length < 6 || normalized.length > 15) return false;
  if (normalized.startsWith('0')) return /^0\d{9,10}$/.test(normalized);
  return /^\d{6,15}$/.test(normalized);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(input: string | null | undefined): boolean {
  if (input === null || input === undefined || String(input).trim() === '') return true; // optional
  const value = String(input).trim();
  if (value.length > EMAIL_MAX_LENGTH) return false;
  return EMAIL_PATTERN.test(value);
}

/** Normalise a name for duplicate matching: case-folded, punctuation stripped, whitespace collapsed. */
export function normalizeName(input: string | null | undefined): string {
  if (!input) return '';
  return String(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,'"`\-_/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token set used for fuzzy name comparison. */
export function nameTokens(input: string): string[] {
  return normalizeName(input).split(' ').filter((t) => t.length > 1);
}

/** Jaccard similarity of two token sets, 0..1. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateCandidateInput {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  dobKey: string | null;
  patientCode: string;
}

export interface DuplicateSignal {
  /** 'search' is not a match signal; it reports that the candidate list was capped. */
  field: 'phone' | 'name' | 'dob' | 'email' | 'search';
  weight: number;
  description: string;
}

export interface DuplicateMatch {
  candidate: DuplicateCandidateInput;
  score: number;
  signals: DuplicateSignal[];
}

export const DUPLICATE_REVIEW_THRESHOLD = 60;
export const DUPLICATE_STRONG_THRESHOLD = 90;

/**
 * Score a candidate against the patient being saved.
 *
 * Weights are deliberately dominated by phone (the most reliable identifier in clinic practice),
 * then exact date of birth, then name similarity. Email is weak because it is often shared.
 */
export function scoreDuplicate(
  incoming: { name: string; phone: string | null; email: string | null; dobKey: string | null },
  candidate: DuplicateCandidateInput,
): DuplicateMatch {
  const signals: DuplicateSignal[] = [];

  const inPhone = normalizePhone(incoming.phone);
  const candPhone = normalizePhone(candidate.phone);
  if (inPhone !== null && candPhone !== null && inPhone === candPhone) {
    signals.push({ field: 'phone', weight: 55, description: `Same phone number (${candPhone})` });
  }

  if (incoming.dobKey && candidate.dobKey && incoming.dobKey === candidate.dobKey) {
    signals.push({ field: 'dob', weight: 25, description: `Same date of birth (${candidate.dobKey})` });
  }

  const nameSim = tokenSimilarity(incoming.name, candidate.name);
  if (nameSim >= 0.999) {
    signals.push({ field: 'name', weight: 30, description: 'Identical name' });
  } else if (nameSim >= 0.5) {
    signals.push({ field: 'name', weight: Math.round(nameSim * 25), description: `Similar name (${Math.round(nameSim * 100)}% match)` });
  }

  const inEmail = (incoming.email ?? '').trim().toLowerCase();
  const candEmail = (candidate.email ?? '').trim().toLowerCase();
  if (inEmail !== '' && candEmail !== '' && inEmail === candEmail) {
    signals.push({ field: 'email', weight: 15, description: `Same email address (${candEmail})` });
  }

  const score = Math.min(100, signals.reduce((acc, s) => acc + s.weight, 0));
  return { candidate, score, signals };
}

/** Rank candidates above the review threshold, strongest first. Deterministic. */
export function rankDuplicates(
  incoming: { name: string; phone: string | null; email: string | null; dobKey: string | null },
  candidates: DuplicateCandidateInput[],
): DuplicateMatch[] {
  return candidates
    .map((c) => scoreDuplicate(incoming, c))
    .filter((m) => m.score >= DUPLICATE_REVIEW_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.candidate.patientCode.localeCompare(b.candidate.patientCode));
}

export function duplicateSeverity(score: number): 'strong' | 'possible' | 'none' {
  if (score >= DUPLICATE_STRONG_THRESHOLD) return 'strong';
  if (score >= DUPLICATE_REVIEW_THRESHOLD) return 'possible';
  return 'none';
}

/** Validate a patient name for entry. */
export function validateName(input: unknown, field = 'name'): string {
  if (typeof input !== 'string') throw new Error(`${field} must be text.`);
  const value = input.trim().replace(/\s+/g, ' ');
  if (value === '') throw new Error(`${field} is required.`);
  if (value.length < 2) throw new Error(`${field} must be at least 2 characters.`);
  if (value.length > NAME_MAX_LENGTH) throw new Error(`${field} must be ${NAME_MAX_LENGTH} characters or fewer.`);
  return value;
}

/**
 * Validate a date of birth.
 *
 * A future date of birth is rejected: it would produce a negative age and corrupt every
 * age-based clinical display and report.
 */
export function validateDateOfBirth(dobKey: string | null, todayKey: string): string | null {
  if (dobKey === null || dobKey === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobKey)) throw new Error('Date of birth must be in YYYY-MM-DD format.');
  if (dobKey > todayKey) throw new Error('Date of birth cannot be in the future.');
  const year = Number(dobKey.slice(0, 4));
  if (year < 1900) throw new Error('Date of birth is before 1900, which is not supported.');
  return dobKey;
}
