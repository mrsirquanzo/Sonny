# Slice 3: Reranker Retrieval Upgrade - Design

**Status:** Approved, ready for implementation plan.
**Slice:** 3 of the eval-first roadmap (1 eval harness, 2 abstention, 3 reranker, 4 multimodal figures, 5 grading + contradiction, 6 dense index).
**Branch:** `hardening/slice-3-reranker` off `main` (Slices 1 and 2 are merged).
**Date:** 2026-07-03.

## Purpose

Sonny's retrieval ranks Europe PMC hits by citation count, then deep-reads the first title-matching open-access paper.
Citation count is a popularity prior, not a relevance signal for the specialist's actual research question, so a paper that is highly relevant but less cited never gets read and never seeds the citation snowball.
This slice adds a cross-encoder reranker that reorders candidates by question-relevance before the deep-read pick, and widens the candidate pool so genuinely relevant-but-less-cited papers can surface into the store.

## Hosting decision: a hosted rerank API, zero infra, provider-agnostic

The reranker is a hosted cross-encoder API called over HTTPS from TypeScript, exactly like `blastVerify` calls NCBI.
No Python sidecar, no GPU, no service to run.
This is the cheapest way to answer the roadmap's actual question - does reranking beat citation-count ordering - and it is measurable immediately, unlike a self-hosted model behind deferred infra.

The design is **provider-agnostic**: the endpoint, model, and API key are env-configurable, and the response parser is lenient enough to accept the de-facto standard rerank shape shared by Cohere, Jina, and Voyage (`{ results | data: [{ index, relevance_score }] }`).
No provider name appears in the code path; swapping providers is a config change, and swapping to a self-hosted biomedical cross-encoder (MedCPT) later is contained to the one `rerankHits` function.

## Value decision: fetch-wide-then-rerank

Reranking only the existing 8 citation-sorted hits would reorder the deep-read pick (a precision lift) but leave the candidate set unchanged, so `retrieval_recall` over the store would barely move.
Instead:

- `europepmc_search` fetches a wider page (25) when reranking is on.
- The lexical `relevanceGate` still runs first as a grounding safety net (the target must be mentioned).
- `rerankHits` reorders the survivors by the specialist's research question.
- The top 8 are kept for the store and the deep-read.

Store size stays 8, so the lift is purely in *which* 8: a relevant paper at citation-rank 18 that survives the lexical gate and scores high on the question now enters the store and seeds a better snowball.
This is the version that makes the recall/precision numbers move and loosens the snowball-diversity limitation.

## Components

### `rerankHits` (`packages/mcp-gateway/src/rerank.ts`, new)

A standalone function, not a `Tool` (it transforms an existing hit list, it does not fetch from a source - the same shape as `readFigures` in the Slice 4 design):

```ts
interface RerankOpts {
  question: string;
  hits: Evidence[];
  topN?: number;              // documents to score; default hits.length
  endpoint?: string;          // default process.env.SONNY_RERANK_ENDPOINT ?? 'https://api.cohere.com/v2/rerank'
  model?: string;             // default process.env.SONNY_RERANK_MODEL ?? 'rerank-v3.5'
  apiKey?: string;            // default process.env.SONNY_RERANK_API_KEY
  fetchImpl?: typeof fetch;
}
rerankHits(opts: RerankOpts): Promise<Evidence[]>
```

Behavior:

- If `hits.length < 2`, return `hits` unchanged and make NO network call (nothing to reorder).
- Build one document string per hit: `` `${hit.title}\n${hit.passage ?? hit.snippet}` ``.
- POST to the configured endpoint with `Authorization: Bearer <apiKey>` and body `{ model, query: question, documents, top_n }`. The default endpoint value is a working reference (a Cohere-compatible v2 rerank URL), but nothing in the code is provider-specific beyond that default string.
- Throw on non-OK HTTP (`rerank HTTP <status>`), so the caller can isolate it.
- Parse leniently: read `body.results ?? body.data` as the ranked array, each item `{ index: number, relevance_score: number }` (the shape Cohere, Jina, and Voyage all return). Map each item back to the input `hits` by `index`, in descending `relevance_score` order. Indices are validated against the input length; any out-of-range or duplicate index is dropped (grounding: the reorder is derived from our own input, never fabricated). Any input hit not named by the response is appended after the ranked ones in original order, so no candidate is silently lost.

