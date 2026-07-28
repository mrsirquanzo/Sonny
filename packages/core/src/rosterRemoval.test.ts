import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '__s2__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

describe('dead SPECIALISTS roster removal', () => {
  it('has no source import or reference to the SPECIALISTS value anywhere', () => {
    const roots = ['packages/core/src', 'packages/shared/src', 'packages/mcp-gateway/src', 'apps', 'eval/src'];
    const hits = roots.flatMap((r) => sources(r))
      .filter((f) => /\bSPECIALISTS\b/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('no longer ships specialists.ts', () => {
    expect(existsSync('packages/core/src/specialists.ts')).toBe(false);
  });
});
