# Verdict-aware unsupported_sentence_ratio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exempt the abstention verdict from the `unsupported_sentence_ratio` eval metric so a correct abstention no longer registers as a metric failure.

**Architecture:** Add a single guard at the top of `unsupportedSentenceRatio` in `eval/src/metrics.ts`: when the briefing's verdict is `'insufficient-evidence'`, return a perfect score with `detail.abstained` and make zero judge calls. No other metric changes; `faithfulness` and `claim_probes` already handle abstention vacuously.

**Tech Stack:** TypeScript ESM, Vitest. Package `@sonny/eval` at `eval/`.

## Global Constraints

- Never use the em dash; use a plain dash.
- The abstention verdict string is exactly `'insufficient-evidence'` (from `VerdictLabelSchema` in `@mrsirquanzo/sonny-shared`).
- The exempt return value is exactly `{ name: 'unsupported_sentence_ratio', score: 1, pass: true, detail: { abstained: true } }`.
- Only `eval/src/metrics.ts` and `eval/src/metrics.test.ts` change. No behavior change for any non-abstention verdict.
- Surgical change: do not refactor or touch adjacent metrics.

---

### Task 1: Exempt abstention from unsupported_sentence_ratio

**Files:**
- Modify: `eval/src/metrics.ts` (the `unsupportedSentenceRatio` method returned by `makeJudge`, around line 312)
- Test: `eval/src/metrics.test.ts` (append to the existing `describe('judge metrics (decorrelated stub)', ...)` block, around line 93)

**Interfaces:**
- Consumes: `makeJudge(model: StructuredModelLike, judgeModel?: string): Judge` and `RunArtifacts` / `StructuredModelLike` types, all already exported from `eval/src/metrics.ts`.
- The judge method signature is unchanged: `unsupportedSentenceRatio(a: RunArtifacts): Promise<MetricResult>`.
- `a.briefing.verdict` is typed `GoldenTarget["label"]`, which includes `'insufficient-evidence'`.

- [ ] **Step 1: Write the failing tests**

Append these two tests inside the existing `describe('judge metrics (decorrelated stub)', () => { ... })` block in `eval/src/metrics.test.ts` (after the `faithfulness` test):

```ts
it('unsupportedSentenceRatio exempts abstention and makes no judge calls', async () => {
  let calls = 0;
  const countingStub: StructuredModelLike = {
    async generateStructured() { calls++; return { verdict: 'unsupported', rationale: 'x' } as any; },
  };
  const a = {
    briefing: {
      verdict: 'insufficient-evidence',
      thesis: 'Insufficient verified evidence to assess ABC1.',
      executiveRead: 'Fewer than two verified findings support an assessment; the dossier abstains.',
      bull: [],
      bear: [],
      sections: [],
    },
    evidenceById: new Map(),
    elapsedMs: 1,
  } as any as RunArtifacts;
  const judge = makeJudge(countingStub);
  const m = await judge.unsupportedSentenceRatio(a);
  expect(m.score).toBe(1);
  expect(m.pass).toBe(true);
  expect((m.detail as any).abstained).toBe(true);
  expect(calls).toBe(0);
});

it('unsupportedSentenceRatio still scores non-abstention prose via the judge', async () => {
  let calls = 0;
  const countingStub: StructuredModelLike = {
    async generateStructured() { calls++; return { verdict: 'unsupported', rationale: 'x' } as any; },
  };
  const a = {
    briefing: {
      verdict: 'go',
      thesis: 'ABC1 is a validated oncology target with strong genetic support.',
      executiveRead: '',
      bull: [],
      bear: [],
      sections: [{ id: 's', claims: [{ id: 'c1', text: 'ABC1 drives tumor growth', citations: ['PMID:1'] }] }],
    },
    evidenceById: new Map(),
    elapsedMs: 1,
  } as any as RunArtifacts;
  const judge = makeJudge(countingStub);
  const m = await judge.unsupportedSentenceRatio(a);
  expect(calls).toBeGreaterThan(0);
  expect(m.score).toBe(0);
  expect(m.pass).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify the abstention test fails**

Run: `cd . && pnpm --filter @sonny/eval exec vitest run src/metrics.test.ts`
Expected: the "exempts abstention" test FAILS (current code runs the judge on the boilerplate sentences, so `calls` is greater than 0 and `score` is 0, not 1). The "still scores non-abstention prose" test PASSES already (it documents current behavior and guards against the guard being too broad).

- [ ] **Step 3: Add the guard**

In `eval/src/metrics.ts`, at the very top of the `async unsupportedSentenceRatio(a) {` method body (before the `const prose = [...]` line), insert:

```ts
      // An abstention (insufficient-evidence) synthesizes no recommendation: bull/bear
      // are empty and thesis/executiveRead are structural refusal boilerplate with no
      // backing claims. This metric scores prose overreach beyond the evidence, which
      // is not applicable when nothing was synthesized. Exempt it (and skip judge calls),
      // the same way claimProbes early-returns on "no probes".
      if (a.briefing.verdict === 'insufficient-evidence') {
        return { name: 'unsupported_sentence_ratio', score: 1, pass: true, detail: { abstained: true } };
      }
```

- [ ] **Step 4: Run the tests to verify both pass**

Run: `cd . && pnpm --filter @sonny/eval exec vitest run src/metrics.test.ts`
Expected: both new tests PASS, and all pre-existing tests in the file still PASS.

- [ ] **Step 5: Run the full eval package test suite**

Run: `cd . && pnpm --filter @sonny/eval test`
Expected: PASS (the `patentLive` test may show as skipped, which is expected). No failures.

- [ ] **Step 6: Typecheck the eval package**

Run: `cd . && pnpm --filter @sonny/eval build`
Expected: `tsc` completes with no errors.

- [ ] **Step 7: Commit**

```bash
cd .
git add eval/src/metrics.ts eval/src/metrics.test.ts
git commit -m "fix(eval): exempt abstention verdict from unsupported_sentence_ratio"
```

---

## Self-Review

**Spec coverage:**
- "verdict-aware guard, score 1, pass true, zero judge calls, detail.abstained" -> Task 1 Step 3 (guard) + Step 1 (assertions). Covered.
- "only this one metric changes; faithfulness/claim_probes already handle abstention" -> plan touches only `unsupportedSentenceRatio`. Covered.
- "regression guard that the guard is not too broad" -> Task 1 second test (non-abstention still runs the judge). Covered.
- "no network, stubbed model" -> both tests use a synchronous counting stub. Covered.

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code and command step is concrete.

**Type consistency:** `unsupportedSentenceRatio`, `makeJudge`, `StructuredModelLike`, `RunArtifacts`, and the `MetricResult` shape `{ name, score, pass, detail }` match `eval/src/metrics.ts` exactly. The exempt return uses the same metric name string `'unsupported_sentence_ratio'` as the existing return.
