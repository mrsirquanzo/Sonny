# Slice 5: Evidence Grading + Contradiction Detector - Design

**Status:** Approved, ready for implementation plan.
**Slice:** 5 of the eval-first roadmap (1 eval harness, 2 abstention, 3 reranker, 4 multimodal figures, 5 grading + contradiction, 6 dense index).
**Branch:** `hardening/slice-5-grading-contradiction` off `main` (Slices 1-4 merged).
**Date:** 2026-07-03.

## Purpose

Sonny already audits each deep-read paper (the skeptic audit produces a `MethodologicalCritique`: study design, sample size, red flags), but it does not yet grade how much to *trust* that evidence, nor does it catch when two verified findings contradict each other.
This slice deepens the judgment layer with two cohesive, cheap additions whose inputs already exist:

- **(a) Evidence grading:** a deterministic GRADE tier on every critique, surfaced so cross-thread weighing counts higher-tier evidence more.
- **(b) Contradiction detector:** a decorrelated model that flags verified claims contradicting on the same endpoint, surfaced in the weighing takeaway and the bear case.

## (a) Evidence grading

### Contract

Extend `MethodologicalCritiqueSchema` (`@mrsirquanzo/sonny-shared`) with an optional field:

```ts
export const EvidenceLevelSchema = z.enum(['high', 'moderate', 'low', 'very_low']);
// added to MethodologicalCritiqueSchema:
evidenceLevel: EvidenceLevelSchema.optional(),
```

Optional so existing critiques and tests remain valid; every new critique carries it by construction (below).

### The deterministic grade function

`gradeEvidence(critique: { studyDesign, sampleSize, redFlags }): EvidenceLevel` in `packages/core/src/critique/grade.ts`.
No model call - the tier is a fact derived from the audit, honoring "no token, no ship".

GRADE levels are ordered `high(3) > moderate(2) > low(1) > very_low(0)`.

1. **Base tier by study design:**
   - `randomized_controlled` -> `high`
   - `single_arm` -> `moderate`
   - `observational` -> `low`
   - `post_hoc` -> `low`
   - `preclinical_nhp` -> `very_low`
   - `in_vitro` -> `very_low`
2. **Downgrade one level (each), floored at `very_low`:**
   - any red flag with `biasRisk === 'high'` -> -1
   - two or more red flags with `biasRisk === 'moderate'` -> -1
   - `sampleSize` known (non-null) and `< 50` -> -1 (imprecision)

This consumes the whole audit - design, flags, and sample - which is why GRADE was chosen over Oxford levels (which grade study *type* only and would ignore the flags we already compute).
The `< 50` sample threshold is a defensible clinical-imprecision cutoff; it is deliberately a single fixed value, not a tunable knob.

### Wiring the grade

- `runSkepticAudit` (`critique/skepticAudit.ts`) calls `gradeEvidence(audit)` and includes `evidenceLevel` in the returned `MethodologicalCritique`. The grade travels with the critique everywhere it already flows (onto `Section.critiques`).
- **Weighting in `weighing.ts`:** build a `Map<evidenceId, EvidenceLevel>` from all `sections[].critiques`. When rendering each claim line in the digest, annotate it with the **strongest (max) tier** among the claim's cited evidence that has a critique, e.g. `- <text> [PMID:1] (GRADE: high)`. A claim whose cited papers were not deep-read (no critique) is annotated `(GRADE: ungraded)`. The system prompt gains one instruction: weigh higher-GRADE evidence more heavily when reconciling tensions.
  Deterministic tier, model-applied weight - no numeric weight constants, mirroring how skeptic-audit caveats already flow into `synthesize.ts`.

## (b) Contradiction detector

### Contract

```ts
export const ContradictionFlagSchema = z.object({
  evidenceIdA: z.string().min(1),
  evidenceIdB: z.string().min(1),
  endpoint: z.string().min(1),
  explanation: z.string().min(1),
});
export type ContradictionFlag = z.infer<typeof ContradictionFlagSchema>;
```

### The detector

`detectContradictions(opts: { claims: Claim[]; store: EvidenceStore; model: StructuredModel; emit }): Promise<ContradictionFlag[]>` in `packages/core/src/critique/consistency.ts`.

