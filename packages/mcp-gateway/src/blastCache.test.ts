import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evidence } from '@mrsirquanzo/sonny-shared';
import { blastCacheKey, makeCachedBlast, FileBlastCache, blastCacheFromEnv, cacheTtlMsFromEnv } from './blastCache.js';

const ev = (acc: string): Evidence => ({ id: `BLAST:${acc}`, kind: 'dataset', source: 's', title: 't', snippet: '', url: '', raw: { accession: acc }, retrievedAt: '2026-01-01T00:00:00Z' });

describe('blastCacheKey', () => {
  it('is stable for identical params and differs for different ones', () => {
    const base = { sequence: 'EVQLV', database: 'nr' };
    expect(blastCacheKey(base)).toBe(blastCacheKey(base));
    expect(blastCacheKey(base)).not.toBe(blastCacheKey({ ...base, database: 'pataa' }));
    expect(blastCacheKey(base)).not.toBe(blastCacheKey({ ...base, wordSize: 2 }));
  });
  it('normalizes casing/whitespace of the sequence', () => {
    expect(blastCacheKey({ sequence: 'ev ql v', database: 'nr' })).toBe(blastCacheKey({ sequence: 'EVQLV', database: 'nr' }));
  });
});

describe('makeCachedBlast', () => {
  function memCache() {
    const m = new Map<string, { evidence: Evidence[]; cachedAt: string }>();
    return { store: m, get: (k: string) => m.get(k), set: (k: string, v: { evidence: Evidence[]; cachedAt: string }) => { m.set(k, v); } };
  }
  it('caches: inner called once for two identical calls', async () => {
    let calls = 0;
    const inner = async () => { calls++; return [ev('A')]; };
    const cached = makeCachedBlast(inner, memCache());
    const a = await cached('EVQLV', 'nr');
    const b = await cached('EVQLV', 'nr');
    expect(calls).toBe(1);
    expect(b.map((e) => e.id)).toEqual(a.map((e) => e.id));
  });
  it('different params miss', async () => {
    let calls = 0;
    const inner = async () => { calls++; return [ev('A')]; };
    const cached = makeCachedBlast(inner, memCache());
    await cached('EVQLV', 'nr');
    await cached('EVQLV', 'pataa');
    expect(calls).toBe(2);
  });
  it('an inner error propagates (only cache errors are swallowed)', async () => {
    const cached = makeCachedBlast(async () => { throw new Error('ncbi down'); }, memCache());
    await expect(cached('EVQLV', 'nr')).rejects.toThrow('ncbi down');
  });
  it('an entry older than maxAgeMs is a miss', async () => {
    let calls = 0;
    const inner = async () => { calls++; return [ev('A')]; };
    const c = memCache();
    c.store.set(blastCacheKey({ sequence: 'EVQLV', database: 'nr' }), { evidence: [ev('OLD')], cachedAt: '2000-01-01T00:00:00Z' });
    const cached = makeCachedBlast(inner, c, { maxAgeMs: 1000 });
    const out = await cached('EVQLV', 'nr');
    expect(calls).toBe(1);
    expect(out.map((e) => e.id)).toEqual(['BLAST:A']);
  });
});

describe('FileBlastCache', () => {
  it('round-trips and returns undefined on miss/corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blastcache-'));
    try {
      const c = new FileBlastCache(dir);
      expect(c.get('k1')).toBeUndefined();
      c.set('k1', { evidence: [ev('A')], cachedAt: '2026-01-01T00:00:00Z' });
      expect(c.get('k1')?.evidence[0].id).toBe('BLAST:A');
      writeFileSync(join(dir, 'k2.json'), 'not json');
      expect(c.get('k2')).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('env factories', () => {
  it('blastCacheFromEnv returns a cache only when SONNY_BLAST_CACHE_DIR set', () => {
    expect(blastCacheFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(blastCacheFromEnv({ SONNY_BLAST_CACHE_DIR: tmpdir() } as NodeJS.ProcessEnv)).toBeInstanceOf(FileBlastCache);
  });
  it('cacheTtlMsFromEnv converts days to ms', () => {
    expect(cacheTtlMsFromEnv({ SONNY_BLAST_CACHE_TTL_DAYS: '7' } as NodeJS.ProcessEnv)).toBe(7 * 86400000);
    expect(cacheTtlMsFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
