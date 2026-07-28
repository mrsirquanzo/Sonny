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
- CDCP1 fails 5 of 12: `developability_catch` 0.000, `verdict_in_band` 0.000,
  `claim_probes` 0.000, `verdict_stability` 0.667,
  `unsupported_sentence_ratio` 0.591. Verdict `no-go`, expected `watch`.
  Those zeros are consistent with snippet neutralization having removed cues
  the metric keyed on - but with no baseline that is a hypothesis, not a
  finding.

**Still open: is CDCP1 a regression or was it always this way?** A pre-slice
baseline run at `28c338a` was in flight when the session ended and did not
finish. To redo it (about 25 minutes on groq):

```
git worktree add <dir> 28c338a && cd <dir> && pnpm install   # a real install; a
                                # symlinked node_modules does NOT isolate
cd eval && set -a && . /path/to/Sonny/.env && set +a
SONNY_BACKEND=openai SONNY_EVAL_REPEATS=3 SONNY_EVAL_OUT=<out> \
  pnpm exec tsx src/runner.ts --subset fast
```

Only `eval/src/runner.ts` differs between `28c338a` and HEAD (progress logging),
and the goldens are byte-identical, so a wholesale checkout isolates the engine
change cleanly. Verify isolation before trusting the run: `modalityLens.ts` and
`modality.ts` must be absent, and `eval/node_modules/@mrsirquanzo/*` must
resolve inside the worktree.

Caveat on reading the diff: `verdict_stability` 0.667 means CDCP1 flips verdict
across repeats. The zeros are wide enough to read through that noise; small
deltas on the other metrics are not.

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

## Open items, highest value first

1. Finish the `28c338a` baseline comparison above and settle whether CDCP1
   regressed. Until then "output equivalence is not assumed" remains untested.
2. Commit a `_baseline.json` once a run is trusted, or the regression gate stays
   permanently inert.
3. Decide floors for the remaining 10 metrics (gap 2 above).
4. Four `it.skip` deferrals from slice 2, reasons in-file: `resolveQueryScope().target`
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
