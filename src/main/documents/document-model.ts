/**
 * Dentiva Pro — document semantic model.
 *
 * Preview, PDF and print all derive from the same semantic representation. There is no
 * preview-only content and no print-only unexpected content. This is what makes verification
 * possible: the same data drives every rendering path.
 */

export type DocumentKind = 'prescription' | 'invoice' | 'receipt' | 'statement';

export interface ClinicDocumentInfo {
  name: string;
  legalName?: string | null;
  tagline?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  district?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  alternatePhone?: string | null;
  email?: string | null;
  website?: string | null;
  registrationNo?: string | null;
  logoDataUrl?: string | null;
  footerNote?: string | null;
}

export interface PatientDocumentInfo {
  id: string;
  patientCode: string;
  name: string;
  sex: string;
  dobKey: string | null;
  ageLabel: string | null;
  phone: string | null;
  address: string | null;
}

export interface DentistDocumentInfo {
  id: string;
  name: string;
  credentials: string | null;
  designation: string | null;
  registrationNo: string | null;
  specialty: string | null;
  phone: string | null;
}

export interface PrescriptionMedicineDoc {
  orderIndex: number;
  name: string;
  form: string;
  strength: string | null;
  dose: string | null;
  frequency: string | null;
  duration: string | null;
  timing: string | null;
  foodRelation: string | null;
  route: string | null;
  customInstructions: string | null;
}

export interface PrescriptionClinicalDoc {
  key: string;
  label: string;
  detail: string;
  teeth: number[];
}

export interface PrescriptionDocument {
  kind: 'prescription';
  id: string;
  issuedAt: string;
  dateKey: string;
  clinic: ClinicDocumentInfo;
  dentist: DentistDocumentInfo | null;
  patient: PatientDocumentInfo;
  chiefComplaints: PrescriptionClinicalDoc[];
  onExamination: PrescriptionClinicalDoc[];
  radiologyExamination: string | null;
  advice: string | null;
  notes: string | null;
  medicines: PrescriptionMedicineDoc[];
}

export interface InvoiceLineDoc {
  orderIndex: number;
  description: string;
  toothNumber: number | null;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  grossMinor: number;
  netMinor: number;
}

export interface InvoiceDocument {
  kind: 'invoice';
  id: string;
  number: string;
  invoiceDate: string;
  dueDateKey: string | null;
  status: string;
  clinic: ClinicDocumentInfo;
  dentist: DentistDocumentInfo | null;
  patient: PatientDocumentInfo;
  lines: InvoiceLineDoc[];
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxPercent: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  notes: string | null;
}

export interface ReceiptDocument {
  kind: 'receipt';
  id: string;
  number: string;
  receiptDate: string;
  clinic: ClinicDocumentInfo;
  patient: PatientDocumentInfo;
  invoice: { id: string; number: string };
  payment: { id: string; amountMinor: number; method: string; reference: string | null; paidAt: string };
  remainingDueMinor: number;
  receivedBy: string | null;
  notes: string | null;
}

export interface StatementEntryDoc {
  occurredAt: string;
  kind: 'opening' | 'invoice' | 'payment' | 'refund' | 'adjustment';
  reference: string;
  deltaMinor: number;
  runningBalanceMinor: number;
}

export interface StatementDocument {
  kind: 'statement';
  patient: PatientDocumentInfo;
  fromKey: string | null;
  toKey: string | null;
  openingMinor: number;
  entries: StatementEntryDoc[];
  closingMinor: number;
  totalInvoicedMinor: number;
  totalPaidMinor: number;
  totalRefundedMinor: number;
  totalAdjustedMinor: number;
  clinic: ClinicDocumentInfo;
  generatedAt: string;
}

export type AnyDocument = PrescriptionDocument | InvoiceDocument | ReceiptDocument | StatementDocument;
