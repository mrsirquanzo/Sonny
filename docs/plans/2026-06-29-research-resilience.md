# Research Loop Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a deep-research run always complete and always tell the truth about what it could not gather - a single transient external-API failure (e.g. Europe PMC HTTP 504) must never abort the briefing.

**Architecture:** Three layers. (1) A `safeToolCall` helper retries transient failures (HTTP 5xx/429, network/timeout) up to 2 times with backoff, and on persistent or non-transient failure emits an `error` trace event and returns `[]` instead of throwing. (2) The research loop and the gap-filler call their tools through `safeToolCall`, so one dead source degrades to zero results and the loop continues. (3) The Lead dispatches specialists with `Promise.allSettled` and turns a fully-failed specialist into an honest RED "research could not complete" placeholder section; the gap-fill and weighing passes are wrapped so a model error degrades rather than aborts. Net: `runDeepResearch` always returns a result, with red placeholders marking real gaps (the spec's no-silent-truncation rule). Sub-project 1, slice 5 of the engine spec (`docs/specs/2026-06-28-sonny-deep-research-engine-design.md`); directly serves its production-readiness theme (runtime resilience, graceful degradation).

**Tech Stack:** TypeScript ESM monorepo (pnpm workspaces, Node 20+), Vitest, Zod, `tsx` CLI, Ollama (local smoke).

## Global Constraints

- ESM only: every relative import ends in `.js`; every package is `"type": "module"`.
- Package exports are source-first (`exports`/`main` point at `./src`).
- TDD: failing test first, watch it fail, implement minimally, watch it pass, commit.
- Structured output only via Zod schemas; never parse free text with regex (string-matching an error message to classify it as transient is error classification, not data parsing - that is allowed).
- Resilience invariant: after this slice, `runDeepResearch` never rejects due to a single tool failure or a single specialist failure; it returns a result with red placeholder sections marking what failed, and emits an `error` trace event for every failure.
- A failed specialist becomes a RED placeholder section: `{ id, title, takeaway: 'Research could not complete: <reason>', claims: [], sources: [], rag: 'red' }`.
- Retry policy: 2 retries (3 attempts total) on transient errors only, with backoff `backoffMs * attempt`; non-transient errors (e.g. HTTP 4xx) fail immediately with no retry.
- Tools/helpers accept injectable dependencies (`fetchImpl`, `sleep`) so tests never hit the network or actually wait.
- Copy rule: no em dash characters anywhere in code, comments, or output; use a plain hyphen. This includes commit messages and subjects (no task numbers in subjects).
- Run one package's tests with `pnpm --filter <pkg> test <name>`; the whole suite with `pnpm -r test`.

---

## File Structure

- `packages/core/src/safeToolCall.ts` (create) - `isTransient` and `safeToolCall`.
- `packages/core/src/researcher.ts` (modify) - route the loop's search/fulltext calls through `safeToolCall`.
- `packages/core/src/completeness.ts` (modify) - route `fillGap`'s search/fulltext calls through `safeToolCall`.
- `packages/core/src/runDeepResearch.ts` (modify) - `Promise.allSettled` + placeholder section; wrap gap-fill and weighing.
- `packages/core/src/index.ts` (modify) - export `safeToolCall`, `isTransient`.
- Tests alongside.

---

### Task 1: safeToolCall helper

**Files:**
- Create: `packages/core/src/safeToolCall.ts`
- Test: `packages/core/src/safeToolCall.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Evidence`, `TraceEvent` from `@sonny/shared`, `Tool` from `@sonny/mcp-gateway`.
- Produces:
  - `isTransient(err: unknown): boolean` - true for HTTP 5xx/429, `fetch failed`, and common network/timeout errors.
  - `safeToolCall(opts: { tool: Tool; args: Record<string, unknown>; emit: (e: TraceEvent) => void; retries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<Evidence[]>` - retries transient errors (default 2) with backoff, then on failure emits an `error` event and returns `[]`. Never throws.

- [ ] **Step 1: Write the failing test**

`packages/core/src/safeToolCall.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent, Evidence } from '@sonny/shared';
import { safeToolCall, isTransient } from './safeToolCall.js';

const ev: Evidence = { id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' };
const noSleep = async () => {};

describe('isTransient', () => {
  it('classifies 5xx, 429, and network errors as transient; 4xx as not', () => {
    expect(isTransient(new Error('Europe PMC HTTP 504'))).toBe(true);
    expect(isTransient(new Error('Open Targets HTTP 429'))).toBe(true);
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
    expect(isTransient(new Error('Open Targets HTTP 400'))).toBe(false);
  });
});

describe('safeToolCall', () => {
  it('returns evidence on success without retrying', async () => {
    let calls = 0;
    const tool: Tool = { name: 'x', description: '', async call() { calls++; return [ev]; } };
    const out = await safeToolCall({ tool, args: {}, emit: () => {}, sleep: noSleep });
    expect(out).toEqual([ev]);
    expect(calls).toBe(1);
  });

  it('retries a transient failure then succeeds', async () => {
    let calls = 0;
    const tool: Tool = { name: 'x', description: '', async call() { calls++; if (calls < 2) throw new Error('HTTP 504'); return [ev]; } };
    const out = await safeToolCall({ tool, args: {}, emit: () => {}, sleep: noSleep });
    expect(out).toEqual([ev]);
    expect(calls).toBe(2);
  });

  it('gives up after 2 retries on persistent transient failure, emits error, returns []', async () => {
    let calls = 0;
    const events: TraceEvent[] = [];
    const tool: Tool = { name: 'x', description: '', async call() { calls++; throw new Error('HTTP 504'); } };
    const out = await safeToolCall({ tool, args: {}, emit: (e) => events.push(e), sleep: noSleep });
    expect(out).toEqual([]);
    expect(calls).toBe(3); // 1 + 2 retries
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does NOT retry a non-transient failure; emits error and returns [] immediately', async () => {
    let calls = 0;
    const events: TraceEvent[] = [];
    const tool: Tool = { name: 'x', description: '', async call() { calls++; throw new Error('HTTP 400'); } };
    const out = await safeToolCall({ tool, args: {}, emit: (e) => events.push(e), sleep: noSleep });
    expect(out).toEqual([]);
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test safeToolCall`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/safeToolCall.ts`:

```ts
import type { Evidence, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';

export function isTransient(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err);
  return /HTTP 5\d\d/.test(m)
    || /HTTP 429/.test(m)
    || /fetch failed/i.test(m)
    || /(timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)/i.test(m);
}

export async function safeToolCall(opts: {
  tool: Tool; args: Record<string, unknown>; emit: (e: TraceEvent) => void;
  retries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<Evidence[]> {
  const { tool, args, emit } = opts;
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 250;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await tool.call(args);
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransient(err)) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      break;
    }
  }
  emit({ type: 'error', message: `tool ${tool.name} failed: ${String(lastErr)}` });
  return [];
}
```

In `packages/core/src/index.ts`, add:

```ts
export { safeToolCall, isTransient } from './safeToolCall.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test safeToolCall`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/safeToolCall.ts packages/core/src/safeToolCall.test.ts packages/core/src/index.ts
git commit -m "feat(core): safeToolCall - retry transient failures, isolate persistent ones"
```

---

### Task 2: Harden the research loop

**Files:**
- Modify: `packages/core/src/researcher.ts`
- Modify: `packages/core/src/researcher.test.ts`

**Interfaces:**
- Consumes: `safeToolCall` from `./safeToolCall.js`.
- Produces: `runResearcher` routes its `europepmc_search` and `pmc_fulltext` calls through `safeToolCall`, so a tool failure yields `[]` and the loop continues instead of throwing.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/researcher.test.ts`:

