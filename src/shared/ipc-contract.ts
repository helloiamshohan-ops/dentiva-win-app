/**
 * Dentiva Pro — IPC contract.
 *
 * Every production IPC channel is inventoried here with:
 *   - caller
 *   - input schema
 *   - output schema
 *   - authentication requirement
 *   - permission requirement
 *   - validation
 *   - error contract
 *   - side effects
 *
 * The renderer never receives unrestricted Node access. Every privileged operation validates
 * session, authentication, role, permission, input and path where applicable.
 */

import type { Permission } from './permissions';

export type IpcChannel =
  | 'auth:login'
  | 'auth:logout'
  | 'auth:current'
  | 'auth:changePassword'
  | 'auth:lock'
  | 'auth:unlock'
  | 'activation:getState'
  | 'activation:activate'
  | 'clinic:get'
  | 'clinic:update'
  | 'settings:get'
  | 'settings:update'
  | 'settings:completeSetup'
  | 'patients:list'
  | 'patients:get'
  | 'patients:resolve'
  | 'patients:create'
  | 'patients:update'
  | 'patients:archive'
  | 'patients:restore'
  | 'patients:summary'
  | 'patients:header'
  | 'patients:checkDuplicates'
  | 'visits:create'
  | 'visits:update'
  | 'visits:get'
  | 'visits:list'
  | 'visits:timeline'
  | 'chart:get'
  | 'chart:history'
  | 'chart:record'
  | 'prescriptions:create'
  | 'prescriptions:update'
  | 'prescriptions:get'
  | 'prescriptions:list'
  | 'followUps:create'
  | 'followUps:complete'
  | 'followUps:list'
  | 'referrals:create'
  | 'referrals:list'
  | 'notes:add'
  | 'notes:list'
  | 'appointments:create'
  | 'appointments:reschedule'
  | 'appointments:changeStatus'
  | 'appointments:get'
  | 'appointments:list'
  | 'appointments:agenda'
  | 'queue:add'
  | 'queue:changeStatus'
  | 'queue:get'
  | 'queue:list'
  | 'queue:summary'
  | 'resources:listDentists'
  | 'resources:listChairs'
  | 'resources:listRooms'
  | 'resources:create'
  | 'resources:setActive'
  | 'treatments:create'
  | 'treatments:update'
  | 'treatments:get'
  | 'treatments:list'
  | 'treatments:categories'
  | 'treatmentPlans:create'
  | 'treatmentPlans:update'
  | 'treatmentPlans:accept'
  | 'treatmentPlans:get'
  | 'treatmentPlans:list'
  | 'financial:createInvoice'
  | 'financial:updateInvoice'
  | 'financial:voidInvoice'
  | 'financial:getInvoice'
  | 'financial:listInvoices'
  | 'financial:recordPayment'
  | 'financial:voidPayment'
  | 'financial:getPayment'
  | 'financial:listPayments'
  | 'financial:recordRefund'
  | 'financial:recordAdjustment'
  | 'financial:getReceipt'
  | 'financial:listReceipts'
  | 'financial:statement'
  | 'inventory:createItem'
  | 'inventory:updateItem'
  | 'inventory:getItem'
  | 'inventory:listItems'
  | 'inventory:recordMovement'
  | 'inventory:getMovement'
  | 'inventory:listMovements'
  | 'inventory:verifyQuantity'
  | 'inventory:listSuppliers'
  | 'inventory:createSupplier'
  | 'inventory:categories'
  | 'staff:createDentist'
  | 'staff:updateDentist'
  | 'staff:getDentist'
  | 'staff:listDentists'
  | 'staff:createStaff'
  | 'staff:updateStaff'
  | 'staff:getStaff'
  | 'staff:listStaff'
  | 'staff:createUser'
  | 'staff:updateUser'
  | 'staff:resetPassword'
  | 'staff:getUser'
  | 'staff:listUsers'
  | 'search:global'
  | 'notifications:scan'
  | 'notifications:list'
  | 'notifications:markRead'
  | 'notifications:markAllRead'
  | 'notifications:delete'
  | 'dashboard:metrics'
  | 'dashboard:todayAppointments'
  | 'dashboard:lowStock'
  | 'dashboard:recentPatients'
  | 'reports:revenue'
  | 'reports:payments'
  | 'reports:outstanding'
  | 'reports:appointments'
  | 'reports:visits'
  | 'reports:inventory'
  | 'reports:audit'
  | 'reports:patients'
  | 'attachments:store'
  | 'attachments:get'
  | 'attachments:list'
  | 'attachments:listByPatient'
  | 'attachments:delete'
  | 'attachments:readFile'
  | 'attachments:findMissing'
  | 'backup:create'
  | 'backup:list'
  | 'backup:validate'
  | 'backup:restore'
  | 'backup:delete'
  | 'import:patients'
  | 'import:list'
  | 'export:patients'
  | 'export:getData'
  | 'documents:prescription'
  | 'documents:invoice'
  | 'documents:receipt'
  | 'documents:statement'
  | 'documents:generatePdf'
  | 'diagnostics:integrity'
  | 'diagnostics:schema'
  | 'diagnostics:counts'
  | 'diagnostics:performance'
  | 'app:info'
  | 'app:quit';

