# Eval Harness + CI (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the golden-set eval harness and CI ratchet in the `@sonny/eval` package so Sonny's verdict quality is measured and regression-guarded.

**Architecture:** Four reviewed draft files (`goldenSet.ts`, `metrics.ts`, `scorecard.ts`, `runner.ts`) land from `~/Downloads/files`, with fresh tests written to lock their behavior. Two new files bridge to the engine: `adapter.ts` maps the real `@mrsirquanzo/sonny-shared` `Briefing` to the metrics' engine-agnostic `BriefingLike`, and `engine.ts` composes `runDeepResearch` + `synthesizeRecommendation` into a `runOnce(target)` that keeps the full evidence store. CI runs `tsc` + `vitest` on every PR and the live eval nightly.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod, Vitest, tsx, pnpm workspaces, GitHub Actions. Package: `@sonny/eval` (existing, at `eval/`).

## Global Constraints

- **Branch:** all work lands on `hardening/slice-1-eval` (namespaced per the canonical eval-first numbering). Create it before Task 1.
- **Keep the `eval/` package in place** (do not move to `packages/eval`). Replace its superseded Slice-0 files.
- **Draft source of truth:** `goldenSet.ts`, `metrics.ts`, `scorecard.ts`, `runner.ts`, `CDCP1.json`, `ZXQR7.trap.json`, `_subset.json` are copied verbatim from `~/Downloads/files/`. Their `.js` ESM import specifiers already match repo convention. If that folder is unavailable, the exact content is in this session's transcript.
- **Metrics stay engine-decoupled.** Only `adapter.ts` and `engine.ts` import from `@mrsirquanzo/sonny-core`. `metrics.ts`/`scorecard.ts`/`goldenSet.ts` must not.
- **Production engine wiring (copy exactly, from `apps/cli/src/deep.ts`):** `literatureTools: [europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool]`, `structuredTools: [openTargetsTargetTool, clinicalTrialsTool]`, `specialistModel/verifierModel/leadModel: makeModel()`, `roster: RESEARCH_ROSTER`, `budget: { maxRounds: 4 }`.
- **Decorrelated judge:** the eval judge model is `makeModel()` with `model` override `MODEL_ROUTER.verifier`.
- **Abstention gap is known-red:** `RecommendationSchema.verdict` is `go|watch|no-go`; the `ZXQR7` trap allows only `insufficient-evidence`, so its `verdict_in_band` fails until Slice 2. This is expected; do not add abstention here.
- **CI option A:** `tsc --noEmit` + `vitest` per PR/push; live full eval nightly (cron) + `workflow_dispatch`; no live eval blocking PRs; replay deferred.
- **TDD discipline:** for the two new files (`adapter.ts`, `engine.ts` bridge) write the test first. For the copied drafts, write the locking test and confirm it passes against the copied code (characterization). Commit per task.
- **Test commands:** `pnpm --filter @sonny/eval exec vitest run <path>`; type-check `pnpm --filter @sonny/eval exec tsc --noEmit`.

---

## Task 1: Golden schema + golden set + package deps

**Files:**
- Create: `eval/src/goldenSet.ts` (verbatim from `~/Downloads/files/goldenSet.ts`)
- Create: `eval/src/goldenSet.test.ts`
- Create: `eval/golden/CDCP1.json`, `eval/golden/ZXQR7.trap.json`, `eval/golden/_subset.json` (verbatim from `~/Downloads/files/`)
- Delete: `eval/golden/egfr.json`
- Modify: `eval/package.json` (add `zod`, `tsx` deps)

**Interfaces:**
- Produces: `GoldenTarget` (Zod schema + type), `GoldenSet`, `EvalSubset`, `SubsetConfig`, `VerdictLabel`. `GoldenTarget.parse` validates a golden JSON and enforces (via `superRefine`) that `allowedVerdicts` includes `label` and that a `trap` target allows `insufficient-evidence`.

- [ ] **Step 1: Copy the schema and golden files**

```bash
cp ~/Downloads/files/goldenSet.ts eval/src/goldenSet.ts
cp ~/Downloads/files/CDCP1.json eval/golden/CDCP1.json
cp ~/Downloads/files/ZXQR7.trap.json eval/golden/ZXQR7.trap.json
cp ~/Downloads/files/_subset.json eval/golden/_subset.json
git rm eval/golden/egfr.json
```

