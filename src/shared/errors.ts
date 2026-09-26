/**
 * Dentiva Pro — application error contract.
 *
 * A single structured error shape crosses every boundary in the product:
 *   service -> IPC -> preload -> renderer
 *
 * Structured information (error code, field errors, entity references, conflict details)
 * is preserved end-to-end. It is never flattened into a generic "Something went wrong"
 * string, because the renderer needs structured details to render field-level validation,
 * duplicate-patient review dialogs and appointment-conflict dialogs.
 *
 * The wire form is plain JSON-safe data so it survives Electron's structured clone.
 */

export const APP_ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'CONFLICT',
  'DUPLICATE_PATIENT',
  'APPOINTMENT_CONFLICT',
  'QUEUE_CONFLICT',
  'INSUFFICIENT_STOCK',
  'INSUFFICIENT_BALANCE',
  'OVERPAYMENT_NOT_ALLOWED',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'ACCOUNT_LOCKED',
  'INVALID_CREDENTIALS',
  'SESSION_EXPIRED',
  'NOT_ACTIVATED',
  'ACTIVATION_LOCKED',
  'INTEGRITY_VIOLATION',
  'FINANCIAL_IMMUTABLE',
  'BACKUP_FAILED',
  'RESTORE_FAILED',
  'RESTORE_INCOMPATIBLE',
  'IMPORT_FAILED',
  'EXPORT_FAILED',
  'ATTACHMENT_REJECTED',
  'ATTACHMENT_MISSING',
  'DOCUMENT_FAILED',
  'PRINT_FAILED',
  'STORAGE_FAILED',
  'INTERNAL',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** True when an error code is a member of the known contract. */
export function isAppErrorCode(v: unknown): v is AppErrorCode {
  return typeof v === 'string' && (APP_ERROR_CODES as readonly string[]).includes(v);
}

export type FieldErrors = Record<string, string>;

export interface AppErrorDetails {
  [key: string]: unknown;
}

export interface AppErrorOptions {
  code?: AppErrorCode;
  details?: AppErrorDetails;
  fieldErrors?: FieldErrors;
  retryable?: boolean;
  cause?: unknown;
  /** Machine identifier for the entity involved, e.g. { entityType: 'patient', entityId: '...' }. */
  entity?: { entityType: string; entityId: string };
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: AppErrorDetails;
  readonly fieldErrors: FieldErrors;
  readonly retryable: boolean;
  readonly entity?: { entityType: string; entityId: string };
  readonly isAppError = true;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = options.code ?? 'INTERNAL';
    this.details = options.details ?? {};
    this.fieldErrors = options.fieldErrors ?? {};
    this.retryable = options.retryable ?? false;
    if (options.entity) this.entity = options.entity;
    if (options.cause !== undefined) {
      // Preserve the originating error for diagnostics without exposing it to the user.
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
    // Maintain prototype chain when targeting older runtimes.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Convert to a JSON-safe wire payload for transport across the IPC boundary. */
  toWire(): AppErrorWire {
    return {
      name: 'AppError',
      code: this.code,
      message: this.message,
      details: sanitizeForWire(this.details),
      fieldErrors: this.fieldErrors,
      retryable: this.retryable,
      ...(this.entity ? { entity: this.entity } : {}),
    };
  }

  static fromWire(wire: unknown): AppError {
    if (!isAppErrorWire(wire)) return AppError.fromUnknown(wire);
    return new AppError(wire.message, {
      code: wire.code,
      details: wire.details,
      fieldErrors: wire.fieldErrors,
      retryable: wire.retryable,
      entity: wire.entity,
    });
  }

  /**
   * Normalise anything thrown into an AppError.
   *
   * A user-facing message is always produced; raw stack traces and raw database errors are
   * never surfaced to the user, but the originating error is retained on `cause` for the
   * diagnostic log.
   */
  static fromUnknown(err: unknown, fallbackMessage = 'The operation could not be completed.'): AppError {
    if (err instanceof AppError) return err;
    if (isAppErrorWire(err)) return AppError.fromWire(err);
    if (err instanceof Error) {
      return new AppError(fallbackMessage, {
        code: 'INTERNAL',
        details: { errorName: err.name },
        retryable: true,
        cause: err,
      });
    }
    return new AppError(fallbackMessage, { code: 'INTERNAL', retryable: true, cause: err });
  }
}

export interface AppErrorWire {
  name: 'AppError';
  code: AppErrorCode;
  message: string;
  details: AppErrorDetails;
  fieldErrors: FieldErrors;
  retryable: boolean;
  entity?: { entityType: string; entityId: string };
}

export function isAppErrorWire(v: unknown): v is AppErrorWire {
  if (typeof v !== 'object' || v === null) return false;
  const w = v as Record<string, unknown>;
  return (
    w.name === 'AppError' &&
    typeof w.message === 'string' &&
    isAppErrorCode(w.code)
  );
}

export function isAppError(v: unknown): v is AppError {
  return v instanceof AppError || (typeof v === 'object' && v !== null && (v as { isAppError?: boolean }).isAppError === true && isAppErrorWire((v as AppError).toWire?.()));
}

/**
 * Strip values that must never cross the process boundary or reach a log:
 * functions, symbols, class instances with secrets, and circular references.
 */
export function sanitizeForWire(input: unknown, depth = 0): AppErrorDetails {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, level: number): unknown => {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : String(value);
    if (t === 'bigint') return String(value);
    if (t === 'function' || t === 'symbol') return '[unserializable]';
    if (level > 6) return '[depth-limit]';
    if (typeof value === 'object') {
      const obj = value as object;
      if (seen.has(obj)) return '[circular]';
      seen.add(obj);
      if (value instanceof Error) {
        return { name: value.name, message: '[redacted-internal-error]' };
      }
      if (Array.isArray(value)) return value.map((v) => walk(v, level + 1));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(k)) {
          out[k] = '[redacted]';
        } else {
          out[k] = walk(v, level + 1);
        }
      }
      return out;
    }
    return '[unserializable]';
  };
  void depth;
  return (walk(input, 0) as AppErrorDetails) ?? {};
}

