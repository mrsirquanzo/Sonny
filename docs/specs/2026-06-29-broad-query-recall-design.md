# Broad-Query Recall Design

**Status:** Approved, ready for implementation plan.
**Slice:** 8 (recall, part 1 of 2 - broad queries now, reference snowball next).
**Date:** 2026-06-29.

## Problem

In the CDCP1 smoke, 24 of 25 Europe PMC searches returned 0 records.
Root cause is purely query construction: the planner emits a 3-8 keyword `searchQuery` (e.g. `CDCP1 genomic structure exon intron`), and `europepmc_search` passes it raw to Europe PMC's `query=` param, which ANDs every term across all fields.
Requiring a paper to contain all five tokens returns nothing.

This is not a planner-creativity problem and does not need an elaborate query builder.
Scientists search broad: `CDCP1 AND ADC`, `CDCP1 AND oncology` - the target plus one concept.

## Design

Every literature search becomes a two-term query: `<target> AND <concept>`, with the target always pinned and exactly one concept facet.

### 1. Model emits a concept, not a keyword string

- `ResearchQuestion.searchQuery: string` becomes `ResearchQuestion.concept: string` - a single short topic facet (1-2 words), target-free: `ADC`, `oncology`, `signaling`, `metastasis`.
- `ResearchGap.searchQuery` becomes `ResearchGap.concept` likewise.
- The planner prompt (`planResearchQuestions`), the reflect/follow-up prompt (`reflectOnGaps`), and the completeness prompt (`assessCompleteness`) are updated to ask for a short concept, NOT a keyword list and NOT the target symbol (the loop adds the target).

### 2. The loop assembles the query

New pure helper in core:

```ts
export function buildSearchQuery(target: string, concept: string): string {
  const c = concept.trim();
  if (!c) return target;                                  // no concept -> target alone
  return /\s/.test(c) ? `${target} AND "${c}"` : `${target} AND ${c}`; // phrase-quote multi-word
}
```

- `runResearcher` sends `buildSearchQuery(target, item.concept)` instead of the raw `searchQuery`.
- `fillGap` sends `buildSearchQuery(target, gap.concept)`; `fillGap` gains a `target: string` option, passed by `runDeepResearch`.

### 3. Gate unchanged

The relevance gate stays exactly as-is. A broad `CDCP1 AND oncology` query returns many hits; the gate drops any that do not mention the target. Broad recall, gate keeps precision.

## Out of scope (separate slices)

- **Reference snowball** - following a seed paper's references / related / cited-by to pull more papers. This is recall part 2, the next slice.
- **`fillGap` deep-read gating** - `fillGap` still selects its deep-read target with the pre-Plan-7 ungated logic (no title-gate, no passage-gate). A precision inconsistency to clean up in a quick follow-up; unrelated to recall.
- **Confidence clamp** - the `weighAcrossThreads` Zod `confidence > 1` crash. Its own tiny follow-up.

## Testing

- `buildSearchQuery` unit tests: single-word concept -> `T AND kw`; multi-word concept -> `T AND "two words"`; empty concept -> `T`.
- `researcher.test.ts`: planner returns a `concept`; assert the search tool receives `<target> AND <concept>`. Update fixtures that used `searchQuery` to use `concept`.
- `completeness.test.ts`: gap carries a `concept`; assert `fillGap` searches `<target> AND <concept>`. Update fixtures.
- Full core suite green.

## Success criteria

On the CDCP1 smoke, the majority of searches return hits (not 0), and the dossier sections carry real literature claims rather than "evidence does not contain..." placeholders.