```ts
import { safeToolCall } from './safeToolCall.js'; // ensure import graph is wired

describe('runResearcher resilience', () => {
  it('does not throw when the search tool fails; the loop continues and returns findings', async () => {
    const failingSearch: Tool = { name: 'europepmc_search', description: '', async call() { throw new Error('HTTP 504'); } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const replies = [
      { questions: [{ question: 'q?', searchQuery: 'kw' }] }, // plan
      { claims: [] },                                          // extract (no evidence)
      { done: true, followups: [], takeaway: 'no data available' }, // reflect
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    const findings = await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [failingSearch, fulltext], store: new EvidenceStore(),
      model, emit: () => {}, budget: { maxRounds: 1 },
    });
    expect(findings.takeaway).toBe('no data available'); // completed, did not throw
  });
});
```

(Uses `runResearcher`, `EvidenceStore`, and `Tool` already imported in this test file from the slice-1 tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test researcher`
Expected: FAIL - the unguarded `search.call` throws `HTTP 504`, rejecting `runResearcher`.

- [ ] **Step 3: Implement**

In `packages/core/src/researcher.ts`, add the import near the top of the loop section (with the other imports, e.g. after the `Tool` import):

```ts
import { safeToolCall } from './safeToolCall.js';
```

In `runResearcher`, replace the search call block. Change:

```ts
    emit({ type: 'tool_call', tool: search.name, args: { query: item.searchQuery } });
    const hits = await search.call({ query: item.searchQuery });
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

to:

```ts
    emit({ type: 'tool_call', tool: search.name, args: { query: item.searchQuery } });
    const hits = await safeToolCall({ tool: search, args: { query: item.searchQuery }, emit });
    emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

And replace the full-text call. Change:

```ts
      emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
      const passages = await fulltext.call({ pmcid });
      emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
```

to:

```ts
      emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
      const passages = await safeToolCall({ tool: fulltext, args: { pmcid }, emit });
      emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test researcher`
Expected: PASS (the new test plus all existing researcher tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/researcher.ts packages/core/src/researcher.test.ts
git commit -m "feat(core): research loop survives tool failures via safeToolCall"
```

---

### Task 3: Harden the gap-filler

**Files:**
- Modify: `packages/core/src/completeness.ts`
- Modify: `packages/core/src/completeness.test.ts`

**Interfaces:**
- Consumes: `safeToolCall` from `./safeToolCall.js`.
- Produces: `fillGap` routes its search/fulltext calls through `safeToolCall`, so a tool failure during gap-filling yields `[]` and `fillGap` returns whatever supported claims it could gather (often none) instead of throwing.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/completeness.test.ts`:

```ts
describe('fillGap resilience', () => {
  it('does not throw when the search tool fails; returns no claims', async () => {
    const failingSearch: Tool = { name: 'europepmc_search', description: '', async call() { throw new Error('HTTP 504'); } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    const out = await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', searchQuery: 'kw', reason: 'r' },
      tools: [failingSearch, fulltext], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: () => {},
    });
    expect(out).toEqual([]);
  });
});
```

(Uses `fillGap`, `EvidenceStore`, `Tool` already imported in this test file from the slice-2 tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test completeness`
Expected: FAIL - the unguarded `search.call` throws.

