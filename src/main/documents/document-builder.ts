/**
 * Dentiva Pro — document builder.
 *
 * Transforms persisted records into the semantic document model. Every field that appears on a
 * document is sourced from here, so preview and PDF cannot diverge.
 */

import { ageLabel as calcAgeLabel, todayKey, partsInTimeZone } from '../../shared/dates';
import { CHIEF_COMPLAINT_OPTIONS, ON_EXAMINATION_OPTIONS } from '../../domain/prescription';
import type { Database } from '../db/sqlite';
import { Errors } from '../../shared/errors';
import { int, str, strOrNull, json } from '../repositories/row';
import type {
  ClinicDocumentInfo,
  PatientDocumentInfo,
  DentistDocumentInfo,
  PrescriptionDocument,
  PrescriptionMedicineDoc,
  PrescriptionClinicalDoc,
  InvoiceDocument,
  InvoiceLineDoc,
  ReceiptDocument,
  StatementDocument,
  StatementEntryDoc,
} from './document-model';
import type { ClinicalFinding, MedicineInput } from '../../domain/prescription';
import { computeOutstanding } from '../../domain/financial';

export class DocumentBuilder {
  constructor(private readonly db: Database, private readonly timeZone: () => string, private readonly clinicLogoDataUrl: () => string | null) {}

  private getClinic(): ClinicDocumentInfo {
    const row = this.db.get('SELECT * FROM clinic ORDER BY id LIMIT 1');
    if (!row) throw Errors.notFound('clinic configuration');
    return {
      name: String(row.name || ''),
      legalName: row.legal_name ? String(row.legal_name) : null,
      tagline: row.tagline ? String(row.tagline) : null,
      addressLine1: row.address_line1 ? String(row.address_line1) : null,
      addressLine2: row.address_line2 ? String(row.address_line2) : null,
      city: row.city ? String(row.city) : null,
      district: row.district ? String(row.district) : null,
      postalCode: row.postal_code ? String(row.postal_code) : null,
      country: row.country ? String(row.country) : null,
      phone: row.phone ? String(row.phone) : null,
      alternatePhone: row.alternate_phone ? String(row.alternate_phone) : null,
      email: row.email ? String(row.email) : null,
      website: row.website ? String(row.website) : null,
      registrationNo: row.registration_no ? String(row.registration_no) : null,
      logoDataUrl: this.clinicLogoDataUrl(),
      footerNote: row.footer_note ? String(row.footer_note) : null,
    };
  }

  private getPatient(patientId: string): PatientDocumentInfo {
    const row = this.db.get('SELECT id, patient_code AS patientCode, name, sex, dob_key AS dobKey, phone, address FROM patients WHERE id = ?', patientId);
    if (!row) throw Errors.notFound('patient');
    const dobKey = strOrNull(row, 'dobKey');
    const tz = this.timeZone();
    const today = todayKey(tz);
    const age = dobKey ? calcAgeLabel(dobKey, today) : null;
    return {
      id: str(row, 'id'),
      patientCode: str(row, 'patientCode'),
      name: str(row, 'name'),
      sex: str(row, 'sex'),
      dobKey,
      ageLabel: age?.text ?? null,
      phone: strOrNull(row, 'phone'),
      address: strOrNull(row, 'address'),
    };
  }

  private getDentist(dentistId: string | null): DentistDocumentInfo | null {
    if (!dentistId) return null;
    const row = this.db.get('SELECT id, name, credentials, designation, registration_no AS registrationNo, specialty, phone FROM dentists WHERE id = ?', dentistId);
    if (!row) return null;
    return {
      id: str(row, 'id'),
      name: str(row, 'name'),
      credentials: strOrNull(row, 'credentials'),
      designation: strOrNull(row, 'designation'),
      registrationNo: strOrNull(row, 'registrationNo'),
      specialty: strOrNull(row, 'specialty'),
      phone: strOrNull(row, 'phone'),
    };
  }

