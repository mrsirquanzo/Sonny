# H2 Correctness Closers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Close two silent-failure paths: fragment false-positives on `exactMatch` (via a declared-length guard) and silently-dropped ST.26 XML sequence listings (via a detect + parse path).

**Architecture:** Declared length is captured at extraction (ST.25 `<210>/<211>` pairs and ST.26 `<INSDSeq_length>`) and threaded through `patentData` into `reconcilePatent`, where the full-length guard downgrades `exactMatch` and sets `fullLengthConfirmed`. A router picks the ST.26 XML parser vs the text regex based on content.

**Tech Stack:** TypeScript ESM, Vitest, pnpm workspaces, fast-xml-parser (already a mcp-gateway dep).

## Global Constraints

- No em dashes; plain dash. No commit co-author trailer.
- ESM `.js` import specifiers.
- Extraction functions never throw (soft-extraction contract): malformed ST.26 XML yields `[]`.
- exactMatch guard (confirmed): declaredLength known+equal -> keep blast-level exactMatch, fullLengthConfirmed true; known+different -> exactMatch forced false, fullLengthConfirmed false; unknown -> keep blast-level exactMatch, fullLengthConfirmed false.
- `toBlastHit` stays pure blast-level; the full-length guard lives in `reconcilePatent`.
- Additive: `declaredLength` and `fullLengthConfirmed` are optional; existing callers/tests keep working.
- Run `pnpm -r build` (real tsc) before finishing each task that touches mcp-gateway/core, not just `pnpm -r test`.

---

### Task 1: Declared length capture (ST.25) on `ExtractedSequence`

**Files:**
- Modify: `packages/mcp-gateway/src/patentExtract.ts`
- Test: `packages/mcp-gateway/src/patentExtract.test.ts`

**Interfaces:**
- Produces: `ExtractedSequence` gains `declaredLength?: number`; `extractSequenceListing` populates it from ST.25 `<210> N ... <211> M` pairs when present.

- [ ] **Step 1: Write the failing test**

Append to `packages/mcp-gateway/src/patentExtract.test.ts`:

```ts
describe('extractSequenceListing declared length', () => {
  it('captures ST.25 <211> length paired with <210> seq id', () => {
    const md = '<210> 1\n<211> 12\n<212> PRT\n<213> Homo sapiens\nSEQ ID NO: 1\nARDYYGSSYFDY\n\n';
    const out = extractSequenceListing(md);
    const s1 = out.find((s) => s.seqId === 1);
    expect(s1?.residues).toBe('ARDYYGSSYFDY');
    expect(s1?.declaredLength).toBe(12);
  });

  it('leaves declaredLength undefined when no length is declared', () => {
    const md = 'SEQ ID NO: 2\nEVQLVESGG\n\n';
    const out = extractSequenceListing(md);
    expect(out.find((s) => s.seqId === 2)?.declaredLength).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- patentExtract`
Expected: FAIL (declaredLength not populated).

- [ ] **Step 3: Implement**

In `packages/mcp-gateway/src/patentExtract.ts`, add `declaredLength?` to the interface:

```ts
export interface ExtractedSequence {
  seqId: number;
  residues: string;
  declaredLength?: number;
}
```

Add a helper that maps seqId -> declared length from ST.25 numeric-identifier pairs (`<210> N` followed within a short window by `<211> M`):

```ts
// ST.25 numeric identifiers: <210> is the SEQ ID number, <211> is its length.
// Pair them when <211> follows <210> within a small window (the <212>/<213> lines may sit between).
function declaredLengths(markdown: string): Map<number, number> {
  const re = /<210>\s*(\d+)[\s\S]{0,60}?<211>\s*(\d+)/g;
  const out = new Map<number, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const id = Number(m[1]);
    if (!out.has(id)) out.set(id, Number(m[2]));
  }
  return out;
}
```

In `extractSequenceListing`, build the map once and attach `declaredLength` per sequence:

```ts
export function extractSequenceListing(markdown: string): ExtractedSequence[] {
  const listing = /SEQ\s*ID\s*NO[:.\s]*?(\d+)\s*[:.)\-]?\s*\n?([A-Z][A-Z0-9\s]*?)(?=SEQ\s*ID\s*NO|\n\s*\n|$)/g;
  const lengths = declaredLengths(markdown);
  const out: ExtractedSequence[] = [];
  const seen = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = listing.exec(markdown)) !== null) {
    const seqId = Number(m[1]);
    if (seen.has(seqId)) continue;
    const residues = normalizeResidues(m[2]);
    if (residues.length < 4) continue;
    seen.add(seqId);
    const declaredLength = lengths.get(seqId);
    out.push(declaredLength !== undefined ? { seqId, residues, declaredLength } : { seqId, residues });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass, then full gateway suite + build**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- patentExtract` (PASS), then `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test` (PASS), then `pnpm -r build` (Done).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/patentExtract.ts packages/mcp-gateway/src/patentExtract.test.ts
