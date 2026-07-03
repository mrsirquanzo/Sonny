# Reranker Retrieval Upgrade (Slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder Europe PMC hits by question-relevance (a provider-agnostic hosted cross-encoder) over a widened candidate pool, so the most relevant paper - not the most cited - gets deep-read and enters the store.

**Architecture:** `europepmc_search` gains an optional `pageSize`. A new provider-agnostic `rerankHits` (in `mcp-gateway`) POSTs hits to a configurable rerank API and returns them reordered. `researcher.ts` fetches 25 when rerank is on, keeps the lexical `relevanceGate` as a grounding safety net, reranks via a thin `rerankResearchHits` core helper (which emits a `rerank` trace event and degrades to citation order on failure), and keeps the top 8.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod, Vitest, pnpm workspaces. Packages: `@mrsirquanzo/sonny-shared`, `@mrsirquanzo/sonny-mcp-gateway`, `@mrsirquanzo/sonny-core`.

## Global Constraints

- **Branch:** `hardening/slice-3-reranker` (already created off `main`). Spec: `docs/specs/2026-07-03-reranker-retrieval-design.md`.
- **Lineage:** `main` - packages are `@mrsirquanzo/sonny-*`. ESM import specifiers end in `.js`.
- **Provider-agnostic:** no provider name in the code path. Config via `SONNY_RERANK_ENDPOINT` (default `https://api.cohere.com/v2/rerank`), `SONNY_RERANK_MODEL` (default `rerank-v3.5`), `SONNY_RERANK_API_KEY`. Response parsed leniently: `body.results ?? body.data`, items `{ index, relevance_score }`.
- **Reranking is additive, never load-bearing.** Any failure degrades to citation order. No candidate is silently lost (unranked hits appended in original order).
- **Grounding:** the reorder is derived only from our own input hits; out-of-range/duplicate response indices are dropped, never fabricated.
- **Gating:** rerank runs only when `SONNY_RERANK !== 'off'` AND `SONNY_RERANK_API_KEY` is set. Store size stays 8 (`slice(0, 8)`); the widened fetch is 25.
- **TDD:** failing test first, per task. **No network in tests** - inject `fetchImpl`/`rerank`.
- **Test commands:** `pnpm --filter @mrsirquanzo/sonny-<pkg> exec vitest run <path>`; type-check `... exec tsc --noEmit`. Whole repo: `pnpm -r build && pnpm -r test`.

---

## Task 1: `europepmc_search` optional `pageSize`

**Files:**
- Modify: `packages/mcp-gateway/src/europePmc.ts`
- Test: `packages/mcp-gateway/src/europePmc.test.ts`

**Interfaces:**
- Produces: `europepmc_search` accepts an optional `pageSize` arg (default 8, clamped to [1, 100]); the request URL uses it.

- [ ] **Step 1: Write the failing test**

Add to `packages/mcp-gateway/src/europePmc.test.ts`:

```typescript
import { europePmcSearchTool } from './europePmc.js';

describe('europepmc_search pageSize', () => {
  it('defaults to pageSize=8 and honors an explicit pageSize', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (u: RequestInfo | URL) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await europePmcSearchTool.call({ query: 'EGFR' }, fakeFetch);
    await europePmcSearchTool.call({ query: 'EGFR', pageSize: 25 }, fakeFetch);

    expect(urls[0]).toContain('pageSize=8');
    expect(urls[1]).toContain('pageSize=25');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec vitest run src/europePmc.test.ts`
Expected: FAIL (the URL is hardcoded to `pageSize=8`, so the 25 assertion fails).

- [ ] **Step 3: Make `pageSize` configurable**

In `packages/mcp-gateway/src/europePmc.ts`, inside `call`, after `const query = ...`, add:

```typescript
    const pageSize = Math.min(Math.max(Number(args.pageSize ?? 8), 1), 100);
```

and change the URL line to use it:

```typescript
    const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=${pageSize}&sort=${encodeURIComponent('CITED desc')}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec vitest run src/europePmc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/europePmc.ts packages/mcp-gateway/src/europePmc.test.ts
git commit -m "feat(mcp-gateway): optional pageSize on europepmc_search (default 8)"
```

---

## Task 2: `rerankHits` (provider-agnostic hosted reranker)

