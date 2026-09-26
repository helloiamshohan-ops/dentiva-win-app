/**
 * Generate SHA-256 checksums for release artifacts.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseDir = join(root, 'release');

function sha256(filePath) {
  const buffer = readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

function main() {
  if (!existsSync(releaseDir)) {
    console.log('No release directory found. Run npm run dist:win first.');
    process.exit(0);
  }

  const files = readdirSync(releaseDir);
  console.log('Release artifacts checksums:\n');

  for (const file of files) {
    const fullPath = join(releaseDir, file);
    const stat = statSync(fullPath);
    if (stat.isFile()) {
      const hash = sha256(fullPath);
      console.log(`${file}`);
      console.log(`  Size: ${stat.size} bytes`);
      console.log(`  SHA-256: ${hash}`);
      console.log('');
    }
  }
}

main();