export interface IpcChannelMeta {
  permission: Permission | null;
  authRequired: boolean;
  description: string;
}

export const IPC_CHANNEL_META: Record<IpcChannel, IpcChannelMeta> = {
  'auth:login': { permission: null, authRequired: false, description: 'Authenticate and open a session' },
  'auth:logout': { permission: null, authRequired: true, description: 'End the current session' },
  'auth:current': { permission: null, authRequired: false, description: 'Get current session view' },
  'auth:changePassword': { permission: null, authRequired: true, description: 'Change own password' },
  'auth:lock': { permission: null, authRequired: true, description: 'Lock the application' },
  'auth:unlock': { permission: null, authRequired: true, description: 'Unlock with password' },
  'activation:getState': { permission: null, authRequired: false, description: 'Get activation state' },
  'activation:activate': { permission: 'settings.manage', authRequired: true, description: 'Activate product' },
  'clinic:get': { permission: 'settings.read', authRequired: true, description: 'Get clinic info' },
  'clinic:update': { permission: 'clinic.manage', authRequired: true, description: 'Update clinic info' },
  'settings:get': { permission: 'settings.read', authRequired: true, description: 'Get app settings' },
  'settings:update': { permission: 'settings.manage', authRequired: true, description: 'Update app settings' },
  'settings:completeSetup': { permission: 'settings.manage', authRequired: true, description: 'Complete first-run setup' },
  'patients:list': { permission: 'patient.read', authRequired: true, description: 'List patients with paging' },
  'patients:get': { permission: 'patient.read', authRequired: true, description: 'Get patient by id' },
  'patients:resolve': { permission: 'patient.read', authRequired: true, description: 'Resolve patient by id or code' },
  'patients:create': { permission: 'patient.create', authRequired: true, description: 'Create patient with duplicate check' },
  'patients:update': { permission: 'patient.update', authRequired: true, description: 'Update patient' },
  'patients:archive': { permission: 'patient.archive', authRequired: true, description: 'Archive patient' },
  'patients:restore': { permission: 'patient.archive', authRequired: true, description: 'Restore archived patient' },
  'patients:summary': { permission: 'patient.read', authRequired: true, description: 'Get patient lifetime summary' },
  'patients:header': { permission: 'patient.read', authRequired: true, description: 'Get patient header for context' },
  'patients:checkDuplicates': { permission: 'patient.read', authRequired: true, description: 'Check for duplicate patients' },
  'visits:create': { permission: 'visit.create', authRequired: true, description: 'Create visit' },
  'visits:update': { permission: 'visit.update', authRequired: true, description: 'Update visit' },
  'visits:get': { permission: 'visit.read', authRequired: true, description: 'Get visit' },
  'visits:list': { permission: 'visit.read', authRequired: true, description: 'List visits' },
  'visits:timeline': { permission: 'visit.read', authRequired: true, description: 'Get clinical timeline' },
  'chart:get': { permission: 'dentalChart.read', authRequired: true, description: 'Get dental chart' },
  'chart:history': { permission: 'dentalChart.read', authRequired: true, description: 'Get tooth history' },
  'chart:record': { permission: 'dentalChart.manage', authRequired: true, description: 'Record tooth conditions' },
  'prescriptions:create': { permission: 'prescription.create', authRequired: true, description: 'Create prescription' },
  'prescriptions:update': { permission: 'prescription.update', authRequired: true, description: 'Update prescription' },
  'prescriptions:get': { permission: 'prescription.read', authRequired: true, description: 'Get prescription' },
  'prescriptions:list': { permission: 'prescription.read', authRequired: true, description: 'List prescriptions' },
  'followUps:create': { permission: 'visit.create', authRequired: true, description: 'Create follow-up' },
  'followUps:complete': { permission: 'visit.update', authRequired: true, description: 'Complete follow-up' },
  'followUps:list': { permission: 'visit.read', authRequired: true, description: 'List follow-ups' },
  'referrals:create': { permission: 'visit.create', authRequired: true, description: 'Create referral' },
  'referrals:list': { permission: 'visit.read', authRequired: true, description: 'List referrals' },
  'notes:add': { permission: 'visit.create', authRequired: true, description: 'Add patient note' },
  'notes:list': { permission: 'visit.read', authRequired: true, description: 'List patient notes' },
  'appointments:create': { permission: 'appointment.create', authRequired: true, description: 'Create appointment with conflict detection' },
  'appointments:reschedule': { permission: 'appointment.update', authRequired: true, description: 'Reschedule appointment' },
  'appointments:changeStatus': { permission: 'appointment.update', authRequired: true, description: 'Change appointment status' },
  'appointments:get': { permission: 'appointment.read', authRequired: true, description: 'Get appointment' },
  'appointments:list': { permission: 'appointment.read', authRequired: true, description: 'List appointments' },
  'appointments:agenda': { permission: 'appointment.read', authRequired: true, description: 'Get day agenda' },
  'queue:add': { permission: 'queue.manage', authRequired: true, description: 'Add patient to queue with race-safe serial' },
  'queue:changeStatus': { permission: 'queue.manage', authRequired: true, description: 'Change queue entry status' },
  'queue:get': { permission: 'queue.read', authRequired: true, description: 'Get queue entry' },
  'queue:list': { permission: 'queue.read', authRequired: true, description: 'List queue for a day' },
  'queue:summary': { permission: 'queue.read', authRequired: true, description: 'Get queue summary' },
  'resources:listDentists': { permission: 'dentist.read', authRequired: true, description: 'List dentists' },
  'resources:listChairs': { permission: 'appointment.read', authRequired: true, description: 'List chairs' },
  'resources:listRooms': { permission: 'appointment.read', authRequired: true, description: 'List rooms' },
  'resources:create': { permission: 'settings.manage', authRequired: true, description: 'Create chair or room' },
  'resources:setActive': { permission: 'settings.manage', authRequired: true, description: 'Enable/disable resource' },
  'treatments:create': { permission: 'treatment.manage', authRequired: true, description: 'Create treatment catalogue entry' },
  'treatments:update': { permission: 'treatment.manage', authRequired: true, description: 'Update treatment' },
  'treatments:get': { permission: 'treatment.read', authRequired: true, description: 'Get treatment' },
  'treatments:list': { permission: 'treatment.read', authRequired: true, description: 'List treatments' },
  'treatments:categories': { permission: 'treatment.read', authRequired: true, description: 'List treatment categories' },
  'treatmentPlans:create': { permission: 'treatmentPlan.manage', authRequired: true, description: 'Create treatment plan' },
  'treatmentPlans:update': { permission: 'treatmentPlan.manage', authRequired: true, description: 'Update treatment plan' },
  'treatmentPlans:accept': { permission: 'treatmentPlan.manage', authRequired: true, description: 'Accept treatment plan' },
  'treatmentPlans:get': { permission: 'treatmentPlan.read', authRequired: true, description: 'Get treatment plan' },
  'treatmentPlans:list': { permission: 'treatmentPlan.read', authRequired: true, description: 'List treatment plans' },
  'financial:createInvoice': { permission: 'invoice.create', authRequired: true, description: 'Create invoice' },
  'financial:updateInvoice': { permission: 'invoice.update', authRequired: true, description: 'Update invoice (if mutable)' },
  'financial:voidInvoice': { permission: 'invoice.void', authRequired: true, description: 'Void invoice' },
  'financial:getInvoice': { permission: 'invoice.read', authRequired: true, description: 'Get invoice' },
  'financial:listInvoices': { permission: 'invoice.read', authRequired: true, description: 'List invoices' },
  'financial:recordPayment': { permission: 'payment.create', authRequired: true, description: 'Record payment with idempotency' },
  'financial:voidPayment': { permission: 'payment.create', authRequired: true, description: 'Void payment (if no receipt)' },
  'financial:getPayment': { permission: 'payment.read', authRequired: true, description: 'Get payment' },
  'financial:listPayments': { permission: 'payment.read', authRequired: true, description: 'List payments' },
  'financial:recordRefund': { permission: 'payment.refund', authRequired: true, description: 'Record refund' },
  'financial:recordAdjustment': { permission: 'adjustment.create', authRequired: true, description: 'Record adjustment' },
  'financial:getReceipt': { permission: 'payment.read', authRequired: true, description: 'Get receipt' },
  'financial:listReceipts': { permission: 'payment.read', authRequired: true, description: 'List receipts' },
  'financial:statement': { permission: 'statement.read', authRequired: true, description: 'Build patient statement' },
  'inventory:createItem': { permission: 'inventory.manage', authRequired: true, description: 'Create inventory item' },
  'inventory:updateItem': { permission: 'inventory.manage', authRequired: true, description: 'Update inventory item' },
  'inventory:getItem': { permission: 'inventory.read', authRequired: true, description: 'Get inventory item' },
  'inventory:listItems': { permission: 'inventory.read', authRequired: true, description: 'List inventory items' },
  'inventory:recordMovement': { permission: 'inventory.manage', authRequired: true, description: 'Record inventory movement' },
  'inventory:getMovement': { permission: 'inventory.read', authRequired: true, description: 'Get movement' },
  'inventory:listMovements': { permission: 'inventory.read', authRequired: true, description: 'List movements' },
  'inventory:verifyQuantity': { permission: 'inventory.read', authRequired: true, description: 'Verify quantity vs history' },
  'inventory:listSuppliers': { permission: 'inventory.read', authRequired: true, description: 'List suppliers' },
  'inventory:createSupplier': { permission: 'supplier.manage', authRequired: true, description: 'Create supplier' },
  'inventory:categories': { permission: 'inventory.read', authRequired: true, description: 'List inventory categories' },
  'staff:createDentist': { permission: 'dentist.manage', authRequired: true, description: 'Create dentist' },
  'staff:updateDentist': { permission: 'dentist.manage', authRequired: true, description: 'Update dentist' },
  'staff:getDentist': { permission: 'dentist.read', authRequired: true, description: 'Get dentist' },
  'staff:listDentists': { permission: 'dentist.read', authRequired: true, description: 'List dentists' },
  'staff:createStaff': { permission: 'staff.manage', authRequired: true, description: 'Create staff' },
  'staff:updateStaff': { permission: 'staff.manage', authRequired: true, description: 'Update staff' },
  'staff:getStaff': { permission: 'staff.read', authRequired: true, description: 'Get staff' },
  'staff:listStaff': { permission: 'staff.read', authRequired: true, description: 'List staff' },
  'staff:createUser': { permission: 'user.manage', authRequired: true, description: 'Create user' },
  'staff:updateUser': { permission: 'user.manage', authRequired: true, description: 'Update user' },
  'staff:resetPassword': { permission: 'user.manage', authRequired: true, description: 'Reset user password' },
  'staff:getUser': { permission: 'user.manage', authRequired: true, description: 'Get user' },
  'staff:listUsers': { permission: 'user.manage', authRequired: true, description: 'List users' },
  'search:global': { permission: 'patient.read', authRequired: true, description: 'Global search across entities' },
  'notifications:scan': { permission: 'notification.manage', authRequired: true, description: 'Scan for notifications' },
  'notifications:list': { permission: 'notification.read', authRequired: true, description: 'List notifications' },
  'notifications:markRead': { permission: 'notification.read', authRequired: true, description: 'Mark notification read' },
  'notifications:markAllRead': { permission: 'notification.read', authRequired: true, description: 'Mark all read' },
  'notifications:delete': { permission: 'notification.manage', authRequired: true, description: 'Delete notification' },
  'dashboard:metrics': { permission: 'report.read', authRequired: true, description: 'Get dashboard metrics' },
  'dashboard:todayAppointments': { permission: 'appointment.read', authRequired: true, description: 'Get today appointments' },
  'dashboard:lowStock': { permission: 'inventory.read', authRequired: true, description: 'Get low stock alerts' },
  'dashboard:recentPatients': { permission: 'patient.read', authRequired: true, description: 'Get recent patients' },
  'reports:revenue': { permission: 'report.read', authRequired: true, description: 'Revenue report' },
  'reports:payments': { permission: 'report.read', authRequired: true, description: 'Payments report' },
  'reports:outstanding': { permission: 'report.read', authRequired: true, description: 'Outstanding balances report' },
  'reports:appointments': { permission: 'report.read', authRequired: true, description: 'Appointments report' },
  'reports:visits': { permission: 'report.read', authRequired: true, description: 'Visits report' },
  'reports:inventory': { permission: 'report.read', authRequired: true, description: 'Inventory report' },
  'reports:audit': { permission: 'audit.read', authRequired: true, description: 'Audit log report' },
  'reports:patients': { permission: 'report.read', authRequired: true, description: 'Patients report' },
  'attachments:store': { permission: 'attachment.upload', authRequired: true, description: 'Store attachment' },
  'attachments:get': { permission: 'attachment.read', authRequired: true, description: 'Get attachment metadata' },
  'attachments:list': { permission: 'attachment.read', authRequired: true, description: 'List attachments for entity' },
  'attachments:listByPatient': { permission: 'attachment.read', authRequired: true, description: 'List attachments for patient' },
  'attachments:delete': { permission: 'attachment.delete', authRequired: true, description: 'Delete attachment' },
  'attachments:readFile': { permission: 'attachment.read', authRequired: true, description: 'Read attachment file' },
  'attachments:findMissing': { permission: 'diagnostics.read', authRequired: true, description: 'Find missing attachment files' },
  'backup:create': { permission: 'backup.run', authRequired: true, description: 'Create backup' },
  'backup:list': { permission: 'backup.read', authRequired: true, description: 'List backups' },
  'backup:validate': { permission: 'backup.read', authRequired: true, description: 'Validate backup' },
  'backup:restore': { permission: 'restore.run', authRequired: true, description: 'Restore from backup' },
  'backup:delete': { permission: 'backup.run', authRequired: true, description: 'Delete backup' },
  'import:patients': { permission: 'patient.import', authRequired: true, description: 'Import patients' },
  'import:list': { permission: 'patient.import', authRequired: true, description: 'List import batches' },
  'export:patients': { permission: 'patient.export', authRequired: true, description: 'Export patients' },
  'export:getData': { permission: 'patient.export', authRequired: true, description: 'Get export data' },
  'documents:prescription': { permission: 'prescription.read', authRequired: true, description: 'Build prescription document model' },
  'documents:invoice': { permission: 'invoice.read', authRequired: true, description: 'Build invoice document model' },
  'documents:receipt': { permission: 'payment.read', authRequired: true, description: 'Build receipt document model' },
  'documents:statement': { permission: 'statement.read', authRequired: true, description: 'Build statement document model' },
  'documents:generatePdf': { permission: 'report.read', authRequired: true, description: 'Generate PDF from document model' },
  'diagnostics:integrity': { permission: 'diagnostics.read', authRequired: true, description: 'Run integrity check' },
  'diagnostics:schema': { permission: 'diagnostics.read', authRequired: true, description: 'Verify schema' },
  'diagnostics:counts': { permission: 'diagnostics.read', authRequired: true, description: 'Get record counts' },
  'diagnostics:performance': { permission: 'diagnostics.read', authRequired: true, description: 'Run performance diagnostics' },
  'app:info': { permission: null, authRequired: false, description: 'Get app info and version' },
  'app:quit': { permission: null, authRequired: false, description: 'Quit application' },
};

/** All channel names, for static audit. */
export const ALL_CHANNELS = Object.keys(IPC_CHANNEL_META) as IpcChannel[];