- Runs **once** after all threads complete, on the **decorrelated verifier** model (`MODEL_ROUTER.verifier`) - the same decorrelation discipline as the skeptic audit; the writer must not adjudicate its own consistency.
- Input is the flattened verified section claims (text + citations). The model is asked to identify pairs of claims that make **opposing assertions about the same endpoint** and return a `ContradictionFlag` for each, citing the two evidence ids the claims rest on.
- **Grounding:** every returned `evidenceIdA`/`evidenceIdB` is validated against the store; a flag naming an id not in the store is dropped (never fabricated). A flag whose two ids are identical is dropped (not a contradiction between sources).
- Emits a `contradiction` trace event per surviving flag for the glass-box.
- Degrades to `[]` on any model error (additive, never load-bearing), emitting an `error` event.

### Surfacing

- `DeepResearchResult` gains `contradictions: ContradictionFlag[]`. `runDeepResearch` calls `detectContradictions` over the final section claims after weighing and includes the result.
- `synthesizeRecommendation` (`synthesize.ts`) gains `contradictions` in its options and renders them into the digest (a `## Contradictions` block, same mechanism as the existing `devLines` developability block), with a system-prompt instruction to weigh any contradiction in the **bear case**.
- The weighing takeaway already reconciles tensions; contradictions are additionally named there by passing them into `weighAcrossThreads` for the takeaway prompt (optional, low-cost), OR left to synthesis only. **Decision:** surface in synthesis (bear case) and the trace event this slice; do not thread into `weighAcrossThreads` (keeps the weighing signature stable and avoids ordering churn). The roadmap's "surfaced in weighing and the bear case" is honored by the bear case plus the glass-box; a weighing-prompt mention is a trivial follow-up if wanted.

### Trace event

Add to the `TraceEvent` union:

```ts
| { type: 'contradiction'; flag: ContradictionFlag }
```

## Data flow

```
per deep-read paper:
  runSkepticAudit -> audit -> gradeEvidence(audit) -> MethodologicalCritique{ evidenceLevel } -> Section.critiques

runDeepResearch (after sections + gap-fill + developability + kol + weighing):
  detectContradictions(flatten(finalSections.claims), store, verifierModel) -> ContradictionFlag[]  (grounded, degrade [])
  -> DeepResearchResult.contradictions

produceBriefing / synthesizeRecommendation:
  digest includes graded claim tiers (via weighing) AND a Contradictions block
  -> writer weighs high-GRADE evidence more and names contradictions in the bear case
```

## Error handling

- `gradeEvidence` is total and pure; it always returns a level (never throws).
- `detectContradictions` never throws: a model failure emits an `error` event and returns `[]`; unknown/duplicate ids are dropped.
- The normal synthesis/weighing paths are unchanged when there are no contradictions and no critiques (empty annotations, empty block).

## Testing (TDD, no network)

- `gradeEvidence` (pure): a table test - each `studyDesign` maps to its base tier; a `high`-biasRisk flag downgrades one; two `moderate` flags downgrade one; `sampleSize` 40 downgrades, 60 does not, null does not; downgrades stack and floor at `very_low`.
- `runSkepticAudit` (stubbed model): the returned critique carries the `evidenceLevel` that `gradeEvidence` computes for the stubbed audit.
- `weighing.ts` (stubbed model, capture prompt): a claim citing a graded paper renders `(GRADE: <tier>)` with the max tier across its citations; an ungraded citation renders `(GRADE: ungraded)`; the system prompt contains the weigh-higher-GRADE instruction.
- `detectContradictions` (stubbed model): canned flags map to `ContradictionFlag[]`; a flag with an id not in the store is dropped; a same-id flag is dropped; a thrown model call yields `[]` and an `error` event; each surviving flag emits a `contradiction` event.
- `synthesize.ts` (stubbed model, capture prompt): passed contradictions render into the digest under `## Contradictions` and the system prompt instructs weighing them in the bear case; with none, no block appears and behavior is unchanged.

## Out of scope

- A new eval metric for grading or contradictions (existing metrics + the glass-box cover this slice; a "contradiction catch" metric is a later add).
- Any change to the verdict logic itself (grading informs weighing/synthesis prose; it does not gate the verdict).
- Threading contradictions into the `weighAcrossThreads` signature (bear case + trace event suffice; a weighing-prompt mention is a trivial follow-up).
- The self-hosted / dense-index retrieval work (Slice 6).
