# Surface Unreadable Patent Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `extractPatentSequences` fail explicitly when the ingested document has no extractable text, instead of returning a clean empty result.

**Architecture:** Add a pure `isReadableMarkdown` predicate and a guard in `extractPatentSequences` that, after a successful ingest whose content is empty or near-empty, emits the existing failure vocabulary (`error` + `patent_ingest(failed)`) and returns `{ ok: false, error }`.

**Tech Stack:** TypeScript ESM monorepo (pnpm), Vitest. Package `@mrsirquanzo/sonny-core`.

## Global Constraints

- Never use the em dash; use a plain dash.
- Threshold is a single fixed value: `MIN_READABLE_CHARS = 50` (non-whitespace characters). Not an env var, not tunable.
- The unreadable path uses the SAME failure vocabulary as the existing ingest-failure path: `emit({ type: 'error', message })` then `emit({ type: 'patent_ingest', status: 'failed' })`, then `return { ok: false, error }`.
- The error message is exactly: `ingested document has no extractable text (likely a scanned or image-only PDF requiring OCR)`.
- Scope: only `packages/core/src/extractPatentSequences.ts` and its test. Do NOT touch `runPatentWorkup`, `ingestToMarkdown`, or the `IngestResult` contract.
- The predicate must run AFTER the `status !== 'ok'` check and BEFORE `emit({ type: 'patent_ingest', status: 'ok' })`, so an unreadable document emits no stage events and makes no model call.

---

### Task 1: isReadableMarkdown predicate + unreadable-ingest guard

**Files:**
- Modify: `packages/core/src/extractPatentSequences.ts`
- Test: `packages/core/src/extractPatentSequences.test.ts` (append cases)

**Interfaces:**
- Consumes: the existing `extractPatentSequences(opts)` and its `emit`/`deps` shape; `extractPatentData` (unchanged).
- Produces: `export function isReadableMarkdown(markdown: string): boolean` and the new guard behavior.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/extractPatentSequences.test.ts`. Add `isReadableMarkdown` to the import from `./extractPatentSequences.js`.

```ts
describe('isReadableMarkdown', () => {
  it('is false for empty, whitespace, or near-empty text and true above the floor', () => {
    expect(isReadableMarkdown('')).toBe(false);
    expect(isReadableMarkdown('   \n \t ')).toBe(false);
    expect(isReadableMarkdown('A')).toBe(false);
    expect(isReadableMarkdown('x'.repeat(60))).toBe(true);
    expect(isReadableMarkdown('  ' + 'x'.repeat(60) + '  \n')).toBe(true);
  });
});

describe('extractPatentSequences unreadable ingest', () => {
  it('fails explicitly when ingest is ok but the document has no extractable text', async () => {
    const events: TraceEvent[] = [];
    let modelCalls = 0;
    const model: StructuredModel = { async generateStructured() { modelCalls++; return { associations: [] } as never; } };
    const ingest = async () => ({ markdown: '\n \n', status: 'ok' as const });
    const out = await extractPatentSequences({ filePath: '/scan.pdf', emit: (e) => events.push(e), deps: { ingest, model } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('OCR');
    expect(events.map((e) => e.type)).toEqual(['error', 'patent_ingest']);
    expect((events[1] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('failed');
    expect(modelCalls).toBe(0);
  });

  it('does NOT flag a readable document that simply has no sequences', async () => {
    const events: TraceEvent[] = [];
    const prose = 'This patent describes a method of treatment. '.repeat(20); // long, readable, no SEQ IDs
    const model: StructuredModel = { async generateStructured() { return { associations: [] } as never; } };
    const ingest = async () => ({ markdown: prose, status: 'ok' as const });
    const out = await extractPatentSequences({ filePath: '/x.pdf', emit: (e) => events.push(e), deps: { ingest, model } });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.sequences.length).toBe(0);
    expect(events[0].type).toBe('patent_ingest');
    expect((events[0] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('ok');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/extractPatentSequences.test.ts`
Expected: the `isReadableMarkdown` suite FAILS to compile/run (`isReadableMarkdown is not exported`), and the unreadable-ingest test FAILS (current code emits `patent_ingest(ok)` and proceeds, so events are not `['error','patent_ingest']`). The false-positive-guard test passes already.

- [ ] **Step 3: Add the predicate and the guard**

In `packages/core/src/extractPatentSequences.ts`, add the constant and predicate above `export async function extractPatentSequences` (after the `ExtractPatentDeps` interface):

```ts
const MIN_READABLE_CHARS = 50;

// True when the ingested markdown carries enough non-whitespace text to be worth
// extracting. Guards the scanned/image-only PDF case where markitdown returns
// (near-)empty text: without this, an unreadable document is indistinguishable
// from a readable patent that discloses no sequences.
export function isReadableMarkdown(markdown: string): boolean {
  return markdown.replace(/\s/g, '').length >= MIN_READABLE_CHARS;
}
```

Then, inside `extractPatentSequences`, insert the guard between the `status !== 'ok'` block and `emit({ type: 'patent_ingest', status: 'ok' })`:

```ts
    if (!isReadableMarkdown(res.markdown)) {
      const error = 'ingested document has no extractable text (likely a scanned or image-only PDF requiring OCR)';
      emit({ type: 'error', message: error });
      emit({ type: 'patent_ingest', status: 'failed' });
      return { ok: false, error };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/extractPatentSequences.test.ts`
Expected: PASS (all cases, including the pre-existing happy-path and failure tests).

- [ ] **Step 5: Typecheck core**

Run: `cd /Users/quanho/code/Sonny && pnpm --filter @mrsirquanzo/sonny-core build`
Expected: `tsc` completes with no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/quanho/code/Sonny
git add packages/core/src/extractPatentSequences.ts packages/core/src/extractPatentSequences.test.ts
git commit -m "fix(core): fail extractPatentSequences when ingest yields no extractable text"
```

---

## Self-Review

**Spec coverage:**
- Predicate `isReadableMarkdown` with `MIN_READABLE_CHARS = 50` non-whitespace -> Task 1 Step 3. Covered.
- Guard placed after `status !== 'ok'`, before `patent_ingest(ok)`, so no stage events / model call on unreadable input -> Task 1 Step 3 placement + the `modelCalls === 0` assertion. Covered.
- Same failure vocabulary (`error` then `patent_ingest(failed)`, `ok:false`) -> Task 1 Step 3 + first test. Covered.
- Exact error message containing `OCR` -> Step 3 message + test assertion. Covered.
- False-positive guard (readable, no sequences, still `ok:true`, not flagged) -> Task 1 Step 1 second test. Covered.
- Existing happy-path unchanged -> pre-existing tests remain in the file and are run by the same command. Covered.
- Scope limited to the two files -> only those are touched. Covered.

**Placeholder scan:** No TBD/TODO/vague steps; every code and command step is concrete.

**Type consistency:** `isReadableMarkdown(markdown: string): boolean`, `MIN_READABLE_CHARS`, the event `type` strings (`error`, `patent_ingest`), and the `{ ok: false; error }` return shape match the spec and the existing file exactly.
