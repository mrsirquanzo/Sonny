# Phase 2: Modality & Developability Specialist - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth specialist that assesses developability, and let a severe developability liability force the GO/WATCH/NO-GO verdict to NO-GO.

**Architecture:** A new `DevelopabilityRisk` contract; a sixth roster brief that runs in parallel for free; a decorrelated `assessDevelopability` assessor wired into `runDeepResearch`; and a deterministic NO-GO gate in `synthesize.ts`.

**Tech Stack:** TypeScript ESM, Vitest, Zod. Test runners: `pnpm --filter @sonny/shared test`, `pnpm --filter @sonny/core test`, `pnpm --filter @sonny/cli test`.

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Structured output only (Zod); no regex.
- The developability assessor runs on the verifier-role model (decorrelated); a risk must cite a real store evidence id or it is dropped (no token, no ship).
- Developability severity tiers are `manageable | significant | severe`; `severe` is a hard NO-GO. This is distinct from the methodological `RedFlag` (`low | moderate | high`, never changes the verdict).

---

### Task 1: Contracts (`@sonny/shared`)

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `DevelopabilitySeveritySchema`, `DevelopabilityCategorySchema`, `DevelopabilityRiskSchema`/`DevelopabilityRisk`; `SectionSchema.developabilityRisks?`; a `developability_assessment` TraceEvent variant.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/contracts.test.ts`:

```ts
import { DevelopabilityRiskSchema } from './contracts.js';

