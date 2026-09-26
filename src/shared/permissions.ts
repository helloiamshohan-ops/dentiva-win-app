/**
 * Dentiva Pro — role based access control catalogue.
 *
 * Permissions are the single source of truth shared by:
 *   1. the trusted (main-process) IPC authorisation guard — the enforcement point,
 *   2. the renderer, which uses them only to avoid presenting actions the user cannot perform.
 *
 * Hiding a button is never treated as enforcement. Every privileged IPC channel declares the
 * permission it requires and the guard checks it against the authenticated session.
 */

export const PERMISSIONS = [
  // Patients
  'patient.read',
  'patient.create',
  'patient.update',
  'patient.archive',
  'patient.delete',
  'patient.import',
  'patient.export',
  // Clinical
  'visit.read',
  'visit.create',
  'visit.update',
  'visit.delete',
  'prescription.read',
  'prescription.create',
  'prescription.update',
  'prescription.delete',
  'treatment.read',
  'treatment.manage',
  'treatmentPlan.read',
  'treatmentPlan.manage',
  'dentalChart.read',
  'dentalChart.manage',
  'attachment.read',
  'attachment.upload',
  'attachment.delete',
  // Scheduling
  'appointment.read',
  'appointment.create',
  'appointment.update',
  'appointment.delete',
  'queue.read',
  'queue.manage',
  // Financial
  'invoice.read',
  'invoice.create',
  'invoice.update',
  'invoice.void',
  'payment.read',
  'payment.create',
  'payment.refund',
  'adjustment.create',
  'statement.read',
  'accounting.read',
  'expense.manage',
  // Inventory
  'inventory.read',
  'inventory.manage',
  'inventory.adjust',
  'supplier.manage',
  // People
  'dentist.read',
  'dentist.manage',
  'staff.read',
  'staff.manage',
  // System
  'report.read',
  'audit.read',
  'notification.read',
  'notification.manage',
  'settings.read',
  'settings.manage',
  'clinic.manage',
  'backup.run',
  'backup.read',
  'restore.run',
  'diagnostics.read',
  'user.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

export const ROLES = [
  'Administrator',
  'Dentist',
  'Assistant',
  'Receptionist',
  'Accountant',
  'Inventory Staff',
] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

const ALL = [...PERMISSIONS];

/** Read-only clinical access shared by several roles. */
const CLINICAL_READ: Permission[] = [
  'patient.read',
  'visit.read',
  'prescription.read',
  'treatment.read',
  'treatmentPlan.read',
  'dentalChart.read',
  'attachment.read',
  'appointment.read',
  'queue.read',
  'dentist.read',
  'notification.read',
  'report.read',
  'statement.read',
  'invoice.read',
  'payment.read',
  'inventory.read',
  'staff.read',
];

/** Full clinical authoring rights. */
const CLINICAL_WRITE: Permission[] = [
  'visit.create',
  'visit.update',
  'prescription.create',
  'prescription.update',
  'treatmentPlan.manage',
  'dentalChart.manage',
  'attachment.upload',
  'appointment.create',
  'appointment.update',
  'queue.manage',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  Administrator: ALL,

  Dentist: [
    ...CLINICAL_READ,
    ...CLINICAL_WRITE,
    'patient.create',
    'patient.update',
    'visit.delete',
    'prescription.delete',
    'treatment.manage',
  ],

  Assistant: [
    ...CLINICAL_READ,
    ...CLINICAL_WRITE,
    'patient.create',
    'patient.update',
  ],

  Receptionist: [
    ...CLINICAL_READ,
    'patient.create',
    'patient.update',
    'patient.export',
    'appointment.create',
    'appointment.update',
    'appointment.delete',
    'queue.manage',
    'invoice.read',
    'invoice.create',
    'invoice.update',
    'payment.read',
    'payment.create',
    'statement.read',
    'attachment.upload',
  ],

  Accountant: [
    ...CLINICAL_READ,
    'invoice.create',
    'invoice.update',
    'invoice.void',
    'payment.create',
    'payment.refund',
    'adjustment.create',
    'accounting.read',
    'expense.manage',
    'patient.export',
    'report.read',
  ],

  'Inventory Staff': [
    'inventory.read',
    'inventory.manage',
    'inventory.adjust',
    'supplier.manage',
    'report.read',
    'notification.read',
  ],
};

/** Roles that may see financial amounts. Clinical-only roles do not. */
export const ROLES_WITH_FINANCIAL_VISIBILITY: Role[] = [
  'Administrator',
  'Receptionist',
  'Accountant',
];

export function roleCan(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Every permission must be granted to at least one role, otherwise it is dead configuration. */
export function auditPermissionCoverage(): { unassigned: Permission[]; unknownInRoles: string[] } {
  const assigned = new Set<Permission>();
  for (const role of ROLES) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) assigned.add(permission);
  }
  const unassigned = PERMISSIONS.filter((p) => !assigned.has(p));
  const known = new Set<string>(PERMISSIONS);
  const unknownInRoles: string[] = [];
  for (const role of ROLES) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) {
      if (!known.has(permission)) unknownInRoles.push(`${role}:${permission}`);
    }
  }
  return { unassigned, unknownInRoles };
}
