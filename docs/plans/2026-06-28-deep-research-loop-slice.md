# Deep-Research Loop (Foundational Slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the core deep-research mechanic end to end - a single specialist researcher that plans questions, reads full-text primary literature, extracts passage-grounded claims, reflects on its gaps, and loops - producing one verified, RAG-rated deep section runnable from the CLI.

**Architecture:** Add passage-level evidence to the existing trust core, two new literature tools (Europe PMC search for ranked candidates, NCBI PMC efetch for full text), and a bounded plan-act-read-ground-reflect-loop (`runResearcher`) that drives one thread. A thin `produceResearchSection` wraps the loop with the existing grounding gate, decorrelated verifier, and RAG rating to emit a `Section`. This is sub-project 1, slice 1 of the deep-research engine spec (`docs/specs/2026-06-28-sonny-deep-research-engine-design.md`); the Lead orchestration, multi-specialist roster, synthesis/recommendation, patents, glass-box web UI, and expert-bar eval are later plans.

**Tech Stack:** TypeScript ESM monorepo (pnpm workspaces, Node 20+), Vitest, Zod, `@anthropic-ai/sdk`, `zod-to-json-schema`, `fast-xml-parser` (new, for JATS), `tsx` for the CLI.

## Global Constraints

- ESM only: every relative import ends in `.js`; every package is `"type": "module"`.
- Package exports are source-first: `exports` and `main` point at `./src`, not `./dist`.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Structured output only: models return data via `StructuredModel.generateStructured` with a Zod schema; never parse free text with regex.
- Grounding gate is absolute: a claim with any citation that does not resolve in the `EvidenceStore` never ships.
- The verifier is decorrelated: it runs on `MODEL_ROUTER.verifier` (`claude-sonnet-4-6`), a different model than the specialist (`MODEL_ROUTER.specialist`, `claude-opus-4-8`).
- Tool tests pin the REAL response shape: copy a recorded API response into the test fixture; never assert against an invented shape (the Open Targets HTTP 400 regression is the cautionary case).
- Tools accept an injectable `fetchImpl` so tests never hit the network.
- Copy rule: no em dash characters anywhere in code, comments, or output strings; use a plain hyphen.
- Run a single package's tests with `pnpm --filter <pkg> test`; the whole suite with `pnpm -r test`.

---

## File Structure

- `packages/shared/src/contracts.ts` (modify) - add `passage`/`locator` to `Evidence`; add three research `TraceEvent` variants.
- `packages/mcp-gateway/src/europePmc.ts` (create) - `europePmcSearchTool` (name `europepmc_search`).
- `packages/mcp-gateway/src/pmcFullText.ts` (create) - `pmcFullTextTool` (name `pmc_fulltext`).
- `packages/mcp-gateway/src/index.ts` (modify) - export the two new tools.
- `packages/core/src/researcher.ts` (create) - `planResearchQuestions`, `extractClaims`, `reflectOnGaps`, `runResearcher`, and the shared types.
- `packages/core/src/produceResearchSection.ts` (create) - wrap `runResearcher` with grounding + verifier + RAG into a `Section`.
- `packages/core/src/index.ts` (modify) - export the new functions/types.
- `apps/cli/src/deep.ts` (create) - `runDeep` entrypoint for one thread.
- `apps/cli/src/deep.test.ts` (create) - trace-formatting test for the new events.
- `apps/cli/src/run.ts` (modify) - add a `deep` subcommand dispatch.

---

### Task 1: Passage-level evidence

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/core/src/verifier.ts`
- Test: `packages/core/src/verifier.test.ts` (create if absent; otherwise add the case)

**Interfaces:**
- Consumes: existing `EvidenceSchema`, `verifyClaims`.
- Produces: `Evidence` gains optional `passage?: string` and `locator?: string`; `verifyClaims` shows the model `passage` when present, falling back to `snippet`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/verifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Claim } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { verifyClaims } from './verifier.js';
import type { StructuredModel } from './model.js';

describe('verifyClaims passage grounding', () => {
  it('shows the verifier the full-text passage when present, not just the snippet', async () => {
    const store = new EvidenceStore();
    store.register({
      id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in NPC',
      snippet: 'abstract line', passage: 'CDCP1 promotes EMT in nasopharyngeal carcinoma cells.',
      locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now',
    });
    let seenPrompt = '';
    const model: StructuredModel = {
      async generateStructured({ prompt }) {
        seenPrompt = prompt;
        return { claimId: 'x', status: 'supported', rationale: 'ok' } as never;
      },
    };
    const claims: Claim[] = [{ id: 'c1', text: 'CDCP1 drives EMT', citations: ['PMID:1'], confidence: 0.8 }];
    await verifyClaims(claims, store, model);
    expect(seenPrompt).toContain('CDCP1 promotes EMT in nasopharyngeal carcinoma cells.');
    expect(seenPrompt).toContain('Results');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test verifier`
