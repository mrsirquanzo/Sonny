# Slice 2: Abstention Verdict - Design

**Status:** Approved, ready for implementation plan.
**Slice:** 2 of the eval-first roadmap (1 eval harness, 2 abstention, 3 reranker, 4 multimodal figures, 5 grading + contradiction, 6 dense index).
**Stacks on:** Slice 1 (branch `eval-harness-slice-1` / PR #21) - only for *measurement* (turning the `ZXQR7` trap green). The code change itself is independent of the eval package.
**Date:** 2026-07-02.

## Purpose

Sonny always emits a verdict (`go` / `watch` / `no-go`).
A fictional or evidence-poor target still gets a manufactured `watch`, which quietly violates the grounded ethos.
This slice adds an explicit abstention verdict, `insufficient-evidence`, emitted by a deterministic gate when the dossier has fewer than two groundable findings.
It is the "no token, no ship" philosophy applied to the verdict itself: too little to weigh, no synthesized recommendation.

## The trigger: fewer than two supported findings (deterministic)

`Section.claims` holds exactly the claims that verified as `supported` (`produceResearchSection` ships only the `supported` subset; a failed or empty specialist contributes an empty array).
So the count of supported findings across the whole dossier is `sections.reduce((n, s) => n + s.claims.length, 0)`.

**Abstain iff that count is fewer than 2:**

```ts
const supportedCount = sections.reduce((n, s) => n + s.claims.length, 0);
if (supportedCount < 2) { /* return the deterministic abstention below */ }
```

This single check unifies the two cases we care about (`computeRag` returns `red` exactly when a section has no supported claim, so a supported count relates directly to the RAG signal):

- **Zero supported claims** - every section is `red`. This is the fictional or evidence-poor target such as `ZXQR7`. All-red is exactly the zero-count case.
- **Exactly one supported claim** - a single, uncorroborated finding. The recommendation's output is a two-sided bull-and-bear, and you cannot honestly write both sides from one finding, so there is nothing to weigh and abstention is the correct verdict rather than a synthesized `watch`.

Why `2` and not a tuned constant: it is **structural, not calibrated**.
The output is a bull case AND a bear case, which needs at least two grounded findings to weigh against each other.
The threshold is dictated by the arity of a two-sided recommendation, not by fitting the golden set.

- Deterministic, reuses the shipped supported-claim count, no model call.
- Conservative: any target with two or more corroborated findings keeps the normal path.
- An empty `sections` list and an all-`red` list both yield count 0, so both abstain, which is the correct behavior (nothing to assess).

Rejected alternative: a *tunable* coverage floor (abstain when supported `< K` for a fitted `K` like 3 or 5).
That `K` would need calibration against a larger golden set than we have.
The floor of 2 is not that: it is the minimum arity of a two-sided recommendation, so it needs no tuning.

## Placement: short-circuit before the writer

In `synthesizeRecommendation`, compute the supported-claim count from `sections` first.
If it is fewer than 2, return a deterministic abstention `Recommendation` and do NOT call the writer model.

Rationale: do not manufacture a bull/bear narrative for a target we cannot weigh, and do not spend a paid model call to do it.
The existing `severe developability -> no-go` override stays exactly as-is on the normal (non-abstention) path.

Ordering note: the abstention gate runs before the severe-developability override.
In the rare edge where the only findings are a single supported claim alongside a severe developability liability, the dossier abstains rather than returning `no-go`.
A lone, uncorroborated signal is treated as insufficient to assess, consistent with the two-findings floor.
This is a deliberate, documented choice for this slice, not an oversight.

## The abstention Recommendation (deterministic, no model)

```ts
const recommendation: Recommendation = {
  verdict: 'insufficient-evidence',
  thesis: `Insufficient verified evidence to assess ${target}.`,
  bull: [],
  bear: [],
  conditions: [],
};
const executiveRead =
  `No section produced a verified finding for ${target}; the dossier abstains rather than synthesize an unsupported recommendation.`;
```

No LLM call, no citations (there is nothing to cite).
This is the whole of the abstention output.

## Signature change: thread `target` into `synthesizeRecommendation`

`synthesizeRecommendation` today takes `{ sections, weighing, evidence, model }` and does not know the target symbol, which the abstention message needs.
Add a required `target: string` to its options object.

Call sites to update (verified as the only two that pass arguments; `packages/core/src/index.ts` merely re-exports):

- `packages/core/src/briefing.ts:25` - `result.target` is in scope.
- `eval/src/engine.ts:36` - the eval driver already has `target` in scope.

## The contract change

Add `'insufficient-evidence'` to `VerdictLabelSchema` in `packages/shared/src/contracts.ts`:

```ts
export const VerdictLabelSchema = z.enum(['go', 'watch', 'no-go', 'insufficient-evidence']);
```

`RecommendationSchema.verdict` references `VerdictLabelSchema`, so it extends automatically.

Consumer audit (performed against the branch):

- `TraceEvent`'s `recommendation` variant is `{ type: 'recommendation'; verdict: string }` - a plain string, so the new member is safe.
- `apps/cli/src/run.ts` prints the verdict as a string; `apps/cli/src/deep.ts` calls `verdict.toUpperCase()` - both string operations, safe.
- There are no exhaustive `switch`/`case` statements on the verdict union anywhere in `packages` or `apps`, so adding a member breaks no exhaustiveness check.
- Slice 1's `goldenSet.ts` and `metrics.ts` already include `'insufficient-evidence'` in their local `VerdictLabel` enum, so `verdict_in_band` passes the `ZXQR7` trap the moment `synthesize` emits it.

## Data flow

```
runDeepResearch -> sections (each carrying claims [the supported subset] and a rag)
  -> synthesizeRecommendation({ target, sections, weighing, evidence, model }):
       supported = sections.reduce((n, s) => n + s.claims.length, 0)
       if supported < 2:
           return deterministic abstention  (NO model call)
       else:
           draft via writer model
           apply severe-developability -> no-go override
           return
briefing.ts emits { type: 'recommendation', verdict } (now possibly 'insufficient-evidence')
  and assembles the Briefing.
```

## Error handling

The abstention path constructs a plain object and cannot throw (no model call, no I/O).
The normal path is unchanged, including its existing writer-model error propagation.

## Testing (TDD)

Unit tests for `synthesizeRecommendation`, injecting a fake `StructuredModel` whose `generateStructured` is a spy:

- **Zero supported claims (all sections red)** -> returns `verdict: 'insufficient-evidence'`, empty `bull`/`bear`/`conditions`, a `thesis` that names the target, and the fake model's `generateStructured` is **never called** (proves the short-circuit).
- **Exactly one supported claim** -> abstains, model **never called** (this is the single-finding gap the `< 2` floor closes).
- **Two or more supported claims** -> the model IS called and the returned verdict is the model's draft (or `no-go` when a severe developability risk is present); abstention is not triggered.
- **Empty sections array** -> abstains (count 0), model not called.
- **Contract** -> `VerdictLabelSchema.parse('insufficient-evidence')` succeeds and `RecommendationSchema` accepts an abstention object.

Deferred measurement (needs `ANTHROPIC_API_KEY`, not a code gate): a full deep run on `ZXQR7` yields `verdict: 'insufficient-evidence'`, flipping the Slice 1 trap's `verdict_in_band` from known-red to green.
The deterministic unit tests are the real gate; the live run is confirmation and can run with the same key as the Slice 1 baseline (Task 8).

## Out of scope

- A *tunable* coverage floor above the structural `< 2` (e.g. a fitted `K` of 3 or 5) - revisit post-eval only if needed.
- Richer partial-coverage abstention (e.g. weighing which sections are red when two or more supported claims exist) - deliberately out of scope; the `< 2` floor is the whole gate for this slice.
- Any UI or dashboard treatment of the new verdict; the string flows through the existing rendering unchanged.
- The live `ZXQR7` measurement run (needs the key; the unit tests gate the code).