  buildPrescription(prescriptionId: string): PrescriptionDocument {
    const rxRow = this.db.get(
      `SELECT rx.id, rx.patient_id AS patientId, rx.dentist_id AS dentistId, rx.issued_at AS issuedAt,
              rx.chief_complaints AS chiefComplaints, rx.on_examination AS onExamination,
              rx.radiology_examination AS radiologyExamination, rx.advice, rx.notes
         FROM prescriptions rx WHERE rx.id = ?`,
      prescriptionId,
    );
    if (!rxRow) throw Errors.notFound('prescription');

    const clinic = this.getClinic();
    const patient = this.getPatient(str(rxRow, 'patientId'));
    const dentist = this.getDentist(strOrNull(rxRow, 'dentistId'));
    const issuedAt = str(rxRow, 'issuedAt');
    const tz = this.timeZone();
    const parts = partsInTimeZone(issuedAt, tz);
    const dateKey = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;

    const chiefComplaintsRaw = json<ClinicalFinding[]>(rxRow, 'chiefComplaints', []);
    const onExaminationRaw = json<ClinicalFinding[]>(rxRow, 'onExamination', []);

    const mapClinical = (findings: ClinicalFinding[], options: readonly { key: string; label: string }[]): PrescriptionClinicalDoc[] =>
      findings.map((f) => ({
        key: f.key,
        label: options.find((o) => o.key === f.key)?.label ?? f.key,
        detail: f.detail ?? '',
        teeth: f.teeth ?? [],
      }));

    const medicines = this.db
      .all(
        `SELECT order_index AS orderIndex, name, form, strength, dose, frequency, duration, timing,
                food_relation AS foodRelation, route, custom_instructions AS customInstructions
           FROM prescription_medicines WHERE prescription_id = ? ORDER BY order_index`,
        prescriptionId,
      )
      .map((r) => ({
        orderIndex: int(r, 'orderIndex'),
        name: str(r, 'name'),
        form: str(r, 'form'),
        strength: strOrNull(r, 'strength'),
        dose: strOrNull(r, 'dose'),
        frequency: strOrNull(r, 'frequency'),
        duration: strOrNull(r, 'duration'),
        timing: strOrNull(r, 'timing'),
        foodRelation: strOrNull(r, 'foodRelation'),
        route: strOrNull(r, 'route'),
        customInstructions: strOrNull(r, 'customInstructions'),
      }));

    return {
      kind: 'prescription',
      id: str(rxRow, 'id'),
      issuedAt,
      dateKey,
      clinic,
      dentist,
      patient,
      chiefComplaints: mapClinical(chiefComplaintsRaw, CHIEF_COMPLAINT_OPTIONS),
      onExamination: mapClinical(onExaminationRaw, ON_EXAMINATION_OPTIONS),
      radiologyExamination: strOrNull(rxRow, 'radiologyExamination'),
      advice: strOrNull(rxRow, 'advice'),
      notes: strOrNull(rxRow, 'notes'),
      medicines,
    };
  }

  buildInvoice(invoiceId: string): InvoiceDocument {
    const row = this.db.get(
      `SELECT i.id, i.number, i.patient_id AS patientId, i.dentist_id AS dentistId,
              i.invoice_date AS invoiceDate, i.due_date_key AS dueDateKey, i.status,
              i.subtotal_minor AS subtotalMinor, i.discount_minor AS discountMinor,
              i.taxable_minor AS taxableMinor, i.tax_percent AS taxPercent, i.tax_minor AS taxMinor,
              i.total_minor AS totalMinor, i.paid_minor AS paidMinor, i.refunded_minor AS refundedMinor,
              i.adjusted_minor AS adjustedMinor, i.notes
         FROM invoices i WHERE i.id = ?`,
      invoiceId,
    );
    if (!row) throw Errors.notFound('invoice');

    const clinic = this.getClinic();
    const patient = this.getPatient(str(row, 'patientId'));
    const dentist = this.getDentist(strOrNull(row, 'dentistId'));

    const lines = this.db
      .all(
        `SELECT order_index AS orderIndex, description, tooth_number AS toothNumber, quantity,
                unit_price_minor AS unitPriceMinor, discount_minor AS discountMinor,
                gross_minor AS grossMinor, net_minor AS netMinor
           FROM invoice_items WHERE invoice_id = ? ORDER BY order_index`,
        invoiceId,
      )
      .map((r) => ({
        orderIndex: int(r, 'orderIndex'),
        description: str(r, 'description'),
        toothNumber: r.toothNumber === null || r.toothNumber === undefined ? null : int(r, 'toothNumber'),
        quantity: int(r, 'quantity'),
        unitPriceMinor: int(r, 'unitPriceMinor'),
        discountMinor: int(r, 'discountMinor'),
        grossMinor: int(r, 'grossMinor'),
        netMinor: int(r, 'netMinor'),
      }));

    const totalMinor = int(row, 'totalMinor');
    const paidMinor = int(row, 'paidMinor');
    const refundedMinor = int(row, 'refundedMinor');
    const adjustedMinor = int(row, 'adjustedMinor');

    return {
      kind: 'invoice',
      id: str(row, 'id'),
      number: str(row, 'number'),
      invoiceDate: str(row, 'invoiceDate'),
      dueDateKey: strOrNull(row, 'dueDateKey'),
      status: str(row, 'status'),
      clinic,
      dentist,
      patient,
      lines,
      subtotalMinor: int(row, 'subtotalMinor'),
      discountMinor: int(row, 'discountMinor'),
      taxableMinor: int(row, 'taxableMinor'),
      taxPercent: Number(row.taxPercent ?? 0),
      taxMinor: int(row, 'taxMinor'),
      totalMinor,
      paidMinor,
      outstandingMinor: computeOutstanding({ totalMinor, paidMinor, refundedMinor, adjustmentMinor: adjustedMinor }),
      notes: strOrNull(row, 'notes'),
    };
  }