Expected: FAIL - the prompt contains only `snippet`, not the passage/locator.

- [ ] **Step 3: Implement**

In `packages/shared/src/contracts.ts`, extend `EvidenceSchema`:

```ts
export const EvidenceSchema = z.object({
  id: z.string().min(1),
  kind: EvidenceKindSchema,
  source: z.string().min(1),
  title: z.string(),
  snippet: z.string(),
  passage: z.string().optional(),
  locator: z.string().optional(),
  url: z.string(),
  raw: z.unknown(),
  retrievedAt: z.string(),
});
```

In `packages/core/src/verifier.ts`, change the evidence-text line to prefer the passage and show the locator:

```ts
    const evidenceText = c.citations
      .map((id) => store.get(id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
      .map((e) => `[${e.id}]${e.locator ? ` (${e.locator})` : ''} ${e.title} — ${e.passage ?? e.snippet}`)
      .join('\n');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test verifier`
Expected: PASS. Then `pnpm --filter @sonny/shared test` stays green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/core/src/verifier.ts packages/core/src/verifier.test.ts
git commit -m "feat(core): passage-level evidence — verifier reads full-text passage"
```

---

### Task 2: Europe PMC search tool

**Files:**
- Create: `packages/mcp-gateway/src/europePmc.ts`
- Test: `packages/mcp-gateway/src/europePmc.test.ts`
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Consumes: `Tool` from `./tool.js`, `Evidence` from `@sonny/shared`.
- Produces: `europePmcSearchTool: Tool` (name `europepmc_search`). Input `{ query: string }`. Returns publication `Evidence` ranked by citations, each with `passage` = abstract, `raw.citedByCount`, `raw.pmcid`, `raw.isReview`.

- [ ] **Step 1: Write the failing test**

`packages/mcp-gateway/src/europePmc.test.ts` (fixture copied from the real `resultType=core` response):

```ts
import { describe, it, expect } from 'vitest';
import { europePmcSearchTool } from './europePmc.js';

const payload = { resultList: { result: [
  { id: '33611339', source: 'MED', pmid: '33611339', pmcid: 'PMC7897327',
    title: 'CDCP1 review.', abstractText: 'CDCP1 is a transmembrane protein.',
    citedByCount: '1636', isOpenAccess: 'Y', firstPublicationDate: '2021-02-21',
    pubTypeList: { pubType: ['review-article', 'Review', 'Journal Article'] } },
  { id: '40000001', source: 'MED', pmid: '40000001', pmcid: '',
    title: 'CDCP1 primary study.', abstractText: 'CDCP1 promotes EMT.',
    citedByCount: '12', isOpenAccess: 'N', firstPublicationDate: '2024-01-01',
    pubTypeList: { pubType: ['Journal Article'] } },
] } };

const fakeFetch = (async (url) => {
  expect(String(url)).toContain('/europepmc/webservices/rest/search');
  return new Response(JSON.stringify(payload), { status: 200 });
}) as unknown as typeof fetch;

