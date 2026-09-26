/**
 * Dentiva Pro — PDF generation engine.
 *
 * One reliable document engine for all documents. Preview and PDF derive from the same semantic
 * model. PDF quality requirements:
 *   - exact page size, margins, logo, typography, headers, footers, tables, page breaks
 *   - no clipping, overlap, blank page, broken glyph, undefined/null/NaN/[object Object]
 *   - no orphan headings, no split medication rows, no broken table rows
 */

import PDFDocument from 'pdfkit';
import { formatMoney } from '../../shared/money';
import { formatDate, formatDateOnly, type DateFormat } from '../../shared/dates';
import type {
  PrescriptionDocument,
  InvoiceDocument,
  ReceiptDocument,
  StatementDocument,
  AnyDocument,
  PrescriptionMedicineDoc,
} from './document-model';

export type PdfPageSize = 'A4' | 'A5' | 'Letter' | '80mm';

export interface PdfOptions {
  pageSize: PdfPageSize;
  dateFormat: DateFormat;
  timeZone: string;
  currencySymbol: string;
}

const PAGE_DIMENSIONS: Record<PdfPageSize, { width: number; height: number; margin: number }> = {
  A4: { width: 595.28, height: 841.89, margin: 50 },
  A5: { width: 419.53, height: 595.28, margin: 40 },
  Letter: { width: 612, height: 792, margin: 50 },
  '80mm': { width: 226.77, height: 1000, margin: 15 }, // 80mm wide, variable height
};

const COLORS = {
  primary: '#0F6C6B',
  primaryDark: '#0A4A49',
  text: '#1A1A1A',
  textSecondary: '#4A5568',
  textMuted: '#718096',
  border: '#E2E8F0',
  borderLight: '#EDF2F7',
  background: '#F7FAFC',
  success: '#276749',
  warning: '#975A16',
  danger: '#9B2C2C',
};

