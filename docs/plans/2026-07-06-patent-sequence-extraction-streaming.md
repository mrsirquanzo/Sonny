# Streamable Patent Sequence Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Sonny's patent sequence extraction as an importable, `emit(TraceEvent)`-streaming entrypoint that LUMINA drives to render an uploaded patent's sequences in a pop-out.

**Architecture:** Add four patent `TraceEvent` variants to `sonny-shared`; thread an optional `emit` through the existing `extractPatentData` so it narrates its stages; add a document-driven `extractPatentSequences({ filePath, emit, deps })` entrypoint in `sonny-core` that wraps ingest + `extractPatentData`; repoint the CLI runner to delegate to it. The existing extraction logic and the `ExtractedPatent` result are unchanged.

**Tech Stack:** TypeScript ESM monorepo (pnpm), Vitest. Packages `@mrsirquanzo/sonny-shared`, `@mrsirquanzo/sonny-core`, `@sonny/cli`.

## Global Constraints

- Never use the em dash; use a plain dash.
- `sonny-shared` must NOT import from `sonny-core` (core depends on shared, never the reverse). The `patent_complete` event references a `ExtractionCompletenessLike` interface declared inline in `contracts.ts`.
- The four new `TraceEvent` variants are exactly:
  - `{ type: 'patent_ingest'; status: 'ok' | 'failed'; format?: string }`
  - `{ type: 'patent_extracted'; patentNumber: string | null; sequenceCount: number }`
  - `{ type: 'patent_associations'; associationCount: number; source: 'st26' | 'llm' }`
  - `{ type: 'patent_complete'; completeness: ExtractionCompletenessLike }`
- The `emit` parameter added to `extractPatentData` is optional and defaults to a no-op, so `runPatentWorkup` and existing tests are unaffected.
- `ExtractedPatent` is the result; it is NOT mapped into `Briefing`.
- Surgical: touch only the files named per task; do not refactor adjacent code.

---

### Task 1: Patent trace events + emit threading through extractPatentData

**Files:**
- Modify: `packages/shared/src/contracts.ts` (the `TraceEvent` union at line 174; add the `ExtractionCompletenessLike` interface just above it)
- Modify: `packages/core/src/patentData.ts` (`extractPatentData`, around line 90)
- Modify: `packages/core/src/index.ts:24` (add `ExtractionCompleteness` to the existing `patentData` export)
- Test: `packages/core/src/patentData.test.ts` (append cases)

