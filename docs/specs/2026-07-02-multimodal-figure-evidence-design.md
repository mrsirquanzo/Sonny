# Slice 4: Multimodal Figure Evidence (`pmc_figures` + `figure_read` + ColQwen sidecar) - Design

**Status:** Approved, ready for implementation plan.
**Slice:** 4 of the eval-first roadmap (1 eval harness, 2 abstention, 3 reranker, 4 multimodal figures, 5 evidence grading + contradiction, 6 dense index).
The eval-first roadmap is the single canonical numbering for this workstream.
The main-repo VP ledger (slices 12-14) is shipped history, not a parallel plan, and the patent branch runs its own 1-5b in an isolated worktree.
To keep "Slice 4" unambiguous across the three, branches are namespaced: this work lands on `hardening/slice-4-figures`, patent work on `patent/slice-*`. One integer, one meaning.
**Depends on:** Slice 1 (eval harness) landed, so the figure-reading lift is measured, not asserted.
**Scope:** TypeScript engine only (contract + Tools + wiring + eval hooks) against a stubbed sidecar.
The ColQwen + VLM GPU service is fully specced here but built in the fast-follow **Slice 4b**.
**Date:** 2026-07-02.

## 1. Problem

Sonny reads PMC full-text body sections as text passages.
In biomedicine the decision-relevant result often lives in the figure, not the prose: the hazard ratio is in the forest plot, survival is in the Kaplan-Meier curve, dose-response and selectivity are in panels, and effect sizes are in results tables the body only gestures at.
Sonny currently cannot see any of that.
A dossier that never reads a figure is blind to the single most decision-relevant artifact in a clinical paper.

The grounded ethos makes this worse, not better.
Because Sonny refuses to assert what it cannot ground, figure-borne findings simply never enter the dossier.
The fix is not to relax grounding.
It is to make figures a grounded evidence type Sonny can retrieve, read, and cite like any other.

## 2. Goal and non-goals

Goal: for a deep-read paper, retrieve its figures, let a decorrelated vision model read the figures relevant to a specialist's question, and register those readings as first-class grounded evidence that flows through the existing grounding gate and verifier unchanged.

Non-goals for this slice:

- No figure generation or redrawing. Read-only.
- No OCR pipeline. The vision model reads the rendered figure directly.
- No new front-end. A figure citation is just another evidence id on the existing cited-dossier path.
- No multimodal verifier. The text verifier stays text-only; section 5.3 explains how figure readings are verified without one.
- No GPU service in this slice. The Python ColQwen + VLM sidecar is specced (sections 3.3, 7) and built in Slice 4b. This slice ships and tests everything TS-side against a stubbed sidecar.

## 3. The contract

### 3.1 Figure evidence

A figure is an `Evidence` record, same shape as everything else, so the store, dedup, grounding gate, and references need no changes.

```
id:        "PMCID:PMC1234567#fig-3"      // canonical, idempotent
kind:      "figure"                       // new Evidence.kind value
source:    "pmc"
title:     "Figure 3"
snippet:   <author caption, truncated>
passage:   <full author caption>          // the trusted anchor (see 5.3)
locator:   "fig-3"
url:       <figure image url from PMC OA>
metadata:  { figureType?, imageRef }       // figureType best-effort from the reader
raw:       <PMC figure node>
```

The figure's `passage` is the author-written caption, never the model's reading.
The reading is attached separately as a `FigureReading` on the section's critique channel (section 3.2), so the reader can never ground itself.

### 3.2 The `FigureReading` contract (`@mrsirquanzo/sonny-shared`)

```
FigureReading: {
  evidenceId,                 // the figure's store id, set in code
  figureType?: "forest_plot" | "kaplan_meier" | "dose_response" | "bar" | "flow" | "other",
  reading: string,            // the model's textual interpretation
  extractedValues?: [{
    label,
    value,                    // the value string as the model read it
    unit?,
    inCaption: boolean,       // COMPUTED TS-side, deterministic (section 5.3). NOT from the model.
    readRisk: "low" | "high"  // DERIVED TS-side: low iff inCaption, high otherwise. Binary, no fuzzy tier.
  }],
  confidence: number          // 0..1, the reader's own confidence (advisory only)
}
```