- [ ] **Step 3: Implement**

In `packages/core/src/completeness.ts`, add the import after the existing imports:

```ts
import { safeToolCall } from './safeToolCall.js';
```

In `fillGap`, replace the search call. Change:

```ts
  emit({ type: 'tool_call', tool: search.name, args: { query: gap.searchQuery } });
  const hits = await search.call({ query: gap.searchQuery });
  emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

to:

```ts
  emit({ type: 'tool_call', tool: search.name, args: { query: gap.searchQuery } });
  const hits = await safeToolCall({ tool: search, args: { query: gap.searchQuery }, emit });
  emit({ type: 'tool_result', tool: search.name, count: hits.length });
```

And replace the full-text call. Change:

```ts
    emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
    const passages = await fulltext.call({ pmcid });
    emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
```

to:

```ts
    emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
    const passages = await safeToolCall({ tool: fulltext, args: { pmcid }, emit });
    emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test completeness`
Expected: PASS (the new test plus all existing completeness tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/completeness.ts packages/core/src/completeness.test.ts
git commit -m "feat(core): gap-filler survives tool failures via safeToolCall"
```

---

### Task 4: Lead-level isolation and placeholders

**Files:**
- Modify: `packages/core/src/runDeepResearch.ts`
- Modify: `packages/core/src/runDeepResearch.test.ts`

