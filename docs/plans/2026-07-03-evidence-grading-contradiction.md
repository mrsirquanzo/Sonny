# Evidence Grading + Contradiction Detector (Slice 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grade every audited paper with a deterministic GRADE tier that makes cross-thread weighing count stronger evidence more, and flag verified claims that contradict on the same endpoint into the bear case.

**Architecture:** A pure `gradeEvidence()` derives an `EvidenceLevel` from the skeptic audit and attaches it to each `MethodologicalCritique`; `weighing.ts` annotates claim lines with the tier and instructs the lead to weigh higher tiers more. A decorrelated `detectContradictions()` scans verified claims into grounded `ContradictionFlag`s that `runDeepResearch` carries and `synthesize.ts` renders into the bear case.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod, Vitest, pnpm workspaces. Packages: `@mrsirquanzo/sonny-shared`, `@mrsirquanzo/sonny-core`.

## Global Constraints

- **Branch:** `hardening/slice-5-grading-contradiction` (already created off `main`). Spec: `docs/specs/2026-07-03-evidence-grading-contradiction-design.md`.
- **Lineage:** `main` - `@mrsirquanzo/sonny-*`. ESM import specifiers end in `.js`.
- **GRADE order:** `very_low < low < moderate < high`. Base by design: RCT `high`, single-arm `moderate`, observational/post-hoc `low`, preclinical/in-vitro `very_low`. Downgrade one level (each) for: any `high`-biasRisk flag; `>= 2` `moderate` flags; known `sampleSize < 50`. Floor at `very_low`. The `< 50` cutoff is fixed, not tunable.
- **`gradeEvidence` is pure and total** (no model, never throws).
- **`detectContradictions` runs on the decorrelated verifier model, never throws** (model failure -> `[]` + error event), validates both ids against the store, drops unknown/duplicate-id flags, emits a `contradiction` event per surviving flag.
- **Additive, no verdict-logic change:** grading/contradictions inform weighing/synthesis prose only. No new eval metric.
- **TDD:** failing test first, per task. No network - inject the model/store.
- **Test commands:** `pnpm --filter @mrsirquanzo/sonny-<pkg> exec vitest run <path>`; type-check `... exec tsc --noEmit`. Whole repo: `pnpm -r build && pnpm -r test`.

---

## Task 1: Contracts

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `EvidenceLevelSchema`/`EvidenceLevel` (`'high'|'moderate'|'low'|'very_low'`); `MethodologicalCritiqueSchema` gains optional `evidenceLevel`; `ContradictionFlagSchema`/`ContradictionFlag`; `TraceEvent` gains `{ type: 'contradiction'; flag: ContradictionFlag }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/contracts.test.ts` (add the new schema names to the existing `./contracts.js` import):

```typescript
import { EvidenceLevelSchema, MethodologicalCritiqueSchema, ContradictionFlagSchema } from './contracts.js';

describe('grading + contradiction contracts', () => {
  it('EvidenceLevelSchema accepts the four GRADE tiers', () => {
    expect(EvidenceLevelSchema.parse('very_low')).toBe('very_low');
  });

  it('MethodologicalCritique accepts an optional evidenceLevel', () => {
    const c = MethodologicalCritiqueSchema.parse({
      evidenceId: 'PMID:1', studyDesign: 'randomized_controlled', redFlags: [], evidenceLevel: 'high',
    });
    expect(c.evidenceLevel).toBe('high');
    // still valid without it (backward compatible)
    expect(MethodologicalCritiqueSchema.parse({ evidenceId: 'PMID:1', studyDesign: 'observational', redFlags: [] }).evidenceLevel).toBeUndefined();
  });

  it('ContradictionFlagSchema validates a flag', () => {
    const f = ContradictionFlagSchema.parse({ evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:2', endpoint: 'OS', explanation: 'opposite' });
    expect(f.evidenceIdB).toBe('PMID:2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-shared exec vitest run src/contracts.test.ts`
Expected: FAIL (`EvidenceLevelSchema`/`ContradictionFlagSchema` not exported).