`inCaption` and `readRisk` are computed in TypeScript, not returned by the sidecar.
`readRisk` is strictly binary: `low` if and only if the value string is present in the caption, `high` otherwise.
This is the load-bearing decision of the slice; see section 5.3.

Note that this is a distinct shape from the sidecar wire response (section 3.4), which carries neither `inCaption` nor `readRisk`.
`FigureReading` is the Tool's output; the wire response is its input.
The two must not be conflated in code or tests (section 3.5).

### 3.3 The Tools (`mcp-gateway`)

Same uniform `Tool` interface as every other source: `call(args, fetchImpl = fetch) => Promise<...>`, throwing on non-OK HTTP so `safeToolCall` isolates it.
Retrieval and interpretation are two separate Tools so they stay independently testable.

```
pmc_figures:
  call({ pmcid }, fetchImpl) -> Evidence[]        // one Evidence per figure (kind: "figure")

figure_read:
  call({ question, figures }, fetchImpl) -> FigureReading[]
    // figures: [{ figureId, imageUrl, caption }]
    // calls the sidecar, then computes inCaption + readRisk TS-side (section 5.3)
```

`pmc_figures` only fetches and registers figures.
`figure_read` calls the ColQwen sidecar for relevance ranking and VLM reads, then derives grounding facts locally.

### 3.4 The sidecar HTTP contract (built in Slice 4b, stubbed here)

The retrieval and vision models are Python (ColQwen, a VLM).
They live in a small FastAPI service behind the Tool, exactly the "one engine, thin services" boundary from the architecture review: the engine stays TypeScript, the model runtime stays isolated, and the Tool is the only thing that crosses.

```
POST /figures/analyze
  body: {
    question: string,
    figures: [{ figureId, imageUrl, caption }],
    topK: number = 3
  }
  200: {
    readings: [{
      figureId,
      relevanceScore,               // ColQwen late-interaction MaxSim rank
      figureType,
      reading,
      extractedValues: [{ label, value, unit? }],   // NO inCaption, NO readRisk
      confidence
    }]
  }
  non-2xx on failure (Tool throws; safeToolCall isolates)

GET /healthz -> 200 when models are loaded
```

The service ranks all supplied figures by ColQwen relevance to `question`, then runs the VLM read on the top `topK` only, to bound cost.
It never returns `inCaption` or `readRisk`; those are the engine's to compute.

### 3.5 The contract of record: a shared fixture

The seam between the TS engine and the deferred GPU service is pinned by one canonical fixture, `packages/mcp-gateway/src/fixtures/figures-analyze.fixture.json`.

The fixture encodes the **sidecar wire response** shape (section 3.4) only: `extractedValues` carry `label`, `value`, and optional `unit`, and deliberately carry **no** `inCaption` and **no** `readRisk`.
This keeps the two schemas from blurring: the fixture is `figure_read`'s *input*, and `FigureReading` (section 3.2) is its *output*.
The fixture holds at least:

- one `extractedValue` whose `value` string appears in its figure's caption (the Tool must derive `readRisk: low`), and
- one `extractedValue` absent from the caption (a pixel-only read, the Tool must derive `readRisk: high`).

The contract is bound on both sides against this one file:

- **TS side (this slice):** `figure_read`'s tests stub the sidecar with the fixture and assert the Tool's *derivation* from it - that `inCaption` and the binary `readRisk` come out correct for both values. The fixture is never hand-annotated with the derived fields; the test proves the Tool computes them.
- **Python side (Slice 4b):** the sidecar ships a contract test whose Pydantic model round-trips the same `figures-analyze.fixture.json`.

Only when both sides validate against the identical file is the contract genuinely two-sided and drift-proof.
When the sidecar lands, that round-trip test proves the two agree.

## 4. Data flow

Plugs into the deep-read step of `researcher.ts`, right after a paper is deep-read and skeptic-audited:

