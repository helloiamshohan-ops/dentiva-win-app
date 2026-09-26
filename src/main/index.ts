/**
 * Dentiva Pro — main process entry point.
 *
 * Responsibilities:
 *   - Create and migrate the embedded database
 *   - Wire all services with dependency injection
 *   - Set up Electron security (context isolation, sandbox, secure preload, restricted IPC)
 *   - Handle application lifecycle, window management, backup/restore, diagnostics
 *
 * No business logic lives here; it delegates to services.
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

// Import database and services
import { Database, probeSqliteCapabilities } from './db/sqlite';
import { migrate, CURRENT_SCHEMA_VERSION, verifySchema } from './db/migrate';
import { AuditService, SYSTEM_ACTOR } from './audit/audit';
import { AuthService } from './security/auth';
import { ActivationService, ACTIVATION_ENABLED } from './security/activation';
import { SettingsService } from './services/settings';
import { PatientService } from './services/patient-service';
import { FinancialService } from './services/financial-service';
import { SchedulingService } from './services/scheduling-service';
import { ClinicalService } from './services/clinical-service';
import { InventoryService } from './services/inventory-service';
import { TreatmentService } from './services/treatment-service';
import { StaffService } from './services/staff-service';
import { SearchService } from './services/search-service';
import { NotificationService } from './services/notification-service';
import { DashboardService } from './services/dashboard-service';
import { ReportService } from './services/report-service';
import { AttachmentService } from './services/attachment-service';
import { BackupService } from './services/backup-service';
import { ImportExportService } from './services/import-export-service';
import { IntegrityService } from './services/integrity-service';
import { DocumentBuilder } from './documents/document-builder';
import { PdfGenerator, type PdfPageSize } from './documents/pdf-generator';
import { IPC_CHANNEL_META, type IpcChannel } from '../shared/ipc-contract';
import { AppError, isAppErrorWire } from '../shared/errors';
import type { Permission } from '../shared/permissions';

// ── Paths ────────────────────────────────────────────────────────────────────────────────

function getUserDataPath(): string {
  const base = app ? app.getPath('userData') : join(homedir(), '.dentiva');
  return base;
}

function getDatabasePath(userDataPath: string): string {
  return join(userDataPath, 'dentiva.sqlite');
}

function getAttachmentsDir(userDataPath: string): string {
  return join(userDataPath, 'attachments');
}

function getBackupDir(userDataPath: string): string {
  return join(userDataPath, 'backups');
}

function getLogsDir(userDataPath: string): string {
  return join(userDataPath, 'logs');
}

// ── Global state ───────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let db: Database | null = null;
let services: {
  audit: AuditService;
  auth: AuthService;
  activation: ActivationService;
  settings: SettingsService;
  patients: PatientService;
  financial: FinancialService;
  scheduling: SchedulingService;
  clinical: ClinicalService;
  inventory: InventoryService;
  treatments: TreatmentService;
  staff: StaffService;
  search: SearchService;
  notifications: NotificationService;
  dashboard: DashboardService;
  reports: ReportService;
  attachments: AttachmentService;
  backup: BackupService;
  importExport: ImportExportService;
  integrity: IntegrityService;
  documents: DocumentBuilder;
  pdf: PdfGenerator;
} | null = null;

let userDataPath = '';
let dbPath = '';
let attachmentsDir = '';
let backupDir = '';

// ── Database initialization ────────────────────────────────────────────────────────────

function initDatabase(): Database {
  userDataPath = getUserDataPath();
  if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true });

  dbPath = getDatabasePath(userDataPath);
  attachmentsDir = getAttachmentsDir(userDataPath);
  backupDir = getBackupDir(userDataPath);
  const logsDir = getLogsDir(userDataPath);

  for (const dir of [attachmentsDir, backupDir, logsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Probe capabilities before opening
  const caps = probeSqliteCapabilities();
  console.log(`[Dentiva Pro] SQLite capabilities: ${JSON.stringify(caps)}`);

  const database = new Database(dbPath);
  database.verifyPragmas();

  const migrationResult = migrate(database);
  console.log(`[Dentiva Pro] Migration result: ${JSON.stringify(migrationResult)}`);

  const verification = verifySchema(database);
  if (!verification.ok) {
    console.error(`[Dentiva Pro] Schema verification failed: ${JSON.stringify(verification)}`);
    throw new AppError('The database schema is not valid. Restore from a backup or contact support.', {
      code: 'INTEGRITY_VIOLATION',
      details: verification as unknown as Record<string, unknown>,
    });
  }

  return database;
}

function initServices(database: Database) {
  const audit = new AuditService(database);
  const settings = new SettingsService(database, audit);

  const getTimeZone = () => {
    try {
      return settings.getClinic().timeZone;
    } catch {
      return 'Asia/Dhaka';
    }
  };

  const getAppSettings = () => {
    try {
      return settings.getSettings();
    } catch {
      return {
        inactivityTimeoutMinutes: 15,
        paymentMethods: ['Cash', 'Bank', 'Card', 'bKash', 'Nagad', 'Rocket', 'Upay'],
        queueSerialScope: 'clinic' as const,
        allowOverpayment: false,
        allowNegativeStock: false,
        expiryWarningDays: 60,
        autoBackupEnabled: true,
        autoBackupIntervalHours: 24,
        autoBackupRetained: 10,
        backupDirectory: '',
        defaultTaxPercent: 0,
        followUpWindowDays: 7,
        setupCompleted: false,
      };
    }
  };

  const auth = new AuthService(database, audit, () => getAppSettings().inactivityTimeoutMinutes);
  const activation = new ActivationService(database, audit);
  const patients = new PatientService(database, audit, getTimeZone);
  const financial = new FinancialService(database, audit, () => ({
    timeZone: getTimeZone(),
    allowOverpayment: getAppSettings().allowOverpayment,
    paymentMethods: getAppSettings().paymentMethods,
  }));
  const scheduling = new SchedulingService(database, audit, () => ({
    timeZone: getTimeZone(),
    queueSerialScope: getAppSettings().queueSerialScope,
  }));
  const clinical = new ClinicalService(database, audit, getTimeZone);
  const inventory = new InventoryService(database, audit, () => ({
    timeZone: getTimeZone(),
    expiryWarningDays: getAppSettings().expiryWarningDays,
    allowNegativeStock: getAppSettings().allowNegativeStock,
  }));
  const treatments = new TreatmentService(database, audit);
  const staff = new StaffService(database, audit);
  const search = new SearchService(database);
  const notifications = new NotificationService(database, getTimeZone);
  const dashboard = new DashboardService(database, getTimeZone);
  const reports = new ReportService(database);
  const attachments = new AttachmentService(database, audit, () => attachmentsDir);
  const backup = new BackupService(
    database,
    audit,
    () => app?.getVersion() ?? '1.0.0',
    () => dbPath,
    () => attachmentsDir,
    () => {
      const custom = getAppSettings().backupDirectory;
      return custom && custom.trim() !== '' ? custom.trim() : backupDir;
    },
  );
  const importExport = new ImportExportService(database, audit);
  const integrity = new IntegrityService(database, () => attachmentsDir);
  const documents = new DocumentBuilder(database, getTimeZone, () => {
    try {
      const clinic = database.get('SELECT logo_attachment_id AS logoId FROM clinic ORDER BY id LIMIT 1');
      if (!clinic || !clinic.logoId) return null;
      const att = database.get('SELECT stored_name AS storedName, mime_type AS mimeType FROM attachments WHERE id = ?', String(clinic.logoId));
      if (!att) return null;
      const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const filePath = join(attachmentsDir, String(att.storedName));
      if (!existsSync(filePath)) return null;
      const buffer = readFileSync(filePath);
      return `data:${String(att.mimeType)};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  });
  const pdf = new PdfGenerator();

  return {
    audit,
    auth,
    activation,
    settings,
    patients,
    financial,
    scheduling,
    clinical,
    inventory,
    treatments,
    staff,
    search,
    notifications,
    dashboard,
    reports,
    attachments,
    backup,
    importExport,
    integrity,
    documents,
    pdf,
  };
}

// ── IPC handling with auth guards ───────────────────────────────────────────────────────

function setupIpc() {
  if (!services || !db) throw new Error('Services not initialized');

  // Helper to wrap handlers with auth and error handling
  const handle = <TInput, TOutput>(
    channel: IpcChannel,
    handler: (input: TInput & { _token?: string }, actor: ReturnType<AuthService['requireSession']> | null) => Promise<TOutput> | TOutput,
  ) => {
    ipcMain.handle(channel, async (_event, input: TInput & { _token?: string }) => {
      try {
        const meta = IPC_CHANNEL_META[channel];
        const token = input?._token ?? null;

        // Expiry sweep
        if (services) services.auth.expireStaleSessions();

        let actor: ReturnType<AuthService['requireSession']> | null = null;
        if (meta.authRequired) {
          if (!services) throw new AppError('Services not available', { code: 'INTERNAL' });
          if (meta.permission) {
            actor = services.auth.requirePermission(token, meta.permission);
          } else {
            actor = services.auth.requireSession(token);
          }
        } else if (token) {
          try {
            actor = services!.auth.requireSession(token);
          } catch {
            // Optional auth: ignore if token invalid
            actor = null;
          }
        }

        // Activation check (except for activation and auth channels)
        if (ACTIVATION_ENABLED && !channel.startsWith('activation:') && !channel.startsWith('auth:') && channel !== 'app:info') {
          if (services && !services.activation.isActivated()) {
            throw new AppError('The product has not been activated. Activate it to continue.', { code: 'NOT_ACTIVATED' });
          }
        }

        const result = await handler(input, actor);
        return { ok: true, data: result };
      } catch (error) {
        const appError = AppError.fromUnknown(error);
        return { ok: false, error: appError.toWire() };
      }
    });
  };

  // ── Auth ────────────────────────────────────────────────────────────────────────────
  handle('auth:login', async (input: { username: string; password: string }) => {
    return services!.auth.login(input.username, input.password);
  });

  handle('auth:logout', async (input: { _token?: string }) => {
    services!.auth.logout(input._token);
    return { success: true };
  });

  handle('auth:current', async (input: { _token?: string }) => {
    return services!.auth.current(input._token);
  });

  handle('auth:changePassword', async (input: { _token?: string; currentPassword: string; newPassword: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    await services!.auth.changePassword(actor.token, input.currentPassword, input.newPassword);
    return { success: true };
  });

  handle('auth:lock', async (input: { _token?: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.auth.lock(actor.token);
    return { success: true };
  });

  handle('auth:unlock', async (input: { _token?: string; password: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.auth.unlock(actor.token, input.password);
  });

  // ── Activation ──────────────────────────────────────────────────────────────────────
  handle('activation:getState', async () => {
    return services!.activation.getState();
  });

  handle('activation:activate', async (input: { key: string; machineId: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.activation.activate({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.key, input.machineId);
  });

  // ── Clinic & Settings ───────────────────────────────────────────────────────────────
  handle('clinic:get', async () => services!.settings.getClinic());
  handle('clinic:update', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.settings.updateClinic({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('settings:get', async () => services!.settings.getSettings());
  handle('settings:update', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.settings.updateSettings({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('settings:completeSetup', async (_input: unknown, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.settings.completeSetup({ userId: actor.userId, name: actor.displayName, role: actor.role });
    return { success: true };
  });

  // ── Patients ────────────────────────────────────────────────────────────────────────
  handle('patients:list', async (input: { query: Record<string, unknown> }) => services!.patients.list(input.query as never));
  handle('patients:get', async (input: { id: string }) => services!.patients.get(input.id));
  handle('patients:resolve', async (input: { reference: string }) => services!.patients.resolve(input.reference));
  handle('patients:create', async (input: { data: Record<string, unknown>; acknowledgeDuplicate?: boolean }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.patients.create({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never, {
      acknowledgeDuplicate: input.acknowledgeDuplicate,
    });
  });
  handle('patients:update', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.patients.update({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('patients:archive', async (input: { id: string; reason: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.patients.archive({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.reason);
    return { success: true };
  });
  handle('patients:restore', async (input: { id: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.patients.restore({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id);
    return { success: true };
  });
  handle('patients:summary', async (input: { id: string }) => services!.patients.summary(input.id));
  handle('patients:header', async (input: { id: string }) => services!.patients.header(input.id));
  handle('patients:checkDuplicates', async (input: { data: { name: string; phone: string | null; email: string | null; dobKey: string | null }; excludeId?: string | null }) =>
    services!.patients.detectDuplicates(input.data, input.excludeId ?? null),
  );

  // ── Visits ──────────────────────────────────────────────────────────────────────────
  handle('visits:create', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.clinical.createVisit({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('visits:update', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.clinical.updateVisit({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('visits:get', async (input: { id: string }) => services!.clinical.getVisit(input.id));
  handle('visits:list', async (input: { params: Record<string, unknown> }) => services!.clinical.listVisits(input.params as never));
  handle('visits:timeline', async (input: { patientId: string; limit: number; offset: number }) =>
    services!.clinical.timeline(input.patientId, input.limit, input.offset),
  );

  // ── Dental chart ────────────────────────────────────────────────────────────────────
  handle('chart:get', async (input: { patientId: string }) => services!.clinical.chart(input.patientId));
  handle('chart:history', async (input: { patientId: string; toothNumber: number }) => services!.clinical.chartHistory(input.patientId, input.toothNumber));
  handle('chart:record', async (input: { patientId: string; conditions: Record<string, unknown>[] }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.clinical.recordToothConditions(
      { userId: actor.userId, name: actor.displayName, role: actor.role },
      input.patientId,
      input.conditions as never,
    );
  });

  // ── Prescriptions ───────────────────────────────────────────────────────────────────
  handle('prescriptions:create', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.clinical.createPrescription({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('prescriptions:update', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.clinical.updatePrescription({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('prescriptions:get', async (input: { id: string }) => services!.clinical.getPrescription(input.id));
  handle('prescriptions:list', async (input: { params: Record<string, unknown> }) => services!.clinical.listPrescriptions(input.params as never));

  // ── Follow-ups, referrals, notes ─────────────────────────────────────────────────────
  handle('followUps:create', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.clinical.createFollowUp({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
    return { success: true };
  });
  handle('followUps:complete', async (input: { id: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.clinical.completeFollowUp({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id);
    return { success: true };
  });
  handle('followUps:list', async (input: { params: Record<string, unknown> }) => services!.clinical.listFollowUps(input.params as never));
  handle('referrals:create', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.clinical.createReferral({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
    return { success: true };
  });
  handle('referrals:list', async (input: { patientId: string }) => services!.clinical.listReferrals(input.patientId));
  handle('notes:add', async (input: { patientId: string; body: string; pinned?: boolean }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.clinical.addNote({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.patientId, input.body, input.pinned);
    return { success: true };
  });
  handle('notes:list', async (input: { patientId: string; limit?: number; offset?: number }) =>
    services!.clinical.listNotes(input.patientId, input.limit, input.offset),
  );

  // ── Appointments ────────────────────────────────────────────────────────────────────
  handle('appointments:create', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.scheduling.createAppointment({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('appointments:reschedule', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.scheduling.reschedule({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('appointments:changeStatus', async (input: { id: string; status: string; reason?: string | null }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.scheduling.changeStatus({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.status as never, input.reason);
  });
  handle('appointments:get', async (input: { id: string }) => services!.scheduling.getAppointment(input.id));
  handle('appointments:list', async (input: { params: Record<string, unknown> }) => services!.scheduling.listAppointments(input.params as never));
  handle('appointments:agenda', async (input: { dateKey: string }) => services!.scheduling.agenda(input.dateKey));

  // ── Queue ───────────────────────────────────────────────────────────────────────────
  handle('queue:add', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.scheduling.addToQueue({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('queue:changeStatus', async (input: { id: string; status: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.scheduling.changeQueueStatus({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.status as never);
  });
  handle('queue:get', async (input: { id: string }) => services!.scheduling.getQueueEntry(input.id));
  handle('queue:list', async (input: { params: Record<string, unknown> }) => services!.scheduling.listQueue(input.params as never));
  handle('queue:summary', async (input: { dateKey?: string | null }) => services!.scheduling.queueSummary(input.dateKey));

  // ── Resources ───────────────────────────────────────────────────────────────────────
  handle('resources:listDentists', async (input: { includeInactive?: boolean }) => services!.scheduling.listDentists(input.includeInactive));
  handle('resources:listChairs', async (input: { includeInactive?: boolean }) => services!.scheduling.listChairs(input.includeInactive));
  handle('resources:listRooms', async (input: { includeInactive?: boolean }) => services!.scheduling.listRooms(input.includeInactive));
  handle('resources:create', async (input: { kind: 'chair' | 'room'; name: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.scheduling.createResource({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.kind, input.name);
  });
  handle('resources:setActive', async (input: { kind: 'chair' | 'room'; id: string; active: boolean }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.scheduling.setResourceActive({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.kind, input.id, input.active);
    return { success: true };
  });

  // ── Treatments ──────────────────────────────────────────────────────────────────────
  handle('treatments:create', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.treatments.createTreatment({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('treatments:update', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.treatments.updateTreatment({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('treatments:get', async (input: { id: string }) => services!.treatments.getTreatment(input.id));
  handle('treatments:list', async (input: { params: Record<string, unknown> }) => services!.treatments.listTreatments(input.params as never));
  handle('treatments:categories', async () => services!.treatments.categories());

  handle('treatmentPlans:create', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.treatments.createPlan({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('treatmentPlans:update', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.treatments.updatePlan({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('treatmentPlans:accept', async (input: { id: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.treatments.acceptPlan({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id);
  });
  handle('treatmentPlans:get', async (input: { id: string }) => services!.treatments.getPlan(input.id));
  handle('treatmentPlans:list', async (input: { params: Record<string, unknown> }) => services!.treatments.listPlans(input.params as never));

  // ── Financial ───────────────────────────────────────────────────────────────────────
  handle('financial:createInvoice', async (input: { data: Record<string, unknown>; idempotencyKey?: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.financial.createInvoice({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never, input.idempotencyKey);
  });
  handle('financial:updateInvoice', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.financial.updateInvoice({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('financial:voidInvoice', async (input: { id: string; reason: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.financial.voidInvoice({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.reason);
  });
  handle('financial:getInvoice', async (input: { id: string }) => services!.financial.getInvoice(input.id));
  handle('financial:listInvoices', async (input: { params: Record<string, unknown> }) => services!.financial.listInvoices(input.params as never));
  handle('financial:recordPayment', async (input: { data: Record<string, unknown>; idempotencyKey: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.financial.recordPayment({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never, input.idempotencyKey);
  });
  handle('financial:voidPayment', async (input: { id: string; reason: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.financial.voidPayment({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.reason);
  });
  handle('financial:getPayment', async (input: { id: string }) => services!.financial.getPayment(input.id));
  handle('financial:listPayments', async (input: { params: Record<string, unknown> }) => services!.financial.listPayments(input.params as never));
  handle('financial:recordRefund', async (input: { data: Record<string, unknown>; idempotencyKey: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.financial.recordRefund({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never, input.idempotencyKey);
  });
  handle('financial:recordAdjustment', async (input: { data: Record<string, unknown>; idempotencyKey: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.financial.recordAdjustment({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never, input.idempotencyKey);
  });
  handle('financial:getReceipt', async (input: { id: string }) => services!.financial.getReceipt(input.id));
  handle('financial:listReceipts', async (input: { params: Record<string, unknown> }) => services!.financial.listReceipts(input.params as never));
  handle('financial:statement', async (input: { patientId: string; fromKey?: string | null; toKey?: string | null; openingMinor?: number }) =>
    services!.financial.buildStatement(input),
  );

  // ── Inventory ───────────────────────────────────────────────────────────────────────
  handle('inventory:createItem', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.inventory.createItem({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('inventory:updateItem', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.inventory.updateItem({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('inventory:getItem', async (input: { id: string }) => services!.inventory.getItem(input.id));
  handle('inventory:listItems', async (input: { params: Record<string, unknown> }) => services!.inventory.listItems(input.params as never));
  handle('inventory:recordMovement', async (input: { itemId: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.inventory.recordMovement({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.itemId, input.data as never);
  });
  handle('inventory:getMovement', async (input: { id: string }) => services!.inventory.getMovement(input.id));
  handle('inventory:listMovements', async (input: { itemId: string; limit: number; offset: number }) =>
    services!.inventory.listMovements(input.itemId, input.limit, input.offset),
  );
  handle('inventory:verifyQuantity', async (input: { itemId: string }) => services!.inventory.verifyQuantity(input.itemId));
  handle('inventory:listSuppliers', async () => services!.inventory.listSuppliers());
  handle('inventory:createSupplier', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.inventory.createSupplier({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('inventory:categories', async () => services!.inventory.categories());

  // ── Staff ───────────────────────────────────────────────────────────────────────────
  handle('staff:createDentist', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.staff.createDentist({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('staff:updateDentist', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.staff.updateDentist({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('staff:getDentist', async (input: { id: string }) => services!.staff.getDentist(input.id));
  handle('staff:listDentists', async (input: { includeInactive?: boolean }) => services!.staff.listDentists(input.includeInactive));
  handle('staff:createStaff', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.staff.createStaff({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('staff:updateStaff', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.staff.updateStaff({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('staff:getStaff', async (input: { id: string }) => services!.staff.getStaff(input.id));
  handle('staff:listStaff', async (input: { includeInactive?: boolean }) => services!.staff.listStaff(input.includeInactive));
  handle('staff:createUser', async (input: { data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.staff.createUser({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('staff:updateUser', async (input: { id: string; data: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.staff.updateUser({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id, input.data as never);
  });
  handle('staff:resetPassword', async (input: { userId: string; newPassword: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    await services!.staff.resetPassword({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.userId, input.newPassword);
    return { success: true };
  });
  handle('staff:getUser', async (input: { id: string }) => services!.staff.getUser(input.id));
  handle('staff:listUsers', async (input: { includeInactive?: boolean }) => services!.staff.listUsers(input.includeInactive));

  // ── Search ──────────────────────────────────────────────────────────────────────────
  handle('search:global', async (input: { query: string; kinds?: string[]; limit: number }) =>
    services!.search.search({ query: input.query, kinds: input.kinds as never, limit: input.limit }),
  );

  // ── Notifications ───────────────────────────────────────────────────────────────────
  handle('notifications:scan', async () => services!.notifications.scan());
  handle('notifications:list', async (input: { params: Record<string, unknown> }) => services!.notifications.list(input.params as never));
  handle('notifications:markRead', async (input: { id: string }) => {
    services!.notifications.markRead(input.id);
    return { success: true };
  });
  handle('notifications:markAllRead', async () => ({ count: services!.notifications.markAllRead() }));
  handle('notifications:delete', async (input: { id: string }) => {
    services!.notifications.deleteNotification(input.id);
    return { success: true };
  });

  // ── Dashboard ───────────────────────────────────────────────────────────────────────
  handle('dashboard:metrics', async () => services!.dashboard.getMetrics());
  handle('dashboard:todayAppointments', async (input: { limit?: number }) => services!.dashboard.todayAppointments(input.limit));
  handle('dashboard:lowStock', async (input: { limit?: number }) => services!.dashboard.lowStockAlerts(input.limit));
  handle('dashboard:recentPatients', async (input: { limit?: number }) => services!.dashboard.recentPatients(input.limit));

  // ── Reports ─────────────────────────────────────────────────────────────────────────
  handle('reports:revenue', async (input: { params: Record<string, unknown> }) => services!.reports.revenue(input.params as never));
  handle('reports:payments', async (input: { params: Record<string, unknown> }) => services!.reports.payments(input.params as never));
  handle('reports:outstanding', async (input: { params: Record<string, unknown> }) => services!.reports.outstanding(input.params as never));
  handle('reports:appointments', async (input: { params: Record<string, unknown> }) => services!.reports.appointments(input.params as never));
  handle('reports:visits', async (input: { params: Record<string, unknown> }) => services!.reports.visits(input.params as never));
  handle('reports:inventory', async (input: { params: Record<string, unknown> }) => services!.reports.inventory(input.params as never));
  handle('reports:audit', async (input: { params: Record<string, unknown> }) => services!.reports.audit(input.params as never));
  handle('reports:patients', async (input: { params: Record<string, unknown> }) => services!.reports.patients(input.params as never));

  // ── Attachments ─────────────────────────────────────────────────────────────────────
  handle('attachments:store', async (input: { data: { entityType: string; entityId: string; patientId?: string | null; fileName: string; mimeType: string; buffer: number[]; note?: string | null } }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.attachments.store(
      { userId: actor.userId, name: actor.displayName, role: actor.role },
      {
        entityType: input.data.entityType as never,
        entityId: input.data.entityId,
        patientId: input.data.patientId ?? null,
        originalFileName: input.data.fileName,
        mimeType: input.data.mimeType,
        buffer: new Uint8Array(input.data.buffer),
        note: input.data.note ?? null,
      },
    );
  });
  handle('attachments:get', async (input: { id: string }) => services!.attachments.getAttachment(input.id));
  handle('attachments:list', async (input: { entityType: string; entityId: string }) => services!.attachments.list(input.entityType, input.entityId));
  handle('attachments:listByPatient', async (input: { patientId: string; limit: number; offset: number }) =>
    services!.attachments.listByPatient(input.patientId, input.limit, input.offset),
  );
  handle('attachments:delete', async (input: { id: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    services!.attachments.delete({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.id);
    return { success: true };
  });
  handle('attachments:readFile', async (input: { id: string }) => {
    const result = services!.attachments.readFile(input.id);
    if (!result) throw new AppError('The attachment file is missing from disk.', { code: 'ATTACHMENT_MISSING' });
    return { buffer: Array.from(result.buffer), mimeType: result.mimeType, fileName: result.fileName };
  });
  handle('attachments:findMissing', async () => services!.attachments.findMissingFiles());

  // ── Backup / Restore ────────────────────────────────────────────────────────────────
  handle('backup:create', async (input: { trigger?: 'manual' | 'automatic' | 'pre_restore'; notes?: string | null }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.backup.createBackup({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.trigger, input.notes);
  });
  handle('backup:list', async (input: { limit?: number; offset?: number }) => services!.backup.listBackups(input.limit, input.offset));
  handle('backup:validate', async (input: { path: string }) => services!.backup.validateBackup(input.path));
  handle('backup:restore', async (input: { path: string }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.backup.restoreBackup({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.path);
  });
  handle('backup:delete', async (input: { id: string }) => {
    services!.backup.deleteBackup(input.id);
    return { success: true };
  });

  // ── Import / Export ─────────────────────────────────────────────────────────────────
  handle('import:patients', async (input: { data: unknown[] }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.importExport.importPatients({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.data as never);
  });
  handle('import:list', async (input: { limit?: number; offset?: number }) => services!.importExport.listImports(input.limit, input.offset));
  handle('export:patients', async (input: { filter: Record<string, unknown> }, actor) => {
    if (!actor) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED' });
    return services!.importExport.exportPatients({ userId: actor.userId, name: actor.displayName, role: actor.role }, input.filter as never);
  });
  handle('export:getData', async (input: { id: string }) => services!.importExport.getExportData(input.id));

  // ── Documents ───────────────────────────────────────────────────────────────────────
  handle('documents:prescription', async (input: { id: string }) => services!.documents.buildPrescription(input.id));
  handle('documents:invoice', async (input: { id: string }) => services!.documents.buildInvoice(input.id));
  handle('documents:receipt', async (input: { id: string }) => services!.documents.buildReceipt(input.id));
  handle('documents:statement', async (input: { patientId: string; fromKey?: string | null; toKey?: string | null }) =>
    services!.documents.buildStatement(input.patientId, input.fromKey ?? null, input.toKey ?? null),
  );
  handle('documents:generatePdf', async (input: { doc: Record<string, unknown>; pageSize: PdfPageSize; dateFormat?: string; currencySymbol?: string }) => {
    const timeZone = services!.settings.getClinic().timeZone;
    const clinicSettings = services!.settings.getSettings();
    const buffer = await services!.pdf.generate(input.doc as never, {
      pageSize: input.pageSize,
      dateFormat: (input.dateFormat as never) ?? (services!.settings.getClinic().dateFormat as never) ?? 'DD/MM/YYYY',
      timeZone,
      currencySymbol: input.currencySymbol ?? services!.settings.getClinic().currencySymbol ?? '৳',
    });
    return { buffer: Array.from(buffer), size: buffer.length };
  });

  // ── Diagnostics ─────────────────────────────────────────────────────────────────────
  handle('diagnostics:integrity', async () => services!.integrity.check());
  handle('diagnostics:schema', async () => {
    const { verifySchema } = await import('./db/migrate');
    return verifySchema(db!);
  });
  handle('diagnostics:counts', async () => {
    const tables = [
      'patients',
      'visits',
      'prescriptions',
      'invoices',
      'payments',
      'receipts',
      'appointments',
      'queue_entries',
      'treatments',
      'inventory_items',
      'attachments',
      'audit_log',
      'users',
      'dentists',
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      try {
        const row = db!.get(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number };
        counts[table] = Number(row.n ?? 0);
      } catch {
        counts[table] = -1;
      }
    }
    return counts;
  });
  handle('diagnostics:performance', async () => {
    const start = Date.now();
    const patientCount = db!.get('SELECT COUNT(*) AS n FROM patients') as { n: number };
    const patientListStart = Date.now();
    db!.all('SELECT id, patient_code, name FROM patients ORDER BY name LIMIT 100');
    const patientListTime = Date.now() - patientListStart;

    const searchStart = Date.now();
    db!.all('SELECT id FROM patients WHERE name_normalized LIKE ? LIMIT 20', '%test%');
    const searchTime = Date.now() - searchStart;

    return {
      startupMs: Date.now() - start,
      patientListMs: patientListTime,
      searchMs: searchTime,
      patientCount: Number(patientCount.n ?? 0),
      timestamp: new Date().toISOString(),
    };
  });

  // ── App ─────────────────────────────────────────────────────────────────────────────
  handle('app:info', async () => ({
    version: app?.getVersion() ?? '1.0.0',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activationEnabled: ACTIVATION_ENABLED,
    platform: process.platform,
    arch: process.arch,
    userDataPath,
    dbPath,
    attachmentsDir,
    backupDir,
  }));

  handle('app:quit', async () => {
    app?.quit();
    return { success: true };
  });
}

// ── Window management ─────────────────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#F7FAFC',
    title: 'Dentiva Pro',
    icon: getIconPath(),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'index.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Security: block navigation to external URLs, open them in system browser
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('file://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Security: disable new windows from renderer
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Load renderer
  const rendererPath = join(__dirname, '..', 'renderer', 'index.html');
  if (existsSync(rendererPath)) {
    window.loadFile(rendererPath);
  } else {
    // Development fallback: try src/renderer
    const devPath = resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html');
    if (existsSync(devPath)) {
      window.loadFile(devPath);
    } else {
      window.loadURL(`data:text/html,<h1>Dentiva Pro</h1><p>Renderer not built. Run npm run build:renderer</p>`);
    }
  }

  window.once('ready-to-show', () => {
    window.show();
    window.focus();
  });

  // Handle close: confirm if there are unsaved changes (renderer will handle via beforeunload)
  window.on('close', (event) => {
    // Let renderer handle unsaved changes check via IPC if needed
  });

  return window;
}

function getIconPath(): string | undefined {
  const possiblePaths = [
    join(__dirname, '..', '..', 'resources', 'icons', 'icon.png'),
    join(__dirname, '..', 'renderer', 'icon.png'),
    join(process.resourcesPath ?? '', 'icons', 'icon.png'),
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

// ── Application lifecycle ──────────────────────────────────────────────────────────────

async function main() {
  // Security: disable remote module, enable sandbox
  app.commandLine.appendSwitch('no-sandbox', 'false');

  await app.whenReady();

  try {
    db = initDatabase();
    services = initServices(db);
    setupFirstRunIpc();
    setupIpc();
  } catch (error) {
    console.error('[Dentiva Pro] Failed to initialize:', error);
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('Dentiva Pro — Initialization Failed', `The application could not start:\n\n${message}\n\nTry restoring from a backup or contact support.`);
    app.quit();
    return;
  }

  mainWindow = createMainWindow();

  // Inactivity timeout check every minute
  setInterval(() => {
    if (services) {
      const expired = services.auth.expireStaleSessions();
      if (expired > 0) {
        console.log(`[Dentiva Pro] Expired ${expired} stale session(s)`);
        mainWindow?.webContents.send('auth:sessionExpired');
      }
    }
  }, 60_000);

  // Auto backup check every hour
  setInterval(async () => {
    try {
      if (!services) return;
      const settings = services.settings.getSettings();
      if (!settings.autoBackupEnabled) return;

      const lastBackup = db!.get('SELECT created_at AS createdAt FROM backup_history WHERE trigger = \'automatic\' ORDER BY created_at DESC LIMIT 1');
      const lastTime = lastBackup ? Date.parse(String(lastBackup.createdAt)) : 0;
      const intervalMs = settings.autoBackupIntervalHours * 3_600_000;
      if (Date.now() - lastTime < intervalMs) return;

      console.log('[Dentiva Pro] Running automatic backup...');
      await services.backup.createBackup(SYSTEM_ACTOR, 'automatic');

      // Prune old automatic backups
      const allAuto = db!.all('SELECT id, file_path AS filePath FROM backup_history WHERE trigger = \'automatic\' ORDER BY created_at DESC');
      if (allAuto.length > settings.autoBackupRetained) {
        const toDelete = allAuto.slice(settings.autoBackupRetained);
        for (const row of toDelete) {
          try {
            services.backup.deleteBackup(String(row.id));
          } catch {}
        }
      }
    } catch (error) {
      console.error('[Dentiva Pro] Auto backup failed:', error);
    }
  }, 3_600_000);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });

  app.on('before-quit', () => {
    try {
      db?.close();
    } catch {}
  });
}

// ── First-run handler (no auth required when no users exist) ──────────────────────────

function setupFirstRunIpc() {
  ipcMain.handle('firstRun:createAdmin', async (_event, input: { username: string; displayName: string; password: string; clinicName?: string }) => {
    try {
      if (!db || !services) throw new Error('Services not initialized');
      const userCount = db.get('SELECT COUNT(*) AS n FROM users') as { n: number };
      if (Number(userCount.n) > 0) {
        return { ok: false, error: { name: 'AppError', code: 'ALREADY_EXISTS', message: 'An administrator already exists. Sign in to add more users.', details: {}, fieldErrors: {} } };
      }

      const { username, displayName, password, clinicName } = input;
      if (!username || !displayName || !password) {
        return { ok: false, error: { name: 'AppError', code: 'VALIDATION', message: 'Username, display name and password are required.', details: {}, fieldErrors: { username: 'Required', displayName: 'Required', password: 'Required' } } };
      }

      const result = await services.auth.createInitialAdministrator({ username, displayName, password });
      
      // Update clinic name if provided
      if (clinicName?.trim()) {
        try {
          const clinic = db.get('SELECT id FROM clinic ORDER BY id LIMIT 1');
          if (clinic) {
            db.run('UPDATE clinic SET name = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?', clinicName.trim(), String(clinic.id));
          }
        } catch {}
      }

      // Mark setup as not completed so wizard shows, but allow login
      // Actually, complete setup after first admin creation is optional; we let the wizard handle it

      return { ok: true, data: result };
    } catch (error) {
      const appError = AppError.fromUnknown(error);
      return { ok: false, error: appError.toWire() };
    }
  });

  ipcMain.handle('firstRun:check', async () => {
    try {
      if (!db) return { ok: true, data: { needsSetup: true, userCount: 0 } };
      const userCount = db.get('SELECT COUNT(*) AS n FROM users') as { n: number };
      const clinic = db.get('SELECT name FROM clinic ORDER BY id LIMIT 1') as { name?: string } | undefined;
      return {
        ok: true,
        data: {
          needsSetup: Number(userCount.n) === 0,
          userCount: Number(userCount.n),
          clinicName: clinic?.name || '',
        },
      };
    } catch (error) {
      return { ok: false, error: { name: 'AppError', code: 'INTERNAL', message: String(error), details: {}, fieldErrors: {} } };
    }
  });
}

// Only run Electron app if we are in Electron, not when imported for tests
if (process.versions.electron) {
  main().catch((error) => {
    console.error('[Dentiva Pro] Fatal error:', error);
    app.quit();
  });
}

export { initDatabase, initServices, setupIpc, createMainWindow, getUserDataPath, getDatabasePath, getAttachmentsDir, getBackupDir, setupFirstRunIpc };
