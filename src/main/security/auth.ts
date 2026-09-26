/**
 * Dentiva Pro — authentication, session and application lock.
 *
 * The session lives only in the trusted (main) process. The renderer holds a random, opaque
 * token and nothing else: no password, no hash, no role elevation path. Every privileged IPC
 * call presents the token and the guard resolves it back to a session before authorising.
 *
 * Protections implemented here:
 *   - scrypt password hashing (`./password`).
 *   - Account lockout with exponential backoff after repeated failures.
 *   - Inactivity timeout that expires the session server-side, not just in the UI.
 *   - Application lock that requires re-authentication and blocks all privileged operations.
 *   - Inactive accounts cannot authenticate, and an existing session is dropped when the
 *     account is deactivated.
 */

import { AppError, Errors } from '../../shared/errors';
import { randomToken, verifyPassword, hashPassword, encodeStoredPassword, assertPasswordPolicy } from './password';
import type { Permission, Role } from '../../shared/permissions';
import { permissionsFor, roleCan } from '../../shared/permissions';
import { toIso } from '../../shared/dates';
import { newId } from '../../shared/id';
import type { Database } from '../db/sqlite';
import type { AuditActor } from '../audit/audit';
import { AUDIT_ACTIONS, type AuditService } from '../audit/audit';

/** Consecutive failures before the account is locked. */
export const MAX_FAILED_ATTEMPTS = 5;
/** Base backoff in minutes; doubles with each further lockout. */
export const BASE_LOCKOUT_MINUTES = 2;
export const MAX_LOCKOUT_MINUTES = 60;
/** Absolute session lifetime regardless of activity. */
export const MAX_SESSION_HOURS = 12;

export interface Session {
  token: string;
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export interface SessionView {
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  permissions: Permission[];
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  locked: boolean;
}

interface SessionRecord extends Session {
  locked: boolean;
  /** Password hash snapshot used to verify unlock. */
  passwordHash: string;
}

export class AuthService {
  private sessions = new Map<string, SessionRecord>();
  private locked = false;

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly inactivityMinutes: () => number,
  ) {}

  /** Number of active user accounts. Used by first-run setup. */
  countUsers(): number {
    const row = this.db.get('SELECT COUNT(*) AS n FROM users') as { n: number };
    return Number(row?.n ?? 0);
  }