```
deep-read paper                      (existing)
  -> skeptic audit                   (existing, decorrelated)
  -> pmc_figures(pmcid)              (NEW: register figures as Evidence)
  -> figure_read(question, figures)  (NEW: sidecar rank + VLM read top-K,
                                      then TS-side inCaption + readRisk)
  -> extract claims                  (existing) MAY now cite a figure evidence id;
                                      figure-derived numeric claims carry readRisk
  -> ground + verify                 (existing, unchanged: caption is the anchor)
```

The `question` passed to `figure_read` is the specialist's own research question, so relevance ranking stays on-topic.
Every step emits a trace event; a new `figure_read` `TraceEvent` joins the glass-box union so the reading is auditable live, the same way the skeptic audit and developability calls are.
If the sidecar is unavailable, `safeToolCall` returns `[]`, no figure evidence is registered, and the run completes text-only.
Figures are additive, never load-bearing for completion.

Both figure Tools are gated behind a `SONNY_FIGURES` flag. It is **opt-in** (`SONNY_FIGURES=on` enables `pmc_figures` and `figure_read`) until Slice 4b lands the real sidecar; with no sidecar the default-off path keeps the pipeline text-only and avoids a duplicate efetch and a failing sidecar POST on every deep-read. Slice 4b flips the default to on once a healthz-gated sidecar exists.
This flag is in this slice's scope, not assumed.
It is what makes task 0's acceptance criterion (figures-off miss to figures-on catch) reproducible, and it gives the eval harness a clean ablation switch for any figures-on/off A/B.

## 5. Design decisions and reasoning

### 5.1 Why a Python sidecar, not a JS reimplementation

ColQwen and the VLM are Python-native and GPU-bound.
Embedding them into the TS engine is impossible; calling a hosted text-only API loses the visual model entirely.
The sidecar is the same discipline already argued in the architecture review: the model runtime deploys, scales, and fails on its own tier, and Sonny reaches it through one Tool.

### 5.2 Why figures are first-class Evidence

Making a figure an `Evidence` with a canonical id means the grounding gate, dedup, verifier, references, and glass-box all work on it for free.
A figure claim is grounded exactly like a text claim: no token, no ship.
This is cheaper and more coherent than a parallel figure path.

### 5.3 How a figure reading is grounded and verified without a multimodal verifier

This is the crux.
The text verifier cannot see pixels, so a naive design would let the vision model both read and self-certify, breaking decorrelation.
The resolution has two parts, and the second is what makes the metric in section 6 ungameable.

**Caption as the anchor.**
The figure's `passage` is the author-written caption, which is trusted, human-authored text.
Downstream claims that cite the figure are verified by the existing text verifier against the caption, not against the model's own reading.
Caption-consistent claims verify normally.

**`inCaption` is a deterministic TS-side fact, not the reader's opinion.**
For each `extractedValue` the sidecar returns, the `figure_read` Tool checks in TypeScript whether the value string is present in the figure's caption passage.
This is a string-presence check, not a model judgment.
The check normalizes numerics before testing presence (trailing zeros, decimal-separator and middle-dot variants, thousands separators), so `0.62` and `0.620` match.
A false `high` is the safe direction: it under-credits rather than launders, so normalization can start simple and tighten later without ever risking honesty.
`readRisk` is then derived deterministically and binary:

- `low` when the value is present in the caption (anchored in author text),
- `high` otherwise (pixel-only: read off an axis or bar, absent from the caption).

There is deliberately no `moderate` tier in this slice.
A middle tier would require corroborating a pixel read against arbitrary already-ingested text, and a bare number like `0.62` collides with unrelated numbers (a p-value, a different endpoint, a page reference).
That fuzzy match is a false-positive path that downgrades genuinely pixel-only reads to "corroborated" - the exact honesty leak this section exists to close, re-entering through a deterministic-but-noisy door instead of a model-self-report door.
It also muddies the metric: under binary, `figure_grounding` (fraction not-`high`) is precisely "fraction caption-anchored," crisp and unforgeable; a corroborated tier lets a noisy cross-check inflate it, which is Goodhart re-entry.
A corroborated tier is reintroduced only when a later slice lands structural table extraction, and even then gated on matching the value plus its label or unit in the same table row, never the bare number.

Because the reader never reports `inCaption` or `readRisk`, it cannot under-flag a pixel read to inflate the grounding metric.
Caption-anchoring becomes a verified fact rather than the reader's opinion about itself.

