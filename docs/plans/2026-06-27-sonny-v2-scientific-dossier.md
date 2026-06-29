# Sonny v2 — Scientific Dossier (Depth, Plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the thin single-specialist output into a real, multi-section scientific *target dossier* — six sections (Snapshot, Target Biology, Disease & Indications, Clinical & Translational, Safety & Tox, Competitive Landscape) grounded in the *rich* Open Targets payload + ClinicalTrials.gov + targeted PubMed, each section cited, verified, and RAG-rated, dynamically selected per query.

**Architecture:** Add structured `Section`/dossier contracts to `@sonny/shared`; replace the name-lookup Open Targets tool with a rich target-data tool and add a ClinicalTrials.gov tool in `@sonny/mcp-gateway`; add a specialist registry + per-section production + a multi-specialist `runDossier` orchestrator in `@sonny/core`; render the structured sections (contents rail, RAG dots, per-section sources) in `apps/web` and `apps/cli`. Every external tool is dependency-injected (fake `fetch`) and every model call is injected (fake `StructuredModel`) so the whole thing is unit-testable without network.

**Tech Stack:** TypeScript (ESM), Node 20+, Vitest, Zod, Anthropic SDK (via Plan-1 `StructuredModel`), Open Targets GraphQL, ClinicalTrials.gov v2 REST, PubMed E-utilities.

## Global Constraints

- Language/runtime: TypeScript, ESM, Node 20+; `.js` import extensions.
- Trust rule (unchanged): a factual `Claim` ships only with ≥1 citation that resolves in the evidence store; only `supported`-verdict claims appear in a section; empty tool results register zero evidence.
- Decorrelated verifier (unchanged): verifier model differs from the synthesizer (`MODEL_ROUTER.verifier` = `claude-sonnet-4-6`, specialist = `claude-opus-4-8`).
- Canonical IDs: target `ENSG…`; disease `EFO_…`/`MONDO_…` (Open Targets `disease.id` verbatim); drug `CHEMBL…` (Open Targets `drug.id` verbatim); trial `NCT…`; publication `PMID:…`.
- Tool ergonomics: the gateway normalizes every tool result to a lean canonical `Evidence`; never pass raw provider JSON downstream.
- RAG rating is computed from verdicts + evidence, never asked of the model freehand.
- No key in any client-visible frame, log, or error.
- Testing: Vitest; unit tests inject fakes; no network in CI. Live runs are manual.
- Markdown style for any docs: one sentence per line.
- Commits: conventional, one per task minimum, on the working branch.

---

### Task 1: Section / dossier contracts in `@sonny/shared`

**Files:**
- Modify: `packages/shared/src/contracts.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/section.test.ts`

**Interfaces:**
- Consumes: existing `Claim`, `Verdict`, `EvidenceKind` from this package.
- Produces: `RagRating` (`'green'|'amber'|'red'`), `RagRatingSchema`; `Section` + `SectionSchema` (`{ id, title, takeaway, claims: Claim[], sources: string[], rag: RagRating }`); extended `EvidenceKindSchema` to add `'disease'` and `'drug'`; extended `TraceEvent` union with `{ type:'specialist_start'; specialist:string }`, `{ type:'specialist_skipped'; specialist:string; reason:string }`, `{ type:'section_complete'; section: Section }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/section.test.ts
import { describe, it, expect } from 'vitest';
import { SectionSchema, RagRatingSchema, EvidenceKindSchema } from './contracts.js';

describe('section contracts', () => {
  it('parses a valid section', () => {
    const s = { id: 'target_biology', title: 'Target Biology', takeaway: 'EGFR is tractable.',
      claims: [{ id: 'c1', text: 'x', citations: ['ENSG00000146648'], confidence: 0.9 }],
      sources: ['ENSG00000146648'], rag: 'green' };
    expect(SectionSchema.parse(s).id).toBe('target_biology');
  });
  it('constrains rag to the three ratings', () => {
    expect(() => RagRatingSchema.parse('blue')).toThrow();
    expect(RagRatingSchema.parse('amber')).toBe('amber');
  });
  it('accepts the new disease and drug evidence kinds', () => {
    expect(EvidenceKindSchema.parse('disease')).toBe('disease');
    expect(EvidenceKindSchema.parse('drug')).toBe('drug');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/shared test`
Expected: FAIL — `SectionSchema`/`RagRatingSchema` not exported; `'disease'` rejected.

- [ ] **Step 3: Implement the contract additions**

In `packages/shared/src/contracts.ts`, change the `EvidenceKindSchema` enum line to include the two new kinds, and append the new schemas/types + trace events:

```ts
// REPLACE the existing EvidenceKindSchema line with:
export const EvidenceKindSchema = z.enum(['target', 'publication', 'trial', 'patent', 'dataset', 'disease', 'drug']);
```

```ts
// APPEND to packages/shared/src/contracts.ts
export const RagRatingSchema = z.enum(['green', 'amber', 'red']);
export type RagRating = z.infer<typeof RagRatingSchema>;

export const SectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  takeaway: z.string(),
  claims: z.array(ClaimSchema),
  sources: z.array(z.string()),
  rag: RagRatingSchema,
});
export type Section = z.infer<typeof SectionSchema>;
```

Then extend the `TraceEvent` union (add the three members to the existing union):

```ts
// In the TraceEvent union, add these members:
  | { type: 'specialist_start'; specialist: string }
  | { type: 'specialist_skipped'; specialist: string; reason: string }
  | { type: 'section_complete'; section: Section }
```

`packages/shared/src/index.ts` already does `export * from './contracts.js'`, so no change is needed there; confirm it does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sonny/shared test`
Expected: PASS (existing contract tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared): Section/RagRating contracts + disease/drug evidence kinds + dossier trace events"
```

---

### Task 2: Rich Open Targets target tool

**Files:**
- Create: `packages/mcp-gateway/src/openTargetsTarget.ts`
- Modify: `packages/mcp-gateway/src/index.ts`
- Test: `packages/mcp-gateway/src/openTargetsTarget.test.ts`

