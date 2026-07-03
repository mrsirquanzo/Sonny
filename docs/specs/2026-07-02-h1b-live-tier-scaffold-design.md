# H1b Live-Tier Scaffold Design

**Status:** Approved to build (extends the locked hardening roadmap; user said proceed).
**Parent:** [Patent Specialist Hardening Roadmap](./2026-07-02-patent-specialist-hardening-roadmap.md), H1b.
**Date:** 2026-07-02.

## Purpose

H1a shipped the offline eval tier: a `GoldenPatent` type, deterministic metrics, and a full-pipeline integration test that is automated regression insurance for the 5b-Critical bug.
H1b turns that into a *live* tier that runs the real specialist (real ingest + real BLAST + real ANARCI + real EPO + real model) against real patents and scores the result.

This slice builds everything that does NOT need the user's private inputs, so the moment the user supplies human-verified ground truth, an EPO key, and an ANARCI install, the live tier is drop-in.

Out of scope for this slice (the drop-in pieces the user supplies later): the 8 curated real golden patents with human-verified facts, the `SONNY_EPO_KEY`/`SONNY_EPO_SECRET` values, and the local `anarci`/`hmmer` install.

## Key decisions

1. **The live tier is opt-in, never in CI.**
   Real NCBI BLAST and EPO calls are slow and flaky, and the roadmap states the live tier depends on H6 (caching) for non-flakiness.
   So the live tier runs only when `SONNY_LIVE=1` and the required capabilities are present.
   The normal `pnpm -r test` / CI path is untouched and stays fast.

2. **Unverified goldens run in observe-only mode.**
   The integrity rule is that ground truth must be human-verified, never fabricated.
   Each golden carries a `groundTruthVerified` flag (default false).
   A golden with `groundTruthVerified: false` is run and its metrics are printed, but they are labeled UNVERIFIED and never asserted as pass/fail.
   Only a human-verified golden becomes a real gate.

3. **Capability gating degrades, it does not crash.**
   The live runner probes each capability (Anthropic key, EPO creds, ANARCI availability) independently.
   A missing capability disables the parts of the pipeline that need it and prints a clear reason, rather than throwing.
   This mirrors the tools' own soft-degradation contracts.

4. **Close the H4 offline minor here.**
   The offline `runPatentPipeline` currently omits `matchCdrCompetitors`, so cdr-level competitor recall is never scored end-to-end.
   Wire `matchCdrCompetitors` (with an injected `cdrBlast`) into both the offline pipeline and the live runner, so the `competitorRecall(..., 'cdr')` metric has a real path.

## Components (all in `eval/`)

### `eval/src/liveGate.ts` - capability detection

```ts
export interface LiveCapabilities {
  live: boolean;        // SONNY_LIVE=1 opt-in flag
  anthropic: boolean;   // ANTHROPIC_API_KEY present
  epo: boolean;         // SONNY_EPO_KEY && SONNY_EPO_SECRET present
  anarci: boolean;      // `anarci` resolvable on PATH
  reasons: string[];    // human-readable list of what is missing and what it disables
}
export function detectLiveCapabilities(env?: NodeJS.ProcessEnv): LiveCapabilities;
export function liveEnabled(caps: LiveCapabilities): boolean; // live && anthropic (the minimum to run anything)
```

`anarci` availability is probed by attempting to resolve the executable (a cheap `which`-style check), not by running a full numbering.
Injectable `env` so the detection is unit-testable without touching real process env.

### `eval/src/goldenLoader.ts` - load + validate goldens

```ts
export interface LoadedGolden { golden: GoldenPatent; groundTruthVerified: boolean; sourceFile: string }
export function loadGoldens(dir?: string): LoadedGolden[];  // reads eval/golden/*.patent.json
```

- Reads every `*.patent.json` in `eval/golden/` (the existing `synthetic-antibody.json` is renamed to `synthetic-antibody.patent.json` so the offline fixture and the loader share one convention; `egfr.json` is the old dossier golden and is left untouched).
- Validates each file against the `GoldenPatent` shape with a small guard that throws a precise error naming the offending file and field (a malformed golden must fail loudly, not silently score zero).
- `GoldenPatent` gains an optional `groundTruthVerified?: boolean`; the loader surfaces it (default false).