- [ ] **Step 3: Add the schemas**

In `packages/shared/src/contracts.ts`, add `EvidenceLevelSchema` immediately BEFORE `MethodologicalCritiqueSchema`:

```typescript
export const EvidenceLevelSchema = z.enum(['high', 'moderate', 'low', 'very_low']);
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>;
```

Add `evidenceLevel` to `MethodologicalCritiqueSchema` (the object gains one optional field):

```typescript
export const MethodologicalCritiqueSchema = z.object({
  evidenceId: z.string().min(1),
  studyDesign: StudyDesignSchema,
  sampleSize: z.number().int().positive().nullable().optional(),
  redFlags: z.array(RedFlagSchema),
  evidenceLevel: EvidenceLevelSchema.optional(),
});
```

Add `ContradictionFlagSchema` after `MethodologicalCritiqueSchema`:

```typescript
export const ContradictionFlagSchema = z.object({
  evidenceIdA: z.string().min(1),
  evidenceIdB: z.string().min(1),
  endpoint: z.string().min(1),
  explanation: z.string().min(1),
});
export type ContradictionFlag = z.infer<typeof ContradictionFlagSchema>;
```

Add the trace-event variant to the `TraceEvent` union (e.g. after the `methodological_critique` variant):

```typescript
  | { type: 'contradiction'; flag: ContradictionFlag }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mrsirquanzo/sonny-shared exec vitest run src/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

```bash
pnpm --filter @mrsirquanzo/sonny-shared exec tsc --noEmit
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): EvidenceLevel + evidenceLevel on critique, ContradictionFlag + trace event"
```

---

## Task 2: `gradeEvidence` + wire into the skeptic audit

**Files:**
- Create: `packages/core/src/critique/grade.ts`
- Test: `packages/core/src/critique/grade.test.ts`
- Modify: `packages/core/src/critique/skepticAudit.ts`

**Interfaces:**
- Consumes: `EvidenceLevel`, `MethodologicalCritique` (Task 1).
- Produces: `gradeEvidence(critique: Pick<MethodologicalCritique, 'studyDesign' | 'sampleSize' | 'redFlags'>): EvidenceLevel`; `runSkepticAudit` now returns a critique whose `evidenceLevel` is that grade.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/critique/grade.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { gradeEvidence } from './grade.js';

const base = { sampleSize: null as number | null, redFlags: [] as { category: 'unblinded'; biasRisk: 'low' | 'moderate' | 'high'; explanation: string }[] };

describe('gradeEvidence', () => {
  it('maps base tiers by study design', () => {
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled' })).toBe('high');
    expect(gradeEvidence({ ...base, studyDesign: 'single_arm' })).toBe('moderate');
    expect(gradeEvidence({ ...base, studyDesign: 'observational' })).toBe('low');
    expect(gradeEvidence({ ...base, studyDesign: 'post_hoc' })).toBe('low');
    expect(gradeEvidence({ ...base, studyDesign: 'preclinical_nhp' })).toBe('very_low');
    expect(gradeEvidence({ ...base, studyDesign: 'in_vitro' })).toBe('very_low');
  });

  it('downgrades one level for a high-biasRisk flag', () => {
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled',
      redFlags: [{ category: 'unblinded', biasRisk: 'high', explanation: 'x' }] })).toBe('moderate');
  });

  it('downgrades for two moderate flags but not one', () => {
    const one = [{ category: 'unblinded' as const, biasRisk: 'moderate' as const, explanation: 'x' }];
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', redFlags: one })).toBe('high');
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', redFlags: [...one, ...one] })).toBe('moderate');
  });

  it('downgrades for a small known sample only', () => {
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', sampleSize: 40 })).toBe('moderate');
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', sampleSize: 60 })).toBe('high');
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', sampleSize: null })).toBe('high');
  });

  it('stacks downgrades and floors at very_low', () => {
    expect(gradeEvidence({ studyDesign: 'randomized_controlled', sampleSize: 10,
      redFlags: [
        { category: 'unblinded', biasRisk: 'high', explanation: 'x' },
        { category: 'p_hacking', biasRisk: 'moderate', explanation: 'y' },
        { category: 'high_dropout', biasRisk: 'moderate', explanation: 'z' },
      ] })).toBe('very_low');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/critique/grade.test.ts`
