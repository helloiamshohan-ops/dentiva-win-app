/**
 * Dentiva Pro — staff, dentist and user management.
 */

import { AppError, Errors } from '../../shared/errors';
import { newId } from '../../shared/id';
import { isRole, type Role } from '../../shared/permissions';
import { hashPassword, encodeStoredPassword, assertPasswordPolicy } from '../security/password';
import { isValidUsername, normalizeUsername } from '../security/auth';
import type { Database, Transaction } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';
import { int, str, strOrNull } from '../repositories/row';

export interface DentistInput {
  name: string;
  credentials?: string | null;
  designation?: string | null;
  registrationNo?: string | null;
  registrationBody?: string | null;
  specialty?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}

export interface DentistRow {
  id: string;
  name: string;
  credentials: string | null;
  designation: string | null;
  registrationNo: string | null;
  registrationBody: string | null;
  specialty: string | null;
  phone: string | null;
  email: string | null;
  signatureAttachmentId: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffInput {
  name: string;
  roleTitle?: string | null;
  department?: string | null;
  phone?: string | null;
  email?: string | null;
  userId?: string | null;
  dentistId?: string | null;
  notes?: string | null;
}

export interface StaffRow {
  id: string;
  name: string;
  roleTitle: string | null;
  department: string | null;
  phone: string | null;
  email: string | null;
  userId: string | null;
  userDisplayName: string | null;
  dentistId: string | null;
  dentistName: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserInput {
  username: string;
  displayName: string;
  role: Role;
  email?: string | null;
  phone?: string | null;
  password: string;
}

export interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  email: string | null;
  phone: string | null;
  active: boolean;
  mustChangePassword: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class StaffService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  // ── Dentists ────────────────────────────────────────────────────────────────────────────

