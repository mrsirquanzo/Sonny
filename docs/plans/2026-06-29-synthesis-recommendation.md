# Synthesis & Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the multi-section dossier plus cross-thread weighing into a decision artifact - a Briefing that opens with a GO/WATCH/NO-GO recommendation (thesis, bull case, bear case, conditions), an executive read, and a real references bibliography - built strictly on already-verified claims.

**Architecture:** A `synthesizeRecommendation` pass reads ONLY the verifier-supported claims in the sections and the weighing output, asks the lead model for a verdict, thesis, bull/bear cases, conditions, and a short executive read, then filters every bull/bear citation to evidence ids that actually exist in the run. A `produceBriefing` wrapper runs the Lead (`runDeepResearch`), synthesizes the recommendation, and assembles the references from the cited evidence into a `Briefing`. The CLI renders it conclusion-first. The verdict is the analyst's conditioned judgment - it is NOT run through the decorrelated verifier, because a recommendation is an opinion synthesized over facts, not a factual claim to verify. Sub-project 1, slice 3 of the engine spec (`docs/specs/2026-06-28-sonny-deep-research-engine-design.md`).

**Tech Stack:** TypeScript ESM monorepo (pnpm workspaces, Node 20+), Vitest, Zod, `@anthropic-ai/sdk`, `tsx` CLI.

## Global Constraints

- ESM only: every relative import ends in `.js`; every package is `"type": "module"`.
- Package exports are source-first (`exports`/`main` point at `./src`).
- TDD: failing test first, watch it fail, implement minimally, watch it pass, commit.
- Structured output only via `StructuredModel.generateStructured` with a Zod schema; never parse free text with regex.
- The recommendation is built strictly on verifier-`supported` claims: the synthesizer's only input is the claims already present in `result.sections` and `result.weighing.claims` (all of which passed the grounding gate and the verifier in earlier slices). It must not read raw or unverified evidence text.
- Every bull/bear citation must resolve to an evidence id that exists in the run; citations that do not resolve are dropped.
- The `verdict` (`go`/`watch`/`no-go`) is the analyst's judgment and is NOT verified - it carries explicit `conditions`.
- Copy rule: no em dash characters anywhere in code, comments, or output; use a plain hyphen. This includes commit messages and commit subjects (do not reference task numbers in subjects).
- Run one package's tests with `pnpm --filter <pkg> test <name>`; the whole suite with `pnpm -r test`.

---

## File Structure

- `packages/shared/src/contracts.ts` (modify) - add `VerdictLabel`, `CasePoint`, `Recommendation`, `Reference`, `Briefing`, and a `recommendation` `TraceEvent`.
- `packages/core/src/runDeepResearch.ts` (modify) - surface the run's evidence on `DeepResearchResult`.
- `packages/core/src/synthesize.ts` (create) - `synthesizeRecommendation`.
- `packages/core/src/briefing.ts` (create) - `assembleReferences` and `produceBriefing`.
- `packages/core/src/index.ts` (modify) - export the new functions and the `Briefing` type.
- `apps/cli/src/deep.ts` (modify) - render the Briefing conclusion-first.
- `apps/cli/src/run.ts` (modify) - `formatTrace` case for the `recommendation` event.
- Tests alongside each.

---

### Task 1: Briefing contracts

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `VerdictLabel` (`'go'|'watch'|'no-go'`), `CasePoint` (`{ point: string; citations: string[] }`), `Recommendation` (`{ verdict, thesis, bull: CasePoint[], bear: CasePoint[], conditions: string[] }`), `Reference` (`{ id, kind, source, title, url }`), `Briefing` (`{ target, recommendation, executiveRead, sections, weighing, references }`), and a `{ type: 'recommendation'; verdict: string }` trace event.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/contracts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RecommendationSchema, ReferenceSchema, type Briefing, type TraceEvent } from './contracts.js';