The reranked reading never mutates a hit; it only reorders the array.

### `europepmc_search` page size (`packages/mcp-gateway/src/europePmc.ts`, modify)

Add an optional `pageSize` arg (default 8, so existing callers are unaffected):

```ts
const pageSize = Math.min(Math.max(Number(args.pageSize ?? 8), 1), 100);
```

used in the request URL in place of the hardcoded `pageSize=8`.

### Retrieval wiring (`packages/core/src/researcher.ts`, modify)

Replace the single search+gate line with fetch-wide → gate → rerank → slice:

```ts
const RERANK_ON = process.env.SONNY_RERANK !== 'off';
const raw = await safeToolCall({ tool: search, args: { query, pageSize: RERANK_ON ? 25 : 8 }, emit });
const gated = relevanceGate(raw, terms);
const ranked = RERANK_ON ? await rerankResearchHits(item.question, gated, emit) : gated;
const hits = ranked.slice(0, 8);
```

`rerankResearchHits(question, hits, emit)` is a thin `core` helper (in a new `packages/core/src/rerankStep.ts`) that calls `rerankHits`, emits a `rerank` trace event on success, and on any failure emits an `error` event and returns the input hits unchanged (degrade to citation order). This mirrors the `researchFigures` degrade pattern from Slice 4.

### Trace event (`packages/shared/src/contracts.ts`, modify)

Add to the `TraceEvent` union:

```ts
| { type: 'rerank'; specialist: string; before: string[]; after: string[] }
```

where `before`/`after` are the hit ids in order, so the reorder is auditable in the glass-box.

## Gating and degradation

- `SONNY_RERANK` (default on; `=off` disables reranking and reverts to `pageSize=8` citation order). This is the eval ablation switch, the same pattern as `SONNY_FIGURES`.
- If `SONNY_RERANK_API_KEY` is unset or the API errors, `rerankResearchHits` catches it, emits an error trace event, and returns the citation-ordered hits. Reranking is additive, never load-bearing for a run to complete.

## Measurement (no new metric)

Slice 1's harness already measures this:

- `retrieval_recall` (fraction of gold seminal PMIDs in the store) moves when fetch-wide-then-rerank surfaces a relevant-but-less-cited gold paper into the top 8.
- `faithfulness` and the verdict metrics capture the downstream effect of a better deep-read seed.
- `SONNY_RERANK=off` vs `on` is the A/B, exactly like the figures ablation.

The live proof needs a live eval run (`ANTHROPIC_API_KEY`) plus `SONNY_RERANK_API_KEY`; it rides the same deferred run as the Slice 1 baseline. The `rerankHits` code and its wiring are fully buildable and unit-testable now against a stubbed `fetch`.

## Testing (TDD, no network)

- `rerankHits` reorders hits by a stubbed Cohere response and maps `index` back to the correct hit; a higher `relevance_score` ranks first.
- `rerankHits` throws on non-OK HTTP so the caller can isolate it.
- `rerankHits` returns the input unchanged and makes no `fetch` call when `hits.length < 2`.
- `rerankHits` drops an out-of-range `index` rather than fabricating a hit.
- `europepmc_search` honors `pageSize` (the request URL contains `pageSize=25`).
- `rerankResearchHits` emits a `rerank` event on success and, on a thrown rerank, emits an `error` event and returns the input hits unchanged (degrade path).

## Out of scope

- The self-hosted biomedical MedCPT reranker (a later swap behind the `rerankHits` seam).
- Any dense retrieval index or RRF fusion (Slice 6).
- Adaptive `pageSize`/`top_n` tuning; the 25-in, 8-out constants are fixed for this slice.
- A dedicated rerank eval metric; the existing recall/faithfulness metrics plus the ablation switch cover it.
