# Citation Snowball Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a thread deep-reads its first seminal paper, follow forward citations one hop to register related on-target papers.

**Architecture:** A new `europepmc_citations` tool returns a seed's citing papers (title-only). A `snowballCitations` step title-gates them, hydrates the top 3 via `EXT_ID` search to get abstract + pmcid, and registers them. `runResearcher` calls it once per thread, on the first deep-read.

**Tech Stack:** TypeScript ESM, Vitest. Test runners: `pnpm --filter @sonny/mcp-gateway test`, `pnpm --filter @sonny/core test`.

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Reuse `relevanceGate` and `safeToolCall`; no new logic or trace-event types.
- Tools take `(args, fetchImpl = fetch)` and throw on non-OK HTTP so `safeToolCall` isolates them.

---

### Task 1: europepmc_citations tool

**Files:**
- Create: `packages/mcp-gateway/src/europePmcCitations.ts`
- Test: `packages/mcp-gateway/src/europePmcCitations.test.ts`
- Modify: `packages/mcp-gateway/src/index.ts` (export the tool)

**Interfaces:**
- Produces: `europePmcCitationsTool: Tool` (name `europepmc_citations`). `call({ pmid })` returns `Evidence[]` of MED citers, each `{ id: 'PMID:<id>', kind: 'publication', title, snippet, passage: '', url, raw: { citedByCount, pubYear } }`.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-gateway/src/europePmcCitations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { europePmcCitationsTool } from './europePmcCitations.js';

const payload = { citationList: { citation: [
  { id: '41091621', source: 'MED', title: 'CDCP1 degrader conjugates.', citedByCount: 5, pubYear: '2025' },
  { id: '40725832', source: 'MED', title: 'CD318 in tumor immunity.', citedByCount: 3, pubYear: '2025' },
  { id: 'PPR9', source: 'PPR', title: 'A preprint.', citedByCount: 0, pubYear: '2025' },
] } };

const fakeFetch = (async (url: string) => {
  expect(String(url)).toContain('/MED/11466621/citations');
  return new Response(JSON.stringify(payload), { status: 200 });
}) as unknown as typeof fetch;

