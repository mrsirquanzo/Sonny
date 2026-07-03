# CDR-Level Competitor Matching Implementation Plan (H4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch humanized/affinity-matured competitors that share CDR-H3 but diverge across framework (below the whole-VH 98% filter) by BLASTing each construct's CDR-H3 against the patent DB with short-query parameters.

**Architecture:** `blast_verify` gains optional short-query params. A new `matchCdrCompetitors` (core) BLASTs each construct's ANARCI-derived CDR-H3 against `pataa`, attaching CDR-level competitor hits and cdr-level graph edges. The CLI wires it in; the eval derives the overlap level from edge provenance.

**Tech Stack:** TypeScript ESM, Vitest. Test runner: `pnpm --filter @sonny/<pkg> test`.

**Spec:** [docs/specs/2026-07-02-h4-cdr-competitor-matching-design.md](../specs/2026-07-02-h4-cdr-competitor-matching-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension; all imports at the top.
- `matchCdrCompetitors` NEVER throws (a BLAST failure leaves that construct's `cdrCompetitors` empty).
- CDR-H3 competitor threshold is `CDRH3_MIN_IDENTITY = 90` (CDR-H3 is short and diverse - require high identity).
- Do NOT lower the whole-VH threshold (that is the noise trap the design rejects).
- Touch only the files named in each task.

## File Structure

- Modify: `packages/mcp-gateway/src/blastVerify.ts` (+ test) - short-query params.
- Modify: `packages/core/src/patentReconcile.ts` - export `toBlastHit`.
- Modify: `packages/core/src/patentWorkup.ts` (+ test) - `WorkedConstruct.cdrCompetitors`, `matchCdrCompetitors`, cdr-level graph edges; `packages/core/src/index.ts` export.
- Modify: `apps/cli/src/patentWorkup.ts` (+ test) - wire the CDR match into `runPatentWorkup`.
- Modify: `eval/src/patentPipeline.ts` (+ test) - derive overlap level from edge provenance.

---

### Task 1: `blast_verify` short-query parameters

**Files:**
- Modify: `packages/mcp-gateway/src/blastVerify.ts`
- Test: `packages/mcp-gateway/src/blastVerify.test.ts`

**Interfaces:**
- Produces: `blast_verify` accepts optional `wordSize` (-> `WORD_SIZE`) and `matrix` (-> `MATRIX`) args; when omitted the submit body is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mcp-gateway/src/blastVerify.test.ts` (reuse the existing `SUBMIT`, `statusBody`, `RESULT_XML` helpers):

```ts
describe('blastVerifyTool short-query params', () => {
  function captureBodyFetch(bodyOut: { value: string }) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') { bodyOut.value = String(init.body); return new Response(SUBMIT, { status: 200 }); }
      if (String(url).includes('FORMAT_OBJECT=SearchInfo')) return new Response(statusBody('READY'), { status: 200 });
      return new Response(RESULT_XML, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('adds WORD_SIZE and MATRIX to the submit body when provided', async () => {
    const body = { value: '' };
    await blastVerifyTool.call({ sequence: 'EVQLVESGGG', wordSize: 2, matrix: 'PAM30', pollIntervalMs: 0 }, captureBodyFetch(body));
    expect(body.value).toContain('WORD_SIZE=2');
    expect(body.value).toContain('MATRIX=PAM30');
  });

  it('omits WORD_SIZE and MATRIX when not provided', async () => {
    const body = { value: '' };
    await blastVerifyTool.call({ sequence: 'EVQLVESGGG', pollIntervalMs: 0 }, captureBodyFetch(body));
    expect(body.value).not.toContain('WORD_SIZE');
    expect(body.value).not.toContain('MATRIX');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- blastVerify`
Expected: FAIL - the body does not yet contain the params.

- [ ] **Step 3: Implement**

In `packages/mcp-gateway/src/blastVerify.ts`, after the `const body = new URLSearchParams({...})` block, add:

```ts
    if (args.wordSize !== undefined) body.set('WORD_SIZE', String(Number(args.wordSize)));
    if (args.matrix !== undefined) body.set('MATRIX', String(args.matrix));
```

- [ ] **Step 4: Run to verify pass, then full gateway suite**

Run: `pnpm --filter @sonny/mcp-gateway test -- blastVerify` (PASS), then `pnpm --filter @sonny/mcp-gateway test` (PASS).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/blastVerify.ts packages/mcp-gateway/src/blastVerify.test.ts
git commit -m "feat(mcp-gateway): support WORD_SIZE and MATRIX short-query params in blast_verify"
```

---

### Task 2: `matchCdrCompetitors` + cdr-level graph edges

**Files:**
- Modify: `packages/core/src/patentReconcile.ts` (export `toBlastHit`)
- Modify: `packages/core/src/patentWorkup.ts`
- Test: `packages/core/src/patentWorkup.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `toBlastHit`, `BlastHit`, `VerifiedSequence`, `PatentReconciliation` from `./patentReconcile.js`; `Evidence` from `@sonny/shared`.
- Produces: `WorkedConstruct` gains `cdrCompetitors?: BlastHit[]`; `type CdrBlast`; `matchCdrCompetitors(workup, reconciliation, blast): Promise<void>` (mutates `workup`).

- [ ] **Step 1: Export `toBlastHit`**

In `packages/core/src/patentReconcile.ts`, change `function toBlastHit(` to `export function toBlastHit(`.

- [ ] **Step 2: Write the failing tests**

Append to `packages/core/src/patentWorkup.test.ts`:

```ts
import { matchCdrCompetitors, graphRelationships } from './patentWorkup.js';
import type { PatentReconciliation, VerifiedSequence } from './patentReconcile.js';
import type { Evidence } from '@sonny/shared';

function evH(raw: Record<string, unknown>): Evidence {
  return { id: `BLAST:${raw.accession}`, kind: 'patent', source: 'blast', title: 'hit', snippet: '', url: '', raw, retrievedAt: '' };
}

function reconWithVh(cdrh3: string): PatentReconciliation {
  const vh: VerifiedSequence = {
    seqId: 1, residues: 'E'.repeat(60), regionLabels: ['VH'], length: 60, blasted: true, patentHits: [],
    domain: { chain: 'H', species: 'homo_sapiens', numberedRegions: { 'CDR-H3': { seq: cdrh3, imgtStart: 105, imgtEnd: 117, residues: [] } } },
  };
  return { patent: { input: 'US1', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }, sequences: [vh] };
}

describe('matchCdrCompetitors', () => {
  const workupWith = () => ({
    patentNumber: 'US1', patent: { input: 'US1', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] },
    constructs: [{ name: 'Ab1', regions: [{ regionLabel: 'VH' as const, seqId: 1, residues: 'E'.repeat(60) }], species: { classification: 'human-like' as const, evidence: '' } }],
    ungrouped: [], narrative: { summary: '', points: [] }, graph: [],
  });

  it('BLASTs the derived CDR-H3 against pataa with short-query opts and keeps >=90% hits', async () => {
    const calls: Array<{ seq: string; db: string; opts: unknown }> = [];
    const blast = async (seq: string, db: string, opts?: unknown) => {
      calls.push({ seq, db, opts });
      return [evH({ accession: 'PAT_CDR', percentIdentity: 100, queryCoverage: 100, identity: 12, alignLen: 12, organism: '' }),
        evH({ accession: 'PAT_LOW', percentIdentity: 85, queryCoverage: 100, identity: 10, alignLen: 12, organism: '' })];
    };
    const wk = workupWith();
    await matchCdrCompetitors(wk, reconWithVh('ARDYYGSSYFDY'), blast);
    expect(calls[0].seq).toBe('ARDYYGSSYFDY');
    expect(calls[0].db).toBe('pataa');
    expect(calls[0].opts).toMatchObject({ wordSize: 2, matrix: 'PAM30' });
    expect(wk.constructs[0].cdrCompetitors?.map((h) => h.accession)).toEqual(['PAT_CDR']); // PAT_LOW 85% dropped
  });

  it('does not BLAST when the VH has no derived CDR-H3, and never throws on a blast failure', async () => {
    const wk = workupWith();
    await matchCdrCompetitors(wk, { patent: reconWithVh('X').patent, sequences: [{ seqId: 1, residues: 'E'.repeat(60), regionLabels: ['VH'], length: 60, blasted: true, patentHits: [] }] }, async () => { throw new Error('x'); });
    expect(wk.constructs[0].cdrCompetitors ?? []).toEqual([]);
  });

  it('graphRelationships emits a cdr-level MATCHES edge keyed on the VH SEQ with provenance blast-cdr-h3', () => {
    const wk = workupWith();
    wk.constructs[0].cdrCompetitors = [{ database: 'pataa', accession: 'PAT_CDR', title: 't', percentIdentity: 100, queryCoverage: 100, mismatchCount: 0, exactMatch: true, organism: '' }];
    const g = graphRelationships(wk as never);
    expect(g).toContainEqual({ subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_CDR', provenance: 'blast-cdr-h3', confidence: 'claimed' });
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: FAIL - `matchCdrCompetitors` not exported.

- [ ] **Step 4: Implement**

In `packages/core/src/patentWorkup.ts`:

Add to the top imports:

```ts
import type { Evidence } from '@sonny/shared';
import { toBlastHit } from './patentReconcile.js';
import type { BlastHit, VerifiedSequence, PatentReconciliation } from './patentReconcile.js';
```

(If `BlastHit`/`VerifiedSequence`/`PatentReconciliation` are already imported, do not duplicate.)

Add `cdrCompetitors?: BlastHit[];` to the `WorkedConstruct` interface.

Add:

```ts
const CDRH3_MIN_IDENTITY = 90;

export type CdrBlast = (
  sequence: string,
  database: string,
  opts?: { wordSize?: number; matrix?: string; expect?: number },
) => Promise<Evidence[]>;

export async function matchCdrCompetitors(
  workup: PatentWorkup,
  reconciliation: PatentReconciliation,
  blast: CdrBlast,
): Promise<void> {
  const bySeq = new Map<number, VerifiedSequence>(reconciliation.sequences.map((s) => [s.seqId, s]));
  for (const c of workup.constructs) {
    const vhSeqId = c.regions.find((r) => r.regionLabel === 'VH')?.seqId;
    const cdrh3 = vhSeqId !== undefined ? bySeq.get(vhSeqId)?.domain?.numberedRegions?.['CDR-H3']?.seq : undefined;
    if (!cdrh3) continue;
    try {
      const hits = await blast(cdrh3, 'pataa', { wordSize: 2, matrix: 'PAM30', expect: 200000 });
      c.cdrCompetitors = hits
        .map((h) => toBlastHit(h, 'pataa'))
        .filter((h): h is BlastHit => h !== undefined && h.percentIdentity >= CDRH3_MIN_IDENTITY);
    } catch {
      c.cdrCompetitors = [];
    }
  }
}
```

In `graphRelationships`, inside the `for (const c of workup.constructs)` loop (after the existing region edges), add cdr-level edges keyed on the VH SEQ:

```ts
    const vhSeqId = c.regions.find((r) => r.regionLabel === 'VH')?.seqId;
    if (vhSeqId !== undefined) {
      for (const hit of c.cdrCompetitors ?? []) {
        edges.push({ subject: `SEQ:${vhSeqId}`, predicate: 'MATCHES', object: hit.accession, provenance: 'blast-cdr-h3', confidence: 'claimed' });
      }
    }
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: PASS.

- [ ] **Step 6: Export and commit**

In `packages/core/src/index.ts`, add `matchCdrCompetitors, type CdrBlast` to the `patentWorkup.js` export.

Run: `pnpm --filter @sonny/core test` (PASS).

```bash
git add packages/core/src/patentReconcile.ts packages/core/src/patentWorkup.ts packages/core/src/patentWorkup.test.ts packages/core/src/index.ts
git commit -m "feat(core): add CDR-H3 competitor matching and cdr-level graph edges"
```

---

### Task 3: Wire into `runPatentWorkup` + eval level derivation

**Files:**
- Modify: `apps/cli/src/patentWorkup.ts`
- Test: `apps/cli/src/patentWorkup.test.ts`
- Modify: `eval/src/patentPipeline.ts`
- Test: `eval/src/patentPipeline.test.ts`

**Interfaces:**
- Consumes: `matchCdrCompetitors`, `CdrBlast` from `@sonny/core`; `blastVerifyTool` from `@sonny/mcp-gateway`.
- Produces: `WorkupDeps` gains optional `cdrBlast?: CdrBlast`; the eval `gotCompetitorOverlaps` derives level from edge provenance.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/src/patentWorkup.test.ts`:

```ts
import type { CdrBlast } from '@sonny/core';

describe('runPatentWorkup CDR competitor matching', () => {
  it('attaches a cdr-level competitor and emits its graph edge', async () => {
    const cdrBlast: CdrBlast = async () => [
      { id: 'x', kind: 'patent', source: 'b', title: 't', snippet: '', url: '', retrievedAt: '', raw: { accession: 'PAT_CDR', percentIdentity: 100, queryCoverage: 100, identity: 12, alignLen: 12, organism: '' } } as never,
    ];
    const out = await runPatentWorkup('/x.pdf', {
      ingest: async () => ({ markdown: 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\nEVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVS\n', status: 'ok' as const }),
      model: { async generateStructured(opts: { system: string }) {
        if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never;
        if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }] }] } as never;
        return { summary: 'ACME.', points: [] } as never;
      } },
      reconcileDeps: {
        blast: async () => [],
        anarci: async () => ({ overallStatus: 'confirmed', domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: { 'CDR-H3': { seq: 'ARDYYGSSYFDY', imgtStart: 105, imgtEnd: 117, residues: [] } } }], regionChecks: [], speciesSummary: [] }),
        epo: async () => ({ input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }),
      },
      verifier: { model: { async generateStructured() { return { status: 'supported', rationale: '' } as never; } }, modelId: 'x', decorrelated: false },
      cdrBlast,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.workup.constructs[0].cdrCompetitors?.[0]?.accession).toBe('PAT_CDR');
      expect(out.workup.graph.some((e) => e.provenance === 'blast-cdr-h3' && e.object === 'PAT_CDR')).toBe(true);
    }
  });
});
```

Append to `eval/src/patentPipeline.test.ts`:

```ts
import { gotCompetitorOverlaps } from './patentPipeline.js';
import type { PatentWorkup } from '@sonny/core';

describe('gotCompetitorOverlaps level', () => {
  it('derives cdr vs whole from edge provenance', () => {
    const wk = { graph: [
      { subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_W', provenance: 'blast-pataa', confidence: 'verified' },
      { subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_C', provenance: 'blast-cdr-h3', confidence: 'claimed' },
    ] } as unknown as PatentWorkup;
    const got = gotCompetitorOverlaps(wk);
    expect(got).toContainEqual({ seqId: 1, competitorAccession: 'PAT_W', level: 'whole' });
    expect(got).toContainEqual({ seqId: 1, competitorAccession: 'PAT_C', level: 'cdr' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sonny/cli test -- patentWorkup` and `pnpm --filter @sonny/eval test -- patentPipeline`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/cli/src/patentWorkup.ts`: add to imports `import { matchCdrCompetitors } from '@sonny/core';` and `import type { CdrBlast } from '@sonny/core';` and (if not present) `import { blastVerifyTool } from '@sonny/mcp-gateway';`. Add `cdrBlast?: CdrBlast;` to `WorkupDeps`. In `runPatentWorkup`, after the `verifyNarrative` line and BEFORE `workup.graph = graphRelationships(workup)`, add:

```ts
  const cdrBlast = deps.cdrBlast ?? ((seq: string, db: string, opts?: { wordSize?: number; matrix?: string; expect?: number }) => blastVerifyTool.call({ sequence: seq, database: db, ...opts }));
  await matchCdrCompetitors(workup, reconciliation, cdrBlast);
```

In `eval/src/patentPipeline.ts`, change `gotCompetitorOverlaps` to derive the level from provenance:

```ts
export function gotCompetitorOverlaps(workup: PatentWorkup): GoldenCompetitor[] {
  return workup.graph
    .filter((e) => e.predicate === 'MATCHES')
    .map((e) => ({
      seqId: Number(e.subject.replace('SEQ:', '')),
      competitorAccession: e.object,
      level: e.provenance === 'blast-cdr-h3' ? ('cdr' as const) : ('whole' as const),
    }));
}
```

- [ ] **Step 4: Run to verify pass, then the full suites**

Run: `pnpm --filter @sonny/cli test` and `pnpm --filter @sonny/eval test` (PASS), then `pnpm -r test` (PASS).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/patentWorkup.ts apps/cli/src/patentWorkup.test.ts eval/src/patentPipeline.ts eval/src/patentPipeline.test.ts
git commit -m "feat: wire CDR-H3 competitor matching into the workup and score it in the eval"
```

---

## Notes for the controller

- The CDR match runs BEFORE `graphRelationships` (which now reads `cdrCompetitors`).
- A real CDR-H3 BLAST needs the short-query regime to return anything; a manual smoke confirms a known humanized variant surfaces as a cdr-level hit while its whole-VH stays below 98%.
- Out of scope: CDR-L3 / other CDRs; numbering the competitor hit; lowering the whole-VH threshold.