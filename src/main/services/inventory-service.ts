/**
 * Dentiva Pro — inventory service.
 *
 * Stock is derived from immutable movements. Quantity on hand is always recomputable from
 * history, so a corrupted quantity can be detected and repaired rather than silently accepted.
 */

import { AppError, Errors } from '../../shared/errors';
import { newId } from '../../shared/id';
import { toIso, todayKey } from '../../shared/dates';
import {
  MOVEMENT_TYPES,
  checkStock,
  expiryStatus,
  isLowStock,
  recomputeQuantity,
  resolveMovement,
  type MovementType,
} from '../../domain/inventory';
import type { Database, Transaction } from '../db/sqlite';
import { AUDIT_ACTIONS, type AuditActor, type AuditService } from '../audit/audit';
import { int, str, strOrNull } from '../repositories/row';

export interface InventoryItemInput {
  sku: string;
  name: string;
  category?: string | null;
  supplierId?: string | null;
  unit?: string;
  costMinor?: number;
  priceMinor?: number;
  quantity?: number;
  minQuantity?: number;
  batch?: string | null;
  expiryKey?: string | null;
  location?: string | null;
  notes?: string | null;
}

export interface InventoryItemRow {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  supplierId: string | null;
  supplierName: string | null;
  unit: string;
  costMinor: number;
  priceMinor: number;
  quantity: number;
  minQuantity: number;
  batch: string | null;
  expiryKey: string | null;
  expiryStatus: 'expired' | 'expiring_soon' | 'ok' | 'no_expiry';
  isLow: boolean;
  location: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MovementInput {
  type: MovementType;
  quantity?: number;
  delta?: number;
  unitCostMinor?: number | null;
  batch?: string | null;
  expiryKey?: string | null;
  reference?: string | null;
  note?: string | null;
}

export interface MovementRow {
  id: string;
  itemId: string;
  type: MovementType;
  quantity: number;
  signedQuantity: number;
  unitCostMinor: number | null;
  batch: string | null;
  expiryKey: string | null;
  reference: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

export class InventoryService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly options: () => { timeZone: string; expiryWarningDays: number; allowNegativeStock: boolean },
  ) {}