Expected: FAIL (`grade.js` missing).

- [ ] **Step 3: Write `gradeEvidence`**

Create `packages/core/src/critique/grade.ts`:

```typescript
import type { EvidenceLevel, MethodologicalCritique, StudyDesign } from '@mrsirquanzo/sonny-shared';

const ORDER: EvidenceLevel[] = ['very_low', 'low', 'moderate', 'high'];

const BASE: Record<StudyDesign, EvidenceLevel> = {
  randomized_controlled: 'high',
  single_arm: 'moderate',
  observational: 'low',
  post_hoc: 'low',
  preclinical_nhp: 'very_low',
  in_vitro: 'very_low',
};

// Deterministic GRADE: start from the study design, downgrade for risk-of-bias
// limitations (high-risk flag, >=2 moderate flags, small sample), floored at very_low.
export function gradeEvidence(
  critique: Pick<MethodologicalCritique, 'studyDesign' | 'sampleSize' | 'redFlags'>,
): EvidenceLevel {
  let idx = ORDER.indexOf(BASE[critique.studyDesign]);
  let downgrades = 0;
  if (critique.redFlags.some((f) => f.biasRisk === 'high')) downgrades += 1;
  if (critique.redFlags.filter((f) => f.biasRisk === 'moderate').length >= 2) downgrades += 1;
  if (typeof critique.sampleSize === 'number' && critique.sampleSize < 50) downgrades += 1;
  idx = Math.max(0, idx - downgrades);
  return ORDER[idx];
}
```

- [ ] **Step 4: Run the grade test to verify it passes**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/critique/grade.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the grade into `runSkepticAudit`**

In `packages/core/src/critique/skepticAudit.ts`, import `gradeEvidence` and attach the level to the returned critique. Change the import line and the return:

```typescript
import { gradeEvidence } from './grade.js';
```

```typescript
  return { evidenceId: paper.id, ...audit, evidenceLevel: gradeEvidence(audit) };
```

- [ ] **Step 6: Run the skeptic-audit test and type-check**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/critique/skepticAudit.test.ts && pnpm --filter @mrsirquanzo/sonny-core exec tsc --noEmit`
Expected: PASS and clean. If the existing skeptic-audit test asserts a deep-equal critique object, extend that expectation to include the computed `evidenceLevel` (e.g. `evidenceLevel: 'high'` for an RCT-with-no-flags stub).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/critique/grade.ts packages/core/src/critique/grade.test.ts packages/core/src/critique/skepticAudit.ts
git commit -m "feat(core): deterministic GRADE tier (gradeEvidence) attached by the skeptic audit"
```

---

## Task 3: Surface the grade into cross-thread weighing

**Files:**
- Modify: `packages/core/src/weighing.ts`
- Test: `packages/core/src/weighing.test.ts` (create if absent)

**Interfaces:**
- Consumes: `Section.critiques[].evidenceLevel` (Task 2).
- Produces: `weighAcrossThreads`'s digest annotates each claim line with `(GRADE: <tier>)` (max tier across its cited critiques, else `ungraded`); the system prompt instructs weighing higher tiers more. Signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/weighing.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { Section } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { EvidenceStore } from './evidenceStore.js';
import { weighAcrossThreads } from './weighing.js';

const sections: Section[] = [{
  id: 'a', title: 'A', takeaway: 't', rag: 'amber', sources: ['PMID:1'],
  claims: [
    { id: 'c1', text: 'Strong RCT finding.', citations: ['PMID:1'], confidence: 0.9 },
    { id: 'c2', text: 'Abstract-only finding.', citations: ['PMID:9'], confidence: 0.5 },
  ],
  critiques: [{ evidenceId: 'PMID:1', studyDesign: 'randomized_controlled', redFlags: [], evidenceLevel: 'high' }],
}];

