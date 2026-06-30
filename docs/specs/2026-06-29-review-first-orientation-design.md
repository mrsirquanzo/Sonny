# Review-First Orientation Design

**Status:** Approved, ready for implementation plan.
**Slice:** 10 (retrieve like a scientist, part 1: orient with a review).
**Date:** 2026-06-29.

## Problem

A scientist starting on a new target reads a review article first - to get the broad biology, disease, and indication landscape - before diving into specific primary papers.
Sonny skips this: it orients on structured data (Open Targets) then jumps straight into per-thread keyword searches.
No deliberate review read grounds the specialists' work.

## Design

Add a one-time review-orientation pass to `runDeepResearch`, after `seedStructuredEvidence` and before the specialists dispatch, so the review lands in the shared store and every specialist inherits the framing.

### 1. `buildReviewQuery(target)` (in `searchQuery.ts`)

```ts
export function buildReviewQuery(target: string): string {
  return `TITLE_ABS:${target} AND PUB_TYPE:"review"`;
}
```

The API probe confirmed `PUB_TYPE:"review"` returns actual reviews ("The CDCP1 Signaling Hub", "The cell surface glycoprotein CDCP1 in cancer"), whereas free-text `review` returns primary papers.

### 2. `orientWithReview({ target, tools, store, emit })` (new `orientation.ts`)

1. Search reviews with `buildReviewQuery(target)`; pass through `relevanceGate(..., terms)` where `terms = targetTerms(store, target)`.
2. Register the top **K = 2** review abstracts into the shared store - dense landscape summaries, valuable even without full text (the best target-specific reviews are often not open-access).
3. If a top review is open-access and its title names the target (`titleMentionsTarget` + `pmcid` + not closed), deep-read it (`pmc_fulltext`), passage-gate, register - for the full landscape.
4. `safeToolCall`-wrapped; emits `tool_call` / `tool_result` / `evidence_registered` / `research_read` (specialist id `'orientation'`). If tools are missing or no review is found, return without effect.

### 3. Wire-in (`runDeepResearch.ts`)

One `await orientWithReview({ target, tools: literatureTools, store, emit })` between `seedStructuredEvidence` and `lead_decompose`, wrapped in try/catch so an orientation failure degrades to a normal run.

## Out of scope

- Reference snowball / forward citations (next slice).
- Specialty-lab / modality-expert detection (later slice).
- Deep-reading more than one review; recursive orientation.
- Confidence clamp.

## Testing

- `searchQuery.test.ts`: `buildReviewQuery('CDCP1')` -> `'TITLE_ABS:CDCP1 AND PUB_TYPE:"review"'`.
- `orientation.test.ts`:
  (a) registers the top 2 review abstracts from a gated review search;
  (b) deep-reads an open-access review whose title names the target (sections registered, `research_read` emitted) and passage-gates off-topic sections;
  (c) does not deep-read when no review is open-access (no `pmc_fulltext` call);
  (d) returns without throwing when the literature tools are absent.
- Full core suite green (existing `runDeepResearch` tests unaffected: their mock search hits are gated out by the target-term gate, so orientation is a no-op for those fixtures).

## Success criteria

A re-run smoke shows an orientation review search (`TITLE_ABS:CDCP1 AND PUB_TYPE:"review"`) firing before the specialists, with review evidence registered into the store, and review-derived claims/references appearing in the dossier.