**Interfaces:**
- Consumes: `Tool` (`./tool.js`), `Evidence` from `@sonny/shared`.
- Produces: `const openTargetsTargetTool: Tool` (arg `{ symbol: string }`). Resolves the symbol to its `ENSG…` id then fetches the target payload and normalizes to canonical `Evidence[]`: one `kind:'target'` record (the gene), up to 8 `kind:'disease'` records (top associations, each carrying disease name + association score in `snippet`/`raw`, id = the disease ontology id), up to 8 `kind:'drug'` records (known drugs, id = ChEMBL id, snippet carries mechanism/phase), and (folded into the target record's `raw`) tractability + safety liabilities + baseline expression. Empty/unknown symbol → `[]`.

- [ ] **Step 1: Write the failing test (injected fake fetch with a fixture)**

```ts
// packages/mcp-gateway/src/openTargetsTarget.test.ts
import { describe, it, expect } from 'vitest';
import { openTargetsTargetTool } from './openTargetsTarget.js';

const payload = {
  data: { target: {
    id: 'ENSG00000163814', approvedSymbol: 'CDCP1', approvedName: 'CUB domain containing protein 1',
    tractability: [{ modality: 'SM', label: 'Approved Drug', value: false }],
    safetyLiabilities: [{ event: 'cardiotoxicity' }],
    associatedDiseases: { rows: [
      { score: 0.62, disease: { id: 'EFO_0000311', name: 'cancer' } },
      { score: 0.41, disease: { id: 'MONDO_0005233', name: 'non-small cell lung carcinoma' } },
    ] },
    knownDrugs: { rows: [
      { drug: { id: 'CHEMBL1201585', name: 'EXAMPLEMAB' }, mechanismOfAction: 'CDCP1 inhibitor', phase: 1 },
    ] },
  } },
};
const fakeFetch = (async (_url, init) => {
  const body = JSON.parse(String((init as RequestInit).body));
  if (body.query.includes('mapIds') || body.variables?.q) {
    return new Response(JSON.stringify({ data: { search: { hits: [{ id: 'ENSG00000163814', entity: 'target' }] } } }), { status: 200 });
  }
  return new Response(JSON.stringify(payload), { status: 200 });
}) as unknown as typeof fetch;

describe('openTargetsTargetTool', () => {
  it('normalizes target + diseases + drugs to canonical evidence', async () => {
    const out = await openTargetsTargetTool.call({ symbol: 'CDCP1' }, fakeFetch);
    const target = out.find((e) => e.kind === 'target');
    expect(target?.id).toBe('ENSG00000163814');
    expect(out.filter((e) => e.kind === 'disease').map((e) => e.id)).toEqual(['EFO_0000311', 'MONDO_0005233']);
    expect(out.find((e) => e.kind === 'drug')?.id).toBe('CHEMBL1201585');
    // safety/tractability folded into the target record raw
    expect((target?.raw as { safetyLiabilities?: unknown[] }).safetyLiabilities).toHaveLength(1);
  });

  it('returns [] for an unresolved symbol', async () => {
    const empty = (async () => new Response(JSON.stringify({ data: { search: { hits: [] } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await openTargetsTargetTool.call({ symbol: 'ZZZ' }, empty)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: FAIL — `Cannot find module './openTargetsTarget.js'`.

- [ ] **Step 3: Implement the rich tool**

```ts
// packages/mcp-gateway/src/openTargetsTarget.ts
import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://api.platform.opentargets.org/api/v4/graphql';
const SEARCH = `query Resolve($q: String!) { search(queryString: $q, entityNames: ["target"]) { hits { id entity } } }`;
const TARGET = `query Target($id: String!) {
  target(ensemblId: $id) {
    id approvedSymbol approvedName
    tractability { modality label value }
    safetyLiabilities { event }
    associatedDiseases(page: { index: 0, size: 8 }) { rows { score disease { id name } } }
    knownDrugs(size: 8) { rows { drug { id name } mechanismOfAction phase } }
  }
}`;

async function gql(fetchImpl: typeof fetch, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`Open Targets HTTP ${res.status}`);
  return res.json();
}

interface TargetData {
  data?: { target?: {
    id: string; approvedSymbol: string; approvedName: string;
    tractability?: unknown[]; safetyLiabilities?: unknown[];
    associatedDiseases?: { rows?: Array<{ score: number; disease: { id: string; name: string } }> };
    knownDrugs?: { rows?: Array<{ drug: { id: string; name: string }; mechanismOfAction?: string; phase?: number }> };
  } };
}

export const openTargetsTargetTool: Tool = {
  name: 'open_targets_target',
  description: 'Fetch the Open Targets target dossier for a gene symbol: associations (scored), tractability, known drugs, safety liabilities.',
  async call(args, fetchImpl = fetch) {
    const symbol = String(args.symbol ?? '').trim();
    if (!symbol) return [];
    const search = (await gql(fetchImpl, SEARCH, { q: symbol })) as { data?: { search?: { hits?: Array<{ id: string; entity: string }> } } };
    const ensg = (search.data?.search?.hits ?? []).find((h) => h.entity === 'target' && h.id.startsWith('ENSG'))?.id;
    if (!ensg) return [];
    const t = ((await gql(fetchImpl, TARGET, { id: ensg })) as TargetData).data?.target;
    if (!t) return [];
    const now = new Date().toISOString();
    const out: Evidence[] = [];
    out.push({
      id: t.id, kind: 'target', source: 'Open Targets', title: `${t.approvedSymbol} — ${t.approvedName}`,
      snippet: `tractability: ${(t.tractability ?? []).length} modalities; safety liabilities: ${(t.safetyLiabilities ?? []).length}`,
      url: `https://platform.opentargets.org/target/${t.id}`,
      raw: { tractability: t.tractability ?? [], safetyLiabilities: t.safetyLiabilities ?? [] }, retrievedAt: now,
    });
    for (const r of t.associatedDiseases?.rows ?? []) {
      out.push({ id: r.disease.id, kind: 'disease', source: 'Open Targets',
        title: r.disease.name, snippet: `association score ${r.score.toFixed(2)} for ${t.approvedSymbol}`,
        url: `https://platform.opentargets.org/evidence/${t.id}/${r.disease.id}`, raw: r, retrievedAt: now });
    }
    for (const r of t.knownDrugs?.rows ?? []) {
      out.push({ id: r.drug.id, kind: 'drug', source: 'Open Targets',
        title: r.drug.name, snippet: `${r.mechanismOfAction ?? 'mechanism n/a'}${r.phase != null ? ` (phase ${r.phase})` : ''}`,
        url: `https://platform.opentargets.org/drug/${r.drug.id}`, raw: r, retrievedAt: now });
    }
    return out;
  },
};
```

```ts
// packages/mcp-gateway/src/index.ts  (add)
export { openTargetsTargetTool } from './openTargetsTarget.js';
```

(Leave the original `openTargetsTool` exported for back-compat; the orchestrator will use the new one.)

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/mcp-gateway test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(gateway): rich Open Targets tool (associations, tractability, known drugs, safety)"
```