- [ ] **Step 2: Add deps to `eval/package.json`**

In `eval/package.json`, add to `dependencies`:

```json
    "zod": "^3.23.8"
```

and add a `devDependencies` block if absent:

```json
  "devDependencies": {
    "tsx": "^4.19.0"
  }
```

Then run `pnpm install` from the repo root.

- [ ] **Step 3: Write the failing test**

Create `eval/src/goldenSet.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GoldenTarget } from './goldenSet.js';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../golden/${f}`, import.meta.url), 'utf8'));

describe('GoldenTarget schema', () => {
  it('validates the CDCP1 golden target', () => {
    const t = GoldenTarget.parse(load('CDCP1.json'));
    expect(t.label).toBe('watch');
    expect(t.expectedKols.some((k) => k.investigator === 'Hooper JD' && k.mustAppear)).toBe(true);
  });

  it('validates the ZXQR7 trap and requires abstention in its band', () => {
    const t = GoldenTarget.parse(load('ZXQR7.trap.json'));
    expect(t.trap?.kind).toBe('fictional');
    expect(t.allowedVerdicts).toContain('insufficient-evidence');
  });

  it('rejects a target whose allowedVerdicts omits its label', () => {
    expect(() => GoldenTarget.parse({
      target: 'X', label: 'go', allowedVerdicts: ['watch'], rationale: 'r',
      curator: 'c', curatedAt: '2026-07-02',
    })).toThrow();
  });

  it('rejects a trap that does not allow insufficient-evidence', () => {
    expect(() => GoldenTarget.parse({
      target: 'X', label: 'watch', allowedVerdicts: ['watch'], rationale: 'r',
      trap: { kind: 'fictional', reason: 'r' }, curator: 'c', curatedAt: '2026-07-02',
    })).toThrow();
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @sonny/eval exec vitest run src/goldenSet.test.ts`
Expected: PASS (4 tests). If it fails to resolve `zod`, re-run `pnpm install`.

- [ ] **Step 5: Commit**

```bash
git add eval/src/goldenSet.ts eval/src/goldenSet.test.ts eval/golden/ eval/package.json
git commit -m "feat(eval): land golden-target schema and initial golden set (CDCP1, ZXQR7 trap)"
```

---

## Task 2: Metrics

**Files:**
- Create: `eval/src/metrics.ts` (verbatim from `~/Downloads/files/metrics.ts`)
- Create: `eval/src/metrics.test.ts`

**Interfaces:**
- Consumes: `GoldenTarget` (Task 1).
- Produces: `RunArtifacts`, `BriefingLike`, `EvidenceLike`, `ClaimLike`, `MetricResult`, `StructuredModelLike`, `Judge`; deterministic metrics `groundingIntegrity`, `retrievalRecall`, `kolPrecisionAtK`, `developabilityCatchRate`, `verdictInBand`, `verdictStability`, `costLatency`; `makeJudge(model, judgeModel?)` returning `{ faithfulness, unsupportedSentenceRatio, claimProbes }`.

- [ ] **Step 1: Copy the metrics file**

```bash
cp ~/Downloads/files/metrics.ts eval/src/metrics.ts
```

- [ ] **Step 2: Write the failing test**

Create `eval/src/metrics.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  groundingIntegrity, retrievalRecall, verdictInBand, verdictStability,
  makeJudge, type RunArtifacts, type StructuredModelLike,
} from './metrics.js';
import { GoldenTarget } from './goldenSet.js';

const target = GoldenTarget.parse({
  target: 'CDCP1', label: 'watch', allowedVerdicts: ['watch', 'go'], rationale: 'r',
  seminalPmids: ['23208492'], curator: 'c', curatedAt: '2026-07-02',
});

function artifacts(over: Partial<RunArtifacts> = {}): RunArtifacts {
  return {
    briefing: {
      verdict: 'watch',
      sections: [{ id: 's', claims: [{ id: 'c1', text: 'x', citations: ['PMID:23208492'] }] }],
    },
    evidenceById: new Map([['PMID:23208492', { id: 'PMID:23208492', passage: 'CDCP1 is cleaved.' }]]),
    elapsedMs: 100,
    ...over,
  } as RunArtifacts;
}

describe('deterministic metrics', () => {
  it('groundingIntegrity is 1.0 when every claim citation resolves', () => {
    expect(groundingIntegrity(artifacts()).score).toBe(1);
  });

  it('groundingIntegrity flags an unresolvable citation', () => {
    const a = artifacts({
      briefing: { verdict: 'watch', sections: [{ id: 's', claims: [{ id: 'c1', text: 'x', citations: ['PMID:999'] }] }] } as any,
    });
    const m = groundingIntegrity(a);
    expect(m.score).toBe(0);
    expect(m.pass).toBe(false);
  });

  it('retrievalRecall measures gold PMIDs pulled into the store', () => {
    expect(retrievalRecall(artifacts(), target).score).toBe(1);
    const empty = artifacts({ evidenceById: new Map() });
    expect(retrievalRecall(empty, target).score).toBe(0);
  });

  it('verdictInBand passes inside the band and fails outside', () => {
    expect(verdictInBand(artifacts(), target).pass).toBe(true);
    expect(verdictInBand(artifacts({ briefing: { verdict: 'no-go', sections: [] } as any }), target).pass).toBe(false);
  });

  it('verdictStability reports flip rate across repeats', () => {
    expect(verdictStability(['watch', 'watch', 'watch']).score).toBe(1);
    expect(verdictStability(['watch', 'go', 'watch']).pass).toBe(true); // 1/3 flip <= 0.2? no -> check
  });
});

describe('judge metrics (decorrelated stub)', () => {
  const stub: StructuredModelLike = {
    async generateStructured() { return { verdict: 'supported', rationale: 'ok' } as any; },
  };
  it('faithfulness scores supported claims from the judge', async () => {
    const judge = makeJudge(stub);
    const m = await judge.faithfulness(artifacts());
    expect(m.score).toBe(1);
    expect(m.pass).toBe(true);
  });
});
```

Note on the stability assertion: `verdictStability(['watch','go','watch'])` has flip rate `1/3 ≈ 0.33`, which is `> 0.2`, so `pass` is `false`. Correct the last assertion to `expect(verdictStability(['watch', 'go', 'watch']).pass).toBe(false);` before running.

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @sonny/eval exec vitest run src/metrics.test.ts`
Expected: PASS after the stability-assertion correction above.

- [ ] **Step 4: Commit**

```bash
git add eval/src/metrics.ts eval/src/metrics.test.ts
git commit -m "feat(eval): land output-quality metrics (deterministic + decorrelated judge)"
```

---

## Task 3: Scorecard

**Files:**
- Create: `eval/src/scorecard.ts` (verbatim from `~/Downloads/files/scorecard.ts`)
- Create: `eval/src/scorecard.test.ts`

**Interfaces:**
- Consumes: `MetricResult` (Task 2).
- Produces: `Scorecard`, `TargetScore`, `RegressionResult`, `REGRESSION_TOLERANCE`, `aggregate`, `toMarkdown`, `writeScorecard`, `checkRegression`.

- [ ] **Step 1: Copy the scorecard file**

```bash
cp ~/Downloads/files/scorecard.ts eval/src/scorecard.ts
```

- [ ] **Step 2: Write the failing test**

Create `eval/src/scorecard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { aggregate, checkRegression, type Scorecard, type TargetScore } from './scorecard.js';

function target(name: string, grounding: number, faithful: number): TargetScore {
  return {
    target: name, label: 'watch', verdict: 'watch', trap: false,
    metrics: [
      { name: 'grounding_integrity', score: grounding, pass: grounding >= 0.99 },
      { name: 'faithfulness', score: faithful, pass: faithful >= 0.9 },
    ],
  };
}

function card(targets: TargetScore[]): Scorecard {
  return { runAt: '2026-07-02', backend: 'anthropic', subset: 'fast', targets, aggregates: aggregate(targets) };
}

describe('scorecard', () => {
  it('aggregates per-metric means', () => {
    const agg = aggregate([target('a', 1, 0.8), target('b', 1, 1.0)]);
    expect(agg.grounding_integrity).toBe(1);
    expect(agg.faithfulness).toBeCloseTo(0.9, 5);
  });

  it('treats a missing baseline as a first run (no regressions)', async () => {
    const reg = await checkRegression(card([target('a', 1, 0.95)]), '/nonexistent/_baseline.json');
    expect(reg.regressed).toEqual([]);
    expect(reg.hardFailures).toEqual([]);
  });

  it('hard-fails when grounding_integrity fails on any target', async () => {
    const reg = await checkRegression(card([target('a', 0.5, 0.95)]), '/nonexistent/_baseline.json');
    expect(reg.hardFailures).toContain('a');
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @sonny/eval exec vitest run src/scorecard.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add eval/src/scorecard.ts eval/src/scorecard.test.ts
git commit -m "feat(eval): land scorecard aggregation and baseline regression check"
```

---

## Task 4: Adapter - real `Briefing` to metrics `BriefingLike`

**Files:**
- Create: `eval/src/adapter.ts`
- Test: `eval/src/adapter.test.ts`

**Interfaces:**
- Consumes: `Briefing`, `Evidence`, `TraceEvent` (from `@mrsirquanzo/sonny-shared`); `RunArtifacts`, `BriefingLike`, `EvidenceLike` (from `./metrics.js`).
- Produces: `toRunArtifacts(briefing: Briefing, evidence: Evidence[], events: TraceEvent[], elapsedMs: number): RunArtifacts`.

- [ ] **Step 1: Write the failing test**

Create `eval/src/adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { Briefing, Evidence } from '@mrsirquanzo/sonny-shared';
import { toRunArtifacts } from './adapter.js';

const evidence: Evidence[] = [{
  id: 'PMID:1', kind: 'publication', source: 's', title: 'T', snippet: 'snip',
  passage: 'full passage', url: 'u', raw: {}, retrievedAt: 'now',
}];

const briefing: Briefing = {
  target: 'CDCP1',
  recommendation: {
    verdict: 'watch', thesis: 'th',
    bull: [{ point: 'good', citations: ['PMID:1'] }],
    bear: [{ point: 'bad', citations: [] }],
    conditions: ['c'],
  },
  executiveRead: 'exec',
  sections: [{ id: 'sec', title: 'Sec', takeaway: 't', claims: [{ id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 0.9 }], sources: ['PMID:1'], rag: 'amber' }],
  weighing: { takeaway: 'w', claims: [] },
  references: [],
  kolCluster: { target: 'CDCP1', labs: [{ investigator: 'Hooper JD', institution: 'UQ', paperCount: 3, weight: 1, evidenceIds: ['PMID:1'] }] },
};

describe('toRunArtifacts', () => {
  it('flattens recommendation.verdict and CasePoint bull/bear to the metrics shape', () => {
    const a = toRunArtifacts(briefing, evidence, [], 1234);
    expect(a.briefing.verdict).toBe('watch');
    expect(a.briefing.bull).toEqual(['good']);
    expect(a.briefing.bear).toEqual(['bad']);
    expect(a.briefing.executiveRead).toBe('exec');
    expect(a.elapsedMs).toBe(1234);
  });

  it('builds evidenceById with passages from the full evidence list', () => {
    const a = toRunArtifacts(briefing, evidence, [], 0);
    expect(a.evidenceById.get('PMID:1')?.passage).toBe('full passage');
  });

  it('maps kolCluster labs to investigator/institution', () => {
    const a = toRunArtifacts(briefing, evidence, [], 0);
    expect(a.briefing.kolCluster?.labs[0].investigator).toBe('Hooper JD');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/eval exec vitest run src/adapter.test.ts`
Expected: FAIL (`adapter.js` does not exist).

- [ ] **Step 3: Write the implementation**

Create `eval/src/adapter.ts`:

```typescript
import type { Briefing, Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { RunArtifacts, BriefingLike, EvidenceLike } from './metrics.js';

/**
 * Adapt the real @mrsirquanzo/sonny-shared Briefing (nested recommendation, CasePoint bull/bear)
 * plus the full evidence store into the metrics' engine-agnostic RunArtifacts.
 * This is the only place the eval package knows the core Briefing shape.
 */
export function toRunArtifacts(
  briefing: Briefing,
  evidence: Evidence[],
  _events: TraceEvent[],
  elapsedMs: number,
): RunArtifacts {
  const briefingLike: BriefingLike = {
    verdict: briefing.recommendation.verdict,
    thesis: briefing.recommendation.thesis,
    executiveRead: briefing.executiveRead,
    bull: briefing.recommendation.bull.map((p) => p.point),
    bear: briefing.recommendation.bear.map((p) => p.point),
    sections: briefing.sections.map((s) => ({
      id: s.id,
      claims: s.claims,
      developabilityRisks: s.developabilityRisks,
    })),
    kolCluster: briefing.kolCluster
      ? { labs: briefing.kolCluster.labs.map((l) => ({ investigator: l.investigator, institution: l.institution })) }
      : undefined,
  };
  const evidenceById = new Map<string, EvidenceLike>(
    evidence.map((e) => [e.id, { id: e.id, passage: e.passage, snippet: e.snippet, title: e.title }]),
  );
  return { briefing: briefingLike, evidenceById, elapsedMs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sonny/eval exec vitest run src/adapter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @sonny/eval exec tsc --noEmit`
Expected: no errors (the `sections` and `kolCluster` mappings are structurally compatible with `BriefingLike`).

- [ ] **Step 6: Commit**

```bash
git add eval/src/adapter.ts eval/src/adapter.test.ts
git commit -m "feat(eval): adapter mapping real Briefing to engine-agnostic RunArtifacts"
```

---

## Task 5: Engine driver - `runOnce`

**Files:**
- Create: `eval/src/engine.ts`

**Interfaces:**
- Consumes: `runDeepResearch`, `synthesizeRecommendation`, `assembleReferences`, `makeModel`, `currentBackend`, `RESEARCH_ROSTER` (from `@mrsirquanzo/sonny-core`); the literature/structured tools (from `@mrsirquanzo/sonny-mcp-gateway`); `toRunArtifacts` (Task 4); `RunArtifacts` (Task 2).
- Produces: `makeRunOnce(): (target: string) => Promise<RunArtifacts>`; re-exports `currentBackend`.

- [ ] **Step 1: Write the implementation**

This file is the single live coupling to the engine; it mirrors `apps/cli/src/deep.ts`'s wiring but composes `runDeepResearch` + `synthesizeRecommendation` so it keeps the full evidence store. It is exercised by the live nightly/on-demand run, not a unit test (per the spec). Create `eval/src/engine.ts`:

```typescript
import type { Briefing, TraceEvent } from '@mrsirquanzo/sonny-shared';
import {
  runDeepResearch, synthesizeRecommendation, assembleReferences,
  makeModel, currentBackend, RESEARCH_ROSTER,
} from '@mrsirquanzo/sonny-core';
import {
  europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool,
  openTargetsTargetTool, clinicalTrialsTool,
} from '@mrsirquanzo/sonny-mcp-gateway';
import { toRunArtifacts } from './adapter.js';
import type { RunArtifacts } from './metrics.js';

/**
 * Build the eval's runOnce(target): the ONLY coupling to @mrsirquanzo/sonny-core. Mirrors
 * apps/cli/src/deep.ts, but composes runDeepResearch + synthesizeRecommendation
 * directly so the full evidence store (not just cited references) is available
 * to the retrieval/grounding metrics.
 */
export function makeRunOnce(): (target: string) => Promise<RunArtifacts> {
  return async (target: string): Promise<RunArtifacts> => {
    const events: TraceEvent[] = [];
    const emit = (e: TraceEvent) => events.push(e);
    const leadModel = makeModel();
    const t0 = Date.now();
    const result = await runDeepResearch({
      target,
      roster: RESEARCH_ROSTER,
      literatureTools: [europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool],
      structuredTools: [openTargetsTargetTool, clinicalTrialsTool],
      specialistModel: makeModel(),
      verifierModel: makeModel(),
      leadModel,
      emit,
      budget: { maxRounds: 4 },
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
  };
}

export { currentBackend };
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @sonny/eval exec tsc --noEmit`
Expected: no errors. This confirms every `@mrsirquanzo/sonny-core` import resolves and the `runDeepResearch` opts shape matches.

- [ ] **Step 3: Commit**

```bash
git add eval/src/engine.ts
git commit -m "feat(eval): runOnce engine driver composing deep research + recommendation"
```

---

## Task 6: Runner - wire it together, remove old eval files

**Files:**
- Create: `eval/src/runner.ts` (from `~/Downloads/files/runner.ts`, with the CLI block replaced)
- Test: `eval/src/runner.test.ts`
- Delete: `eval/src/index.ts`, `eval/src/score.ts`, `eval/src/score.test.ts`
- Modify: `eval/package.json` (repoint the `eval` script)

**Interfaces:**
- Consumes: `loadGolden` inputs (golden dir + `_subset.json`); `makeRunOnce` (Task 5); `makeModel`, `MODEL_ROUTER` (from `@mrsirquanzo/sonny-core`).
- Produces: `runEval(deps, subset, backend)`, `loadGolden(subset)`; CLI entry `pnpm --filter @sonny/eval exec tsx src/runner.ts -- --subset fast`.

- [ ] **Step 1: Copy the runner and replace its CLI stub**

```bash
cp ~/Downloads/files/runner.ts eval/src/runner.ts
```

Then replace the final CLI block (the `if (import.meta.url === ...)` section that currently `throw`s "wire EngineDeps") with real wiring:

```typescript
// CLI entry: `pnpm --filter @sonny/eval exec tsx src/runner.ts -- --subset fast`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { makeRunOnce, currentBackend } = await import('./engine.js');
  const { makeModel, MODEL_ROUTER } = await import('@mrsirquanzo/sonny-core');
  const subset = (process.argv.includes('--subset')
    ? process.argv[process.argv.indexOf('--subset') + 1]
    : 'fast') as EvalSubset;
  const code = await runEval(
    { runOnce: makeRunOnce(), judgeModel: makeModel(), judgeModelId: MODEL_ROUTER.verifier },
    subset,
    currentBackend(),
  );
  process.exit(code);
}
```

Confirm the top of `runner.ts` exports `runEval` and `loadGolden` (add `export` to `loadGolden` if the draft leaves it unexported) and that `EngineDeps` includes `judgeModelId?: string` (it does in the draft).

- [ ] **Step 2: Remove the superseded Slice-0 files**

```bash
git rm eval/src/index.ts eval/src/score.ts eval/src/score.test.ts
```

- [ ] **Step 3: Repoint the `eval` script**

In `eval/package.json`, change the `eval` script:

```json
    "eval": "tsx src/runner.ts"
```

- [ ] **Step 4: Write the failing test (loadGolden + fast subset)**

Create `eval/src/runner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadGolden } from './runner.js';

describe('loadGolden', () => {
  it('loads and validates the fast subset (CDCP1 + ZXQR7)', async () => {
    const targets = await loadGolden('fast');
    const names = targets.map((t) => t.target).sort();
    expect(names).toEqual(['CDCP1', 'ZXQR7']);
  });

  it('loads all golden targets for the full subset', async () => {
    const targets = await loadGolden('full');
    expect(targets.length).toBeGreaterThanOrEqual(2);
  });
});
```

This test runs from the package root, so it relies on the draft's `GOLDEN_DIR` default of `golden`. Run it with the eval package as cwd (the `--filter` command already does this).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sonny/eval exec vitest run src/runner.test.ts`
Expected: PASS (2 tests). If `loadGolden` is not exported, add `export` to its declaration in `runner.ts`.

- [ ] **Step 6: Full package type-check and test**

Run: `pnpm --filter @sonny/eval exec tsc --noEmit && pnpm --filter @sonny/eval exec vitest run`
Expected: no type errors; all eval tests pass.

- [ ] **Step 7: Commit**

```bash
git add eval/src/runner.ts eval/src/runner.test.ts eval/package.json
git rm --cached eval/src/index.ts eval/src/score.ts eval/src/score.test.ts 2>/dev/null || true
git commit -m "feat(eval): wire runner to the engine and judge; remove superseded slice-0 eval"
```

---

## Task 7: CI workflow (option A)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a CI workflow that runs `tsc` + `vitest` on every PR/push, the live full eval nightly and on demand, and never blocks a PR on a live eval.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "0 6 * * *" # nightly full eval (06:00 UTC)
  workflow_dispatch:      # on-demand live fast eval

jobs:
  # Type-check + unit tests on every PR/push. Closes the tsc-masking gap:
  # vitest strips types without checking them, so tsc runs as its own gate.
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r exec tsc --noEmit
      - run: pnpm -r test

  # Full live eval nightly; on-demand fast eval via workflow_dispatch. Never
  # blocks a PR (no pull_request trigger): a paid, nondeterministic call must
  # not fail an unrelated change.
  eval-live:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    needs: build-and-test
    env:
      SONNY_BACKEND: anthropic
      SONNY_EVAL_REPEATS: "3"
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @sonny/eval exec tsx src/runner.ts -- --subset ${{ github.event_name == 'schedule' && 'full' || 'fast' }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: eval-scorecard
          path: eval/.eval-out
```

- [ ] **Step 2: Validate the workflow parses**

Run: `pnpm dlx @action-validator/cli .github/workflows/ci.yml 2>/dev/null || echo "validator unavailable; verify YAML by eye"`
Expected: no schema errors (or the fallback message; then confirm indentation by eye).

- [ ] **Step 3: Confirm the full suite is green locally**

Run: `pnpm -r exec tsc --noEmit && pnpm -r test`
Expected: type-check clean; all workspace tests pass. This is exactly what the PR job will run.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: tsc + vitest on every PR, live eval nightly and on-demand (option A)"
```

---

## Task 8: Capture the baseline (operational, post-merge)

Requires `ANTHROPIC_API_KEY` and a live run; do this once after Tasks 1-7 merge.

**Files:**
- Create: `eval/golden/_baseline.json`

- [ ] **Step 1: Run the full eval live**

```bash
ANTHROPIC_API_KEY=... SONNY_BACKEND=anthropic pnpm --filter @sonny/eval exec tsx src/runner.ts -- --subset full
```

Expected: a scorecard is written to `eval/.eval-out/scorecard.json` and `scorecard.md`. The `ZXQR7` trap's `verdict_in_band` is RED (known-red until Slice 2); every other target's `grounding_integrity` should be ~1.0.

- [ ] **Step 2: Promote the scorecard to the baseline**

```bash
cp eval/.eval-out/scorecard.json eval/golden/_baseline.json
```

- [ ] **Step 3: Commit**

```bash
git add eval/golden/_baseline.json
git commit -m "chore(eval): capture first scorecard baseline (ZXQR7 trap known-red until slice 2)"
```

---

## Self-Review

**Spec coverage:**
- D1 metrics-decoupled + adapter - Tasks 2 and 4.
- D2 keep `eval/`, replace Slice-0 files - Tasks 1 (egfr.json) and 6 (index/score).
- D3 CI option A - Task 7.
- Golden schema/set, ratchet-at-3 - Task 1.
- Eight metrics + judge - Task 2.
- Scorecard + regression - Task 3.
- Engine wiring (compose deep research + recommendation, full evidence) - Task 5.
- Runner + judge decorrelation (`MODEL_ROUTER.verifier`) - Task 6.
- Abstention gap known-red, baseline capture - Task 8 and the CDCP1/ZXQR7 fixtures.
- Out of scope (abstention verdict, replay, ABSOLUTE_FLOORS, growing the set) - correctly absent.

**Placeholder scan:** No "TBD"/"handle edge cases". Verbatim copies name an exact source file and are validated by a written test. Task 8's values come from a live run, which is that task's defined operational deliverable.

**Type consistency:** `RunArtifacts`/`BriefingLike`/`EvidenceLike` names match across Tasks 2, 4, 5. `toRunArtifacts(briefing, evidence, events, elapsedMs)` signature is identical in Tasks 4 and 5. `makeRunOnce()` (no args) and `MODEL_ROUTER.verifier` judge id match between Tasks 5 and 6. Engine tools/models/budget match `apps/cli/src/deep.ts` verbatim. The metrics `verdict` field accepts `recommendation.verdict` (`go|watch|no-go` is a subset of the `VerdictLabel` union including `insufficient-evidence`).

**One correction folded in:** Task 2's `verdictStability(['watch','go','watch'])` assertion is noted as `pass === false` (flip rate 1/3 > 0.2), not true.
