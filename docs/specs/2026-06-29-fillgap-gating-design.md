# fillGap Deep-Read Gating Design

**Status:** Approved, ready for implementation plan.
**Slice:** 9 (precision consistency).
**Date:** 2026-06-29.

## Problem

Slice 7 (passage relevance) added a title-gated deep-read selection and passage gating to `runResearcher`, but missed the parallel deep-read path in `fillGap` (`packages/core/src/completeness.ts`).
The recall smoke confirmed it: the gap-filler deep-read the MIS-C/COVID paper (PMC7489877, 26 off-topic sections) into the store, because `fillGap` still selects its deep-read target with the pre-slice-7 ungated logic.
The verifier kept those sections out of the final dossier, but the path wastes deep-reads and relies on the verifier as the only backstop.

## Design

Mirror the slice-7 gating exactly into `fillGap`. The target-term set `terms = targetTerms(store)` is already computed at the top of `fillGap`; both helpers already exist.

1. **Import** `titleMentionsTarget` alongside the existing `targetTerms`, `relevanceGate` from `./relevance.js`.
2. **Title-gate the selection:** require the hit's title to name the target.
   ```ts
   const top = hits.find((h) =>
     titleMentionsTarget(h, terms) &&
     (h.raw as { pmcid?: string })?.pmcid &&
     (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
   ```
   When no hit qualifies, `top` is undefined and the existing `if (top)` guard skips the full-text call.
3. **Passage-gate the sections:** wrap the full-text result in `relevanceGate(..., terms)` before registering.
   ```ts
   const passages = relevanceGate(await safeToolCall({ tool: fulltext, args: { pmcid }, emit }), terms);
   ```
   The emitted `tool_result` count reflects the gated count.

No other behavior changes. `extractClaims` still reads `store.all()`, which now never receives off-topic gap-fill passages.

## Out of scope

- Reference snowball (separate slice).
- Confidence clamp (separate slice).

## Testing

- `completeness.test.ts`: add two cases mirroring the slice-7 researcher tests:
  (a) a gap whose top search hit passes the search gate via its passage but whose title lacks the target is NOT deep-read (no `pmc_fulltext` call);
  (b) when the deep-read fires on a title-matching hit, off-topic full-text sections are dropped before registration.
- Full core suite green.

## Success criteria

A re-run smoke shows the gap-filler never deep-reads a paper whose title does not name the target (no MIS-C full-text fetch from the gap-fill path).