---

### Task 3: ClinicalTrials.gov v2 tool

**Files:**
- Create: `packages/mcp-gateway/src/clinicalTrials.ts`
- Modify: `packages/mcp-gateway/src/index.ts`
- Test: `packages/mcp-gateway/src/clinicalTrials.test.ts`

**Interfaces:**
- Consumes: `Tool`, `Evidence`.
- Produces: `const clinicalTrialsTool: Tool` (arg `{ query: string }`). Calls ClinicalTrials.gov v2 `studies` endpoint and normalizes to `kind:'trial'` Evidence keyed by `NCT…`, with `snippet` = phase + status, title = brief title. Empty → `[]`.

- [ ] **Step 1: Write the failing test (fake fetch)**

```ts
// packages/mcp-gateway/src/clinicalTrials.test.ts
import { describe, it, expect } from 'vitest';
import { clinicalTrialsTool } from './clinicalTrials.js';

const fakeFetch = (async () => new Response(JSON.stringify({ studies: [
  { protocolSection: { identificationModule: { nctId: 'NCT05983770', briefTitle: 'BESTOW' },
    statusModule: { overallStatus: 'COMPLETED' }, designModule: { phases: ['PHASE2'] } } },
] }), { status: 200 })) as unknown as typeof fetch;

describe('clinicalTrialsTool', () => {
  it('normalizes a study to canonical NCT evidence', async () => {
    const out = await clinicalTrialsTool.call({ query: 'CDCP1 cancer' }, fakeFetch);
    expect(out[0].id).toBe('NCT05983770');
    expect(out[0].kind).toBe('trial');
    expect(out[0].title).toBe('BESTOW');
    expect(out[0].snippet).toContain('PHASE2');
    expect(out[0].snippet).toContain('COMPLETED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: FAIL — `Cannot find module './clinicalTrials.js'`.

- [ ] **Step 3: Implement the tool**

```ts
// packages/mcp-gateway/src/clinicalTrials.ts
import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://clinicaltrials.gov/api/v2/studies';

interface Study {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string };
    statusModule?: { overallStatus?: string };
    designModule?: { phases?: string[] };
  };
}

export const clinicalTrialsTool: Tool = {
  name: 'clinical_trials_search',
  description: 'Search ClinicalTrials.gov (v2) and return trials (NCT id, title, phase, status).',
  async call(args, fetchImpl = fetch) {
    const query = String(args.query ?? '').trim();
    if (!query) return [];
    const url = `${ENDPOINT}?query.term=${encodeURIComponent(query)}&pageSize=8&format=json`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`ClinicalTrials.gov HTTP ${res.status}`);
    const studies = ((await res.json()) as { studies?: Study[] }).studies ?? [];
    const now = new Date().toISOString();
    const out: Evidence[] = [];
    for (const s of studies) {
      const id = s.protocolSection?.identificationModule?.nctId;
      if (!id) continue;
      const phases = (s.protocolSection?.designModule?.phases ?? []).join('/');
      const status = s.protocolSection?.statusModule?.overallStatus ?? '';
      out.push({ id, kind: 'trial', source: 'ClinicalTrials.gov',
        title: s.protocolSection?.identificationModule?.briefTitle ?? '(no title)',
        snippet: `${phases} ${status}`.trim(), url: `https://clinicaltrials.gov/study/${id}`, raw: s, retrievedAt: now });
    }
    return out;
  },
};
```

```ts
// packages/mcp-gateway/src/index.ts  (add)
export { clinicalTrialsTool } from './clinicalTrials.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/mcp-gateway test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(gateway): ClinicalTrials.gov v2 tool with canonical NCT normalization"
```

---

### Task 4: RAG rating function (`@sonny/core`)

**Files:**
- Create: `packages/core/src/rag.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/rag.test.ts`

**Interfaces:**
- Consumes: `Claim`, `Verdict` from `@sonny/shared`.
- Produces: `function computeRag(shipped: Claim[], verdicts: Verdict[]): RagRating` — `red` if there are no shipped claims OR none are `supported`; `amber` if there is ≥1 `supported` claim but also any non-`supported` verdict, or fewer than 2 distinct cited sources across supported claims; `green` if every shipped claim is `supported` and ≥2 distinct sources back them.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/rag.test.ts
import { describe, it, expect } from 'vitest';
import type { Claim, Verdict } from '@sonny/shared';
import { computeRag } from './rag.js';

const claim = (id: string, cites: string[]): Claim => ({ id, text: 'x', citations: cites, confidence: 0.9 });
const v = (id: string, status: Verdict['status']): Verdict => ({ claimId: id, status, rationale: '' });

describe('computeRag', () => {
  it('red when nothing shipped', () => { expect(computeRag([], [])).toBe('red'); });
  it('red when no supported verdicts', () => {
    expect(computeRag([claim('c1', ['A'])], [v('c1', 'overreach')])).toBe('red');
  });
  it('green when all supported with >=2 sources', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['B'])], [v('c1', 'supported'), v('c2', 'supported')])).toBe('green');
  });
  it('amber when supported but only one source', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['A'])], [v('c1', 'supported'), v('c2', 'supported')])).toBe('amber');
  });
  it('amber when mixed verdicts', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['B'])], [v('c1', 'supported'), v('c2', 'overreach')])).toBe('amber');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — `Cannot find module './rag.js'`.

- [ ] **Step 3: Implement computeRag**

```ts
// packages/core/src/rag.ts
import type { Claim, Verdict, RagRating } from '@sonny/shared';

