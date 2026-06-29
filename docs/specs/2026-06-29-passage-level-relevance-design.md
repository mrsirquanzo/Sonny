# Passage-Level Relevance Design

**Status:** Approved, ready for implementation plan.
**Slice:** 7 (follows Plan 6, retrieval relevance).
**Date:** 2026-06-29.

## Problem

Plan 6 added a target-mention relevance gate on search hits.
The local CDCP1 smoke proved it kills the gross off-topic noise (0 m6A/lncRNA sections, previously a whole dossier), but surfaced a second leak: full-text passages of a gate-passing hit are not gated.

Two concrete failures in the deep-read flow (`packages/core/src/researcher.ts:99-111`):

1. **Hit selection.**
   `hits.find((h) => pmcid && isOpenAccess !== false)` deep-reads the first PMC hit.
   A paper that merely name-drops the target in its abstract (enough to pass the Plan 6 gate) gets fully read.
   In the smoke, a MIS-C/COVID proteomic paper that mentions CDCP1 once was deep-read, then flooded the store with off-topic MIS-C claims.

2. **Passage registration.**
   Every full-text section returned by `pmc_fulltext` is registered into the store ungated.
   Even a genuinely on-target paper carries off-topic sections (methods, unrelated results) that then enter `store.all()`, which `extractClaims` reads wholesale.

Both are structural: the gate exists but is not applied at the full-text boundary, and paper selection has no relevance criterion beyond "has a PMC id".

## Goal

Stop off-topic full-text from entering the evidence store, reusing the existing target-term set.
No new tuning knobs; deterministic; precision-first.

## Design

### 1. Shared matching core (`packages/core/src/relevance.ts`)

Extract the gate's matching logic into one pure predicate so both callers stay consistent:

```ts
export function mentionsAny(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true; // no terms known -> no-op, matches gate semantics
  const hay = text.toLowerCase();
  return terms.some((t) => hay.includes(t));
}
```

`relevanceGate` is re-expressed in terms of it, with the haystack unchanged (`title + passage + snippet`):

```ts
export function relevanceGate(hits: Evidence[], terms: string[]): Evidence[] {
  if (terms.length === 0) return hits;
  return hits.filter((h) => mentionsAny(`${h.title} ${h.passage ?? ''} ${h.snippet}`, terms));
}
```

This is a behavior-preserving refactor: existing `relevance.test.ts` cases still pass.

New predicate for title-gated selection:

```ts
export function titleMentionsTarget(e: Evidence, terms: string[]): boolean {
  return mentionsAny(e.title, terms);
}
```

`mentionsAny('', terms)` with non-empty `terms` returns `false` (empty title never matches a real term), and with empty `terms` returns `true` (no-op), preserving the gate's empty-terms contract.

### 2. Strict title-gated deep-read selection (`researcher.ts`)

Replace the selection at line 100:

```ts
const top = hits.find((h) =>
  titleMentionsTarget(h, terms) &&
  (h.raw as { pmcid?: string })?.pmcid &&
  (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
```

If no hit qualifies, `top` is `undefined` and the existing `if (top)` guard skips the full-text call entirely.
The round still drafts claims from the gated abstract passages already registered in the store.

**Decision (precision-first, user-approved):** when no hit has the target in its title, read no full text that round.
Better to read nothing than to deep-read a tangential paper.

### 3. Passage gating (`researcher.ts`)

Gate the full-text result before registering:

```ts
const passages = relevanceGate(await safeToolCall({ tool: fulltext, args: { pmcid }, emit }), terms);
emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
```

Only target-mentioning sections register and emit `research_read`.
The `tool_result` count reflects the gated count - honest, no silent inflation.

## Data flow (unchanged otherwise)

- Structured seed evidence stays ungated (it is the target record and its curated facts).
- `extractClaims` still reads `store.all()`, but the store now only ever contains target-relevant passages.
- `targetTerms(store, target)` is already computed once at the top of `runResearcher` and reused.

## Out of scope (separate slices)

- **Thin recall / qwen looping.** The smoke showed gated searches sometimes return ~0 hits and qwen repeats claims/searches. That is a query-construction + ranking + model concern, not passage relevance. Separate slice.
- **OA-gate tightening** (`isOpenAccess !== false` -> `isOpenAccess === true`). Folding this in here would cut recall further while we are already going strict on titles. Deferred backlog item, left as-is.

## Testing

- `relevance.test.ts`: existing gate cases unchanged (refactor is behavior-preserving). Add unit cases for `mentionsAny` (empty terms -> true; non-empty terms, no match -> false; case-insensitive substring hit) and `titleMentionsTarget` (title-only match ignores passage/snippet; alias in title matches; empty terms -> true).
- `researcher.test.ts`: add cases proving (a) a hit whose title lacks the target is NOT deep-read even when it has a pmcid, while a title-matching hit IS; (b) off-topic full-text sections are dropped before registration so `store.all()` excludes them; (c) when no hit title-matches, no `pmc_fulltext` call is made and the round still drafts claims from abstracts.
- Full core suite must stay green; fixtures whose deep-read path depends on selection may need a target-mentioning title.

## Success criteria

On the CDCP1 smoke: no off-topic full-text passages (e.g. MIS-C/COVID sections) appear in the dossier, and a tangential paper that only name-drops the target is never deep-read.
