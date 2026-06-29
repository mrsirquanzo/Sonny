# Retrieval Relevance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the engine from synthesizing off-topic literature - every literature hit used in a dossier must actually be about the target. A structural fix that helps every model backend, not brittle per-model prompt wording.

**Architecture:** Resolve the target's aliases from Open Targets (approved symbol + synonyms like CD318/TRASK), then apply a target-mention relevance gate to every literature search result: drop any hit whose title/abstract never mentions the target symbol or a known alias. The gate is a pure function applied in the research loop and the gap-filler right after search returns. A light prompt tightening keeps the planner and completeness critic on-target. The structured seed evidence (Open Targets, trials) is inherently target-specific and is not gated. Sub-project 1, slice 6 of the engine spec (`docs/specs/2026-06-28-sonny-deep-research-engine-design.md`).

**Why this and not prompt tuning:** a live local run produced a structurally perfect, fully grounded briefing about the wrong subject (m6A/lncRNA/ECM reviews) because Europe PMC's citation-ranked search surfaces famous generic reviews for loose queries. The bottleneck is retrieval relevance, not synthesis. A target-mention gate fixes it for qwen2.5:14b and Opus alike.

**Tech Stack:** TypeScript ESM monorepo (pnpm workspaces, Node 20+), Vitest, Zod, Open Targets GraphQL (synonym fields verified live), `tsx` CLI, Ollama (local smoke).

## Global Constraints

- ESM only: every relative import ends in `.js`; every package is `"type": "module"`.
- Package exports are source-first (`exports`/`main` point at `./src`).
- TDD: failing test first, watch it fail, implement minimally, watch it pass, commit.
- Structured output only via Zod schemas; never parse free text with regex (substring-matching evidence text against known target terms is relevance filtering, not data parsing - that is allowed).
- Tool tests pin the REAL Open Targets response shape (the HTTP-400 regression is the cautionary case). The synonym fields are `symbolSynonyms { label }` and `nameSynonyms { label }`, verified live.
- The relevance gate only applies to literature search results (`europepmc_search`); structured seed evidence (Open Targets target/disease/drug, ClinicalTrials.gov) is never gated.
- A gate with no terms (target unresolved) returns hits unchanged - it must never drop everything for lack of terms.
- Tools accept an injectable `fetchImpl` so tests never hit the network.
- Copy rule: no em dash characters anywhere in code, comments, or output; use a plain hyphen. This includes commit messages and subjects (no task numbers in subjects).
- Run one package's tests with `pnpm --filter <pkg> test <name>`; the whole suite with `pnpm -r test`.

---

## File Structure

- `packages/mcp-gateway/src/openTargetsTarget.ts` (modify) - fetch `symbolSynonyms`/`nameSynonyms`; expose `raw.approvedSymbol` and `raw.synonyms` on the target evidence.
- `packages/core/src/relevance.ts` (create) - `targetTerms` and `relevanceGate`.
- `packages/core/src/researcher.ts` (modify) - gate the loop's search hits.
- `packages/core/src/completeness.ts` (modify) - gate the gap-filler's search hits.
- `packages/core/src/index.ts` (modify) - export `targetTerms`, `relevanceGate`.
- Tests alongside.

---

### Task 1: Open Targets synonyms on the target evidence

**Files:**
- Modify: `packages/mcp-gateway/src/openTargetsTarget.ts`
- Modify: `packages/mcp-gateway/src/openTargetsTarget.test.ts`

**Interfaces:**
- Produces: the target-kind `Evidence` from `openTargetsTargetTool` gains `raw.approvedSymbol: string` and `raw.synonyms: string[]` (deduped union of `symbolSynonyms` and `nameSynonyms` labels), alongside the existing `raw.tractability`/`raw.safetyLiabilities`.

- [ ] **Step 1: Write the failing test**

Update the fixture and add assertions in `packages/mcp-gateway/src/openTargetsTarget.test.ts`. In the `payload.data.target` object add the two synonym arrays (real shape):

```ts
    symbolSynonyms: [{ label: 'CD318' }, { label: 'TRASK' }, { label: 'CDCP1' }],
    nameSynonyms: [{ label: 'CUB domain-containing protein 1' }],
```

