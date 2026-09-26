import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

for (const dir of ['dist', 'release', 'coverage', 'out', 'build-output']) {
  const path = fileURLToPath(new URL(`../${dir}`, import.meta.url));
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    console.log(`Cleaned ${dir}/`);
  }
}

console.log('Clean complete.');