**High-risk values are surfaced, never load-bearing.**
A pixel-only (`readRisk: high`) value is treated like a methodological caveat: surfaced in prose, flagged in the trace as model interpretation, and never allowed to drive the verdict.
This mirrors the existing "surface, do not gate" rule for evidence-quality flags.
The result: caption-anchored figure findings are grounded like any citation, and pixel-only readings enter the dossier honestly labeled as interpretation.
Sonny never launders a guessed number into a hard claim.

### 5.4 Why decorrelate the reader

The VLM reader must be a different model family from the writer, the same rule as the skeptic audit and developability assessor.
A reader that shared the writer's family would let the writer rubber-stamp its own visual interpretation.
The reader is a critic-role model, selected in Slice 4b.

### 5.5 Which specialists consume it

Clinical Landscape and Mechanism of Action gain the most (forest plots, survival curves, dose-response).
The Tool is available to every specialist's deep-read, but the question passed to `figure_read` is the specialist's own, so relevance stays on-topic.

## 6. Eval hooks (ties to Slice 1)

### 6.1 The rule: invariants get hard gates, distributions get bands

`grounding_integrity` is a hard gate because it is an invariant: no ungrounded claim ships, ever, 100% of the time by design.
`figure_grounding` is a health ratio: a distribution that should trend well but legitimately varies run to run, because pixel-only `high`-risk reads are allowed by design.
Invariants get hard gates; distributions get bands.
This rule tells us cleanly where every future metric belongs.

### 6.2 The `figure_grounding` metric

Of the claims citing a `kind: "figure"` evidence, the fraction whose `readRisk` is `low` (caption-anchored).
Under the binary `readRisk`, "fraction not-`high`" is exactly "fraction caption-anchored," crisp and unforgeable.
It guards against the dossier filling up with pixel-guessed numbers.
It is gated two ways, mirroring `grounding_integrity`'s dual treatment, and both live in code, not prose:

- **Regression band:** tolerance ~0.1 below baseline, for drift. This is a new entry in the existing `REGRESSION_TOLERANCE` map in `scorecard.ts`.
- **Absolute floor:** a baseline-independent backstop, enforced in `checkRegression` the same way `grounding_integrity`'s hard-fail is. Add an `ABSOLUTE_FLOORS` map beside `REGRESSION_TOLERANCE` (`figure_grounding: ~0.5`, "at least half of figure-citing claims are caption-anchored"), calibrated after the first few real figure runs. A pure band anchors to the first baseline; if the first figure run is already bad, the band would lock that in and never complain. The floor catches a bad first baseline regardless of drift.

The metric returns its denominator `n` (the count of figure-citing claims) alongside the ratio.
The gate applies only when `n >= 3`: below that the metric returns a non-failing/skip result (a `1.0` or `0.0` off one or two claims is noise, reported but not gated).
The deterministic `inCaption` check that feeds this metric normalizes numerics first (section 5.3), and a false `high` under-credits rather than launders, so the metric errs safe.

`faithfulness` and `unsupported_sentence_ratio` already cover figure claims for free, since figure evidence flows through the same verifier.

### 6.3 The figure-heavy golden target: an operational acceptance criterion, not a paper

The measured-lift proof needs a target whose decision-relevant value lives only in a figure.
The binding verification of such a target is not a bibliographic check ("a human confirmed the number is not in the prose"); it is an operational run against a baseline.
So the spec states the requirement operationally, and sourcing plus confirmation is build task 0.

> The figure-heavy golden target must contain a `claimProbe` whose answer is a decision-relevant value present in a figure and absent from the passages baseline Sonny ingests.
> Acceptance: a `SONNY_FIGURES=off` run fails the probe, and a `SONNY_FIGURES=on` run passes it.
> Sourcing and this baseline-miss confirmation are build task 0.

Concrete search criteria for task 0, so it is not a needle hunt: an open-access meta-analysis or subgroup forest plot, with an exact hazard ratio and confidence interval rendered in the plot and not enumerated in the body text.
Subgroup and per-study forest-plot estimates are the richest vein, because they are routinely figure-only.