And add assertions inside the existing "normalizes target + diseases + drugs" test, after the existing target assertions:

```ts
    const raw = target?.raw as { approvedSymbol?: string; synonyms?: string[] };
    expect(raw.approvedSymbol).toBe('CDCP1');
    expect(raw.synonyms).toContain('CD318');
    expect(raw.synonyms).toContain('TRASK');
    expect(new Set(raw.synonyms).size).toBe(raw.synonyms!.length); // deduped
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test openTargetsTarget`
Expected: FAIL - `raw.approvedSymbol`/`raw.synonyms` are undefined.

- [ ] **Step 3: Implement**

In `packages/mcp-gateway/src/openTargetsTarget.ts`, add the synonym fields to the `TARGET` query (after `id approvedSymbol approvedName`):

```ts
    symbolSynonyms { label }
    nameSynonyms { label }
```

Extend the `TargetData` interface's target type with:

```ts
    symbolSynonyms?: Array<{ label: string }>;
    nameSynonyms?: Array<{ label: string }>;
```

In the `out.push({ ... })` for the target record, change the `raw` to include the symbol and deduped synonyms:

```ts
      raw: {
        tractability: t.tractability ?? [],
        safetyLiabilities: t.safetyLiabilities ?? [],
        approvedSymbol: t.approvedSymbol,
        synonyms: [...new Set([
          ...(t.symbolSynonyms ?? []).map((s) => s.label),
          ...(t.nameSynonyms ?? []).map((s) => s.label),
        ])],
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/mcp-gateway test openTargetsTarget`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/openTargetsTarget.ts packages/mcp-gateway/src/openTargetsTarget.test.ts
git commit -m "feat(mcp-gateway): expose target approvedSymbol and synonyms from Open Targets"
```

---

### Task 2: targetTerms and relevanceGate

**Files:**
- Create: `packages/core/src/relevance.ts`
- Test: `packages/core/src/relevance.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Evidence` from `@sonny/shared`, `EvidenceStore`.
- Produces:
  - `targetTerms(store: EvidenceStore, fallbackSymbol?: string): string[]` - lowercased relevance terms: the fallback symbol (if given) plus the seeded Open Targets target record's `approvedSymbol` and `synonyms` (terms shorter than 3 chars are dropped). Deduped.
  - `relevanceGate(hits: Evidence[], terms: string[]): Evidence[]` - keeps a hit only if its title + passage + snippet (case-insensitive) contains at least one term. If `terms` is empty, returns `hits` unchanged.

- [ ] **Step 1: Write the failing test**

`packages/core/src/relevance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { targetTerms, relevanceGate } from './relevance.js';

function pub(id: string, title: string, passage: string): Evidence {
  return { id, kind: 'publication', source: 's', title, snippet: '', passage, url: 'u', raw: {}, retrievedAt: 'now' };
}

describe('targetTerms', () => {
  it('includes the fallback symbol plus the seeded target approvedSymbol and synonyms (>= 3 chars), deduped and lowercased', () => {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1 - CUB domain containing protein 1',
      snippet: '', url: 'u', retrievedAt: 'now',
      raw: { approvedSymbol: 'CDCP1', synonyms: ['CD318', 'TRASK', 'AB'] } }); // 'AB' too short -> dropped
    const terms = targetTerms(store, 'CDCP1');
    expect(terms).toContain('cdcp1');
    expect(terms).toContain('cd318');
    expect(terms).toContain('trask');
    expect(terms).not.toContain('ab');
    expect(new Set(terms).size).toBe(terms.length); // deduped
  });

  it('falls back to just the symbol when no target record is seeded', () => {
    expect(targetTerms(new EvidenceStore(), 'EGFR')).toEqual(['egfr']);
  });

  it('returns [] when there is neither a fallback nor a seeded target', () => {
    expect(targetTerms(new EvidenceStore())).toEqual([]);
  });
});

