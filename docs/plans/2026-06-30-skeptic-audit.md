# Slice 1: The Skeptic's Audit - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a paper is deep-read, an independent (decorrelated) critic audits its study design and reporting for bias risk; the judgment is surfaced in the dossier alongside the finding, never used to drop or penalize it.

**Architecture:** New Zod contracts for the critique; a `runSkepticAudit` module on the verifier-role model; wiring into `runResearcher` (after deep-read) that tags resting claims with red flags; and a `synthesize` writer that weaves moderate/high flags into prose.

**Tech Stack:** TypeScript ESM, Vitest, Zod. Test runners: `pnpm --filter @sonny/shared test`, `pnpm --filter @sonny/core test`, `pnpm --filter @sonny/cli test`.

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Structured output only (Zod); no regex parsing.
- The critic runs on the verifier-role model (decorrelated from the specialist) - non-negotiable.
- A methodological flag never drops a claim and never lowers confidence; the grounding gate is unchanged and orthogonal.
- The critique `evidenceId` is set in code to the audited paper's store id (never by the model) - grounded by construction.
- Bias tiers are `low | moderate | high` only; no `fatal`, no `red/amber`, no dismissive language in schema or prompts.

---

### Task 1: Contracts (`@sonny/shared`)

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces: `BiasRiskSchema`, `RedFlagCategorySchema`, `RedFlagSchema`/`RedFlag`, `StudyDesignSchema`, `MethodologicalCritiqueSchema`/`MethodologicalCritique`; `ClaimSchema.redFlags?`; `SectionSchema.critiques?`; a `methodological_critique` TraceEvent variant.

- [ ] **Step 1: Write the failing tests**

Create or append `packages/shared/src/contracts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MethodologicalCritiqueSchema, RedFlagSchema, ClaimSchema, SectionSchema } from './contracts.js';

describe('MethodologicalCritique schema', () => {
  const valid = {
    evidenceId: 'PMID:1',
    studyDesign: 'single_arm',
    sampleSize: 42,
    redFlags: [{ category: 'surrogate_endpoint', biasRisk: 'high', explanation: 'eGFR is a surrogate.' }],
  };

  it('accepts a valid critique', () => {
    expect(MethodologicalCritiqueSchema.parse(valid)).toEqual(valid);
  });

  it('accepts null sampleSize', () => {
    expect(MethodologicalCritiqueSchema.parse({ ...valid, sampleSize: null }).sampleSize).toBeNull();
  });

  it('rejects an invalid studyDesign', () => {
    expect(() => MethodologicalCritiqueSchema.parse({ ...valid, studyDesign: 'meta_analysis' })).toThrow();
  });

  it('rejects an invalid biasRisk tier (no fatal/red/amber)', () => {
    expect(() => RedFlagSchema.parse({ category: 'unblinded', biasRisk: 'fatal', explanation: 'x' })).toThrow();
    expect(() => RedFlagSchema.parse({ category: 'unblinded', biasRisk: 'red', explanation: 'x' })).toThrow();
  });

  it('rejects an invalid red-flag category', () => {
    expect(() => RedFlagSchema.parse({ category: 'small_n', biasRisk: 'low', explanation: 'x' })).toThrow();
  });

  it('rejects an empty explanation', () => {
    expect(() => RedFlagSchema.parse({ category: 'unblinded', biasRisk: 'low', explanation: '' })).toThrow();
  });
});

describe('Claim and Section carry optional audit data', () => {
  it('Claim accepts optional redFlags', () => {
    const c = { id: 'c1', text: 't', citations: ['PMID:1'], confidence: 0.8,
      redFlags: [{ category: 'high_dropout', biasRisk: 'moderate', explanation: '30% dropout.' }] };
    expect(ClaimSchema.parse(c).redFlags?.[0].category).toBe('high_dropout');
  });

  it('Claim is valid without redFlags', () => {
    expect(ClaimSchema.parse({ id: 'c1', text: 't', citations: [], confidence: 0.5 }).redFlags).toBeUndefined();
  });

  it('Section accepts optional critiques', () => {
    const s = { id: 'a', title: 'A', takeaway: 't', claims: [], sources: [], rag: 'green',
      critiques: [{ evidenceId: 'PMID:1', studyDesign: 'in_vitro', sampleSize: null, redFlags: [] }] };
    expect(SectionSchema.parse(s).critiques?.[0].studyDesign).toBe('in_vitro');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/shared test -- contracts`