describe('weighAcrossThreads grade annotation', () => {
  it('annotates claim lines with the cited evidence GRADE and instructs weighing it', async () => {
    let prompt = ''; let system = '';
    const model: StructuredModel = {
      async generateStructured(opts) { prompt = opts.prompt; system = opts.system; return { takeaway: 'tk', claims: [] } as never; },
    };
    const store = new EvidenceStore();
    await weighAcrossThreads({ sections, store, leadModel: model, verifierModel: model, emit: () => {} });
    expect(prompt).toContain('(GRADE: high)');       // c1 cites a graded RCT
    expect(prompt).toContain('(GRADE: ungraded)');    // c2 cites an un-audited abstract
    expect(system.toLowerCase()).toContain('grade');  // instruction to weigh by tier
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/weighing.test.ts`
Expected: FAIL (no `(GRADE: ...)` annotation yet).

- [ ] **Step 3: Annotate the digest and extend the prompt**

In `packages/core/src/weighing.ts`, replace the `digest` construction and add a grade helper. The new body from the `digest` line:

```typescript
  const LEVEL_ORDER = ['very_low', 'low', 'moderate', 'high'];
  const gradeById = new Map<string, string>();
  for (const s of sections) for (const cr of s.critiques ?? []) if (cr.evidenceLevel) gradeById.set(cr.evidenceId, cr.evidenceLevel);
  const bestGrade = (citations: string[]): string => {
    let best = -1;
    for (const id of citations) { const g = gradeById.get(id); if (g) best = Math.max(best, LEVEL_ORDER.indexOf(g)); }
    return best < 0 ? 'ungraded' : LEVEL_ORDER[best];
  };
  const claimLine = (c: { text: string; citations: string[] }) =>
    `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')} (GRADE: ${bestGrade(c.citations)})`;
  const digest = sections.map((s) =>
    `## ${s.title} [${s.rag}]\n${s.takeaway}\n${s.claims.map(claimLine).join('\n')}`,
  ).join('\n\n');
```

And append one sentence to the existing `system` string in the `generateStructured` call (after the reconciliation instruction, before "Write a one-line..."):

```
 Each finding is tagged with a GRADE evidence level (high > moderate > low > very_low, or ungraded); when findings of different levels are in tension, weigh the higher-GRADE evidence more heavily.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/weighing.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, run the core suite, commit**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec tsc --noEmit && pnpm --filter @mrsirquanzo/sonny-core exec vitest run`
Expected: clean, all green (the digest shape changed but only adds the annotation).

```bash
git add packages/core/src/weighing.ts packages/core/src/weighing.test.ts
git commit -m "feat(core): weighing annotates claims with GRADE tier and weighs higher tiers more"
```

---

## Task 4: `detectContradictions`

**Files:**
- Create: `packages/core/src/critique/consistency.ts`
- Test: `packages/core/src/critique/consistency.test.ts`

**Interfaces:**
- Consumes: `ContradictionFlag`, `Claim`, `TraceEvent` (Task 1); `EvidenceStore`, `StructuredModel`, `MODEL_ROUTER`.
- Produces: `detectContradictions(opts: { claims: Claim[]; store: EvidenceStore; model: StructuredModel; emit: (e: TraceEvent) => void }): Promise<ContradictionFlag[]>` - decorrelated verifier model; validates both ids against the store; drops unknown/duplicate-id flags; emits a `contradiction` event per surviving flag; `[]` (with an `error` event) on any model failure; `[]` (no call) for `< 2` claims.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/critique/consistency.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { Claim, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import { detectContradictions } from './consistency.js';

function claim(id: string, cite: string): Claim {
  return { id, text: `finding ${id}`, citations: [cite], confidence: 0.8 };
}
function storeWith(...ids: string[]): EvidenceStore {
  const s = new EvidenceStore();
  for (const id of ids) s.register({ id, kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' });
  return s;
}
const claims = [claim('c1', 'PMID:1'), claim('c2', 'PMID:2')];

describe('detectContradictions', () => {
  it('returns valid grounded flags and emits a contradiction event each', async () => {
    const events: TraceEvent[] = [];
    const model: StructuredModel = {
      async generateStructured() {
        return { contradictions: [{ evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:2', endpoint: 'OS', explanation: 'opposite' }] } as never;
      },
    };
    const out = await detectContradictions({ claims, store: storeWith('PMID:1', 'PMID:2'), model, emit: (e) => events.push(e) });
    expect(out).toHaveLength(1);
    expect(events.filter((e) => e.type === 'contradiction')).toHaveLength(1);
  });

  it('drops a flag whose id is not in the store, and a same-id flag', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return { contradictions: [
          { evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:999', endpoint: 'x', explanation: 'y' },
          { evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:1', endpoint: 'x', explanation: 'y' },
        ] } as never;
      },
    };
    const out = await detectContradictions({ claims, store: storeWith('PMID:1', 'PMID:2'), model, emit: () => {} });
    expect(out).toEqual([]);
  });

  it('degrades to [] and emits an error when the model throws', async () => {
    const events: TraceEvent[] = [];
    const model: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    const out = await detectContradictions({ claims, store: storeWith('PMID:1', 'PMID:2'), model, emit: (e) => events.push(e) });
    expect(out).toEqual([]);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('returns [] without calling the model for fewer than two claims', async () => {
    const gen = vi.fn();
    const out = await detectContradictions({ claims: [claim('c1', 'PMID:1')], store: storeWith('PMID:1'), model: { generateStructured: gen } as never, emit: () => {} });
    expect(out).toEqual([]);
    expect(gen).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/critique/consistency.test.ts`
Expected: FAIL (`consistency.js` missing).

- [ ] **Step 3: Write `detectContradictions`**

Create `packages/core/src/critique/consistency.ts`:

```typescript
import { z } from 'zod';
import { ContradictionFlagSchema, type ContradictionFlag, type Claim, type TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import { MODEL_ROUTER } from '../model.js';

const FlagsSchema = z.object({ contradictions: z.array(ContradictionFlagSchema) });

export async function detectContradictions(opts: {
  claims: Claim[]; store: EvidenceStore; model: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<ContradictionFlag[]> {
  const { claims, store, model, emit } = opts;
  if (claims.length < 2) return [];

  const list = claims.map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
  let flags: ContradictionFlag[] = [];
  try {
    const out = await model.generateStructured({
      system: `You are an independent consistency auditor. Given a set of verified findings, identify PAIRS that make directly OPPOSING assertions about the SAME endpoint (for example one says a marker predicts poor prognosis and another says it has no prognostic value). For each genuine contradiction return evidenceIdA and evidenceIdB (the evidence ids the two findings cite, copied verbatim), the endpoint in tension, and a one-line explanation. Flag only real opposition on the same endpoint - not differences in scope, population, or emphasis. Return an empty list if there are none.`,
      prompt: `VERIFIED FINDINGS:\n${list}\n\nReturn contradictions, each with evidenceIdA, evidenceIdB, endpoint, explanation.`,
      schema: FlagsSchema,
      model: MODEL_ROUTER.verifier,
    });
    flags = out.contradictions;
  } catch (err) {
    emit({ type: 'error', message: `contradiction detection failed: ${String(err)}` });
    return [];
  }

  const ids = new Set(store.all().map((e) => e.id));
  const valid = flags.filter((f) => f.evidenceIdA !== f.evidenceIdB && ids.has(f.evidenceIdA) && ids.has(f.evidenceIdB));
  for (const f of valid) emit({ type: 'contradiction', flag: f });
  return valid;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/critique/consistency.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check and commit**

```bash
pnpm --filter @mrsirquanzo/sonny-core exec tsc --noEmit
git add packages/core/src/critique/consistency.ts packages/core/src/critique/consistency.test.ts
git commit -m "feat(core): decorrelated contradiction detector with grounded ContradictionFlags"
```

---

## Task 5: Wire contradictions into `runDeepResearch` and the bear case

**Files:**
- Modify: `packages/core/src/runDeepResearch.ts`
- Modify: `packages/core/src/synthesize.ts`
- Modify: `packages/core/src/briefing.ts`
- Modify: `eval/src/engine.ts`
- Test: `packages/core/src/synthesize.test.ts`

**Interfaces:**
- Consumes: `detectContradictions` (Task 4); `ContradictionFlag` (Task 1).
- Produces: `DeepResearchResult` gains `contradictions: ContradictionFlag[]`; `synthesizeRecommendation` opts gain optional `contradictions?: ContradictionFlag[]` rendered into the digest under `## Contradictions` with a bear-case instruction; `produceBriefing` and the eval `runOnce` pass `result.contradictions` through.

- [ ] **Step 1: Write the failing test (synthesis renders contradictions)**

Append to `packages/core/src/synthesize.test.ts`:

```typescript
import type { ContradictionFlag } from '@mrsirquanzo/sonny-shared';

describe('synthesizeRecommendation contradictions', () => {
  it('renders contradictions into the digest and instructs the bear case', async () => {
    let prompt = ''; let system = '';
    const model = { async generateStructured(o: { prompt: string; system: string }) { prompt = o.prompt; system = o.system;
      return { verdict: 'watch', thesis: 't', bull: [], bear: [], conditions: [], executiveRead: 'e' } as never; } };
    const contradictions: ContradictionFlag[] = [{ evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:2', endpoint: 'OS', explanation: 'opposite OS effect' }];
    await synthesizeRecommendation({
      target: 'EGFR',
      sections: [{ id: 'a', title: 'A', takeaway: 't', rag: 'green', sources: ['PMID:1'],
        claims: [
          { id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 0.9 },
          { id: 'c2', text: 'y', citations: ['PMID:2'], confidence: 0.9 },
        ] }] as never,
      weighing: { takeaway: '', claims: [] },
      evidence: [
        { id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
        { id: 'PMID:2', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
      ] as never,
      model: model as never,
      contradictions,
    });
    expect(prompt).toContain('## Contradictions');
    expect(prompt).toContain('opposite OS effect');
    expect(system.toLowerCase()).toContain('contradiction');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/synthesize.test.ts`
Expected: FAIL (no `## Contradictions` block; opts has no `contradictions`).

- [ ] **Step 3: Render contradictions in `synthesize.ts`**

In `packages/core/src/synthesize.ts`, add `ContradictionFlag` to the `@mrsirquanzo/sonny-shared` import, add `contradictions` to the opts type, add a helper, and extend the digest + system prompt.

Opts type gains one line:

```typescript
  evidence: Evidence[]; model: StructuredModel; contradictions?: ContradictionFlag[];
```

Destructure it (defaulting to empty):

```typescript
  const { target, sections, weighing, evidence, model } = opts;
  const contradictions = opts.contradictions ?? [];
```

Add a helper beside `devLines`:

```typescript
function contradictionLines(flags: { endpoint: string; explanation: string; evidenceIdA: string; evidenceIdB: string }[]): string {
  if (!flags.length) return '';
  return `\n\n## Contradictions\n`
    + flags.map((f) => `- ${f.endpoint}: ${f.explanation} [${f.evidenceIdA}] vs [${f.evidenceIdB}]`).join('\n');
}
```

Append it to the `digest` construction (after `devLines(sections)`):

```typescript
    + devLines(sections)
    + contradictionLines(contradictions);
```

And add one sentence to the existing writer `system` string (after the developability sentence):

```
 If a contradiction between findings is listed, name it in the bear case as an evidence conflict and factor it into the verdict.
```

(The abstention short-circuit is above the digest and unchanged, so an abstaining run ignores contradictions.)

- [ ] **Step 4: Run the synthesize test to verify it passes**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/synthesize.test.ts`
Expected: PASS (the new test plus the existing ones, which do not pass `contradictions` and so render no block).

- [ ] **Step 5: Add contradictions to `runDeepResearch`**

In `packages/core/src/runDeepResearch.ts`: import `detectContradictions` and `type ContradictionFlag`; add `contradictions: ContradictionFlag[]` to the `DeepResearchResult` interface; after the `weighing` block and before the `return`, run the detector; and include it in the returned object.

```typescript
import { detectContradictions } from './critique/consistency.js';
import type { ContradictionFlag } from '@mrsirquanzo/sonny-shared';
```

```typescript
  const contradictions = await detectContradictions({
    claims: finalSections.flatMap((s) => s.claims), store, model: verifierModel, emit,
  });
  return { target, sections: finalSections, weighing, evidence: store.all(), kolCluster, contradictions };
```

(`detectContradictions` self-degrades to `[]`, so no extra try/catch is needed.)

- [ ] **Step 6: Pass contradictions through the two synthesis call sites**

In `packages/core/src/briefing.ts`, the `synthesizeRecommendation` call gains `contradictions: result.contradictions`:

```typescript
  const { recommendation, executiveRead } = await synthesizeRecommendation({
    target: result.target, sections: result.sections, weighing: result.weighing, evidence: result.evidence, model: opts.leadModel,
    contradictions: result.contradictions,
  });
```

In `eval/src/engine.ts`, the `synthesizeRecommendation` call gains the same:

```typescript
    const { recommendation, executiveRead } = await synthesizeRecommendation({
      target, sections: result.sections, weighing: result.weighing, evidence: result.evidence, model: leadModel,
      contradictions: result.contradictions,
    });
```

- [ ] **Step 7: Type-check both packages and run the core suite**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec tsc --noEmit && pnpm --filter @sonny/eval exec tsc --noEmit && pnpm --filter @mrsirquanzo/sonny-core exec vitest run`
Expected: clean; all core tests pass. `DeepResearchResult` now requires `contradictions`; the type-checker flags any construction site that omits it - the only producer is `runDeepResearch` (updated). Existing `synthesize`/`briefing` tests pass (contradictions optional / threaded).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/runDeepResearch.ts packages/core/src/synthesize.ts packages/core/src/synthesize.test.ts packages/core/src/briefing.ts eval/src/engine.ts
git commit -m "feat(core): detect contradictions in runDeepResearch and surface them in the bear case"
```

---

## Final verification (whole repo)

- [ ] **Run the exact CI gate**

Run: `pnpm -r build && pnpm -r test`
Expected: build clean, all packages green. Confirms the contract additions, the grade wiring, the weighing annotation, the detector, and the synthesis wiring integrate without breaking `apps/*` or `@sonny/eval`.

- [ ] **Deferred (needs `ANTHROPIC_API_KEY`, not a code gate):** a live `deep <target>` run should show GRADE tiers in the weighing prompt and, when the literature genuinely conflicts, a `contradiction` trace event and an evidence-conflict line in the bear case. Rides the same live run as the Slice 1 baseline.

---

## Self-Review

**Spec coverage:**
- `EvidenceLevel` + `evidenceLevel` on critique; `ContradictionFlag`; `contradiction` trace event - Task 1.
- Deterministic `gradeEvidence` (base + downgrades + floor) attached by the audit - Task 2.
- Weighting surfaces the max tier per claim + weigh-higher instruction - Task 3.
- Decorrelated `detectContradictions` (id validation, degrade, `< 2` no-op, event) - Task 4.
- `DeepResearchResult.contradictions` + synthesis bear-case rendering + both call sites - Task 5.
- No new eval metric, no verdict-logic change - respected (grading/contradictions only touch weighing/synthesis prose).

**Placeholder scan:** No "TBD"/"handle edge cases"; every code step shows exact code.

**Type consistency:** `gradeEvidence` signature matches its call in Task 2 Step 5 and the `Pick<...>` audit shape. `ContradictionFlag`/`detectContradictions` names match across Tasks 4 and 5. `synthesizeRecommendation`'s new optional `contradictions` matches the two call sites and the test. `DeepResearchResult.contradictions` is produced once (runDeepResearch) and consumed at both call sites.

**Note:** Task 5 makes `DeepResearchResult.contradictions` a required field; the only construction site is `runDeepResearch`, so the type-check in Step 7 is the backstop that no producer omits it.
