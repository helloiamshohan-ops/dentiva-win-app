/**
 * Dentiva Pro — clinic and application settings.
 *
 * Settings live in two places with different shapes:
 *   - `clinic`       a single typed row: the clinic's identity and regional configuration.
 *   - `app_settings` a key/value table for operational preferences.
 *
 * Every read returns a fully populated object with defaults applied, so callers never have to
 * handle a half-configured clinic. Every write is transactional and audited; a failed save
 * surfaces as an error rather than silently leaving the old value in place.
 */

import { AppError, Errors } from '../../shared/errors';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_ZONE, isValidTimeZone, type DateFormat } from '../../shared/dates';
import { PAYMENT_METHODS_DEFAULT } from '../../domain/financial';
import type { QueueSerialScope } from '../../domain/queue';
import type { Database } from '../db/sqlite';
import type { AuditActor } from '../audit/audit';
import { AUDIT_ACTIONS, type AuditService } from '../audit/audit';

export interface ClinicInfo {
  id: string;
  name: string;
  legalName: string;
  tagline: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  district: string;
  postalCode: string;
  country: string;
  phone: string;
  alternatePhone: string;
  email: string;
  website: string;
  registrationNo: string;
  registrationBody: string;
  logoAttachmentId: string | null;
  timeZone: string;
  currencyCode: string;
  currencySymbol: string;
  dateFormat: DateFormat;
  footerNote: string;
}

export interface AppSettings {
  /** Minutes of inactivity before the application locks itself. */
  inactivityTimeoutMinutes: number;
  /** Payment methods offered at the point of payment. */
  paymentMethods: string[];
  /** Queue serial numbering scope. */
  queueSerialScope: QueueSerialScope;
  /** Permit payments larger than the outstanding balance. */
  allowOverpayment: boolean;
  /** Permit inventory operations that drive stock negative. */
  allowNegativeStock: boolean;
  /** Days before expiry that stock is flagged. */
  expiryWarningDays: number;
  /** Run automatic backups. */
  autoBackupEnabled: boolean;
  /** Hours between automatic backups. */
  autoBackupIntervalHours: number;
  /** Number of automatic backups to retain. */
  autoBackupRetained: number;
  /** Directory backups are written to. Empty means the managed default. */
  backupDirectory: string;
  /** Default tax percentage applied to new invoices. */
  defaultTaxPercent: number;
  /** Days before a follow-up is due that it appears in the dashboard. */
  followUpWindowDays: number;
  /** Whether the first-run setup wizard has been completed. */
  setupCompleted: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  inactivityTimeoutMinutes: 15,
  paymentMethods: [...PAYMENT_METHODS_DEFAULT],
  queueSerialScope: 'clinic',
  allowOverpayment: false,
  allowNegativeStock: false,
  expiryWarningDays: 60,
  autoBackupEnabled: true,
  autoBackupIntervalHours: 24,
  autoBackupRetained: 10,
  backupDirectory: '',
  defaultTaxPercent: 0,
  followUpWindowDays: 7,
  setupCompleted: false,
};

/** Keys that hold JSON-encoded values rather than plain strings. */
const JSON_KEYS: Record<string, keyof AppSettings> = {
  'payment.methods': 'paymentMethods',
};