describe('DevelopabilityRisk schema', () => {
  const valid = { evidenceId: 'PMID:9', category: 'immunogenicity', severity: 'severe', explanation: 'High ADA incidence.' };

  it('accepts a valid developability risk', () => {
    expect(DevelopabilityRiskSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an invalid severity (no fatal/blocker)', () => {
    expect(() => DevelopabilityRiskSchema.parse({ ...valid, severity: 'fatal' })).toThrow();
    expect(() => DevelopabilityRiskSchema.parse({ ...valid, severity: 'blocker' })).toThrow();
  });

  it('rejects an invalid category', () => {
    expect(() => DevelopabilityRiskSchema.parse({ ...valid, category: 'potency' })).toThrow();
  });

  it('rejects an empty explanation', () => {
    expect(() => DevelopabilityRiskSchema.parse({ ...valid, explanation: '' })).toThrow();
  });

  it('Section accepts optional developabilityRisks', () => {
    const s = { id: 'm', title: 'M', takeaway: 't', claims: [], sources: [], rag: 'red',
      developabilityRisks: [valid] };
    expect(SectionSchema.parse(s).developabilityRisks?.[0].severity).toBe('severe');
  });
});
```

(`SectionSchema` is already imported in this test file from Slice 1; reuse that import.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/shared test -- contracts`
Expected: FAIL - `DevelopabilityRiskSchema` does not exist.

- [ ] **Step 3: Add the schemas**

In `packages/shared/src/contracts.ts`, add the developability schemas next to the methodological-critique schemas, BEFORE `SectionSchema` (which will reference them):

```ts
export const DevelopabilitySeveritySchema = z.enum(['manageable', 'significant', 'severe']);
export type DevelopabilitySeverity = z.infer<typeof DevelopabilitySeveritySchema>;

export const DevelopabilityCategorySchema = z.enum([
  'immunogenicity', 'half_life', 'dosing', 'off_target_toxicity', 'fc_engineering', 'manufacturability',
]);
export type DevelopabilityCategory = z.infer<typeof DevelopabilityCategorySchema>;

export const DevelopabilityRiskSchema = z.object({
  evidenceId: z.string().min(1),
  category: DevelopabilityCategorySchema,
  severity: DevelopabilitySeveritySchema,
  explanation: z.string().min(1),
});
export type DevelopabilityRisk = z.infer<typeof DevelopabilityRiskSchema>;
```

Add `developabilityRisks` to `SectionSchema`:

```ts
  developabilityRisks: z.array(DevelopabilityRiskSchema).optional(),
```

Add the trace-event variant to the `TraceEvent` union (after the `methodological_critique` line):

```ts
  | { type: 'developability_assessment'; risks: DevelopabilityRisk[] }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/shared test`
Expected: PASS - all shared tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): DevelopabilityRisk contract and assessment trace event"
```

---

### Task 2: Sixth specialist (`researchRoster.ts`)

**Files:**
- Modify: `packages/core/src/researchRoster.ts`
- Test: `packages/core/src/researchRoster.test.ts`

- [ ] **Step 1: Update the failing test**

In `packages/core/src/researchRoster.test.ts`:
- Add `'modality_developability'` to the end of the expected id list in the `toEqual([...])` assertion.
- Change `expect(new Set(RESEARCH_ROSTER.map((b) => b.id)).size).toBe(5)` to `.toBe(6)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/core test -- researchRoster`
Expected: FAIL - the roster has 5 briefs.

- [ ] **Step 3: Add the brief**

In `packages/core/src/researchRoster.ts`, append a sixth entry to the `RESEARCH_ROSTER` array (after `competitive_ip`):

```ts
  {
    id: 'modality_developability', title: 'Modality & Developability',
    objective: 'Assess whether the target can actually be drugged: half-life, dosing route, immunogenicity, off-target toxicity, Fc-engineering, and manufacturability.',
    promptHint: 'Assess ONLY the physical and developability constraints of drugging this target, not its disease biology. Cover antibody or protein half-life and dosing route (IV versus subcutaneous), immunogenicity and anti-drug-antibody (ADA) risk, off-target and on-target/off-tumor toxicity, Fc-engineering and format risk, and manufacturability. Where the literature reports a developability liability, state it plainly. Ignore general pathway and disease-mechanism questions - other specialists cover those.',
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sonny/core test -- researchRoster`
Expected: PASS - roster has 6 briefs including `modality_developability`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/researchRoster.ts packages/core/src/researchRoster.test.ts
git commit -m "feat(core): add Modality and Developability specialist to the roster"
```

---

### Task 3: Developability assessor and wire-in

**Files:**
- Create: `packages/core/src/critique/developability.ts`
- Test: `packages/core/src/critique/developability.test.ts`
- Modify: `packages/core/src/runDeepResearch.ts`
- Modify: `apps/cli/src/run.ts` (formatTrace)

Note: the `runDeepResearch` wire-in is a 6-line guarded block fully covered by the assessor unit test (this task) and the synthesize gate test (Task 4); no new `runDeepResearch.test.ts` case is required. Existing `runDeepResearch` tests are unaffected - their rosters contain no `modality_developability` id, so the new block is skipped (`mi === -1`).

**Interfaces:**
- Produces: `assessDevelopability(opts: { section: Section; store: EvidenceStore; model: StructuredModel; emit: (e: TraceEvent) => void }): Promise<DevelopabilityRisk[]>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/critique/developability.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Section, TraceEvent } from '@sonny/shared';
import type { StructuredModel } from '../model.js';
import { EvidenceStore } from '../evidenceStore.js';
import { assessDevelopability } from './developability.js';

function storeWith(id: string): EvidenceStore {
  const store = new EvidenceStore();
  store.register({ id, kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' });
  return store;
}

const section: Section = {
  id: 'modality_developability', title: 'Modality & Developability', takeaway: 't',
  claims: [{ id: 'c1', text: 'High ADA incidence reported.', citations: ['PMID:9'], confidence: 0.8 }],
  sources: ['PMID:9'], rag: 'red',
};

describe('assessDevelopability', () => {
  it('keeps only risks grounded in a real store evidence id and emits the trace', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return { risks: [
          { evidenceId: 'PMID:9', category: 'immunogenicity', severity: 'severe', explanation: 'High ADA incidence.' },
          { evidenceId: 'PMID:404', category: 'half_life', severity: 'significant', explanation: 'Not in store.' },
        ] } as never;
      },
    };
    const events: TraceEvent[] = [];
    const risks = await assessDevelopability({ section, store: storeWith('PMID:9'), model, emit: (e) => events.push(e) });
    expect(risks.map((r) => r.evidenceId)).toEqual(['PMID:9']);           // PMID:404 dropped - no token, no ship
    expect(risks[0].severity).toBe('severe');
    expect(events.some((e) => e.type === 'developability_assessment')).toBe(true);
  });

  it('returns an empty list when the section has no claims', async () => {
    const model: StructuredModel = { async generateStructured() { return { risks: [] } as never; } };
    const risks = await assessDevelopability({ section: { ...section, claims: [] }, store: storeWith('PMID:9'), model, emit: () => {} });
    expect(risks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/core test -- developability`
Expected: FAIL - `assessDevelopability` does not exist.

- [ ] **Step 3: Implement the assessor**

Create `packages/core/src/critique/developability.ts`:

```ts
import { z } from 'zod';
import { DevelopabilityRiskSchema, type DevelopabilityRisk, type Section, type TraceEvent } from '@sonny/shared';
import type { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import { MODEL_ROUTER } from '../model.js';

const AssessSchema = z.object({ risks: z.array(DevelopabilityRiskSchema) });

// Assess the asset's own developability dealbreakers (distinct from methodological bias).
// Decorrelated (verifier model); grounded - a risk citing an unknown evidence id is dropped.
export async function assessDevelopability(opts: {
  section: Section; store: EvidenceStore; model: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<DevelopabilityRisk[]> {
  const { section, store, model, emit } = opts;
  const claimsText = section.claims
    .map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
  if (!claimsText) { emit({ type: 'developability_assessment', risks: [] }); return []; }

  const { risks } = await model.generateStructured({
    system: `You are an independent developability reviewer assessing whether this target can be drugged. From the modality findings, identify concrete developability risks: immunogenicity and anti-drug antibodies, half-life, dosing route, off-target or on-target/off-tumor toxicity, Fc-engineering and format risk, and manufacturability. For each risk cite the evidenceId it rests on (copied verbatim from the findings), classify the category, and rate severity: manageable, significant, or severe. Severe means a developability dealbreaker. Only raise a risk the findings support; return an empty list if none.`,
    prompt: `MODALITY FINDINGS:\n${claimsText}\n\nReturn the developability risks, each with evidenceId, category, severity, and explanation.`,
    schema: AssessSchema,
    model: MODEL_ROUTER.verifier,
  });

  const validIds = new Set(store.all().map((e) => e.id));
  const grounded = risks.filter((r) => validIds.has(r.evidenceId)); // no token, no ship
  emit({ type: 'developability_assessment', risks: grounded });
  return grounded;
}
```

- [ ] **Step 4: Wire into runDeepResearch**

In `packages/core/src/runDeepResearch.ts`:

1. Add the import:

```ts
import { assessDevelopability } from './critique/developability.js';
```

2. After the gap-fill block (where `finalSections` is finalized) and before the weighing block, add:

```ts
  try {
    const mi = finalSections.findIndex((s) => s.id === 'modality_developability');
    if (mi !== -1) {
      const risks = await assessDevelopability({ section: finalSections[mi], store, model: verifierModel, emit });
      finalSections = finalSections.map((s, i) => (i === mi ? { ...s, developabilityRisks: risks } : s));
    }
  } catch (err) {
    emit({ type: 'error', message: `developability assessment failed: ${String(err)}` });
  }
```

- [ ] **Step 5: Render the trace event in the CLI**

In `apps/cli/src/run.ts` `formatTrace`, add a case before `default`:

```ts
      case 'developability_assessment': {
        const r = e.risks.filter((x) => x.severity !== 'manageable');
        return `LEAD  developability: ` + (r.length ? r.map((x) => `${x.severity} ${x.category}`).join('; ') : 'no material risks');
      }
```

- [ ] **Step 6: Run the suites to verify they pass**

Run: `pnpm --filter @sonny/core test && pnpm --filter @sonny/cli test`
Expected: PASS - assessor cases green; existing runDeepResearch tests unaffected; CLI green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/critique/developability.ts packages/core/src/critique/developability.test.ts packages/core/src/runDeepResearch.ts apps/cli/src/run.ts
git commit -m "feat(core): assess developability risks on the modality section, decorrelated and grounded"
```

---

### Task 4: The verdict gate (`synthesize.ts`)

**Files:**
- Modify: `packages/core/src/synthesize.ts`
- Test: `packages/core/src/synthesize.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/synthesize.test.ts`:

```ts
it('forces NO-GO when any section carries a severe developability risk, even on a go draft', async () => {
  let prompt = '';
  const model: StructuredModel = {
    async generateStructured(opts) { prompt = opts.prompt;
      return { verdict: 'go', thesis: 'strong biology', bull: [], bear: [], conditions: [], executiveRead: 'er' } as never; },
  };
  const sections = [
    { id: 'target_biology', title: 'Target Biology', takeaway: 'great', rag: 'green', sources: [], claims: [] },
    { id: 'modality_developability', title: 'Modality & Developability', takeaway: 'tough', rag: 'red', sources: ['PMID:9'], claims: [],
      developabilityRisks: [{ evidenceId: 'PMID:9', category: 'immunogenicity', severity: 'severe', explanation: 'High ADA incidence.' }] },
  ];
  const { recommendation } = await synthesizeRecommendation({
    sections: sections as never, weighing: { takeaway: '', claims: [] },
    evidence: [{ id: 'PMID:9', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
    model,
  });
  expect(recommendation.verdict).toBe('no-go');          // severe developability overrides the go draft
  expect(prompt).toContain('High ADA incidence.');       // risk surfaced to the writer
});

it('does not override the verdict for a significant-only developability risk', async () => {
  const model: StructuredModel = {
    async generateStructured() { return { verdict: 'go', thesis: 't', bull: [], bear: [], conditions: [], executiveRead: 'er' } as never; },
  };
  const sections = [
    { id: 'modality_developability', title: 'M', takeaway: 't', rag: 'amber', sources: ['PMID:9'], claims: [],
      developabilityRisks: [{ evidenceId: 'PMID:9', category: 'half_life', severity: 'significant', explanation: 'Short half-life.' }] },
  ];
  const { recommendation } = await synthesizeRecommendation({
    sections: sections as never, weighing: { takeaway: '', claims: [] },
    evidence: [{ id: 'PMID:9', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
    model,
  });
  expect(recommendation.verdict).toBe('go');             // significant informs but does not override
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- synthesize`
Expected: FAIL - the verdict is not overridden and the risk is not in the prompt.

- [ ] **Step 3: Add the developability digest and the gate**

In `packages/core/src/synthesize.ts`:

1. Add a developability digest helper (next to `claimLines`):

```ts
function devLines(sections: Section[]): string {
  const risks = sections.flatMap((s) => (s.developabilityRisks ?? []).filter((r) => r.severity !== 'manageable'));
  if (!risks.length) return '';
  return `\n\n## Developability risks\n`
    + risks.map((r) => `- ${r.severity} ${r.category} [${r.evidenceId}] - ${r.explanation}`).join('\n');
}
```

2. Append the developability block to the digest:

```ts
  const digest = sections.map((s) => `## ${s.title} [${s.rag}]\n${s.takeaway}\n${claimLines(s.claims)}`).join('\n\n')
    + `\n\n## Cross-thread weighing\n${weighing.takeaway}\n${claimLines(weighing.claims)}`
    + devLines(sections);
```

3. Add the dealbreaker instruction to the writer system prompt (append before the closing backtick):

```
 A severe developability liability is a dealbreaker - if one is present the verdict cannot be "go". Weigh significant developability risks in the bear case.
```

4. After the `draft` is produced, apply the deterministic override when building the recommendation:

```ts
  const severe = sections.some((s) => (s.developabilityRisks ?? []).some((r) => r.severity === 'severe'));
  const recommendation: Recommendation = {
    verdict: severe ? 'no-go' : draft.verdict, thesis: draft.thesis,
    bull: clean(draft.bull), bear: clean(draft.bear), conditions: draft.conditions,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- synthesize`
Expected: PASS - severe forces `no-go`; significant does not override; the risk is in the writer prompt.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/synthesize.ts packages/core/src/synthesize.test.ts
git commit -m "feat(core): severe developability risk forces a NO-GO verdict"
```

---

## Notes for the controller

- After all tasks, run `pnpm -r test` before the whole-branch review.
- A free local smoke (`SONNY_BACKEND=ollama pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1`) should show the `Modality & Developability` specialist running in parallel and a `LEAD developability:` line. On CDCP1 a severe liability may not fire (it is preclinical); the deterministic NO-GO gate is proven by the synthesize tests regardless.
- Out of scope: probability-of-success scoring, translational strategy, a developability-specific tool.
