# Abstention Verdict (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Sonny an explicit `insufficient-evidence` abstention verdict, emitted by a deterministic gate in `synthesizeRecommendation` when the dossier carries fewer than two supported findings, instead of manufacturing a `watch`.

**Architecture:** Add `'insufficient-evidence'` to `VerdictLabelSchema` (`@mrsirquanzo/sonny-shared`). In `synthesizeRecommendation`, count supported claims across sections first; if fewer than 2, short-circuit before the writer model and return a deterministic abstention `Recommendation`. Thread `target` into the function so the abstention message names it, updating the two call sites.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod, Vitest, pnpm workspaces. Packages: `@mrsirquanzo/sonny-shared`, `@mrsirquanzo/sonny-core`, `@sonny/eval`.

## Global Constraints

- **Branch:** `hardening/slice-2-abstention` (already created, stacked on `eval-harness-slice-1`). The spec lives at `docs/specs/2026-07-02-abstention-verdict-design.md`.
- **Lineage:** this is the `main` lineage - packages are `@mrsirquanzo/sonny-*`. Do not use `@sonny/*` for the shared/core imports.
- **The trigger is `supportedCount < 2`**, where `supportedCount = sections.reduce((n, s) => n + s.claims.length, 0)`. `Section.claims` is already the supported-only subset. This subsumes the all-red (zero-count) case. The `2` is structural (a bull-and-bear needs two findings to weigh), not tunable - do not parameterize it.
- **Deterministic abstention:** the short-circuit must NOT call the model. No LLM, no I/O on the abstention path.
- **Do not change the normal path**, including the existing `severe developability -> no-go` override. The abstention gate runs before it (a single finding, even beside a severe liability, abstains - a deliberate documented choice).
- **ESM import specifiers end in `.js`** even for `.ts` files.
- **TDD:** failing test first, minimal implementation, passing test, commit per task.
- **Test commands:** `pnpm --filter @mrsirquanzo/sonny-shared exec vitest run <path>`, `pnpm --filter @mrsirquanzo/sonny-core exec vitest run <path>`. Type-check a package with `pnpm --filter <pkg> exec tsc --noEmit`. Whole repo: `pnpm -r build` then `pnpm -r test`.

---

## Task 1: Add `insufficient-evidence` to the verdict union

**Files:**
- Modify: `packages/shared/src/contracts.ts:152`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `VerdictLabelSchema` now accepts `'insufficient-evidence'`; `RecommendationSchema.verdict` extends automatically.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/contracts.test.ts` (add `VerdictLabelSchema` and `RecommendationSchema` to the existing import from `./contracts.js` if not already imported):

```typescript
import { VerdictLabelSchema, RecommendationSchema } from './contracts.js';