**Interfaces:**
- Consumes: `ThreadBrief`, `Section`.
- Produces: `runDeepResearch` dispatches specialists with `Promise.allSettled`; a rejected specialist becomes a RED placeholder section and an emitted `error`; the gap-fill loop and the weighing pass are wrapped so a model error degrades (emits `error`, continues) rather than aborts. `runDeepResearch` always resolves.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/runDeepResearch.test.ts`:

```ts
describe('runDeepResearch resilience', () => {
  it('turns a failing specialist into a RED placeholder and still completes', async () => {
    const ot: Tool = { name: 'open_targets_target', description: '', async call() { return []; } };
    // a search tool that throws a NON-transient error so the model-layer is reached;
    // but to force a specialist FAILURE we make the specialist model throw for brief 'b' only.
    const search: Tool = { name: 'europepmc_search', description: '', async call() { return []; } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };

    const roster: ThreadBrief[] = [
      { id: 'a', title: 'A', objective: 'oa', promptHint: 'ha' },
      { id: 'b', title: 'B', objective: 'ob', promptHint: 'hb' },
    ];
    // specialistModel: brief 'a' plans/extracts/reflects fine; throw when the plan prompt is for B.
    const specialistModel = { async generateStructured(o: { prompt: string; system: string }) {
      if (o.prompt.includes('TARGET: CDCP1') && o.prompt.includes('B')) throw new Error('model exploded for B');
      if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q', searchQuery: 'kw' }] } as never;
      if (o.system.includes('rigorous biomedical')) return { claims: [] } as never;
      return { done: true, followups: [], takeaway: 'ok' } as never;
    } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    const leadModel = { async generateStructured(o: { prompt: string }) {
      if (o.prompt.includes('THREAD FINDINGS')) return { takeaway: '', claims: [] } as never;
      return { complete: true, gaps: [] } as never;
    } };

    const result = await runDeepResearch({
      target: 'CDCP1', roster, literatureTools: [search, fulltext], structuredTools: [ot],
      specialistModel, verifierModel, leadModel, emit: () => {}, budget: { maxRounds: 1 },
    });

    const b = result.sections.find((s) => s.id === 'b')!;
    expect(b.rag).toBe('red');
    expect(b.takeaway).toContain('could not complete');
    expect(result.sections.find((s) => s.id === 'a')).toBeDefined(); // the healthy specialist still produced
  });
});
```

(The B-brief prompt for `planResearchQuestions` includes `BRIEF: B` and `TARGET: CDCP1`; matching on `'B'` plus the target isolates the throw to brief B's first model call. `ThreadBrief` and `Tool` are already imported in this test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test runDeepResearch`
Expected: FAIL - `Promise.all` rejects when brief B's model call throws, so `runDeepResearch` rejects.

- [ ] **Step 3: Implement**

In `packages/core/src/runDeepResearch.ts`, add a placeholder helper above `runDeepResearch`:

```ts
function placeholderSection(brief: ThreadBrief, reason: string): Section {
  return { id: brief.id, title: brief.title, takeaway: `Research could not complete: ${reason}`, claims: [], sources: [], rag: 'red' };
}
```

Replace the parallel dispatch. Change:

```ts
  emit({ type: 'lead_decompose', specialists: roster.map((b) => b.id) });
  const sections = await Promise.all(roster.map((brief) =>
    produceResearchSection({ brief, target, tools: literatureTools, store, specialistModel, verifierModel, emit, budget }),
  ));
```

to:

```ts
  emit({ type: 'lead_decompose', specialists: roster.map((b) => b.id) });
  const settled = await Promise.allSettled(roster.map((brief) =>
    produceResearchSection({ brief, target, tools: literatureTools, store, specialistModel, verifierModel, emit, budget }),
  ));
  const sections = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const reason = String((r.reason as { message?: string })?.message ?? r.reason);
    emit({ type: 'error', message: `specialist ${roster[i].id} failed: ${reason}` });
    return placeholderSection(roster[i], reason);
  });
```

Wrap the gap-fill call. Change:

```ts
      const claims = await fillGap({ gap, tools: literatureTools, store, specialistModel, verifierModel, emit });
      finalSections = finalSections.map((s, i) => (i === idx ? mergeGapClaims(s, claims) : s));
```

to:

```ts
      try {
        const claims = await fillGap({ gap, tools: literatureTools, store, specialistModel, verifierModel, emit });
        finalSections = finalSections.map((s, i) => (i === idx ? mergeGapClaims(s, claims) : s));
      } catch (err) {
        emit({ type: 'error', message: `gap-fill ${gap.specialistId} failed: ${String(err)}` });
      }
```

Wrap the weighing pass. Change:

```ts
  const weighing = await weighAcrossThreads({ sections: finalSections, store, leadModel: opts.leadModel, verifierModel, emit });
  return { target, sections: finalSections, weighing, evidence: store.all() };
```

to:

```ts
  let weighing = { takeaway: '', claims: [] as Claim[] };
  try {
    weighing = await weighAcrossThreads({ sections: finalSections, store, leadModel: opts.leadModel, verifierModel, emit });
  } catch (err) {
    emit({ type: 'error', message: `weighing failed: ${String(err)}` });
  }
  return { target, sections: finalSections, weighing, evidence: store.all() };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test runDeepResearch`
Expected: PASS (the new test plus all existing runDeepResearch tests).

- [ ] **Step 5: Full suite**

Run: `pnpm -r test`
Expected: every package green.

- [ ] **Step 6: Live smoke (free, local) - the payoff**

With Ollama running:
```bash
pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1
```
Expected: the run completes end to end on local models even if an external API hiccups - a conclusion-first GO/WATCH/NO-GO briefing, with any failed thread shown as a RED "could not complete" placeholder rather than a crash. This is the first full local end-to-end briefing.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runDeepResearch.ts packages/core/src/runDeepResearch.test.ts
git commit -m "feat(core): lead isolates failing specialists into red placeholders, run always completes"
```

---

## What this plan deliberately does NOT do (next plans)

- **Prompt optimization for local models** - the resilience layer makes runs complete; tuning qwen2.5:14b/llama3.1:8b search queries and reasoning to a useful quality bar is the follow-on.
- **Web glass-box** rendering of error/placeholder states.
- **Circuit-breaking or rate-limit-aware scheduling** across many concurrent calls - the 2-retry/backoff policy is enough for the current scale; smarter throttling is a later concern if needed.
- **The accumulated cleanup list** (OA-gate tightening, shared `DeepResearchOptions` type, duplicate test imports).

---

## Self-Review

- **Spec coverage (resilience):** retry + isolation helper (Task 1), research loop hardened (Task 2), gap-filler hardened (Task 3), Lead-level `allSettled` + RED placeholders + wrapped gap-fill/weighing (Task 4). The invariant - a single tool or specialist failure never aborts the briefing, and failures surface as red placeholders + error events - is covered across Tasks 2-4. Prompt optimization and web rendering explicitly deferred above.
- **Placeholder scan:** none - every step carries real code and a concrete command with expected result.
- **Type consistency:** `safeToolCall`/`isTransient` (Task 1) return `Promise<Evidence[]>`/`boolean` and are consumed unchanged in Tasks 2-3; the `placeholderSection` helper (Task 4) returns the existing `Section` shape; `runDeepResearch`'s return type `DeepResearchResult` is unchanged (weighing stays `{ takeaway, claims }`, now via a guarded assignment); `emit` continues to take the existing `TraceEvent` union (the `error` member already exists).
