# fillGap Deep-Read Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the slice-7 title-gate and passage-gate to the `fillGap` deep-read path so the gap-filler never deep-reads a paper whose title does not name the target.

**Architecture:** Mirror the gating already present in `runResearcher` into `fillGap` in `packages/core/src/completeness.ts`. Both helpers (`titleMentionsTarget`, `relevanceGate`) and the term set (`terms = targetTerms(store)`) already exist in scope.

**Tech Stack:** TypeScript ESM, Vitest. Test runner: `pnpm --filter @sonny/core test`.

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Surgical: touch only `packages/core/src/completeness.ts` and `packages/core/src/completeness.test.ts`.
- Reuse `titleMentionsTarget` and `relevanceGate`; no new logic.

---

### Task 1: Title-gate and passage-gate the fillGap deep-read

**Files:**
- Modify: `packages/core/src/completeness.ts` (import line ~11; deep-read block in `fillGap`)
- Test: `packages/core/src/completeness.test.ts`

**Interfaces:**
- Consumes: `titleMentionsTarget`, `relevanceGate`, `targetTerms` from `./relevance.js`.
- Produces: no signature change. `fillGap` deep-read behavior gains the title-gate and passage-gate.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/completeness.test.ts`:

```ts
import { titleMentionsTarget } from './relevance.js'; // ensure import graph wired

describe('fillGap deep-read gating', () => {
  function seededStore() {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: '', url: 'u', retrievedAt: 'now',
      raw: { approvedSymbol: 'CDCP1', synonyms: ['CD318'] } });
    return store;
  }

  it('does not deep-read a hit whose title lacks the target (passage-only match)', async () => {
    const search: Tool = { name: 'europepmc_search', description: '', async call() {
      return [
        { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'Generic proteomics survey', snippet: '',
          passage: 'CDCP1 was among the detected proteins.', url: 'u', raw: { pmcid: 'PMC9', isOpenAccess: true }, retrievedAt: 'now' },
      ] as never;
    } };
    let fulltextCalls = 0;
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { fulltextCalls++; return [] as never; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };

    await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', concept: 'proteomics', reason: 'r' },
      target: 'CDCP1', tools: [search, fulltext], store: seededStore(),
      specialistModel, verifierModel, emit: () => {},
    });

    expect(fulltextCalls).toBe(0); // title-gate skipped the deep-read
  });

  it('drops off-topic full-text sections before registering', async () => {
    const search: Tool = { name: 'europepmc_search', description: '', async call() {
      return [
        { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in pancreatic cancer', snippet: '',
          passage: 'CDCP1 is overexpressed.', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
      ] as never;
    } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() {
      return [
        { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 signaling', snippet: '',
          passage: 'CDCP1 promotes EMT.', locator: 'CDCP1 signaling', url: 'u', raw: {}, retrievedAt: 'now' },
        { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Cohort', snippet: '',
          passage: 'Patients with MIS-C after COVID showed elevated markers.', locator: 'Cohort', url: 'u', raw: {}, retrievedAt: 'now' },
      ] as never;
    } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };

    const store = seededStore();
    await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', concept: 'mechanism', reason: 'r' },
      target: 'CDCP1', tools: [search, fulltext], store,
      specialistModel, verifierModel, emit: () => {},
    });

    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMCID:PMC1#sec-0');     // on-target section registered
    expect(ids).not.toContain('PMCID:PMC1#sec-1'); // off-target MIS-C section dropped
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- completeness`
Expected: FAIL - today `fillGap` deep-reads the first PMC hit regardless of title (`fulltextCalls` is 1) and registers the off-topic section.

- [ ] **Step 3: Add the import**

In `packages/core/src/completeness.ts`, change the relevance import (line ~11):

```ts
import { targetTerms, relevanceGate, titleMentionsTarget } from './relevance.js';
```

- [ ] **Step 4: Gate the deep-read block**

In `fillGap`, replace the deep-read selection and the full-text call. Current:

```ts
  const top = hits.find((h) => (h.raw as { pmcid?: string; isOpenAccess?: boolean })?.pmcid && (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
  if (top) {
    const pmcid = (top.raw as { pmcid: string }).pmcid;
    emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
    const passages = await safeToolCall({ tool: fulltext, args: { pmcid }, emit });
    emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
```

becomes:

```ts
  const top = hits.find((h) =>
    titleMentionsTarget(h, terms) &&
    (h.raw as { pmcid?: string })?.pmcid &&
    (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
  if (top) {
    const pmcid = (top.raw as { pmcid: string }).pmcid;
    emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
    const passages = relevanceGate(await safeToolCall({ tool: fulltext, args: { pmcid }, emit }), terms);
    emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
```

(Leave the `for (const p of passages)` registration loop unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- completeness`
Expected: PASS - both new cases pass; existing `fillGap` cases (their hits use title `'CDCP1 resistance'` or have empty `terms`) still pass.

- [ ] **Step 6: Run the full core suite**

Run: `pnpm --filter @sonny/core test`
Expected: PASS - all core tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/completeness.ts packages/core/src/completeness.test.ts
git commit -m "feat(core): title-gate and passage-gate the fillGap deep-read"
```

---

## Notes for the controller

- A free local smoke (`SONNY_BACKEND=ollama pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1`) confirms the gap-filler no longer deep-reads off-target papers. Validation, not a task.
- Out of scope: reference snowball, confidence clamp.
