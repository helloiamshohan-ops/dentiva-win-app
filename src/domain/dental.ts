/**
 * Dentiva Pro — dental chart domain model (FDI two-digit notation).
 *
 * FDI quadrants:
 *   Permanent — 1 upper right, 2 upper left, 3 lower left, 4 lower right (teeth 1–8)
 *   Primary   — 5 upper right, 6 upper left, 7 lower left, 8 lower right (teeth 1–5)
 *
 * The chart never communicates state by colour alone: every state also carries a text label and
 * a distinct glyph, so it remains readable in monochrome printing and for colour-blind users.
 */

export const TOOTH_SURFACES = ['mesial', 'distal', 'occlusal', 'buccal', 'palatal'] as const;
export type ToothSurface = (typeof TOOTH_SURFACES)[number];

export const SURFACE_LABEL: Record<ToothSurface, string> = {
  mesial: 'Mesial',
  distal: 'Distal',
  occlusal: 'Occlusal',
  buccal: 'Buccal',
  palatal: 'Palatal',
};

export const TOOTH_STATES = [
  'sound',
  'caries',
  'filled',
  'missing',
  'extracted',
  'root_canal',
  'crown',
  'implant',
  'impacted',
  'fractured',
  'mobile',
  'bridge_pontic',
  'watch',
] as const;
export type ToothState = (typeof TOOTH_STATES)[number];

/** Short glyph shown on the chart in addition to colour, so state is never colour-only. */
export const TOOTH_STATE_LABEL: Record<ToothState, string> = {
  sound: 'Sound',
  caries: 'Caries',
  filled: 'Filled',
  missing: 'Missing',
  extracted: 'Extracted',
  root_canal: 'Root canal',
  crown: 'Crown',
  implant: 'Implant',
  impacted: 'Impacted',
  fractured: 'Fractured',
  mobile: 'Mobile',
  bridge_pontic: 'Bridge pontic',
  watch: 'Watch',
};

export const TOOTH_STATE_GLYPH: Record<ToothState, string> = {
  sound: '',
  caries: 'C',
  filled: 'F',
  missing: 'X',
  extracted: 'E',
  root_canal: 'R',
  crown: 'W',
  implant: 'I',
  impacted: 'M',
  fractured: '/',
  mobile: '~',
  bridge_pontic: 'B',
  watch: '?',
};

export type Dentition = 'permanent' | 'primary';

export interface ToothDefinition {
  /** FDI number, e.g. 16 or 64. */
  number: number;
  quadrant: number;
  position: number;
  dentition: Dentition;
  arch: 'upper' | 'lower';
  side: 'right' | 'left';
  /** Conventional name, e.g. "Upper right first molar". */
  name: string;
  /** Universal (US) number equivalent where one exists, else null. */
  universal: number | null;
}

const PERMANENT_NAMES: Record<number, string> = {
  1: 'central incisor',
  2: 'lateral incisor',
  3: 'canine',
  4: 'first premolar',
  5: 'second premolar',
  6: 'first molar',
  7: 'second molar',
  8: 'third molar',
};

const PRIMARY_NAMES: Record<number, string> = {
  1: 'central incisor',
  2: 'lateral incisor',
  3: 'canine',
  4: 'first molar',
  5: 'second molar',
};

const QUADRANT_META: Record<number, { dentition: Dentition; arch: 'upper' | 'lower'; side: 'right' | 'left' }> = {
  1: { dentition: 'permanent', arch: 'upper', side: 'right' },
  2: { dentition: 'permanent', arch: 'upper', side: 'left' },
  3: { dentition: 'permanent', arch: 'lower', side: 'left' },
  4: { dentition: 'permanent', arch: 'lower', side: 'right' },
  5: { dentition: 'primary', arch: 'upper', side: 'right' },
  6: { dentition: 'primary', arch: 'upper', side: 'left' },
  7: { dentition: 'primary', arch: 'lower', side: 'left' },
  8: { dentition: 'primary', arch: 'lower', side: 'right' },
};

/** Universal numbering for permanent teeth, keyed by FDI number. */
const UNIVERSAL_MAP: Record<number, number> = {
  18: 1, 17: 2, 16: 3, 15: 4, 14: 5, 13: 6, 12: 7, 11: 8,
  21: 9, 22: 10, 23: 11, 24: 12, 25: 13, 26: 14, 27: 15, 28: 16,
  38: 17, 37: 18, 36: 19, 35: 20, 34: 21, 33: 22, 32: 23, 31: 24,
  41: 25, 42: 26, 43: 27, 44: 28, 45: 29, 46: 30, 47: 31, 48: 32,
};

