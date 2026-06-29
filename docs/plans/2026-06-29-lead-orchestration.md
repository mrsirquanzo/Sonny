# Lead Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-specialist research loop into a Lead-orchestrated research team: seed a shared structured scaffold once, run the full specialist roster in parallel, run a completeness critic that dispatches gap-fillers, and weigh findings across threads - producing a multi-section result.

**Architecture:** A `runDeepResearch` Lead seeds the shared `EvidenceStore` once with structured target-level evidence (Open Targets, ClinicalTrials.gov), dispatches the research-brief roster in parallel through the existing `produceResearchSection` over that shared store, then runs a completeness critic whose flagged gaps are filled by targeted research rounds merged back into their sections, and finally a cross-thread weighing pass that emits grounded reconciliation claims. The synthesis/recommendation artifact (GO/WATCH/NO-GO, bull/bear, teaching narrative) and the web glass-box are later plans. Sub-project 1, slice 2 of the engine spec (`docs/specs/2026-06-28-sonny-deep-research-engine-design.md`).

**Tech Stack:** TypeScript ESM monorepo (pnpm workspaces, Node 20+), Vitest, Zod, `@anthropic-ai/sdk`, `tsx` CLI.

## Global Constraints

- ESM only: every relative import ends in `.js`; every package is `"type": "module"`.
- Package exports are source-first (`exports`/`main` point at `./src`).
- TDD: failing test first, watch it fail, implement minimally, watch it pass, commit.
- Structured output only via `StructuredModel.generateStructured` with a Zod schema; never parse free text or API JSON with regex.
- Grounding gate is absolute: a claim with any unresolved citation never ships; only verifier-`supported` claims appear in any section or in the weighing output.
- The verifier is decorrelated: it runs on `MODEL_ROUTER.verifier` (`claude-sonnet-4-6`); specialists and the Lead run on `MODEL_ROUTER.specialist` (`claude-opus-4-8`).
- The shared `EvidenceStore` is passed to every specialist; `register` is idempotent first-write-wins, so concurrent specialists deduplicate naturally.
- Specialists receive ONLY the literature tools (`europepmc_search`, `pmc_fulltext`); structured tools are called by the Lead, not by specialists.
- Copy rule: no em dash characters anywhere in code, comments, or output; use a plain hyphen. This includes commit messages.
- Run one package's tests with `pnpm --filter <pkg> test <name>`; the whole suite with `pnpm -r test`.

---

## File Structure

- `packages/shared/src/contracts.ts` (modify) - add three Lead `TraceEvent` variants.
- `packages/core/src/researchRoster.ts` (create) - the five research briefs (`RESEARCH_ROSTER: ThreadBrief[]`).
- `packages/core/src/leadSeed.ts` (create) - `seedStructuredEvidence` (one-time Open Targets + trials scaffold).
- `packages/core/src/completeness.ts` (create) - `assessCompleteness` critic and `fillGap` gap-filler.
- `packages/core/src/weighing.ts` (create) - `weighAcrossThreads` cross-thread reconciliation.
- `packages/core/src/runDeepResearch.ts` (create) - the Lead orchestrator tying it together.
- `packages/core/src/index.ts` (modify) - export the new roster, functions, and result type.
- `apps/cli/src/deep.ts` (modify) - run the full Lead and render all sections + weighing.
- `apps/cli/src/run.ts` (modify) - `formatTrace` cases for the new Lead events.
- Tests alongside each new module.

---

### Task 1: Lead trace events

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces three new `TraceEvent` variants:
  - `{ type: 'lead_decompose'; specialists: string[] }`
  - `{ type: 'completeness_verdict'; complete: boolean; gaps: string[] }`
  - `{ type: 'gap_filler'; specialist: string; question: string }`

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/contracts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from './contracts.js';

