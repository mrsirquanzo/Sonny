# Modality-agnostic redesign: slice status

Last updated 2026-07-27.

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
| 4 | MONDO disease-context normalization | **WIP** `feat/slice4-disease-context-main`, 24/30 tests |
| 5 | Conclusions, Q6 taxonomy, reconciliation, coverage-based abstention | not started |
| 6 | Shared asset registry | not started |
| 7 | Multi-variant fan-out infrastructure | not started |
| 8 | Strategy nomination and bake-off | not started |

674 tests pass on `main`.

## What is settled and should not be reopened

The Q1/Q3 boundary. Q1 keyed by `(target identity, targetRole, biologicalIntent)`,
not by modality. The deterministic rubric (`composeRoster` makes NO model call).
Modality conditioning via lens injected into Q2 and Q6 only. `strategyFingerprint`
as identity, `strategyVariantLabel` as presentation only.

**Ontology, approved 2026-07-27:** MONDO pinned to release 2026-06-02 is the
canonical disease namespace. EFO 3.91.0 and DOID/NCIt/Orphanet/MeSH are alias and
mapping layers reachable only through explicit crossrefs. This cleared the human
gate that was blocking slice 4.

## Open items, highest value first

1. **The eval has not run against merged slices 2 and 3.** Snippet neutralization
   changed deterministic claim text, and slice 3 rewrote all six specialist briefs -
   the largest change to model-facing text in the project. "Output equivalence is
   not assumed" is still an untested position until this runs.
2. Slice 4's six remaining test failures. API-shape and hash-composition
   mismatches, not resolution-policy defects. Suite parked at
   `docs/slices/slice4-pending-tests/` (`.test.ts.txt` so vitest skips it).
3. Four `it.skip` deferrals from slice 2, reasons in-file: `resolveQueryScope().target`
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
