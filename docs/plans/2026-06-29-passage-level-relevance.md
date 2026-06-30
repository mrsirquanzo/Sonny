# Passage-Level Relevance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop off-topic full-text from entering the evidence store by title-gating which paper gets deep-read and passage-gating its sections, reusing the existing target-term set.

**Architecture:** Two changes. (1) Extract the gate's match logic into a pure `mentionsAny` predicate and add `titleMentionsTarget`, both in `relevance.ts`. (2) In `runResearcher`, select the paper to deep-read by title match (strict: skip the full-text call when none qualifies) and pass the returned sections through `relevanceGate` before registering them.

**Tech Stack:** TypeScript ESM (Node 20+), Vitest, Zod. Source-first packages. Test runner: `pnpm --filter @sonny/core test`.

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add the agent as a commit co-author.
- ESM imports use the `.js` extension on relative paths (e.g. `./relevance.js`).
- Surgical changes only; touch only the lines the task names. Match existing style.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Reuse the existing `targetTerms`/`relevanceGate`; introduce no new tuning knobs or thresholds.
- The empty-terms contract is load-bearing: with no terms known, every relevance check is a no-op (returns everything / true).

---

### Task 1: Shared match core and title predicate

**Files:**
- Modify: `packages/core/src/relevance.ts`
- Test: `packages/core/src/relevance.test.ts`

**Interfaces:**
- Consumes: `Evidence` from `@sonny/shared`.
- Produces:
  - `mentionsAny(text: string, terms: string[]): boolean` - case-insensitive substring match; `terms.length === 0` returns `true`.
  - `titleMentionsTarget(e: Evidence, terms: string[]): boolean` - `mentionsAny(e.title, terms)`.
  - `relevanceGate(hits: Evidence[], terms: string[]): Evidence[]` - unchanged behavior, now built on `mentionsAny`.
  - `targetTerms` - unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/relevance.test.ts`:

```ts
import { mentionsAny, titleMentionsTarget } from './relevance.js';

describe('mentionsAny', () => {
  it('returns true for a case-insensitive substring hit', () => {
    expect(mentionsAny('The CDCP1 receptor', ['cdcp1'])).toBe(true);
  });

  it('returns false when no term is present', () => {
    expect(mentionsAny('m6A RNA methylation', ['cdcp1', 'cd318'])).toBe(false);
  });

  it('returns true (no-op) when there are no terms', () => {
    expect(mentionsAny('anything at all', [])).toBe(true);
  });
});

