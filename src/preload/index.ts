/**
 * Dentiva Pro — secure preload.
 *
 * Exposes a minimal, typed API to the renderer. No Node.js, no Electron, no filesystem access
 * is exposed directly. Every call goes through the IPC guard in the main process, which
 * enforces authentication, RBAC and validation.
 *
 * The renderer holds only an opaque session token. The token is stored in memory, never in
 * localStorage, so it does not survive a restart and cannot be exfiltrated via XSS from storage.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel } from '../shared/ipc-contract';
import type { AppErrorWire } from '../shared/errors';

export interface IpcResponse<T> {
  ok: true;
  data: T;
}

export interface IpcErrorResponse {
  ok: false;
  error: AppErrorWire;
}

export type IpcResult<T> = IpcResponse<T> | IpcErrorResponse;

async function invoke<T>(channel: IpcChannel, input: Record<string, unknown> = {}): Promise<T> {
  const token = sessionToken;
  const payload = token ? { ...input, _token: token } : input;
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  if (!result.ok) {
    // Preserve structured error details
    const error = new Error(result.error.message) as Error & { code?: string; details?: unknown; fieldErrors?: Record<string, string>; wire?: AppErrorWire };
    error.code = result.error.code;
    error.details = result.error.details;
    error.fieldErrors = result.error.fieldErrors;
    error.wire = result.error;
    throw error;
  }
  return result.data;
}

let sessionToken: string | null = null;

export const api = {
  // Token management (in-memory only)
  setToken(token: string | null) {
    sessionToken = token;
  },
  getToken(): string | null {
    return sessionToken;
  },

  // Auth
  auth: {
    login: (username: string, password: string) => invoke<{ token: string; userId: string; username: string; displayName: string; role: string; permissions: string[]; locked: boolean }>('auth:login', { username, password } as never),
    logout: () => invoke('auth:logout'),
    current: () => invoke('auth:current'),
    changePassword: (currentPassword: string, newPassword: string) => invoke('auth:changePassword', { currentPassword, newPassword } as never),
    lock: () => invoke('auth:lock'),
    unlock: (password: string) => invoke('auth:unlock', { password } as never),
  },

  // Activation
  activation: {
    getState: () => invoke('activation:getState'),
    activate: (key: string, machineId: string) => invoke('activation:activate', { key, machineId } as never),
  },

  // Clinic & Settings
  clinic: {
    get: () => invoke('clinic:get'),
    update: (data: Record<string, unknown>) => invoke('clinic:update', { data } as never),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (data: Record<string, unknown>) => invoke('settings:update', { data } as never),
    completeSetup: () => invoke('settings:completeSetup'),
  },

  // Patients
  patients: {
    list: (query: Record<string, unknown>) => invoke('patients:list', { query } as never),
    get: (id: string) => invoke('patients:get', { id } as never),
    resolve: (reference: string) => invoke('patients:resolve', { reference } as never),
    create: (data: Record<string, unknown>, acknowledgeDuplicate?: boolean) => invoke('patients:create', { data, acknowledgeDuplicate } as never),
    update: (id: string, data: Record<string, unknown>) => invoke('patients:update', { id, data } as never),
    archive: (id: string, reason: string) => invoke('patients:archive', { id, reason } as never),
    restore: (id: string) => invoke('patients:restore', { id } as never),
    summary: (id: string) => invoke('patients:summary', { id } as never),
    header: (id: string) => invoke('patients:header', { id } as never),
    checkDuplicates: (data: { name: string; phone: string | null; email: string | null; dobKey: string | null }, excludeId?: string | null) =>
      invoke('patients:checkDuplicates', { data, excludeId } as never),
  },

  // Visits
  visits: {
    create: (data: Record<string, unknown>) => invoke('visits:create', { data } as never),
    update: (id: string, data: Record<string, unknown>) => invoke('visits:update', { id, data } as never),
    get: (id: string) => invoke('visits:get', { id } as never),
    list: (params: Record<string, unknown>) => invoke('visits:list', { params } as never),
    timeline: (patientId: string, limit: number, offset: number) => invoke('visits:timeline', { patientId, limit, offset } as never),
  },

  // Dental chart
  chart: {
    get: (patientId: string) => invoke('chart:get', { patientId } as never),
    history: (patientId: string, toothNumber: number) => invoke('chart:history', { patientId, toothNumber } as never),
    record: (patientId: string, conditions: Record<string, unknown>[]) => invoke('chart:record', { patientId, conditions } as never),
  },

  // Prescriptions
  prescriptions: {
    create: (data: Record<string, unknown>) => invoke('prescriptions:create', { data } as never),
    update: (id: string, data: Record<string, unknown>) => invoke('prescriptions:update', { id, data } as never),
    get: (id: string) => invoke('prescriptions:get', { id } as never),
    list: (params: Record<string, unknown>) => invoke('prescriptions:list', { params } as never),
  },

  // Follow-ups, referrals, notes
  followUps: {
    create: (data: Record<string, unknown>) => invoke('followUps:create', { data } as never),
    complete: (id: string) => invoke('followUps:complete', { id } as never),
    list: (params: Record<string, unknown>) => invoke('followUps:list', { params } as never),
  },
  referrals: {
    create: (data: Record<string, unknown>) => invoke('referrals:create', { data } as never),
    list: (patientId: string) => invoke('referrals:list', { patientId } as never),
  },
  notes: {
    add: (patientId: string, body: string, pinned?: boolean) => invoke('notes:add', { patientId, body, pinned } as never),
    list: (patientId: string, limit?: number, offset?: number) => invoke('notes:list', { patientId, limit, offset } as never),
  },

  // Appointments
  appointments: {
    create: (data: Record<string, unknown>) => invoke('appointments:create', { data } as never),
    reschedule: (id: string, data: Record<string, unknown>) => invoke('appointments:reschedule', { id, data } as never),
    changeStatus: (id: string, status: string, reason?: string | null) => invoke('appointments:changeStatus', { id, status, reason } as never),
    get: (id: string) => invoke('appointments:get', { id } as never),
    list: (params: Record<string, unknown>) => invoke('appointments:list', { params } as never),
    agenda: (dateKey: string) => invoke('appointments:agenda', { dateKey } as never),
  },

  // Queue
  queue: {
    add: (data: Record<string, unknown>) => invoke('queue:add', { data } as never),
    changeStatus: (id: string, status: string) => invoke('queue:changeStatus', { id, status } as never),
    get: (id: string) => invoke('queue:get', { id } as never),
    list: (params: Record<string, unknown>) => invoke('queue:list', { params } as never),
    summary: (dateKey?: string | null) => invoke('queue:summary', { dateKey } as never),
  },

  // Resources
  resources: {
    listDentists: (includeInactive?: boolean) => invoke('resources:listDentists', { includeInactive } as never),
    listChairs: (includeInactive?: boolean) => invoke('resources:listChairs', { includeInactive } as never),
    listRooms: (includeInactive?: boolean) => invoke('resources:listRooms', { includeInactive } as never),
    create: (kind: 'chair' | 'room', name: string) => invoke('resources:create', { kind, name } as never),
    setActive: (kind: 'chair' | 'room', id: string, active: boolean) => invoke('resources:setActive', { kind, id, active } as never),
  },

  // Treatments
  treatments: {
    create: (data: Record<string, unknown>) => invoke('treatments:create', { data } as never),
    update: (id: string, data: Record<string, unknown>) => invoke('treatments:update', { id, data } as never),
    get: (id: string) => invoke('treatments:get', { id } as never),
    list: (params: Record<string, unknown>) => invoke('treatments:list', { params } as never),
    categories: () => invoke('treatments:categories'),
  },
  treatmentPlans: {
    create: (data: Record<string, unknown>) => invoke('treatmentPlans:create', { data } as never),
    update: (id: string, data: Record<string, unknown>) => invoke('treatmentPlans:update', { id, data } as never),
    accept: (id: string) => invoke('treatmentPlans:accept', { id } as never),
    get: (id: string) => invoke('treatmentPlans:get', { id } as never),
    list: (params: Record<string, unknown>) => invoke('treatmentPlans:list', { params } as never),
  },

  // Financial
  financial: {
    createInvoice: (data: Record<string, unknown>, idempotencyKey?: string) => invoke('financial:createInvoice', { data, idempotencyKey } as never),
    updateInvoice: (id: string, data: Record<string, unknown>) => invoke('financial:updateInvoice', { id, data } as never),
    voidInvoice: (id: string, reason: string) => invoke('financial:voidInvoice', { id, reason } as never),
    getInvoice: (id: string) => invoke('financial:getInvoice', { id } as never),
    listInvoices: (params: Record<string, unknown>) => invoke('financial:listInvoices', { params } as never),
    recordPayment: (data: Record<string, unknown>, idempotencyKey: string) => invoke('financial:recordPayment', { data, idempotencyKey } as never),
    voidPayment: (id: string, reason: string) => invoke('financial:voidPayment', { id, reason } as never),
    getPayment: (id: string) => invoke('financial:getPayment', { id } as never),
    listPayments: (params: Record<string, unknown>) => invoke('financial:listPayments', { params } as never),
    recordRefund: (data: Record<string, unknown>, idempotencyKey: string) => invoke('financial:recordRefund', { data, idempotencyKey } as never),
    recordAdjustment: (data: Record<string, unknown>, idempotencyKey: string) => invoke('financial:recordAdjustment', { data, idempotencyKey } as never),
    getReceipt: (id: string) => invoke('financial:getReceipt', { id } as never),
    listReceipts: (params: Record<string, unknown>) => invoke('financial:listReceipts', { params } as never),
    statement: (patientId: string, fromKey?: string | null, toKey?: string | null, openingMinor?: number) =>
      invoke('financial:statement', { patientId, fromKey, toKey, openingMinor } as never),
  },

  // Inventory
  inventory: {
    createItem: (data: Record<string, unknown>) => invoke('inventory:createItem', { data } as never),
    updateItem: (id: string, data: Record<string, unknown>) => invoke('inventory:updateItem', { id, data } as never),
    getItem: (id: string) => invoke('inventory:getItem', { id } as never),
    listItems: (params: Record<string, unknown>) => invoke('inventory:listItems', { params } as never),
    recordMovement: (itemId: string, data: Record<string, unknown>) => invoke('inventory:recordMovement', { itemId, data } as never),
    getMovement: (id: string) => invoke('inventory:getMovement', { id } as never),
    listMovements: (itemId: string, limit: number, offset: number) => invoke('inventory:listMovements', { itemId, limit, offset } as never),
    verifyQuantity: (itemId: string) => invoke('inventory:verifyQuantity', { itemId } as never),
    listSuppliers: () => invoke('inventory:listSuppliers'),
    createSupplier: (data: Record<string, unknown>) => invoke('inventory:createSupplier', { data } as never),
    categories: () => invoke('inventory:categories'),
  },

  // Staff
  staff: {
    createDentist: (data: Record<string, unknown>) => invoke('staff:createDentist', { data } as never),
    updateDentist: (id: string, data: Record<string, unknown>) => invoke('staff:updateDentist', { id, data } as never),
    getDentist: (id: string) => invoke('staff:getDentist', { id } as never),
    listDentists: (includeInactive?: boolean) => invoke('staff:listDentists', { includeInactive } as never),
    createStaff: (data: Record<string, unknown>) => invoke('staff:createStaff', { data } as never),
    updateStaff: (id: string, data: Record<string, unknown>) => invoke('staff:updateStaff', { id, data } as never),
    getStaff: (id: string) => invoke('staff:getStaff', { id } as never),
    listStaff: (includeInactive?: boolean) => invoke('staff:listStaff', { includeInactive } as never),
    createUser: (data: Record<string, unknown>) => invoke('staff:createUser', { data } as never),
    updateUser: (id: string, data: Record<string, unknown>) => invoke('staff:updateUser', { id, data } as never),
    resetPassword: (userId: string, newPassword: string) => invoke('staff:resetPassword', { userId, newPassword } as never),
    getUser: (id: string) => invoke('staff:getUser', { id } as never),
    listUsers: (includeInactive?: boolean) => invoke('staff:listUsers', { includeInactive } as never),
  },

  // Search
  search: {
    global: (query: string, kinds?: string[], limit?: number) => invoke('search:global', { query, kinds, limit: limit ?? 20 } as never),
  },

  // Notifications
  notifications: {
    scan: () => invoke('notifications:scan'),
    list: (params: Record<string, unknown>) => invoke('notifications:list', { params } as never),
    markRead: (id: string) => invoke('notifications:markRead', { id } as never),
    markAllRead: () => invoke('notifications:markAllRead'),
    delete: (id: string) => invoke('notifications:delete', { id } as never),
  },

  // Dashboard
  dashboard: {
    metrics: () => invoke('dashboard:metrics'),
    todayAppointments: (limit?: number) => invoke('dashboard:todayAppointments', { limit } as never),
    lowStock: (limit?: number) => invoke('dashboard:lowStock', { limit } as never),
    recentPatients: (limit?: number) => invoke('dashboard:recentPatients', { limit } as never),
  },

  // Reports
  reports: {
    revenue: (params: Record<string, unknown>) => invoke('reports:revenue', { params } as never),
    payments: (params: Record<string, unknown>) => invoke('reports:payments', { params } as never),
    outstanding: (params: Record<string, unknown>) => invoke('reports:outstanding', { params } as never),
    appointments: (params: Record<string, unknown>) => invoke('reports:appointments', { params } as never),
    visits: (params: Record<string, unknown>) => invoke('reports:visits', { params } as never),
    inventory: (params: Record<string, unknown>) => invoke('reports:inventory', { params } as never),
    audit: (params: Record<string, unknown>) => invoke('reports:audit', { params } as never),
    patients: (params: Record<string, unknown>) => invoke('reports:patients', { params } as never),
  },

  // Attachments
  attachments: {
    store: (data: { entityType: string; entityId: string; patientId?: string | null; fileName: string; mimeType: string; buffer: number[]; note?: string | null }) =>
      invoke('attachments:store', { data } as never),
    get: (id: string) => invoke('attachments:get', { id } as never),
    list: (entityType: string, entityId: string) => invoke('attachments:list', { entityType, entityId } as never),
    listByPatient: (patientId: string, limit: number, offset: number) => invoke('attachments:listByPatient', { patientId, limit, offset } as never),
    delete: (id: string) => invoke('attachments:delete', { id } as never),
    readFile: (id: string) => invoke('attachments:readFile', { id } as never),
    findMissing: () => invoke('attachments:findMissing'),
  },

  // Backup / Restore
  backup: {
    create: (trigger?: 'manual' | 'automatic' | 'pre_restore', notes?: string | null) => invoke('backup:create', { trigger, notes } as never),
    list: (limit?: number, offset?: number) => invoke('backup:list', { limit, offset } as never),
    validate: (path: string) => invoke('backup:validate', { path } as never),
    restore: (path: string) => invoke('backup:restore', { path } as never),
    delete: (id: string) => invoke('backup:delete', { id } as never),
  },

  // Import / Export
  import: {
    patients: (data: unknown[]) => invoke('import:patients', { data } as never),
    list: (limit?: number, offset?: number) => invoke('import:list', { limit, offset } as never),
  },
  export: {
    patients: (filter: Record<string, unknown>) => invoke('export:patients', { filter } as never),
    getData: (id: string) => invoke('export:getData', { id } as never),
  },

  // Documents
  documents: {
    prescription: (id: string) => invoke('documents:prescription', { id } as never),
    invoice: (id: string) => invoke('documents:invoice', { id } as never),
    receipt: (id: string) => invoke('documents:receipt', { id } as never),
    statement: (patientId: string, fromKey?: string | null, toKey?: string | null) => invoke('documents:statement', { patientId, fromKey, toKey } as never),
    generatePdf: (doc: Record<string, unknown>, pageSize: string, dateFormat?: string, currencySymbol?: string) =>
      invoke('documents:generatePdf', { doc, pageSize, dateFormat, currencySymbol } as never),
  },

  // Diagnostics
  diagnostics: {
    integrity: () => invoke('diagnostics:integrity'),
    schema: () => invoke('diagnostics:schema'),
    counts: () => invoke('diagnostics:counts'),
    performance: () => invoke('diagnostics:performance'),
  },

  // App
  app: {
    info: () => invoke('app:info'),
    quit: () => invoke('app:quit'),
  },

  // Event listeners
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
  off: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  },
};

// Expose to renderer
contextBridge.exposeInMainWorld('dentiva', api);

// Type for renderer
declare global {
  interface Window {
    dentiva: typeof api;
  }
}