Expected: FAIL - the schemas do not exist yet.

- [ ] **Step 3: Add the schemas**

In `packages/shared/src/contracts.ts`, add after the `VerdictSchema` block (before the `TraceEvent` union):

```ts
export const BiasRiskSchema = z.enum(['low', 'moderate', 'high']);
export type BiasRisk = z.infer<typeof BiasRiskSchema>;

export const RedFlagCategorySchema = z.enum([
  'surrogate_endpoint', 'high_dropout', 'p_hacking', 'active_control_mismatch', 'unblinded',
]);
export type RedFlagCategory = z.infer<typeof RedFlagCategorySchema>;

export const RedFlagSchema = z.object({
  category: RedFlagCategorySchema,
  biasRisk: BiasRiskSchema,
  explanation: z.string().min(1),
});
export type RedFlag = z.infer<typeof RedFlagSchema>;

export const StudyDesignSchema = z.enum([
  'randomized_controlled', 'single_arm', 'post_hoc', 'observational', 'preclinical_nhp', 'in_vitro',
]);
export type StudyDesign = z.infer<typeof StudyDesignSchema>;

export const MethodologicalCritiqueSchema = z.object({
  evidenceId: z.string().min(1),
  studyDesign: StudyDesignSchema,
  sampleSize: z.number().int().positive().nullable().optional(),
  redFlags: z.array(RedFlagSchema),
});
export type MethodologicalCritique = z.infer<typeof MethodologicalCritiqueSchema>;
```

Add `redFlags` to `ClaimSchema` (so the whole file's single ClaimSchema gains it):

```ts
export const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  citations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  redFlags: z.array(RedFlagSchema).optional(),
});
```

Add `critiques` to `SectionSchema`:

```ts
export const SectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  takeaway: z.string(),
  claims: z.array(ClaimSchema),
  sources: z.array(z.string()),
  rag: RagRatingSchema,
  critiques: z.array(MethodologicalCritiqueSchema).optional(),
});
```

Add the trace-event variant to the `TraceEvent` union (e.g. after the `gap_filler` line):

```ts
  | { type: 'methodological_critique'; specialist: string; critique: MethodologicalCritique }
```

Note: `RedFlagSchema`/`MethodologicalCritiqueSchema` must be declared before `ClaimSchema`/`SectionSchema`/the `TraceEvent` union reference them. If the existing `ClaimSchema` sits above where you added the new schemas, move the new schema block above `ClaimSchema`. Keep all additions in dependency order.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/shared test`
Expected: PASS - all shared tests green, including the new cases.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): MethodologicalCritique contracts and audit trace event"
```

---

### Task 2: skepticAudit module (`@sonny/core`)

**Files:**
- Create: `packages/core/src/critique/skepticAudit.ts`
- Test: `packages/core/src/critique/skepticAudit.test.ts`

**Interfaces:**
- Consumes: `StudyDesignSchema`, `RedFlagSchema`, `MethodologicalCritique`, `Evidence` from `@sonny/shared`; `StructuredModel`, `MODEL_ROUTER` from `../model.js`.
- Produces: `runSkepticAudit(paper: Evidence, model: StructuredModel): Promise<MethodologicalCritique>`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/critique/skepticAudit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Evidence } from '@sonny/shared';
import type { StructuredModel } from '../model.js';
import { runSkepticAudit } from './skepticAudit.js';

