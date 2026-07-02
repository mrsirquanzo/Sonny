# Slice 1: Eval Harness + CI - Design

**Status:** Approved, ready for implementation plan.
**Slice:** 1 of the eval-first roadmap (1 eval harness, 2 abstention, 3 reranker, 4 multimodal figures, 5 grading + contradiction, 6 dense index).
**Blocks:** Slice 4 Tasks 0 and 6 depend on this landing.
**Date:** 2026-07-02.

## Purpose

Sonny has 164 tests on its plumbing and almost none on its product.
For an agent whose value is a trustworthy verdict, the unanswered question is "how often is the verdict right, and is it getting better or worse as I change things?"
This slice builds the golden-set eval harness and the CI ratchet that answer it: a fixed set of curated targets, eight output-quality metrics, a scorecard that diffs against a baseline, and a CI gate.

The design and the metric definitions are already locked (the review plus the drafts in `~/Downloads/files`).
This spec records the three decisions that landing them in the real repo requires, and the engine wiring the drafts left as a TODO.

## Ratchet, not corpus

Ship the ratchet at N=3, not N=25.
The golden set starts at three targets already curated: `CDCP1` (a `watch`-band real target, Hooper JD must-appear), and `ZXQR7` (a fictional trap that must abstain).
Grow the corpus behind an already-green gate; the gate is the lever, the corpus is fill-in.

## Decisions

### D1: Metrics stay engine-decoupled; the runner adapts

The drafts' `metrics.ts` uses a local `BriefingLike` structural mirror "so eval has no deep coupling to core internals beyond the public Briefing shape."
The real `@mrsirquanzo/sonny-shared` `Briefing` differs: the verdict lives at `recommendation.verdict`, and `bull`/`bear` are `CasePoint[]`, not `string[]`.
Rather than rewrite the metrics against the core types, land `metrics.ts` essentially verbatim and write one small adapter, `toRunArtifacts(briefing, evidence, events, elapsedMs)`, in the eval package.
The metric layer stays engine-agnostic; only the adapter and the engine driver know `@mrsirquanzo/sonny-core`.

### D2: Keep the `eval/` package in place

`eval/` is already the `@sonny/eval` workspace package (`pnpm-workspace.yaml` lists `eval`).
Do not move it to `packages/eval`.
Replace its superseded Slice-0 contents (`src/score.ts`, `src/index.ts`, `golden/egfr.json`) with the Slice 1 structure, and point the CI workflow `path` at `eval/`.
This is the surgical change; a package move would touch tsconfig references and the workspace glob for no benefit.

### D3: CI option A - cheap gate now, live eval nightly, replay deferred

Live per-PR eval is the gate that quietly dies: it costs money per PR and a flaky verdict fails an unrelated change, so someone disables it.
So:

- **Per PR and push:** `tsc --noEmit` plus `vitest` across the workspace. This also closes the tsc-masking gap (vitest strips types without checking them).
- **Nightly (cron):** the full live eval on the Anthropic backend, writing a scorecard artifact and diffing against the stored baseline.
- **On demand:** a `workflow_dispatch` entry to run the fast subset live when wanted (e.g. to prove Slice 4's figure lift).
- **Deferred:** recorded-response replay that would make a per-PR eval deterministic and free. It graduates to its own slice when the golden set is large enough to justify it.

The ratchet still exists (nightly baseline plus regression diff); it simply does not block individual PRs on a paid, nondeterministic call.

## Components

All live in the existing `eval/` package.

- `src/goldenSet.ts` - the Zod `GoldenTarget` schema (verdict bands, trap targets, `claimProbe`s, expected KOLs/PMIDs/developability), `EvalSubset`, `SubsetConfig`. Lands from the draft verbatim.
- `src/metrics.ts` - the eight metrics and `makeJudge`, split deterministic (grounding integrity, retrieval recall, KOL precision@k, developability catch, verdict-in-band, verdict stability, cost/latency) and decorrelated-judge (faithfulness, unsupported-sentence-ratio, claim probes). Lands from the draft verbatim. Defines `BriefingLike`, `RunArtifacts`, `StructuredModelLike`, `MetricResult`.
- `src/scorecard.ts` - `aggregate`, `toMarkdown`, `writeScorecard`, `checkRegression`, `REGRESSION_TOLERANCE`. Lands from the draft verbatim. (Slice 4 later adds `ABSOLUTE_FLOORS`; not in this slice.)
- `src/adapter.ts` (new) - `toRunArtifacts(briefing: Briefing, evidence: Evidence[], events: TraceEvent[], elapsedMs: number): RunArtifacts`. Maps `recommendation.verdict` to the flat `verdict`, `bull`/`bear` `CasePoint[]` to `string[]` (via `.point`), passes `sections` (already `{ id, claims, developabilityRisks }`-compatible) and `kolCluster` through, and builds `evidenceById` from the full evidence list. Cost and tokens are read from trace events when present, else left undefined.
- `src/engine.ts` (new) - `makeRunOnce(backend)`, the ONLY coupling to `@mrsirquanzo/sonny-core`. Returns `runOnce(target)` that assembles the literature and structured tools, the specialist/verifier/lead models for the backend, and the research budget; composes `runDeepResearch` then `synthesizeRecommendation` (mirroring `produceBriefing`, but keeping the full `result.evidence` the metrics need); times the run; and returns `toRunArtifacts(...)`.
- `src/runner.ts` - `loadGolden`, `scoreTarget` (runs each target N times for stability), `runEval`, and the CLI entry. Lands from the draft; its `EngineDeps` TODO is filled by `makeRunOnce` and the verifier-role judge model.
- `golden/CDCP1.json`, `golden/ZXQR7.trap.json`, `golden/_subset.json` - land from the drafts.
- `.github/workflows/ci.yml` - the option-A shape above.

## Engine wiring (the drafts' TODO)

`runOnce` composes the pipeline directly rather than calling `produceBriefing`, because `produceBriefing` returns only cited `references`, whereas the metrics need the full evidence store to resolve citations and score seminal-PMID recall.

```ts
const events: TraceEvent[] = [];
const emit = (e: TraceEvent) => events.push(e);
const t0 = Date.now();
const result = await runDeepResearch({
  target, roster: RESEARCH_ROSTER,
  literatureTools, structuredTools,
  specialistModel, verifierModel, leadModel, emit, budget,
});
const { recommendation, executiveRead } = await synthesizeRecommendation({
  sections: result.sections, weighing: result.weighing, evidence: result.evidence, model: leadModel,
});
const briefing: Briefing = {
  target, recommendation, executiveRead,
  sections: result.sections, weighing: result.weighing,
  references: assembleReferences(result), kolCluster: result.kolCluster,
};
return toRunArtifacts(briefing, result.evidence, events, Date.now() - t0);
```

The judge model passed to `makeJudge` is the verifier-role model (decorrelated from the specialist writer), following Sonny's own rule.

## The abstention gap (known-red until Slice 2)

`RecommendationSchema.verdict` is `go | watch | no-go`; the golden schema and metrics also allow `insufficient-evidence`.
Slice 1 does NOT add the abstention verdict (that is Slice 2).
So the `ZXQR7` trap, whose only allowed verdict is `insufficient-evidence`, will fail `verdict_in_band` until Slice 2 lands.
This is by design and documented: the trap failing loudly is the signal that abstention is missing.
The first stored baseline therefore carries the trap as a known-red line; Slice 2 turns it green.

## Error handling

The harness never throws on a single bad run.
`loadGolden` validates every golden file with the Zod schema and fails fast on a malformed file (a curation bug should stop the run, not silently skip).
A metric that cannot compute (no gold PMIDs, no expected KOLs) returns `pass: true` with an explanatory detail, per the drafts.
`checkRegression` treats a missing baseline as a first run (no regressions), and a `grounding_integrity` failure on any target as a hard failure independent of baseline.

## Testing

Vitest, no network, hand-built `RunArtifacts` and stubbed models.

- Each deterministic metric: a unit test over a constructed `RunArtifacts` (grounding offender detection, recall found/missed, KOL must-appear, developability severity threshold, verdict band, stability flip-rate, cost/latency passthrough).
- Judge metrics: a `StructuredModelLike` stub returning canned `JudgeVerdict`s; assert supported/unsupported/overreach accounting for faithfulness, unsupported-sentence-ratio, and claim probes.
- `scorecard.ts`: `aggregate` means, `checkRegression` (regression detected past tolerance, grounding hard-fail, first-run no-baseline).
- `goldenSet.ts`: schema `superRefine` (a trap without `insufficient-evidence` in `allowedVerdicts` is rejected; `allowedVerdicts` must include `label`).
- `adapter.ts`: `toRunArtifacts` maps a real-shaped `Briefing` (nested `recommendation`, `CasePoint[]` bull/bear) to the flat metrics shape, and builds `evidenceById` from the full evidence list.
- `runner.ts` `loadGolden`: validates golden files and applies the `fast` subset filter.
- `engine.ts` is the live coupling and is exercised by the on-demand/nightly live run, not a unit test; keep it thin.

## Setup

The live eval needs `ANTHROPIC_API_KEY` (nightly CI reads it from a repo secret).
Baseline capture: after Slice 1 merges, run the full eval once on the Anthropic backend and commit the resulting scorecard as `golden/_baseline.json`, with the `ZXQR7` trap recorded as a known-red until Slice 2.

## Out of scope

- The abstention verdict (Slice 2).
- Recorded-response replay / per-PR live eval (deferred; own slice).
- `ABSOLUTE_FLOORS` and the `figure_grounding` metric (Slice 4).
- Growing the golden set beyond the initial three targets (incremental, behind the green gate).