export class PdfGenerator {
  /**
   * Generate PDF buffer from a semantic document.
   */
  async generate(doc: AnyDocument, options: PdfOptions): Promise<Buffer> {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    const pdf = new PDFDocument({
      size: options.pageSize === '80mm' ? [dims.width, dims.height] : options.pageSize === 'A5' ? 'A5' : options.pageSize === 'Letter' ? 'LETTER' : 'A4',
      margins: { top: dims.margin, bottom: dims.margin, left: dims.margin, right: dims.margin },
      info: {
        Title: this.getTitle(doc),
        Author: doc.clinic.name || 'Dentiva Pro',
        Subject: `${doc.kind} document`,
        Creator: 'Dentiva Pro',
      },
    });

    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));

    const done = new Promise<Buffer>((resolve, reject) => {
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);
    });

    try {
      switch (doc.kind) {
        case 'prescription':
          this.renderPrescription(pdf, doc, options);
          break;
        case 'invoice':
          this.renderInvoice(pdf, doc, options);
          break;
        case 'receipt':
          this.renderReceipt(pdf, doc, options);
          break;
        case 'statement':
          this.renderStatement(pdf, doc, options);
          break;
      }
    } catch (error) {
      pdf.end();
      throw error;
    }

    pdf.end();
    return done;
  }

  private getTitle(doc: AnyDocument): string {
    switch (doc.kind) {
      case 'prescription':
        return `Prescription - ${doc.patient.patientCode} - ${doc.dateKey}`;
      case 'invoice':
        return `Invoice ${doc.number} - ${doc.patient.patientCode}`;
      case 'receipt':
        return `Receipt ${doc.number} - ${doc.patient.patientCode}`;
      case 'statement':
        return `Statement - ${doc.patient.patientCode}`;
    }
  }

  // ── Prescription ─────────────────────────────────────────────────────────────────────

  private renderPrescription(pdf: PDFKit.PDFDocument, doc: PrescriptionDocument, options: PdfOptions): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    const isSmall = options.pageSize === 'A5' || options.pageSize === '80mm';

    // Header
    this.renderClinicHeader(pdf, doc.clinic, options, isSmall);

    // Title
    pdf.moveDown(0.5);
    this.renderTitle(pdf, 'PRESCRIPTION', isSmall);

    // Patient and dentist info
    pdf.moveDown(0.5);
    this.renderPatientBlock(pdf, doc.patient, options, isSmall);
    if (doc.dentist) {
      this.renderDentistBlock(pdf, doc.dentist, isSmall);
    }

    pdf.moveDown(0.5);
    pdf.fontSize(isSmall ? 8 : 10).fillColor(COLORS.textMuted).text(`Date: ${formatDateOnly(doc.dateKey, options.dateFormat)}`, { align: 'right' });
    pdf.moveDown(0.5);

    // Divider
    this.renderDivider(pdf);

    // C/C
    if (doc.chiefComplaints.length > 0) {
      this.renderClinicalSection(pdf, 'C/C (Chief Complaints)', doc.chiefComplaints, isSmall);
    }

    // O/E
    if (doc.onExamination.length > 0) {
      this.renderClinicalSection(pdf, 'O/E (On Examination)', doc.onExamination, isSmall);
    }

    // R/E
    if (doc.radiologyExamination) {
      pdf.fontSize(isSmall ? 9 : 11).fillColor(COLORS.text).font('Helvetica-Bold').text('R/E (Radiological Examination):');
      pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').text(doc.radiologyExamination, { width: dims.width - dims.margin * 2 - 20 });
      pdf.moveDown(0.5);
    }

    // Medicines
    if (doc.medicines.length > 0) {
      this.renderMedicines(pdf, doc.medicines, options, isSmall);
    }

    // Advice
    if (doc.advice) {
      pdf.moveDown(0.5);
      pdf.fontSize(isSmall ? 9 : 11).font('Helvetica-Bold').fillColor(COLORS.text).text('Advice:');
      pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').text(doc.advice, { width: dims.width - dims.margin * 2 - 20 });
    }

    // Notes
    if (doc.notes) {
      pdf.moveDown(0.5);
      pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.textSecondary).text(`Notes: ${doc.notes}`, { width: dims.width - dims.margin * 2 - 20 });
    }

    // Footer
    this.renderFooter(pdf, doc.clinic, doc.dentist, options, isSmall);
  }

  private renderMedicines(pdf: PDFKit.PDFDocument, medicines: PrescriptionMedicineDoc[], options: PdfOptions, isSmall: boolean): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    pdf.moveDown(0.5);
    pdf.fontSize(isSmall ? 10 : 12).font('Helvetica-Bold').fillColor(COLORS.primary).text('Rx', { underline: false });
    pdf.moveDown(0.3);

    medicines.forEach((med, idx) => {
      // Check if we need a new page (keep medicine row together)
      const neededHeight = 60;
      if (pdf.y + neededHeight > dims.height - dims.margin - 80) {
        pdf.addPage();
      }

      pdf.fontSize(isSmall ? 9 : 11).font('Helvetica-Bold').fillColor(COLORS.text).text(`${idx + 1}. ${med.name}`, { continued: false });
      const details: string[] = [];
      if (med.form) details.push(med.form);
      if (med.strength) details.push(med.strength);
      if (details.length > 0) {
        pdf.fontSize(isSmall ? 7 : 9).font('Helvetica').fillColor(COLORS.textSecondary).text(`   ${details.join(' - ')}`);
      }

      const instructions: string[] = [];
      if (med.dose) instructions.push(`Dose: ${med.dose}`);
      if (med.frequency) instructions.push(med.frequency);
      if (med.duration) instructions.push(`for ${med.duration}`);
      if (med.timing) instructions.push(med.timing);
      if (med.foodRelation) instructions.push(med.foodRelation.replace('_', ' '));
      if (instructions.length > 0) {
        pdf.fontSize(isSmall ? 7 : 9).font('Helvetica').fillColor(COLORS.text).text(`   ${instructions.join(', ')}`, { width: dims.width - dims.margin * 2 - 30 });
      }
      if (med.customInstructions) {
        pdf.fontSize(isSmall ? 7 : 9).font('Helvetica-Oblique').fillColor(COLORS.textSecondary).text(`   ${med.customInstructions}`, { width: dims.width - dims.margin * 2 - 30 });
      }
      pdf.moveDown(0.4);
    });
  }

  private renderClinicalSection(pdf: PDFKit.PDFDocument, title: string, findings: { label: string; detail: string; teeth: number[] }[], isSmall: boolean): void {
    const dims = PAGE_DIMENSIONS[isSmall ? 'A5' : 'A4'];
    pdf.fontSize(isSmall ? 9 : 11).font('Helvetica-Bold').fillColor(COLORS.text).text(title);
    pdf.moveDown(0.2);
    findings.forEach((finding) => {
      let text = `• ${finding.label}`;
      if (finding.detail) text += `: ${finding.detail}`;
      if (finding.teeth.length > 0) text += ` [Teeth: ${finding.teeth.join(', ')}]`;
      pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.text).text(text, { width: dims.width - dims.margin * 2 - 20 });
    });
    pdf.moveDown(0.5);
  }

  // ── Invoice ───────────────────────────────────────────────────────────────────────────

  private renderInvoice(pdf: PDFKit.PDFDocument, doc: InvoiceDocument, options: PdfOptions): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    const isSmall = options.pageSize === 'A5';

    this.renderClinicHeader(pdf, doc.clinic, options, isSmall);
    pdf.moveDown(0.5);
    this.renderTitle(pdf, `INVOICE ${doc.number}`, isSmall);

    pdf.moveDown(0.5);
    this.renderPatientBlock(pdf, doc.patient, options, isSmall);
    if (doc.dentist) this.renderDentistBlock(pdf, doc.dentist, isSmall);

    pdf.moveDown(0.3);
    pdf.fontSize(isSmall ? 8 : 10).fillColor(COLORS.textMuted).text(`Date: ${formatDateOnly(doc.invoiceDate, options.dateFormat)} | Status: ${doc.status.replace('_', ' ')}`, { align: 'right' });
    if (doc.dueDateKey) {
      pdf.text(`Due: ${formatDateOnly(doc.dueDateKey, options.dateFormat)}`, { align: 'right' });
    }

    pdf.moveDown(0.5);
    this.renderDivider(pdf);

    // Line items table
    this.renderInvoiceTable(pdf, doc, options, isSmall);

    // Totals
    pdf.moveDown(0.5);
    this.renderInvoiceTotals(pdf, doc, options, isSmall);

    if (doc.notes) {
      pdf.moveDown(0.5);
      pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.textSecondary).text(`Notes: ${doc.notes}`, { width: dims.width - dims.margin * 2 - 20 });
    }

    this.renderFooter(pdf, doc.clinic, doc.dentist, options, isSmall);
  }

  private renderInvoiceTable(pdf: PDFKit.PDFDocument, doc: InvoiceDocument, options: PdfOptions, isSmall: boolean): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    const tableWidth = dims.width - dims.margin * 2;
    const colWidths = isSmall ? [20, 140, 30, 50, 50] : [25, 220, 40, 70, 70];
    const headers = ['#', 'Description', 'Qty', 'Unit Price', 'Total'];

    // Header
    let x = dims.margin;
    const headerY = pdf.y;
    pdf.fontSize(isSmall ? 7 : 9).font('Helvetica-Bold').fillColor(COLORS.text);
    headers.forEach((header, i) => {
      pdf.text(header, x, headerY, { width: colWidths[i]!, align: i === 0 ? 'center' : i >= 3 ? 'right' : 'left' });
      x += colWidths[i]!;
    });
    pdf.moveDown(0.5);
    this.renderDivider(pdf, 0.5);

    // Rows
    doc.lines.forEach((line, idx) => {
      const rowHeight = 20;
      if (pdf.y + rowHeight > dims.height - dims.margin - 100) {
        pdf.addPage();
        // Repeat header
        x = dims.margin;
        pdf.fontSize(isSmall ? 7 : 9).font('Helvetica-Bold').fillColor(COLORS.text);
        headers.forEach((header, i) => {
          pdf.text(header, x, pdf.y, { width: colWidths[i]!, align: i === 0 ? 'center' : i >= 3 ? 'right' : 'left' });
          x += colWidths[i]!;
        });
        pdf.moveDown(0.5);
        this.renderDivider(pdf, 0.5);
      }

      x = dims.margin;
      const rowY = pdf.y;
      pdf.fontSize(isSmall ? 7 : 9).font('Helvetica').fillColor(COLORS.text);
      pdf.text(String(idx + 1), x, rowY, { width: colWidths[0]!, align: 'center' });
      x += colWidths[0]!;
      pdf.text(line.description + (line.toothNumber ? ` (Tooth ${line.toothNumber})` : ''), x, rowY, { width: colWidths[1]!, align: 'left' });
      x += colWidths[1]!;
      pdf.text(String(line.quantity), x, rowY, { width: colWidths[2]!, align: 'center' });
      x += colWidths[2]!;
      pdf.text(formatMoney(line.unitPriceMinor, { symbol: options.currencySymbol }), x, rowY, { width: colWidths[3]!, align: 'right' });
      x += colWidths[3]!;
      pdf.text(formatMoney(line.netMinor, { symbol: options.currencySymbol }), x, rowY, { width: colWidths[4]!, align: 'right' });
      pdf.moveDown(0.8);
    });
  }

  private renderInvoiceTotals(pdf: PDFKit.PDFDocument, doc: InvoiceDocument, options: PdfOptions, isSmall: boolean): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    const totalsX = dims.width - dims.margin - 180;
    const valueX = dims.width - dims.margin - 80;

    const rows: [string, number][] = [
      ['Subtotal:', doc.subtotalMinor],
      ...(doc.discountMinor > 0 ? [['Discount:', -doc.discountMinor] as [string, number]] : []),
      ...(doc.taxMinor > 0 ? [[`Tax (${doc.taxPercent}%):`, doc.taxMinor] as [string, number]] : []),
      ['Total:', doc.totalMinor],
      ['Paid:', -doc.paidMinor],
      ['Due:', doc.outstandingMinor],
    ];

    rows.forEach(([label, amount], idx) => {
      const isTotal = label === 'Total:';
      const isDue = label === 'Due:';
      pdf.fontSize(isSmall ? 8 : 10).font(isTotal || isDue ? 'Helvetica-Bold' : 'Helvetica').fillColor(isDue && doc.outstandingMinor > 0 ? COLORS.danger : COLORS.text);
      pdf.text(label, totalsX, pdf.y, { width: 80, align: 'right', continued: false });
      const amountText = formatMoney(Math.abs(amount), { symbol: options.currencySymbol });
      const displayText = amount < 0 ? `-${amountText}` : amountText;
      pdf.text(displayText, valueX, pdf.y - (isSmall ? 11 : 13), { width: 80, align: 'right' });
      if (isTotal) {
        pdf.moveDown(0.2);
        this.renderDivider(pdf, 0.5, totalsX, 160);
      }
      pdf.moveDown(isTotal || isDue ? 0.5 : 0.3);
    });
  }

  // ── Receipt ───────────────────────────────────────────────────────────────────────────

  private renderReceipt(pdf: PDFKit.PDFDocument, doc: ReceiptDocument, options: PdfOptions): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    const isSmall = options.pageSize === '80mm' || options.pageSize === 'A5';

    if (options.pageSize === '80mm') {
      // Compact receipt for thermal printer
      pdf.fontSize(12).font('Helvetica-Bold').fillColor(COLORS.text).text(doc.clinic.name || 'Dentiva Pro', { align: 'center' });
      if (doc.clinic.addressLine1) pdf.fontSize(7).font('Helvetica').text(doc.clinic.addressLine1, { align: 'center' });
      if (doc.clinic.phone) pdf.fontSize(7).text(`Tel: ${doc.clinic.phone}`, { align: 'center' });
      pdf.moveDown(0.5);
      this.renderDivider(pdf, 0.5);
      pdf.fontSize(10).font('Helvetica-Bold').text(`RECEIPT ${doc.number}`, { align: 'center' });
      pdf.moveDown(0.3);
      pdf.fontSize(7).font('Helvetica').text(`Date: ${formatDateOnly(doc.receiptDate, options.dateFormat)}`);
      pdf.text(`Patient: ${doc.patient.name} (${doc.patient.patientCode})`);
      pdf.text(`Invoice: ${doc.invoice.number}`);
      pdf.moveDown(0.3);
      this.renderDivider(pdf, 0.5);
      pdf.fontSize(9).font('Helvetica-Bold').text(`Amount: ${formatMoney(doc.payment.amountMinor, { symbol: options.currencySymbol })}`, { align: 'center' });
      pdf.fontSize(7).font('Helvetica').text(`Method: ${doc.payment.method}`, { align: 'center' });
      if (doc.payment.reference) pdf.text(`Ref: ${doc.payment.reference}`, { align: 'center' });
      pdf.moveDown(0.3);
      this.renderDivider(pdf, 0.5);
      pdf.fontSize(7).text(`Remaining Due: ${formatMoney(doc.remainingDueMinor, { symbol: options.currencySymbol })}`, { align: 'center' });
      if (doc.receivedBy) pdf.text(`Received by: ${doc.receivedBy}`, { align: 'center' });
      if (doc.notes) {
        pdf.moveDown(0.3);
        pdf.text(doc.notes, { align: 'center' });
      }
      pdf.moveDown(0.5);
      pdf.fontSize(6).fillColor(COLORS.textMuted).text('Thank you for your payment!', { align: 'center' });
    } else {
      this.renderClinicHeader(pdf, doc.clinic, options, isSmall);
      pdf.moveDown(0.5);
      this.renderTitle(pdf, `RECEIPT ${doc.number}`, isSmall);
      pdf.moveDown(0.5);
      this.renderPatientBlock(pdf, doc.patient, options, isSmall);

      pdf.moveDown(0.3);
      pdf.fontSize(isSmall ? 8 : 10).fillColor(COLORS.textMuted).text(`Date: ${formatDateOnly(doc.receiptDate, options.dateFormat)}`, { align: 'right' });
      pdf.text(`Invoice: ${doc.invoice.number}`, { align: 'right' });

      pdf.moveDown(0.5);
      this.renderDivider(pdf);

      pdf.moveDown(0.5);
      pdf.fontSize(isSmall ? 10 : 14).font('Helvetica-Bold').fillColor(COLORS.success).text(`Amount Received: ${formatMoney(doc.payment.amountMinor, { symbol: options.currencySymbol })}`, { align: 'center' });
      pdf.moveDown(0.3);
      pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.text).text(`Payment Method: ${doc.payment.method}`, { align: 'center' });
      if (doc.payment.reference) pdf.text(`Reference: ${doc.payment.reference}`, { align: 'center' });
      pdf.text(`Payment Date: ${formatDate(doc.payment.paidAt, options.timeZone, options.dateFormat)}`, { align: 'center' });

      pdf.moveDown(0.5);
      this.renderDivider(pdf);

      pdf.moveDown(0.3);
      pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.text).text(`Remaining Balance: ${formatMoney(doc.remainingDueMinor, { symbol: options.currencySymbol })}`, { align: 'right' });
      if (doc.receivedBy) pdf.text(`Received by: ${doc.receivedBy}`, { align: 'right' });

      if (doc.notes) {
        pdf.moveDown(0.5);
        pdf.text(`Notes: ${doc.notes}`, { width: dims.width - dims.margin * 2 - 20 });
      }

      this.renderFooter(pdf, doc.clinic, null, options, isSmall);
    }
  }

  // ── Statement ─────────────────────────────────────────────────────────────────────────

  private renderStatement(pdf: PDFKit.PDFDocument, doc: StatementDocument, options: PdfOptions): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    const isSmall = options.pageSize === 'A5';

    this.renderClinicHeader(pdf, doc.clinic, options, isSmall);
    pdf.moveDown(0.5);
    this.renderTitle(pdf, `PATIENT STATEMENT`, isSmall);

    pdf.moveDown(0.5);
    this.renderPatientBlock(pdf, doc.patient, options, isSmall);

    pdf.moveDown(0.3);
    let periodText = 'All time';
    if (doc.fromKey || doc.toKey) {
      periodText = `${doc.fromKey ? formatDateOnly(doc.fromKey, options.dateFormat) : 'Start'} to ${doc.toKey ? formatDateOnly(doc.toKey, options.dateFormat) : 'Now'}`;
    }
    pdf.fontSize(isSmall ? 8 : 10).fillColor(COLORS.textMuted).text(`Period: ${periodText}`, { align: 'right' });
    pdf.text(`Generated: ${formatDate(doc.generatedAt, options.timeZone, options.dateFormat)}`, { align: 'right' });

    pdf.moveDown(0.5);
    this.renderDivider(pdf);

    // Opening balance
    pdf.moveDown(0.3);
    pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.text).text(`Opening Balance: ${formatMoney(doc.openingMinor, { symbol: options.currencySymbol })}`, { align: 'right' });

    pdf.moveDown(0.5);

    // Transaction table
    const tableWidth = dims.width - dims.margin * 2;
    const colWidths = isSmall ? [50, 40, 80, 50, 50] : [70, 50, 120, 70, 70];
    const headers = ['Date', 'Type', 'Reference', 'Amount', 'Balance'];

    let x = dims.margin;
    const headerY = pdf.y;
    pdf.fontSize(isSmall ? 7 : 9).font('Helvetica-Bold').fillColor(COLORS.text);
    headers.forEach((header, i) => {
      pdf.text(header, x, headerY, { width: colWidths[i]!, align: i >= 3 ? 'right' : 'left' });
      x += colWidths[i]!;
    });
    pdf.moveDown(0.5);
    this.renderDivider(pdf, 0.5);

    doc.entries.forEach((entry) => {
      const rowHeight = 18;
      if (pdf.y + rowHeight > dims.height - dims.margin - 80) {
        pdf.addPage();
        x = dims.margin;
        pdf.fontSize(isSmall ? 7 : 9).font('Helvetica-Bold').fillColor(COLORS.text);
        headers.forEach((header, i) => {
          pdf.text(header, x, pdf.y, { width: colWidths[i]!, align: i >= 3 ? 'right' : 'left' });
          x += colWidths[i]!;
        });
        pdf.moveDown(0.5);
        this.renderDivider(pdf, 0.5);
      }

      x = dims.margin;
      const rowY = pdf.y;
      pdf.fontSize(isSmall ? 7 : 8).font('Helvetica').fillColor(COLORS.text);
      pdf.text(formatDateOnly(entry.occurredAt.slice(0, 10), options.dateFormat), x, rowY, { width: colWidths[0]!, align: 'left' });
      x += colWidths[0]!;
      pdf.text(entry.kind.replace('_', ' '), x, rowY, { width: colWidths[1]!, align: 'left' });
      x += colWidths[1]!;
      pdf.text(entry.reference, x, rowY, { width: colWidths[2]!, align: 'left' });
      x += colWidths[2]!;
      const amountText = formatMoney(entry.deltaMinor, { symbol: options.currencySymbol });
      pdf.fillColor(entry.deltaMinor > 0 ? COLORS.danger : COLORS.success).text(amountText, x, rowY, { width: colWidths[3]!, align: 'right' });
      x += colWidths[3]!;
      pdf.fillColor(COLORS.text).text(formatMoney(entry.runningBalanceMinor, { symbol: options.currencySymbol }), x, rowY, { width: colWidths[4]!, align: 'right' });
      pdf.moveDown(0.6);
    });

    pdf.moveDown(0.5);
    this.renderDivider(pdf);

    // Summary
    pdf.moveDown(0.3);
    pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.text);
    pdf.text(`Total Invoiced: ${formatMoney(doc.totalInvoicedMinor, { symbol: options.currencySymbol })}`, { align: 'right' });
    pdf.text(`Total Paid: ${formatMoney(doc.totalPaidMinor, { symbol: options.currencySymbol })}`, { align: 'right' });
    if (doc.totalRefundedMinor > 0) pdf.text(`Total Refunded: ${formatMoney(doc.totalRefundedMinor, { symbol: options.currencySymbol })}`, { align: 'right' });
    if (doc.totalAdjustedMinor !== 0) pdf.text(`Adjustments: ${formatMoney(doc.totalAdjustedMinor, { symbol: options.currencySymbol })}`, { align: 'right' });
    pdf.moveDown(0.3);
    pdf.fontSize(isSmall ? 9 : 12).font('Helvetica-Bold').fillColor(doc.closingMinor > 0 ? COLORS.danger : COLORS.success).text(`Closing Balance: ${formatMoney(doc.closingMinor, { symbol: options.currencySymbol })}`, { align: 'right' });

    this.renderFooter(pdf, doc.clinic, null, options, isSmall);
  }

  // ── Common rendering helpers ──────────────────────────────────────────────────────────

  private renderClinicHeader(pdf: PDFKit.PDFDocument, clinic: { name: string; addressLine1?: string | null; city?: string | null; phone?: string | null; email?: string | null; logoDataUrl?: string | null }, options: PdfOptions, isSmall: boolean): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];

    // Logo
    if (clinic.logoDataUrl) {
      try {
        const base64Data = clinic.logoDataUrl.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        pdf.image(buffer, dims.margin, pdf.y, { width: isSmall ? 30 : 50 });
      } catch {
        // Logo failed to render; continue without it
      }
    }

    pdf.fontSize(isSmall ? 12 : 16).font('Helvetica-Bold').fillColor(COLORS.primary).text(clinic.name || 'Dentiva Pro', dims.margin + (clinic.logoDataUrl ? (isSmall ? 40 : 60) : 0), pdf.y, { align: 'left' });
    pdf.fontSize(isSmall ? 7 : 9).font('Helvetica').fillColor(COLORS.textSecondary);
    const addressParts = [clinic.addressLine1, clinic.city].filter(Boolean);
    if (addressParts.length > 0) pdf.text(addressParts.join(', '), { width: tableWidth(dims) });
    if (clinic.phone) pdf.text(`Phone: ${clinic.phone}`);
    if (clinic.email) pdf.text(`Email: ${clinic.email}`);
  }

  private renderTitle(pdf: PDFKit.PDFDocument, title: string, isSmall: boolean): void {
    pdf.fontSize(isSmall ? 12 : 16).font('Helvetica-Bold').fillColor(COLORS.text).text(title, { align: 'center' });
  }

  private renderPatientBlock(pdf: PDFKit.PDFDocument, patient: { patientCode: string; name: string; sex: string; ageLabel: string | null; phone: string | null }, _options: PdfOptions, isSmall: boolean): void {
    pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.text);
    pdf.text(`Patient: ${patient.name} (${patient.patientCode})`);
    const details = [`Sex: ${patient.sex}`, patient.ageLabel ? `Age: ${patient.ageLabel}` : null, patient.phone ? `Phone: ${patient.phone}` : null].filter(Boolean);
    if (details.length > 0) pdf.fontSize(isSmall ? 7 : 9).fillColor(COLORS.textSecondary).text(details.join(' | '));
  }

  private renderDentistBlock(pdf: PDFKit.PDFDocument, dentist: { name: string; credentials: string | null; designation: string | null }, isSmall: boolean): void {
    pdf.moveDown(0.2);
    pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.text).text(`Dentist: ${dentist.name}${dentist.credentials ? `, ${dentist.credentials}` : ''}`);
    if (dentist.designation) pdf.fontSize(isSmall ? 7 : 9).fillColor(COLORS.textSecondary).text(dentist.designation);
  }

  private renderDivider(pdf: PDFKit.PDFDocument, thickness = 1, x?: number, width?: number): void {
    const dims = PAGE_DIMENSIONS['A4'];
    const startX = x ?? dims.margin;
    const w = width ?? dims.width - dims.margin * 2;
    pdf.moveTo(startX, pdf.y).lineTo(startX + w, pdf.y).lineWidth(thickness).strokeColor(COLORS.border).stroke();
    pdf.moveDown(0.3);
  }

  private renderFooter(pdf: PDFKit.PDFDocument, clinic: { footerNote?: string | null }, dentist: { name: string } | null, options: PdfOptions, isSmall: boolean): void {
    const dims = PAGE_DIMENSIONS[options.pageSize];
    const footerY = dims.height - dims.margin + 10;

    // Only render footer if we have space
    if (pdf.y < footerY - 60) {
      pdf.moveDown(2);
      this.renderDivider(pdf, 0.5);

      if (clinic.footerNote) {
        pdf.fontSize(isSmall ? 6 : 8).font('Helvetica').fillColor(COLORS.textMuted).text(clinic.footerNote, { width: dims.width - dims.margin * 2, align: 'center' });
      }

      pdf.fontSize(isSmall ? 6 : 8).fillColor(COLORS.textMuted).text(`Generated by Dentiva Pro on ${formatDate(new Date().toISOString(), options.timeZone, options.dateFormat)} | Page ${pdf.bufferedPageRange().count}`, {
        align: 'center',
      });

      if (dentist) {
        pdf.moveDown(1);
        pdf.fontSize(isSmall ? 8 : 10).font('Helvetica').fillColor(COLORS.text).text(`_________________________`, { align: 'right' });
        pdf.text(dentist.name, { align: 'right' });
        pdf.fontSize(isSmall ? 6 : 8).fillColor(COLORS.textMuted).text('Signature', { align: 'right' });
      }
    }
  }
}

function tableWidth(dims: { width: number; margin: number }): number {
  return dims.width - dims.margin * 2 - 60;
}