  createItem(actor: AuditActor, input: InventoryItemInput): InventoryItemRow {
    const normalized = this.normalizeItem(input, true);
    const id = newId('itm');
    this.db.transaction((tx) => {
      if (tx.get('SELECT 1 AS ok FROM inventory_items WHERE sku = ?', normalized.sku)) {
        throw Errors.alreadyExists(`An inventory item with SKU "${normalized.sku}" already exists.`);
      }
      if (normalized.supplierId && !tx.get('SELECT 1 AS ok FROM suppliers WHERE id = ?', normalized.supplierId)) {
        throw Errors.notFound('supplier');
      }
      tx.run(
        `INSERT INTO inventory_items (id, sku, name, category, supplier_id, unit, cost_minor, price_minor,
             quantity, min_quantity, batch, expiry_key, location, active, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        normalized.sku,
        normalized.name,
        normalized.category,
        normalized.supplierId,
        normalized.unit,
        normalized.costMinor,
        normalized.priceMinor,
        normalized.quantity,
        normalized.minQuantity,
        normalized.batch,
        normalized.expiryKey,
        normalized.location,
        normalized.notes,
      );
      if (normalized.quantity !== 0) {
        tx.run(
          `INSERT INTO inventory_movements (id, item_id, type, quantity, signed_quantity, unit_cost_minor, batch, expiry_key, reference, note, created_by, created_at)
           VALUES (?, ?, 'stock_in', ?, ?, ?, ?, ?, 'Initial stock', NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          newId('mov'),
          id,
          Math.abs(normalized.quantity),
          normalized.quantity,
          normalized.costMinor || null,
          normalized.batch,
          normalized.expiryKey,
          actor.userId,
        );
      }
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.INVENTORY_CHANGED,
        entityType: 'inventory_item',
        entityId: id,
        summary: `Added inventory item "${normalized.name}" (${normalized.sku})`,
      });
    });
    return this.getItem(id);
  }

  updateItem(actor: AuditActor, itemId: string, input: Partial<InventoryItemInput>): InventoryItemRow {
    const existing = this.getItem(itemId);
    const merged = { ...existing, ...input, id: itemId } as InventoryItemInput & { id: string };
    const normalized = this.normalizeItem(merged, false);
    this.db.transaction((tx) => {
      const clash = tx.get('SELECT id FROM inventory_items WHERE sku = ? AND id <> ?', normalized.sku, itemId);
      if (clash) throw Errors.alreadyExists(`Another item already uses SKU "${normalized.sku}".`);
      if (normalized.supplierId && !tx.get('SELECT 1 AS ok FROM suppliers WHERE id = ?', normalized.supplierId)) {
        throw Errors.notFound('supplier');
      }
      tx.run(
        `UPDATE inventory_items SET sku = ?, name = ?, category = ?, supplier_id = ?, unit = ?, cost_minor = ?,
             price_minor = ?, min_quantity = ?, batch = ?, expiry_key = ?, location = ?, notes = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        normalized.sku,
        normalized.name,
        normalized.category,
        normalized.supplierId,
        normalized.unit,
        normalized.costMinor,
        normalized.priceMinor,
        normalized.minQuantity,
        normalized.batch,
        normalized.expiryKey,
        normalized.location,
        normalized.notes,
        itemId,
      );
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.INVENTORY_CHANGED,
        entityType: 'inventory_item',
        entityId: itemId,
        summary: `Updated inventory item "${normalized.name}"`,
      });
    });
    return this.getItem(itemId);
  }

  recordMovement(actor: AuditActor, itemId: string, input: MovementInput): { item: InventoryItemRow; movement: MovementRow } {
    const item = this.getItem(itemId);
    const resolved = resolveMovement({
      type: input.type,
      quantity: input.quantity ?? 1,
      ...(input.delta !== undefined ? { delta: input.delta } : {}),
      batch: input.batch ?? null,
      expiry: input.expiryKey ?? null,
    });
    const nextQty = checkStock({
      currentQuantity: item.quantity,
      movement: resolved,
      allowNegative: this.options().allowNegativeStock,
    });
    const movementId = newId('mov');
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO inventory_movements (id, item_id, type, quantity, signed_quantity, unit_cost_minor,
             batch, expiry_key, reference, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        movementId,
        itemId,
        resolved.type,
        resolved.quantity,
        resolved.signedQuantity,
        input.unitCostMinor ?? null,
        resolved.batch,
        resolved.expiry,
        (input.reference ?? '').trim().slice(0, 120) || null,
        (input.note ?? '').trim().slice(0, 500) || null,
        actor.userId,
      );
      tx.run('UPDATE inventory_items SET quantity = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?', nextQty, itemId);
      this.audit.record(actor, {
        action: AUDIT_ACTIONS.INVENTORY_CHANGED,
        entityType: 'inventory_item',
        entityId: itemId,
        summary: `${resolved.type.replace('_', ' ')} of ${resolved.quantity} for "${item.name}"`,
        metadata: { type: resolved.type, quantity: resolved.quantity, previousQuantity: item.quantity, newQuantity: nextQty },
      });
    });
    return { item: this.getItem(itemId), movement: this.getMovement(movementId) };
  }

  getItem(itemId: string): InventoryItemRow {
    const row = this.db.get(
      `SELECT it.id, it.sku, it.name, it.category, it.supplier_id AS supplierId, s.name AS supplierName,
              it.unit, it.cost_minor AS costMinor, it.price_minor AS priceMinor, it.quantity,
              it.min_quantity AS minQuantity, it.batch, it.expiry_key AS expiryKey, it.location,
              it.active, it.notes, it.created_at AS createdAt, it.updated_at AS updatedAt
         FROM inventory_items it LEFT JOIN suppliers s ON s.id = it.supplier_id WHERE it.id = ?`,
      itemId,
    );
    if (!row) throw Errors.notFound('inventory item');
    return mapItem(row, this.options().timeZone, this.options().expiryWarningDays);
  }

  listItems(params: {
    search?: string;
    category?: string | null;
    lowStockOnly?: boolean;
    expiredOnly?: boolean;
    includeInactive?: boolean;
    limit: number;
    offset: number;
  }): { rows: InventoryItemRow[]; total: number } {
    const tz = this.options().timeZone;
    const today = todayKey(tz);
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (!params.includeInactive) clauses.push('it.active = 1');
    if (params.category) {
      clauses.push('it.category = ?');
      args.push(params.category);
    }
    if (params.search) {
      const s = `%${params.search.replace(/[%_\\]/g, '\\$&')}%`;
      clauses.push('(it.name LIKE ? OR it.sku LIKE ? OR it.category LIKE ?)');
      args.push(s, s, s);
    }
    if (params.lowStockOnly) clauses.push('it.quantity <= it.min_quantity');
    if (params.expiredOnly) {
      clauses.push('it.expiry_key IS NOT NULL AND it.expiry_key < ?');
      args.push(today);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get(`SELECT COUNT(*) AS n FROM inventory_items it ${where}`, ...args) as { n: number };
    const rows = this.db.all(
      `SELECT it.id, it.sku, it.name, it.category, it.supplier_id AS supplierId, s.name AS supplierName,
              it.unit, it.cost_minor AS costMinor, it.price_minor AS priceMinor, it.quantity,
              it.min_quantity AS minQuantity, it.batch, it.expiry_key AS expiryKey, it.location,
              it.active, it.notes, it.created_at AS createdAt, it.updated_at AS updatedAt
         FROM inventory_items it LEFT JOIN suppliers s ON s.id = it.supplier_id
         ${where} ORDER BY it.name LIMIT ? OFFSET ?`,
      ...args,
      params.limit,
      params.offset,
    );
    return { rows: rows.map((r) => mapItem(r, tz, this.options().expiryWarningDays)), total: int(totalRow, 'n') };
  }

  getMovement(movementId: string): MovementRow {
    const row = this.db.get(
      `SELECT m.id, m.item_id AS itemId, m.type, m.quantity, m.signed_quantity AS signedQuantity,
              m.unit_cost_minor AS unitCostMinor, m.batch, m.expiry_key AS expiryKey, m.reference, m.note,
              u.display_name AS createdByName, m.created_at AS createdAt
         FROM inventory_movements m LEFT JOIN users u ON u.id = m.created_by WHERE m.id = ?`,
      movementId,
    );
    if (!row) throw Errors.notFound('inventory movement');
    return mapMovement(row);
  }

  listMovements(itemId: string, limit: number, offset: number): { rows: MovementRow[]; total: number } {
    const totalRow = this.db.get('SELECT COUNT(*) AS n FROM inventory_movements WHERE item_id = ?', itemId) as { n: number };
    const rows = this.db.all(
      `SELECT m.id, m.item_id AS itemId, m.type, m.quantity, m.signed_quantity AS signedQuantity,
              m.unit_cost_minor AS unitCostMinor, m.batch, m.expiry_key AS expiryKey, m.reference, m.note,
              u.display_name AS createdByName, m.created_at AS createdAt
         FROM inventory_movements m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.item_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
      itemId,
      limit,
      offset,
    );
    return { rows: rows.map(mapMovement), total: int(totalRow, 'n') };
  }

  verifyQuantity(itemId: string): { stored: number; computed: number; matches: boolean } {
    const item = this.getItem(itemId);
    const movements = this.db.all('SELECT signed_quantity AS signedQuantity FROM inventory_movements WHERE item_id = ?', itemId) as {
      signedQuantity: number;
    }[];
    const computed = recomputeQuantity(movements);
    return { stored: item.quantity, computed, matches: item.quantity === computed };
  }

  listSuppliers(): SupplierRow[] {
    return this.db
      .all('SELECT id, name, phone, email, active FROM suppliers ORDER BY name')
      .map((r) => ({ id: str(r, 'id'), name: str(r, 'name'), phone: strOrNull(r, 'phone'), email: strOrNull(r, 'email'), active: int(r, 'active') === 1 }));
  }

  createSupplier(actor: AuditActor, input: { name: string; phone?: string | null; email?: string | null; address?: string | null }): SupplierRow {
    const name = input.name.trim();
    if (name === '' || name.length > 150) throw Errors.validation('Enter a supplier name of up to 150 characters.', { name: 'Enter a name.' });
    const id = newId('sup');
    this.db.run(
      `INSERT INTO suppliers (id, name, phone, email, address, active, created_at, updated_at)
       VALUES (?,?,?,?,?,1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      id,
      name,
      input.phone ?? null,
      input.email ?? null,
      input.address ?? null,
    );
    this.audit.record(actor, { action: 'supplier.created', entityType: 'supplier', entityId: id, summary: `Added supplier "${name}"` });
    return { id, name, phone: input.phone ?? null, email: input.email ?? null, active: true };
  }

  categories(): string[] {
    return this.db
      .all('SELECT DISTINCT category FROM inventory_items WHERE category IS NOT NULL AND category <> \'\' ORDER BY category')
      .map((r) => str(r, 'category'));
  }

  private normalizeItem(input: InventoryItemInput, isCreate: boolean): Required<InventoryItemInput> {
    const sku = (input.sku ?? '').trim().toUpperCase();
    if (sku === '' || sku.length > 40) throw Errors.validation('Enter an SKU of up to 40 characters.', { sku: 'Enter an SKU.' });
    const name = (input.name ?? '').trim();
    if (name === '' || name.length > 200) throw Errors.validation('Enter an item name of up to 200 characters.', { name: 'Enter a name.' });
    const costMinor = input.costMinor ?? 0;
    const priceMinor = input.priceMinor ?? 0;
    if (!Number.isSafeInteger(costMinor) || costMinor < 0) throw Errors.validation('Cost must be zero or greater.', { costMinor: 'Enter a valid cost.' });
    if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) throw Errors.validation('Price must be zero or greater.', { priceMinor: 'Enter a valid price.' });
    const qty = input.quantity ?? 0;
    if (!Number.isSafeInteger(qty) && isCreate) throw Errors.validation('Quantity must be a whole number.', { quantity: 'Enter a valid quantity.' });
    if (input.expiryKey && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiryKey)) {
      throw Errors.validation('Enter a valid expiry date.', { expiryKey: 'Enter a valid date.' });
    }
    return {
      sku,
      name,
      category: input.category?.trim() ? input.category.trim().slice(0, 80) : null,
      supplierId: input.supplierId ?? null,
      unit: (input.unit ?? 'unit').trim().slice(0, 20) || 'unit',
      costMinor,
      priceMinor,
      quantity: qty,
      minQuantity: input.minQuantity ?? 0,
      batch: input.batch?.trim()?.slice(0, 80) ?? null,
      expiryKey: input.expiryKey ?? null,
      location: input.location?.trim()?.slice(0, 80) ?? null,
      notes: input.notes?.trim()?.slice(0, 1000) ?? null,
    };
  }
}

function mapItem(row: Record<string, unknown>, timeZone: string, warningDays: number): InventoryItemRow {
  const expiryKey = strOrNull(row, 'expiryKey');
  const today = todayKey(timeZone);
  return {
    id: str(row, 'id'),
    sku: str(row, 'sku'),
    name: str(row, 'name'),
    category: strOrNull(row, 'category'),
    supplierId: strOrNull(row, 'supplierId'),
    supplierName: strOrNull(row, 'supplierName'),
    unit: str(row, 'unit'),
    costMinor: int(row, 'costMinor'),
    priceMinor: int(row, 'priceMinor'),
    quantity: int(row, 'quantity'),
    minQuantity: int(row, 'minQuantity'),
    batch: strOrNull(row, 'batch'),
    expiryKey,
    expiryStatus: expiryStatus(expiryKey, today, warningDays),
    isLow: isLowStock(int(row, 'quantity'), int(row, 'minQuantity')),
    location: strOrNull(row, 'location'),
    active: int(row, 'active') === 1,
    notes: strOrNull(row, 'notes'),
    createdAt: str(row, 'createdAt'),
    updatedAt: str(row, 'updatedAt'),
  };
}

function mapMovement(row: Record<string, unknown>): MovementRow {
  return {
    id: str(row, 'id'),
    itemId: str(row, 'itemId'),
    type: String(row.type) as MovementType,
    quantity: int(row, 'quantity'),
    signedQuantity: int(row, 'signedQuantity'),
    unitCostMinor: row.unitCostMinor === null || row.unitCostMinor === undefined ? null : int(row, 'unitCostMinor'),
    batch: strOrNull(row, 'batch'),
    expiryKey: strOrNull(row, 'expiryKey'),
    reference: strOrNull(row, 'reference'),
    note: strOrNull(row, 'note'),
    createdByName: strOrNull(row, 'createdByName'),
    createdAt: str(row, 'createdAt'),
  };
}

export interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  active: boolean;
}