describe('europePmcSearchTool', () => {
  it('returns citation-ranked publication evidence with abstract as passage and review flag', async () => {
    const out = await europePmcSearchTool.call({ query: 'CDCP1 cancer' }, fakeFetch);
    expect(out.map((e) => e.id)).toEqual(['PMID:33611339', 'PMID:40000001']);
    expect(out[0].kind).toBe('publication');
    expect(out[0].passage).toBe('CDCP1 is a transmembrane protein.');
    expect((out[0].raw as { isReview: boolean }).isReview).toBe(true);
    expect((out[0].raw as { pmcid: string }).pmcid).toBe('PMC7897327');
    expect((out[1].raw as { isReview: boolean }).isReview).toBe(false);
  });

  it('returns [] for an empty query', async () => {
    const out = await europePmcSearchTool.call({ query: '  ' }, fakeFetch);
    expect(out).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test europePmc`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/mcp-gateway/src/europePmc.ts`:

```ts
import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

interface Hit {
  id: string; source: string; pmid?: string; pmcid?: string;
  title?: string; abstractText?: string; citedByCount?: string;
  isOpenAccess?: string; firstPublicationDate?: string;
  pubTypeList?: { pubType?: string[] };
}

export const europePmcSearchTool: Tool = {
  name: 'europepmc_search',
  description: 'Search Europe PMC for publications, ranked by citation count. Returns title, abstract, citation count, review flag, and PMC id for full-text retrieval.',
  async call(args, fetchImpl = fetch) {
    const query = String(args.query ?? '').trim();
    if (!query) return [];
    const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=8&sort=${encodeURIComponent('CITED desc')}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Europe PMC HTTP ${res.status}`);
    const hits = (((await res.json()) as { resultList?: { result?: Hit[] } }).resultList?.result) ?? [];
    const now = new Date().toISOString();
    return hits
      .filter((h) => h.pmid)
      .map<Evidence>((h) => {
        const types = h.pubTypeList?.pubType ?? [];
        const isReview = types.some((t) => /review/i.test(t));
        return {
          id: `PMID:${h.pmid}`, kind: 'publication', source: 'Europe PMC',
          title: h.title ?? '(no title)',
          snippet: `cited ${h.citedByCount ?? '0'}× · ${h.firstPublicationDate ?? ''}`.trim(),
          passage: h.abstractText ?? '',
          url: `https://europepmc.org/article/${h.source}/${h.pmid}`,
          raw: { pmcid: h.pmcid ?? '', citedByCount: Number(h.citedByCount ?? 0), isReview, isOpenAccess: h.isOpenAccess === 'Y' },
          retrievedAt: now,
        };
      });
  },
};
```

In `packages/mcp-gateway/src/index.ts`, add:

```ts
export { europePmcSearchTool } from './europePmc.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/mcp-gateway test europePmc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/europePmc.ts packages/mcp-gateway/src/europePmc.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): Europe PMC search tool (citation-ranked, review flag, abstract passage)"
```

---

### Task 3: PMC full-text tool

**Files:**
- Create: `packages/mcp-gateway/src/pmcFullText.ts`
- Test: `packages/mcp-gateway/src/pmcFullText.test.ts`
- Modify: `packages/mcp-gateway/src/index.ts`
- Modify: `packages/mcp-gateway/package.json` (add `fast-xml-parser` dependency)

**Interfaces:**
- Consumes: `Tool`, `Evidence`.
- Produces: `pmcFullTextTool: Tool` (name `pmc_fulltext`). Input `{ pmcid: string }` (e.g. `PMC7897327`). Fetches JATS via NCBI efetch and returns one `Evidence` per body section, id `PMCID:<id>#sec-<n>`, `kind: 'publication'`, `passage` = section text, `locator` = section title.

- [ ] **Step 1: Add the dependency**

In `packages/mcp-gateway/package.json`, add to `dependencies`:

```json
    "fast-xml-parser": "^4.5.0"
```

Run: `pnpm install`
Expected: lockfile updates, `fast-xml-parser` resolves.

- [ ] **Step 2: Write the failing test**

`packages/mcp-gateway/src/pmcFullText.test.ts` (minimal JATS matching the real efetch `body → sec → title + p` shape):

```ts
import { describe, it, expect } from 'vitest';
import { pmcFullTextTool } from './pmcFullText.js';

const xml = `<?xml version="1.0"?><article><body>
  <sec><title>Introduction</title><p>CDCP1 is a CUB-domain transmembrane protein.</p></sec>
  <sec><title>Results</title><p>CDCP1 promotes EMT in NPC cells.</p><p>Knockdown reduced migration.</p></sec>
</body></article>`;

const fakeFetch = (async (url) => {
  expect(String(url)).toContain('efetch.fcgi');
  expect(String(url)).toContain('db=pmc');
  expect(String(url)).toContain('id=7897327');
  return new Response(xml, { status: 200 });
}) as unknown as typeof fetch;

describe('pmcFullTextTool', () => {
  it('returns one passage evidence per body section with title as locator', async () => {
    const out = await pmcFullTextTool.call({ pmcid: 'PMC7897327' }, fakeFetch);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('PMCID:PMC7897327#sec-0');
    expect(out[0].locator).toBe('Introduction');
    expect(out[0].passage).toContain('CUB-domain transmembrane protein');
    expect(out[1].locator).toBe('Results');
    expect(out[1].passage).toContain('promotes EMT');
    expect(out[1].passage).toContain('reduced migration');
  });

  it('returns [] when pmcid is missing', async () => {
    expect(await pmcFullTextTool.call({ pmcid: '' }, fakeFetch)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test pmcFullText`
Expected: FAIL - module does not exist.

- [ ] **Step 4: Implement**

`packages/mcp-gateway/src/pmcFullText.ts`:

```ts
import { XMLParser } from 'fast-xml-parser';
import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const parser = new XMLParser({ ignoreAttributes: true, textNodeName: '#text' });

// Flatten any nested node into plain text, joining all string fragments in order.
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') return Object.values(node as Record<string, unknown>).map(textOf).join(' ');
  return '';
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

export const pmcFullTextTool: Tool = {
  name: 'pmc_fulltext',
  description: 'Fetch the full text of an open-access PMC article (by PMC id) and return its body sections as passages for grounding.',
  async call(args, fetchImpl = fetch) {
    const pmcid = String(args.pmcid ?? '').trim();
    if (!pmcid) return [];
    const numeric = pmcid.replace(/^PMC/i, '');
    const res = await fetchImpl(`${EFETCH}?db=pmc&id=${encodeURIComponent(numeric)}&rettype=full&retmode=xml`);
    if (!res.ok) throw new Error(`PMC efetch HTTP ${res.status}`);
    const xml = await res.text();
    const doc = parser.parse(xml) as Record<string, unknown>;
    const article = (doc.article ?? doc) as Record<string, unknown>;
    const body = (article.body ?? {}) as Record<string, unknown>;
    const secs = asArray(body.sec as unknown);
    const now = new Date().toISOString();
    const out: Evidence[] = [];
    secs.forEach((sec, i) => {
      const s = sec as Record<string, unknown>;
      const title = textOf(s.title).trim() || `Section ${i + 1}`;
      const passage = asArray(s.p as unknown).map(textOf).join(' ').replace(/\s+/g, ' ').trim();
      if (!passage) return;
      out.push({
        id: `PMCID:${pmcid}#sec-${i}`, kind: 'publication', source: 'PMC full text',
        title, snippet: title, passage, locator: title,
        url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`,
        raw: { pmcid, sectionIndex: i }, retrievedAt: now,
      });
    });
    return out;
  },
};
```

In `packages/mcp-gateway/src/index.ts`, add:

```ts
export { pmcFullTextTool } from './pmcFullText.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sonny/mcp-gateway test pmcFullText`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-gateway/src/pmcFullText.ts packages/mcp-gateway/src/pmcFullText.test.ts packages/mcp-gateway/src/index.ts packages/mcp-gateway/package.json
git commit -m "feat(mcp-gateway): PMC full-text tool — JATS body sections as grounded passages"
```

---

### Task 4: Research-loop trace events

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts` (add a type-level usage test)

**Interfaces:**
- Produces: three new `TraceEvent` variants:
  - `{ type: 'research_plan'; specialist: string; questions: string[] }`
  - `{ type: 'research_read'; specialist: string; sourceId: string; locator: string }`
  - `{ type: 'research_reflect'; specialist: string; note: string; followups: string[] }`

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/contracts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from './contracts.js';

describe('research trace events', () => {
  it('accepts research_plan, research_read, research_reflect', () => {
    const events: TraceEvent[] = [
      { type: 'research_plan', specialist: 'target_biology', questions: ['what is the MOA?'] },
      { type: 'research_read', specialist: 'target_biology', sourceId: 'PMCID:PMC1#sec-0', locator: 'Results' },
      { type: 'research_reflect', specialist: 'target_biology', note: 'genetics weak vs literature', followups: ['check resistance'] },
    ];
    expect(events.map((e) => e.type)).toEqual(['research_plan', 'research_read', 'research_reflect']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/shared test contracts`
Expected: FAIL - TypeScript rejects the unknown variants (test does not compile).

- [ ] **Step 3: Implement**

In `packages/shared/src/contracts.ts`, add to the `TraceEvent` union:

```ts
  | { type: 'research_plan'; specialist: string; questions: string[] }
  | { type: 'research_read'; specialist: string; sourceId: string; locator: string }
  | { type: 'research_reflect'; specialist: string; note: string; followups: string[] }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/shared test contracts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): research-loop trace events (plan, read, reflect)"
```

---

### Task 5: Researcher - plan and extract (one round)

**Files:**
- Create: `packages/core/src/researcher.ts`
- Test: `packages/core/src/researcher.test.ts`

**Interfaces:**
- Consumes: `StructuredModel`, `MODEL_ROUTER`, `ClaimsSchema`, `Claim`, `EvidenceStore`.
- Produces:
  - `interface ThreadBrief { id: string; title: string; objective: string; promptHint: string }`
  - `planResearchQuestions(brief: ThreadBrief, target: string, model: StructuredModel): Promise<string[]>`
  - `extractClaims(question: string, evidenceList: string, model: StructuredModel): Promise<Claim[]>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/researcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { StructuredModel } from './model.js';
import { planResearchQuestions, extractClaims, type ThreadBrief } from './researcher.js';

const brief: ThreadBrief = {
  id: 'target_biology', title: 'Target Biology',
  objective: 'Characterize the target biology and MOA.',
  promptHint: 'Describe structure, MOA, expression.',
};

function modelReturning(value: unknown): StructuredModel {
  return { async generateStructured() { return value as never; } };
}

describe('planResearchQuestions', () => {
  it('returns the planned questions and includes the target in the prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) { prompt = opts.prompt; return { questions: ['What is the MOA of CDCP1?'] } as never; },
    };
    const qs = await planResearchQuestions(brief, 'CDCP1', model);
    expect(qs).toEqual(['What is the MOA of CDCP1?']);
    expect(prompt).toContain('CDCP1');
    expect(prompt).toContain('Target Biology');
  });
});

describe('extractClaims', () => {
  it('returns claims as drafted by the model', async () => {
    const model = modelReturning({ claims: [
      { id: 'c1', text: 'CDCP1 drives EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 },
    ] });
    const claims = await extractClaims('What is the MOA?', '[PMCID:PMC1#sec-1] (Results) ...', model);
    expect(claims).toHaveLength(1);
    expect(claims[0].citations).toEqual(['PMCID:PMC1#sec-1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test researcher`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/researcher.ts`:

```ts
import { z } from 'zod';
import { ClaimsSchema, type Claim } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

export interface ThreadBrief { id: string; title: string; objective: string; promptHint: string }

const QuestionsSchema = z.object({ questions: z.array(z.string().min(1)).min(1).max(5) });

export async function planResearchQuestions(
  brief: ThreadBrief, target: string, model: StructuredModel,
): Promise<string[]> {
  const { questions } = await model.generateStructured({
    system: `You are the ${brief.title} research specialist. ${brief.promptHint}\nPlan the specific, answerable research questions you must investigate to assess this target at expert depth. Each question must be precise enough to drive a literature search.`,
    prompt: `TARGET: ${target}\nOBJECTIVE: ${brief.objective}\nList up to 5 research questions, most important first.`,
    schema: QuestionsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return questions;
}

export async function extractClaims(
  question: string, evidenceList: string, model: StructuredModel,
): Promise<Claim[]> {
  const { claims } = await model.generateStructured({
    system: `You are a rigorous biomedical research specialist. Answer the research question using ONLY the provided evidence passages. Every claim MUST cite the evidence id(s) it rests on, copied verbatim. If the evidence conflicts, write a reconciliation claim that names the tension and states which way it leans and why. Do not state anything the evidence does not support.`,
    prompt: `RESEARCH QUESTION: ${question}\n\nEVIDENCE:\n${evidenceList}\n\nReturn claims c1, c2, ... each with citations and a confidence in [0,1].`,
    schema: ClaimsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return claims;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test researcher`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/researcher.ts packages/core/src/researcher.test.ts
git commit -m "feat(core): researcher plan + extract (question planning, grounded claim extraction)"
```

---

### Task 6: Researcher - reflect and loop

**Files:**
- Modify: `packages/core/src/researcher.ts`
- Modify: `packages/core/src/researcher.test.ts`

**Interfaces:**
- Consumes: `Tool` (from `@sonny/mcp-gateway`), `EvidenceStore`, `TraceEvent`, the Task 5 functions.
- Produces:
  - `interface ResearchBudget { maxRounds: number }`
  - `interface ThreadFindings { takeaway: string; claims: Claim[]; openQuestions: string[] }`
  - `reflectOnGaps(brief, claims, model): Promise<{ done: boolean; followups: string[]; takeaway: string }>`
  - `runResearcher(opts): Promise<ThreadFindings>` where `opts = { brief, target, tools, store, model, emit, budget }`. `tools` must include one named `europepmc_search` and one named `pmc_fulltext`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/researcher.test.ts`:

```ts
import { EvidenceStore } from './evidenceStore.js';
import { runResearcher } from './researcher.js';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

describe('runResearcher loop', () => {
  it('plans, reads full text, extracts grounded claims, reflects, and stops when done', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1', snippet: '',
        passage: 'abstract', url: 'u', raw: { pmcid: 'PMC1', isReview: false, isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Results',
        snippet: 'Results', passage: 'CDCP1 promotes EMT.', locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);

    const replies = [
      { questions: ['What is the MOA of CDCP1?'] },                                   // plan
      { claims: [{ id: 'c1', text: 'CDCP1 promotes EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] }, // extract
      { done: true, followups: [], takeaway: 'CDCP1 is an EMT driver.' },             // reflect
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    const events: TraceEvent[] = [];
    const findings = await runResearcher({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, emit: (e) => events.push(e), budget: { maxRounds: 3 },
    });

    expect(findings.takeaway).toBe('CDCP1 is an EMT driver.');
    expect(findings.claims.map((c) => c.id)).toEqual(['c1']);
    expect(events.map((e) => e.type)).toContain('research_plan');
    expect(events.map((e) => e.type)).toContain('research_read');
    expect(events.map((e) => e.type)).toContain('research_reflect');
  });

  it('always halts at maxRounds even if the model never says done', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'x', snippet: '',
        passage: 'a', url: 'u', raw: { pmcid: 'PMC1' }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'S',
        snippet: 'S', passage: 'p', locator: 'S', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const model = {
      async generateStructured(opts: { schema: { safeParse?: unknown } }) {
        // plan -> one question; extract -> no claims; reflect -> never done, always a follow-up
        const sys = String((opts as { system?: string }).system ?? '');
        if (sys.includes('Plan the specific')) return { questions: ['q'] } as never;
        if (sys.includes('rigorous biomedical')) return { claims: [] } as never;
        return { done: false, followups: ['again'], takeaway: 't' } as never;
      },
    };
    const findings = await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, emit: () => {}, budget: { maxRounds: 2 },
    });
    expect(findings).toBeDefined(); // returned, did not loop forever
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test researcher`
Expected: FAIL - `runResearcher`/`reflectOnGaps` not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/researcher.ts`:

```ts
import type { Evidence, TraceEvent } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';
import type { Tool } from '@sonny/mcp-gateway';

export interface ResearchBudget { maxRounds: number }
export interface ThreadFindings { takeaway: string; claims: Claim[]; openQuestions: string[] }

const ReflectSchema = z.object({
  done: z.boolean(),
  followups: z.array(z.string().min(1)).max(3),
  takeaway: z.string(),
});

export async function reflectOnGaps(
  brief: ThreadBrief, claims: Claim[], model: StructuredModel,
): Promise<{ done: boolean; followups: string[]; takeaway: string }> {
  return model.generateStructured({
    system: `You are the ${brief.title} research lead reviewing your own progress. Decide whether the thread is sufficiently covered for expert-level assessment. If a critical question remains unanswered, or a source raised a new high-value thread (e.g. a resistance mechanism), list up to 3 follow-up questions. Otherwise set done=true. Always write a one-line takeaway summarizing the thread so far.`,
    prompt: `OBJECTIVE: ${brief.objective}\n\nCLAIMS SO FAR:\n${claims.map((c) => `- ${c.text}`).join('\n') || '(none yet)'}`,
    schema: ReflectSchema,
    model: MODEL_ROUTER.specialist,
  });
}

function evidenceLine(e: Evidence): string {
  return `[${e.id}]${e.locator ? ` (${e.locator})` : ''} ${e.title} — ${e.passage ?? e.snippet}`;
}

export async function runResearcher(opts: {
  brief: ThreadBrief; target: string; tools: Tool[]; store: EvidenceStore;
  model: StructuredModel; emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<ThreadFindings> {
  const { brief, target, tools, store, model, emit, budget } = opts;
  const search = tools.find((t) => t.name === 'europepmc_search');
  const fulltext = tools.find((t) => t.name === 'pmc_fulltext');
  if (!search || !fulltext) throw new Error('runResearcher requires europepmc_search and pmc_fulltext tools');

  emit({ type: 'specialist_start', specialist: brief.id });
  let openQuestions = await planResearchQuestions(brief, target, model);
  emit({ type: 'research_plan', specialist: brief.id, questions: openQuestions });

  const claims: Claim[] = [];
  let takeaway = '';

  for (let round = 0; round < budget.maxRounds && openQuestions.length > 0; round++) {
    const question = openQuestions[0];

    emit({ type: 'tool_call', tool: search.name, args: { query: `${target} ${question}` } });
    const hits = await search.call({ query: `${target} ${question}` });
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
    for (const h of hits) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }

    // Read the full text of the top open-access hit that has a PMC id.
    const top = hits.find((h) => (h.raw as { pmcid?: string; isOpenAccess?: boolean })?.pmcid && (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
    if (top) {
      const pmcid = (top.raw as { pmcid: string }).pmcid;
      emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
      const passages = await fulltext.call({ pmcid });
      emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
      for (const p of passages) {
        store.register(p);
        emit({ type: 'evidence_registered', id: p.id, title: p.title });
        emit({ type: 'research_read', specialist: brief.id, sourceId: p.id, locator: p.locator ?? p.title });
      }
    }

    const evidenceList = store.all().map(evidenceLine).join('\n');
    const drafted = await extractClaims(question, evidenceList, model);
    for (const c of drafted) { claims.push(c); emit({ type: 'claim_drafted', claim: c }); }

    const reflection = await reflectOnGaps(brief, claims, model);
    takeaway = reflection.takeaway;
    emit({ type: 'research_reflect', specialist: brief.id, note: reflection.takeaway, followups: reflection.followups });
    openQuestions = reflection.done ? [] : reflection.followups;
  }

  return { takeaway, claims, openQuestions };
}
```

Note: `@sonny/mcp-gateway` must be a dependency of `@sonny/core`. Confirm `packages/core/package.json` lists `"@sonny/mcp-gateway": "workspace:*"` under `dependencies`; if absent, add it and run `pnpm install`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test researcher`
Expected: PASS (both cases, including the maxRounds halt).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/researcher.ts packages/core/src/researcher.test.ts packages/core/package.json
git commit -m "feat(core): runResearcher — bounded plan-read-extract-reflect loop with full-text reads"
```

---

### Task 7: Section production and CLI

**Files:**
- Create: `packages/core/src/produceResearchSection.ts`
- Test: `packages/core/src/produceResearchSection.test.ts`
- Modify: `packages/core/src/index.ts`
- Create: `apps/cli/src/deep.ts`
- Create: `apps/cli/src/deep.test.ts`
- Modify: `apps/cli/src/run.ts`

**Interfaces:**
- Consumes: `runResearcher`, `groundClaims`, `verifyClaims`, `computeRag`, `Section`.
- Produces:
  - `produceResearchSection(opts): Promise<Section>` where `opts = { brief, target, tools, store, specialistModel, verifierModel, emit, budget }`.
  - CLI: `runDeep(target: string): Promise<void>` runs the Target Biology thread and prints the section + trace.

- [ ] **Step 1: Write the failing test (core)**

`packages/core/src/produceResearchSection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { produceResearchSection } from './produceResearchSection.js';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

describe('produceResearchSection', () => {
  it('runs the loop, grounds, verifies, and returns a RAG-rated section', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1', snippet: '',
        passage: 'abstract', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Results',
        snippet: 'Results', passage: 'CDCP1 promotes EMT.', locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);

    const specialistReplies = [
      { questions: ['What is the MOA?'] },
      { claims: [{ id: 'c1', text: 'CDCP1 promotes EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] },
      { done: true, followups: [], takeaway: 'CDCP1 drives EMT.' },
    ];
    let i = 0;
    const specialistModel = { async generateStructured() { return specialistReplies[i++] as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: 'ok' } as never; } };

    const events: TraceEvent[] = [];
    const section = await produceResearchSection({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: (e) => events.push(e), budget: { maxRounds: 2 },
    });

    expect(section.id).toBe('target_biology');
    expect(section.takeaway).toBe('CDCP1 drives EMT.');
    expect(section.claims.map((c) => c.id)).toEqual(['c1']);
    expect(section.sources).toContain('PMCID:PMC1#sec-1');
    expect(section.rag).toBe('amber'); // one supported claim, single source -> amber
    expect(events.some((e) => e.type === 'section_complete')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test produceResearchSection`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement (core)**

`packages/core/src/produceResearchSection.ts`:

```ts
import type { Claim, Section, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag } from './rag.js';
import { runResearcher, type ThreadBrief, type ResearchBudget } from './researcher.js';

export async function produceResearchSection(opts: {
  brief: ThreadBrief; target: string; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<Section> {
  const { brief, target, tools, store, specialistModel, verifierModel, emit, budget } = opts;
  const findings = await runResearcher({ brief, target, tools, store, model: specialistModel, emit, budget });

  const { shippable } = groundClaims(findings.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported: Claim[] = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  const sources = [...new Set(supported.flatMap((c) => c.citations))];
  const section: Section = {
    id: brief.id, title: brief.title, takeaway: findings.takeaway,
    claims: supported, sources, rag: computeRag(shippable, verdicts),
  };
  emit({ type: 'section_complete', section });
  return section;
}
```

In `packages/core/src/index.ts`, add:

```ts
export { planResearchQuestions, extractClaims, reflectOnGaps, runResearcher,
  type ThreadBrief, type ThreadFindings, type ResearchBudget } from './researcher.js';
export { produceResearchSection } from './produceResearchSection.js';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test produceResearchSection`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI trace test**

`apps/cli/src/deep.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { formatTrace } from './run.js';

describe('formatTrace research events', () => {
  it('renders research plan, read, and reflect lines', () => {
    const events: TraceEvent[] = [
      { type: 'research_plan', specialist: 'target_biology', questions: ['What is the MOA of CDCP1?'] },
      { type: 'research_read', specialist: 'target_biology', sourceId: 'PMCID:PMC1#sec-1', locator: 'Results' },
      { type: 'research_reflect', specialist: 'target_biology', note: 'EMT driver', followups: ['check resistance'] },
    ];
    const out = formatTrace(events);
    expect(out).toContain('What is the MOA of CDCP1?');
    expect(out).toContain('reading PMCID:PMC1#sec-1');
    expect(out).toContain('Results');
    expect(out).toContain('check resistance');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @sonny/cli test deep`
Expected: FAIL - `formatTrace` has no cases for the research events (they fall to `default`).

- [ ] **Step 7: Implement the CLI**

In `apps/cli/src/run.ts`, add cases inside the `formatTrace` switch (before `default`):

```ts
      case 'research_plan':
        return `  ▸ ${e.specialist} plan:\n` + e.questions.map((q) => `      ? ${q}`).join('\n');
      case 'research_read':
        return `      reading ${e.sourceId} (${e.locator})`;
      case 'research_reflect':
        return `      reflect: ${e.note}` + (e.followups.length ? `\n      follow-ups: ${e.followups.join('; ')}` : '');
```

Create `apps/cli/src/deep.ts`:

```ts
import { AnthropicModel, produceResearchSection } from '@sonny/core';
import { europePmcSearchTool, pmcFullTextTool } from '@sonny/mcp-gateway';
import { formatTrace } from './run.js';

export async function runDeep(target: string): Promise<void> {
  const t = target.trim() || 'CDCP1';
  const section = await produceResearchSection({
    brief: { id: 'target_biology', title: 'Target Biology',
      objective: `Assess the biology and mechanism of ${t} at expert depth.`,
      promptHint: 'Characterize the target: structure, mechanism of action, pathway, and expression.' },
    target: t, tools: [europePmcSearchTool, pmcFullTextTool],
    store: new (await import('@sonny/core')).EvidenceStore(),
    specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(),
    emit: (e) => process.stdout.write(formatTrace([e]) + '\n'),
    budget: { maxRounds: 4 },
  });
  process.stdout.write(`\n[${section.rag.toUpperCase()}] ${section.title}\n  ${section.takeaway}\n`);
}
```

In `apps/cli/src/run.ts`, dispatch the subcommand at the top of `main`:

```ts
  if (argv[2] === 'deep') {
    const { runDeep } = await import('./deep.js');
    await runDeep(argv.slice(3).join(' '));
    return;
  }
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @sonny/cli test deep`
Expected: PASS.

- [ ] **Step 9: Full suite + live smoke**

Run: `pnpm -r test`
Expected: every package green.

Live smoke (manual, needs a valid key):
```bash
ANTHROPIC_API_KEY=… pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1
```
Expected: a plan of research questions, full-text reads, reflection lines, then a RAG-rated Target Biology takeaway grounded in PMCID passages. (`apps/cli/src/index.ts` already calls `main(process.argv)`.)

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/produceResearchSection.ts packages/core/src/produceResearchSection.test.ts \
  packages/core/src/index.ts apps/cli/src/deep.ts apps/cli/src/deep.test.ts apps/cli/src/run.ts
git commit -m "feat: produceResearchSection + CLI deep command (full-text research loop, end to end)"
```

---

## What this slice deliberately does NOT do (next plans)

- **Lead orchestration**: parallel multi-specialist dispatch, completeness critic, gap-fillers, cross-thread weighing.
- **The full roster**: MOA & Pathway, Disease & Indications, Clinical Landscape, Competitive & IP - each as its own brief on these same rails.
- **Synthesis**: the recommendation (GO/WATCH/NO-GO, bull/bear), executive read, teaching narrative.
- **Patents**: the patent source and the Competitive & IP researcher.
- **Glass-box web UI**: the parallel-lane reasoning stream and the fixed evidence drawer (the web app still runs the old `runDossier`).
- **Expert-bar eval**: the decorrelated rubric scorer and the fixed target panel.

---

## Self-Review

- **Spec coverage (this slice):** passage-level evidence (Task 1), full-text reading via Europe PMC search + PMC efetch (Tasks 2-3), the plan-act-read-ground-reflect-loop (Tasks 5-6), passage-level grounding + decorrelated verifier + RAG (Task 7), live trace events (Task 4 + Task 7 CLI). Lead orchestration, synthesis, patents, web glass-box, and the eval are explicitly deferred and listed above.
- **Placeholder scan:** none - every step carries real code and a concrete command with expected result.
- **Type consistency:** `ThreadBrief`, `ThreadFindings`, `ResearchBudget`, and `runResearcher`'s option bag are defined once in Task 5/6 and consumed unchanged in Task 7; `Evidence.passage`/`locator` added in Task 1 are used by the verifier (Task 1) and the researcher's `evidenceLine` (Task 6); the three trace events declared in Task 4 are emitted in Task 6 and rendered in Task 7.
