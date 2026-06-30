# Review-First Orientation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a review article on the target before the specialists run, seeding broad biology/disease/indication framing into the shared evidence store.

**Architecture:** A `buildReviewQuery` helper plus an `orientWithReview` step wired into `runDeepResearch` after structured seeding. Reuses the existing search/fulltext tools, relevance gate, title-gate, and `safeToolCall`.

**Tech Stack:** TypeScript ESM, Vitest. Test runner: `pnpm --filter @sonny/core test`.

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Surgical: touch only `searchQuery.ts`, `searchQuery.test.ts`, new `orientation.ts`, new `orientation.test.ts`, `runDeepResearch.ts`.
- Reuse `targetTerms`, `relevanceGate`, `titleMentionsTarget`, `safeToolCall`; no new logic or trace-event types.

---

### Task 1: buildReviewQuery, orientWithReview, and wire-in

**Files:**
- Modify: `packages/core/src/searchQuery.ts`
- Test: `packages/core/src/searchQuery.test.ts`
- Create: `packages/core/src/orientation.ts`
- Test: `packages/core/src/orientation.test.ts`
- Modify: `packages/core/src/runDeepResearch.ts:31` (add the orientation call)

**Interfaces:**
- Produces: `buildReviewQuery(target: string): string`; `orientWithReview(opts: { target: string; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void }): Promise<void>`.
- Consumes: `targetTerms`, `relevanceGate`, `titleMentionsTarget` from `./relevance.js`; `safeToolCall` from `./safeToolCall.js`; `buildReviewQuery` from `./searchQuery.js`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/searchQuery.test.ts`:

```ts
import { buildReviewQuery } from './searchQuery.js';

describe('buildReviewQuery', () => {
  it('builds a TITLE_ABS target query constrained to review publications', () => {
    expect(buildReviewQuery('CDCP1')).toBe('TITLE_ABS:CDCP1 AND PUB_TYPE:"review"');
  });
});
```

Create `packages/core/src/orientation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { orientWithReview } from './orientation.js';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

function seededStore() {
  const store = new EvidenceStore();
  store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: '', url: 'u', retrievedAt: 'now',
    raw: { approvedSymbol: 'CDCP1', synonyms: ['CD318'] } });
  return store;
}