function buildTeeth(): ToothDefinition[] {
  const teeth: ToothDefinition[] = [];
  for (const [quadrantStr, meta] of Object.entries(QUADRANT_META)) {
    const quadrant = Number(quadrantStr);
    const count = meta.dentition === 'permanent' ? 8 : 5;
    const names = meta.dentition === 'permanent' ? PERMANENT_NAMES : PRIMARY_NAMES;
    const archLabel = meta.arch === 'upper' ? 'Upper' : 'Lower';
    const sideLabel = meta.side === 'right' ? 'right' : 'left';
    for (let position = 1; position <= count; position += 1) {
      const number = quadrant * 10 + position;
      teeth.push({
        number,
        quadrant,
        position,
        dentition: meta.dentition,
        arch: meta.arch,
        side: meta.side,
        name: `${archLabel} ${sideLabel} ${names[position] ?? 'tooth'}`,
        universal: UNIVERSAL_MAP[number] ?? null,
      });
    }
  }
  return teeth;
}

export const ALL_TEETH: readonly ToothDefinition[] = Object.freeze(buildTeeth());
export const PERMANENT_TEETH = ALL_TEETH.filter((t) => t.dentition === 'permanent');
export const PRIMARY_TEETH = ALL_TEETH.filter((t) => t.dentition === 'primary');

const BY_NUMBER = new Map<number, ToothDefinition>(ALL_TEETH.map((t) => [t.number, t]));

export function isToothNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && BY_NUMBER.has(value);
}

export function getTooth(number: number): ToothDefinition | null {
  return BY_NUMBER.get(number) ?? null;
}

/** Human-readable label for an FDI number, e.g. "16 — Upper right first molar". */
export function toothLabel(number: number): string {
  const tooth = getTooth(number);
  if (!tooth) return `Tooth ${number}`;
  return `${tooth.number} — ${tooth.name}`;
}

/**
 * Parse a free-text tooth reference into validated FDI numbers.
 * Accepts "16", "16,17", "16-18", "FDI 16". Unknown tokens are reported rather than dropped,
 * because silently discarding a tooth reference in a clinical record is a safety problem.
 */
export function parseToothReferences(input: string): { numbers: number[]; rejected: string[] } {
  const numbers: number[] = [];
  const rejected: string[] = [];
  const tokens = input
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
  for (const token of tokens) {
    const cleaned = token.replace(/^(fdi|tooth)\s*/i, '');
    const range = /^(\d{1,2})\s*[-–]\s*(\d{1,2})$/.exec(cleaned);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to - from > 40) {
        rejected.push(token);
        continue;
      }
      for (let n = from; n <= to; n += 1) {
        if (isToothNumber(n)) numbers.push(n);
        else rejected.push(String(n));
      }
      continue;
    }
    const single = /^\d{1,2}$/.exec(cleaned);
    if (single) {
      const n = Number(cleaned);
      if (isToothNumber(n)) numbers.push(n);
      else rejected.push(token);
      continue;
    }
    rejected.push(token);
  }
  // Deterministic, duplicate-free ordering.
  return { numbers: [...new Set(numbers)].sort((a, b) => a - b), rejected: [...new Set(rejected)] };
}

/** Group teeth into upper/lower rows for chart rendering, ordered for a clinician-facing view. */
export function chartRows(dentition: Dentition): { upper: ToothDefinition[]; lower: ToothDefinition[] } {
  const set = dentition === 'permanent' ? PERMANENT_TEETH : PRIMARY_TEETH;
  // Upper: quadrant 2 left-to-right then quadrant 1 (clinician view), Lower: quadrant 4 then 3.
  const upperQuads = dentition === 'permanent' ? [2, 1] : [6, 5];
  const lowerQuads = dentition === 'permanent' ? [4, 3] : [8, 7];
  const byQuad = (q: number) =>
    set
      .filter((t) => t.quadrant === q)
      .sort((a, b) => (upperQuads.includes(q) || lowerQuads.includes(q) ? b.position - a.position : a.position - b.position));
  return {
    upper: [...byQuad(upperQuads[0] as number), ...byQuad(upperQuads[1] as number)],
    lower: [...byQuad(lowerQuads[0] as number), ...byQuad(lowerQuads[1] as number)],
  };
}

export interface ToothConditionInput {
  toothNumber: number;
  state: ToothState;
  surfaces?: ToothSurface[];
  note?: string;
}

/** Validate a chart entry. Unknown teeth or states are rejected, never coerced. */
export function validateToothCondition(input: ToothConditionInput): ToothConditionInput {
  if (!isToothNumber(input.toothNumber)) {
    throw new Error(`Unknown tooth number: ${String(input.toothNumber)}`);
  }
  if (!(TOOTH_STATES as readonly string[]).includes(input.state)) {
    throw new Error(`Unknown tooth state: ${String(input.state)}`);
  }
  const surfaces = input.surfaces ?? [];
  for (const s of surfaces) {
    if (!(TOOTH_SURFACES as readonly string[]).includes(s)) {
      throw new Error(`Unknown tooth surface: ${String(s)}`);
    }
  }
  const note = (input.note ?? '').trim();
  if (note.length > 500) throw new Error('Tooth note exceeds 500 characters.');
  return {
    toothNumber: input.toothNumber,
    state: input.state,
    surfaces: [...new Set(surfaces)],
    ...(note === '' ? {} : { note }),
  };
}
