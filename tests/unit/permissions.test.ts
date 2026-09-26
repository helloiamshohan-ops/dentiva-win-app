import { describe, it, expect } from 'vitest';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, roleCan, auditPermissionCoverage, isPermission, isRole } from '../../src/shared/permissions';

describe('permissions catalogue', () => {
  it('every permission is assigned to at least one role', () => {
    const { unassigned, unknownInRoles } = auditPermissionCoverage();
    expect(unassigned, `Unassigned permissions: ${unassigned.join(', ')}`).toEqual([]);
    expect(unknownInRoles, `Unknown permissions in roles: ${unknownInRoles.join(', ')}`).toEqual([]);
  });

  it('administrator has all permissions', () => {
    const adminPerms = ROLE_PERMISSIONS['Administrator'];
    expect(adminPerms.length).toBe(PERMISSIONS.length);
    for (const perm of PERMISSIONS) {
      expect(adminPerms.includes(perm), `Administrator missing ${perm}`).toBe(true);
    }
  });

  it('validates permission and role types', () => {
    expect(isPermission('patient.read')).toBe(true);
    expect(isPermission('invalid.permission')).toBe(false);
    expect(isRole('Administrator')).toBe(true);
    expect(isRole('InvalidRole')).toBe(false);
  });

  it('roleCan checks correctly', () => {
    expect(roleCan('Administrator', 'patient.read')).toBe(true);
    expect(roleCan('Dentist', 'patient.read')).toBe(true);
    expect(roleCan('Inventory Staff', 'patient.read')).toBe(false);
    expect(roleCan('Inventory Staff', 'inventory.read')).toBe(true);
    expect(roleCan('Receptionist', 'invoice.create')).toBe(true);
    expect(roleCan('Receptionist', 'inventory.manage')).toBe(false);
  });

  it('has expected roles', () => {
    expect(ROLES).toContain('Administrator');
    expect(ROLES).toContain('Dentist');
    expect(ROLES).toContain('Receptionist');
    expect(ROLES).toContain('Accountant');
    expect(ROLES).toContain('Inventory Staff');
  });
});