export function computeRag(shipped: Claim[], verdicts: Verdict[]): RagRating {
  if (shipped.length === 0) return 'red';
  const statusOf = (id: string) => verdicts.find((v) => v.claimId === id)?.status;
  const supported = shipped.filter((c) => statusOf(c.id) === 'supported');
  if (supported.length === 0) return 'red';
  const distinctSources = new Set(supported.flatMap((c) => c.citations));
  const allSupported = shipped.every((c) => statusOf(c.id) === 'supported');
  if (allSupported && distinctSources.size >= 2) return 'green';
  return 'amber';
}
```

```ts
// packages/core/src/index.ts  (append)
export { computeRag } from './rag.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(core): RAG rating from verdicts + evidence breadth"
```

---

### Task 5: Specialist registry + dynamic selection planner (`@sonny/core`)

**Files:**
- Create: `packages/core/src/specialists.ts`, `packages/core/src/planner.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/planner.test.ts`

**Interfaces:**
- Consumes: `StructuredModel`, `MODEL_ROUTER`, `Tool`.
- Produces:
  `interface Specialist { id: string; title: string; objective: string; toolNames: string[]; promptHint: string }`
  `const SPECIALISTS: Specialist[]` — six entries: `target_biology`, `disease_indications`, `clinical_translational`, `safety_tox`, `competitive_landscape` (Snapshot is synthesized separately, not a selectable specialist).
  `async function selectSpecialists(query: string, model: StructuredModel): Promise<{ selected: string[]; skipped: Array<{ id: string; reason: string }> }>` — asks the planner model (structured output) which specialists are relevant to the query; ids not selected become `skipped` with a one-line reason. Falls back to selecting all five if the model returns an empty selection.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/planner.test.ts
import { describe, it, expect } from 'vitest';
import { SPECIALISTS } from './specialists.js';
import { selectSpecialists } from './planner.js';
import type { StructuredModel } from './model.js';

describe('specialist selection', () => {
  it('registry has the five scientific specialists', () => {
    expect(SPECIALISTS.map((s) => s.id)).toEqual([
      'target_biology', 'disease_indications', 'clinical_translational', 'safety_tox', 'competitive_landscape',
    ]);
  });

  it('returns model selection and derives skipped with reasons', async () => {
    const model: StructuredModel = {
      async generateStructured({ schema }) {
        return schema.parse({ selected: ['target_biology', 'disease_indications'],
          skipped: [{ id: 'competitive_landscape', reason: 'no competitive question posed' }] });
      },
    };
    const { selected, skipped } = await selectSpecialists('What diseases is CDCP1 associated with?', model);
    expect(selected).toContain('target_biology');
    expect(skipped.find((s) => s.id === 'clinical_translational')).toBeTruthy(); // derived even if model omitted it
  });

  it('falls back to all specialists if model selects none', async () => {
    const model: StructuredModel = { async generateStructured({ schema }) { return schema.parse({ selected: [], skipped: [] }); } };
    const { selected } = await selectSpecialists('CDCP1', model);
    expect(selected).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the registry + planner**

```ts
// packages/core/src/specialists.ts
export interface Specialist { id: string; title: string; objective: string; toolNames: string[]; promptHint: string }

export const SPECIALISTS: Specialist[] = [
  { id: 'target_biology', title: 'Target Biology',
    objective: 'Characterize the target: function, tractability, expression.',
    toolNames: ['open_targets_target', 'pubmed_search'],
    promptHint: 'Describe the target’s biology, druggability/tractability, and expression. Use the Open Targets target record and literature.' },
  { id: 'disease_indications', title: 'Disease & Indications',
    objective: 'Identify the diseases/indications most associated with the target.',
    toolNames: ['open_targets_target', 'pubmed_search'],
    promptHint: 'Summarize the top disease associations (cite the disease records and their scores) and the most credible indication(s).' },
  { id: 'clinical_translational', title: 'Clinical & Translational',
    objective: 'Summarize clinical trials and translational evidence.',
    toolNames: ['clinical_trials_search', 'pubmed_search'],
    promptHint: 'Summarize relevant clinical trials (phase/status) and translational evidence. Cite NCT ids and PMIDs.' },
  { id: 'safety_tox', title: 'Safety & Tox',
    objective: 'Surface known safety liabilities and toxicity signals.',
    toolNames: ['open_targets_target', 'pubmed_search'],
    promptHint: 'Report known safety liabilities (from the Open Targets target record) and toxicity signals from the literature. Be conservative.' },
  { id: 'competitive_landscape', title: 'Competitive Landscape',
    objective: 'Map known drugs / modalities against the target.',
    toolNames: ['open_targets_target', 'pubmed_search'],
    promptHint: 'Summarize known drugs and modalities targeting this gene (cite the drug records, mechanism, phase) and differentiation.' },
];
```

```ts
// packages/core/src/planner.ts
import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { SPECIALISTS } from './specialists.js';

const SelectionSchema = z.object({
  selected: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});

const SYSTEM = `You are the Lead Investigator planning a scientific target dossier.
Given the user's question, choose which specialists are relevant. For any specialist you do NOT select, give a one-line reason.
Valid specialist ids: ${SPECIALISTS.map((s) => s.id).join(', ')}.`;