describe('lead trace events', () => {
  it('accepts lead_decompose, completeness_verdict, gap_filler', () => {
    const events: TraceEvent[] = [
      { type: 'lead_decompose', specialists: ['target_biology', 'moa_pathway'] },
      { type: 'completeness_verdict', complete: false, gaps: ['resistance mechanisms'] },
      { type: 'gap_filler', specialist: 'clinical_landscape', question: 'What are the acquired resistance mechanisms?' },
    ];
    expect(events.map((e) => e.type)).toEqual(['lead_decompose', 'completeness_verdict', 'gap_filler']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/shared test contracts`
Expected: FAIL - TypeScript rejects the unknown variants.

- [ ] **Step 3: Implement**

In `packages/shared/src/contracts.ts`, add to the `TraceEvent` union:

```ts
  | { type: 'lead_decompose'; specialists: string[] }
  | { type: 'completeness_verdict'; complete: boolean; gaps: string[] }
  | { type: 'gap_filler'; specialist: string; question: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/shared test contracts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): lead orchestration trace events (decompose, completeness, gap-filler)"
```

---

### Task 2: Research roster

**Files:**
- Create: `packages/core/src/researchRoster.ts`
- Test: `packages/core/src/researchRoster.test.ts`

**Interfaces:**
- Consumes: `ThreadBrief` from `./researcher.js`.
- Produces: `RESEARCH_ROSTER: ThreadBrief[]` - five briefs with ids `target_biology`, `moa_pathway`, `disease_indications`, `clinical_landscape`, `competitive_ip`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/researchRoster.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RESEARCH_ROSTER } from './researchRoster.js';

describe('RESEARCH_ROSTER', () => {
  it('defines the five scientific research briefs with unique ids and prompts', () => {
    expect(RESEARCH_ROSTER.map((b) => b.id)).toEqual([
      'target_biology', 'moa_pathway', 'disease_indications', 'clinical_landscape', 'competitive_ip',
    ]);
    for (const b of RESEARCH_ROSTER) {
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.objective.length).toBeGreaterThan(0);
      expect(b.promptHint.length).toBeGreaterThan(0);
    }
    expect(new Set(RESEARCH_ROSTER.map((b) => b.id)).size).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test researchRoster`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/researchRoster.ts`:

```ts
import type { ThreadBrief } from './researcher.js';

export const RESEARCH_ROSTER: ThreadBrief[] = [
  {
    id: 'target_biology', title: 'Target Biology',
    objective: 'Characterize what the target is: gene, protein, domain architecture, normal physiology, and expression.',
    promptHint: 'Describe the target structurally and physiologically: gene and protein identity, domain architecture, normal function, tissue and cell-type expression. Build the foundation a non-expert needs.',
  },
  {
    id: 'moa_pathway', title: 'Mechanism of Action & Pathway',
    objective: 'Explain how the target drives disease biology: signaling, pathway, and the mechanistic model an expert holds.',
    promptHint: 'Explain the mechanism of action and the pathway the target sits in: how it signals, what it activates or represses, and how that mechanism connects to disease (e.g. proliferation, invasion, immune evasion).',
  },
  {
    id: 'disease_indications', title: 'Disease & Indications',
    objective: 'Identify where the target is implicated and weigh the most credible indication.',
    promptHint: 'Identify the diseases and indications the target is implicated in. Weigh genetic association against mechanistic and clinical evidence, and name the most credible indication and why. Be honest where validation is weak.',
  },
  {
    id: 'clinical_landscape', title: 'Clinical Landscape',
    objective: 'Map every asset against the target by modality, phase, sponsor, and status.',
    promptHint: 'Map the clinical landscape: every drug or trial against this target, by modality (antibody, small molecule, ADC, cell therapy), phase, sponsor, and status. Cite trial ids and primary reports. This is everything done to date.',
  },
  {
    id: 'competitive_ip', title: 'Competitive & IP Landscape',
    objective: 'Map who is pursuing the target and the surrounding intellectual-property position.',
    promptHint: 'Map the competitive landscape: which companies and academic groups pursue this target, the modalities in play, and the differentiation. Note the patent and exclusivity signals visible in the literature and known drug records.',
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test researchRoster`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/researchRoster.ts packages/core/src/researchRoster.test.ts
git commit -m "feat(core): research-brief roster (five scientific specialist briefs)"
```

---

### Task 3: Lead structured seeding

**Files:**
- Create: `packages/core/src/leadSeed.ts`
- Test: `packages/core/src/leadSeed.test.ts`

**Interfaces:**
- Consumes: `Tool` from `@sonny/mcp-gateway`, `EvidenceStore`, `TraceEvent`.
- Produces: `seedStructuredEvidence(opts: { target: string; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void }): Promise<void>`. Calls each structured tool once with target-level args, registers its evidence into the shared store, and emits `tool_call`/`tool_result`/`evidence_registered`. A tool that throws is reported via an `error` event and does not abort the others.

- [ ] **Step 1: Write the failing test**

`packages/core/src/leadSeed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { seedStructuredEvidence } from './leadSeed.js';

function tool(name: string, recordArgs: Record<string, unknown>[], evidence: object[]): Tool {
  return { name, description: name, async call(args) { recordArgs.push(args); return evidence as never; } };
}

describe('seedStructuredEvidence', () => {
  it('calls open_targets_target with the symbol and clinical_trials_search with the target, seeding the shared store', async () => {
    const otArgs: Record<string, unknown>[] = [];
    const ctArgs: Record<string, unknown>[] = [];
    const ot = tool('open_targets_target', otArgs, [
      { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const ct = tool('clinical_trials_search', ctArgs, [
      { id: 'NCT1', kind: 'trial', source: 'ClinicalTrials.gov', title: 'A trial', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const store = new EvidenceStore();
    const events: TraceEvent[] = [];
    await seedStructuredEvidence({ target: 'CDCP1', tools: [ot, ct], store, emit: (e) => events.push(e) });

    expect(otArgs).toEqual([{ symbol: 'CDCP1' }]);
    expect(ctArgs).toEqual([{ query: 'CDCP1' }]);
    expect(store.has('ENSG1')).toBe(true);
    expect(store.has('NCT1')).toBe(true);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });

  it('reports a failing seed tool as an error event and still seeds the others', async () => {
    const ok = tool('clinical_trials_search', [], [
      { id: 'NCT1', kind: 'trial', source: 'ClinicalTrials.gov', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const bad: Tool = { name: 'open_targets_target', description: 'x', async call() { throw new Error('HTTP 400'); } };
    const store = new EvidenceStore();
    const events: TraceEvent[] = [];
    await seedStructuredEvidence({ target: 'CDCP1', tools: [bad, ok], store, emit: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(store.has('NCT1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test leadSeed`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/leadSeed.ts`:

```ts
import type { TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';

// Target-level argument for each structured seed tool.
function seedArgs(toolName: string, target: string): Record<string, unknown> {
  if (toolName === 'open_targets_target') return { symbol: target };
  return { query: target }; // clinical_trials_search and any other structured lookup
}

export async function seedStructuredEvidence(opts: {
  target: string; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void;
}): Promise<void> {
  const { target, tools, store, emit } = opts;
  await Promise.all(tools.map(async (t) => {
    const args = seedArgs(t.name, target);
    emit({ type: 'tool_call', tool: t.name, args });
    try {
      const evidence = await t.call(args);
      emit({ type: 'tool_result', tool: t.name, count: evidence.length });
      for (const e of evidence) {
        store.register(e);
        emit({ type: 'evidence_registered', id: e.id, title: e.title });
      }
    } catch (err) {
      emit({ type: 'error', message: `seed ${t.name} failed: ${String(err)}` });
    }
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test leadSeed`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/leadSeed.ts packages/core/src/leadSeed.test.ts
git commit -m "feat(core): lead structured seeding (Open Targets + trials scaffold into shared store)"
```

---

### Task 4: Lead orchestrator (parallel dispatch)

**Files:**
- Create: `packages/core/src/runDeepResearch.ts`
- Test: `packages/core/src/runDeepResearch.test.ts`

**Interfaces:**
- Consumes: `RESEARCH_ROSTER`, `seedStructuredEvidence`, `produceResearchSection`, `ThreadBrief`, `ResearchBudget`, `EvidenceStore`, `Section`, `Tool`, `StructuredModel`.
- Produces:
  - `interface DeepResearchResult { target: string; sections: Section[]; weighing: { takeaway: string; claims: Claim[] } }`
  - `runDeepResearch(opts): Promise<DeepResearchResult>` where `opts = { target; roster: ThreadBrief[]; literatureTools: Tool[]; structuredTools: Tool[]; specialistModel; verifierModel; leadModel: StructuredModel; emit; budget: ResearchBudget }`. This task returns `weighing` as an empty placeholder `{ takeaway: '', claims: [] }`; Tasks 6 and 7 fill in gap-filling and weighing.

- [ ] **Step 1: Write the failing test**

`packages/core/src/runDeepResearch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';
import type { ThreadBrief } from './researcher.js';
import { runDeepResearch } from './runDeepResearch.js';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

const roster: ThreadBrief[] = [
  { id: 'a', title: 'A', objective: 'oa', promptHint: 'ha' },
  { id: 'b', title: 'B', objective: 'ob', promptHint: 'hb' },
];

describe('runDeepResearch', () => {
  it('seeds structured evidence once, dispatches every brief over a shared store, and returns one section per brief', async () => {
    const ot = tool('open_targets_target', [
      { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'T', snippet: '', passage: 'tractable', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'P', snippet: '', passage: 'abs', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'Results', snippet: '', passage: 'finding', locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);

    // Two specialists run in PARALLEL, so their plan/extract/reflect calls interleave.
    // Discriminate by the call's system prompt - NOT a positional counter, which would
    // hand one specialist's plan call another specialist's extract reply under Promise.all.
    const specialistModel = { async generateStructured(o: { system: string }) {
      if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q?', searchQuery: 'kw' }] } as never;
      if (o.system.includes('rigorous biomedical')) return { claims: [{ id: 'c1', text: 'A claim citing ENSG1.', citations: ['ENSG1'], confidence: 0.8 }] } as never;
      return { done: true, followups: [], takeaway: 'takeaway' } as never; // reflect
    } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: 'ok' } as never; } };
    const leadModel = { async generateStructured() { return {} as never; } };

    const events: TraceEvent[] = [];
    const result = await runDeepResearch({
      target: 'CDCP1', roster, literatureTools: [search, fulltext], structuredTools: [ot],
      specialistModel, verifierModel, leadModel, emit: (e) => events.push(e), budget: { maxRounds: 1 },
    });

    expect(result.sections.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(events.some((e) => e.type === 'lead_decompose')).toBe(true);
    // structured seed evidence is visible to specialists (claim cites the seeded ENSG1)
    expect(result.sections.every((s) => s.claims.length === 1)).toBe(true);
    expect(result.weighing).toEqual({ takeaway: '', claims: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test runDeepResearch`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/runDeepResearch.ts`:

```ts
import type { Claim, Section, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import type { ThreadBrief, ResearchBudget } from './researcher.js';
import { produceResearchSection } from './produceResearchSection.js';
import { seedStructuredEvidence } from './leadSeed.js';

export interface DeepResearchResult {
  target: string;
  sections: Section[];
  weighing: { takeaway: string; claims: Claim[] };
}

export async function runDeepResearch(opts: {
  target: string; roster: ThreadBrief[];
  literatureTools: Tool[]; structuredTools: Tool[];
  specialistModel: StructuredModel; verifierModel: StructuredModel; leadModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<DeepResearchResult> {
  const { target, roster, literatureTools, structuredTools, specialistModel, verifierModel, emit, budget } = opts;
  const store = new EvidenceStore();

  await seedStructuredEvidence({ target, tools: structuredTools, store, emit });

  emit({ type: 'lead_decompose', specialists: roster.map((b) => b.id) });
  const sections = await Promise.all(roster.map((brief) =>
    produceResearchSection({ brief, target, tools: literatureTools, store, specialistModel, verifierModel, emit, budget }),
  ));

  return { target, sections, weighing: { takeaway: '', claims: [] } };
}
```

Add to `packages/core/src/index.ts`:

```ts
export { RESEARCH_ROSTER } from './researchRoster.js';
export { seedStructuredEvidence } from './leadSeed.js';
export { runDeepResearch, type DeepResearchResult } from './runDeepResearch.js';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test runDeepResearch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runDeepResearch.ts packages/core/src/runDeepResearch.test.ts packages/core/src/index.ts
git commit -m "feat(core): runDeepResearch - seed once, dispatch roster in parallel over shared store"
```

---

### Task 5: Completeness critic

**Files:**
- Create: `packages/core/src/completeness.ts`
- Test: `packages/core/src/completeness.test.ts`

**Interfaces:**
- Consumes: `Section`, `StructuredModel`, `MODEL_ROUTER`.
- Produces:
  - `interface ResearchGap { specialistId: string; question: string; searchQuery: string; reason: string }`
  - `assessCompleteness(sections: Section[], model: StructuredModel): Promise<{ complete: boolean; gaps: ResearchGap[] }>` - the critic reasons over each section's title, RAG, and takeaway, and returns up to 5 gaps, each tagged to an existing section id with a keyword search query.

- [ ] **Step 1: Write the failing test**

`packages/core/src/completeness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Section } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { assessCompleteness } from './completeness.js';

const sections: Section[] = [
  { id: 'target_biology', title: 'Target Biology', takeaway: 'Solid.', claims: [], sources: ['ENSG1', 'PMID:1'], rag: 'green' },
  { id: 'clinical_landscape', title: 'Clinical Landscape', takeaway: 'Thin.', claims: [], sources: [], rag: 'red' },
];

describe('assessCompleteness', () => {
  it('returns the critic verdict and includes the section summaries in the prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return { complete: false, gaps: [
          { specialistId: 'clinical_landscape', question: 'What trials exist?', searchQuery: 'CDCP1 clinical trial', reason: 'section is red' },
        ] } as never;
      },
    };
    const out = await assessCompleteness(sections, model);
    expect(out.complete).toBe(false);
    expect(out.gaps[0].specialistId).toBe('clinical_landscape');
    expect(prompt).toContain('Clinical Landscape');
    expect(prompt).toContain('red');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test completeness`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/completeness.ts`:

```ts
import { z } from 'zod';
import type { Section } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

export interface ResearchGap { specialistId: string; question: string; searchQuery: string; reason: string }

const CompletenessSchema = z.object({
  complete: z.boolean(),
  gaps: z.array(z.object({
    specialistId: z.string().min(1),
    question: z.string().min(1),
    searchQuery: z.string().min(1),
    reason: z.string().min(1),
  })).max(5),
});

export async function assessCompleteness(
  sections: Section[], model: StructuredModel,
): Promise<{ complete: boolean; gaps: ResearchGap[] }> {
  const summary = sections.map((s) =>
    `- [${s.rag}] ${s.id} (${s.title}): ${s.takeaway} (${s.claims.length} claims, ${s.sources.length} sources)`,
  ).join('\n');
  return model.generateStructured({
    system: `You are the lead reviewer of a target-assessment dossier. Judge whether the assessment is complete enough for an expert reader. A red or thin section, or an obvious unanswered question (e.g. resistance mechanisms, safety, a missing modality), is a gap. For each gap, name the existing section id it belongs to, a precise follow-up question, a 3-8 keyword searchQuery (no sentences, no punctuation), and the reason. If the dossier is sufficient, set complete=true with no gaps.`,
    prompt: `SECTIONS:\n${summary}\n\nReturn complete and up to 5 gaps, each tagged to one of the section ids above.`,
    schema: CompletenessSchema,
    model: MODEL_ROUTER.specialist,
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test completeness`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/completeness.ts packages/core/src/completeness.test.ts
git commit -m "feat(core): completeness critic - flag thin sections and unanswered questions as gaps"
```

---

### Task 6: Gap-filler and wiring

**Files:**
- Modify: `packages/core/src/completeness.ts`
- Modify: `packages/core/src/runDeepResearch.ts`
- Modify: `packages/core/src/completeness.test.ts`
- Modify: `packages/core/src/runDeepResearch.test.ts`

**Interfaces:**
- Consumes: `ResearchGap`, `Tool`, `EvidenceStore`, `groundClaims`, `verifyClaims`, `computeRag`, `extractClaims`, `Section`, `Verdict`.
- Produces:
  - `fillGap(opts: { gap: ResearchGap; tools: Tool[]; store: EvidenceStore; specialistModel; verifierModel; emit }): Promise<Claim[]>` - one targeted literature round (search the gap's query, read the top open-access hit, extract claims for the gap question), then ground + verify, returning only `supported` claims.
  - `mergeGapClaims(section: Section, newClaims: Claim[]): Section` - appends the new supported claims, unions sources, recomputes RAG treating all kept claims as supported.
  - `runDeepResearch` runs ONE completeness pass: if not complete, fills each gap and merges into the matching section before returning.

- [ ] **Step 1: Write the failing test (fillGap + mergeGapClaims)**

Add to `packages/core/src/completeness.test.ts`:

```ts
import { EvidenceStore } from './evidenceStore.js';
import { fillGap, mergeGapClaims } from './completeness.js';
import type { Tool } from '@sonny/mcp-gateway';
import type { Claim } from '@sonny/shared';

function gapTool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

describe('fillGap', () => {
  it('searches, reads, extracts, grounds, and returns only verifier-supported claims', async () => {
    const search = gapTool('europepmc_search', [
      { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'X', snippet: '', passage: 'abs', url: 'u', raw: { pmcid: 'PMC9', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = gapTool('pmc_fulltext', [
      { id: 'PMCID:PMC9#sec-0', kind: 'publication', source: 'PMC full text', title: 'R', snippet: '', passage: 'resistance via bypass', locator: 'R', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const specialistModel = { async generateStructured() {
      return { claims: [
        { id: 'g1', text: 'Bypass signaling drives resistance.', citations: ['PMCID:PMC9#sec-0'], confidence: 0.7 },
        { id: 'g2', text: 'Unsupported overreach.', citations: ['PMCID:PMC9#sec-0'], confidence: 0.5 },
      ] } as never;
    } };
    let v = 0;
    const verifierModel = { async generateStructured() {
      return [{ claimId: 'x', status: 'supported', rationale: 'ok' }, { claimId: 'x', status: 'unsupported', rationale: 'no' }][v++] as never;
    } };
    const out = await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'How does resistance arise?', searchQuery: 'CDCP1 resistance', reason: 'gap' },
      tools: [search, fulltext], store: new EvidenceStore(), specialistModel, verifierModel, emit: () => {},
    });
    expect(out.map((c) => c.id)).toEqual(['g1']); // only the supported claim survives
  });
});

describe('mergeGapClaims', () => {
  it('appends claims, unions sources, and recomputes RAG to green at two distinct sources', () => {
    const section = { id: 'x', title: 'X', takeaway: 't', claims: [
      { id: 'c1', text: 'a', citations: ['PMID:1'], confidence: 0.8 } as Claim,
    ], sources: ['PMID:1'], rag: 'amber' as const };
    const merged = mergeGapClaims(section, [{ id: 'c2', text: 'b', citations: ['PMID:2'], confidence: 0.7 }]);
    expect(merged.claims.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(merged.sources.sort()).toEqual(['PMID:1', 'PMID:2']);
    expect(merged.rag).toBe('green');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test completeness`
Expected: FAIL - `fillGap`/`mergeGapClaims` not exported.

- [ ] **Step 3: Implement in `packages/core/src/completeness.ts`**

Append:

```ts
import type { Claim, Section, TraceEvent, Verdict } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag } from './rag.js';
import { extractClaims } from './researcher.js';

export async function fillGap(opts: {
  gap: ResearchGap; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<Claim[]> {
  const { gap, tools, store, specialistModel, verifierModel, emit } = opts;
  const search = tools.find((t) => t.name === 'europepmc_search');
  const fulltext = tools.find((t) => t.name === 'pmc_fulltext');
  if (!search || !fulltext) throw new Error('fillGap requires europepmc_search and pmc_fulltext tools');

  emit({ type: 'gap_filler', specialist: gap.specialistId, question: gap.question });
  emit({ type: 'tool_call', tool: search.name, args: { query: gap.searchQuery } });
  const hits = await search.call({ query: gap.searchQuery });
  emit({ type: 'tool_result', tool: search.name, count: hits.length });
  for (const h of hits) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }

  const top = hits.find((h) => (h.raw as { pmcid?: string; isOpenAccess?: boolean })?.pmcid && (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
  if (top) {
    const pmcid = (top.raw as { pmcid: string }).pmcid;
    emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
    const passages = await fulltext.call({ pmcid });
    emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
    for (const p of passages) {
      store.register(p);
      emit({ type: 'evidence_registered', id: p.id, title: p.title });
      emit({ type: 'research_read', specialist: gap.specialistId, sourceId: p.id, locator: p.locator ?? p.title });
    }
  }

  const evidenceList = store.all().map((e) => `[${e.id}]${e.locator ? ` (${e.locator})` : ''} ${e.title} - ${e.passage ?? e.snippet}`).join('\n');
  const drafted = await extractClaims(gap.question, evidenceList, specialistModel);
  for (const c of drafted) emit({ type: 'claim_drafted', claim: c });

  const { shippable } = groundClaims(drafted, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const vd of verdicts) emit({ type: 'verdict', verdict: vd });
  return shippable.filter((c) => verdicts.find((vd) => vd.claimId === c.id)?.status === 'supported');
}

export function mergeGapClaims(section: Section, newClaims: Claim[]): Section {
  if (newClaims.length === 0) return section;
  const claims = [...section.claims, ...newClaims];
  const sources = [...new Set(claims.flatMap((c) => c.citations))];
  const verdicts: Verdict[] = claims.map((c) => ({ claimId: c.id, status: 'supported', rationale: '' }));
  return { ...section, claims, sources, rag: computeRag(claims, verdicts) };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test completeness`
Expected: PASS.

- [ ] **Step 5: Wire one completeness pass into `runDeepResearch.ts`**

In `runDeepResearch.ts`, add imports:

```ts
import { assessCompleteness, fillGap, mergeGapClaims } from './completeness.js';
```

Replace the `return` with a completeness pass before returning. After `const sections = await Promise.all(...)`:

```ts
  const { complete, gaps } = await assessCompleteness(sections, opts.leadModel);
  emit({ type: 'completeness_verdict', complete, gaps: gaps.map((g) => g.question) });
  let finalSections = sections;
  if (!complete) {
    for (const gap of gaps) {
      const idx = finalSections.findIndex((s) => s.id === gap.specialistId);
      if (idx === -1) continue;
      const claims = await fillGap({ gap, tools: literatureTools, store, specialistModel, verifierModel, emit });
      finalSections = finalSections.map((s, i) => (i === idx ? mergeGapClaims(s, claims) : s));
    }
  }

  return { target, sections: finalSections, weighing: { takeaway: '', claims: [] } };
```

(Remove the old `return { target, sections, weighing: { takeaway: '', claims: [] } };` line.)

- [ ] **Step 6: Update the Task 4 orchestrator test for the completeness pass**

In `runDeepResearch.test.ts`, the `leadModel` mock must now answer the completeness critic. Change it to:

```ts
    const leadModel = { async generateStructured() { return { complete: true, gaps: [] } as never; } };
```

This keeps the existing assertions valid (complete=true -> no gap-filling, sections unchanged).

- [ ] **Step 7: Run both tests**

Run: `pnpm --filter @sonny/core test completeness runDeepResearch`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/completeness.ts packages/core/src/completeness.test.ts packages/core/src/runDeepResearch.ts packages/core/src/runDeepResearch.test.ts
git commit -m "feat(core): gap-filler - fill flagged gaps with targeted research and merge into sections"
```

---

### Task 7: Cross-thread weighing

**Files:**
- Create: `packages/core/src/weighing.ts`
- Modify: `packages/core/src/runDeepResearch.ts`
- Test: `packages/core/src/weighing.test.ts`
- Modify: `packages/core/src/runDeepResearch.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Section`, `EvidenceStore`, `groundClaims`, `verifyClaims`, `StructuredModel`, `ClaimsSchema`.
- Produces:
  - `weighAcrossThreads(opts: { sections: Section[]; store: EvidenceStore; leadModel; verifierModel; emit }): Promise<{ takeaway: string; claims: Claim[] }>` - the Lead reads every section's takeaway and claims and emits reconciliation claims that name cross-thread tensions (e.g. weak genetics vs strong mechanism). Claims cite existing evidence ids; they are grounded and verified; only `supported` survive.

- [ ] **Step 1: Write the failing test**

`packages/core/src/weighing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Section } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { weighAcrossThreads } from './weighing.js';

const sections: Section[] = [
  { id: 'disease_indications', title: 'Disease & Indications', takeaway: 'Weak genetics.', claims: [
    { id: 'c1', text: 'Genetic association is 0.11.', citations: ['ENSG1'], confidence: 0.7 },
  ], sources: ['ENSG1'], rag: 'amber' },
  { id: 'moa_pathway', title: 'MOA & Pathway', takeaway: 'Strong mechanism.', claims: [
    { id: 'c2', text: 'Drives EMT.', citations: ['PMID:1'], confidence: 0.8 },
  ], sources: ['PMID:1'], rag: 'green' },
];

describe('weighAcrossThreads', () => {
  it('produces grounded, verified reconciliation claims and a takeaway', async () => {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'OT', title: 'T', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' });
    store.register({ id: 'PMID:1', kind: 'publication', source: 'PMC', title: 'P', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' });
    const leadModel = { async generateStructured() {
      return { takeaway: 'Genetics weak but mechanism strong.', claims: [
        { id: 'w1', text: 'The weak genetic association conflicts with strong mechanistic evidence; mechanism leans more credible.', citations: ['ENSG1', 'PMID:1'], confidence: 0.7 },
      ] } as never;
    } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: 'ok' } as never; } };
    const out = await weighAcrossThreads({ sections, store, leadModel, verifierModel, emit: () => {} });
    expect(out.takeaway).toContain('mechanism');
    expect(out.claims.map((c) => c.id)).toEqual(['w1']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test weighing`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/weighing.ts`:

```ts
import { z } from 'zod';
import { ClaimsSchema, type Claim, type Section, type TraceEvent } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';

const WeighSchema = z.object({ takeaway: z.string(), claims: ClaimsSchema.shape.claims });

export async function weighAcrossThreads(opts: {
  sections: Section[]; store: EvidenceStore;
  leadModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<{ takeaway: string; claims: Claim[] }> {
  const { sections, store, leadModel, verifierModel, emit } = opts;
  const digest = sections.map((s) =>
    `## ${s.title} [${s.rag}]\n${s.takeaway}\n${s.claims.map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n')}`,
  ).join('\n\n');

  const draft = await leadModel.generateStructured({
    system: `You are the lead scientist weighing the findings across every thread of a target assessment. Identify the tensions between threads - for example a weak genetic association against strong mechanistic evidence, or a promising mechanism against a thin clinical pipeline. For each tension write a reconciliation claim that names it, states which way the evidence leans, and why. Cite ONLY evidence ids that already appear in the section claims, copied verbatim. Write a one-line cross-thread takeaway.`,
    prompt: `THREAD FINDINGS:\n${digest}\n\nReturn a takeaway and reconciliation claims c1, c2, ... each citing existing evidence ids.`,
    schema: WeighSchema,
    model: MODEL_ROUTER.specialist,
  });

  for (const c of draft.claims) emit({ type: 'claim_drafted', claim: c });
  const { shippable } = groundClaims(draft.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });
  const claims = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  return { takeaway: draft.takeaway, claims };
}
```

In `runDeepResearch.ts`, import and call weighing before the return:

```ts
import { weighAcrossThreads } from './weighing.js';
```

Replace the placeholder weighing in the return:

```ts
  const weighing = await weighAcrossThreads({ sections: finalSections, store, leadModel: opts.leadModel, verifierModel, emit });
  return { target, sections: finalSections, weighing };
```

In `packages/core/src/index.ts`, add:

```ts
export { assessCompleteness, fillGap, mergeGapClaims, type ResearchGap } from './completeness.js';
export { weighAcrossThreads } from './weighing.js';
```

- [ ] **Step 4: Update the orchestrator test for weighing**

In `runDeepResearch.test.ts`, the `leadModel` now answers BOTH the completeness critic and the weighing pass. Make it discriminate on the schema/prompt:

```ts
    const leadModel = { async generateStructured(o: { prompt: string }) {
      if (o.prompt.includes('THREAD FINDINGS')) return { takeaway: '', claims: [] } as never;
      return { complete: true, gaps: [] } as never;
    } };
```

Update the final assertion to allow the weighing object shape (takeaway string, claims array):

```ts
    expect(result.weighing.claims).toEqual([]);
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @sonny/core test weighing runDeepResearch`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/weighing.ts packages/core/src/runDeepResearch.ts packages/core/src/runDeepResearch.test.ts packages/core/src/weighing.test.ts packages/core/src/index.ts
git commit -m "feat(core): cross-thread weighing - grounded reconciliation claims across sections"
```

---

### Task 8: CLI - run the full Lead

**Files:**
- Modify: `apps/cli/src/deep.ts`
- Modify: `apps/cli/src/run.ts`
- Test: `apps/cli/src/deep.test.ts`

**Interfaces:**
- Consumes: `runDeepResearch`, `RESEARCH_ROSTER`, `AnthropicModel`, the four tools, `formatTrace`.
- Produces: `runDeep(target)` runs the full Lead and prints every section plus the cross-thread weighing; `formatTrace` renders the three Lead events.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/deep.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { formatTrace } from './run.js';

describe('formatTrace lead events', () => {
  it('renders decompose, completeness, and gap-filler lines', () => {
    const events: TraceEvent[] = [
      { type: 'lead_decompose', specialists: ['target_biology', 'moa_pathway'] },
      { type: 'completeness_verdict', complete: false, gaps: ['resistance mechanisms'] },
      { type: 'gap_filler', specialist: 'moa_pathway', question: 'How does resistance arise?' },
    ];
    const out = formatTrace(events);
    expect(out).toContain('target_biology');
    expect(out).toContain('gap');
    expect(out).toContain('resistance mechanisms');
    expect(out).toContain('How does resistance arise?');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/cli test deep`
Expected: FAIL - the new events fall through to the `default` case and the asserted text is absent.

- [ ] **Step 3: Implement**

In `apps/cli/src/run.ts`, add cases inside the `formatTrace` switch (before `default`):

```ts
      case 'lead_decompose':
        return `\nLEAD  dispatching: ${e.specialists.join(', ')}`;
      case 'completeness_verdict':
        return `LEAD  completeness: ${e.complete ? 'complete' : 'gaps -> ' + e.gaps.join('; ')}`;
      case 'gap_filler':
        return `  + gap-fill [${e.specialist}]: ${e.question}`;
```

Rewrite `apps/cli/src/deep.ts`:

```ts
import { AnthropicModel, runDeepResearch, RESEARCH_ROSTER, EvidenceStore } from '@sonny/core';
import { europePmcSearchTool, pmcFullTextTool, openTargetsTargetTool, clinicalTrialsTool } from '@sonny/mcp-gateway';
import { formatTrace } from './run.js';

// EvidenceStore is imported to keep the dependency explicit for future callers; the Lead owns its own store.
void EvidenceStore;

export async function runDeep(target: string): Promise<void> {
  const t = target.trim() || 'CDCP1';
  const result = await runDeepResearch({
    target: t, roster: RESEARCH_ROSTER,
    literatureTools: [europePmcSearchTool, pmcFullTextTool],
    structuredTools: [openTargetsTargetTool, clinicalTrialsTool],
    specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(), leadModel: new AnthropicModel(),
    emit: (e) => process.stdout.write(formatTrace([e]) + '\n'),
    budget: { maxRounds: 4 },
  });

  for (const s of result.sections) {
    process.stdout.write(`\n[${s.rag.toUpperCase()}] ${s.title}\n  ${s.takeaway}\n`);
    for (const c of s.claims) {
      process.stdout.write(`  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}\n`);
    }
  }
  if (result.weighing.claims.length) {
    process.stdout.write(`\nCROSS-THREAD WEIGHING\n  ${result.weighing.takeaway}\n`);
    for (const c of result.weighing.claims) {
      process.stdout.write(`  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}\n`);
    }
  }
}
```

(The `deep` subcommand dispatch already exists in `run.ts` from the previous slice; no change needed there.)

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/cli test deep`
Expected: PASS.

- [ ] **Step 5: Full suite + live smoke**

Run: `pnpm -r test`
Expected: every package green.

Live smoke (manual, needs a valid key):
```bash
ANTHROPIC_API_KEY=… pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1
```
Expected: a structured seed (Open Targets + trials), five specialists dispatched, full-text reads, a completeness verdict (possibly gap-fillers), five RAG-rated sections, and a cross-thread weighing block.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/deep.ts apps/cli/src/run.ts apps/cli/src/deep.test.ts
git commit -m "feat(cli): deep command runs the full Lead - roster, completeness, weighing"
```

---

## What this plan deliberately does NOT do (next plans)

- **Synthesis & recommendation:** the GO/WATCH/NO-GO verdict, bull/bear, executive read, and teaching narrative built on top of these sections + weighing.
- **Web glass-box:** the parallel-lane reasoning stream and the fixed evidence drawer (the web app still runs the old `runDossier`).
- **Patents / BD-valuation / conversation / learning loop:** later sub-projects.
- **Per-round multi-question fan-out, citation-weighted source picking, and the OA-gate tightening** noted in the slice-1 cleanup list.

---

## Self-Review

- **Spec coverage (Lead orchestration):** structured scaffold seeded once (Task 3), roster (Task 2), parallel dispatch over shared store (Task 4), completeness critic (Task 5), gap-fillers merged into sections (Task 6), cross-thread weighing (Task 7), Lead trace events + CLI (Tasks 1, 8). Synthesis/recommendation, web, patents are explicitly deferred above.
- **Placeholder scan:** none - every step carries real code and a concrete command with expected result. Task 4 ships an intentional empty `weighing` placeholder that Task 7 replaces; this is called out in both tasks.
- **Type consistency:** `ThreadBrief` (from slice 1) is the roster element and the dispatch unit unchanged; `ResearchGap` defined in Task 5 is consumed by `fillGap`/`runDeepResearch` in Task 6; `DeepResearchResult.weighing` shape (`{ takeaway, claims }`) is fixed in Task 4 and filled by Task 7; the three Lead events declared in Task 1 are emitted in Tasks 4/6 and rendered in Task 8; `produceResearchSection`, `groundClaims`, `verifyClaims`, `computeRag`, `extractClaims` are consumed with their existing signatures.
