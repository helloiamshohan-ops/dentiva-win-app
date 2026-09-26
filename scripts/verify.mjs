/**
 * Dentiva Pro — final build verification gate.
 * Runs all checks required by FINAL BUILD GATE.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')} (exit ${result.status})`);
  }
}

async function main() {
  console.log('=== Dentiva Pro — Final Build Verification ===\n');
  console.log(`Root: ${root}`);
  console.log(`Node: ${process.version}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const gates = [
    { name: 'TypeScript', command: 'npm', args: ['run', 'typecheck'] },
    { name: 'Unit Tests', command: 'npm', args: ['run', 'test:unit'] },
    { name: 'Integration Tests', command: 'npm', args: ['run', 'test:integration'] },
    { name: 'Static Audit', command: 'npm', args: ['run', 'static-audit'] },
    { name: 'Smoke', command: 'npm', args: ['run', 'smoke'] },
  ];

  const results = [];

  for (const gate of gates) {
    console.log(`\n=== Gate: ${gate.name} ===`);
    try {
      run(gate.command, gate.args);
      results.push({ gate: gate.name, result: 'PASSED', evidence: `${gate.command} ${gate.args.join(' ')} exited 0` });
      console.log(`✅ ${gate.name} PASSED`);
    } catch (error) {
      results.push({ gate: gate.name, result: 'FAILED', evidence: error.message });
      console.log(`❌ ${gate.name} FAILED: ${error.message}`);
      // Don't stop on failure; collect all results
    }
  }

  console.log('\n=== Final Gate Summary ===');
  console.table(results);

  const failed = results.filter((r) => r.result === 'FAILED');
  if (failed.length > 0) {
    console.log(`\n❌ ${failed.length} gate(s) FAILED`);
    process.exit(1);
  }

  console.log('\n✅ All verification gates PASSED');
}

main().catch((error) => {
  console.error('Verification failed:', error);
  process.exit(1);
});