export async function selectSpecialists(
  query: string,
  model: StructuredModel,
): Promise<{ selected: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const valid = new Set(SPECIALISTS.map((s) => s.id));
  const raw = await model.generateStructured({
    system: SYSTEM, prompt: `Question: ${query}`, schema: SelectionSchema, model: MODEL_ROUTER.planner,
  });
  let selected = raw.selected.filter((id) => valid.has(id));
  if (selected.length === 0) selected = SPECIALISTS.map((s) => s.id); // fallback: run all
  // Derive skipped for any valid specialist not selected (merge model-provided reasons).
  const skipped = SPECIALISTS.filter((s) => !selected.includes(s.id)).map((s) => ({
    id: s.id, reason: raw.skipped.find((k) => k.id === s.id)?.reason ?? 'not relevant to this question',
  }));
  return { selected, skipped };
}
```

```ts
// packages/core/src/index.ts  (append)
export { SPECIALISTS, type Specialist } from './specialists.js';
export { selectSpecialists } from './planner.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(core): specialist registry + dynamic selection planner"
```

---

### Task 6: Per-section production (`@sonny/core`)

**Files:**
- Create: `packages/core/src/produceSection.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/produceSection.test.ts`

**Interfaces:**
- Consumes: `Specialist`, `EvidenceStore`, `Tool`, `StructuredModel`, `groundClaims`, `verifyClaims`, `computeRag`, `ClaimsSchema`, `Section`, `MODEL_ROUTER`.
- Produces:
  `async function produceSection(opts: { spec: Specialist; query: string; symbol: string; tools: Tool[]; store: EvidenceStore; specialistModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void }): Promise<Section>` — emits `specialist_start`; runs the spec's tools (by `toolNames`, allSettled, registering evidence + emitting `tool_call`/`tool_result`/`evidence_registered`/`error`); drafts a takeaway + claims via the specialist model over the evidence; grounds; verifies; computes RAG; returns the `Section` (id = spec.id, title = spec.title, takeaway, supported claims, distinct sources, rag); emits `section_complete`.

- [ ] **Step 1: Write the failing test (fakes)**

```ts
// packages/core/src/produceSection.test.ts
import { describe, it, expect } from 'vitest';
import type { Evidence, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { StructuredModel } from './model.js';
import { EvidenceStore } from './evidenceStore.js';
import { produceSection } from './produceSection.js';
import { SPECIALISTS } from './specialists.js';

const ev: Evidence = { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' };
const otTool: Tool = { name: 'open_targets_target', description: '', call: async () => [ev] };
const pubmed: Tool = { name: 'pubmed_search', description: '', call: async () => [] };

const specialistModel: StructuredModel = {
  async generateStructured({ schema }) {
    return schema.parse({ takeaway: 'CDCP1 is a cell-surface target.',
      claims: [{ id: 'c1', text: 'CDCP1 is a target.', citations: ['ENSG1'], confidence: 0.9 }] });
  },
};
const verifierModel: StructuredModel = { async generateStructured({ schema }) { return schema.parse({ claimId: 'x', status: 'supported', rationale: 'r' }); } };

describe('produceSection', () => {
  it('runs tools, grounds, verifies, rates, and returns a section', async () => {
    const events: TraceEvent[] = [];
    const spec = SPECIALISTS.find((s) => s.id === 'target_biology')!;
    const section = await produceSection({
      spec, query: 'CDCP1 biology', symbol: 'CDCP1', tools: [otTool, pubmed],
      store: new EvidenceStore(), specialistModel, verifierModel, emit: (e) => events.push(e),
    });
    expect(section.id).toBe('target_biology');
    expect(section.title).toBe('Target Biology');
    expect(section.takeaway).toContain('cell-surface');
    expect(section.claims.map((c) => c.id)).toEqual(['c1']);
    expect(section.sources).toContain('ENSG1');
    expect(section.rag).toBe('amber'); // one source -> amber
    expect(events.find((e) => e.type === 'specialist_start')).toBeTruthy();
    expect(events.find((e) => e.type === 'section_complete')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — `Cannot find module './produceSection.js'`.

- [ ] **Step 3: Implement produceSection**

```ts
// packages/core/src/produceSection.ts
import { z } from 'zod';
import { ClaimsSchema, type Claim, type Section, type TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag } from './rag.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import type { Specialist } from './specialists.js';

const SectionDraftSchema = z.object({ takeaway: z.string(), claims: ClaimsSchema.shape.claims });

function argsFor(toolName: string, query: string, symbol: string): Record<string, unknown> {
  if (toolName === 'open_targets_target') return { symbol };
  if (toolName === 'clinical_trials_search') return { query: `${symbol} ${query}` };
  return { query: `${symbol} ${query}` }; // pubmed_search and default
}

export async function produceSection(opts: {
  spec: Specialist; query: string; symbol: string; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<Section> {
  const { spec, query, symbol, tools, store, specialistModel, verifierModel, emit } = opts;
  emit({ type: 'specialist_start', specialist: spec.id });

  const chosen = tools.filter((t) => spec.toolNames.includes(t.name));
  const settled = await Promise.allSettled(chosen.map(async (t) => {
    const args = argsFor(t.name, query, symbol);
    emit({ type: 'tool_call', tool: t.name, args });
    const evidence = await t.call(args);
    emit({ type: 'tool_result', tool: t.name, count: evidence.length });
    return evidence;
  }));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const e of r.value) { store.register(e); emit({ type: 'evidence_registered', id: e.id, title: e.title }); }
    } else {
      emit({ type: 'error', message: `tool ${chosen[i].name} failed: ${String(r.reason)}` });
    }
  });

  const evidenceList = store.all().map((e) => `[${e.id}] (${e.kind}) ${e.title} — ${e.snippet}`).join('\n');
  const draft = await specialistModel.generateStructured({
    system: `You are the ${spec.title} specialist. ${spec.promptHint}\nUse ONLY the provided evidence. Every claim MUST cite the evidence id(s) it rests on. Provide a one-line takeaway and claims c1, c2, ... with confidence in [0,1].`,
    prompt: `QUESTION: ${query}\n\nEVIDENCE:\n${evidenceList}`,
    schema: SectionDraftSchema, model: MODEL_ROUTER.specialist,
  });
  for (const c of draft.claims) emit({ type: 'claim_drafted', claim: c });

  const { shippable } = groundClaims(draft.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported: Claim[] = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  const sources = [...new Set(supported.flatMap((c) => c.citations))];
  const section: Section = {
    id: spec.id, title: spec.title, takeaway: draft.takeaway, claims: supported, sources,
    rag: computeRag(shippable, verdicts),
  };
  emit({ type: 'section_complete', section });
  return section;
}
```

```ts
// packages/core/src/index.ts  (append)
export { produceSection } from './produceSection.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(core): per-section production (tools -> ground -> verify -> RAG -> Section)"
```

---

### Task 7: `runDossier` multi-specialist orchestrator (`@sonny/core`)

**Files:**
- Create: `packages/core/src/runDossier.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/runDossier.test.ts`

**Interfaces:**
- Consumes: `selectSpecialists`, `SPECIALISTS`, `produceSection`, `EvidenceStore`, `Tool`, `StructuredModel`, `Section`, `TraceEvent`.
- Produces:
  `async function runDossier(opts: { query: string; symbol: string; tools: Tool[]; plannerModel: StructuredModel; specialistModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void }): Promise<{ verdict: string; sections: Section[] }>` — selects specialists (emits `plan` with the selected ids + their tool names, and a `specialist_skipped` per skipped id); shares ONE `EvidenceStore` across sections; runs each selected specialist's `produceSection` sequentially; the `verdict` is a one-line headline derived from the highest-confidence supported claim of the first non-empty section (or "No grounded findings" if every section is empty).

- [ ] **Step 1: Write the failing test (fakes)**

```ts
// packages/core/src/runDossier.test.ts
import { describe, it, expect } from 'vitest';
import type { Evidence, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { StructuredModel } from './model.js';
import { runDossier } from './runDossier.js';

const ev: Evidence = { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' };
const otTool: Tool = { name: 'open_targets_target', description: '', call: async () => [ev] };
const pubmed: Tool = { name: 'pubmed_search', description: '', call: async () => [] };
const ctgov: Tool = { name: 'clinical_trials_search', description: '', call: async () => [] };

const plannerModel: StructuredModel = { async generateStructured({ schema }) {
  return schema.parse({ selected: ['target_biology'], skipped: [{ id: 'safety_tox', reason: 'no safety question' }] }); } };
const specialistModel: StructuredModel = { async generateStructured({ schema }) {
  return schema.parse({ takeaway: 'CDCP1 is a cell-surface target.',
    claims: [{ id: 'c1', text: 'CDCP1 is a target.', citations: ['ENSG1'], confidence: 0.95 }] }); } };
const verifierModel: StructuredModel = { async generateStructured({ schema }) {
  return schema.parse({ claimId: 'x', status: 'supported', rationale: 'r' }); } };

describe('runDossier', () => {
  it('selects specialists, produces sections sharing one store, and derives a verdict', async () => {
    const events: TraceEvent[] = [];
    const out = await runDossier({
      query: 'CDCP1 biology', symbol: 'CDCP1', tools: [otTool, pubmed, ctgov],
      plannerModel, specialistModel, verifierModel, emit: (e) => events.push(e),
    });
    expect(out.sections.map((s) => s.id)).toEqual(['target_biology']);
    expect(out.verdict).toContain('CDCP1');
    expect(events.find((e) => e.type === 'plan')).toBeTruthy();
    expect(events.find((e) => e.type === 'specialist_skipped')).toBeTruthy();
    expect(events.filter((e) => e.type === 'section_complete')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — `Cannot find module './runDossier.js'`.

- [ ] **Step 3: Implement runDossier**

```ts
// packages/core/src/runDossier.ts
import type { Section, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import { SPECIALISTS } from './specialists.js';
import { selectSpecialists } from './planner.js';
import { produceSection } from './produceSection.js';
import type { StructuredModel } from './model.js';

export async function runDossier(opts: {
  query: string; symbol: string; tools: Tool[];
  plannerModel: StructuredModel; specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void;
}): Promise<{ verdict: string; sections: Section[] }> {
  const { query, symbol, tools, plannerModel, specialistModel, verifierModel, emit } = opts;

  const { selected, skipped } = await selectSpecialists(query, plannerModel);
  const specs = SPECIALISTS.filter((s) => selected.includes(s.id));
  emit({ type: 'plan', specialists: specs.map((s) => s.id), tools: [...new Set(specs.flatMap((s) => s.toolNames))] });
  for (const k of skipped) emit({ type: 'specialist_skipped', specialist: k.id, reason: k.reason });

  const store = new EvidenceStore(); // shared across sections
  const sections: Section[] = [];
  for (const spec of specs) {
    sections.push(await produceSection({ spec, query, symbol, tools, store, specialistModel, verifierModel, emit }));
  }

  // Headline verdict: highest-confidence supported claim across sections, else a fallback.
  const top = sections.flatMap((s) => s.claims).sort((a, b) => b.confidence - a.confidence)[0];
  const verdict = top ? top.text : 'No grounded findings for this target.';
  return { verdict, sections };
}
```

```ts
// packages/core/src/index.ts  (append)
export { runDossier } from './runDossier.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS. Then `pnpm -r test` to confirm nothing else broke.

```bash
git add -A
git commit -m "feat(core): runDossier multi-specialist orchestrator with shared evidence store"
```

---

### Task 8: Wire the web glass-box to the dossier

**Files:**
- Modify: `apps/web/src/streamRun.ts`, `apps/web/src/main.ts`, `apps/web/public/app.js`, `apps/web/public/index.html` (add a contents-rail container), `apps/web/public/styles.css` (section + RAG-dot styles)
- Test: `apps/web/src/streamRun.test.ts` (update), `apps/web/src/frontend.test.ts` (update)

**Interfaces:**
- Consumes: `runDossier` (`@sonny/core`); `Section`, `TraceEvent` (`@sonny/shared`).
- Produces: `streamRun`'s `OrchestratorRunner` return type widens to `{ verdict: string; sections: Section[] }`, and the `done` frame carries `{ verdict, sections }`; `buildDeps.makeRunner` calls `runDossier` with `plannerModel/specialistModel/verifierModel`; the front-end renders each `section_complete`/the final dossier as a titled section with its takeaway, cited claims, per-section sources, and a RAG dot, plus a contents rail listing sections with RAG dots, and `specialist_skipped` lines in the research process.

- [ ] **Step 1: Update streamRun's type + test**

Change `OrchestratorRunner` to `(emit) => Promise<{ verdict: string; sections: Section[] }>` and the `done` payload to the full object. Update `streamRun.test.ts` so the fake runner returns `{ verdict: 'v', sections: [] }` and assert the done frame contains `"verdict":"v"`.

```ts
// apps/web/src/streamRun.ts  (replace the type + done line)
import type { Section, TraceEvent } from '@sonny/shared';
import { encodeEvent, encodeNamed } from './sse.js';

export type OrchestratorRunner = (emit: (e: TraceEvent) => void) => Promise<{ verdict: string; sections: Section[] }>;

export async function streamRun(runner: OrchestratorRunner, write: (chunk: string) => void): Promise<void> {
  try {
    const result = await runner((e) => write(encodeEvent(e)));
    write(encodeNamed('done', result));
  } catch (err) {
    write(encodeNamed('error', { message: err instanceof Error ? err.message : 'unknown error' }));
  }
}
```

```ts
// apps/web/src/streamRun.test.ts  (update the success test)
// runner returns { verdict: 'done text', sections: [] }; assert:
expect(chunks.at(-1)).toContain('"verdict":"done text"');
```

- [ ] **Step 2: Run the streamRun test to verify it fails then passes**

Run: `pnpm --filter @sonny/web test`
Expected: FAIL first (old assertion/type), then update the test as above → PASS for streamRun.

- [ ] **Step 3: Update `main.ts` to call `runDossier`**

```ts
// apps/web/src/main.ts  (replace the makeRunner body)
import { runDossier, AnthropicModel } from '@sonny/core';
import { openTargetsTargetTool, pubmedTool, clinicalTrialsTool } from '@sonny/mcp-gateway';
// ... within buildDeps:
    makeRunner: (query, symbol) => async (emit) => {
      const { verdict, sections } = await runDossier({
        query, symbol, tools: [openTargetsTargetTool, pubmedTool, clinicalTrialsTool],
        plannerModel: new AnthropicModel(), specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(), emit,
      });
      return { verdict, sections };
    },
```

(Keep `buildDeps`'s lazy-construction shape; only the tools + call + return change. Update `main.test.ts` only if it asserted the old return — it asserts `makeRunner(...)` is a function, which still holds.)

- [ ] **Step 4: Update the front-end — index.html contents rail + section containers**

Add a contents rail and a sections container to `index.html` (keep all existing ids). Insert a `<nav id="contents"></nav>` before the `<main>` and change `#dossier` to hold rendered sections; add `#skipped` inside the research process.

```html
<!-- apps/web/public/index.html — within <body>, wrap page in a flex row -->
<div class="page">
  <nav id="contents" class="contents"></nav>
  <main class="sheet">
    <div class="composer">
      <input id="query" type="text" placeholder="Ask about a target, e.g. CDCP1">
      <button id="run">Run</button>
      <span id="edits-toggle" class="lnk" hidden>View agent edits</span>
    </div>
    <h1 id="verdict" class="verdict">Sonny</h1>
    <div id="meta" class="meta"></div>
    <hr class="rule">
    <section id="dossier" class="dossier"></section>
    <h2 class="lane">Supporting evidence</h2>
    <div id="evidence-list" class="evidence"></div>
    <details class="proc"><summary>Research process</summary><div id="skipped" class="skipped"></div><div id="trace" class="trace"></div></details>
  </main>
</div>
<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer"><span class="x" id="drawer-close">✕</span><div id="drawer-body"></div></aside>
```

- [ ] **Step 5: Update `styles.css` — section + RAG-dot + contents-rail styles**

```css
/* apps/web/public/styles.css  (append) */
.page{display:flex;gap:20px;align-items:flex-start}
.contents{position:sticky;top:24px;flex:0 0 180px;font-size:12.5px;padding-top:8px}
.contents a{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:6px;color:var(--muted);text-decoration:none}
.contents a:hover{color:var(--ink)}
.rag{width:7px;height:7px;border-radius:50%;display:inline-block}
.rag.green{background:var(--ok)}.rag.amber{background:var(--warn)}.rag.red{background:#b9544f}
.section{padding:20px 0;border-bottom:1px solid var(--border)}
.section h2{font-size:18px;font-weight:600;color:var(--ink);margin:0 0 4px}
.section .take{font-style:italic;color:#475569;margin:0 0 12px}
.section .src{font-size:11.5px;color:var(--muted);margin-top:8px}
.skipped{font-size:11.5px;color:var(--muted);margin-bottom:8px}
```

- [ ] **Step 6: Update `app.js` — render sections, contents rail, skipped; update the test**

```js
// apps/web/public/app.js — replace the section/synthesis rendering with section_complete handling
function ragDot(rag){ return `<span class="rag ${esc(rag)}"></span>`; }
function renderSection(sec){
  const claims = sec.claims.map((c) =>
    `<p>${esc(c.text)} ${(c.citations||[]).map((id)=>`<span class="cite" data-id="${esc(id)}">[${esc(id)}]</span>`).join(' ')}</p>`).join('');
  const el = document.createElement('div'); el.className='section'; el.id='sec-'+esc(sec.id);
  el.innerHTML = `<h2>${ragDot(sec.rag)} ${esc(sec.title)}</h2><div class="take">${esc(sec.takeaway)}</div>${claims}`+
    (sec.sources.length?`<div class="src">Sources: ${sec.sources.map((id)=>`<span class="cite" data-id="${esc(id)}">${esc(id)}</span>`).join(' · ')}</div>`:'');
  $('dossier').appendChild(el);
  const link=document.createElement('a'); link.href='#sec-'+esc(sec.id);
  link.innerHTML = `${ragDot(sec.rag)} ${esc(sec.title)}`; $('contents').appendChild(link);
}
// in handle(): add cases
//   case 'specialist_start': appendTrace('  ▸ '+ev.specialist); break;
//   case 'specialist_skipped': { const d=document.createElement('div'); d.textContent='skipped '+ev.specialist+' — '+ev.reason; $('skipped').appendChild(d); break; }
//   case 'section_complete': renderSection(ev.section); break;
// remove the old 'synthesis' case.
// in the 'done' listener: const { verdict } = JSON.parse(m.data); $('verdict').textContent = verdict || 'No grounded findings';
// in reset(): also clear $('contents').innerHTML and $('skipped').innerHTML.
```

Update `frontend.test.ts`: assert `index.html` contains `id="contents"` and `id="skipped"`; assert `app.js` contains `section_complete`, `specialist_skipped`, and `renderSection`.

- [ ] **Step 7: Run web tests, then the full suite**

Run: `pnpm --filter @sonny/web test` → Expected: PASS (updated tests).
Run: `pnpm -r test` → Expected: all packages green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): render multi-section dossier (sections, RAG dots, contents rail, skipped specialists)"
```

---

### Task 9: Update the CLI to render the dossier

**Files:**
- Modify: `apps/cli/src/run.ts`
- Test: `apps/cli/src/run.test.ts` (update)

**Interfaces:**
- Consumes: `runDossier`, `AnthropicModel` (`@sonny/core`); `openTargetsTargetTool`, `pubmedTool`, `clinicalTrialsTool` (`@sonny/mcp-gateway`); `Section`, `TraceEvent`.
- Produces: `formatTrace` gains cases for `specialist_start`, `specialist_skipped`, `section_complete` (renders `RAG TITLE` + takeaway + cited claims); `main` calls `runDossier` with the three tools + planner/specialist/verifier models and prints the verdict + sections.

- [ ] **Step 1: Update `run.test.ts` for the new events**

```ts
// apps/cli/src/run.test.ts  (extend the events fixture + assertion)
import type { Section } from '@sonny/shared';
// add to events:
//   { type: 'specialist_skipped', specialist: 'safety_tox', reason: 'no safety question' },
//   { type: 'section_complete', section: { id:'target_biology', title:'Target Biology', takeaway:'t', claims:[], sources:[], rag:'green' } as Section },
// assert formatTrace output contains 'Target Biology' and 'skipped safety_tox'
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/cli test`
Expected: FAIL — `formatTrace` doesn't handle the new event types yet.

- [ ] **Step 3: Update `formatTrace` + `main`**

```ts
// apps/cli/src/run.ts — add cases to the formatTrace switch:
//   case 'specialist_start': return `  ▸ ${e.specialist}`;
//   case 'specialist_skipped': return `  (skipped ${e.specialist}: ${e.reason})`;
//   case 'section_complete': return `\n[${e.section.rag.toUpperCase()}] ${e.section.title}\n  ${e.section.takeaway}\n` +
//     e.section.claims.map((c) => `  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
// remove the old 'synthesis' case.
// In main(): replace runOrchestration with:
//   import { runDossier, AnthropicModel } from '@sonny/core';
//   import { openTargetsTargetTool, pubmedTool, clinicalTrialsTool } from '@sonny/mcp-gateway';
//   await runDossier({ query, symbol, tools: [openTargetsTargetTool, pubmedTool, clinicalTrialsTool],
//     plannerModel: new AnthropicModel(), specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(),
//     emit: (e) => process.stdout.write(formatTrace([e]) + '\n') });
```

- [ ] **Step 4: Run CLI tests + full suite**

Run: `pnpm --filter @sonny/cli test` → Expected: PASS.
Run: `pnpm -r test` → Expected: all packages green.

Manual live run (requires key): `ANTHROPIC_API_KEY=sk-... pnpm --filter @sonny/cli start "CDCP1"` → expect the planner to select specialists, each section to print with a RAG tag + cited claims grounded in Open Targets associations/drugs/safety + trials.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cli): render multi-section dossier with RAG tags and skipped specialists"
```

---

## Self-Review

**Spec coverage (Plan 3 scope = spec §5 dossier sections + §4 rich retrieval, scientific half):**
- Rich Open Targets (associations/tractability/known drugs/safety): Task 2 ✓
- ClinicalTrials.gov: Task 3 ✓
- Targeted PubMed (symbol+query, no dup): Tasks 6/9 `argsFor` builds `${symbol} ${query}` ✓
- Six sections (Snapshot via verdict + 5 specialists; Disease & Safety broken out): Tasks 5/6/7 ✓
- Per-section cite+verify+RAG: Tasks 4/6 ✓
- Dynamic selection with skipped+reasons: Tasks 5/7 ✓
- Structured multi-section dossier surfaced in web + CLI: Tasks 8/9 ✓
- Trust rule + decorrelated verifier preserved (reuse groundClaims/verifyClaims): Task 6 ✓
- **Deferred (per scope):** IP & Exclusivity, Probability of Success, and the entire financial/valuation half (rNPV, comps, market model) — next plan.

**Placeholder scan:** Tasks 8 and 9 use targeted in-file edit snippets (commented "add/replace these cases") rather than full-file rewrites, because they modify large existing files surgically; each snippet contains the exact code to add and names the exact functions/cases. No "TBD"/"handle the rest" — every change is shown. All new files (Tasks 1–7) have complete code.

**Type consistency:** `Section`/`RagRating` (Task 1) consumed identically by Tasks 4/6/7/8/9; `Specialist`/`SPECIALISTS` (Task 5) by Tasks 6/7; `produceSection` signature (Task 6) called by Task 7; `runDossier` return `{ verdict, sections }` (Task 7) consumed by Tasks 8 (streamRun/main) and 9 (cli); the new tool names (`open_targets_target`, `clinical_trials_search`) in `SPECIALISTS.toolNames` (Task 5) match the tool `name` fields (Tasks 2/3) and the `argsFor` switch (Task 6); the new `TraceEvent` members (Task 1) are the ones emitted in Tasks 6/7 and handled in Tasks 8/9.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-sonny-v2-scientific-dossier.md`.