  createDentist(actor: AuditActor, input: DentistInput): DentistRow {
    const normalized = this.normalizeDentist(input);
    const id = newId('dnt');
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO dentists (id, name, credentials, designation, registration_no, registration_body,
             specialty, phone, email, active, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        normalized.name,
        normalized.credentials,
        normalized.designation,
        normalized.registrationNo,
        normalized.registrationBody,
        normalized.specialty,
        normalized.phone,
        normalized.email,
        normalized.notes,
      );
      this.audit.record(actor, { action: 'dentist.created', entityType: 'dentist', entityId: id, summary: `Added dentist "${normalized.name}"` });
    });
    return this.getDentist(id);
  }

  updateDentist(actor: AuditActor, id: string, input: Partial<DentistInput> & { active?: boolean }): DentistRow {
    const existing = this.getDentist(id);
    const merged = { ...existing, ...input } as DentistInput & { active?: boolean };
    const normalized = this.normalizeDentist(merged);
    const active = input.active ?? existing.active;
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE dentists SET name = ?, credentials = ?, designation = ?, registration_no = ?, registration_body = ?,
             specialty = ?, phone = ?, email = ?, active = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        normalized.name,
        normalized.credentials,
        normalized.designation,
        normalized.registrationNo,
        normalized.registrationBody,
        normalized.specialty,
        normalized.phone,
        normalized.email,
        active ? 1 : 0,
        normalized.notes,
        id,
      );
      this.audit.record(actor, { action: 'dentist.updated', entityType: 'dentist', entityId: id, summary: `Updated dentist "${normalized.name}"` });
    });
    return this.getDentist(id);
  }

  getDentist(id: string): DentistRow {
    const row = this.db.get('SELECT id, name, credentials, designation, registration_no AS registrationNo, registration_body AS registrationBody, specialty, phone, email, signature_attachment_id AS signatureAttachmentId, active, notes, created_at AS createdAt, updated_at AS updatedAt FROM dentists WHERE id = ?', id);
    if (!row) throw Errors.notFound('dentist');
    return {
      id: str(row, 'id'),
      name: str(row, 'name'),
      credentials: strOrNull(row, 'credentials'),
      designation: strOrNull(row, 'designation'),
      registrationNo: strOrNull(row, 'registrationNo'),
      registrationBody: strOrNull(row, 'registrationBody'),
      specialty: strOrNull(row, 'specialty'),
      phone: strOrNull(row, 'phone'),
      email: strOrNull(row, 'email'),
      signatureAttachmentId: strOrNull(row, 'signatureAttachmentId'),
      active: int(row, 'active') === 1,
      notes: strOrNull(row, 'notes'),
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
  }

  listDentists(includeInactive = false): DentistRow[] {
    const rows = this.db.all(
      `SELECT id, name, credentials, designation, registration_no AS registrationNo, registration_body AS registrationBody,
              specialty, phone, email, signature_attachment_id AS signatureAttachmentId, active, notes,
              created_at AS createdAt, updated_at AS updatedAt
         FROM dentists ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`,
    );
    return rows.map((r) => ({
      id: str(r, 'id'),
      name: str(r, 'name'),
      credentials: strOrNull(r, 'credentials'),
      designation: strOrNull(r, 'designation'),
      registrationNo: strOrNull(r, 'registrationNo'),
      registrationBody: strOrNull(r, 'registrationBody'),
      specialty: strOrNull(r, 'specialty'),
      phone: strOrNull(r, 'phone'),
      email: strOrNull(r, 'email'),
      signatureAttachmentId: strOrNull(r, 'signatureAttachmentId'),
      active: int(r, 'active') === 1,
      notes: strOrNull(r, 'notes'),
      createdAt: str(r, 'createdAt'),
      updatedAt: str(r, 'updatedAt'),
    }));
  }

  // ── Staff ───────────────────────────────────────────────────────────────────────────────

  createStaff(actor: AuditActor, input: StaffInput): StaffRow {
    const normalized = this.normalizeStaff(input);
    const id = newId('stf');
    this.db.transaction((tx) => {
      if (normalized.userId && !tx.get('SELECT 1 AS ok FROM users WHERE id = ?', normalized.userId)) throw Errors.notFound('user');
      if (normalized.dentistId && !tx.get('SELECT 1 AS ok FROM dentists WHERE id = ?', normalized.dentistId)) throw Errors.notFound('dentist');
      tx.run(
        `INSERT INTO staff (id, name, role_title, department, phone, email, user_id, dentist_id, active, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        normalized.name,
        normalized.roleTitle,
        normalized.department,
        normalized.phone,
        normalized.email,
        normalized.userId,
        normalized.dentistId,
        normalized.notes,
      );
      this.audit.record(actor, { action: AUDIT_ACTIONS.STAFF_CREATED, entityType: 'staff', entityId: id, summary: `Added staff member "${normalized.name}"` });
    });
    return this.getStaff(id);
  }

  updateStaff(actor: AuditActor, id: string, input: Partial<StaffInput> & { active?: boolean }): StaffRow {
    const existing = this.getStaff(id);
    const merged = { ...existing, ...input } as StaffInput & { active?: boolean };
    const normalized = this.normalizeStaff(merged);
    const active = input.active ?? existing.active;
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE staff SET name = ?, role_title = ?, department = ?, phone = ?, email = ?, user_id = ?, dentist_id = ?,
             active = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        normalized.name,
        normalized.roleTitle,
        normalized.department,
        normalized.phone,
        normalized.email,
        normalized.userId,
        normalized.dentistId,
        active ? 1 : 0,
        normalized.notes,
        id,
      );
      this.audit.record(actor, { action: AUDIT_ACTIONS.STAFF_UPDATED, entityType: 'staff', entityId: id, summary: `Updated staff member "${normalized.name}"` });
    });
    return this.getStaff(id);
  }

  getStaff(id: string): StaffRow {
    const row = this.db.get(
      `SELECT s.id, s.name, s.role_title AS roleTitle, s.department, s.phone, s.email, s.user_id AS userId,
              u.display_name AS userDisplayName, s.dentist_id AS dentistId, d.name AS dentistName, s.active, s.notes,
              s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM staff s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN dentists d ON d.id = s.dentist_id WHERE s.id = ?`,
      id,
    );
    if (!row) throw Errors.notFound('staff member');
    return {
      id: str(row, 'id'),
      name: str(row, 'name'),
      roleTitle: strOrNull(row, 'roleTitle'),
      department: strOrNull(row, 'department'),
      phone: strOrNull(row, 'phone'),
      email: strOrNull(row, 'email'),
      userId: strOrNull(row, 'userId'),
      userDisplayName: strOrNull(row, 'userDisplayName'),
      dentistId: strOrNull(row, 'dentistId'),
      dentistName: strOrNull(row, 'dentistName'),
      active: int(row, 'active') === 1,
      notes: strOrNull(row, 'notes'),
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
  }

  listStaff(includeInactive = false): StaffRow[] {
    const rows = this.db.all(
      `SELECT s.id, s.name, s.role_title AS roleTitle, s.department, s.phone, s.email, s.user_id AS userId,
              u.display_name AS userDisplayName, s.dentist_id AS dentistId, d.name AS dentistName, s.active, s.notes,
              s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM staff s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN dentists d ON d.id = s.dentist_id
         ${includeInactive ? '' : 'WHERE s.active = 1'} ORDER BY s.name`,
    );
    return rows.map((r) => ({
      id: str(r, 'id'),
      name: str(r, 'name'),
      roleTitle: strOrNull(r, 'roleTitle'),
      department: strOrNull(r, 'department'),
      phone: strOrNull(r, 'phone'),
      email: strOrNull(r, 'email'),
      userId: strOrNull(r, 'userId'),
      userDisplayName: strOrNull(r, 'userDisplayName'),
      dentistId: strOrNull(r, 'dentistId'),
      dentistName: strOrNull(r, 'dentistName'),
      active: int(r, 'active') === 1,
      notes: strOrNull(r, 'notes'),
      createdAt: str(r, 'createdAt'),
      updatedAt: str(r, 'updatedAt'),
    }));
  }

  // ── Users ───────────────────────────────────────────────────────────────────────────────

  async createUser(actor: AuditActor, input: UserInput): Promise<UserRow> {
    const username = normalizeUsername(input.username);
    if (!isValidUsername(username)) throw Errors.validation('Usernames must be 3-64 characters and may contain letters, numbers, dot, underscore or hyphen.', { username: 'Enter a valid username.' });
    const displayName = input.displayName.trim();
    if (displayName === '' || displayName.length > 120) throw Errors.validation('Enter a full name of up to 120 characters.', { displayName: 'Enter a full name.' });
    if (!isRole(input.role)) throw Errors.validation('Select a valid role.', { role: 'Select a role.' });
    assertPasswordPolicy(input.password);
    if (this.db.get('SELECT 1 AS ok FROM users WHERE username = ?', username)) {
      throw Errors.alreadyExists(`A user account named "${username}" already exists.`);
    }
    const hashed = await hashPassword(input.password);
    const id = newId('usr');
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO users (id, username, display_name, role, email, phone, password_hash, password_algo, password_salt, active, must_change_password, created_at, updated_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'scrypt', 'embedded', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        username,
        displayName,
        input.role,
        input.email?.trim() || null,
        input.phone?.trim() || null,
        encodeStoredPassword(hashed),
      );
      this.audit.record(actor, { action: AUDIT_ACTIONS.USER_CREATED, entityType: 'user', entityId: id, summary: `Created user account "${username}" (${input.role})` });
    });
    return this.getUser(id);
  }

  async updateUser(actor: AuditActor, id: string, input: Partial<Omit<UserInput, 'password'>> & { active?: boolean; mustChangePassword?: boolean; role?: Role }): Promise<UserRow> {
    const existing = this.getUser(id);
    const username = input.username ? normalizeUsername(input.username) : existing.username;
    const role = input.role ?? existing.role;
    if (!isRole(role)) throw Errors.validation('Select a valid role.', { role: 'Select a role.' });
    this.db.transaction((tx) => {
      const clash = tx.get('SELECT id FROM users WHERE username = ? AND id <> ?', username, id);
      if (clash) throw Errors.alreadyExists(`Another account already uses username "${username}".`);
      tx.run(
        `UPDATE users SET username = ?, display_name = ?, role = ?, email = ?, phone = ?, active = ?,
                must_change_password = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        username,
        input.displayName?.trim() || existing.displayName,
        role,
        input.email !== undefined ? (input.email?.trim() || null) : existing.email,
        input.phone !== undefined ? (input.phone?.trim() || null) : existing.phone,
        input.active === undefined ? (existing.active ? 1 : 0) : input.active ? 1 : 0,
        input.mustChangePassword === undefined ? (existing.mustChangePassword ? 1 : 0) : input.mustChangePassword ? 1 : 0,
        id,
      );
      this.audit.record(actor, { action: AUDIT_ACTIONS.USER_UPDATED, entityType: 'user', entityId: id, summary: `Updated user account "${username}"` });
    });
    return this.getUser(id);
  }

  async resetPassword(actor: AuditActor, userId: string, newPassword: string): Promise<void> {
    assertPasswordPolicy(newPassword);
    const hashed = await hashPassword(newPassword);
    this.db.transaction((tx) => {
      if (!tx.get('SELECT 1 AS ok FROM users WHERE id = ?', userId)) throw Errors.notFound('user');
      tx.run(
        `UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL,
                password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        encodeStoredPassword(hashed),
        userId,
      );
      this.audit.record(actor, { action: AUDIT_ACTIONS.PASSWORD_CHANGED, entityType: 'user', entityId: userId, summary: 'Reset the password for an account' });
    });
  }

  getUser(id: string): UserRow {
    const row = this.db.get('SELECT id, username, display_name AS displayName, role, email, phone, active, must_change_password AS mustChangePassword, failed_attempts AS failedAttempts, locked_until AS lockedUntil, last_login_at AS lastLoginAt, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?', id);
    if (!row) throw Errors.notFound('user');
    return {
      id: str(row, 'id'),
      username: str(row, 'username'),
      displayName: str(row, 'displayName'),
      role: str(row, 'role') as Role,
      email: strOrNull(row, 'email'),
      phone: strOrNull(row, 'phone'),
      active: int(row, 'active') === 1,
      mustChangePassword: int(row, 'mustChangePassword') === 1,
      failedAttempts: int(row, 'failedAttempts'),
      lockedUntil: strOrNull(row, 'lockedUntil'),
      lastLoginAt: strOrNull(row, 'lastLoginAt'),
      createdAt: str(row, 'createdAt'),
      updatedAt: str(row, 'updatedAt'),
    };
  }

  listUsers(includeInactive = false): UserRow[] {
    const rows = this.db.all(
      `SELECT id, username, display_name AS displayName, role, email, phone, active,
              must_change_password AS mustChangePassword, failed_attempts AS failedAttempts,
              locked_until AS lockedUntil, last_login_at AS lastLoginAt, created_at AS createdAt, updated_at AS updatedAt
         FROM users ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY username`,
    );
    return rows.map((r) => ({
      id: str(r, 'id'),
      username: str(r, 'username'),
      displayName: str(r, 'displayName'),
      role: str(r, 'role') as Role,
      email: strOrNull(r, 'email'),
      phone: strOrNull(r, 'phone'),
      active: int(r, 'active') === 1,
      mustChangePassword: int(r, 'mustChangePassword') === 1,
      failedAttempts: int(r, 'failedAttempts'),
      lockedUntil: strOrNull(r, 'lockedUntil'),
      lastLoginAt: strOrNull(r, 'lastLoginAt'),
      createdAt: str(r, 'createdAt'),
      updatedAt: str(r, 'updatedAt'),
    }));
  }

  private normalizeDentist(input: DentistInput): Required<DentistInput> {
    const name = input.name.trim();
    if (name === '' || name.length > 150) throw Errors.validation('Enter a dentist name of up to 150 characters.', { name: 'Enter a name.' });
    return {
      name,
      credentials: input.credentials?.trim()?.slice(0, 200) ?? null,
      designation: input.designation?.trim()?.slice(0, 200) ?? null,
      registrationNo: input.registrationNo?.trim()?.slice(0, 100) ?? null,
      registrationBody: input.registrationBody?.trim()?.slice(0, 100) ?? null,
      specialty: input.specialty?.trim()?.slice(0, 100) ?? null,
      phone: input.phone?.trim()?.slice(0, 32) ?? null,
      email: input.email?.trim()?.slice(0, 200) ?? null,
      notes: input.notes?.trim()?.slice(0, 1000) ?? null,
    };
  }

  private normalizeStaff(input: StaffInput): Required<StaffInput> {
    const name = input.name.trim();
    if (name === '' || name.length > 150) throw Errors.validation('Enter a staff name of up to 150 characters.', { name: 'Enter a name.' });
    return {
      name,
      roleTitle: input.roleTitle?.trim()?.slice(0, 100) ?? null,
      department: input.department?.trim()?.slice(0, 100) ?? null,
      phone: input.phone?.trim()?.slice(0, 32) ?? null,
      email: input.email?.trim()?.slice(0, 200) ?? null,
      userId: input.userId ?? null,
      dentistId: input.dentistId ?? null,
      notes: input.notes?.trim()?.slice(0, 1000) ?? null,
    };
  }
}
