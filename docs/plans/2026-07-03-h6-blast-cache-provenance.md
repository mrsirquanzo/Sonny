# H6 BLAST Caching + DB-Version Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add always-on DB-version provenance to BLAST hits, and an opt-in content-addressed cache around the `blast` dependency so re-running identical queries does not re-hit NCBI.

**Architecture:** Provenance is captured in `blastVerify.ts` (additive raw fields). The cache is a new `blastCache.ts` module (content-addressed, filesystem-backed, injectable) wrapped around the `blast` dep at the CLI/eval seam; it is enabled only when `SONNY_BLAST_CACHE_DIR` is set. The tool itself stays pure.

**Tech Stack:** TypeScript ESM, Vitest, pnpm workspaces, node builtins (`crypto`, `fs`).

## Global Constraints

- No em dashes; plain dash. No commit co-author trailer. ESM `.js` import specifiers.
- Caching is OPT-IN: no cache unless `SONNY_BLAST_CACHE_DIR` is set. When unset, the pipeline behaves exactly as today.
- DB-version provenance is ALWAYS on (independent of caching).
- The cache and `blastVerifyTool` never throw for cache reasons: any cache read/write error degrades to a live call. An `inner` (real BLAST) error still propagates.
- `blastVerifyTool` stays pure - no cache state inside it; caching is an injectable wrapper.
- The cache key normalizes the sequence (uppercase, alpha-only) so casing/whitespace variants share an entry.
- Run `pnpm -r build` (real tsc) before finishing each task, not just `pnpm -r test`. The new module uses node builtins (`crypto`, `fs`) - if tsc flags missing node types in mcp-gateway, `@types/node` is already a devDependency there (added in H4), so this should not recur; confirm via the build.

---

### Task 1: DB-version provenance in `blast_verify`

**Files:**
- Modify: `packages/mcp-gateway/src/blastVerify.ts`
- Test: `packages/mcp-gateway/src/blastVerify.test.ts`

**Interfaces:**
- Produces: each BLAST hit's `raw` gains `dbVersion` (from `BlastOutput_db`) and `blastVersion` (from `BlastOutput_version`).

- [ ] **Step 1: Write the failing test**

Append to `packages/mcp-gateway/src/blastVerify.test.ts`. Reuse the existing `RESULT_XML`/`SUBMIT`/`statusBody` helpers, but this test needs an XML with the db/version fields - define a local variant near the test:

```ts
describe('blastVerify db-version provenance', () => {
  const XML_WITH_DB = `<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_version>BLASTP 2.15.0+</BlastOutput_version>
  <BlastOutput_db>nr</BlastOutput_db>
  <BlastOutput_query-len>10</BlastOutput_query-len>
  <BlastOutput_iterations><Iteration><Iteration_hits><Hit>
    <Hit_accession>ABC123</Hit_accession><Hit_def>test [Homo sapiens]</Hit_def>
    <Hit_hsps><Hsp><Hsp_align-len>10</Hsp_align-len><Hsp_identity>10</Hsp_identity>
      <Hsp_query-from>1</Hsp_query-from><Hsp_query-to>10</Hsp_query-to>
      <Hsp_evalue>0.0</Hsp_evalue><Hsp_bit-score>20</Hsp_bit-score></Hsp></Hit_hsps>
  </Hit></Iteration_hits></Iteration></BlastOutput_iterations>
</BlastOutput>`;

  function fetchWith(xml: string) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(SUBMIT, { status: 200 });
      if (String(url).includes('FORMAT_OBJECT=SearchInfo')) return new Response(statusBody('READY'), { status: 200 });
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('stamps dbVersion and blastVersion onto each hit raw', async () => {
    const ev = await blastVerifyTool.call({ sequence: 'EVQLVESGGG', pollIntervalMs: 0 }, fetchWith(XML_WITH_DB));
    expect((ev[0].raw as Record<string, unknown>).dbVersion).toBe('nr');
    expect((ev[0].raw as Record<string, unknown>).blastVersion).toBe('BLASTP 2.15.0+');
  });

  it('defaults provenance to empty strings when the fields are absent', async () => {
    const ev = await blastVerifyTool.call({ sequence: 'EVQLVESGGG', pollIntervalMs: 0 }, fetchWith(RESULT_XML));
    expect((ev[0].raw as Record<string, unknown>).dbVersion).toBe('');
    expect((ev[0].raw as Record<string, unknown>).blastVersion).toBe('');
  });
});
```