describe('europePmcCitationsTool', () => {
  it('maps MED citers to PMID evidence with empty passage and drops non-MED entries', async () => {
    const out = await europePmcCitationsTool.call({ pmid: '11466621' }, fakeFetch);
    expect(out.map((e) => e.id)).toEqual(['PMID:41091621', 'PMID:40725832']);
    expect(out[0].passage).toBe('');
    expect((out[0].raw as { citedByCount: number }).citedByCount).toBe(5);
  });

  it('returns [] for an empty pmid without fetching', async () => {
    const out = await europePmcCitationsTool.call({ pmid: '' }, fakeFetch);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test -- europePmcCitations`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement the tool**

Create `packages/mcp-gateway/src/europePmcCitations.ts`:

```ts
import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

interface Citer { id?: string; source?: string; title?: string; citedByCount?: number; pubYear?: string }

export const europePmcCitationsTool: Tool = {
  name: 'europepmc_citations',
  description: 'Fetch the papers that cite a given PMID (forward citations), ranked by citation count, for snowball expansion. Returns title-only evidence; hydrate via europepmc_search EXT_ID for abstracts.',
  async call(args, fetchImpl = fetch) {
    const pmid = String(args.pmid ?? '').trim();
    if (!pmid) return [];
    const url = `${BASE}/MED/${encodeURIComponent(pmid)}/citations?format=json&pageSize=8&sort=${encodeURIComponent('CITED desc')}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Europe PMC citations HTTP ${res.status}`);
    const list = (((await res.json()) as { citationList?: { citation?: Citer[] } }).citationList?.citation) ?? [];
    const now = new Date().toISOString();
    return list
      .filter((c) => c.id && c.source === 'MED')
      .map<Evidence>((c) => ({
        id: `PMID:${c.id}`, kind: 'publication', source: 'Europe PMC',
        title: c.title ?? '(no title)',
        snippet: `cited ${c.citedByCount ?? 0}x . ${c.pubYear ?? ''}`.trim(),
        passage: '',
        url: `https://europepmc.org/article/MED/${c.id}`,
        raw: { citedByCount: Number(c.citedByCount ?? 0), pubYear: c.pubYear ?? '' },
        retrievedAt: now,
      }));
  },
};
```

- [ ] **Step 4: Export the tool**

In `packages/mcp-gateway/src/index.ts`, add after the `europePmcSearchTool` export:

```ts
export { europePmcCitationsTool } from './europePmcCitations.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @sonny/mcp-gateway test -- europePmcCitations`
Expected: PASS - both cases green.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-gateway/src/europePmcCitations.ts packages/mcp-gateway/src/europePmcCitations.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): add europepmc_citations forward-citations tool"
```

---

### Task 2: snowballCitations step and runResearcher wire-in

**Files:**
- Create: `packages/core/src/snowball.ts`
- Test: `packages/core/src/snowball.test.ts`
- Modify: `packages/core/src/researcher.ts` (import; `snowballed` guard; call in the deep-read block)
- Test: `packages/core/src/researcher.test.ts`
- Modify: `apps/cli/src/deep.ts` (add the tool to `literatureTools`)

**Interfaces:**
- Consumes: `relevanceGate` from `./relevance.js`; `safeToolCall` from `./safeToolCall.js`.
- Produces: `snowballCitations(opts: { seed: Evidence; terms: string[]; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/snowball.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { snowballCitations } from './snowball.js';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}
const seed: Evidence = { id: 'PMID:111', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 seminal', snippet: '', passage: 'CDCP1', url: 'u', raw: {}, retrievedAt: 'now' };

describe('snowballCitations', () => {
  it('title-gates citers and hydrates the top 3 into the store', async () => {
    const citations = tool('europepmc_citations', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in NPC', snippet: '', passage: '', url: 'u', raw: {}, retrievedAt: 'now' },
      { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'unrelated immunology', snippet: '', passage: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    // hydrate returns the full record for whichever EXT_ID was asked; here a CDCP1 paper.
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in NPC', snippet: '', passage: 'CDCP1 drives NPC.', url: 'u', raw: { pmcid: 'PMCX', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const store = new EvidenceStore();
    await snowballCitations({ seed, terms: ['cdcp1'], tools: [citations, search], store, emit: () => {} });
    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMID:1');     // on-target citer hydrated + registered
    expect(ids).not.toContain('PMID:2'); // off-target citer dropped at the title gate
  });

  it('returns without throwing when the citations tool is absent', async () => {
    const search = tool('europepmc_search', []);
    await expect(snowballCitations({ seed, terms: ['cdcp1'], tools: [search], store: new EvidenceStore(), emit: () => {} })).resolves.toBeUndefined();
  });

  it('returns without effect when the seed has no PMID prefix', async () => {
    const citations = tool('europepmc_citations', []);
    const search = tool('europepmc_search', []);
    const nonPmidSeed: Evidence = { ...seed, id: 'PMCID:PMC1#sec-0' };
    const store = new EvidenceStore();
    await snowballCitations({ seed: nonPmidSeed, terms: ['cdcp1'], tools: [citations, search], store, emit: () => {} });
    expect(store.all()).toEqual([]);
  });
});
```

Append to `packages/core/src/researcher.test.ts`, inside the `describe('runResearcher loop', ...)` block:

```ts
it('snowballs only once per thread even across multiple deep-reads', async () => {
  const search = tool('europepmc_search', [
    { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 cancer', snippet: '', passage: 'CDCP1', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
  ]);
  const fulltext = tool('pmc_fulltext', [
    { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 sec', snippet: '', passage: 'CDCP1 promotes EMT.', locator: 'CDCP1 sec', url: 'u', raw: {}, retrievedAt: 'now' },
  ]);
  let citeCalls = 0;
  const citations: Tool = { name: 'europepmc_citations', description: '', async call() { citeCalls++; return [] as never; } };
  const replies = [
    { questions: [{ question: 'q', concept: 'mechanism' }] },                            // plan
    { claims: [] },                                                                       // extract r1
    { done: false, followups: [{ question: 'q2', concept: 'invasion' }], takeaway: 't' }, // reflect r1
    { claims: [] },                                                                       // extract r2
    { done: true, followups: [], takeaway: 't2' },                                        // reflect r2
  ];
  let i = 0;
  const model = { async generateStructured() { return replies[i++] as never; } };
  await runResearcher({
    brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
    target: 'CDCP1', tools: [search, fulltext, citations], store: new EvidenceStore(),
    model, emit: () => {}, budget: { maxRounds: 2 },
  });
  expect(citeCalls).toBe(1); // snowball fired once despite two deep-reads
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- "snowball|researcher"`
Expected: FAIL - `snowballCitations` not defined; `citeCalls` is 0 (no snowball wired).

- [ ] **Step 3: Create snowball.ts**

Create `packages/core/src/snowball.ts`:

```ts
import type { Evidence, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { safeToolCall } from './safeToolCall.js';
import { relevanceGate } from './relevance.js';

// Follow forward citations of a seed paper one hop: title-gate the citers (they carry
// no abstract), hydrate the top 3 via EXT_ID search to get abstract + pmcid, register.
export async function snowballCitations(opts: {
  seed: Evidence; terms: string[]; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void;
}): Promise<void> {
  const { seed, terms, tools, store, emit } = opts;
  const citationsTool = tools.find((t) => t.name === 'europepmc_citations');
  const search = tools.find((t) => t.name === 'europepmc_search');
  if (!citationsTool || !search) return;
  const pmid = seed.id.replace(/^PMID:/, '');
  if (!pmid || pmid === seed.id) return; // seed is not a PMID-keyed paper

  emit({ type: 'tool_call', tool: citationsTool.name, args: { pmid } });
  const citers = relevanceGate(await safeToolCall({ tool: citationsTool, args: { pmid }, emit }), terms);
  emit({ type: 'tool_result', tool: citationsTool.name, count: citers.length });

  for (const c of citers.slice(0, 3)) {
    const extId = c.id.replace(/^PMID:/, '');
    const query = `EXT_ID:${extId} AND SRC:MED`;
    emit({ type: 'tool_call', tool: search.name, args: { query } });
    const hydrated = relevanceGate(await safeToolCall({ tool: search, args: { query }, emit }), terms);
    emit({ type: 'tool_result', tool: search.name, count: hydrated.length });
    for (const h of hydrated) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }
  }
}
```

- [ ] **Step 4: Wire into runResearcher**

In `packages/core/src/researcher.ts`:

1. Add the import near the relevance import:

```ts
import { snowballCitations } from './snowball.js';
```

2. Before the `for (let round = ...)` loop, declare the once-per-thread guard:

```ts
  let snowballed = false;
```

3. Inside the `if (top) { ... }` deep-read block, after the `for (const p of passages)` registration loop closes (still inside `if (top)`), add:

```ts
      if (!snowballed) {
        snowballed = true;
        await snowballCitations({ seed: top, terms, tools, store, emit });
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- "snowball|researcher"`
Expected: PASS - snowball cases green; the researcher snowball-once case shows `citeCalls === 1`.

- [ ] **Step 6: Register the tool in the CLI**

In `apps/cli/src/deep.ts`, import `europePmcCitationsTool` and add it to `literatureTools`:

```ts
import { europePmcSearchTool, pmcFullTextTool, openTargetsTargetTool, clinicalTrialsTool, europePmcCitationsTool } from '@sonny/mcp-gateway';
```

and change the `literatureTools` array to include it:

```ts
    literatureTools: [europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool],
```

- [ ] **Step 7: Run the full core + cli suites**

Run: `pnpm --filter @sonny/core test && pnpm --filter @sonny/cli test`
Expected: PASS - all green.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/snowball.ts packages/core/src/snowball.test.ts packages/core/src/researcher.ts packages/core/src/researcher.test.ts apps/cli/src/deep.ts
git commit -m "feat(core): snowball forward citations once per thread after first deep-read"
```

---

## Notes for the controller

- After both tasks, run `pnpm -r test` before the whole-branch review.
- A free local smoke (`SONNY_BACKEND=ollama pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1`) confirms `europepmc_citations` fires after a thread's first deep-read, followed by `EXT_ID:` hydration searches, with citation-neighbor papers appearing in the references.
- Out of scope: backward references, recursive snowball, specialty-lab detection, confidence clamp.
