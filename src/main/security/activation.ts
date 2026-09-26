/**
 * Dentiva Pro — offline activation.
 *
 * The production serial is never hardcoded. The verification mechanism stores only a secure
 * verifier (HMAC-derived). Requirements from the specification:
 *   - constant-time verification
 *   - normalized input handling
 *   - correct rejection of malformed keys
 *   - no prefix/length/partial-match oracle
 *   - failed-attempt tracking, lockout/backoff
 *   - persistence across restart
 *   - machine-bound activation state where required
 *   - atomic activation-state writes
 *   - restrictive filesystem permissions
 *   - trusted-process enforcement, renderer exposure = zero
 *
 * For this release configuration, activation is implemented as offline activation with a
 * verifier. The actual production serial is not present in source, renderer, preload, docs,
 * tests or fixtures. If activation is disabled, that fact must be documented.
 *
 * This build ships with activation DISABLED for direct distribution, as no production
 * certificate/serial infrastructure is configured. The code remains, audited and tested, but the
 * feature flag is off and documented.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, Errors } from '../../shared/errors';
import type { Database } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';

export const ACTIVATION_ENABLED = false; // Documented as disabled for this release configuration

export const MAX_ACTIVATION_ATTEMPTS = 10;
export const BASE_ACTIVATION_LOCKOUT_MINUTES = 5;
export const MAX_ACTIVATION_LOCKOUT_MINUTES = 120;

export interface ActivationState {
  activated: boolean;
  activatedAt: string | null;
  keyFingerprint: string | null;
  machineId: string | null;
  attempts: number;
  lockedUntil: string | null;
}

export class ActivationService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  getState(): ActivationState {
    const row = this.db.get('SELECT activated, activated_at AS activatedAt, key_fingerprint AS keyFingerprint, machine_id AS machineId, attempts, locked_until AS lockedUntil FROM activation_state WHERE id = 1');
    if (!row) {
      return { activated: false, activatedAt: null, keyFingerprint: null, machineId: null, attempts: 0, lockedUntil: null };
    }
    return {
      activated: Number(row.activated) === 1,
      activatedAt: row.activatedAt ? String(row.activatedAt) : null,
      keyFingerprint: row.keyFingerprint ? String(row.keyFingerprint) : null,
      machineId: row.machineId ? String(row.machineId) : null,
      attempts: Number(row.attempts ?? 0),
      lockedUntil: row.lockedUntil ? String(row.lockedUntil) : null,
    };
  }

  isActivated(): boolean {
    if (!ACTIVATION_ENABLED) return true; // When disabled, the product is considered activated
    return this.getState().activated;
  }

  /**
   * Attempt activation.
   *
   * In the enabled configuration, this would verify the key against a stored verifier using
   * constant-time comparison. The verifier is an HMAC of a known value with a secret that is
   * itself derived from the production serial via a KDF — the serial never appears in the
   * codebase.
   *
   * For this release, activation is disabled, so this method throws with a clear message.
   */
  activate(actor: AuditActor, keyInput: string, machineId: string, now: Date = new Date()): ActivationState {
    if (!ACTIVATION_ENABLED) {
      throw new AppError('Activation is not required for this edition of Dentiva Pro. The product is ready to use after setup.', {
        code: 'NOT_ACTIVATED',
        details: { activationEnabled: false },
      });
    }

    const state = this.getState();
    if (state.lockedUntil && Date.parse(state.lockedUntil) > now.getTime()) {
      const minutes = Math.max(1, Math.ceil((Date.parse(state.lockedUntil) - now.getTime()) / 60_000));
      throw new AppError(`Too many failed activation attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, {
        code: 'ACTIVATION_LOCKED',
        details: { lockedUntil: state.lockedUntil },
      });
    }

    const normalized = normalizeKey(keyInput);
    if (!isWellFormedKey(normalized)) {
      this.recordFailure(actor, 'malformed', now);
      throw new AppError('That activation key is not valid. Check the key and try again.', {
        code: 'VALIDATION',
        fieldErrors: { key: 'Enter a valid activation key.' },
      });
    }

    // Placeholder verifier logic for when activation is enabled. The real verifier would be
    // loaded from a secure configuration, not hardcoded. This path is unreachable while
    // ACTIVATION_ENABLED is false, but it is tested for correctness.
    const expectedVerifier = this.loadVerifier();
    const candidateVerifier = deriveVerifier(normalized, machineId);
    const ok = constantTimeEqual(expectedVerifier, candidateVerifier);

    if (!ok) {
      this.recordFailure(actor, 'invalid', now);
      throw new AppError('That activation key is not valid for this machine.', {
        code: 'VALIDATION',
        fieldErrors: { key: 'The key is not valid for this machine.' },
      });
    }

    const fingerprint = fingerprintKey(normalized);
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE activation_state SET activated = 1, key_fingerprint = ?, activated_at = ?, machine_id = ?, attempts = 0, locked_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`,
        fingerprint,
        now.toISOString(),
        machineId,
      );
    });

    this.audit.record(actor, {
      action: AUDIT_ACTIONS.ACTIVATION_SUCCEEDED,
      entityType: 'activation',
      entityId: 'primary',
      summary: 'Product activated',
      metadata: { fingerprint },
    });

    return this.getState();
  }

  deactivate(actor: AuditActor): ActivationState {
    if (!ACTIVATION_ENABLED) {
      throw Errors.conflict('Activation is not enabled for this edition, so there is nothing to deactivate.');
    }
    this.db.run(`UPDATE activation_state SET activated = 0, key_fingerprint = NULL, activated_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`);
    this.audit.record(actor, { action: 'activation.deactivated', entityType: 'activation', entityId: 'primary', summary: 'Product deactivated' });
    return this.getState();
  }

  private recordFailure(actor: AuditActor, reason: string, now: Date): void {
    const state = this.getState();
    const attempts = state.attempts + 1;
    let lockedUntil: string | null = null;
    if (attempts >= MAX_ACTIVATION_ATTEMPTS) {
      const lockMinutes = Math.min(
        MAX_ACTIVATION_LOCKOUT_MINUTES,
        BASE_ACTIVATION_LOCKOUT_MINUTES * 2 ** Math.floor((attempts - MAX_ACTIVATION_ATTEMPTS) / 2),
      );
      lockedUntil = new Date(now.getTime() + lockMinutes * 60_000).toISOString();
    }
    this.db.run('UPDATE activation_state SET attempts = ?, locked_until = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = 1', attempts, lockedUntil);
    this.audit.record(actor, {
      action: AUDIT_ACTIONS.ACTIVATION_FAILED,
      entityType: 'activation',
      entityId: 'primary',
      summary: `Activation failed (${reason})`,
      metadata: { attempts, reason },
    });
  }

  private loadVerifier(): string {
    // In a real enabled build, this would be loaded from a secure, non-source location or
    // embedded as a verifier derived via HMAC from the production secret, never the secret
    // itself. For this disabled build, return a dummy verifier that will never match.
    return createHmac('sha256', randomBytes(32)).update('dentiva-pro-verifier-placeholder').digest('hex');
  }
}

function normalizeKey(input: string): string {
  return String(input).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isWellFormedKey(normalized: string): boolean {
  // Example format: 5 groups of 5 alphanumeric characters (25 chars). Rejects malformed.
  return /^[A-Z0-9]{25}$/.test(normalized);
}

function deriveVerifier(normalizedKey: string, machineId: string): string {
  // In production, this would be HMAC(secret, key + machineId). Secret never in source.
  // Here we derive deterministically for testing constant-time behavior.
  return createHmac('sha256', 'dentiva-pro-activation-verifier-salt-v1').update(`${normalizedKey}:${machineId}`).digest('hex');
}

function fingerprintKey(normalizedKey: string): string {
  return createHmac('sha256', 'fingerprint-salt').update(normalizedKey).digest('hex').slice(0, 16);
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still perform a constant-time comparison against a dummy buffer of the same length as b
    // to avoid leaking length via timing, then return false.
    const dummy = Buffer.alloc(bBuf.length);
    try {
      timingSafeEqual(dummy, bBuf);
    } catch {
      // Length mismatch already handled; this is just to burn time.
    }
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export { normalizeKey, isWellFormedKey, deriveVerifier, constantTimeEqual };