  buildReceipt(receiptId: string): ReceiptDocument {
    const row = this.db.get(
      `SELECT r.id, r.number, r.receipt_date AS receiptDate, r.patient_id AS patientId,
              r.invoice_id AS invoiceId, i.number AS invoiceNumber, r.payment_id AS paymentId,
              r.amount_minor AS amountMinor, r.method, r.reference, r.remaining_due_minor AS remainingDueMinor,
              r.received_by AS receivedBy, u.display_name AS receivedByName, r.notes,
              pm.paid_at AS paidAt
         FROM receipts r JOIN invoices i ON i.id = r.invoice_id JOIN payments pm ON pm.id = r.payment_id
         LEFT JOIN users u ON u.id = r.received_by WHERE r.id = ?`,
      receiptId,
    );
    if (!row) throw Errors.notFound('receipt');

    const clinic = this.getClinic();
    const patient = this.getPatient(str(row, 'patientId'));

    return {
      kind: 'receipt',
      id: str(row, 'id'),
      number: str(row, 'number'),
      receiptDate: str(row, 'receiptDate'),
      clinic,
      patient,
      invoice: { id: str(row, 'invoiceId'), number: str(row, 'invoiceNumber') },
      payment: {
        id: str(row, 'paymentId'),
        amountMinor: int(row, 'amountMinor'),
        method: str(row, 'method'),
        reference: strOrNull(row, 'reference'),
        paidAt: str(row, 'paidAt'),
      },
      remainingDueMinor: int(row, 'remainingDueMinor'),
      receivedBy: strOrNull(row, 'receivedByName') ?? (strOrNull(row, 'receivedBy') ? 'Staff' : null),
      notes: strOrNull(row, 'notes'),
    };
  }