**Interfaces:**
- Consumes: `extractPatentData(markdown: string, model: StructuredModel)` (existing), `isST26`, `extractST26Associations`, `extractAssociations`, `extractSequences`, `extractPatentNumber` (existing).
- Produces: `extractPatentData(markdown: string, model: StructuredModel, emit?: (e: TraceEvent) => void)` and the four `TraceEvent` variants + `ExtractionCompletenessLike` from `sonny-shared`. `ExtractionCompleteness` exported from `sonny-core`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/patentData.test.ts`. Add `import type { TraceEvent } from '@mrsirquanzo/sonny-shared';` to the top imports. Reuse the `ST26` fixture constant already defined in this file's "ST.26 structured associations" describe block (do not redefine it - reference the same constant).

```ts
describe('extractPatentData emit', () => {
  it('emits stage events in order for a text patent', async () => {
    const events: TraceEvent[] = [];
    const md = 'US 10,123,456 B2\nSEQ ID NO: 1\nEVQLVESGGG\n';
    const model = { async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 1 }] } as never; } };
    await extractPatentData(md, model, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(['patent_extracted', 'patent_associations', 'patent_complete']);
    const extracted = events[0] as Extract<TraceEvent, { type: 'patent_extracted' }>;
    expect(extracted.sequenceCount).toBe(1);
    expect(extracted.patentNumber).toBe('US10123456');
    const assoc = events[1] as Extract<TraceEvent, { type: 'patent_associations' }>;
    expect(assoc.source).toBe('llm');
  });

  it('reports source=st26 and calls no model for an ST.26 listing', async () => {
    const events: TraceEvent[] = [];
    let llmCalls = 0;
    const model = { async generateStructured() { llmCalls++; return { associations: [] } as never; } };
    await extractPatentData(ST26, model, (e) => events.push(e));
    const assoc = events.find((e) => e.type === 'patent_associations') as Extract<TraceEvent, { type: 'patent_associations' }>;
    expect(assoc.source).toBe('st26');
    expect(llmCalls).toBe(0);
  });

  it('defaults emit to a no-op when omitted', async () => {
    const md = 'SEQ ID NO: 1\nEVQLVESGGG\n';
    const model = { async generateStructured() { return { associations: [] } as never; } };
    await expect(extractPatentData(md, model)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/patentData.test.ts`
Expected: the two emit tests FAIL (`extractPatentData` ignores the third arg, so `events` stays empty and `.map(...type)` is `[]`). The no-op test passes already.

- [ ] **Step 3: Add the event variants to sonny-shared**

In `packages/shared/src/contracts.ts`, immediately above `export type TraceEvent =` (line 174), add:

```ts
export interface ExtractionCompletenessLike {
  foundCount: number;
  referencedMax: number;
  missingSeqIds: number[];
  alphabetWarnings: Array<{ seqId: number; invalidChars: string }>;
  associationCount: number;
}
```

Then add these four members to the `TraceEvent` union (before the closing `;` on the `recommendation` line):

```ts
  | { type: 'patent_ingest'; status: 'ok' | 'failed'; format?: string }
  | { type: 'patent_extracted'; patentNumber: string | null; sequenceCount: number }
  | { type: 'patent_associations'; associationCount: number; source: 'st26' | 'llm' }
  | { type: 'patent_complete'; completeness: ExtractionCompletenessLike }
```

- [ ] **Step 4: Thread emit through extractPatentData**

In `packages/core/src/patentData.ts`, add `import type { TraceEvent } from '@mrsirquanzo/sonny-shared';` to the imports. Replace the `extractPatentData` function (lines 90-104) with:

```ts
export async function extractPatentData(
  markdown: string,
  model: StructuredModel,
  emit: (e: TraceEvent) => void = () => {},
): Promise<ExtractedPatent> {
  const patentNumber = extractPatentNumber(markdown);
  const sequences = extractSequences(markdown);
  emit({ type: 'patent_extracted', patentNumber, sequenceCount: sequences.length });
  const st26 = isST26(markdown);
  const associations = st26
    ? extractST26Associations(markdown)
    : await extractAssociations(markdown, model);
  emit({ type: 'patent_associations', associationCount: associations.length, source: st26 ? 'st26' : 'llm' });
  const byId = new Map(sequences.map((s) => [s.seqId, s.residues]));
  const completeness = computeCompleteness(sequences, associations);
  emit({ type: 'patent_complete', completeness });
  return {
    patentNumber,
    sequences,
    associations: associations.map((a) => ({ ...a, residues: byId.get(a.seqId) })),
    completeness,
  };
}
```

- [ ] **Step 5: Export ExtractionCompleteness from core**

In `packages/core/src/index.ts:24`, change the `patentData` export to include the type:

```ts
export { extractPatentData, extractAssociations, type ExtractedPatent, type RegionAssociation, type ExtractionCompleteness } from './patentData.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/patentData.test.ts`
Expected: PASS (all cases, including the pre-existing ones).

- [ ] **Step 7: Typecheck shared + core**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-shared build && pnpm --filter @mrsirquanzo/sonny-core build`
Expected: both `tsc` runs complete with no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/quanho/code/Sonny
git add packages/shared/src/contracts.ts packages/core/src/patentData.ts packages/core/src/index.ts packages/core/src/patentData.test.ts
git commit -m "feat(core): thread emit through extractPatentData with patent trace events"
```

---

### Task 2: extractPatentSequences entrypoint + CLI delegation

**Files:**
- Create: `packages/core/src/extractPatentSequences.ts`
- Modify: `packages/core/src/index.ts` (export the new entrypoint + `ExtractPatentDeps`)
- Modify: `apps/cli/src/extractPatent.ts` (delegate to the core entrypoint)
- Test: `packages/core/src/extractPatentSequences.test.ts` (new)

**Interfaces:**
- Consumes: `extractPatentData(markdown, model, emit)` (Task 1), `ingestToMarkdown` + `IngestResult` from `@mrsirquanzo/sonny-mcp-gateway`, `makeModel` + `StructuredModel` from `./model.js`, `ExtractedPatent` from `./patentData.js`, `TraceEvent` from `@mrsirquanzo/sonny-shared`.
- Produces: `extractPatentSequences(opts: { filePath: string; emit: (e: TraceEvent) => void; deps?: ExtractPatentDeps }): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }>` and `interface ExtractPatentDeps { ingest?: (filePath: string) => Promise<IngestResult>; model?: StructuredModel }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/extractPatentSequences.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractPatentSequences } from './extractPatentSequences.js';
import type { StructuredModel } from './model.js';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';

const model: StructuredModel = {
  async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 1 }] } as never; },
};

describe('extractPatentSequences', () => {
  it('emits patent_ingest ok then the stage events and returns the data', async () => {
    const events: TraceEvent[] = [];
    const ingest = async () => ({ markdown: 'US 10,123,456 B2\nSEQ ID NO: 1\nEVQLVESGGG\n', status: 'ok' as const });
    const out = await extractPatentSequences({ filePath: '/x.pdf', emit: (e) => events.push(e), deps: { ingest, model } });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.patentNumber).toBe('US10123456');
    expect(events.map((e) => e.type)).toEqual(['patent_ingest', 'patent_extracted', 'patent_associations', 'patent_complete']);
    expect((events[0] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('ok');
  });

  it('emits error and patent_ingest failed, returns ok:false, on ingest failure', async () => {
    const events: TraceEvent[] = [];
    const ingest = async () => ({ markdown: '', status: 'markitdown_unavailable' as const, error: 'not installed' });
    const out = await extractPatentSequences({ filePath: '/x.pdf', emit: (e) => events.push(e), deps: { ingest } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('not installed');
    expect(events.map((e) => e.type)).toEqual(['error', 'patent_ingest']);
    expect((events[1] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/extractPatentSequences.test.ts`
Expected: FAIL - `Cannot find module './extractPatentSequences.js'` (the file does not exist yet).

- [ ] **Step 3: Create the entrypoint**

Create `packages/core/src/extractPatentSequences.ts`:

```ts
import { ingestToMarkdown } from '@mrsirquanzo/sonny-mcp-gateway';
import type { IngestResult } from '@mrsirquanzo/sonny-mcp-gateway';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import { extractPatentData, type ExtractedPatent } from './patentData.js';
import { makeModel, type StructuredModel } from './model.js';

export interface ExtractPatentDeps {
  ingest?: (filePath: string) => Promise<IngestResult>;
  model?: StructuredModel;
}

export async function extractPatentSequences(opts: {
  filePath: string;
  emit: (e: TraceEvent) => void;
  deps?: ExtractPatentDeps;
}): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }> {
  const { filePath, emit, deps = {} } = opts;
  const ingest = deps.ingest ?? ingestToMarkdown;
  try {
    const res = await ingest(filePath);
    if (res.status !== 'ok') {
      const error = res.error ?? 'markitdown unavailable';
      emit({ type: 'error', message: error });
      emit({ type: 'patent_ingest', status: 'failed' });
      return { ok: false, error };
    }
    emit({ type: 'patent_ingest', status: 'ok' });
    const model = deps.model ?? makeModel();
    const data = await extractPatentData(res.markdown, model, emit);
    return { ok: true, data };
  } catch (e) {
    const error = `patent extraction failed: ${(e as Error).message}`;
    emit({ type: 'error', message: error });
    return { ok: false, error };
  }
}
```

- [ ] **Step 4: Export from core**

In `packages/core/src/index.ts`, add (near the other patent exports):

```ts
export { extractPatentSequences, type ExtractPatentDeps } from './extractPatentSequences.js';
```

- [ ] **Step 5: Run the entrypoint tests to verify they pass**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/extractPatentSequences.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Repoint the CLI runner to delegate**

Replace the entire contents of `apps/cli/src/extractPatent.ts` with:

```ts
import { extractPatentSequences } from '@mrsirquanzo/sonny-core';
import type { ExtractPatentDeps, ExtractedPatent } from '@mrsirquanzo/sonny-core';

export type { ExtractPatentDeps };

export async function runExtractPatent(
  filePath: string,
  deps: ExtractPatentDeps = {},
): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }> {
  return extractPatentSequences({ filePath, emit: () => {}, deps });
}
```

- [ ] **Step 7: Run the CLI tests to verify delegation kept behavior**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @sonny/cli exec vitest run src/extractPatent.test.ts`
Expected: PASS (both existing cases - the happy path and the markitdown-unavailable path - still hold through delegation).

- [ ] **Step 8: Typecheck core + cli**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-core build && pnpm --filter @sonny/cli build`
Expected: both `tsc` runs complete with no errors.

- [ ] **Step 9: Commit**

```bash
cd /Users/quanho/code/Sonny
git add packages/core/src/extractPatentSequences.ts packages/core/src/extractPatentSequences.test.ts packages/core/src/index.ts apps/cli/src/extractPatent.ts
git commit -m "feat(core): streamable extractPatentSequences entrypoint; CLI delegates"
```

---

## Self-Review

**Spec coverage:**
- New streaming entrypoint `extractPatentSequences({ filePath, emit, deps })` -> Task 2. Covered.
- Four `TraceEvent` variants in `sonny-shared` with the `ExtractionCompletenessLike` mirror (no core import) -> Task 1 Steps 3. Covered.
- Optional `emit` threaded through `extractPatentData`, defaulting to no-op, stages emitted in order -> Task 1 Steps 4 + tests. Covered.
- `patent_extracted` before the association step -> Task 1 Step 4 (emit is before the `await extractAssociations`). Covered.
- ST.26 reports `source: 'st26'` with zero model calls -> Task 1 Step 1 second test. Covered.
- Ingest failure returns `{ ok: false, error }` with `error` + `patent_ingest(failed)`, no later events -> Task 2 Step 1 second test. Covered.
- CLI `runExtractPatent` delegates; `extract-patent` keeps working -> Task 2 Steps 6-7. Covered.
- Exports for LUMINA (`extractPatentSequences`, `ExtractPatentDeps`, `ExtractedPatent`, `RegionAssociation`, `ExtractionCompleteness`) -> Task 1 Step 5 + Task 2 Step 4 (`ExtractedPatent`/`RegionAssociation` already exported). Covered.
- Result not mapped into `Briefing` -> no such mapping exists in the plan. Covered.

**Placeholder scan:** No TBD/TODO/vague steps; every code and command step is concrete. The ST.26 test reuses the file's existing `ST26` fixture constant (named, not a placeholder).

**Type consistency:** `extractPatentSequences`, `ExtractPatentDeps`, `ExtractedPatent`, `ExtractionCompletenessLike`, and the four event `type` strings are identical across the spec, both tasks, and the exports. `extractPatentData`'s new optional third parameter matches between Task 1's implementation and Task 2's consumption.
