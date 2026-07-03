# Slice: Verdict-aware unsupported_sentence_ratio (abstention exemption) - Design

**Status:** Approved, ready for implementation plan.
**Context:** Follow-up hardening slice surfaced by the first live eval run (haiku smoke) after Slices 1-5 merged.
**Branch:** `hardening/eval-abstention-metric-fix` off `main`.
**Date:** 2026-07-03.

## Purpose

The eval harness's `unsupported_sentence_ratio` judge metric mis-fires on the abstention verdict that Slice 2 was built to produce.
This slice makes the metric verdict-aware so that a correct abstention no longer registers as a metric failure.

## The bug

`unsupportedSentenceRatio` (`eval/src/metrics.ts`) scores the briefing's synthesized prose.
It concatenates `thesis`, `executiveRead`, `bull`, and `bear`, splits into sentences, and asks the decorrelated judge whether each sentence is entailed by the set of verified claims.
The ratio of unsupported (or overreaching) sentences becomes `1 - ratio` as the score, failing when the ratio exceeds `0.1`.

On an abstention, Slice 2 short-circuits before the writer and returns a structural refusal:
`bull` and `bear` are empty, `thesis`/`executiveRead` carry deterministic boilerplate ("Insufficient verified evidence to assess X..."), and by definition fewer than two supported claims exist.
The judge therefore sees self-referential refusal sentences with no backing claims and marks every one unsupported: ratio `1.0`, score `0`, metric fails.

This was confirmed live: a haiku-tier run of the `ZXQR7` trap returned `verdict: insufficient-evidence` (correct, in-band, grounded) yet `unsupported_sentence_ratio` failed with ratio `1.0`, offenders being the two abstention boilerplate sentences.
The run did not fail overall (the runner gates on grounding hard-fail, baseline regression, and absolute floors, not on individual metric `pass` flags), but the metric is semantically wrong and would poison any captured baseline.

## The fix

`unsupportedSentenceRatio` gains a single guard at the top:
when `a.briefing.verdict === 'insufficient-evidence'`, it returns
`{ name: 'unsupported_sentence_ratio', score: 1, pass: true, detail: { abstained: true } }`
and makes zero judge calls.

The metric measures whether synthesized prose overreaches beyond the evidence.
An abstention synthesizes nothing, so the metric is not applicable, exactly as `claimProbes` already early-returns on "no probes" and the deterministic metrics report "none expected".
Skipping the judge calls also saves the wasted model round-trips on every abstaining target.

`a.briefing.verdict` is already available on `BriefingLike` (typed as `GoldenTarget["label"]`, which includes `'insufficient-evidence'` from Slice 2's `VerdictLabelSchema`), so the guard needs no new plumbing.

## Why only this one metric

The live smoke run proves the other two judge metrics already handle abstention correctly, so no general verdict-aware framework is warranted (YAGNI):

- `faithfulness` filters to claims that carry citations; on abstention it sampled `0` claims and returned score `1` (passed vacuously).
- `claim_probes` scores the golden's probe statements against the dossier; the trap's probes expect an "unsupported" stance against the empty dossier, which the judge returned, so it passed.

Only `unsupported_sentence_ratio` scores free prose rather than claims, which is why it alone mis-fires.

## Rejected alternatives

- **Strip the known boilerplate sentences before splitting.**
  Fragile: it couples the metric to the exact abstention wording and breaks the moment that copy changes.
- **Change the abstention output to carry a citation or mark sentences as non-claims.**
  Wrong layer: it distorts the product to satisfy a metric.

## Testing (TDD, stubbed model, no network)

- Abstention briefing (`verdict: 'insufficient-evidence'`, empty `bull`/`bear`, boilerplate `thesis`) yields `score 1`, `pass true`, `detail.abstained === true`, and the stubbed judge model is invoked zero times.
- A normal briefing (`verdict: 'go'`) still runs the judge and computes the ratio as before (regression guard against the guard being too broad).

## Out of scope

- Any change to the abstention behavior itself (Slice 2 is correct; this only fixes how the eval scores it).
- A general verdict-aware wrapper for all judge metrics (the other two already handle abstention; adding one would be speculative).
- Capturing a committed `_baseline.json` (a production-fidelity opus run, deferred separately).
