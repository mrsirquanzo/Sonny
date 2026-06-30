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

New pure helper in core. The target is pinned to Europe PMC's `TITLE_ABS:` field (see the field-pinning finding below); the concept stays free text:

```ts
export function buildSearchQuery(target: string, concept: string): string {
  const c = concept.trim();
  const pinned = `TITLE_ABS:${target}`;                       // target must be a subject of the paper
  if (!c) return pinned;                                       // no concept -> target alone
  return /\s/.test(c) ? `${pinned} AND "${c}"` : `${pinned} AND ${c}`; // phrase-quote multi-word concept
}
```

- `runResearcher` sends `buildSearchQuery(target, item.concept)` instead of the raw `searchQuery`.
- `fillGap` sends `buildSearchQuery(target, gap.concept)`; `fillGap` gains a `target: string` option, passed by `runDeepResearch`.

### 3. Pin the target to the title/abstract field (field-pinning finding)

The first local smoke after the two-term change showed recall still near zero, and the direct Europe PMC probe explained why.
Europe PMC matches `query=` across full text, and the tool sorts by `CITED desc`.
So `CDCP1 AND signaling` returns 1223 hits, but the top 8 are famous reviews (m6A, MALAT1, fatty-acid metabolism) that merely cite a CDCP1 paper - none has CDCP1 in its title or abstract.
The relevance gate (which sees only title + abstract + snippet) correctly drops all 8, leaving 0 records.

Pinning the target to the `TITLE_ABS:` field aligns the API with the gate: `TITLE_ABS:CDCP1 AND signaling` returns 199 hits whose top 8 are all genuinely about CDCP1 ("CDCP1 drives triple-negative breast cancer metastasis", "CUB domain-containing protein 1 is a novel regulator of anoikis resistance").
The concept stays free text so it can still match in the body; only the target must be a subject of the paper.
This is the structural completion of the broad-query fix: two terms alone are necessary but not sufficient; the target must be field-pinned for recall to be real.

### 4. Gate unchanged

The relevance gate stays exactly as-is. With the target field-pinned, returned hits already mention the target, so the gate becomes a near-redundant backstop (it still catches alias-only or edge cases). Broad recall, gate keeps precision.

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