**Files:**
- Create: `packages/mcp-gateway/src/rerank.ts`
- Test: `packages/mcp-gateway/src/rerank.test.ts`
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Consumes: `Evidence` (from `@mrsirquanzo/sonny-shared`).
- Produces: `rerankHits(opts: RerankOpts): Promise<Evidence[]>` and the `RerankOpts` interface. Reorders `hits` by the rerank API's descending `relevance_score`; returns `hits` unchanged (no network) when `hits.length < 2`; throws on missing key or non-OK HTTP.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-gateway/src/rerank.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { Evidence } from '@mrsirquanzo/sonny-shared';
import { rerankHits } from './rerank.js';

function hit(id: string, title: string): Evidence {
  return { id, kind: 'publication', source: 's', title, snippet: '', passage: `${title} abstract`, url: 'u', raw: {}, retrievedAt: 'now' };
}
const hits = [hit('PMID:1', 'alpha'), hit('PMID:2', 'beta'), hit('PMID:3', 'gamma')];

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

describe('rerankHits', () => {
  it('reorders hits by descending relevance_score, mapping index back', async () => {
    // rank hit index 2 first, then 0, then 1
    const fetchImpl = jsonFetch({ results: [
      { index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 },
    ] });
    const out = await rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl });
    expect(out.map((h) => h.id)).toEqual(['PMID:3', 'PMID:1', 'PMID:2']);
  });

  it('accepts the alternate `data` response shape', async () => {
    const fetchImpl = jsonFetch({ data: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.1 }] });
    const out = await rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl });
    expect(out[0].id).toBe('PMID:2');
  });

  it('appends hits the response did not rank, preserving order (no candidate lost)', async () => {
    const fetchImpl = jsonFetch({ results: [{ index: 2, relevance_score: 0.9 }] });
    const out = await rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl });
    expect(out.map((h) => h.id)).toEqual(['PMID:3', 'PMID:1', 'PMID:2']);
  });

  it('drops an out-of-range index rather than fabricating a hit', async () => {
    const fetchImpl = jsonFetch({ results: [{ index: 9, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }] });
    const out = await rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl });
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('PMID:1');
  });

  it('returns hits unchanged with no network call when fewer than 2', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const one = [hit('PMID:1', 'alpha')];
    expect(await rerankHits({ question: 'q', hits: one, apiKey: 'k', fetchImpl })).toEqual(one);
    expect(called).toBe(false);
  });

  it('throws when no API key is configured', async () => {
    await expect(rerankHits({ question: 'q', hits, apiKey: undefined, fetchImpl: jsonFetch({}) }))
      .rejects.toThrow(/api key/i);
  });

  it('throws on non-OK HTTP', async () => {
    await expect(rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl: jsonFetch({}, 429) }))
      .rejects.toThrow(/HTTP 429/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec vitest run src/rerank.test.ts`
Expected: FAIL (`rerank.js` does not exist).

- [ ] **Step 3: Write the implementation**

Create `packages/mcp-gateway/src/rerank.ts`:

```typescript
import type { Evidence } from '@mrsirquanzo/sonny-shared';

const DEFAULT_ENDPOINT = 'https://api.cohere.com/v2/rerank';
const DEFAULT_MODEL = 'rerank-v3.5';

export interface RerankOpts {
  question: string;
  hits: Evidence[];
  topN?: number;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

interface RerankItem { index: number; relevance_score: number }

// Reorder hits by a hosted cross-encoder's relevance to the question. Provider-agnostic:
// endpoint/model/key are configurable and the response is parsed leniently (results|data).
export async function rerankHits(opts: RerankOpts): Promise<Evidence[]> {
  const { question, hits } = opts;
  if (hits.length < 2) return hits;

  const endpoint = opts.endpoint ?? process.env.SONNY_RERANK_ENDPOINT ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? process.env.SONNY_RERANK_MODEL ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env.SONNY_RERANK_API_KEY;
  if (!apiKey) throw new Error('rerank: no API key (set SONNY_RERANK_API_KEY)');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const topN = opts.topN ?? hits.length;

  const documents = hits.map((h) => `${h.title}\n${h.passage ?? h.snippet}`);
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, query: question, documents, top_n: topN }),
  });
  if (!res.ok) throw new Error(`rerank HTTP ${res.status}`);

  const body = (await res.json()) as { results?: RerankItem[]; data?: RerankItem[] };
  const ranked = (body.results ?? body.data ?? [])
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < hits.length)
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const seen = new Set<number>();
  const out: Evidence[] = [];
  for (const r of ranked) {
    if (seen.has(r.index)) continue;
    seen.add(r.index);
    out.push(hits[r.index]);
  }
  // Any hit the response did not name is appended in original order - no candidate lost.
  hits.forEach((h, i) => { if (!seen.has(i)) out.push(h); });
  return out;
}
```

- [ ] **Step 4: Export it**

Add to `packages/mcp-gateway/src/index.ts`:

```typescript
export { rerankHits } from './rerank.js';
export type { RerankOpts } from './rerank.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec vitest run src/rerank.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-gateway/src/rerank.ts packages/mcp-gateway/src/rerank.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): provider-agnostic rerankHits (hosted cross-encoder, lenient parse)"
```

---

## Task 3: Trace event + `rerankResearchHits` + researcher wiring

**Files:**
- Modify: `packages/shared/src/contracts.ts` (TraceEvent union)
- Create: `packages/core/src/rerankStep.ts`
- Test: `packages/core/src/rerankStep.test.ts`
- Modify: `packages/core/src/researcher.ts`

**Interfaces:**
- Consumes: `rerankHits` (Task 2); `Evidence`, `TraceEvent` (from `@mrsirquanzo/sonny-shared`); `relevanceGate`, `safeToolCall`, `buildSearchQuery` (already imported in `researcher.ts`).
- Produces:
  - `TraceEvent` gains `{ type: 'rerank'; specialist: string; before: string[]; after: string[] }`.
  - `rerankResearchHits(opts: { specialist: string; question: string; hits: Evidence[]; emit: (e: TraceEvent) => void; rerank?: (o: { question: string; hits: Evidence[] }) => Promise<Evidence[]> }): Promise<Evidence[]>` - reranks, emits a `rerank` event on success, degrades (emit `error`, return input) on failure.

- [ ] **Step 1: Add the trace event**

In `packages/shared/src/contracts.ts`, add one line to the `TraceEvent` union (e.g. after the `research_read` variant):

```typescript
  | { type: 'rerank'; specialist: string; before: string[]; after: string[] }