git commit -m "feat(mcp-gateway): capture ST.25 declared length on extracted sequences"
```

---

### Task 2: ST.26 detect + parse + router

**Files:**
- Modify: `packages/mcp-gateway/src/patentExtract.ts`
- Modify: `packages/mcp-gateway/src/index.ts`
- Test: `packages/mcp-gateway/src/patentExtract.test.ts`

**Interfaces:**
- Consumes: `XMLParser` from `fast-xml-parser`.
- Produces: `isST26(content)`, `extractSequenceListingST26(content)`, `extractSequences(content)`; exported from index.

- [ ] **Step 1: Write the failing test**

Append to `packages/mcp-gateway/src/patentExtract.test.ts`:

```ts
import { isST26, extractSequenceListingST26, extractSequences } from './patentExtract.js';

const ST26 = `<?xml version="1.0"?>
<ST26SequenceListing>
  <SequenceData sequenceIDNumber="1">
    <INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_moltype>AA</INSDSeq_moltype><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence></INSDSeq>
  </SequenceData>
  <SequenceData sequenceIDNumber="2">
    <INSDSeq><INSDSeq_length>9</INSDSeq_length><INSDSeq_moltype>AA</INSDSeq_moltype><INSDSeq_sequence>EVQLVESGG</INSDSeq_sequence></INSDSeq>
  </SequenceData>
</ST26SequenceListing>`;