### `eval/src/patentLive.ts` - the live runner

```ts
export interface LiveRunReport {
  name: string;
  groundTruthVerified: boolean;
  metrics: PatentMetrics;        // all deterministic metrics for this run
  capabilities: LiveCapabilities;
  notes: string[];               // degradations that applied
}
export async function runLivePatent(golden: GoldenPatent, patentFile: string, caps: LiveCapabilities): Promise<LiveRunReport>;
```

- Runs the real `runPatentWorkup` (real `ingestToMarkdown`, real `blastVerifyTool`, real `confirmRegions`, real `lookupPatent`, real `AnthropicModel`, real decorrelated verifier, real `matchCdrCompetitors`).
- Wires the tools per the detected capabilities (e.g. EPO disabled -> the reconcile EPO dep returns the soft `EPO_CONFIG_MISSING` record; ANARCI disabled -> `anarci_unavailable`).
- Scores the resulting workup against the golden using the existing metrics + `gotConstructs` / `gotCompetitorOverlaps`.
- Never asserts; returns the report. The caller decides how to present verified vs unverified.

### `eval/src/patentScore.ts` - one metrics roll-up

```ts
export interface PatentMetrics {
  extractionRecall: number; residueFidelity: number;
  assigneeRecall: number; familyRecall: number;
  speciesAccuracy: number; pairingAccuracy: number;
  competitorRecallWhole: number; competitorRecallCdr: number;
  competitorPrecisionWhole: number; competitorPrecisionCdr: number;
}
export function scorePatent(workup: PatentWorkup, golden: GoldenPatent): PatentMetrics;
```

Pure function composing the existing `goldenPatent.ts` metrics into one object, reused by both the offline integration test and the live runner. No new metric logic - it only assembles what H1a already defined (assignee/family via `setRecall`).

### `eval/src/patentLive.test.ts` - opt-in live test

- `it.skipIf(!liveEnabled(detectLiveCapabilities()))(...)` so it is inert in normal CI.
- When enabled, loads the verified goldens, runs `runLivePatent` on each, and asserts the metrics meet thresholds ONLY for `groundTruthVerified` goldens; unverified goldens are logged, not asserted.

### CLI entry (extend `eval/src/index.ts` or add `eval/src/patentLiveMain.ts`)

A standalone opt-in runner: `SONNY_LIVE=1 ANTHROPIC_API_KEY=... pnpm --filter @sonny/eval exec tsx src/patentLiveMain.ts`.
Prints the capability report, then each golden's `LiveRunReport` (metrics + verified/unverified label + degradation notes).

## Offline change (closes the H4 minor)

`runPatentPipeline` gains an optional `cdrBlast` in its deps and calls `matchCdrCompetitors(workup, reconciliation, cdrBlast)` before `graphRelationships`, matching `runPatentWorkup`'s ordering.
The existing offline integration test is extended so the synthetic golden's cdr-level overlap is actually scored (the mock `cdrBlast` returns a >=90% pataa hit for the CDR-H3).

## Error handling

- `loadGoldens` throws only on a malformed golden file (precise message); a missing dir yields an empty list.
- `detectLiveCapabilities` never throws.
- `runLivePatent` surfaces tool degradations as `notes`, never throws on a soft tool failure; a hard model failure propagates (a live run with a broken model is a real error worth surfacing).

## Testing

Offline (runs in CI, no external deps):
- `detectLiveCapabilities`: each env combination yields the right flags + reasons; injected env.
- `liveEnabled`: true only when live + anthropic.
- `loadGoldens`: loads the synthetic fixture; a malformed fixture throws naming the file/field; `groundTruthVerified` defaults false.
- `scorePatent`: on a known workup + golden, every metric equals its hand-computed value.
- The extended offline integration test: the synthetic cdr overlap is scored via the injected `cdrBlast`.

Live (skipped unless `SONNY_LIVE=1` + capabilities): the `patentLive.test.ts` path, exercised manually by the user once inputs land.

## Out of scope

- The 8 curated real golden patents with human-verified facts (user supplies).
- Real EPO credentials and ANARCI install (user supplies).
- Non-flaky live CI (depends on H6 caching).
- Any change to the tools themselves (this slice is eval-only plus the one offline pipeline wiring).