describe('titleMentionsTarget', () => {
  const ev = (title: string, passage: string): Evidence =>
    ({ id: 'x', kind: 'publication', source: 's', title, snippet: '', passage, url: 'u', raw: {}, retrievedAt: 'now' });

  it('matches on the title only, ignoring passage and snippet', () => {
    expect(titleMentionsTarget(ev('CDCP1 in cancer', 'no mention here'), ['cdcp1'])).toBe(true);
    expect(titleMentionsTarget(ev('Generic proteomics', 'CDCP1 was detected'), ['cdcp1'])).toBe(false);
  });

  it('matches an alias in the title', () => {
    expect(titleMentionsTarget(ev('TRASK drives EMT', ''), ['cdcp1', 'trask'])).toBe(true);
  });

  it('returns true (no-op) when there are no terms', () => {
    expect(titleMentionsTarget(ev('whatever', ''), [])).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- relevance`
Expected: FAIL - `mentionsAny`/`titleMentionsTarget` are not exported.

- [ ] **Step 3: Implement the helpers**

Edit `packages/core/src/relevance.ts`. Add `mentionsAny` and `titleMentionsTarget`, and re-express `relevanceGate` on top of `mentionsAny`. The final file:

```ts
import type { Evidence } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';

export function targetTerms(store: EvidenceStore, fallbackSymbol?: string): string[] {
  const terms = new Set<string>();
  if (fallbackSymbol) terms.add(fallbackSymbol.toLowerCase());
  const target = store.all().find((e) => e.kind === 'target');
  if (target) {
    const raw = target.raw as { approvedSymbol?: string; synonyms?: string[] };
    if (raw.approvedSymbol) terms.add(raw.approvedSymbol.toLowerCase());
    for (const s of raw.synonyms ?? []) {
      if (s.length >= 3) terms.add(s.toLowerCase());
    }
  }
  return [...terms];
}

export function mentionsAny(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = text.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

export function titleMentionsTarget(e: Evidence, terms: string[]): boolean {
  return mentionsAny(e.title, terms);
}

export function relevanceGate(hits: Evidence[], terms: string[]): Evidence[] {
  if (terms.length === 0) return hits;
  return hits.filter((h) => mentionsAny(`${h.title} ${h.passage ?? ''} ${h.snippet}`, terms));
}
```

Note: `relevanceGate` keeps its own `terms.length === 0` early return so it returns the exact same array reference semantics its existing tests assert (`relevanceGate(hits, [])` returns `hits` unchanged).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- relevance`
Expected: PASS - all `relevance.test.ts` cases green, including the pre-existing `targetTerms` and `relevanceGate` cases (behavior-preserving refactor).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/relevance.ts packages/core/src/relevance.test.ts
git commit -m "feat(core): add mentionsAny and titleMentionsTarget; refactor gate onto shared core"
```

---

### Task 2: Title-gated deep-read selection and passage gating

**Files:**
- Modify: `packages/core/src/researcher.ts` (import on line 5; deep-read block at lines 99-111)
- Test: `packages/core/src/researcher.test.ts`

**Interfaces:**
- Consumes: `titleMentionsTarget`, `relevanceGate`, `targetTerms` from `./relevance.js`.
- Produces: no new exports. `runResearcher` keeps its signature; only its internal deep-read behavior changes.

**Behavior to implement:**
1. Deep-read the first hit that (a) has the target in its title, (b) has a `pmcid`, and (c) is not explicitly closed-access. When none qualifies, make no `pmc_fulltext` call this round.
2. Pass the full-text sections through `relevanceGate` before registering them, so off-topic sections never enter the store. The `tool_result` count reflects the gated count.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('runResearcher loop', ...)` block in `packages/core/src/researcher.test.ts`:

```ts
it('does not deep-read a hit whose title lacks the target, but still drafts claims from abstracts', async () => {
  // Title lacks the target; passage mentions it, so it passes the search gate but must NOT be deep-read.
  const search = tool('europepmc_search', [
    { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'Generic proteomics survey', snippet: '',
      passage: 'CDCP1 was among the detected proteins.', url: 'u',
      raw: { pmcid: 'PMC9', isOpenAccess: true }, retrievedAt: 'now' },
  ]);
  let fulltextCalls = 0;
  const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { fulltextCalls++; return [] as never; } };

  const replies = [
    { questions: [{ question: 'Is CDCP1 detected?', searchQuery: 'cdcp1 proteomics' }] },  // plan
    { claims: [{ id: 'c1', text: 'CDCP1 was detected.', citations: ['PMID:9'], confidence: 0.5 }] }, // extract
    { done: true, followups: [], takeaway: 't' },                                          // reflect
  ];
  let i = 0;
  const model = { async generateStructured() { return replies[i++] as never; } };

  const events: TraceEvent[] = [];
  const findings = await runResearcher({
    brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
    target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
    model, emit: (e) => events.push(e), budget: { maxRounds: 1 },
  });

  expect(fulltextCalls).toBe(0);                              // title-gate skipped the deep-read
  expect(events.some((e) => e.type === 'research_read')).toBe(false);
  expect(findings.claims.map((c) => c.id)).toEqual(['c1']);  // claims still drafted from the abstract
});

it('deep-reads a title-matching hit and drops its off-topic sections before registering', async () => {
  const search = tool('europepmc_search', [
    { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in pancreatic cancer', snippet: '',
      passage: 'CDCP1 is overexpressed.', url: 'u',
      raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
  ]);
  const fulltext = tool('pmc_fulltext', [
    { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 signaling',
      snippet: '', passage: 'CDCP1 promotes EMT via SRC.', locator: 'CDCP1 signaling', url: 'u', raw: {}, retrievedAt: 'now' },
    { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Cohort characteristics',
      snippet: '', passage: 'Patients with MIS-C after COVID showed elevated markers.', locator: 'Cohort characteristics', url: 'u', raw: {}, retrievedAt: 'now' },
  ]);

  const replies = [
    { questions: [{ question: 'What is the MOA of CDCP1?', searchQuery: 'cdcp1 mechanism' }] }, // plan
    { claims: [] },                                                                             // extract
    { done: true, followups: [], takeaway: 't' },                                               // reflect
  ];
  let i = 0;
  const model = { async generateStructured() { return replies[i++] as never; } };

  const store = new EvidenceStore();
  await runResearcher({
    brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
    target: 'CDCP1', tools: [search, fulltext], store,
    model, emit: () => {}, budget: { maxRounds: 1 },
  });

  const ids = store.all().map((e) => e.id);
  expect(ids).toContain('PMCID:PMC1#sec-0');     // on-target section registered
  expect(ids).not.toContain('PMCID:PMC1#sec-1'); // off-target MIS-C section dropped
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- researcher`
Expected: FAIL - today the first hit is deep-read regardless of title (so `fulltextCalls` is 1 and a `research_read` is emitted), and the off-topic section `PMCID:PMC1#sec-1` is registered.

- [ ] **Step 3: Update the import**

Edit `packages/core/src/researcher.ts` line 5:

```ts
import { targetTerms, relevanceGate, titleMentionsTarget } from './relevance.js';
```

- [ ] **Step 4: Implement title-gated selection and passage gating**

In `runResearcher`, replace the deep-read block (currently lines 99-111):

```ts
    // Read the full text of the top open-access hit that has a PMC id.
    const top = hits.find((h) => (h.raw as { pmcid?: string; isOpenAccess?: boolean })?.pmcid && (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
    if (top) {
      const pmcid = (top.raw as { pmcid: string }).pmcid;
      emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
      const passages = await safeToolCall({ tool: fulltext, args: { pmcid }, emit });
      emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
      for (const p of passages) {
        store.register(p);
        emit({ type: 'evidence_registered', id: p.id, title: p.title });
        emit({ type: 'research_read', specialist: brief.id, sourceId: p.id, locator: p.locator ?? p.title });
      }
    }
```

with:

```ts
    // Deep-read the top open-access hit whose TITLE names the target. Strict: if none
    // qualifies, read no full text this round rather than deep-read a tangential paper.
    const top = hits.find((h) =>
      titleMentionsTarget(h, terms) &&
      (h.raw as { pmcid?: string })?.pmcid &&
      (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
    if (top) {
      const pmcid = (top.raw as { pmcid: string }).pmcid;
      emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
      // Gate the sections: a title-relevant paper still carries off-topic sections.
      const passages = relevanceGate(await safeToolCall({ tool: fulltext, args: { pmcid }, emit }), terms);
      emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
      for (const p of passages) {
        store.register(p);
        emit({ type: 'evidence_registered', id: p.id, title: p.title });
        emit({ type: 'research_read', specialist: brief.id, sourceId: p.id, locator: p.locator ?? p.title });
      }
    }
```

- [ ] **Step 5: Run the researcher tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- researcher`
Expected: PASS - the two new cases pass, and the existing `runResearcher loop` cases (titles `'CDCP1'`/`'x'`) still pass.

- [ ] **Step 6: Run the full core suite to confirm no fixture ripple**

Run: `pnpm --filter @sonny/core test`
Expected: PASS - all core tests green. The deep-read-path fixtures in `produceResearchSection.test.ts` (hit title `'CDCP1'`) and `runDeepResearch.test.ts` (search hit dropped upstream by the Plan 6 search gate; claims cite the seeded `ENSG1`) are unaffected. If any test fails because a fixture relied on deep-reading a non-title-matching hit, fix it by adding the target symbol to that fixture's hit title - do not weaken the gate.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/researcher.ts packages/core/src/researcher.test.ts
git commit -m "feat(core): title-gate deep-read selection and gate full-text passages"
```

---

## Notes for the controller

- After both tasks, run the full repo suite (`pnpm -r test`) before the whole-branch review.
- A free local smoke (`pnpm --filter @sonny/cli dev deep CDCP1`, backend ollama) is the real acceptance check: confirm no off-topic full-text passages (e.g. MIS-C/COVID sections) appear and no tangential paper is deep-read. This is validation, not a task.
- Out of scope, do not let it leak in: thin recall / qwen looping, and the `isOpenAccess !== false -> === true` tightening.
