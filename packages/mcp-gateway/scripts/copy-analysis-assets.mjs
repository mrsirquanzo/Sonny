import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(packageRoot, 'dist');

for (const directory of ['sandbox', 'dataLake']) {
  const destination = resolve(distRoot, directory);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(
    resolve(packageRoot, directory === 'sandbox' ? 'sandbox' : 'src/dataLake'),
    destination,
    { recursive: true },
  );
}