  buildStatement(patientId: string, fromKey: string | null, toKey: string | null): StatementDocument {
    const clinic = this.getClinic();
    const patient = this.getPatient(patientId);

    // Reuse financial service logic via direct queries for document builder independence
    const entries: StatementEntryDoc[] = [];
    const tz = this.timeZone();

    // We need to compute opening balance if fromKey is set
    let openingMinor = 0;
    if (fromKey) {
      const openingRow = this.db.get(
        `SELECT
           (SELECT COALESCE(SUM(total_minor),0) FROM invoices WHERE patient_id = ? AND status <> 'void' AND invoice_date < ?)
         - (SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE patient_id = ? AND voided_at IS NULL AND substr(paid_at,1,10) < ?)
         + (SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE patient_id = ? AND substr(refunded_at,1,10) < ?)
         + (SELECT COALESCE(SUM(delta_minor),0) FROM adjustments WHERE patient_id = ? AND substr(created_at,1,10) < ?) AS balance`,
        patientId,
        fromKey,
        patientId,
        fromKey,
        patientId,
        fromKey,
        patientId,
        fromKey,
      );
      openingMinor = int(openingRow, 'balance');
    }

    const invoices = this.db.all(
      `SELECT number, invoice_date AS invoiceDate, total_minor AS totalMinor FROM invoices
        WHERE patient_id = ? AND status <> 'void' AND (? IS NULL OR invoice_date >= ?) AND (? IS NULL OR invoice_date <= ?)
        ORDER BY invoice_date, number`,
      patientId,
      fromKey,
      fromKey,
      toKey,
      toKey,
    );
    for (const inv of invoices) {
      entries.push({
        occurredAt: `${str(inv, 'invoiceDate')}T00:00:00.000Z`,
        kind: 'invoice',
        reference: str(inv, 'number'),
        deltaMinor: int(inv, 'totalMinor'),
        runningBalanceMinor: 0,
      });
    }

    const payments = this.db.all(
      `SELECT pm.paid_at AS paidAt, pm.amount_minor AS amountMinor, i.number AS invoiceNumber
         FROM payments pm JOIN invoices i ON i.id = pm.invoice_id
        WHERE pm.patient_id = ? AND pm.voided_at IS NULL AND (? IS NULL OR substr(pm.paid_at,1,10) >= ?) AND (? IS NULL OR substr(pm.paid_at,1,10) <= ?)
        ORDER BY pm.paid_at`,
      patientId,
      fromKey,
      fromKey,
      toKey,
      toKey,
    );
    for (const pm of payments) {
      entries.push({
        occurredAt: str(pm, 'paidAt'),
        kind: 'payment',
        reference: str(pm, 'invoiceNumber'),
        deltaMinor: -int(pm, 'amountMinor'),
        runningBalanceMinor: 0,
      });
    }

    const refunds = this.db.all(
      `SELECT rf.refunded_at AS refundedAt, rf.amount_minor AS amountMinor, i.number AS invoiceNumber
         FROM refunds rf JOIN invoices i ON i.id = rf.invoice_id
        WHERE rf.patient_id = ? AND (? IS NULL OR substr(rf.refunded_at,1,10) >= ?) AND (? IS NULL OR substr(rf.refunded_at,1,10) <= ?)
        ORDER BY rf.refunded_at`,
      patientId,
      fromKey,
      fromKey,
      toKey,
      toKey,
    );
    for (const rf of refunds) {
      entries.push({
        occurredAt: str(rf, 'refundedAt'),
        kind: 'refund',
        reference: str(rf, 'invoiceNumber'),
        deltaMinor: int(rf, 'amountMinor'),
        runningBalanceMinor: 0,
      });
    }

    const adjustments = this.db.all(
      `SELECT ad.created_at AS createdAt, ad.delta_minor AS deltaMinor, i.number AS invoiceNumber
         FROM adjustments ad JOIN invoices i ON i.id = ad.invoice_id
        WHERE ad.patient_id = ? AND (? IS NULL OR substr(ad.created_at,1,10) >= ?) AND (? IS NULL OR substr(ad.created_at,1,10) <= ?)
        ORDER BY ad.created_at`,
      patientId,
      fromKey,
      fromKey,
      toKey,
      toKey,
    );
    for (const ad of adjustments) {
      entries.push({
        occurredAt: str(ad, 'createdAt'),
        kind: 'adjustment',
        reference: str(ad, 'invoiceNumber'),
        deltaMinor: int(ad, 'deltaMinor'),
        runningBalanceMinor: 0,
      });
    }

    // Sort and compute running balance
    entries.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.reference.localeCompare(b.reference)));
    let running = openingMinor;
    let totalInvoiced = 0;
    let totalPaid = 0;
    let totalRefunded = 0;
    let totalAdjusted = 0;
    for (const entry of entries) {
      running += entry.deltaMinor;
      entry.runningBalanceMinor = running;
      if (entry.kind === 'invoice') totalInvoiced += entry.deltaMinor;
      else if (entry.kind === 'payment') totalPaid += -entry.deltaMinor;
      else if (entry.kind === 'refund') totalRefunded += entry.deltaMinor;
      else if (entry.kind === 'adjustment') totalAdjusted += entry.deltaMinor;
    }

    return {
      kind: 'statement',
      patient,
      fromKey,
      toKey,
      openingMinor,
      entries,
      closingMinor: running,
      totalInvoicedMinor: totalInvoiced,
      totalPaidMinor: totalPaid,
      totalRefundedMinor: totalRefunded,
      totalAdjustedMinor: totalAdjusted,
      clinic,
      generatedAt: new Date().toISOString(),
    };
  }
}
