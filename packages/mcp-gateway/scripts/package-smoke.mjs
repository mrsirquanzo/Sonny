import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'sonny-package-smoke-'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', temporaryRoot], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
  const tarball = resolve(temporaryRoot, 'mrsirquanzo-sonny-mcp-gateway-0.1.0.tgz');
  execFileSync('tar', ['-xzf', tarball, '-C', temporaryRoot], { stdio: 'pipe' });
  const installed = resolve(temporaryRoot, 'package');
  const runtimeModule = await import(pathToFileURL(resolve(installed, 'dist/runtimeAssets.js')).href);
  const assets = runtimeModule.resolveAnalysisRuntimeAssets();
  const missing = Object.entries(assets).filter(([, path]) => !existsSync(path));
  if (missing.length > 0) throw new Error(`packaged assets missing: ${missing.map(([name]) => name).join(', ')}`);

  const packageJson = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8'));
  if (packageJson.files?.length !== 1 || packageJson.files[0] !== 'dist') {
    throw new Error('package files allowlist must ship the self-contained dist tree');
  }
  process.stdout.write('packaged analysis assets resolve (CI release gate must also run pnpm test:docker)\n');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