export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  getClinic(): ClinicInfo {
    const row = this.db.get('SELECT * FROM clinic ORDER BY id LIMIT 1');
    if (!row) {
      throw new AppError('Clinic configuration is missing. Run the first-launch setup to create it.', {
        code: 'INTEGRITY_VIOLATION',
        retryable: false,
      });
    }
    const text = (key: string): string => {
      const value = row[key];
      return value === null || value === undefined ? '' : String(value);
    };
    const timeZone = text('time_zone') || DEFAULT_TIME_ZONE;
    const dateFormat = text('date_format') || DEFAULT_DATE_FORMAT;
    return {
      id: text('id'),
      name: text('name'),
      legalName: text('legal_name'),
      tagline: text('tagline'),
      addressLine1: text('address_line1'),
      addressLine2: text('address_line2'),
      city: text('city'),
      district: text('district'),
      postalCode: text('postal_code'),
      country: text('country') || 'Bangladesh',
      phone: text('phone'),
      alternatePhone: text('alternate_phone'),
      email: text('email'),
      website: text('website'),
      registrationNo: text('registration_no'),
      registrationBody: text('registration_body'),
      logoAttachmentId: row.logo_attachment_id === null ? null : String(row.logo_attachment_id),
      timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE,
      currencyCode: text('currency_code') || 'BDT',
      currencySymbol: text('currency_symbol') || '৳',
      dateFormat: (['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const).includes(dateFormat as DateFormat)
        ? (dateFormat as DateFormat)
        : DEFAULT_DATE_FORMAT,
      footerNote: text('footer_note'),
    };
  }

  updateClinic(actor: AuditActor, input: Partial<ClinicInfo>): ClinicInfo {
    const current = this.getClinic();
    const next: ClinicInfo = { ...current, ...stripUndefined(input), id: current.id };

    next.name = requireText(next.name, 'Clinic name', 200);
    if (next.legalName) next.legalName = requireText(next.legalName, 'Legal name', 200);
    if (!isValidTimeZone(next.timeZone)) {
      throw Errors.validation('That time zone is not recognised.', { timeZone: 'Select a valid time zone.' });
    }
    if (!(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const).includes(next.dateFormat)) {
      throw Errors.validation('That date format is not supported.', { dateFormat: 'Select a supported date format.' });
    }
    next.currencyCode = requireText(next.currencyCode, 'Currency code', 8).toUpperCase();
    next.currencySymbol = requireText(next.currencySymbol, 'Currency symbol', 8);
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(next.email)) {
      throw Errors.validation('That email address does not look right.', { email: 'Enter a valid email address.' });
    }

    this.db.transaction((tx) => {
      tx.run(
        `UPDATE clinic SET
           name = ?, legal_name = ?, tagline = ?, address_line1 = ?, address_line2 = ?,
           city = ?, district = ?, postal_code = ?, country = ?, phone = ?, alternate_phone = ?,
           email = ?, website = ?, registration_no = ?, registration_body = ?, logo_attachment_id = ?,
           time_zone = ?, currency_code = ?, currency_symbol = ?, date_format = ?, footer_note = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        next.name,
        nullIfEmpty(next.legalName),
        nullIfEmpty(next.tagline),
        nullIfEmpty(next.addressLine1),
        nullIfEmpty(next.addressLine2),
        nullIfEmpty(next.city),
        nullIfEmpty(next.district),
        nullIfEmpty(next.postalCode),
        next.country,
        nullIfEmpty(next.phone),
        nullIfEmpty(next.alternatePhone),
        nullIfEmpty(next.email),
        nullIfEmpty(next.website),
        nullIfEmpty(next.registrationNo),
        nullIfEmpty(next.registrationBody),
        next.logoAttachmentId,
        next.timeZone,
        next.currencyCode,
        next.currencySymbol,
        next.dateFormat,
        nullIfEmpty(next.footerNote),
        next.id,
      );
      const changed = Object.keys(stripUndefined(input)).filter((k) => k !== 'id');
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.CLINIC_UPDATED,
        entityType: 'clinic',
        entityId: next.id,
        summary: `Updated clinic details (${changed.join(', ') || 'no fields'})`,
        metadata: { fields: changed },
      });
    });

    return this.getClinic();
  }

  getSettings(): AppSettings {
    const rows = this.db.all('SELECT key, value FROM app_settings');
    const map = new Map<string, string>();
    for (const row of rows) map.set(String(row.key), String(row.value));
    const result: AppSettings = { ...DEFAULT_APP_SETTINGS, paymentMethods: [...DEFAULT_APP_SETTINGS.paymentMethods] };

    const readNumber = (key: string, fallback: number, min: number, max: number): number => {
      const raw = map.get(key);
      if (raw === undefined) return fallback;
      const value = Number(raw);
      if (!Number.isFinite(value)) return fallback;
      return Math.min(max, Math.max(min, value));
    };
    const readBool = (key: string, fallback: boolean): boolean => {
      const raw = map.get(key);
      if (raw === undefined) return fallback;
      return raw === '1' || raw === 'true';
    };

    result.inactivityTimeoutMinutes = readNumber('inactivity.timeout_minutes', DEFAULT_APP_SETTINGS.inactivityTimeoutMinutes, 1, 480);
    result.queueSerialScope = map.get('queue.serial_scope') === 'dentist' ? 'dentist' : 'clinic';
    result.allowOverpayment = readBool('financial.allow_overpayment', DEFAULT_APP_SETTINGS.allowOverpayment);
    result.allowNegativeStock = readBool('inventory.allow_negative_stock', DEFAULT_APP_SETTINGS.allowNegativeStock);
    result.expiryWarningDays = readNumber('inventory.expiry_warning_days', DEFAULT_APP_SETTINGS.expiryWarningDays, 0, 3650);
    result.autoBackupEnabled = readBool('backup.auto_enabled', DEFAULT_APP_SETTINGS.autoBackupEnabled);
    result.autoBackupIntervalHours = readNumber('backup.auto_interval_hours', DEFAULT_APP_SETTINGS.autoBackupIntervalHours, 1, 168);
    result.autoBackupRetained = readNumber('backup.auto_retained', DEFAULT_APP_SETTINGS.autoBackupRetained, 1, 200);
    result.backupDirectory = map.get('backup.directory') ?? '';
    result.defaultTaxPercent = readNumber('financial.default_tax_percent', DEFAULT_APP_SETTINGS.defaultTaxPercent, 0, 100);
    result.followUpWindowDays = readNumber('followup.window_days', DEFAULT_APP_SETTINGS.followUpWindowDays, 0, 365);
    result.setupCompleted = readBool('setup.completed', false);

    const methodsRaw = map.get('payment.methods');
    if (methodsRaw !== undefined) {
      try {
        const parsed = JSON.parse(methodsRaw) as unknown;
        if (Array.isArray(parsed)) {
          const methods = parsed.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim().slice(0, 40));
          if (methods.length > 0) result.paymentMethods = [...new Set(methods)];
        }
      } catch {
        // A corrupt setting must not break the application; fall back to the defaults.
        result.paymentMethods = [...DEFAULT_APP_SETTINGS.paymentMethods];
      }
    }

    return result;
  }

  updateSettings(actor: AuditActor, input: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = { ...current, ...stripUndefined(input) };

    if (!Number.isSafeInteger(next.inactivityTimeoutMinutes) || next.inactivityTimeoutMinutes < 1 || next.inactivityTimeoutMinutes > 480) {
      throw Errors.validation('The inactivity timeout must be between 1 and 480 minutes.', {
        inactivityTimeoutMinutes: 'Enter a value between 1 and 480.',
      });
    }
    if (next.queueSerialScope !== 'clinic' && next.queueSerialScope !== 'dentist') {
      throw Errors.validation('Queue serial scope must be either clinic or dentist.', {
        queueSerialScope: 'Select a valid scope.',
      });
    }
    const methods = [...new Set((next.paymentMethods ?? []).map((m) => String(m).trim()).filter((m) => m !== ''))];
    if (methods.length === 0) {
      throw Errors.validation('At least one payment method is required.', {
        paymentMethods: 'Keep at least one payment method.',
      });
    }
    if (methods.some((m) => m.length > 40)) {
      throw Errors.validation('Payment method names must be 40 characters or fewer.', {
        paymentMethods: 'Shorten a payment method name.',
      });
    }
    next.paymentMethods = methods;

    if (next.defaultTaxPercent < 0 || next.defaultTaxPercent > 100) {
      throw Errors.validation('Default tax percentage must be between 0 and 100.', {
        defaultTaxPercent: 'Enter a value between 0 and 100.',
      });
    }

    const writes: Array<[string, string]> = [
      ['inactivity.timeout_minutes', String(next.inactivityTimeoutMinutes)],
      ['queue.serial_scope', next.queueSerialScope],
      ['financial.allow_overpayment', next.allowOverpayment ? '1' : '0'],
      ['inventory.allow_negative_stock', next.allowNegativeStock ? '1' : '0'],
      ['inventory.expiry_warning_days', String(next.expiryWarningDays)],
      ['backup.auto_enabled', next.autoBackupEnabled ? '1' : '0'],
      ['backup.auto_interval_hours', String(next.autoBackupIntervalHours)],
      ['backup.auto_retained', String(next.autoBackupRetained)],
      ['backup.directory', next.backupDirectory],
      ['financial.default_tax_percent', String(next.defaultTaxPercent)],
      ['followup.window_days', String(next.followUpWindowDays)],
      ['setup.completed', next.setupCompleted ? '1' : '0'],
      ['payment.methods', JSON.stringify(next.paymentMethods)],
    ];

    this.db.transaction((tx) => {
      for (const [key, value] of writes) {
        tx.run(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          key,
          value,
        );
      }
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entityType: 'settings',
        entityId: 'application',
        summary: `Updated application settings (${Object.keys(stripUndefined(input)).join(', ') || 'no fields'})`,
        metadata: { fields: Object.keys(stripUndefined(input)) },
      });
    });

    return this.getSettings();
  }

  /** Mark first-run setup as finished. Called once by the setup wizard. */
  completeSetup(actor: AuditActor): void {
    this.updateSettings(actor, { setupCompleted: true });
  }
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function requireText(value: string, label: string, maxLength: number): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') throw Errors.validation(`${label} is required.`, { [label.toLowerCase().replace(/\s+/g, '')]: `${label} is required.` });
  if (trimmed.length > maxLength) {
    throw Errors.validation(`${label} must be ${maxLength} characters or fewer.`, {
      [label.toLowerCase().replace(/\s+/g, '')]: `Use ${maxLength} characters or fewer.`,
    });
  }
  return trimmed;
}

function nullIfEmpty(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

export { JSON_KEYS };