const paper: Evidence = {
  id: 'PMID:1', kind: 'publication', source: 'Europe PMC',
  title: 'A single-arm study of drug X', snippet: '', passage: 'Open-label, single arm, n=42. eGFR improved in a post-hoc subgroup.',
  url: 'u', raw: {}, retrievedAt: 'now',
};

describe('runSkepticAudit', () => {
  it('returns a critique whose evidenceId is the paper id, with the model flags passed through', async () => {
    let system = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        system = opts.system;
        return { studyDesign: 'post_hoc', sampleSize: 42,
          redFlags: [{ category: 'surrogate_endpoint', biasRisk: 'high', explanation: 'eGFR is a surrogate endpoint.' }] } as never;
      },
    };
    const critique = await runSkepticAudit(paper, model);
    expect(critique.evidenceId).toBe('PMID:1');          // id set in code, not by the model
    expect(critique.studyDesign).toBe('post_hoc');
    expect(critique.redFlags[0].biasRisk).toBe('high');
    expect(system.toLowerCase()).toContain('dropout');   // prompt scrutinizes design/reporting
    expect(system.toLowerCase()).toContain('endpoint');
  });

  it('returns an empty redFlags list when the model finds none', async () => {
    const model: StructuredModel = {
      async generateStructured() { return { studyDesign: 'in_vitro', sampleSize: null, redFlags: [] } as never; },
    };
    const critique = await runSkepticAudit(paper, model);
    expect(critique.redFlags).toEqual([]);
    expect(critique.evidenceId).toBe('PMID:1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/core test -- skepticAudit`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement the module**

Create `packages/core/src/critique/skepticAudit.ts`:

```ts
import { z } from 'zod';
import { StudyDesignSchema, RedFlagSchema, type MethodologicalCritique, type Evidence } from '@sonny/shared';
import type { StructuredModel } from '../model.js';
import { MODEL_ROUTER } from '../model.js';

// The model returns the audit body; evidenceId is attached in code so it is always
// the audited paper's real store id (no token, no ship).
const AuditSchema = z.object({
  studyDesign: StudyDesignSchema,
  sampleSize: z.number().int().positive().nullable(),
  redFlags: z.array(RedFlagSchema),
});

export async function runSkepticAudit(paper: Evidence, model: StructuredModel): Promise<MethodologicalCritique> {
  const audit = await model.generateStructured({
    system: `You are an independent methodological reviewer auditing a biomedical study for design and reporting risk. You did NOT run this study. Classify the study design and identify objective methodological risks - do not invalidate or dismiss the work, categorize risk objectively. Consider: surrogate versus hard endpoints, dropout and attrition, post-hoc or subgroup analyses (p-hacking), active-control mismatch, and blinding. Only raise a red flag the passage actually supports. For preclinical or in-vitro work, clinical-trial flags usually do not apply - return an empty list when nothing applies. For each red flag assign biasRisk: low, moderate, or high.`,
    prompt: `STUDY:\n${paper.title}\n${paper.passage ?? paper.snippet}\n\nClassify studyDesign, report sampleSize (or null if not stated), and list any methodological redFlags, each with category, biasRisk, and a one-line explanation.`,
    schema: AuditSchema,
    model: MODEL_ROUTER.verifier,
  });
  return { evidenceId: paper.id, ...audit };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sonny/core test -- skepticAudit`
Expected: PASS - both cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/critique/skepticAudit.ts packages/core/src/critique/skepticAudit.test.ts
git commit -m "feat(core): runSkepticAudit - decorrelated methodological critique"
```

---

### Task 3: Wire the audit into the research loop

**Files:**
- Modify: `packages/core/src/researcher.ts`
- Test: `packages/core/src/researcher.test.ts`
- Modify: `packages/core/src/produceResearchSection.ts`
- Test: `packages/core/src/produceResearchSection.test.ts`
- Modify: `apps/cli/src/run.ts` (formatTrace)

**Interfaces:**
- `runResearcher` opts gain `verifierModel: StructuredModel` (required). `ThreadFindings` gains `critiques: MethodologicalCritique[]`. No other signatures change.

- [ ] **Step 1: Update the failing tests**

In `packages/core/src/researcher.test.ts`:

1. Add to imports:

```ts
import type { MethodologicalCritique } from '@sonny/shared';
```

2. Add a no-op audit model helper near the top (after `modelReturning`):

```ts
// A verifier model that returns an audit with no flags - the decorrelated critic.
const noFlagAudit: StructuredModel = { async generateStructured() { return { studyDesign: 'in_vitro', sampleSize: null, redFlags: [] } as never; } };
```

3. Every existing `runResearcher({ ... })` call in this file must add `verifierModel: noFlagAudit,` to its options (the signature is now required). There are several; add it to each.

4. Append a new integration test inside `describe('runResearcher loop', ...)`:

```ts
it('attaches audit red flags to claims resting on audited evidence without capping confidence', async () => {
  const search = tool('europepmc_search', [
    { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 trial', snippet: '', passage: 'CDCP1', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
  ]);
  const fulltext = tool('pmc_fulltext', [
    { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 results', snippet: '', passage: 'CDCP1 improved a surrogate marker.', locator: 'CDCP1 results', url: 'u', raw: {}, retrievedAt: 'now' },
  ]);
  const verifierModel: StructuredModel = { async generateStructured() {
    return { studyDesign: 'post_hoc', sampleSize: 30,
      redFlags: [{ category: 'surrogate_endpoint', biasRisk: 'high', explanation: 'Surrogate marker.' }] } as never;
  } };
  const replies = [
    { questions: [{ question: 'q', concept: 'trial' }] },                                          // plan
    { claims: [{ id: 'c1', text: 'CDCP1 improved a marker.', citations: ['PMCID:PMC1#sec-0'], confidence: 0.9 }] }, // extract
    { done: true, followups: [], takeaway: 't' },                                                  // reflect
  ];
  let i = 0;
  const model = { async generateStructured() { return replies[i++] as never; } };
  const events: TraceEvent[] = [];

  const findings = await runResearcher({
    brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
    target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
    model, verifierModel, emit: (e) => events.push(e), budget: { maxRounds: 1 },
  });

  const c1 = findings.claims.find((c) => c.id === 'c1')!;
  expect(c1.confidence).toBe(0.9);                                  // NOT capped - data preserved
  expect(c1.redFlags?.[0].category).toBe('surrogate_endpoint');    // context attached
  expect(findings.critiques.some((cr) => cr.evidenceId === 'PMID:1')).toBe(true);
  expect(events.some((e) => e.type === 'methodological_critique')).toBe(true);
});
```

5. Append a resilience test:

```ts
it('does not abort the loop when the skeptic audit throws', async () => {
  const search = tool('europepmc_search', [
    { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 trial', snippet: '', passage: 'CDCP1', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
  ]);
  const fulltext = tool('pmc_fulltext', [
    { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 results', snippet: '', passage: 'CDCP1.', locator: 'r', url: 'u', raw: {}, retrievedAt: 'now' },
  ]);
  const verifierModel: StructuredModel = { async generateStructured() { throw new Error('audit model down'); } };
  const replies = [
    { questions: [{ question: 'q', concept: 'trial' }] },
    { claims: [] },
    { done: true, followups: [], takeaway: 't' },
  ];
  let i = 0;
  const model = { async generateStructured() { return replies[i++] as never; } };
  const findings = await runResearcher({
    brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
    target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
    model, verifierModel, emit: () => {}, budget: { maxRounds: 1 },
  });
  expect(findings.takeaway).toBe('t'); // completed despite the audit failure
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- researcher`
Expected: FAIL - `verifierModel` is not accepted; `findings.critiques` and `claim.redFlags` are undefined; no `methodological_critique` event.

- [ ] **Step 3: Wire `runResearcher`**

In `packages/core/src/researcher.ts`:

1. Add imports:

```ts
import type { MethodologicalCritique } from '@sonny/shared';
import { runSkepticAudit } from './critique/skepticAudit.js';
```

2. Extend `ThreadFindings`:

```ts
export interface ThreadFindings { takeaway: string; claims: Claim[]; openQuestions: string[]; critiques: MethodologicalCritique[] }
```

3. Add `verifierModel` to the opts type and destructuring:

```ts
export async function runResearcher(opts: {
  brief: ThreadBrief; target: string; tools: Tool[]; store: EvidenceStore;
  model: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<ThreadFindings> {
  const { brief, target, tools, store, model, verifierModel, emit, budget } = opts;
```

4. Before the round loop, add the critique accumulators (near `let snowballed = false;`):

```ts
  const critiques: MethodologicalCritique[] = [];
  const audited: { ids: Set<string>; redFlags: MethodologicalCritique['redFlags'] }[] = [];
```

5. Inside the `if (top) { ... }` block, AFTER the `for (const p of passages)` loop and BEFORE the snowball block, run the audit:

```ts
      try {
        const critique = await runSkepticAudit(top, verifierModel);
        critiques.push(critique);
        emit({ type: 'methodological_critique', specialist: brief.id, critique });
        if (critique.redFlags.length) {
          audited.push({ ids: new Set<string>([top.id, ...passages.map((p) => p.id)]), redFlags: critique.redFlags });
        }
      } catch (err) {
        emit({ type: 'error', message: `skeptic audit failed: ${String(err)}` });
      }
```

6. Replace the claim-drafting loop to tag red flags (no cap):

```ts
    const drafted = await extractClaims(item.question, evidenceList, model);
    for (const c of drafted) {
      const flags = audited.filter((a) => c.citations.some((id) => a.ids.has(id))).flatMap((a) => a.redFlags);
      if (flags.length) c.redFlags = flags;
      claims.push(c);
      emit({ type: 'claim_drafted', claim: c });
    }
```

7. Return the critiques:

```ts
  return { takeaway, claims, openQuestions: openQuestions.map((q) => q.question), critiques };
```

- [ ] **Step 4: Wire `produceResearchSection`**

In `packages/core/src/produceResearchSection.ts`:

1. Pass `verifierModel` into `runResearcher`:

```ts
  const findings = await runResearcher({ brief, target, tools, store, model: specialistModel, verifierModel, emit, budget });
```

2. Attach the critiques to the section (in the `section` object literal):

```ts
  const section: Section = {
    id: brief.id, title: brief.title, takeaway: findings.takeaway,
    claims: supported, sources, rag: computeRag(shippable, verdicts),
    critiques: findings.critiques,
  };
```

- [ ] **Step 5: Update produceResearchSection test for the new section field**

In `packages/core/src/produceResearchSection.test.ts`, the existing test passes a fixed `verifierModel` that returns a verdict object; when `runResearcher` calls it for the audit, that object fails `AuditSchema` and the audit is a caught no-op (no critiques). Confirm the existing assertions still hold; add one assertion that the returned section has a `critiques` array (it will be present, possibly empty):

```ts
    expect(Array.isArray(section.critiques)).toBe(true);
```

- [ ] **Step 6: Render the trace event in the CLI**

In `apps/cli/src/run.ts` `formatTrace`, add a case (before the `default`):

```ts
      case 'methodological_critique': {
        const f = e.critique.redFlags;
        return `      ⚖ skeptic [${e.critique.evidenceId}]: ${e.critique.studyDesign}` +
          (f.length ? ` - ${f.map((r) => `${r.biasRisk}:${r.category}`).join('; ')}` : ' - no flags');
      }
```

- [ ] **Step 7: Run the suites to verify they pass**

Run: `pnpm --filter @sonny/core test && pnpm --filter @sonny/cli test`
Expected: PASS - researcher integration + resilience cases green; produceResearchSection green; CLI green.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/researcher.ts packages/core/src/researcher.test.ts packages/core/src/produceResearchSection.ts packages/core/src/produceResearchSection.test.ts apps/cli/src/run.ts
git commit -m "feat(core): run the skeptic audit after deep-read and tag resting claims"
```

---

### Task 4: Surface caveats in the writer (`synthesize.ts`)

**Files:**
- Modify: `packages/core/src/synthesize.ts`
- Test: `packages/core/src/synthesize.test.ts`

**Interfaces:** no signature change. The writer prompt now annotates moderate/high-flag claims and is instructed to weave the caveat into prose.

- [ ] **Step 1: Update the failing test**

In `packages/core/src/synthesize.test.ts`, add a test capturing the writer prompt:

```ts
it('passes moderate/high audit caveats to the writer and instructs surfacing them', async () => {
  let prompt = '';
  let system = '';
  const model: StructuredModel = {
    async generateStructured(opts) {
      prompt = opts.prompt; system = opts.system;
      return { verdict: 'watch', thesis: 't', bull: [], bear: [], conditions: [], executiveRead: 'er' } as never;
    },
  };
  const sections = [{
    id: 'a', title: 'A', takeaway: 'tk', rag: 'amber', sources: ['PMID:1'],
    claims: [
      { id: 'c1', text: 'eGFR improved.', citations: ['PMID:1'], confidence: 0.9,
        redFlags: [{ category: 'surrogate_endpoint', biasRisk: 'high', explanation: 'unpowered post-hoc subgroup' }] },
      { id: 'c2', text: 'Minor effect.', citations: ['PMID:1'], confidence: 0.5,
        redFlags: [{ category: 'unblinded', biasRisk: 'low', explanation: 'open label' }] },
    ],
  }];
  await synthesizeRecommendation({
    sections: sections as never, weighing: { takeaway: '', claims: [] },
    evidence: [{ id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
    model,
  });
  expect(prompt).toContain('unpowered post-hoc subgroup'); // high flag surfaced to the writer
  expect(prompt).not.toContain('open label');              // low flag not surfaced
  expect(system.toLowerCase()).toContain('audit');         // writer instructed to weave the caveat
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/core test -- synthesize`
Expected: FAIL - the prompt does not yet contain the caveat and the system prompt does not mention the audit.

- [ ] **Step 3: Annotate claims and instruct the writer**

In `packages/core/src/synthesize.ts`, replace `claimLines` to append moderate/high audit notes:

```ts
function claimLines(claims: Claim[]): string {
  return claims.map((c) => {
    const cites = c.citations.map((id) => `[${id}]`).join(' ');
    const flags = (c.redFlags ?? []).filter((f) => f.biasRisk === 'moderate' || f.biasRisk === 'high');
    const note = flags.length
      ? ` (AUDIT: ${flags.map((f) => `${f.biasRisk} ${f.category} - ${f.explanation}`).join('; ')})`
      : '';
    return `- ${c.text} ${cites}${note}`;
  }).join('\n');
}
```

In the writer system prompt, add a sentence (append to the existing `system` string, before the closing backtick):

```
 Some findings carry an AUDIT note (a methodological bias risk and explanation). When you cite such a finding, state the finding AND its audit caveat in the same sentence - report what was found, then note the limitation. Never drop a finding because of a methodological flag; surface the context.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sonny/core test -- synthesize`
Expected: PASS - the writer prompt carries the high-flag caveat and the instruction; the low flag is excluded.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/synthesize.ts packages/core/src/synthesize.test.ts
git commit -m "feat(core): writer surfaces moderate/high audit caveats in dossier prose"
```

---

## Notes for the controller

- After all tasks, run `pnpm -r test` before the whole-branch review.
- A free local smoke (`SONNY_BACKEND=ollama pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1`) should show `⚖ skeptic` lines after deep-reads, claims carrying red flags where the design warrants, and (where moderate/high flags exist) the dossier prose stating the finding together with its methodological caveat - never dropping it.
- Out of scope: full-text multi-section audit, probability-of-success scoring, modality-fit, RAG-formula changes.