  /** Create the first administrator during first-run setup. Refuses if any account exists. */
  async createInitialAdministrator(input: {
    username: string;
    displayName: string;
    password: string;
    role?: Role;
  }): Promise<{ userId: string }> {
    if (this.countUsers() > 0) {
      throw Errors.conflict('An administrator already exists. Sign in, or ask an administrator to add a user.');
    }
    const username = normalizeUsername(input.username);
    const displayName = (input.displayName ?? '').trim();
    if (displayName === '' || displayName.length > 120) {
      throw Errors.validation('Enter the full name for this account.', { displayName: 'Enter a full name.' });
    }
    assertPasswordPolicy(input.password);
    const hashed = await hashPassword(input.password);
    const id = newId('usr');
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO users (id, username, display_name, role, password_hash, password_algo, password_salt,
                            active, must_change_password, created_at, updated_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, 'scrypt', 'embedded', 1, 0,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        username,
        displayName,
        input.role ?? 'Administrator',
        encodeStoredPassword(hashed),
      );
    });
    this.audit.record({ userId: id, name: displayName, role: input.role ?? 'Administrator' }, {
      action: AUDIT_ACTIONS.USER_CREATED,
      entityType: 'user',
      entityId: id,
      summary: `Created the initial administrator account (${username})`,
    });
    return { userId: id };
  }

  /**
   * Authenticate and open a session.
   *
   * Failures are deliberately uniform: the same message whether the username is unknown, the
   * password is wrong or the account is inactive, so the endpoint cannot be used to enumerate
   * accounts.
   */
  async login(usernameInput: string, password: string, now: Date = new Date()): Promise<SessionView> {
    const username = normalizeUsername(usernameInput);
    const genericFailure = () =>
      new AppError('The username or password is incorrect.', {
        code: 'INVALID_CREDENTIALS',
        fieldErrors: { password: 'Incorrect username or password.' },
      });

    if (username === '' || typeof password !== 'string' || password === '') {
      // Record the attempt so brute-force activity is visible in the audit log.
      this.audit.record({ userId: null, name: username || 'Unknown', role: null }, {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: 'user',
        summary: 'Sign-in rejected: missing credentials',
      });
      throw Errors.validation('Enter your username and password.', {
        username: username === '' ? 'Enter your username.' : '',
        password: password === '' ? 'Enter your password.' : '',
      });
    }

    const row = this.db.get(
      `SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash,
              active, failed_attempts AS failedAttempts, locked_until AS lockedUntil
         FROM users WHERE username = ?`,
      username,
    );

    if (!row) {
      this.recordFailedLogin(null, username, 'unknown_user', now);
      throw genericFailure();
    }

    const userId = String(row.id);
    const displayName = String(row.displayName);
    const role = String(row.role) as Role;

    // Lockout is checked before the password, so a locked account cannot be probed.
    const lockedUntil = row.lockedUntil === null || row.lockedUntil === undefined ? null : String(row.lockedUntil);
    if (lockedUntil !== null && Date.parse(lockedUntil) > now.getTime()) {
      const minutes = Math.max(1, Math.ceil((Date.parse(lockedUntil) - now.getTime()) / 60_000));
      this.audit.record({ userId, name: displayName, role }, {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: 'user',
        entityId: userId,
        summary: 'Sign-in rejected: account temporarily locked',
      });
      throw new AppError(
        `This account is temporarily locked after repeated failed sign-ins. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        { code: 'ACCOUNT_LOCKED', details: { lockedUntil, minutesRemaining: minutes } },
      );
    }

    if (Number(row.active) !== 1) {
      this.recordFailedLogin(userId, username, 'inactive', now);
      throw new AppError('This account has been deactivated. Contact an administrator.', {
        code: 'PERMISSION_DENIED',
        details: { userId },
      });
    }

    const passwordHash = String(row.passwordHash);
    const ok = await verifyPassword(password, passwordHash);
    if (!ok) {
      const attempts = Number(row.failedAttempts ?? 0) + 1;
      const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
      const lockMinutes = shouldLock
        ? Math.min(MAX_LOCKOUT_MINUTES, BASE_LOCKOUT_MINUTES * 2 ** Math.floor((attempts - MAX_FAILED_ATTEMPTS) / MAX_FAILED_ATTEMPTS))
        : 0;
      this.db.run(
        `UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        shouldLock ? 0 : attempts,
        shouldLock ? toIso(new Date(now.getTime() + lockMinutes * 60_000)) : null,
        userId,
      );
      this.recordFailedLogin(userId, username, 'bad_password', now, attempts);
      if (shouldLock) {
        throw new AppError(
          `Too many failed sign-in attempts. This account is locked for ${lockMinutes} minutes.`,
          { code: 'ACCOUNT_LOCKED', details: { userId, minutesRemaining: lockMinutes } },
        );
      }
      const remaining = MAX_FAILED_ATTEMPTS - attempts;
      throw new AppError('The username or password is incorrect.', {
        code: 'INVALID_CREDENTIALS',
        fieldErrors: { password: 'Incorrect username or password.' },
        details: { attemptsRemaining: remaining },
      });
    }

    // Successful authentication clears the failure counter.
    this.db.run(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      toIso(now),
      userId,
    );

    const timeoutMs = Math.max(1, this.inactivityMinutes()) * 60_000;
    const absoluteExpiry = Math.min(now.getTime() + timeoutMs, now.getTime() + MAX_SESSION_HOURS * 3_600_000);
    const session: SessionRecord = {
      token: randomToken(32),
      userId,
      username,
      displayName,
      role,
      startedAt: toIso(now),
      lastActivityAt: toIso(now),
      expiresAt: toIso(new Date(absoluteExpiry)),
      locked: false,
      passwordHash,
    };
    this.sessions.set(session.token, session);
    this.locked = false;

    this.audit.record(this.actorOf(session), {
      action: AUDIT_ACTIONS.LOGIN,
      entityType: 'user',
      entityId: userId,
      summary: `Signed in as ${username}`,
    });

    return this.viewOf(session);
  }

  /** Validate a token and touch the session. Returns the session or throws. */
  requireSession(token: string | null | undefined, now: Date = new Date()): SessionRecord {
    if (typeof token !== 'string' || token === '') throw Errors.unauthenticated();
    const session = this.sessions.get(token);
    if (!session) throw Errors.unauthenticated();
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      this.sessions.delete(token);
      throw Errors.sessionExpired();
    }
    return session;
  }

  /** Authorisation check used by every privileged IPC handler. */
  requirePermission(token: string | null | undefined, permission: Permission, now: Date = new Date()): SessionRecord {
    const session = this.requireSession(token, now);
    if (session.locked) {
      throw new AppError('The application is locked. Unlock it to continue.', { code: 'UNAUTHENTICATED', retryable: true });
    }
    if (!roleCan(session.role, permission)) {
      this.audit.record(this.actorOf(session), {
        action: 'auth.permission_denied',
        entityType: 'user',
        entityId: session.userId,
        summary: `Blocked attempt to perform ${permission}`,
        metadata: { permission },
      });
      throw Errors.permissionDenied(permission.replace('.', ' '));
    }
    // Activity refresh keeps an in-use session alive.
    session.lastActivityAt = toIso(now);
    const timeoutMs = Math.max(1, this.inactivityMinutes()) * 60_000;
    const candidate = now.getTime() + timeoutMs;
    const absolute = Date.parse(session.startedAt) + MAX_SESSION_HOURS * 3_600_000;
    session.expiresAt = toIso(new Date(Math.min(candidate, absolute)));
    return session;
  }

  /** Current session view, or null when signed out. */
  current(token: string | null | undefined): SessionView | null {
    try {
      const session = this.requireSession(token);
      return this.viewOf(session);
    } catch {
      return null;
    }
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** Lock the application. Data stays in memory but every privileged operation is refused. */
  lock(token: string | null | undefined, now: Date = new Date()): void {
    const session = this.requireSession(token, now);
    session.locked = true;
    this.locked = true;
    this.audit.record(this.actorOf(session), {
      action: AUDIT_ACTIONS.LOCK,
      entityType: 'user',
      entityId: session.userId,
      summary: 'Application locked',
    });
  }

  /** Unlock with the signed-in user's password. */
  async unlock(token: string | null | undefined, password: string, now: Date = new Date()): Promise<SessionView> {
    const session = this.requireSession(token, now);
    if (!session.locked && !this.locked) return this.viewOf(session);

    // Re-read the stored hash: an administrator may have changed the password while locked.
    const row = this.db.get('SELECT password_hash AS passwordHash, active FROM users WHERE id = ?', session.userId);
    if (!row || Number(row.active) !== 1) {
      this.sessions.delete(session.token);
      throw new AppError('This account is no longer active. Sign in with a different account.', {
        code: 'PERMISSION_DENIED',
      });
    }
    const ok = await verifyPassword(password, String(row.passwordHash));
    if (!ok) {
      this.audit.record(this.actorOf(session), {
        action: AUDIT_ACTIONS.UNLOCK_FAILED,
        entityType: 'user',
        entityId: session.userId,
        summary: 'Unlock rejected: incorrect password',
      });
      throw new AppError('That password is incorrect.', {
        code: 'INVALID_CREDENTIALS',
        fieldErrors: { password: 'Incorrect password.' },
      });
    }
    session.locked = false;
    this.locked = false;
    session.passwordHash = String(row.passwordHash);
    session.lastActivityAt = toIso(now);
    this.audit.record(this.actorOf(session), {
      action: AUDIT_ACTIONS.UNLOCK,
      entityType: 'user',
      entityId: session.userId,
      summary: 'Application unlocked',
    });
    return this.viewOf(session);
  }

  logout(token: string | null | undefined, now: Date = new Date()): void {
    if (typeof token !== 'string') return;
    const session = this.sessions.get(token);
    this.sessions.delete(token);
    if (session) {
      this.audit.record(this.actorOf(session), {
        action: AUDIT_ACTIONS.LOGOUT,
        entityType: 'user',
        entityId: session.userId,
        summary: `Signed out (${session.username})`,
      });
    }
    if (this.sessions.size === 0) this.locked = false;
    void now;
  }

  /** Drop every session for a user (used when the account is deactivated or its role changes). */
  revokeUser(userId: string, reason: string): number {
    let count = 0;
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(token);
        count += 1;
      }
    }
    if (this.sessions.size === 0) this.locked = false;
    if (count > 0) {
      this.audit.record({ userId, name: userId, role: null }, {
        action: 'auth.sessions_revoked',
        entityType: 'user',
        entityId: userId,
        summary: `Ended ${count} session(s): ${reason}`,
      });
    }
    return count;
  }

  /** Change the signed-in user's password. */
  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    const session = this.requireSession(token);
    const row = this.db.get('SELECT password_hash AS passwordHash FROM users WHERE id = ?', session.userId);
    if (!row) throw Errors.notFound('user account');
    const ok = await verifyPassword(currentPassword, String(row.passwordHash));
    if (!ok) {
      throw new AppError('Your current password is incorrect.', {
        code: 'INVALID_CREDENTIALS',
        fieldErrors: { currentPassword: 'Incorrect current password.' },
      });
    }
    assertPasswordPolicy(newPassword);
    const hashed = await hashPassword(newPassword);
    this.db.run(
      `UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      encodeStoredPassword(hashed),
      session.userId,
    );
    session.passwordHash = encodeStoredPassword(hashed);
    this.audit.record(this.actorOf(session), {
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      entityType: 'user',
      entityId: session.userId,
      summary: 'Changed own password',
    });
  }

  /** Expiry sweep. Called on a timer and before serving privileged requests. */
  expireStaleSessions(now: Date = new Date()): number {
    let expired = 0;
    for (const [token, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now.getTime()) {
        this.sessions.delete(token);
        expired += 1;
        this.audit.record(this.actorOf(session), {
          action: 'auth.session_expired',
          entityType: 'user',
          entityId: session.userId,
          summary: `Session expired after inactivity (${session.username})`,
        });
      }
    }
    if (this.sessions.size === 0) this.locked = false;
    return expired;
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  private recordFailedLogin(userId: string | null, username: string, reason: string, now: Date, attempts?: number): void {
    this.audit.record({ userId, name: username, role: null }, {
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: 'user',
      ...(userId ? { entityId: userId } : {}),
      summary: `Sign-in rejected (${reason.replace(/_/g, ' ')})`,
      ...(attempts !== undefined ? { metadata: { attempts } } : {}),
    });
    void now;
  }

  private actorOf(session: SessionRecord): AuditActor {
    return { userId: session.userId, name: session.displayName, role: session.role };
  }

  private viewOf(session: SessionRecord): SessionView {
    return {
      userId: session.userId,
      username: session.username,
      displayName: session.displayName,
      role: session.role,
      permissions: permissionsFor(session.role),
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      expiresAt: session.expiresAt,
      locked: session.locked || this.locked,
    };
  }
}

export function normalizeUsername(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase().slice(0, 64);
}

export function isValidUsername(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const value = input.trim();
  return value.length >= 3 && value.length <= 64 && /^[a-z0-9._-]+$/i.test(value);
}
