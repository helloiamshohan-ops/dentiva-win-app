/**
 * Dentiva Pro — password hashing and verification.
 *
 * Uses scrypt (RFC 7914) from the Node standard library. Passwords are never stored, logged or
 * transported in plaintext, and the verification is constant-time so response timing does not
 * reveal whether an account exists.
 *
 * Stored format: `scrypt$N$r$p$saltHex$hashHex`. The parameters travel with the hash so they can
 * be strengthened later without invalidating existing accounts.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '../../shared/errors';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** scrypt cost parameters. N=2^15 keeps interactive login under ~150 ms on clinic hardware. */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
export const KEY_LENGTH = 64;
export const SALT_LENGTH = 16;
export const ALGORITHM = 'scrypt';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

export interface HashedPassword {
  hash: string;
  salt: string;
  algorithm: string;
}

export class PasswordPolicyError extends AppError {
  constructor(message: string, fieldErrors: Record<string, string>) {
    super(message, { code: 'VALIDATION', fieldErrors });
    this.name = 'PasswordPolicyError';
  }
}

/**
 * Validate a password against the clinic policy.
 *
 * The rules are deliberately achievable for non-technical clinic staff while still preventing
 * the trivially guessable passwords that dominate real-world breaches.
 */
export function assertPasswordPolicy(password: unknown): string {
  if (typeof password !== 'string') {
    throw new PasswordPolicyError('Enter a password.', { password: 'Enter a password.' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`, {
      password: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Passwords must be ${MAX_PASSWORD_LENGTH} characters or fewer.`, {
      password: `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`,
    });
  }
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const kinds = [hasLower, hasUpper, hasDigit].filter(Boolean).length;
  if (kinds < 2) {
    throw new PasswordPolicyError(
      'Use a mix of uppercase letters, lowercase letters and numbers.',
      { password: 'Use a mix of uppercase, lowercase and numbers.' },
    );
  }
  const common = ['password', '12345678', 'qwerty', 'dentiva', 'admin123', '11111111', 'abcdefgh'];
  const lowered = password.toLowerCase();
  if (common.some((c) => lowered === c || lowered.includes(c))) {
    throw new PasswordPolicyError('That password is too common to be safe. Choose something less predictable.', {
      password: 'Choose a less common password.',
    });
  }
  return password;
}

/** Hash a password for storage. */
export async function hashPassword(password: string): Promise<HashedPassword> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 256 * 1024 * 1024,
  });
  return {
    hash: derived.toString('hex'),
    salt: salt.toString('hex'),
    algorithm: ALGORITHM,
  };
}

/** Format a hash for the `password_hash` column. */
export function encodeStoredPassword(hashed: HashedPassword): string {
  return `${ALGORITHM}$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${hashed.salt}$${hashed.hash}`;
}

export interface DecodedPassword {
  algorithm: string;
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** Parse a stored password. Rejects malformed values instead of treating them as "no match". */
export function decodeStoredPassword(stored: string): DecodedPassword {
  const parts = String(stored).split('$');
  if (parts.length !== 6) {
    throw new AppError('Stored credential is malformed and cannot be verified. Reset the password for this account.', {
      code: 'INVALID_CREDENTIALS',
      details: { reason: 'malformed_format' },
    });
  }
  const [algorithm, nStr, rStr, pStr, saltHex, hashHex] = parts as [string, string, string, string, string, string];
  if (algorithm !== ALGORITHM) {
    throw new AppError('Stored credential uses an unsupported algorithm. Reset the password for this account.', {
      code: 'INVALID_CREDENTIALS',
      details: { reason: 'unsupported_algorithm' },
    });
  }
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || N < 1024) {
    throw new AppError('Stored credential has invalid cost parameters. Reset the password for this account.', {
      code: 'INVALID_CREDENTIALS',
      details: { reason: 'invalid_parameters' },
    });
  }
  const salt = Buffer.from(saltHex, 'hex');
  const hash = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || hash.length === 0) {
    throw new AppError('Stored credential is corrupt. Reset the password for this account.', {
      code: 'INVALID_CREDENTIALS',
      details: { reason: 'corrupt_value' },
    });
  }
  return { algorithm, N, r, p, salt, hash };
}

/**
 * Verify a password against a stored hash.
 *
 * Always performs a full derivation, even when the stored value is malformed, so an attacker
 * cannot use response time to enumerate which usernames exist.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  let decoded: DecodedPassword;
  try {
    decoded = decodeStoredPassword(stored);
  } catch {
    // Burn comparable time, then reject.
    await scrypt(password.normalize('NFKC'), randomBytes(SALT_LENGTH), KEY_LENGTH, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: 256 * 1024 * 1024,
    });
    return false;
  }
  const derived = await scrypt(password.normalize('NFKC'), decoded.salt, decoded.hash.length, {
    N: decoded.N,
    r: decoded.r,
    p: decoded.p,
    maxmem: 256 * 1024 * 1024,
  });
  if (derived.length !== decoded.hash.length) return false;
  return timingSafeEqual(derived, decoded.hash);
}

/** Whether a stored hash was produced with parameters weaker than the current policy. */
export function needsRehash(stored: string): boolean {
  try {
    const decoded = decodeStoredPassword(stored);
    return decoded.N < SCRYPT_PARAMS.N || decoded.r < SCRYPT_PARAMS.r || decoded.p < SCRYPT_PARAMS.p;
  } catch {
    return true;
  }
}

/** Generate a random token for sessions and idempotency keys. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
