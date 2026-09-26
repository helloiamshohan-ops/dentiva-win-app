/**
 * Dentiva Pro — prescription clinical vocabulary.
 *
 * The chief-complaint (C/C) and on-examination (O/E) catalogues are defined once, here, and are
 * used by the prescription form, by persistence and by the printed document. That guarantees the
 * printed prescription can never show a heading the form did not capture, or vice versa.
 *
 * These are recording categories for clinician-entered findings. Dentiva Pro does not diagnose
 * and does not suggest findings: an entry appears on the document only if the clinician recorded
 * it.
 */

export interface ClinicalCheckOption {
  /** Stable key persisted with the prescription. */
  key: string;
  /** Label printed on the document and shown in the form. */
  label: string;
  /** Short form used in the compact C/C line. */
  abbreviation?: string;
}

export const CHIEF_COMPLAINT_OPTIONS: readonly ClinicalCheckOption[] = [
  { key: 'pain_on', label: 'Pain On', abbreviation: 'Pain On' },
  { key: 'g_carries', label: 'G. Carries', abbreviation: 'G. Carries' },
  { key: 'swelling', label: 'Swelling', abbreviation: 'Swelling' },
  { key: 'gum_bleeding', label: 'Gum Bleeding', abbreviation: 'Gum Bleeding' },
  { key: 'bad_breath', label: 'Bad Breath', abbreviation: 'Bad Breath' },
  { key: 'sensitivity', label: 'Sensitivity', abbreviation: 'Sensitivity' },
] as const;

export const ON_EXAMINATION_OPTIONS: readonly ClinicalCheckOption[] = [
  { key: 'carries_g_carries', label: 'Carries / G Carries', abbreviation: 'Carries / G Carries' },
  { key: 'bdr_bdc', label: 'BDR / BDC', abbreviation: 'BDR / BDC' },
  { key: 'gingivitis', label: 'Gingivitis', abbreviation: 'Gingivitis' },
  { key: 'parodental_pocket', label: 'Parodental Pocket', abbreviation: 'Parodental Pocket' },
  { key: 'perio_dontitis', label: 'Perio Dontitis', abbreviation: 'Perio Dontitis' },
  { key: 'impected_teeth', label: 'Impected Teeth', abbreviation: 'Impected Teeth' },
  { key: 'dry_socket', label: 'Dry Socket', abbreviation: 'Dry Socket' },
  { key: 'attrition_erosion', label: 'Attrition / Erosion', abbreviation: 'Attrition / Erosion' },
] as const;

/**
 * A recorded finding: the catalogue key plus optional clinician detail and the tooth references
 * it applies to. Detail is free text; the catalogue key keeps the document structured.
 */
export interface ClinicalFinding {
  key: string;
  /** Clinician-entered detail, e.g. "lower right first molar, spontaneous at night". */
  detail: string;
  /** FDI tooth numbers this finding applies to. */
  teeth: number[];
}

export type ClinicalSection = 'chiefComplaints' | 'onExamination';

export function optionsFor(section: ClinicalSection): readonly ClinicalCheckOption[] {
  return section === 'chiefComplaints' ? CHIEF_COMPLAINT_OPTIONS : ON_EXAMINATION_OPTIONS;
}

export function isValidKey(section: ClinicalSection, key: unknown): boolean {
  if (typeof key !== 'string') return false;
  return optionsFor(section).some((option) => option.key === key);
}

export function labelFor(section: ClinicalSection, key: string): string {
  return optionsFor(section).find((option) => option.key === key)?.label ?? key;
}

// ── Medicines ───────────────────────────────────────────────────────────────────────────────

export const MEDICINE_FORMS = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'cream',
  'gel',
  'ointment',
  'drops',
  'mouthwash',
  'injection',
  'spray',
  'custom',
] as const;
export type MedicineForm = (typeof MEDICINE_FORMS)[number];

export const MEDICINE_FORM_LABEL: Record<MedicineForm, string> = {
  tablet: 'Tab.',
  capsule: 'Cap.',
  syrup: 'Syrup',
  suspension: 'Susp.',
  cream: 'Cream',
  gel: 'Gel',
  ointment: 'Oint.',
  drops: 'Drops',
  mouthwash: 'Mouthwash',
  injection: 'Inj.',
  spray: 'Spray',
  custom: '',
};

export const FOOD_RELATIONS = ['before_food', 'after_food', 'with_food', 'any', 'empty_stomach'] as const;
export type FoodRelation = (typeof FOOD_RELATIONS)[number];

export const FOOD_RELATION_LABEL: Record<FoodRelation, string> = {
  before_food: 'Before food',
  after_food: 'After food',
  with_food: 'With food',
  any: 'Any time',
  empty_stomach: 'On an empty stomach',
};

export const TIMINGS = ['morning', 'noon', 'evening', 'night', 'bedtime', 'as_needed'] as const;
export type MedicineTiming = (typeof TIMINGS)[number];

export const TIMING_LABEL: Record<MedicineTiming, string> = {
  morning: 'Morning',
  noon: 'Noon',
  evening: 'Evening',
  night: 'Night',
  bedtime: 'At bedtime',
  as_needed: 'As needed',
};

export interface MedicineInput {
  name: string;
  form: MedicineForm;
  /** Free text when `form` is `custom`. */
  customForm?: string | null;
  strength?: string | null;
  dose?: string | null;
  frequency?: string | null;
  duration?: string | null;
  timing?: string | null;
  foodRelation?: FoodRelation | null;
  route?: string | null;
  customInstructions?: string | null;
  notes?: string | null;
}

export const MEDICINE_NAME_MAX = 150;
export const MEDICINE_TEXT_MAX = 200;
export const ADVICE_MAX = 2000;

/** Commonly prescribed dental medicines, offered as suggestions. Purely a convenience. */
export const COMMON_MEDICINES: readonly { name: string; form: MedicineForm; strength: string }[] = [
  { name: 'Paracetamol', form: 'tablet', strength: '500 mg' },
  { name: 'Ibuprofen', form: 'tablet', strength: '400 mg' },
  { name: 'Aceclofenac', form: 'tablet', strength: '100 mg' },
  { name: 'Amoxicillin', form: 'capsule', strength: '500 mg' },
  { name: 'Metronidazole', form: 'tablet', strength: '400 mg' },
  { name: 'Clindamycin', form: 'capsule', strength: '300 mg' },
  { name: 'Chlorhexidine', form: 'mouthwash', strength: '0.2%' },
  { name: 'Omeprazole', form: 'capsule', strength: '20 mg' },
] as const;
