import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence } from '@mrsirquanzo/sonny-shared';

export interface CachedBlast { evidence: Evidence[]; cachedAt: string }
export interface BlastCache {
  get(key: string): CachedBlast | undefined;
  set(key: string, value: CachedBlast): void;
}
export type BlastFn = (sequence: string, database: string, opts?: { wordSize?: number; matrix?: string; expect?: number }) => Promise<Evidence[]>;

function normSeq(s: string): string { return s.replace(/[^A-Za-z]/g, '').toUpperCase(); }

export function blastCacheKey(args: { sequence: string; database: string; program?: string; expect?: number; maxHits?: number; wordSize?: number; matrix?: string }): string {
  const canonical = [args.program ?? '', args.database, args.expect ?? '', args.maxHits ?? '', args.wordSize ?? '', args.matrix ?? '', normSeq(args.sequence)].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export class FileBlastCache implements BlastCache {
  constructor(private readonly dir: string) {}
  private path(key: string): string { return join(this.dir, `${key}.json`); }
  get(key: string): CachedBlast | undefined {
    try {
      const p = this.path(key);
      if (!existsSync(p)) return undefined;
      return JSON.parse(readFileSync(p, 'utf8')) as CachedBlast;
    } catch { return undefined; }
  }
  set(key: string, value: CachedBlast): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path(key), JSON.stringify(value));
    } catch { /* best-effort */ }
  }
}

export function makeCachedBlast(inner: BlastFn, cache: BlastCache, opts?: { maxAgeMs?: number }): BlastFn {
  return async (sequence, database, callOpts) => {
    const key = blastCacheKey({ sequence, database, wordSize: callOpts?.wordSize, matrix: callOpts?.matrix, expect: callOpts?.expect });
    const hit = cache.get(key);
    if (hit && !isExpired(hit.cachedAt, opts?.maxAgeMs)) return hit.evidence;
    const evidence = await inner(sequence, database, callOpts);
    cache.set(key, { evidence, cachedAt: new Date().toISOString() });
    return evidence;
  };
}

function isExpired(cachedAt: string, maxAgeMs?: number): boolean {
  if (maxAgeMs === undefined) return false;
  const t = Date.parse(cachedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > maxAgeMs;
}

export function blastCacheFromEnv(env: NodeJS.ProcessEnv = process.env): BlastCache | undefined {
  const dir = env.SONNY_BLAST_CACHE_DIR;
  return dir ? new FileBlastCache(dir) : undefined;
}

export function cacheTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const days = env.SONNY_BLAST_CACHE_TTL_DAYS;
  if (!days) return undefined;
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? n * 86400000 : undefined;
}