(If `RESULT_XML` lacks a hit or the helper names differ, adapt to the file's actual helpers; keep both assertions.)

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- blastVerify`
Expected: FAIL (dbVersion/blastVersion undefined).

- [ ] **Step 3: Implement**

In `packages/mcp-gateway/src/blastVerify.ts`, extend the parsed-root type and read the two fields:

```ts
    const parsed = parser.parse(await result.text()) as {
      BlastOutput?: { 'BlastOutput_query-len'?: number;
        'BlastOutput_version'?: string; 'BlastOutput_db'?: string;
        BlastOutput_iterations?: { Iteration?: unknown } };
    };
    const root = parsed.BlastOutput;
    const queryLen = Number(root?.['BlastOutput_query-len'] ?? 0);
    const blastVersion = String(root?.['BlastOutput_version'] ?? '');
    const dbVersion = String(root?.['BlastOutput_db'] ?? '');
```

Add the two fields to each hit's `raw` object:

```ts
        raw: { accession, percentIdentity, eValue, bitScore, queryCoverage, organism, database, program, identity, alignLen, dbVersion, blastVersion },
```

- [ ] **Step 4: Run to verify pass, then full gateway suite + build**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- blastVerify` (PASS), then `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test` (PASS), then `pnpm -r build` (Done).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/blastVerify.ts packages/mcp-gateway/src/blastVerify.test.ts
git commit -m "feat(mcp-gateway): stamp BLAST db and program version into hit provenance"
```

---

### Task 2: content-addressed BLAST cache module

**Files:**
- Create: `packages/mcp-gateway/src/blastCache.ts`
- Modify: `packages/mcp-gateway/src/index.ts`
- Test: `packages/mcp-gateway/src/blastCache.test.ts`

**Interfaces:**
- Consumes: `Evidence` from `@sonny/shared`; node `crypto`, `fs`, `path`.
- Produces: `BlastCache`, `CachedBlast`, `BlastFn`, `blastCacheKey`, `FileBlastCache`, `makeCachedBlast`, `blastCacheFromEnv`, `cacheTtlMsFromEnv`.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-gateway/src/blastCache.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- blastCache`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `packages/mcp-gateway/src/blastCache.ts`:

```ts
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
```

In `packages/mcp-gateway/src/index.ts`, export the module:

```ts
export { blastCacheKey, makeCachedBlast, FileBlastCache, blastCacheFromEnv, cacheTtlMsFromEnv } from './blastCache.js';
export type { BlastCache, CachedBlast, BlastFn } from './blastCache.js';
```

- [ ] **Step 4: Run to verify pass, then full gateway suite + build**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- blastCache` (PASS), then `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test` (PASS), then `pnpm -r build` (Done).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/blastCache.ts packages/mcp-gateway/src/index.ts packages/mcp-gateway/src/blastCache.test.ts
git commit -m "feat(mcp-gateway): content-addressed BLAST cache (opt-in, filesystem-backed)"
```

---

### Task 3: wire the opt-in cache into the CLI + eval pipelines

**Files:**
- Modify: `apps/cli/src/patentWorkup.ts`
- Test: `apps/cli/src/patentWorkup.test.ts`
- Modify: `eval/src/patentLive.ts`

**Interfaces:**
- Consumes: `blastCacheFromEnv`, `cacheTtlMsFromEnv`, `makeCachedBlast`, `BlastCache`, `BlastFn` from `@mrsirquanzo/sonny-mcp-gateway`.
- Produces: `WorkupDeps` gains optional `blastCache?: BlastCache`; when a cache is available, both the reconcile `blast` dep and `cdrBlast` are cache-wrapped.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/src/patentWorkup.test.ts`:

```ts
import type { BlastCache } from '@mrsirquanzo/sonny-mcp-gateway';

describe('runPatentWorkup BLAST cache wiring', () => {
  it('routes reconcile + cdr BLAST through an injected cache', async () => {
    const store = new Map<string, { evidence: never[]; cachedAt: string }>();
    let sets = 0;
    const cache: BlastCache = { get: (k) => store.get(k) as never, set: (k, v) => { sets++; store.set(k, v as never); } };
    const out = await runPatentWorkup('/x.pdf', {
      ingest: async () => ({ markdown: 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\n' + 'E'.repeat(60) + '\n', status: 'ok' as const }),
      model: { async generateStructured(o: { system: string }) {
        if (o.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never;
        if (o.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }] }] } as never;
        return { summary: 'ACME.', points: [] } as never;
      } },
      verifier: { model: { async generateStructured() { return { status: 'supported', rationale: '' } as never; } }, modelId: 'x', decorrelated: false },
      blastCache: cache,
    });
    expect(out.ok).toBe(true);
    expect(sets).toBeGreaterThan(0); // the cache was written to (BLAST results flowed through the wrapper)
  });
});
```

NOTE to implementer: this test relies on the REAL `blastVerifyTool` performing a live submit unless the reconcile/cdr blast deps are otherwise injected. To keep it hermetic, ALSO inject `reconcileDeps.blast` and `cdrBlast` returning `[]` is NOT possible here (that would bypass the cache). Instead, prove the wiring by injecting the cache and a fake `reconcileDeps` whose `blast` is the thing being wrapped - see Step 3 for how the cache wraps the dep. If a fully hermetic assertion is hard, assert only that `out.ok` is true with the cache present (the wrapper is exercised) and move the strong cache-behavior assertions to the Task 2 unit tests. Prefer: inject `reconcileDeps: { blast: async () => [], anarci: ..., epo: ... }` and assert the cache wraps it by checking `sets > 0` after a >=50-residue sequence triggers a blast. Adapt to what makes the assertion real and hermetic; keep the test deterministic (no network).

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sonny/cli test -- patentWorkup`
Expected: FAIL (`blastCache` not a recognized dep / not wired).

