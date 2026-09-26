/**
 * Dentiva Pro — renderer API client.
 * Wraps window.dentiva with typed helpers and error handling.
 */

export interface ApiError extends Error {
  code?: string;
  details?: unknown;
  fieldErrors?: Record<string, string>;
  wire?: { code: string; message: string; details: Record<string, unknown>; fieldErrors: Record<string, string> };
}

function handleError(error: unknown): never {
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(String(error));
}

export const api = {
  get dentiva() {
    if (typeof window === 'undefined' || !window.dentiva) {
      throw new Error('Dentiva API not available. Are you running in Electron?');
    }
    return window.dentiva;
  },

  // Auth
  auth: {
    login: async (username: string, password: string) => {
      try {
        const result = await window.dentiva.auth.login(username, password);
        window.dentiva.setToken((result as any).token || (result as any).session?.token || '');
        // Store token from result
        const token = (result as any).token || (result as any).session?.token;
        if (token) window.dentiva.setToken(token);
        return result;
      } catch (e) { handleError(e); }
    },
    logout: async () => {
      try {
        await window.dentiva.auth.logout();
        window.dentiva.setToken(null);
      } catch (e) { handleError(e); }
    },
    current: async () => {
      try { return await window.dentiva.auth.current(); } catch (e) { handleError(e); }
    },
    lock: async () => {
      try { return await window.dentiva.auth.lock(); } catch (e) { handleError(e); }
    },
    unlock: async (password: string) => {
      try { return await window.dentiva.auth.unlock(password); } catch (e) { handleError(e); }
    },
  },

  // Patients
  patients: {
    list: async (query: any) => { try { return await window.dentiva.patients.list(query); } catch (e) { handleError(e); } },
    get: async (id: string) => { try { return await window.dentiva.patients.get(id); } catch (e) { handleError(e); } },
    resolve: async (ref: string) => { try { return await window.dentiva.patients.resolve(ref); } catch (e) { handleError(e); } },
    create: async (data: any, ack?: boolean) => { try { return await window.dentiva.patients.create(data, ack); } catch (e) { handleError(e); } },
    update: async (id: string, data: any) => { try { return await window.dentiva.patients.update(id, data); } catch (e) { handleError(e); } },
    archive: async (id: string, reason: string) => { try { return await window.dentiva.patients.archive(id, reason); } catch (e) { handleError(e); } },
    restore: async (id: string) => { try { return await window.dentiva.patients.restore(id); } catch (e) { handleError(e); } },
    summary: async (id: string) => { try { return await window.dentiva.patients.summary(id); } catch (e) { handleError(e); } },
    header: async (id: string) => { try { return await window.dentiva.patients.header(id); } catch (e) { handleError(e); } },
  },

  // Visits
  visits: {
    create: async (data: any) => { try { return await window.dentiva.visits.create(data); } catch (e) { handleError(e); } },
    update: async (id: string, data: any) => { try { return await window.dentiva.visits.update(id, data); } catch (e) { handleError(e); } },
    get: async (id: string) => { try { return await window.dentiva.visits.get(id); } catch (e) { handleError(e); } },
    list: async (params: any) => { try { return await window.dentiva.visits.list(params); } catch (e) { handleError(e); } },
    timeline: async (patientId: string, limit: number, offset: number) => { try { return await window.dentiva.visits.timeline(patientId, limit, offset); } catch (e) { handleError(e); } },
  },

  // Chart
  chart: {
    get: async (patientId: string) => { try { return await window.dentiva.chart.get(patientId); } catch (e) { handleError(e); } },
    record: async (patientId: string, conditions: any[]) => { try { return await window.dentiva.chart.record(patientId, conditions); } catch (e) { handleError(e); } },
  },

  // Prescriptions
  prescriptions: {
    create: async (data: any) => { try { return await window.dentiva.prescriptions.create(data); } catch (e) { handleError(e); } },
    update: async (id: string, data: any) => { try { return await window.dentiva.prescriptions.update(id, data); } catch (e) { handleError(e); } },
    get: async (id: string) => { try { return await window.dentiva.prescriptions.get(id); } catch (e) { handleError(e); } },
    list: async (params: any) => { try { return await window.dentiva.prescriptions.list(params); } catch (e) { handleError(e); } },
  },

  // Appointments
  appointments: {
    create: async (data: any) => { try { return await window.dentiva.appointments.create(data); } catch (e) { handleError(e); } },
    reschedule: async (id: string, data: any) => { try { return await window.dentiva.appointments.reschedule(id, data); } catch (e) { handleError(e); } },
    changeStatus: async (id: string, status: string, reason?: string | null) => { try { return await window.dentiva.appointments.changeStatus(id, status, reason); } catch (e) { handleError(e); } },
    get: async (id: string) => { try { return await window.dentiva.appointments.get(id); } catch (e) { handleError(e); } },
    list: async (params: any) => { try { return await window.dentiva.appointments.list(params); } catch (e) { handleError(e); } },
    agenda: async (dateKey: string) => { try { return await window.dentiva.appointments.agenda(dateKey); } catch (e) { handleError(e); } },
  },

  // Queue
  queue: {
    add: async (data: any) => { try { return await window.dentiva.queue.add(data); } catch (e) { handleError(e); } },
    changeStatus: async (id: string, status: string) => { try { return await window.dentiva.queue.changeStatus(id, status); } catch (e) { handleError(e); } },
    list: async (params: any) => { try { return await window.dentiva.queue.list(params); } catch (e) { handleError(e); } },
    summary: async (dateKey?: string | null) => { try { return await window.dentiva.queue.summary(dateKey); } catch (e) { handleError(e); } },
  },

  // Financial
  financial: {
    createInvoice: async (data: any) => { try { const key = `inv_${Date.now()}_${Math.random().toString(36).slice(2)}`; return await window.dentiva.financial.createInvoice(data, key); } catch (e) { handleError(e); } },
    updateInvoice: async (id: string, data: any) => { try { return await window.dentiva.financial.updateInvoice(id, data); } catch (e) { handleError(e); } },
    voidInvoice: async (id: string, reason: string) => { try { return await window.dentiva.financial.voidInvoice(id, reason); } catch (e) { handleError(e); } },
    getInvoice: async (id: string) => { try { return await window.dentiva.financial.getInvoice(id); } catch (e) { handleError(e); } },
    listInvoices: async (params: any) => { try { return await window.dentiva.financial.listInvoices(params); } catch (e) { handleError(e); } },
    recordPayment: async (data: any) => { try { const key = `pmt_${Date.now()}_${Math.random().toString(36).slice(2)}`; return await window.dentiva.financial.recordPayment(data, key); } catch (e) { handleError(e); } },
    listPayments: async (params: any) => { try { return await window.dentiva.financial.listPayments(params); } catch (e) { handleError(e); } },
    getReceipt: async (id: string) => { try { return await window.dentiva.financial.getReceipt(id); } catch (e) { handleError(e); } },
    listReceipts: async (params: any) => { try { return await window.dentiva.financial.listReceipts(params); } catch (e) { handleError(e); } },
    statement: async (patientId: string, fromKey?: string | null, toKey?: string | null) => { try { return await window.dentiva.financial.statement(patientId, fromKey, toKey); } catch (e) { handleError(e); } },
    recordRefund: async (data: any) => { try { const key = `rfd_${Date.now()}_${Math.random().toString(36).slice(2)}`; return await window.dentiva.financial.recordRefund(data, key); } catch (e) { handleError(e); } },
    recordAdjustment: async (data: any) => { try { const key = `adj_${Date.now()}_${Math.random().toString(36).slice(2)}`; return await window.dentiva.financial.recordAdjustment(data, key); } catch (e) { handleError(e); } },
  },

  // Inventory
  inventory: {
    createItem: async (data: any) => { try { return await window.dentiva.inventory.createItem(data); } catch (e) { handleError(e); } },
    updateItem: async (id: string, data: any) => { try { return await window.dentiva.inventory.updateItem(id, data); } catch (e) { handleError(e); } },
    getItem: async (id: string) => { try { return await window.dentiva.inventory.getItem(id); } catch (e) { handleError(e); } },
    listItems: async (params: any) => { try { return await window.dentiva.inventory.listItems(params); } catch (e) { handleError(e); } },
    recordMovement: async (itemId: string, data: any) => { try { return await window.dentiva.inventory.recordMovement(itemId, data); } catch (e) { handleError(e); } },
    listSuppliers: async () => { try { return await window.dentiva.inventory.listSuppliers(); } catch (e) { handleError(e); } },
    createSupplier: async (data: any) => { try { return await window.dentiva.inventory.createSupplier(data); } catch (e) { handleError(e); } },
  },

  // Treatments
  treatments: {
    create: async (data: any) => { try { return await window.dentiva.treatments.create(data); } catch (e) { handleError(e); } },
    update: async (id: string, data: any) => { try { return await window.dentiva.treatments.update(id, data); } catch (e) { handleError(e); } },
    get: async (id: string) => { try { return await window.dentiva.treatments.get(id); } catch (e) { handleError(e); } },
    list: async (params: any) => { try { return await window.dentiva.treatments.list(params); } catch (e) { handleError(e); } },
  },
  treatmentPlans: {
    create: async (data: any) => { try { return await window.dentiva.treatmentPlans.create(data); } catch (e) { handleError(e); } },
    get: async (id: string) => { try { return await window.dentiva.treatmentPlans.get(id); } catch (e) { handleError(e); } },
    list: async (params: any) => { try { return await window.dentiva.treatmentPlans.list(params); } catch (e) { handleError(e); } },
    accept: async (id: string) => { try { return await window.dentiva.treatmentPlans.accept(id); } catch (e) { handleError(e); } },
  },

  // Staff
  staff: {
    createDentist: async (data: any) => { try { return await window.dentiva.staff.createDentist(data); } catch (e) { handleError(e); } },
    listDentists: async (includeInactive?: boolean) => { try { return await window.dentiva.staff.listDentists(includeInactive); } catch (e) { handleError(e); } },
    createStaff: async (data: any) => { try { return await window.dentiva.staff.createStaff(data); } catch (e) { handleError(e); } },
    listStaff: async (includeInactive?: boolean) => { try { return await window.dentiva.staff.listStaff(includeInactive); } catch (e) { handleError(e); } },
    createUser: async (data: any) => { try { return await window.dentiva.staff.createUser(data); } catch (e) { handleError(e); } },
    listUsers: async (includeInactive?: boolean) => { try { return await window.dentiva.staff.listUsers(includeInactive); } catch (e) { handleError(e); } },
  },

  // Search
  search: {
    global: async (query: string, kinds?: string[], limit?: number) => { try { return await window.dentiva.search.global(query, kinds, limit); } catch (e) { handleError(e); } },
  },

  // Dashboard
  dashboard: {
    metrics: async () => { try { return await window.dentiva.dashboard.metrics(); } catch (e) { handleError(e); } },
    todayAppointments: async (limit?: number) => { try { return await window.dentiva.dashboard.todayAppointments(limit); } catch (e) { handleError(e); } },
    lowStock: async (limit?: number) => { try { return await window.dentiva.dashboard.lowStock(limit); } catch (e) { handleError(e); } },
    recentPatients: async (limit?: number) => { try { return await window.dentiva.dashboard.recentPatients(limit); } catch (e) { handleError(e); } },
  },

  // Reports
  reports: {
    revenue: async (params: any) => { try { return await window.dentiva.reports.revenue(params); } catch (e) { handleError(e); } },
    payments: async (params: any) => { try { return await window.dentiva.reports.payments(params); } catch (e) { handleError(e); } },
    outstanding: async (params: any) => { try { return await window.dentiva.reports.outstanding(params); } catch (e) { handleError(e); } },
    appointments: async (params: any) => { try { return await window.dentiva.reports.appointments(params); } catch (e) { handleError(e); } },
  },

  // Clinic & Settings
  clinic: {
    get: async () => { try { return await window.dentiva.clinic.get(); } catch (e) { handleError(e); } },
    update: async (data: any) => { try { return await window.dentiva.clinic.update(data); } catch (e) { handleError(e); } },
  },
  settings: {
    get: async () => { try { return await window.dentiva.settings.get(); } catch (e) { handleError(e); } },
    update: async (data: any) => { try { return await window.dentiva.settings.update(data); } catch (e) { handleError(e); } },
  },

  // Backup
  backup: {
    create: async (trigger?: any, notes?: string | null) => { try { return await window.dentiva.backup.create(trigger, notes); } catch (e) { handleError(e); } },
    list: async (limit?: number, offset?: number) => { try { return await window.dentiva.backup.list(limit, offset); } catch (e) { handleError(e); } },
    validate: async (path: string) => { try { return await window.dentiva.backup.validate(path); } catch (e) { handleError(e); } },
    restore: async (path: string) => { try { return await window.dentiva.backup.restore(path); } catch (e) { handleError(e); } },
  },

  // Documents
  documents: {
    prescription: async (id: string) => { try { return await window.dentiva.documents.prescription(id); } catch (e) { handleError(e); } },
    invoice: async (id: string) => { try { return await window.dentiva.documents.invoice(id); } catch (e) { handleError(e); } },
    receipt: async (id: string) => { try { return await window.dentiva.documents.receipt(id); } catch (e) { handleError(e); } },
    statement: async (patientId: string, fromKey?: string | null, toKey?: string | null) => { try { return await window.dentiva.documents.statement(patientId, fromKey, toKey); } catch (e) { handleError(e); } },
    generatePdf: async (doc: any, pageSize: string) => { try { return await window.dentiva.documents.generatePdf(doc, pageSize); } catch (e) { handleError(e); } },
  },

  // Diagnostics
  diagnostics: {
    integrity: async () => { try { return await window.dentiva.diagnostics.integrity(); } catch (e) { handleError(e); } },
    counts: async () => { try { return await window.dentiva.diagnostics.counts(); } catch (e) { handleError(e); } },
  },

  // App
  app: {
    info: async () => { try { return await window.dentiva.app.info(); } catch (e) { handleError(e); } },
  },
};