### 6.4 Why the two eval decisions reinforce each other

A band-plus-floor metric and an operationally-verified target mean the whole proof rests on the measured delta (baseline miss to figure catch), not on hand-curating a pristine paper or on a brittle pass/fail threshold.
Neither piece has to be perfect for the slice to prove itself, which is exactly what a proof should require.

## 7. Test plan (TDD, failing test first)

Fixture-based, no network and no GPU.

- `pmc_figures` parses a PMC OA figure-list fixture into N `Evidence` records with correct canonical ids and captions.
- `pmc_figures` throws on non-OK HTTP so `safeToolCall` isolates it.
- `figure_read` maps a stubbed sidecar `/figures/analyze` response (the shared wire-shape fixture from 3.5) into `FigureReading[]`, deriving the fields the fixture does not carry.
- `inCaption` is deterministic and normalized: a value present in the caption resolves to `readRisk: low`; a pixel-only value resolves to `readRisk: high`; `0.62` matches `0.620`. `readRisk` is binary, with no `moderate` tier.
- The reader cannot game risk: a stubbed reading yields `high` for any value absent from the caption, because the Tool computes it, not the model.
- Integration: a deep-read that includes a figure produces a figure `Evidence` in the store, and a claim citing it passes the grounding gate.
- Resilience: a sidecar 5xx yields `[]` and the run completes text-only.
- Contract: the shared fixture is the single source both the TS stub and (in Slice 4b) the Python Pydantic model validate against.

## 8. Task plan (bite-sized, TDD)

0. **(Eval prerequisite, operational)** Source and confirm the figure-heavy golden target per section 6.3: find a candidate matching the search criteria, run figures-off baseline to confirm the probe misses, hold it for the figures-on catch once the Tools land.
1. `Evidence.kind` gains `"figure"`; `FigureReading` contract in `@mrsirquanzo/sonny-shared`; `figure_read` `TraceEvent` added to the union.
2. `pmc_figures` Tool: fetch and parse PMC OA figures into `Evidence`. Tests, no network.
3. Shared fixture `figures-analyze.fixture.json` (section 3.5).
4. `figure_read` Tool: call the (stubbed) sidecar, map the wire response to `FigureReading[]`, compute deterministic normalized `inCaption`, derive the binary `readRisk`. Tests assert the derivation from the shared wire-shape fixture (fixture carries no derived fields).
5. Wire both into `researcher.ts` deep-read after the skeptic audit; emit the trace event; caption-anchored verification path; gate both Tools behind `SONNY_FIGURES` (opt-in `=== 'on'` until Slice 4b; the deferred sidecar makes default-on unsafe in production).
6. Eval hooks: `figure_grounding` metric in `eval` with the `REGRESSION_TOLERANCE` band entry, the `ABSOLUTE_FLOORS` backstop in `checkRegression`, and the `n >= 3` denominator gate; add the confirmed golden target from task 0; prove the figures-off-miss to figures-on-catch delta via `SONNY_FIGURES`.

## 9. Slice 4b (fast-follow, out of scope here)

- Python FastAPI sidecar: `/figures/analyze` + `/healthz`, ColQwen late-interaction ranking, VLM read of top-K, Pydantic contract, Dockerfile, runs standalone.
- Reader model selection (a critic-family VLM decorrelated from the writer).
- The shared-fixture round-trip test proving the Python contract matches this slice's stub.

## 10. Risks and open questions

- VLM plot-reading accuracy is imperfect; `readRisk` and caption anchoring contain the damage but do not eliminate it. Calibrate the `high`-risk handling against a small hand-checked figure set in Slice 4b.
- PMC OA figure image availability varies; non-OA papers may expose captions but not images. Degrade to caption-only evidence (the caption is still useful text) rather than failing.
- Sidecar latency and GPU cost. Bound with `topK` and by reading figures only from papers that pass the title-gated deep-read, not every hit. Deferred to Slice 4b.
- Table extraction (as opposed to figures) is deferred to a follow-up slice; this spec covers figures and their captions only. A corroborated `readRisk` tier that cross-checks structural table rows (value plus label or unit, never the bare number) is reintroduced with that later slice, not here.