- [ ] **Step 3: Implement**

In `apps/cli/src/patentWorkup.ts`:

Add imports:

```ts
import { ingestToMarkdown, blastVerifyTool, blastCacheFromEnv, cacheTtlMsFromEnv, makeCachedBlast } from '@mrsirquanzo/sonny-mcp-gateway';
import type { IngestResult, BlastCache, BlastFn } from '@mrsirquanzo/sonny-mcp-gateway';
```

Add to `WorkupDeps`:

```ts
  blastCache?: BlastCache;
```

In `runPatentWorkup`, build the cache-wrapped blast once and use it for both reconcile and cdr. Replace the current reconcile call and cdrBlast default:

```ts
    const rawBlast: BlastFn = (seq, db, opts) => blastVerifyTool.call({ sequence: seq, database: db, ...opts });
    const cache = deps.blastCache ?? blastCacheFromEnv();
    const blast = cache ? makeCachedBlast(rawBlast, cache, { maxAgeMs: cacheTtlMsFromEnv() }) : rawBlast;

    const extracted = await extractPatentData(res.markdown, model);
    const reconcileDeps = deps.reconcileDeps ?? { blast };
    const reconciliation = await reconcilePatent(extracted, reconcileDeps);
    ...
    const cdrBlast = deps.cdrBlast ?? blast;
```

Rationale: when no cache and no explicit deps, `blast === rawBlast === blastVerifyTool.call` - identical to today. When `deps.reconcileDeps` is provided (tests), it is respected as-is. When a cache is present, both reconcile and cdr route through it.

In `eval/src/patentLive.ts`, apply the same wrapping so the live golden runner caches (this is the primary beneficiary). Where it calls `reconcilePatent(extracted)` and builds `cdrBlast`, construct `const cache = blastCacheFromEnv(); const rawBlast = (seq, db, opts) => blastVerifyTool.call({ sequence: seq, database: db, ...opts }); const blast = cache ? makeCachedBlast(rawBlast, cache, { maxAgeMs: cacheTtlMsFromEnv() }) : rawBlast;` and pass `reconcilePatent(extracted, { blast })` and use `blast` for the cdrBlast. Add a `notes` line when the cache is active (e.g. `cache ? notes.push('BLAST cache active') : undefined`).

- [ ] **Step 4: Run to verify pass, then full suites + build**

Run: `pnpm --filter @sonny/cli test -- patentWorkup` (PASS), then `pnpm --filter @sonny/cli test` and `pnpm --filter @sonny/eval test` (PASS), then `pnpm -r build` (all 6 Done), then `pnpm -r test` (all pass).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/patentWorkup.ts apps/cli/src/patentWorkup.test.ts eval/src/patentLive.ts
git commit -m "feat: route BLAST through the opt-in cache in the workup and live eval pipelines"
```

---

## Self-review notes

- Provenance (Task 1) is always on; caching (Tasks 2-3) is opt-in via `SONNY_BLAST_CACHE_DIR`, so no correctness-sensitive run is silently served stale data.
- The cache wrapper sits at the injectable `blast` dep seam; `blastVerifyTool` stays pure.
- The default path (no env, no injected deps) is byte-for-byte the current behavior - `blast === blastVerifyTool.call`.
- Every task runs `pnpm -r build` (real tsc), pre-empting the vitest-hides-type-errors trap.
- Cache and file IO never throw for cache reasons; a real BLAST error still propagates.