describe('abstention verdict', () => {
  it("accepts 'insufficient-evidence' as a verdict label", () => {
    expect(VerdictLabelSchema.parse('insufficient-evidence')).toBe('insufficient-evidence');
  });

  it('RecommendationSchema accepts an abstention recommendation', () => {
    const r = RecommendationSchema.parse({
      verdict: 'insufficient-evidence', thesis: 'Insufficient verified evidence.',
      bull: [], bear: [], conditions: [],
    });
    expect(r.verdict).toBe('insufficient-evidence');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-shared exec vitest run src/contracts.test.ts`
Expected: FAIL (`'insufficient-evidence'` not in the enum, so `VerdictLabelSchema.parse` throws).

- [ ] **Step 3: Add the union member**

In `packages/shared/src/contracts.ts`, change line 152:

```typescript
export const VerdictLabelSchema = z.enum(['go', 'watch', 'no-go', 'insufficient-evidence']);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mrsirquanzo/sonny-shared exec vitest run src/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check the package**

Run: `pnpm --filter @mrsirquanzo/sonny-shared exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): add insufficient-evidence to the verdict union"
```

---

## Task 2: The abstention gate in `synthesizeRecommendation` + call sites

**Files:**
- Modify: `packages/core/src/synthesize.ts`
- Modify: `packages/core/src/synthesize.test.ts` (it already exists - append the new describe block AND update the 4 existing calls; do NOT overwrite the file)
- Modify: `packages/core/src/briefing.ts:25`
- Modify: `eval/src/engine.ts:36`

**Interfaces:**
- Consumes: `'insufficient-evidence'` from Task 1; `Section`, `Claim`, `Evidence`, `Recommendation` (from `@mrsirquanzo/sonny-shared`); `StructuredModel` (from `./model.js`).
- Produces: `synthesizeRecommendation` now takes a required `target: string` in its options object and returns `verdict: 'insufficient-evidence'` (with empty `bull`/`bear`/`conditions`) when `sections` carry fewer than 2 supported claims, without calling the model.

**IMPORTANT - existing tests interact with the new gate.** `synthesize.test.ts` already has four tests. Three use minimal fixtures with 0-1 supported claims to exercise citation-cleaning and the severe-developability override; under the new `< 2` gate they would abstain and never reach that code. Step 5 updates them (add `target`, and bump each to >= 2 supported claims so they still reach the normal path they test). This is fixture maintenance, not a change to what those tests assert.

- [ ] **Step 1: Append the new abstention tests**

Append this describe block to the existing `packages/core/src/synthesize.test.ts` (the file already imports `describe, it, expect` from vitest; add `vi` to that import):

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { Section, Evidence } from '@mrsirquanzo/sonny-shared';
import { synthesizeRecommendation } from './synthesize.js';

function section(id: string, claimCount: number): Section {
  return {
    id, title: id, takeaway: 't',
    claims: Array.from({ length: claimCount }, (_, i) => ({
      id: `${id}-c${i}`, text: 'a finding', citations: ['PMID:1'], confidence: 0.9,
    })),
    sources: [], rag: claimCount ? 'amber' : 'red',
  };
}

const evidence: Evidence[] = [{
  id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: 's',
  url: 'u', raw: {}, retrievedAt: 'now',
}];

const draft = {
  verdict: 'watch', thesis: 'th',
  bull: [{ point: 'b', citations: ['PMID:1'] }],
  bear: [{ point: 'x', citations: [] }],
  conditions: [], executiveRead: 'exec',
};

describe('synthesizeRecommendation abstention gate', () => {
  it('abstains on zero supported claims and never calls the model', async () => {
    const gen = vi.fn();
    const { recommendation, executiveRead } = await synthesizeRecommendation({
      target: 'ZXQR7', sections: [section('a', 0), section('b', 0)],
      weighing: { takeaway: '', claims: [] }, evidence: [], model: { generateStructured: gen } as any,
    });
    expect(recommendation.verdict).toBe('insufficient-evidence');
    expect(recommendation.bull).toEqual([]);
    expect(recommendation.bear).toEqual([]);
    expect(recommendation.conditions).toEqual([]);
    expect(recommendation.thesis).toContain('ZXQR7');
    expect(executiveRead).toContain('ZXQR7');
    expect(gen).not.toHaveBeenCalled();
  });

  it('abstains on exactly one supported claim (the single-finding gap)', async () => {
    const gen = vi.fn();
    const { recommendation } = await synthesizeRecommendation({
      target: 'FOO', sections: [section('a', 1), section('b', 0)],
      weighing: { takeaway: '', claims: [] }, evidence, model: { generateStructured: gen } as any,
    });
    expect(recommendation.verdict).toBe('insufficient-evidence');
    expect(gen).not.toHaveBeenCalled();
  });

  it('takes the normal path with two or more supported claims', async () => {
    const gen = vi.fn().mockResolvedValue(draft);
    const { recommendation } = await synthesizeRecommendation({
      target: 'EGFR', sections: [section('a', 2)],
      weighing: { takeaway: '', claims: [] }, evidence, model: { generateStructured: gen } as any,
    });
    expect(gen).toHaveBeenCalledOnce();
    expect(recommendation.verdict).toBe('watch');
    expect(recommendation.bull).toEqual([{ point: 'b', citations: ['PMID:1'] }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/synthesize.test.ts`
Expected: FAIL (the current signature has no `target`, and there is no abstention short-circuit, so the zero/one-claim cases call the model / do not return `insufficient-evidence`).

- [ ] **Step 3: Add `target` and the abstention short-circuit**

In `packages/core/src/synthesize.ts`, change the function signature and add the gate at the top of the body. The signature block becomes:

```typescript
export async function synthesizeRecommendation(opts: {
  target: string; sections: Section[]; weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[]; model: StructuredModel;
}): Promise<{ recommendation: Recommendation; executiveRead: string }> {
  const { target, sections, weighing, evidence, model } = opts;

  // Abstention gate (deterministic, no model call). Section.claims is the
  // supported-only subset, so this counts grounded findings. Fewer than two
  // means there is nothing to weigh into a two-sided bull-and-bear.
  const supportedCount = sections.reduce((n, s) => n + s.claims.length, 0);
  if (supportedCount < 2) {
    const recommendation: Recommendation = {
      verdict: 'insufficient-evidence',
      thesis: `Insufficient verified evidence to assess ${target}.`,
      bull: [], bear: [], conditions: [],
    };
    return {
      recommendation,
      executiveRead: `Fewer than two verified findings support an assessment of ${target}; the dossier abstains rather than synthesize an unsupported recommendation.`,
    };
  }

  const digest = sections.map((s) => `## ${s.title} [${s.rag}]\n${s.takeaway}\n${claimLines(s.claims)}`).join('\n\n')
```

(The `const digest = ...` line and everything after it are unchanged - the gate is inserted between the destructure and the existing `digest` construction.)

- [ ] **Step 4: Update the four existing tests so they reach the normal path**

The gate now requires `target` and abstains below 2 supported claims, so update the pre-existing tests in `synthesize.test.ts`:

1. **Top-level `sections` const** (used by test "produces a recommendation from verified claims..."): add a second supported claim so the count is 2:

```typescript
const sections: Section[] = [
  { id: 'moa_pathway', title: 'MOA & Pathway', takeaway: 'Strong mechanism.',
    claims: [
      { id: 'c1', text: 'Drives EMT.', citations: ['PMID:1'], confidence: 0.8 },
      { id: 'c2', text: 'Promotes invasion.', citations: ['PMID:1'], confidence: 0.8 },
    ], sources: ['PMID:1'], rag: 'green' },
];
```

2. **Test "produces a recommendation..."** - add `target` to its call:

```typescript
    const { recommendation, executiveRead } = await synthesizeRecommendation({ target: 'CDCP1', sections, weighing, evidence, model });
```

3. **Test "passes moderate/high audit caveats..."** - its local `sections` already has 2 claims; only add `target`:

```typescript
    await synthesizeRecommendation({
      target: 'FOO', sections: sections as never, weighing: { takeaway: '', claims: [] },
      evidence: [{ id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
      model,
    });
```

4. **Test "forces NO-GO when any section carries a severe developability risk..."** - give the `target_biology` section 2 supported claims (so it reaches the normal path where the severe override applies) and add `target`:

```typescript
    const sections = [
      { id: 'target_biology', title: 'Target Biology', takeaway: 'great', rag: 'green', sources: ['PMID:1'], claims: [
        { id: 'b1', text: 'Expressed in tumor.', citations: ['PMID:1'], confidence: 0.9 },
        { id: 'b2', text: 'Correlates with stage.', citations: ['PMID:1'], confidence: 0.9 },
      ] },
      { id: 'modality_developability', title: 'Modality & Developability', takeaway: 'tough', rag: 'red', sources: ['PMID:9'], claims: [],
        developabilityRisks: [{ evidenceId: 'PMID:9', category: 'immunogenicity', severity: 'severe', explanation: 'High ADA incidence.' }] },
    ];
    const { recommendation } = await synthesizeRecommendation({
      target: 'HARD', sections: sections as never, weighing: { takeaway: '', claims: [] },
      evidence: [{ id: 'PMID:9', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
      model,
    });
```

5. **Test "does not override the verdict for a significant-only developability risk"** - give its lone section 2 supported claims and add `target`:

```typescript
    const sections = [
      { id: 'modality_developability', title: 'M', takeaway: 't', rag: 'amber', sources: ['PMID:9'], claims: [
        { id: 'm1', text: 'Feasible format.', citations: ['PMID:9'], confidence: 0.8 },
        { id: 'm2', text: 'Manufacturable.', citations: ['PMID:9'], confidence: 0.8 },
      ], developabilityRisks: [{ evidenceId: 'PMID:9', category: 'half_life', severity: 'significant', explanation: 'Short half-life.' }] },
    ];
    const { recommendation } = await synthesizeRecommendation({
      target: 'FOO', sections: sections as never, weighing: { takeaway: '', claims: [] },
      evidence: [{ id: 'PMID:9', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
      model,
    });
```

- [ ] **Step 5: Run the synthesize test file to verify it passes**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/synthesize.test.ts`
Expected: PASS (the 3 new abstention tests + the 4 updated existing tests = 7 tests).

- [ ] **Step 6: Update the `briefing.ts` call site**

In `packages/core/src/briefing.ts`, the `synthesizeRecommendation` call (around line 25) currently omits `target`. Add it from the deep-research result:

```typescript
  const { recommendation, executiveRead } = await synthesizeRecommendation({
    target: result.target, sections: result.sections, weighing: result.weighing, evidence: result.evidence, model: opts.leadModel,
  });
```

- [ ] **Step 7: Update the `eval/src/engine.ts` call site**

In `eval/src/engine.ts`, the `synthesizeRecommendation` call (around line 36) currently omits `target`. Add the `target` already in scope in `runOnce`:

```typescript
    const { recommendation, executiveRead } = await synthesizeRecommendation({
      target, sections: result.sections, weighing: result.weighing, evidence: result.evidence, model: leadModel,
    });
```

- [ ] **Step 8: Type-check both packages**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec tsc --noEmit && pnpm --filter @sonny/eval exec tsc --noEmit`
Expected: no errors (confirms both call sites now satisfy the required `target`).

- [ ] **Step 9: Run the core test suite (no regression)**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run`
Expected: PASS. Any other existing test that called `synthesizeRecommendation` without `target` would fail to compile; the type-check in Step 8 flags it, and adding `target: '<symbol>'` fixes it.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/synthesize.ts packages/core/src/synthesize.test.ts packages/core/src/briefing.ts eval/src/engine.ts
git commit -m "feat(core): abstain with insufficient-evidence when fewer than two supported findings"
```

---

## Final verification (whole repo)

- [ ] **Run the exact CI gate**

Run: `pnpm -r build && pnpm -r test`
Expected: build clean, all packages green. This confirms the signature change did not break `apps/*` or `@sonny/eval`, and that the new verdict flows through the string-typed consumers (`briefing.ts` trace emit, `apps/cli` printing) without error.

- [ ] **Deferred (needs `ANTHROPIC_API_KEY`, not a code gate):** a live `deep ZXQR7` run should now yield `verdict: 'insufficient-evidence'`, flipping the Slice 1 `ZXQR7` trap's `verdict_in_band` from known-red to green. This rides along with the Slice 1 baseline capture (Task 8) whenever the key is available.

---

## Self-Review

**Spec coverage:**
- Add `'insufficient-evidence'` to the union - Task 1.
- `supportedCount < 2` deterministic gate, short-circuit before the model - Task 2 Step 3.
- Deterministic abstention Recommendation (empty bull/bear/conditions, target-named thesis) - Task 2 Step 3.
- `target` threaded into `synthesizeRecommendation` + both call sites (`briefing.ts`, `engine.ts`) - Task 2 Steps 3, 6, 7.
- Existing `synthesize.test.ts` tests updated for the new gate (target + >= 2 supported claims) - Task 2 Step 4.
- Normal path and severe-developability override unchanged - Task 2 Step 3 inserts only the gate; the `digest` and everything after are untouched.
- Consumer safety (no exhaustive verdict switch) - verified during design; the whole-repo build in Final Verification is the backstop.
- Unit tests: zero-claim abstain + model-not-called, one-claim abstain, two-claim normal path - Task 2 Step 1.

**Placeholder scan:** No "TBD"/"handle edge cases". Every code step shows the exact code.

**Type consistency:** `synthesizeRecommendation`'s new `target: string` option is used identically in Task 2's test and both call sites. The abstention `Recommendation` shape (`verdict`/`thesis`/`bull`/`bear`/`conditions`) matches `RecommendationSchema`. `Section.claims` counting matches the spec's `supportedCount` definition.

**Note - executiveRead wording refined from the spec:** the spec's draft said "No section produced a verified finding", which is inaccurate for the one-claim case; the plan uses "Fewer than two verified findings support an assessment of ${target}", accurate for both the zero- and one-claim cases. The thesis is unchanged from the spec.