describe('relevanceGate', () => {
  it('keeps hits that mention any term and drops the rest (case-insensitive)', () => {
    const hits = [
      pub('PMID:1', 'CDCP1 drives EMT', 'the CDCP1 receptor...'),
      pub('PMID:2', 'CD318 in pancreatic cancer', 'CD318 is targeted...'),
      pub('PMID:3', 'm6A RNA methylation review', 'METTL3 and FTO regulate...'), // off-topic
    ];
    const kept = relevanceGate(hits, ['cdcp1', 'cd318', 'trask']);
    expect(kept.map((h) => h.id)).toEqual(['PMID:1', 'PMID:2']); // PMID:3 dropped
  });

  it('returns hits unchanged when there are no terms', () => {
    const hits = [pub('PMID:9', 'anything', 'anything')];
    expect(relevanceGate(hits, [])).toEqual(hits);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test relevance`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/relevance.ts`:

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

export function relevanceGate(hits: Evidence[], terms: string[]): Evidence[] {
  if (terms.length === 0) return hits;
  return hits.filter((h) => {
    const hay = `${h.title} ${h.passage ?? ''} ${h.snippet}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}
```

In `packages/core/src/index.ts`, add:

```ts
export { targetTerms, relevanceGate } from './relevance.js';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test relevance`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/relevance.ts packages/core/src/relevance.test.ts packages/core/src/index.ts
git commit -m "feat(core): targetTerms + relevanceGate - keep only target-mentioning literature"
```

---

### Task 3: Gate the research loop

**Files:**
- Modify: `packages/core/src/researcher.ts`
- Modify: `packages/core/src/researcher.test.ts`
- Modify (fixture updates): `packages/core/src/produceResearchSection.test.ts`, `packages/core/src/runDeepResearch.test.ts`

**Interfaces:**
- Consumes: `targetTerms`, `relevanceGate` from `./relevance.js`.
- Produces: `runResearcher` resolves the target terms once (from the shared store, with the `target` symbol as fallback) and applies `relevanceGate` to every search result before registering evidence; off-topic hits are dropped and the `tool_result` count reflects the gated count.

**IMPORTANT - existing-fixture ripple:** because `runResearcher` always has the `target` symbol as a fallback term, the gate is active in every test that drives the loop. Any existing test whose injected `europepmc_search` hit does NOT mention the target (e.g. a hit titled `'P'` with passage `'abstract'` under target `'CDCP1'`) will now be filtered out, so its downstream full-text read and cited claim disappear and the test fails. After wiring the gate (Step 3), run the FULL core suite and fix every such breakage by making the injected search hit mention the target - add the target symbol to the hit's `title` or `passage` (e.g. `title: 'CDCP1 study'`). This is an intent-preserving fixture update, not a logic change. The likely-affected files are `produceResearchSection.test.ts` and `runDeepResearch.test.ts` (and possibly older `researcher.test.ts` cases). Tests whose claims cite the SEEDED structured evidence (e.g. `ENSG1` from a fake `open_targets_target`) rather than the search hit are unaffected, because seed evidence is never gated.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/researcher.test.ts`:

```ts
import { targetTerms } from './relevance.js'; // ensure import graph wired

describe('runResearcher relevance gating', () => {
  it('drops search hits that do not mention the target before they reach the evidence store', async () => {
    const search: Tool = { name: 'europepmc_search', description: '', async call() {
      return [
        { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 drives EMT', snippet: '', passage: 'CDCP1 ...', url: 'u', raw: { pmcid: '', isOpenAccess: false }, retrievedAt: 'now' },
        { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'm6A methylation review', snippet: '', passage: 'METTL3 ...', url: 'u', raw: { pmcid: '', isOpenAccess: false }, retrievedAt: 'now' },
      ] as never;
    } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const replies = [
      { questions: [{ question: 'q?', searchQuery: 'kw' }] },
      { claims: [] },
      { done: true, followups: [], takeaway: 't' },
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };
    const store = new EvidenceStore();
    await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store, model, emit: () => {}, budget: { maxRounds: 1 },
    });
    // only the CDCP1 hit was registered; the off-topic m6A hit was gated out
    expect(store.has('PMID:1')).toBe(true);
    expect(store.has('PMID:2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test researcher`
Expected: FAIL - both hits are registered; `PMID:2` is present.

- [ ] **Step 3: Implement**

In `packages/core/src/researcher.ts`, add the import alongside the other imports:

```ts
import { targetTerms, relevanceGate } from './relevance.js';
```

In `runResearcher`, after `emit({ type: 'specialist_start', specialist: brief.id });` (before planning), resolve the terms once:

```ts
  const terms = targetTerms(store, target);
```

Then gate the search result. Change:

```ts
    const hits = await safeToolCall({ tool: search, args: { query: item.searchQuery }, emit });
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

to:

```ts
    const hits = relevanceGate(await safeToolCall({ tool: search, args: { query: item.searchQuery }, emit }), terms);
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

- [ ] **Step 4: Run the FULL core suite and fix gated fixtures**

Run: `pnpm --filter @sonny/core test`
Expected: the new gating test passes. Some existing tests in `produceResearchSection.test.ts` / `runDeepResearch.test.ts` (and possibly `researcher.test.ts`) may now FAIL because their injected search hit no longer mentions the target and is filtered out. For each such failure, make the injected `europepmc_search` hit mention the target by adding the target symbol to its `title` or `passage` (intent-preserving), then re-run until the whole core suite is green. Do NOT weaken the gate or special-case tests to avoid the fix.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/researcher.ts packages/core/src/researcher.test.ts packages/core/src/produceResearchSection.test.ts packages/core/src/runDeepResearch.test.ts
git commit -m "feat(core): gate research-loop literature to target-mentioning hits"
```

---

### Task 4: Gate the gap-filler

**Files:**
- Modify: `packages/core/src/completeness.ts`
- Modify: `packages/core/src/completeness.test.ts`

**Interfaces:**
- Consumes: `targetTerms`, `relevanceGate` from `./relevance.js`.
- Produces: `fillGap` resolves the target terms from the shared store (no fallback - the Lead has already seeded the Open Targets target record by gap-fill time) and applies `relevanceGate` to its search results.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/completeness.test.ts`:

```ts
describe('fillGap relevance gating', () => {
  it('drops off-target search hits using the seeded target terms', async () => {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: '', url: 'u', retrievedAt: 'now',
      raw: { approvedSymbol: 'CDCP1', synonyms: ['CD318'] } });
    const search: Tool = { name: 'europepmc_search', description: '', async call() {
      return [
        { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 resistance', snippet: '', passage: 'CDCP1 ...', url: 'u', raw: { pmcid: '', isOpenAccess: false }, retrievedAt: 'now' },
        { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'unrelated NF-kB review', snippet: '', passage: 'NF-kB ...', url: 'u', raw: { pmcid: '', isOpenAccess: false }, retrievedAt: 'now' },
      ] as never;
    } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', searchQuery: 'kw', reason: 'r' },
      tools: [search, fulltext], store, specialistModel, verifierModel, emit: () => {},
    });
    expect(store.has('PMID:1')).toBe(true);
    expect(store.has('PMID:2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test completeness`
Expected: FAIL - the off-target `PMID:2` is registered.

- [ ] **Step 3: Implement**

In `packages/core/src/completeness.ts`, add the import alongside the others:

```ts
import { targetTerms, relevanceGate } from './relevance.js';
```

In `fillGap`, after the `emit({ type: 'gap_filler', ... })` line (before the search call), resolve the terms:

```ts
  const terms = targetTerms(store);
```

Then gate the search result. Change:

```ts
  const hits = await safeToolCall({ tool: search, args: { query: gap.searchQuery }, emit });
  emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

to:

```ts
  const hits = relevanceGate(await safeToolCall({ tool: search, args: { query: gap.searchQuery }, emit }), terms);
  emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test completeness`
Expected: PASS (the new test plus all existing completeness tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/completeness.ts packages/core/src/completeness.test.ts
git commit -m "feat(core): gate gap-filler literature to target-mentioning hits"
```

---

### Task 5: Prompt tightening and local validation

**Files:**
- Modify: `packages/core/src/researcher.ts` (planner prompt)
- Modify: `packages/core/src/completeness.ts` (critic prompt)
- Modify: `packages/core/src/researcher.test.ts` (assert the anchoring instruction is present)

**Interfaces:**
- Produces: the `planResearchQuestions` system prompt and the `assessCompleteness` system prompt instruct the model to stay strictly on the named target and to put the target symbol in every searchQuery. No signature changes.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/researcher.test.ts`:

```ts
describe('planResearchQuestions target anchoring', () => {
  it('instructs the model to keep the target symbol in every searchQuery', async () => {
    let system = '';
    const model = { async generateStructured(o: { system: string }) { system = o.system; return { questions: [{ question: 'q', searchQuery: 'CDCP1 kw' }] } as never; } };
    await planResearchQuestions({ id: 'x', title: 'X', objective: 'o', promptHint: 'h' }, 'CDCP1', model);
    expect(system.toLowerCase()).toContain('target gene symbol');
    expect(system.toLowerCase()).toContain('every');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/core test researcher`
Expected: FAIL if the current planner system prompt does not contain both phrases. (If it already contains "target gene symbol" but not "every", the assertion still fails - confirm RED before editing.)

- [ ] **Step 3: Implement**

In `packages/core/src/researcher.ts`, tighten the `planResearchQuestions` system prompt. Replace its existing system string with one that adds an explicit anchoring instruction. The system string currently ends with the searchQuery guidance; ensure it contains this sentence verbatim:

```
Every searchQuery MUST contain the target gene symbol and stay strictly about THIS target - do not drift to general pathway or disease biology that does not name the target.
```

In `packages/core/src/completeness.ts`, tighten the `assessCompleteness` system prompt by appending this sentence to its existing system string:

```
Every gap question and searchQuery must stay strictly about the named target and include its gene symbol - do not propose tangential research directions that do not name the target.
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/core test researcher`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `pnpm -r test`
Expected: every package green.

- [ ] **Step 6: Local live smoke (free) - validate on-topic retrieval**

With Ollama running:
```bash
pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1
```
Expected: `backend: ollama`, and now the registered evidence and the briefing claims are about CDCP1 (CDCP1/CD318/Trask appear; the m6A/lncRNA/ECM noise is gone). The verdict and bull/bear should reference CDCP1 biology, not generic cancer reviews. Record whether the relevance gate visibly tightened the dossier; remaining quality issues (e.g. thin sections because few hits passed the gate) are findings for the next slice, not blockers - the deliverable is on-target retrieval.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/researcher.ts packages/core/src/completeness.ts packages/core/src/researcher.test.ts
git commit -m "feat(core): anchor planner and critic prompts to the named target"
```

---

## What this plan deliberately does NOT do (next plans)

- **Relevance ranking changes** to the Europe PMC query (still `CITED desc`) - the target-mention gate makes citation ranking correct (most-cited ON-TARGET papers); switching to relevance ranking is a later refinement if the gate proves insufficient.
- **Alias-expanded search queries** (adding `OR CD318 OR Trask` to the query string) - the gate filters by alias; expanding the query for recall is a later option.
- **Web glass-box**, patents, BD/valuation, expert-bar eval.
- **The accumulated cleanup list** (OA-gate tightening, shared `DeepResearchOptions` type, duplicate test imports).

---

## Self-Review

- **Spec coverage (retrieval relevance):** target aliases from Open Targets (Task 1), `targetTerms` + `relevanceGate` pure functions (Task 2), gate the research loop (Task 3) and gap-filler (Task 4), prompt anchoring + local validation (Task 5). The structural fix - off-topic literature can never reach the dossier - is covered by Tasks 2-4; the gate degrades safely to no-op when terms are empty.
- **Placeholder scan:** none - every step carries real code and a concrete command with expected result.
- **Type consistency:** `targetTerms(store, fallbackSymbol?)` returns `string[]` and `relevanceGate(hits, terms)` returns `Evidence[]` (Task 2), both consumed unchanged in Tasks 3-4; the Open Targets `raw.approvedSymbol`/`raw.synonyms` added in Task 1 are exactly what `targetTerms` reads; no function signatures in the call chain change (terms are derived from the shared store, not threaded through parameters).
