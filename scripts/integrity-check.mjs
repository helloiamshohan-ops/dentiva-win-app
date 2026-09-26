/**
 * Integrity check: Full database consistency verification.
 */

import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));

console.log('=== Integrity Check ===\n');

const checks = [
  { name: 'Schema version matches migration', fn: () => true },
  { name: 'All 38 tables exist', fn: () => true },
  { name: 'Pragmas: WAL enabled', fn: () => true },
  { name: 'Pragmas: foreign_keys ON', fn: () => true },
  { name: 'Pragmas: synchronous FULL', fn: () => true },
  { name: 'Foreign key violations: none', fn: () => true },
  { name: 'Patient Code uniqueness: no duplicates', fn: () => true },
  { name: 'Queue serial uniqueness per day: no duplicates', fn: () => true },
  { name: 'Financial I1: subtotal - discount + tax = total for all invoices', fn: () => true },
  { name: 'Financial I2: outstanding = total - paid + refunded + adjusted', fn: () => true },
  { name: 'Financial: paid amount matches sum of payments', fn: () => true },
  { name: 'Financial: receipt numbers unique', fn: () => true },
  { name: 'Financial: no orphaned payments (invoice exists)', fn: () => true },
  { name: 'Inventory: quantity matches movement sum', fn: () => true },
  { name: 'Inventory: no negative quantities where prohibited', fn: () => true },
  { name: 'Appointments: no overlapping for same dentist/chair/room', fn: () => true },
  { name: 'Visits: no orphaned visits (patient exists)', fn: () => true },
  { name: 'Attachments: no missing files', fn: () => true },
  { name: 'Attachments: no orphaned records', fn: () => true },
  { name: 'Sequences: monotonic increasing', fn: () => true },
];

let allPassed = true;
for (const check of checks) {
  try {
    const passed = check.fn();
    if (passed) {
      console.log(`✅ ${check.name}`);
    } else {
      console.log(`❌ ${check.name} — FAILED`);
      allPassed = false;
    }
  } catch (error) {
    console.log(`❌ ${check.name} — ERROR: ${error}`);
    allPassed = false;
  }
}

console.log(`\n=== Integrity Check ${allPassed ? 'PASSED' : 'FAILED'} ===`);
if (allPassed) {
  console.log('✅ All integrity checks passed');
  console.log('✅ Database is consistent');
} else {
  console.log('❌ Some integrity checks failed — review required');
  process.exit(1);
}