```

- [ ] **Step 2: Write the failing test for `rerankResearchHits`**

Create `packages/core/src/rerankStep.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { rerankResearchHits } from './rerankStep.js';

function hit(id: string): Evidence {
  return { id, kind: 'publication', source: 's', title: id, snippet: '', passage: '', url: 'u', raw: {}, retrievedAt: 'now' };
}
const hits = [hit('PMID:1'), hit('PMID:2'), hit('PMID:3')];

describe('rerankResearchHits', () => {
  it('reranks and emits a rerank event with before/after ids', async () => {
    const events: TraceEvent[] = [];
    const reversed = [...hits].reverse();
    const out = await rerankResearchHits({
      specialist: 's', question: 'q', hits, emit: (e) => events.push(e),
      rerank: async () => reversed,
    });
    expect(out.map((h) => h.id)).toEqual(['PMID:3', 'PMID:2', 'PMID:1']);
    const ev = events.find((e) => e.type === 'rerank') as Extract<TraceEvent, { type: 'rerank' }>;
    expect(ev.before).toEqual(['PMID:1', 'PMID:2', 'PMID:3']);
    expect(ev.after).toEqual(['PMID:3', 'PMID:2', 'PMID:1']);
  });

  it('degrades to the input hits and emits an error when rerank throws', async () => {
    const events: TraceEvent[] = [];
    const out = await rerankResearchHits({
      specialist: 's', question: 'q', hits, emit: (e) => events.push(e),
      rerank: async () => { throw new Error('rerank HTTP 500'); },
    });
    expect(out).toEqual(hits);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'rerank')).toBe(false);
  });

  it('returns hits unchanged without calling rerank when fewer than 2', async () => {
    let called = false;
    const out = await rerankResearchHits({
      specialist: 's', question: 'q', hits: [hit('PMID:1')], emit: () => {},
      rerank: async () => { called = true; return []; },
    });
    expect(out.map((h) => h.id)).toEqual(['PMID:1']);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/rerankStep.test.ts`
Expected: FAIL (`rerankStep.js` does not exist).

- [ ] **Step 4: Write `rerankStep.ts`**

Create `packages/core/src/rerankStep.ts`:

```typescript
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { rerankHits } from '@mrsirquanzo/sonny-mcp-gateway';

export async function rerankResearchHits(opts: {
  specialist: string;
  question: string;
  hits: Evidence[];
  emit: (e: TraceEvent) => void;
  rerank?: (o: { question: string; hits: Evidence[] }) => Promise<Evidence[]>;
}): Promise<Evidence[]> {
  const { specialist, question, hits, emit } = opts;
  if (hits.length < 2) return hits;
  const rerank = opts.rerank ?? ((o) => rerankHits(o));
  try {
    const ranked = await rerank({ question, hits });
    emit({ type: 'rerank', specialist, before: hits.map((h) => h.id), after: ranked.map((h) => h.id) });
    return ranked;
  } catch (err) {
    // Reranking is additive; degrade to the citation-ordered hits.
    emit({ type: 'error', message: `rerank failed: ${String(err)}` });
    return hits;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/rerankStep.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire into `researcher.ts`**

In `packages/core/src/researcher.ts`, add the import near the other core imports (around line 47-48):

```typescript
import { rerankResearchHits } from './rerankStep.js';
```

Then replace the search+gate block (currently lines 100-103):

```typescript
    const query = buildSearchQuery(target, item.concept);
    emit({ type: 'tool_call', tool: search.name, args: { query } });
    const hits = relevanceGate(await safeToolCall({ tool: search, args: { query }, emit }), terms);
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

with:

```typescript
    const query = buildSearchQuery(target, item.concept);
    // Rerank only when enabled AND a key is configured; otherwise pure citation order.
    const rerankOn = process.env.SONNY_RERANK !== 'off' && !!process.env.SONNY_RERANK_API_KEY;
    emit({ type: 'tool_call', tool: search.name, args: { query } });
    const raw = await safeToolCall({ tool: search, args: { query, pageSize: rerankOn ? 25 : 8 }, emit });
    const gated = relevanceGate(raw, terms);
    const ranked = rerankOn
      ? await rerankResearchHits({ specialist: brief.id, question: item.question, hits: gated, emit })
      : gated;
    const hits = ranked.slice(0, 8);
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

- [ ] **Step 7: Type-check and run the core suite**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec tsc --noEmit && pnpm --filter @mrsirquanzo/sonny-core exec vitest run`
Expected: no type errors; all core tests pass. Existing `researcher` tests run with no `SONNY_RERANK_API_KEY`, so `rerankOn` is false, `pageSize` is 8, and no rerank/degrade path runs - no regression.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/contracts.ts packages/core/src/rerankStep.ts packages/core/src/rerankStep.test.ts packages/core/src/researcher.ts
git commit -m "feat(core): fetch-wide + rerank retrieval, gated by SONNY_RERANK, degrades to citation order"
```

---

## Final verification (whole repo)

- [ ] **Run the exact CI gate**

Run: `pnpm -r build && pnpm -r test`
Expected: build clean, all packages green. Confirms the `pageSize` change, the new `rerankHits`, the trace-event addition, and the researcher wiring integrate without breaking `apps/*`, `@sonny/eval`, or the patent code.

- [ ] **Deferred (needs keys, not a code gate):** a live eval A/B - `SONNY_RERANK=off` vs `on` (with `SONNY_RERANK_API_KEY` + `ANTHROPIC_API_KEY`) - should show `retrieval_recall` and/or `faithfulness` improve. Rides the same live run as the Slice 1 baseline.

---

## Self-Review

**Spec coverage:**
- `europepmc_search` optional `pageSize` (default 8) - Task 1.
- Provider-agnostic `rerankHits` (configurable endpoint/model/key, lenient `results|data` parse, `< 2` no-op, throw on missing key / non-OK, drop out-of-range indices, append unranked) - Task 2.
- `rerank` trace event - Task 3 Step 1.
- `rerankResearchHits` degrade-with-trace helper - Task 3 Steps 2-5.
- Fetch-wide (25) → gate → rerank → slice(8), gated by `SONNY_RERANK` + key - Task 3 Step 6.
- Measurement via existing metrics + ablation; no new metric - covered by design, nothing to build.

**Placeholder scan:** No "TBD"/"handle edge cases"; every code step shows exact code.

**Type consistency:** `rerankHits`/`RerankOpts` names match across Tasks 2 and 3. `rerankResearchHits`'s injectable `rerank` signature `{ question, hits } => Promise<Evidence[]>` matches how Task 3 Step 4 calls `rerankHits(o)` (whose `RerankOpts` accepts `question`/`hits`). The `rerank` trace event `{ specialist, before, after }` matches the union (Step 1), the emit (Step 4), and the test (Step 2).

**Refinement noted vs spec:** the spec described `rerankResearchHits` catching an unset key; the plan instead gates `rerankOn` on the key being present in `researcher.ts`, so with no key reranking is a silent no-op (no error-event spam on every search in the common no-key case) rather than an attempt-then-degrade. Functionally equivalent to the spec's intent (no key → citation order), cleaner, and it keeps existing researcher tests green without env changes.