describe('briefing contracts', () => {
  it('parses a recommendation and accepts the recommendation trace event', () => {
    const rec = RecommendationSchema.parse({
      verdict: 'watch', thesis: 'Interesting but under-validated.',
      bull: [{ point: 'Tractable surface antigen.', citations: ['ENSG1'] }],
      bear: [{ point: 'Weak human genetics.', citations: ['ENSG1'] }],
      conditions: ['A positive Phase 1 readout would move this to GO.'],
    });
    expect(rec.verdict).toBe('watch');
    const ref = ReferenceSchema.parse({ id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'X', url: 'u' });
    expect(ref.id).toBe('PMID:1');
    const ev: TraceEvent = { type: 'recommendation', verdict: 'watch' };
    expect(ev.type).toBe('recommendation');
    const briefing: Briefing = {
      target: 'CDCP1', recommendation: rec, executiveRead: 'read',
      sections: [], weighing: { takeaway: '', claims: [] }, references: [ref],
    };
    expect(briefing.references).toHaveLength(1);
  });

  it('rejects an invalid verdict', () => {
    expect(() => RecommendationSchema.parse({
      verdict: 'maybe', thesis: 't', bull: [], bear: [], conditions: [],
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/shared test contracts`
Expected: FAIL - the new schemas/types do not exist.

- [ ] **Step 3: Implement**

In `packages/shared/src/contracts.ts`, add after the `Section` definitions:

```ts
export const VerdictLabelSchema = z.enum(['go', 'watch', 'no-go']);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

export const CasePointSchema = z.object({
  point: z.string().min(1),
  citations: z.array(z.string()),
});
export type CasePoint = z.infer<typeof CasePointSchema>;

export const RecommendationSchema = z.object({
  verdict: VerdictLabelSchema,
  thesis: z.string().min(1),
  bull: z.array(CasePointSchema),
  bear: z.array(CasePointSchema),
  conditions: z.array(z.string()),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const ReferenceSchema = z.object({
  id: z.string().min(1),
  kind: EvidenceKindSchema,
  source: z.string(),
  title: z.string(),
  url: z.string(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

export interface Briefing {
  target: string;
  recommendation: Recommendation;
  executiveRead: string;
  sections: Section[];
  weighing: { takeaway: string; claims: Claim[] };
  references: Reference[];
}
```

And add to the `TraceEvent` union:

```ts
  | { type: 'recommendation'; verdict: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/shared test contracts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): briefing contracts - recommendation, reference, briefing, trace event"
```

---

### Task 2: Surface run evidence on the result

**Files:**
- Modify: `packages/core/src/runDeepResearch.ts`
- Modify: `packages/core/src/runDeepResearch.test.ts`

**Interfaces:**
- Consumes: `Evidence` from `@sonny/shared`, `EvidenceStore`.
- Produces: `DeepResearchResult` gains `evidence: Evidence[]` (the full set registered during the run, `store.all()`), so the briefing layer can build references without re-querying.

- [ ] **Step 1: Write the failing test**

Add an assertion to the existing successful-run test in `packages/core/src/runDeepResearch.test.ts` (inside the existing `it(...)` after the result is produced):

```ts
    // the run's evidence is surfaced for the briefing layer (references)
    expect(result.evidence.some((e) => e.id === 'ENSG1')).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test runDeepResearch`
Expected: FAIL - `result.evidence` is undefined.

- [ ] **Step 3: Implement**

In `packages/core/src/runDeepResearch.ts`:

Add `Evidence` to the shared import:

```ts
import type { Claim, Evidence, Section, TraceEvent } from '@sonny/shared';
```

Add `evidence` to the interface:

```ts
export interface DeepResearchResult {
  target: string;
  sections: Section[];
  weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[];
}
```

Change the final return to include it:

```ts
  return { target, sections: finalSections, weighing, evidence: store.all() };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test runDeepResearch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runDeepResearch.ts packages/core/src/runDeepResearch.test.ts
git commit -m "feat(core): surface run evidence on DeepResearchResult for the briefing layer"
```

---

### Task 3: Synthesize the recommendation

**Files:**
- Create: `packages/core/src/synthesize.ts`
- Test: `packages/core/src/synthesize.test.ts`

**Interfaces:**
- Consumes: `Recommendation`, `RecommendationSchema`, `Section`, `Claim`, `Evidence`, `StructuredModel`, `MODEL_ROUTER`.
- Produces: `synthesizeRecommendation(opts: { sections: Section[]; weighing: { takeaway: string; claims: Claim[] }; evidence: Evidence[]; model: StructuredModel }): Promise<{ recommendation: Recommendation; executiveRead: string }>`. Reads ONLY the verified claims; asks the model (on `MODEL_ROUTER.writer`) for the verdict, thesis, bull/bear, conditions, and executive read; then drops any bull/bear citation that is not a real evidence id from the run.

- [ ] **Step 1: Write the failing test**

`packages/core/src/synthesize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Section, Claim, Evidence } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { synthesizeRecommendation } from './synthesize.js';

const sections: Section[] = [
  { id: 'moa_pathway', title: 'MOA & Pathway', takeaway: 'Strong mechanism.',
    claims: [{ id: 'c1', text: 'Drives EMT.', citations: ['PMID:1'], confidence: 0.8 }], sources: ['PMID:1'], rag: 'green' },
];
const weighing = { takeaway: 'Mechanism strong, genetics weak.', claims: [
  { id: 'w1', text: 'Mechanism outweighs weak genetics.', citations: ['PMID:1'], confidence: 0.7 } as Claim,
] };
const evidence: Evidence[] = [
  { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'P', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
];

describe('synthesizeRecommendation', () => {
  it('produces a recommendation from verified claims and drops phantom citations', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return {
          verdict: 'watch', thesis: 'Mechanistically interesting, under-validated.',
          bull: [{ point: 'Strong mechanism.', citations: ['PMID:1', 'PMID:999'] }], // PMID:999 is phantom
          bear: [{ point: 'Weak genetics.', citations: ['PMID:1'] }],
          conditions: ['A positive Phase 1 readout moves to GO.'],
          executiveRead: 'CDCP1 is mechanistically compelling but genetically thin.',
        } as never;
      },
    };
    const { recommendation, executiveRead } = await synthesizeRecommendation({ sections, weighing, evidence, model });
    expect(recommendation.verdict).toBe('watch');
    // phantom citation dropped, real one kept
    expect(recommendation.bull[0].citations).toEqual(['PMID:1']);
    expect(executiveRead).toContain('mechanistically');
    // synthesizer saw the verified claims, not raw evidence text
    expect(prompt).toContain('Drives EMT.');
    expect(prompt).toContain('Mechanism outweighs weak genetics.');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test synthesize`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/synthesize.ts`:

```ts
import { RecommendationSchema, type Recommendation, type Section, type Claim, type Evidence } from '@sonny/shared';
import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

const SynthesisSchema = RecommendationSchema.extend({ executiveRead: z.string().min(1) });

function claimLines(claims: Claim[]): string {
  return claims.map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
}

export async function synthesizeRecommendation(opts: {
  sections: Section[]; weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[]; model: StructuredModel;
}): Promise<{ recommendation: Recommendation; executiveRead: string }> {
  const { sections, weighing, evidence, model } = opts;

  const digest = sections.map((s) => `## ${s.title} [${s.rag}]\n${s.takeaway}\n${claimLines(s.claims)}`).join('\n\n')
    + `\n\n## Cross-thread weighing\n${weighing.takeaway}\n${claimLines(weighing.claims)}`;

  const draft = await model.generateStructured({
    system: `You are the lead scientist writing the recommendation for a target-assessment briefing. Base your judgment ONLY on the verified findings provided - do not introduce facts that are not in them. Decide a verdict: "go" (pursue), "watch" (monitor, not yet), or "no-go" (do not pursue). Write a one-line thesis, a bull case and a bear case (each a list of points, every point citing the evidence id(s) it rests on, copied verbatim from the findings), the conditions that would change the verdict, and a 3-4 sentence executive read (what the target is, why it matters, the core bull, the core bear, the call). The verdict is your conditioned judgment, not a fact.`,
    prompt: `TARGET FINDINGS (verified):\n${digest}\n\nReturn the verdict, thesis, bull, bear, conditions, and executiveRead.`,
    schema: SynthesisSchema,
    model: MODEL_ROUTER.writer,
  });

  const validIds = new Set(evidence.map((e) => e.id));
  const clean = (points: { point: string; citations: string[] }[]) =>
    points.map((p) => ({ point: p.point, citations: p.citations.filter((id) => validIds.has(id)) }));

  const recommendation: Recommendation = {
    verdict: draft.verdict, thesis: draft.thesis,
    bull: clean(draft.bull), bear: clean(draft.bear), conditions: draft.conditions,
  };
  return { recommendation, executiveRead: draft.executiveRead };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test synthesize`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/synthesize.ts packages/core/src/synthesize.test.ts
git commit -m "feat(core): synthesize recommendation from verified claims (verdict, bull/bear, exec read)"
```

---

### Task 4: References and briefing assembly

**Files:**
- Create: `packages/core/src/briefing.ts`
- Test: `packages/core/src/briefing.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `DeepResearchResult`, `runDeepResearch`, `synthesizeRecommendation`, `Briefing`, `Reference`, `Evidence`, `Section`, `Claim`, `Tool`, `StructuredModel`, `ThreadBrief`, `ResearchBudget`.
- Produces:
  - `assembleReferences(result: DeepResearchResult): Reference[]` - the deduplicated evidence cited anywhere in the sections or weighing, resolved against `result.evidence`, sorted by id.
  - `produceBriefing(opts): Promise<Briefing>` where `opts` is `runDeepResearch`'s options plus nothing else - it runs the Lead, synthesizes the recommendation on `opts.leadModel`, emits a `recommendation` event, and assembles the `Briefing`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/briefing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Evidence, Section } from '@sonny/shared';
import { assembleReferences } from './briefing.js';
import type { DeepResearchResult } from './runDeepResearch.js';

describe('assembleReferences', () => {
  it('returns the cited evidence as references, deduped and sorted, ignoring uncited evidence', () => {
    const sections: Section[] = [
      { id: 's1', title: 'S1', takeaway: 't', claims: [
        { id: 'c1', text: 'a', citations: ['PMID:2', 'ENSG1'], confidence: 0.8 },
      ], sources: ['PMID:2', 'ENSG1'], rag: 'green' },
    ];
    const evidence: Evidence[] = [
      { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'T', snippet: '', url: 'u1', raw: {}, retrievedAt: 'now' },
      { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'P', snippet: '', url: 'u2', raw: {}, retrievedAt: 'now' },
      { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'Uncited', snippet: '', url: 'u9', raw: {}, retrievedAt: 'now' },
    ];
    const result: DeepResearchResult = {
      target: 'X', sections, weighing: { takeaway: '', claims: [] }, evidence,
    };
    const refs = assembleReferences(result);
    expect(refs.map((r) => r.id)).toEqual(['ENSG1', 'PMID:2']); // sorted, PMID:9 excluded (uncited)
    expect(refs[0].title).toBe('T');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test briefing`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/briefing.ts`:

```ts
import type { Briefing, Reference, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { StructuredModel } from './model.js';
import type { ThreadBrief, ResearchBudget } from './researcher.js';
import { runDeepResearch, type DeepResearchResult } from './runDeepResearch.js';
import { synthesizeRecommendation } from './synthesize.js';

export function assembleReferences(result: DeepResearchResult): Reference[] {
  const cited = new Set<string>();
  for (const s of result.sections) for (const c of s.claims) for (const id of c.citations) cited.add(id);
  for (const c of result.weighing.claims) for (const id of c.citations) cited.add(id);
  return result.evidence
    .filter((e) => cited.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ id: e.id, kind: e.kind, source: e.source, title: e.title, url: e.url }));
}

export async function produceBriefing(opts: {
  target: string; roster: ThreadBrief[];
  literatureTools: Tool[]; structuredTools: Tool[];
  specialistModel: StructuredModel; verifierModel: StructuredModel; leadModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<Briefing> {
  const result = await runDeepResearch(opts);
  const { recommendation, executiveRead } = await synthesizeRecommendation({
    sections: result.sections, weighing: result.weighing, evidence: result.evidence, model: opts.leadModel,
  });
  opts.emit({ type: 'recommendation', verdict: recommendation.verdict });
  return {
    target: result.target, recommendation, executiveRead,
    sections: result.sections, weighing: result.weighing, references: assembleReferences(result),
  };
}
```

In `packages/core/src/index.ts`, add:

```ts
export { synthesizeRecommendation } from './synthesize.js';
export { assembleReferences, produceBriefing } from './briefing.js';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test briefing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/briefing.ts packages/core/src/briefing.test.ts packages/core/src/index.ts
git commit -m "feat(core): assemble references and produce the briefing"
```

---

### Task 5: CLI renders the briefing

**Files:**
- Modify: `apps/cli/src/deep.ts`
- Modify: `apps/cli/src/run.ts`
- Test: `apps/cli/src/deep.test.ts`

**Interfaces:**
- Consumes: `produceBriefing`, `RESEARCH_ROSTER`, `AnthropicModel`, the four tools, `formatTrace`.
- Produces: `runDeep` runs `produceBriefing` and prints conclusion-first (the verdict and thesis loudest, then executive read, then sections, then bull/bear/conditions, then references); `formatTrace` renders the `recommendation` event.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/deep.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { formatTrace } from './run.js';

describe('formatTrace recommendation event', () => {
  it('renders the recommendation verdict line', () => {
    const events: TraceEvent[] = [{ type: 'recommendation', verdict: 'watch' }];
    const out = formatTrace(events);
    expect(out.toLowerCase()).toContain('recommendation');
    expect(out).toContain('watch');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/cli test deep`
Expected: FAIL - the `recommendation` event falls through to `default` and "recommendation" text is absent.

- [ ] **Step 3: Implement**

In `apps/cli/src/run.ts`, add a case inside the `formatTrace` switch (before `default`):

```ts
      case 'recommendation':
        return `\nLEAD  recommendation: ${e.verdict.toUpperCase()}`;
```

Rewrite `apps/cli/src/deep.ts`:

```ts
import { AnthropicModel, produceBriefing, RESEARCH_ROSTER } from '@sonny/core';
import { europePmcSearchTool, pmcFullTextTool, openTargetsTargetTool, clinicalTrialsTool } from '@sonny/mcp-gateway';
import { formatTrace } from './run.js';

export async function runDeep(target: string): Promise<void> {
  const t = target.trim() || 'CDCP1';
  const briefing = await produceBriefing({
    target: t, roster: RESEARCH_ROSTER,
    literatureTools: [europePmcSearchTool, pmcFullTextTool],
    structuredTools: [openTargetsTargetTool, clinicalTrialsTool],
    specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(), leadModel: new AnthropicModel(),
    emit: (e) => process.stdout.write(formatTrace([e]) + '\n'),
    budget: { maxRounds: 4 },
  });

  const r = briefing.recommendation;
  process.stdout.write(`\n\n=== ${r.verdict.toUpperCase()}: ${r.thesis} ===\n`);
  process.stdout.write(`\n${briefing.executiveRead}\n`);

  for (const s of briefing.sections) {
    process.stdout.write(`\n[${s.rag.toUpperCase()}] ${s.title}\n  ${s.takeaway}\n`);
    for (const c of s.claims) {
      process.stdout.write(`  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}\n`);
    }
  }

  if (briefing.weighing.claims.length) {
    process.stdout.write(`\nCROSS-THREAD WEIGHING\n  ${briefing.weighing.takeaway}\n`);
    for (const c of briefing.weighing.claims) {
      process.stdout.write(`  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}\n`);
    }
  }

  process.stdout.write(`\nBULL CASE\n`);
  for (const p of r.bull) process.stdout.write(`  + ${p.point} ${p.citations.map((id) => `[${id}]`).join(' ')}\n`);
  process.stdout.write(`\nBEAR CASE\n`);
  for (const p of r.bear) process.stdout.write(`  - ${p.point} ${p.citations.map((id) => `[${id}]`).join(' ')}\n`);
  if (r.conditions.length) {
    process.stdout.write(`\nCONDITIONS\n`);
    for (const c of r.conditions) process.stdout.write(`  * ${c}\n`);
  }

  process.stdout.write(`\nREFERENCES (${briefing.references.length})\n`);
  for (const ref of briefing.references) {
    process.stdout.write(`  ${ref.id}  ${ref.title}  ${ref.url}\n`);
  }
}
```

(The `deep` subcommand dispatch already exists in `run.ts`; no change needed there.)

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/cli test deep`
Expected: PASS.

- [ ] **Step 5: Full suite + live smoke**

Run: `pnpm -r test`
Expected: every package green.

Live smoke (manual, needs a valid key with credits):
```bash
ANTHROPIC_API_KEY=… pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1
```
Expected: the full Lead runs, then a conclusion-first briefing - a GO/WATCH/NO-GO verdict and thesis, an executive read, the sections, a bull and bear case with citations, conditions, and a references bibliography.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/deep.ts apps/cli/src/run.ts apps/cli/src/deep.test.ts
git commit -m "feat(cli): render the conclusion-first briefing with recommendation and references"
```

---

## What this plan deliberately does NOT do (next plans)

- **Web glass-box:** the parallel-lane reasoning stream and the fixed evidence drawer (the web app still runs the old `runDossier`).
- **Teaching-narrative section prose:** elevating each section's claim list into flowing narrative (kept out to protect grounding; the sections carry a teaching takeaway + grounded claims already).
- **Patents, BD/valuation, conversation, learning loop, expert-bar eval:** later sub-projects.
- **The slice-1/2 cleanup list:** OA-gate tightening, per-round multi-question fan-out, gap-filler extraction scoping, the duplicate test import.

---

## Self-Review

- **Spec coverage (synthesis/recommendation):** the recommendation with verdict/thesis/bull/bear/conditions (Task 3), the executive read (Task 3), references bibliography (Task 4), the Briefing artifact and conclusion-first rendering (Tasks 4, 5), built strictly on verified claims with phantom citations dropped (Task 3). Web glass-box and teaching-narrative prose are explicitly deferred above.
- **Placeholder scan:** none - every step carries real code and a concrete command with expected result.
- **Type consistency:** `Recommendation`/`CasePoint`/`VerdictLabel`/`Reference`/`Briefing` defined in Task 1 are consumed unchanged in Tasks 3-5; `DeepResearchResult.evidence` added in Task 2 is read by `synthesizeRecommendation` (Task 3) and `assembleReferences` (Task 4); `produceBriefing` (Task 4) consumes `runDeepResearch`'s exact option bag plus calls `synthesizeRecommendation` with the result fields; the `recommendation` trace event declared in Task 1 is emitted in Task 4 and rendered in Task 5.
