/**
 * Dentiva Pro — attachment service.
 *
 * Attachments are stored on disk under a managed directory, with filenames derived from a
 * content hash and a random suffix. The original filename is preserved only as metadata, never
 * as a filesystem path, which eliminates path traversal and unsafe filename attacks.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { AppError, Errors } from '../../shared/errors';
import { newId } from '../../shared/id';
import type { Database } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';
import { int, str, strOrNull } from '../repositories/row';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

export interface AttachmentRow {
  id: string;
  entityType: string;
  entityId: string;
  patientId: string | null;
  fileName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  note: string | null;
  uploadedByName: string | null;
  createdAt: string;
  filePath: string;
}

export class AttachmentService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly attachmentsDir: () => string,
  ) {}

  private ensureDir(): string {
    const dir = this.attachmentsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Store a file that is already on disk (e.g. from Electron's file picker) into the managed
   * attachments directory and record it in the database.
   *
   * Validation happens before any filesystem write, and the stored filename is derived from a
   * hash, never from user input.
   */
  async store(
    actor: AuditActor,
    input: {
      entityType: 'patient' | 'visit' | 'prescription' | 'invoice' | 'clinic' | 'dentist' | 'staff';
      entityId: string;
      patientId?: string | null;
      originalFileName: string;
      mimeType: string;
      buffer: Uint8Array;
      note?: string | null;
    },
  ): Promise<AttachmentRow> {
    if (!ALLOWED_MIMES.has(input.mimeType)) {
      throw new AppError(`Files of type "${input.mimeType}" are not supported. Supported types: images, PDF and common documents.`, {
        code: 'ATTACHMENT_REJECTED',
        details: { mimeType: input.mimeType },
      });
    }
    if (input.buffer.length > MAX_FILE_SIZE) {
      throw new AppError(`This file is too large (${Math.round(input.buffer.length / 1024 / 1024)} MB). Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`, {
        code: 'ATTACHMENT_REJECTED',
        details: { size: input.buffer.length },
      });
    }
    if (input.buffer.length === 0) {
      throw new AppError('This file is empty and cannot be attached.', { code: 'ATTACHMENT_REJECTED' });
    }

    const safeOriginal = sanitizeFileName(input.originalFileName);
    if (safeOriginal === '') throw Errors.validation('Enter a valid file name.', { fileName: 'Enter a valid file name.' });

    const sha256 = createHash('sha256').update(input.buffer).digest('hex');
    const ext = (EXTENSION_MAP[input.mimeType] ?? extname(safeOriginal).slice(0, 10)) || '.bin';
    const storedName = `${sha256.slice(0, 16)}_${newId('att').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}${ext}`;
    const dir = this.ensureDir();
    const filePath = join(dir, storedName);

    // Write file before database record; if the write fails, no orphan DB row is created.
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(filePath, input.buffer, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw AppError.fromUnknown(error, 'The attachment could not be saved. Check that there is enough disk space and that the attachments directory is writable.');
    }

    const id = newId('att');
    try {
      this.db.run(
        `INSERT INTO attachments (id, entity_type, entity_id, patient_id, file_name, stored_name, mime_type, size_bytes, sha256, note, uploaded_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        input.entityType,
        input.entityId,
        input.patientId ?? null,
        safeOriginal,
        storedName,
        input.mimeType,
        input.buffer.length,
        sha256,
        input.note?.trim()?.slice(0, 500) ?? null,
        actor.userId,
      );
    } catch (error) {
      // Clean up the file if the database insert fails.
      try {
        unlinkSync(filePath);
      } catch {
        // Best effort.
      }
      throw AppError.fromUnknown(error, 'The attachment record could not be saved.');
    }

    this.audit.record(actor, {
      action: 'attachment.uploaded',
      entityType: input.entityType,
      entityId: input.entityId,
      summary: `Attached "${safeOriginal}"`,
      metadata: { fileName: safeOriginal, sizeBytes: input.buffer.length, mimeType: input.mimeType },
    });

    return this.getAttachment(id);
  }

  getAttachment(id: string): AttachmentRow {
    const row = this.db.get(
      `SELECT a.id, a.entity_type AS entityType, a.entity_id AS entityId, a.patient_id AS patientId,
              a.file_name AS fileName, a.stored_name AS storedName, a.mime_type AS mimeType,
              a.size_bytes AS sizeBytes, a.sha256, a.note, u.display_name AS uploadedByName, a.created_at AS createdAt
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.id = ?`,
      id,
    );
    if (!row) throw Errors.notFound('attachment');
    const dir = this.attachmentsDir();
    return {
      id: str(row, 'id'),
      entityType: str(row, 'entityType'),
      entityId: str(row, 'entityId'),
      patientId: strOrNull(row, 'patientId'),
      fileName: str(row, 'fileName'),
      storedName: str(row, 'storedName'),
      mimeType: str(row, 'mimeType'),
      sizeBytes: int(row, 'sizeBytes'),
      sha256: str(row, 'sha256'),
      note: strOrNull(row, 'note'),
      uploadedByName: strOrNull(row, 'uploadedByName'),
      createdAt: str(row, 'createdAt'),
      filePath: join(dir, str(row, 'storedName')),
    };
  }

  list(entityType: string, entityId: string): AttachmentRow[] {
    const rows = this.db.all(
      `SELECT a.id, a.entity_type AS entityType, a.entity_id AS entityId, a.patient_id AS patientId,
              a.file_name AS fileName, a.stored_name AS storedName, a.mime_type AS mimeType,
              a.size_bytes AS sizeBytes, a.sha256, a.note, u.display_name AS uploadedByName, a.created_at AS createdAt
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.created_at DESC`,
      entityType,
      entityId,
    );
    const dir = this.attachmentsDir();
    return rows.map((r) => ({
      id: str(r, 'id'),
      entityType: str(r, 'entityType'),
      entityId: str(r, 'entityId'),
      patientId: strOrNull(r, 'patientId'),
      fileName: str(r, 'fileName'),
      storedName: str(r, 'storedName'),
      mimeType: str(r, 'mimeType'),
      sizeBytes: int(r, 'sizeBytes'),
      sha256: str(r, 'sha256'),
      note: strOrNull(r, 'note'),
      uploadedByName: strOrNull(r, 'uploadedByName'),
      createdAt: str(r, 'createdAt'),
      filePath: join(dir, str(r, 'storedName')),
    }));
  }

  listByPatient(patientId: string, limit: number, offset: number): { rows: AttachmentRow[]; total: number } {
    const totalRow = this.db.get('SELECT COUNT(*) AS n FROM attachments WHERE patient_id = ?', patientId) as { n: number };
    const rows = this.db.all(
      `SELECT a.id, a.entity_type AS entityType, a.entity_id AS entityId, a.patient_id AS patientId,
              a.file_name AS fileName, a.stored_name AS storedName, a.mime_type AS mimeType,
              a.size_bytes AS sizeBytes, a.sha256, a.note, u.display_name AS uploadedByName, a.created_at AS createdAt
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE a.patient_id = ? ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      patientId,
      limit,
      offset,
    );
    const dir = this.attachmentsDir();
    return {
      rows: rows.map((r) => ({
        id: str(r, 'id'),
        entityType: str(r, 'entityType'),
        entityId: str(r, 'entityId'),
        patientId: strOrNull(r, 'patientId'),
        fileName: str(r, 'fileName'),
        storedName: str(r, 'storedName'),
        mimeType: str(r, 'mimeType'),
        sizeBytes: int(r, 'sizeBytes'),
        sha256: str(r, 'sha256'),
        note: strOrNull(r, 'note'),
        uploadedByName: strOrNull(r, 'uploadedByName'),
        createdAt: str(r, 'createdAt'),
        filePath: join(dir, str(r, 'storedName')),
      })),
      total: int(totalRow, 'n'),
    };
  }

  delete(actor: AuditActor, id: string): void {
    const attachment = this.getAttachment(id);
    this.db.transaction((tx) => {
      tx.run('DELETE FROM attachments WHERE id = ?', id);
      this.audit.record(actor, {
        action: 'attachment.deleted',
        entityType: attachment.entityType,
        entityId: attachment.entityId,
        summary: `Removed attachment "${attachment.fileName}"`,
      });
    });
    // Delete file after the database row is gone; a crash between the two leaves an orphan file,
    // which is detected by integrity diagnostics, rather than a missing file for an existing row.
    try {
      if (existsSync(attachment.filePath)) unlinkSync(attachment.filePath);
    } catch {
      // Best effort; the file may already be gone or the directory may be read-only.
    }
  }

  /** Read file content for preview. Returns null when the file is missing. */
  readFile(id: string): { buffer: Uint8Array; mimeType: string; fileName: string } | null {
    const attachment = this.getAttachment(id);
    try {
      if (!existsSync(attachment.filePath)) return null;
      const buffer = readFileSync(attachment.filePath);
      return { buffer: new Uint8Array(buffer), mimeType: attachment.mimeType, fileName: attachment.fileName };
    } catch {
      return null;
    }
  }

  /** Integrity: find attachments whose file is missing from disk. */
  findMissingFiles(): AttachmentRow[] {
    const rows = this.db.all(
      `SELECT a.id, a.entity_type AS entityType, a.entity_id AS entityId, a.patient_id AS patientId,
              a.file_name AS fileName, a.stored_name AS storedName, a.mime_type AS mimeType,
              a.size_bytes AS sizeBytes, a.sha256, a.note, u.display_name AS uploadedByName, a.created_at AS createdAt
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by`,
    );
    const dir = this.attachmentsDir();
    const missing: AttachmentRow[] = [];
    for (const r of rows) {
      const filePath = join(dir, str(r, 'storedName'));
      if (!existsSync(filePath)) {
        missing.push({
          id: str(r, 'id'),
          entityType: str(r, 'entityType'),
          entityId: str(r, 'entityId'),
          patientId: strOrNull(r, 'patientId'),
          fileName: str(r, 'fileName'),
          storedName: str(r, 'storedName'),
          mimeType: str(r, 'mimeType'),
          sizeBytes: int(r, 'sizeBytes'),
          sha256: str(r, 'sha256'),
          note: strOrNull(r, 'note'),
          uploadedByName: strOrNull(r, 'uploadedByName'),
          createdAt: str(r, 'createdAt'),
          filePath,
        });
      }
    }
    return missing;
  }

  /** Orphan files on disk that have no database row. */
  findOrphanFiles(): string[] {
    const dir = this.attachmentsDir();
    if (!existsSync(dir)) return [];
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const files = readdirSync(dir);
    const known = new Set(this.db.all('SELECT stored_name AS name FROM attachments').map((r) => String(r.name)));
    return files.filter((f) => !known.has(f)).map((f) => join(dir, f));
  }
}

function sanitizeFileName(input: string): string {
  // Strip path components and control characters; keep only safe characters.
  const base = basename(String(input)).replace(/[\0-\x1F\x7F]/g, '').trim();
  if (base === '' || base === '.' || base === '..') return '';
  // Prevent overly long names that could overflow UI or filesystem limits.
  const trimmed = base.slice(0, 200);
  // Reject names that would be hidden or special on Windows.
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(trimmed)) return `file_${trimmed}`;
  return trimmed;
}

export { ALLOWED_MIMES, MAX_FILE_SIZE };