describe('orientWithReview', () => {
  it('registers the top 2 target-mentioning review abstracts', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'The CDCP1 signaling hub review', snippet: '', passage: 'CDCP1 landscape', url: 'u', raw: { pmcid: '', isReview: true, isOpenAccess: false }, retrievedAt: 'now' },
      { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in cancer review', snippet: '', passage: 'CDCP1 overview', url: 'u', raw: { pmcid: '', isReview: true, isOpenAccess: false }, retrievedAt: 'now' },
      { id: 'PMID:3', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 roles review', snippet: '', passage: 'CDCP1 roles', url: 'u', raw: { pmcid: '', isReview: true, isOpenAccess: false }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', []);
    const store = seededStore();
    await orientWithReview({ target: 'CDCP1', tools: [search, fulltext], store, emit: () => {} });
    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMID:1');
    expect(ids).toContain('PMID:2');
    expect(ids).not.toContain('PMID:3'); // only top 2 registered
  });

  it('deep-reads an open-access review whose title names the target and drops off-topic sections', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'The CDCP1 signaling hub review', snippet: '', passage: 'CDCP1 landscape', url: 'u', raw: { pmcid: 'PMC1', isReview: true, isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 biology', snippet: '', passage: 'CDCP1 drives invasion.', locator: 'CDCP1 biology', url: 'u', raw: {}, retrievedAt: 'now' },
      { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Acknowledgements', snippet: '', passage: 'We thank the funders.', locator: 'Acknowledgements', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const events: TraceEvent[] = [];
    const store = seededStore();
    await orientWithReview({ target: 'CDCP1', tools: [search, fulltext], store, emit: (e) => events.push(e) });
    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMCID:PMC1#sec-0');       // on-target section read
    expect(ids).not.toContain('PMCID:PMC1#sec-1');   // off-topic section dropped
    expect(events.some((e) => e.type === 'research_read')).toBe(true);
  });

  it('does not deep-read when no review is open-access', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 review', snippet: '', passage: 'CDCP1', url: 'u', raw: { pmcid: '', isReview: true, isOpenAccess: false }, retrievedAt: 'now' },
    ]);
    let fulltextCalls = 0;
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { fulltextCalls++; return [] as never; } };
    await orientWithReview({ target: 'CDCP1', tools: [search, fulltext], store: seededStore(), emit: () => {} });
    expect(fulltextCalls).toBe(0);
  });

  it('returns without throwing when the literature tools are absent', async () => {
    await expect(orientWithReview({ target: 'CDCP1', tools: [], store: seededStore(), emit: () => {} })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- "searchQuery|orientation"`
Expected: FAIL - `buildReviewQuery` and `orientWithReview` are not defined.

- [ ] **Step 3: Add buildReviewQuery**

Append to `packages/core/src/searchQuery.ts`:

```ts
// Find review articles on the target: pin the target to TITLE_ABS and constrain to
// review publications. PUB_TYPE:"review" returns actual reviews; free-text "review"
// returns primary papers that merely use the word.
export function buildReviewQuery(target: string): string {
  return `TITLE_ABS:${target} AND PUB_TYPE:"review"`;
}
```

- [ ] **Step 4: Create orientation.ts**

Create `packages/core/src/orientation.ts`:

```ts
import type { TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { safeToolCall } from './safeToolCall.js';
import { targetTerms, relevanceGate, titleMentionsTarget } from './relevance.js';
import { buildReviewQuery } from './searchQuery.js';

// Read a review on the target before the specialists run, so the shared store carries
// the broad biology/disease/indication framing a scientist gets from a review first.
export async function orientWithReview(opts: {
  target: string; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void;
}): Promise<void> {
  const { target, tools, store, emit } = opts;
  const search = tools.find((t) => t.name === 'europepmc_search');
  const fulltext = tools.find((t) => t.name === 'pmc_fulltext');
  if (!search || !fulltext) return;

  const terms = targetTerms(store, target);
  const query = buildReviewQuery(target);
  emit({ type: 'tool_call', tool: search.name, args: { query } });
  const hits = relevanceGate(await safeToolCall({ tool: search, args: { query }, emit }), terms);
  emit({ type: 'tool_result', tool: search.name, count: hits.length });

  // Register the top K review abstracts as shared orientation evidence.
  const top = hits.slice(0, 2);
  for (const h of top) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }

  // Deep-read the top open-access review whose title names the target, for the full landscape.
  const readable = top.find((h) =>
    titleMentionsTarget(h, terms) &&
    (h.raw as { pmcid?: string })?.pmcid &&
    (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
  if (readable) {
    const pmcid = (readable.raw as { pmcid: string }).pmcid;
    emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
    const passages = relevanceGate(await safeToolCall({ tool: fulltext, args: { pmcid }, emit }), terms);
    emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
    for (const p of passages) {
      store.register(p);
      emit({ type: 'evidence_registered', id: p.id, title: p.title });
      emit({ type: 'research_read', specialist: 'orientation', sourceId: p.id, locator: p.locator ?? p.title });
    }
  }
}
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- "searchQuery|orientation"`
Expected: PASS - `buildReviewQuery` and all 4 `orientWithReview` cases green.

- [ ] **Step 6: Wire orientation into runDeepResearch**

In `packages/core/src/runDeepResearch.ts`, add the import (after the `seedStructuredEvidence` import, line ~7):

```ts
import { orientWithReview } from './orientation.js';
```

Then, immediately after the `seedStructuredEvidence` call (line ~31), add:

```ts
  try {
    await orientWithReview({ target, tools: literatureTools, store, emit });
  } catch (err) {
    emit({ type: 'error', message: `orientation failed: ${String(err)}` });
  }
```

- [ ] **Step 7: Run the full core suite**

Run: `pnpm --filter @sonny/core test`
Expected: PASS - all core tests green. Existing `runDeepResearch` tests are unaffected: their mock search hits do not mention the target, so the orientation gate registers nothing.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/searchQuery.ts packages/core/src/searchQuery.test.ts packages/core/src/orientation.ts packages/core/src/orientation.test.ts packages/core/src/runDeepResearch.ts
git commit -m "feat(core): orient with a review before specialists run"
```

---

## Notes for the controller

- A free local smoke (`SONNY_BACKEND=ollama pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1`) confirms a `TITLE_ABS:CDCP1 AND PUB_TYPE:"review"` search fires first and review evidence is registered before the specialists.
- Out of scope: reference snowball, specialty-lab detection, confidence clamp.