describe('ST.26 parsing', () => {
  it('isST26 detects XML listing vs text', () => {
    expect(isST26(ST26)).toBe(true);
    expect(isST26('SEQ ID NO: 1\nEVQLVESGG\n')).toBe(false);
  });

  it('extractSequenceListingST26 yields seqId, residues, declaredLength', () => {
    const out = extractSequenceListingST26(ST26);
    expect(out).toEqual([
      { seqId: 1, residues: 'ARDYYGSSYFDY', declaredLength: 12 },
      { seqId: 2, residues: 'EVQLVESGG', declaredLength: 9 },
    ]);
  });

  it('returns [] on malformed xml and skips <4-residue entries', () => {
    expect(extractSequenceListingST26('<ST26SequenceListing><SequenceData')).toEqual([]);
    const short = ST26.replace('ARDYYGSSYFDY', 'AR');
    expect(extractSequenceListingST26(short).map((s) => s.seqId)).toEqual([2]);
  });

  it('extractSequences routes ST.26 to the xml path and text to the regex path', () => {
    expect(extractSequences(ST26).map((s) => s.seqId)).toEqual([1, 2]);
    expect(extractSequences('SEQ ID NO: 5\nEVQLVESGG\n\n').map((s) => s.seqId)).toEqual([5]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- patentExtract`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement**

At the top of `patentExtract.ts` add the import:

```ts
import { XMLParser } from 'fast-xml-parser';
```

Add near the bottom:

```ts
export function isST26(content: string): boolean {
  return /<ST26SequenceListing|<INSDSeq_sequence>/.test(content);
}

const st26Parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function extractSequenceListingST26(content: string): ExtractedSequence[] {
  let parsed: unknown;
  try { parsed = st26Parser.parse(content); } catch { return []; }
  const root = (parsed as { ST26SequenceListing?: { SequenceData?: unknown } })?.ST26SequenceListing;
  const data = asArray(root?.SequenceData) as Array<Record<string, unknown>>;
  const out: ExtractedSequence[] = [];
  const seen = new Set<number>();
  for (const d of data) {
    const seqId = Number(d['@_sequenceIDNumber']);
    if (!Number.isInteger(seqId) || seen.has(seqId)) continue;
    const insd = (d.INSDSeq ?? {}) as Record<string, unknown>;
    const residues = normalizeResidues(String(insd.INSDSeq_sequence ?? ''));
    if (residues.length < 4) continue;
    const len = Number(insd['INSDSeq_length']);
    seen.add(seqId);
    out.push(Number.isInteger(len) ? { seqId, residues, declaredLength: len } : { seqId, residues });
  }
  return out;
}

export function extractSequences(content: string): ExtractedSequence[] {
  return isST26(content) ? extractSequenceListingST26(content) : extractSequenceListing(content);
}
```

In `packages/mcp-gateway/src/index.ts`, extend the patentExtract export to include the new symbols:

```ts
export { extractPatentNumber, extractSequenceListing, extractSequences, extractSequenceListingST26, isST26 } from './patentExtract.js';
```

- [ ] **Step 4: Run to verify pass, then full gateway suite + build**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- patentExtract` (PASS), then `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test` (PASS), then `pnpm -r build` (Done).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/patentExtract.ts packages/mcp-gateway/src/index.ts packages/mcp-gateway/src/patentExtract.test.ts
git commit -m "feat(mcp-gateway): ST.26 XML sequence-listing parser and extraction router"
```

---

### Task 3: Route `patentData` through `extractSequences` + thread declaredLength

**Files:**
- Modify: `packages/core/src/patentData.ts`
- Test: `packages/core/src/patentData.test.ts`

**Interfaces:**
- Consumes: `extractSequences` from `@mrsirquanzo/sonny-mcp-gateway`.
- Produces: `extractPatentData` uses the router; assembled `sequences` carry `declaredLength`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/patentData.test.ts` (reuse the file's existing model-stub style):

```ts
describe('extractPatentData ST.26 + declaredLength', () => {
  it('extracts sequences from an ST.26 listing and carries declaredLength', async () => {
    const st26 = '<ST26SequenceListing><SequenceData sequenceIDNumber="1"><INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence></INSDSeq></SequenceData></ST26SequenceListing>';
    const model = { async generateStructured() { return { associations: [] } as never; } };
    const out = await extractPatentData(st26, model);
    const s1 = out.sequences.find((s) => s.seqId === 1);
    expect(s1?.residues).toBe('ARDYYGSSYFDY');
    expect(s1?.declaredLength).toBe(12);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-core test -- patentData`
Expected: FAIL (text regex finds nothing in the XML; sequences empty).

- [ ] **Step 3: Implement**

In `packages/core/src/patentData.ts`, change the import from `extractSequenceListing` to `extractSequences`:

```ts
import { extractPatentNumber, extractSequences } from '@mrsirquanzo/sonny-mcp-gateway';
```

Change the call site (currently `const sequences = extractSequenceListing(markdown);`):

```ts
  const sequences = extractSequences(markdown);
```

`ExtractedSequence` already carries `declaredLength`, and `sequences` is passed through onto the result, so no further threading is needed here. Confirm the assembled result's `sequences` are the same objects (they already are - the existing code spreads/returns `sequences`). If `computeCompleteness` or any local mapping rebuilds sequence objects and drops `declaredLength`, preserve it.

- [ ] **Step 4: Run to verify pass, then full core suite + build**

Run: `pnpm --filter @mrsirquanzo/sonny-core test -- patentData` (PASS), then `pnpm --filter @mrsirquanzo/sonny-core test` (PASS), then `pnpm -r build` (Done).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/patentData.ts packages/core/src/patentData.test.ts
git commit -m "feat(core): route extraction through extractSequences (ST.26 aware) with declaredLength"
```

---

### Task 4: exactMatch full-length guard in `reconcilePatent`

**Files:**
- Modify: `packages/core/src/patentReconcile.ts`
- Test: `packages/core/src/patentReconcile.test.ts`

**Interfaces:**
- Consumes: `declaredLength` on the extracted sequences; `toBlastHit` (unchanged, blast-level).
- Produces: `VerifiedSequence` gains `declaredLength?: number` and `fullLengthConfirmed?: boolean`; `exactMatch` on that sequence's hits is downgraded per the guard.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/patentReconcile.test.ts` (reuse the file's existing dep-injection style; the key is a blast dep returning a 100%/full-coverage hit so `toBlastHit` yields `exactMatch: true`, then vary declaredLength vs residue length):

```ts
describe('exactMatch full-length guard', () => {
  const exactHitEvidence = (accession: string) => ({
    id: `BLAST:${accession}`, kind: 'patent' as const, source: 'b', title: 't', snippet: '', url: '', retrievedAt: '',
    raw: { accession, percentIdentity: 100, queryCoverage: 100, identity: 12, alignLen: 12, organism: '' },
  });
  // Adapt the extracted-patent input shape to what reconcilePatent consumes in this file's other tests.
  function inputWith(residues: string, declaredLength?: number) {
    return { patentNumber: 'US1', sequences: [ declaredLength !== undefined
      ? { seqId: 1, residues, declaredLength } : { seqId: 1, residues } ], associations: [] };
  }
  const deps = (acc: string) => ({
    blast: async (_seq: string, db: string) => db === 'pataa' ? [exactHitEvidence(acc)] : [exactHitEvidence(acc)],
    anarci: async () => ({ overallStatus: 'skipped', domains: [], regionChecks: [], speciesSummary: [] }),
    epo: async () => ({ input: 'US1', found: false, applicants: [], inventors: [], ipc: [], family: [] }),
  });

  it('declared length equals extracted -> exactMatch kept, fullLengthConfirmed true', async () => {
    const r = await reconcilePatent(inputWith('A'.repeat(60), 60) as never, deps('PAT_A'));
    const s = r.sequences[0];
    expect(s.fullLengthConfirmed).toBe(true);
    expect(s.patentHits[0].exactMatch).toBe(true);
  });

  it('declared length differs from extracted -> exactMatch forced false, fullLengthConfirmed false', async () => {
    const r = await reconcilePatent(inputWith('A'.repeat(60), 120) as never, deps('PAT_B'));
    const s = r.sequences[0];
    expect(s.fullLengthConfirmed).toBe(false);
    expect(s.patentHits[0].exactMatch).toBe(false);
  });

  it('declared length unknown -> exactMatch kept, fullLengthConfirmed false', async () => {
    const r = await reconcilePatent(inputWith('A'.repeat(60)) as never, deps('PAT_C'));
    const s = r.sequences[0];
    expect(s.fullLengthConfirmed).toBe(false);
    expect(s.patentHits[0].exactMatch).toBe(true);
  });
});
```

NOTE to implementer: the exact input shape and the `deps` wiring must match how `reconcilePatent`'s other tests in this file construct them (BLAST only runs for sequences >= 50 residues - hence 60-length residues above; `patentHits` is the pataa-filtered list). Read the existing tests and adapt the harness names accordingly; keep the three assertions.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-core test -- patentReconcile`
Expected: FAIL (`fullLengthConfirmed` undefined; exactMatch not downgraded).

- [ ] **Step 3: Implement**

In `packages/core/src/patentReconcile.ts`:

Add to `VerifiedSequence`:

```ts
  declaredLength?: number;
  fullLengthConfirmed?: boolean;
```

Where each `VerifiedSequence` is built, carry `declaredLength` from the extracted sequence, compute `fullLengthConfirmed`, and apply the guard to every hit (both `nrTopHit` and `patentHits`). Add a helper and use it:

```ts
function applyFullLengthGuard(hits: BlastHit[], extractedLen: number, declaredLength: number | undefined): { hits: BlastHit[]; fullLengthConfirmed: boolean } {
  const lengthMismatch = declaredLength !== undefined && extractedLen !== declaredLength;
  const fullLengthConfirmed = declaredLength !== undefined && extractedLen === declaredLength;
  const guarded = lengthMismatch ? hits.map((h) => ({ ...h, exactMatch: false })) : hits;
  return { hits: guarded, fullLengthConfirmed };
}
```

When assembling each sequence's result, set `declaredLength` from the extracted sequence, run the guard over its hits, and set `fullLengthConfirmed`. Apply the same guard to `nrTopHit` if present (wrap it in an array or guard it inline). The extracted length is the sequence's `residues.length` (already stored as `length`).

- [ ] **Step 4: Run to verify pass, then full core suite + build**

Run: `pnpm --filter @mrsirquanzo/sonny-core test -- patentReconcile` (PASS), then `pnpm --filter @mrsirquanzo/sonny-core test` (PASS), then `pnpm -r build` (Done), then `pnpm -r test` (all packages PASS).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/patentReconcile.ts packages/core/src/patentReconcile.test.ts
git commit -m "feat(core): exactMatch full-length guard using declared sequence length"
```

---

## Self-review notes

- Task ordering: extraction (1, 2) -> data wiring (3) -> reconcile guard (4). Each is independently testable and green.
- The guard is applied to BOTH `nrTopHit` and `patentHits` so a truncated fragment cannot claim exactMatch on either database.
- `toBlastHit` stays pure; the guard is a reconcile-layer concern (the only layer holding declared + extracted length).
- ST.26 region annotations (`INSDFeature`) are deliberately deferred - the association map still owns region<->SEQ-ID.
- Every mcp-gateway/core task runs `pnpm -r build` (real tsc), pre-empting the vitest-hides-type-errors trap seen in H4/H1b.