/** Keys whose values must never be serialised into an error payload or a log. */
export const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|pin|pincode|credential|hash|salt|privatekey|private_key|serial|activation|signature|sessionkey)/i;

/** Redact secret-looking keys from any object before it is logged or transported. */
export function redactSecrets<T>(input: T): T {
  return sanitizeForWire(input) as unknown as T;
}

/** Convenience constructors for the most common failures. */
export const Errors = {
  validation: (message: string, fieldErrors: FieldErrors = {}, details: AppErrorDetails = {}) =>
    new AppError(message, { code: 'VALIDATION', fieldErrors, details }),
  notFound: (entityType: string, details: AppErrorDetails = {}) =>
    new AppError(`The requested ${entityType.replace(/_/g, ' ')} was not found. It may have been removed.`, {
      code: 'NOT_FOUND',
      details: { entityType, ...details },
    }),
  alreadyExists: (message: string, details: AppErrorDetails = {}) =>
    new AppError(message, { code: 'ALREADY_EXISTS', details }),
  conflict: (message: string, details: AppErrorDetails = {}) =>
    new AppError(message, { code: 'CONFLICT', details }),
  permissionDenied: (action: string) =>
    new AppError(`You do not have permission to ${action}. Contact an administrator if this is unexpected.`, {
      code: 'PERMISSION_DENIED',
      details: { action },
    }),
  unauthenticated: () =>
    new AppError('Your session has ended. Sign in again to continue.', { code: 'UNAUTHENTICATED', retryable: true }),
  sessionExpired: () =>
    new AppError('Your session expired because the application was inactive. Sign in again to continue.', {
      code: 'SESSION_EXPIRED',
      retryable: true,
    }),
  integrity: (message: string, details: AppErrorDetails = {}) =>
    new AppError(message, { code: 'INTEGRITY_VIOLATION', details }),
  internal: (message: string, cause?: unknown) =>
    new AppError(message, { code: 'INTERNAL', cause, retryable: true }),
};
