# H6 BLAST Caching + DB-Version Provenance Design

**Status:** Approved to build (extends the locked hardening roadmap; user said proceed).
**Parent:** [Patent Specialist Hardening Roadmap](./2026-07-02-patent-specialist-hardening-roadmap.md), H6.
**Date:** 2026-07-03.

## Purpose

Two related reproducibility/etiquette closers for the BLAST layer:

1. **DB-version provenance (always on).** A BLAST verdict is only reproducible if it records which database and program version produced it. Today each hit carries `retrievedAt` but not the DB or BLAST version. Capture `BlastOutput_db` and `BlastOutput_version` (both in the NCBI XML) into every hit's `raw`.
2. **Content-addressed cache (opt-in).** Re-running the same patent (development, demos, and especially the H1b golden eval) should not re-submit identical queries to NCBI. A content-addressed cache keyed by the query + database + program + params returns a stored result, cutting cost and honoring NCBI etiquette. This is the prerequisite the roadmap names for a non-flaky live tier.

## Key decisions

1. **Caching is opt-in, off by default.** Enabled only when `SONNY_BLAST_CACHE_DIR` is set. A production or verification run with no cache dir always hits live NCBI, so caching can never silently serve a stale match in a correctness-sensitive run. Caching is for the eval/dev/demo paths that re-run the same queries.
2. **DB-version provenance is always on** (independent of caching): every hit carries `dbVersion` + `blastVersion` regardless of cache state.
3. **Staleness is visible, not silent.** Each cache entry stores `cachedAt`, and each cached hit still carries the `dbVersion`/`retrievedAt` from when it was actually fetched. An optional `SONNY_BLAST_CACHE_TTL_DAYS` bounds age (default: no expiry, reproducibility-first); an over-age entry is treated as a miss and re-fetched.
4. **The tool stays pure.** `blastVerifyTool` is not given cache state. Caching is an injectable wrapper at the `blast` dep boundary (the same dependency-injection seam reconcile/cdr already use), so tests inject an in-memory cache and no real FS/network.

## 1. DB-version provenance (mcp-gateway `blastVerify.ts`)

Extend the XML root destructure to read `BlastOutput_version` and `BlastOutput_db`:

```ts
const parsed = ... as { BlastOutput?: {
  'BlastOutput_query-len'?: number;
  'BlastOutput_version'?: string;
  'BlastOutput_db'?: string;
  BlastOutput_iterations?: { Iteration?: unknown };
} };
const blastVersion = String(root?.['BlastOutput_version'] ?? '');
const dbVersion = String(root?.['BlastOutput_db'] ?? '');
```

Add `dbVersion` and `blastVersion` to each hit's `raw`. Additive; no behavior change to identity/coverage.

## 2. Content-addressed cache (mcp-gateway, new `blastCache.ts`)

```ts
export interface CachedBlast { evidence: Evidence[]; cachedAt: string }
export interface BlastCache {
  get(key: string): CachedBlast | undefined;   // undefined on miss or any read error (never throws)
  set(key: string, value: CachedBlast): void;  // best-effort (swallows write errors)
}

// Canonical key over the parameters that change the BLAST result. Sequence is normalized
// (uppercase, alpha-only - the same normalization blast_verify applies) so casing/whitespace
// variants of the same query share a cache entry.
export function blastCacheKey(args: {
  sequence: string; database: string; program?: string;
  expect?: number; maxHits?: number; wordSize?: number; matrix?: string;
}): string;   // sha256 hex of `program|database|expect|maxHits|wordSize|matrix|<normalized-seq>`

export class FileBlastCache implements BlastCache {   // stores <dir>/<key>.json
  constructor(dir: string);
}

// Wrap a blast function with the cache. maxAgeMs undefined = no expiry.
export type BlastFn = (sequence: string, database: string, opts?: { wordSize?: number; matrix?: string; expect?: number }) => Promise<Evidence[]>;
export function makeCachedBlast(inner: BlastFn, cache: BlastCache, opts?: { maxAgeMs?: number }): BlastFn;

// Build a cache from env: FileBlastCache(SONNY_BLAST_CACHE_DIR) when set, else undefined (no caching).
export function blastCacheFromEnv(env?: NodeJS.ProcessEnv): BlastCache | undefined;
export function cacheTtlMsFromEnv(env?: NodeJS.ProcessEnv): number | undefined;  // SONNY_BLAST_CACHE_TTL_DAYS -> ms
```

`makeCachedBlast` behavior: compute the key from `(sequence, database, opts)`; on a fresh hit (within `maxAgeMs`) return the cached `evidence`; on miss/expired call `inner`, then `set` the result and return it. A cache read/write error never propagates - it falls through to `inner`. `FileBlastCache.get` returns undefined on a missing file or a parse error; `set` writes atomically-ish (best-effort) and swallows errors. `crypto.createHash('sha256')` (node builtin) for the key.

## 3. Wiring (opt-in)

Where the real `blast` dep is constructed for the pipeline (CLI `runPatentWorkup` and eval `patentLive`), wrap it when a cache is available:

```ts
const cache = blastCacheFromEnv();
const rawBlast: BlastFn = (seq, db, opts) => blastVerifyTool.call({ sequence: seq, database: db, ...opts });
const blast = cache ? makeCachedBlast(rawBlast, cache, { maxAgeMs: cacheTtlMsFromEnv() }) : rawBlast;
```

Use `blast` for both the reconcile `blast` dep and the `cdrBlast` dep, so whole-sequence and CDR-H3 queries are both cached (keyed distinctly by their params). Injectable so tests pass an explicit cache or none. No change when `SONNY_BLAST_CACHE_DIR` is unset - the pipeline behaves exactly as today.

## Error handling

- `FileBlastCache` never throws: read errors -> `get` returns undefined; write errors -> `set` is a no-op.
- `makeCachedBlast` never throws for cache reasons: any cache failure degrades to a live `inner` call.
- `blastVerify` provenance fields default to empty strings when absent from the XML (a mock/older response is not a crash).

## Testing

- provenance: a BLAST XML fixture with `BlastOutput_db`/`BlastOutput_version` yields hits whose `raw.dbVersion`/`raw.blastVersion` are populated; absent fields -> empty strings.
- `blastCacheKey`: identical params -> identical key; a different db / wordSize / matrix / normalized-sequence -> different key; casing/whitespace variants of the same residues -> same key.
- `makeCachedBlast` with an in-memory cache: first call invokes `inner` and stores; second identical call returns the cached evidence WITHOUT invoking `inner` (assert an inner call-count of 1); a different-params call is a miss (inner called again); an expired entry (cachedAt older than maxAgeMs) is a miss; an `inner` that throws still propagates (only cache errors are swallowed).
- `FileBlastCache` with a temp dir: set then get round-trips; get on a missing key -> undefined; a corrupt file -> undefined (no throw).
- `blastCacheFromEnv`: returns a cache when `SONNY_BLAST_CACHE_DIR` set, undefined otherwise. `cacheTtlMsFromEnv`: `SONNY_BLAST_CACHE_TTL_DAYS=7` -> 7*86400000; unset -> undefined.

## Out of scope

- A shared/remote cache (this is a local filesystem cache).
- Caching EPO or ANARCI results (BLAST is the slow, rate-limited, cost-relevant call).
- Automatic cache eviction/size limits (TTL + manual clear suffice; a lone patent workup writes few entries).
