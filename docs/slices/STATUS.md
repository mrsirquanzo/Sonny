# Modality-agnostic redesign: slice status

Last updated 2026-07-28.

Spec lives outside this repo at `~/Downloads/Sonny_modality_agnostic_spec_draft5.6.md`.
Its Appendix A is a 56-entry decision log recording every reversal and the reason.
**Read it before reopening a settled question.** Section 16 holds the per-slice
acceptance checklists.

## Where we are

| Slice | Scope | Status |
|---|---|---|
| 0 | Abstention counts verified claims only; post-merge `rag` and `sources` | MERGED `28c338a` (#12) |
| 1 | Shared contracts: axes, modality, target identity, scope, risk taxonomy, conclusions | MERGED `3b159a7` (#14) |
| 2 | Evidence layer: neutral card snippets, full tractability, `unknown` fallback, claim ids, target identity | MERGED `f69f2cc` (#16) |
| 3 | Deterministic rubric, modality lenses, single-strategy scope propagation | MERGED `5f89bd1` (#17) |
| 4 | MONDO disease-context normalization | PR #18 open, 30/30 tests |
| 5 | Conclusions, Q6 taxonomy, reconciliation, coverage-based abstention | not started |
| 6 | Shared asset registry | not started |
| 7 | Multi-variant fan-out infrastructure | not started |
| 8 | Strategy nomination and bake-off | not started |

701 tests pass, 4 skipped.

## What is settled and should not be reopened

The Q1/Q3 boundary. Q1 keyed by `(target identity, targetRole, biologicalIntent)`,
not by modality. The deterministic rubric (`composeRoster` makes NO model call).
Modality conditioning via lens injected into Q2 and Q6 only. `strategyFingerprint`
as identity, `strategyVariantLabel` as presentation only.

**Ontology, approved 2026-07-27:** MONDO pinned to release 2026-06-02 is the
canonical disease namespace. EFO 3.91.0 and DOID/NCIt/Orphanet/MeSH are alias and
mapping layers reachable only through explicit crossrefs. This cleared the human
gate that was blocking slice 4.

**Slice 4, decided while closing the last six tests:**

- A broad/narrow/related crossref is **identity-bearing**. `EFO:BROAD_LUNG_CANCER`
  maps into `MONDO:0005233` without being it, so the relation and the alias
  source id are hashed into `canonicalContextId`. Hashing the resolved MONDO id
  alone gave the alias the same id as the exact term - a silent merge of a
  broader population into a narrower one, which is precisely what rule 5 exists
  to prevent. `contextsAreEquivalent` also rejects alias mappings outright, so
  the guarantee does not rest on the hash recipe staying correct.
- `normalizeDiseaseContext` returns `normalizedIdentity`, the exact payload it
  hashes, so a caller can recompute the id and prove no second hashing
  convention appeared. It is a derivation, not stored contract:
  `DiseaseContextKeySchema` strips it.
- `conflicting` is a **status value**, not only a boolean flag, matching §8.3's
  flat list. The boolean is kept alongside it so callers switching on status do
  not have to remember that `conflicting` is also a both-evaluated row.
  Status names stay snake_case (house convention); Codex's suite used kebab
  with a capitalized `Q`, and the test was changed rather than the code.

## The eval, run 2026-07-28

Ran the `fast` subset (CDCP1 + the ZXQR7 trap) against merged slices 0-3 on the
groq backend, 3 repeats. Scorecard preserved at
`docs/slices/eval-runs/2026-07-28-head-slices0-3.{md,json}`.

It printed `[eval] PASS`. **That PASS did not mean what it looks like.**
`eval/golden/verdict/_baseline.json` does not exist, so `checkRegression` set
`baseline = null` and skipped the regression loop entirely: `regressed` was
empty by construction, not by measurement. The only gates that actually ran
were the grounding hard-failures and two absolute floors. Nothing compared
slices 2-3 to anything.

Results worth knowing regardless:

- ZXQR7 (trap) passes all 12 metrics and returns `insufficient-evidence`.
  Abstention holds.
- `grounding_integrity`, `computation_grounding`, `retrieval_recall`,
  `faithfulness`, `figure_grounding` are all 1.000.
- CDCP1 fails 5 of 12 (see the regression section below): `developability_catch` 0.000, `verdict_in_band` 0.000,
  `claim_probes` 0.000, `verdict_stability` 0.667,
  `unsupported_sentence_ratio` 0.591. Verdict `no-go`, expected `watch`.
  Those zeros are consistent with snippet neutralization having removed cues
  the metric keyed on - but with no baseline that is a hypothesis, not a
  finding.

## READ FIRST: 11 of 12 metrics are single-draw

`scoreTarget` (`eval/src/runner.ts`) runs each target `SONNY_EVAL_REPEATS` times
but keeps only the last artifacts:

```js
for (let i = 0; i < REPEATS; i++) { const art = await deps.runOnce(...); verdicts.push(...); last = art }
const a = last!;   // every metric below is computed from THIS ONE RUN
```

Only `verdict_stability` reads the full `verdicts` array. `developability_catch`,
`claim_probes`, `faithfulness`, `unsupported_sentence_ratio` and the rest are
n=1 no matter what `REPEATS` is set to. Setting it to 3 triples the cost and
measures one draw.

The pipeline is genuinely stochastic. Two full CDCP1 runs on the same commit
(`5e8dd58`) produced `developabilityRisks: []` and
`[off_target_toxicity/significant]` respectively. So a 0.500-to-0.000 move on
that metric is one noisy draw against another, not a measured regression.

**Fix this before drawing any further conclusion from a single metric delta.**
Deterministic metrics should aggregate across repeats; judge-scored metrics
(`faithfulness`, `claim_probes`, `unsupported_sentence_ratio`) cost a model call
per repeat, so aggregating them is a real cost decision, not a free one.

## Slices 2-3 and CDCP1: what actually holds up

**Revised 2026-07-28 after the single-draw finding above.** The verdict
regression holds; the `developability_catch` part does not.

- **Holds:** the verdict flip. `verdict_stability` is the one metric computed
  across all repeats, and it moved 1.000 to 0.667 while the mode verdict went
  from `watch` to `no-go`. Baseline agreed `watch` 3/3.
- **Does NOT hold:** `developability_catch` 0.500 to 0.000. Single draw on both
  sides. A later run on `5e8dd58` produced the qualifying
  `off_target_toxicity`/`significant` risk end to end, with no error in the
  trace. The metric is noisy, not pinned at zero.

The section below is the original comparison, kept for the numbers.

## The original paired comparison

The pre-slice comparison ran at `28c338a` in an isolated worktree, same subset,
same backend, 3 repeats. Scorecard at
`docs/slices/eval-runs/2026-07-28-slice0-28c338a.{md,json}`. Only
`eval/src/runner.ts` differs between the two commits (progress logging) and the
goldens are byte-identical, so the engine change is what moved these numbers.

**CDCP1 flipped from the correct verdict to the wrong one.** At `28c338a` it
returned `watch` (expected `watch`) on all three repeats. At HEAD it returns
`no-go`.

| CDCP1 metric | `28c338a` | HEAD | delta |
|---|---|---|---|
| verdict_in_band | 1.000 | 0.000 | **-1.000** |
| verdict_stability | 1.000 | 0.667 | **-0.333** |
| developability_catch | 0.500 | 0.000 | **-0.500** |
| faithfulness | 0.850 | 1.000 | +0.150 |
| unsupported_sentence_ratio | 0.588 | 0.591 | +0.003 |
| claim_probes | 0.000 | 0.000 | 0 |
| grounding_integrity, computation_grounding, retrieval_recall, kol_precision_at_k, cost_latency, figure_grounding | unchanged | unchanged | 0 |

ZXQR7 (trap) is identical across both: all 12 pass, `insufficient-evidence`.
Abstention is unaffected.

Reading this:

- **`claim_probes` 0.000 is NOT a regression.** It was already 0.000 before
  slices 2-3. It has been broken the whole time and is a separate bug.
- **`faithfulness` improved**, 0.850 to 1.000. Neutral snippets appear to have
  made the prose easier to ground, which is the change working as intended.
- The damage is concentrated in verdict correctness and developability catch -
  exactly where removing modality-shaped cues from card snippets and rewriting
  the six briefs would be expected to bite.
- Confidence: one paired run. `verdict_stability` 0.667 at HEAD means CDCP1 now
  flips across repeats, so the effect size is noisy. But the baseline was
  perfectly stable at `watch` (3/3) and HEAD's mode is `no-go`, which is a large
  enough move to act on. Confirm with a second paired run before concluding
  anything about the smaller deltas.

Had `28c338a`'s scorecard been committed as `_baseline.json`, HEAD would fail
the gate on `developability_catch` (0.25 drop vs 0.1 tolerance) and
`verdict_stability` (0.167 vs 0.1).

**`verdict_in_band` would NOT have caught it.** It appears nowhere in
`REGRESSION_TOLERANCE`, so the single most important signal - did the system
reach the right conclusion - is ungated even with a baseline present. See gap 3.

To reproduce (about 25 minutes on groq):

```
git worktree add <dir> 28c338a && cd <dir> && pnpm install   # a real install; a
                                # symlinked node_modules does NOT isolate
cd eval && set -a && . /path/to/Sonny/.env && set +a
SONNY_BACKEND=openai SONNY_EVAL_REPEATS=3 SONNY_EVAL_OUT=<out> \
  pnpm exec tsx src/runner.ts --subset fast
```

Verify isolation before trusting it: `modalityLens.ts` and `modality.ts` must be
absent, and `eval/node_modules/@mrsirquanzo/*` must resolve inside the worktree.

## Harness gaps found while reading the eval

1. **Fixed.** A missing baseline passed silently. `checkRegression` now returns
   `baselineFound`, the runner prints a loud warning and labels the PASS line,
   and there is now a test proving the regression gate actually fires when a
   baseline does exist - which nothing had covered, which is why the hole
   survived.
2. **Open, needs a policy call.** `ABSOLUTE_FLOORS` covers 2 of 12 metrics
   (`figure_grounding`, `computation_grounding`). CDCP1 failed 5 metrics and the
   run still exited 0. Deciding which of the remaining 10 deserve floors, and at
   what values, is a judgment call about what the eval is for, not a bug fix.
3. **Open.** `verdict_in_band` has no entry in `REGRESSION_TOLERANCE` and no
   absolute floor, so a target can flip from the right verdict to the wrong one
   and no gate fires. That is exactly what slices 2-3 did to CDCP1, and only
   `developability_catch` and `verdict_stability` would have caught it. Whether
   verdict correctness should be a hard failure or a tolerance is a policy call,
   but ungated is not defensible.

## Open items, highest value first

1. **Make metrics aggregate across repeats** (top section). Every conclusion
   drawn from a single metric delta is unsafe until this lands, and a day was
   spent chasing a `developability_catch` "regression" that a second draw did
   not reproduce.
2. Re-confirm the verdict flip once metrics aggregate. It is the best-supported
   finding here, but it deserves a clean measurement rather than a mode over
   three runs.
3. Commit a `_baseline.json` once a run is trusted, or the regression gate stays
   permanently inert. `28c338a`'s scorecard is the honest choice; note it will
   make CI red until item 1 is fixed, which is the point.
4. Gate `verdict_in_band` (gap 3) and decide floors for the remaining metrics
   (gap 2).
5. `claim_probes` has been 0.000 on CDCP1 since before slices 2-3. Pre-existing,
   unrelated to this regression, and unexplained.
6. Four `it.skip` deferrals from slice 2, reasons in-file: `resolveQueryScope().target`
   becoming a `TargetIdentity`, and a run id for claim ids.

## How these slices are built

Implementation and test-authoring are split across two models. I implement from
the spec; Codex writes the invariant suite from the same spec **without seeing the
implementation**; the tests then run against it. Every disagreement is a real bug,
a spec ambiguity, or a bad test.

The `*-ambiguities.md` files in this directory are Codex's reports on where the
spec was under-determined. They were consistently more valuable than the tests.

Two mechanical gotchas, both hit once:

- **A git worktree with symlinked `node_modules` does not isolate.** Package
  imports resolve to the main checkout, so edits to `packages/shared` in the
  worktree silently have no effect. Needs a real `pnpm install` per worktree.
- **Stacked PRs and squash merges do not compose.** Squash-merging a base branch
  auto-closes the stacked PR and leaves the branch unrebaseable. Land slices one
  at a time.
