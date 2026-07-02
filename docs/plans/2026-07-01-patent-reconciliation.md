# Patent Reconciliation Engine Implementation Plan (Patent Specialist - Slice 5a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `reconcilePatent`, which runs BLAST + ANARCI + EPO over an `ExtractedPatent` to produce a `PatentReconciliation` of per-sequence verification facts (with exact deltas) plus the authoritative EPO record.

**Architecture:** A tiny extension to `blast_verify` (expose `identity`/`alignLen` in `raw`) so exact `mismatchCount` is derivable, then `reconcilePatent` in `packages/core` - pure orchestration over the three existing tools, no LLM, injectable tool deps. It never throws (the tools already soft-degrade) and never collapses a non-100% match to "verified."

**Tech Stack:** TypeScript ESM, Vitest. Test runner: `pnpm --filter @sonny/<pkg> test`.

**Spec:** [docs/specs/2026-07-01-patent-reconciliation-design.md](../specs/2026-07-01-patent-reconciliation-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension; all imports at the top.
- `reconcilePatent` is a plain exported function, NOT a `Tool`; no LLM.
- BLAST only sequences of length >= 50 (`MIN_BLAST_LEN`); `pataa` hits filtered to `percentIdentity >= 98` (`COMPETITOR_MIN_IDENTITY`); the `nr` top hit is reported at any identity.
- Every `BlastHit` carries `exactMatch` (100% identity AND 100% coverage) and `mismatchCount`; never collapse a non-exact match to "verified."
- Grouping, CDR-confirmation pairing, species classification, narrative, and the CLI are out of scope (slice 5b).
- Touch only the files named in each task.

## File Structure

- Modify: `packages/mcp-gateway/src/blastVerify.ts` + test - add `identity`/`alignLen` to `raw`.
- Create: `packages/core/src/patentReconcile.ts` + test - `reconcilePatent`.
- Modify: `packages/core/src/index.ts` - export `reconcilePatent` and its types.

---

### Task 1: Expose `identity` and `alignLen` in `blast_verify` raw

**Files:**
- Modify: `packages/mcp-gateway/src/blastVerify.ts`
- Test: `packages/mcp-gateway/src/blastVerify.test.ts`

**Interfaces:**
- Produces: `blast_verify` Evidence `raw` now additionally contains `identity: number` and `alignLen: number` (the aligned-identity count and aligned length already computed to derive `percentIdentity`).

- [ ] **Step 1: Extend the happy-path test**

In `packages/mcp-gateway/src/blastVerify.test.ts`, the existing test "submits via POST, polls until READY, and maps an XML hit to dataset Evidence" reads `raw`. Extend its `raw` type and add two assertions (the `RESULT_XML` fixture has `Hsp_identity` 120 and `Hsp_align-len` 120):

```ts
    const raw = e.raw as { percentIdentity: number; eValue: string; organism: string; queryCoverage: number; database: string; program: string; identity: number; alignLen: number };
    expect(raw.percentIdentity).toBe(100);
    expect(raw.queryCoverage).toBe(100);
    expect(raw.eValue).toBe('1e-80');
    expect(raw.organism).toBe('Homo sapiens');
    expect(raw.program).toBe('blastp');
    expect(raw.identity).toBe(120);
    expect(raw.alignLen).toBe(120);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test -- blastVerify`
Expected: FAIL - `raw.identity` / `raw.alignLen` are `undefined`.

- [ ] **Step 3: Add the two fields to `raw`**

In `packages/mcp-gateway/src/blastVerify.ts`, the map already computes `const alignLen` and `const identity`. Change the returned `raw` object to include them:

```ts
        raw: { accession, percentIdentity, eValue, bitScore, queryCoverage, organism, database, program, identity, alignLen },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- blastVerify`
Expected: PASS.

- [ ] **Step 5: Run the full gateway suite**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-gateway/src/blastVerify.ts packages/mcp-gateway/src/blastVerify.test.ts
git commit -m "feat(mcp-gateway): expose identity and alignLen in blast_verify raw for exact mismatch counts"
```

---

### Task 2: `reconcilePatent`

**Files:**
- Create: `packages/core/src/patentReconcile.ts`
- Test: `packages/core/src/patentReconcile.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `blastVerifyTool`, `confirmRegions`, `lookupPatent`, and the types `PatentRecord`, `RegionLabel`, `NumberedRegion`, `ConfirmInput`, `RegionConfirmation` from `@sonny/mcp-gateway`; `Evidence` from `@sonny/shared`; `ExtractedPatent` from `./patentData.js`.
- Produces: `interface BlastHit`, `interface VerifiedSequence`, `interface PatentReconciliation`, `interface ReconcileDeps`; `reconcilePatent(extracted: ExtractedPatent, deps?: ReconcileDeps): Promise<PatentReconciliation>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/patentReconcile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconcilePatent } from './patentReconcile.js';
import type { ReconcileDeps } from './patentReconcile.js';
import type { ExtractedPatent } from './patentData.js';
import type { Evidence } from '@sonny/shared';
import type { PatentRecord, ConfirmInput, RegionConfirmation } from '@sonny/mcp-gateway';

const VH = 'EVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVSAISGSGGSTYYADSVKGRFTISRDNS'; // 74 aa, >= 50

function ev(raw: Record<string, unknown>, kind: Evidence['kind'] = 'dataset'): Evidence {
  return { id: `BLAST:${raw.accession}`, kind, source: 'NCBI BLAST', title: `hit ${raw.accession}`, snippet: '', url: 'u', raw, retrievedAt: 'now' };
}

const patentRecord: PatentRecord = {
  input: 'US10123456', normalized: 'US10123456', found: true,
  applicants: ['ACME BIO INC'], inventors: [], ipc: [], family: [],
};

function deps(spy?: { epoCalls: string[] }): ReconcileDeps {
  return {
    blast: async (_seq, db) => {
      if (db === 'nr') return [ev({ accession: 'NP_1', percentIdentity: 99, queryCoverage: 100, identity: 73, alignLen: 74, organism: 'Homo sapiens' })];
      return [
        ev({ accession: 'PAT_A', percentIdentity: 100, queryCoverage: 100, identity: 74, alignLen: 74, organism: '' }, 'patent'),
        ev({ accession: 'PAT_B', percentIdentity: 97, queryCoverage: 100, identity: 72, alignLen: 74, organism: '' }, 'patent'),
      ];
    },
    anarci: async (input: ConfirmInput): Promise<RegionConfirmation> => ({
      overallStatus: 'confirmed',
      domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: 'IGHV3-23', j: 'IGHJ4' }, numberedRegions: {} }],
      regionChecks: [], speciesSummary: [{ chain: 'H', species: 'homo_sapiens' }],
    }),
    epo: async (input: string) => { spy?.epoCalls.push(input); return patentRecord; },
  };
}

const extracted = (over: Partial<ExtractedPatent> = {}): ExtractedPatent => ({
  patentNumber: 'US10123456',
  sequences: [{ seqId: 1, residues: VH }],
  associations: [{ regionLabel: 'VH', seqId: 1 }],
  ...over,
});

describe('reconcilePatent', () => {
  it('BLASTs a >=50-residue VH against nr+pataa, filters pataa to >=98%, and attaches the ANARCI domain', async () => {
    const rec = await reconcilePatent(extracted(), deps());
    expect(rec.patent.found).toBe(true);
    const s = rec.sequences[0];
    expect(s.blasted).toBe(true);
    expect(s.regionLabels).toEqual(['VH']);
    expect(s.nrTopHit?.percentIdentity).toBe(99);
    expect(s.nrTopHit?.mismatchCount).toBe(1);        // 74 - 73
    expect(s.nrTopHit?.exactMatch).toBe(false);       // 99% -> delta surfaced, not collapsed
    expect(s.patentHits.map((h) => h.accession)).toEqual(['PAT_A']); // PAT_B (97%) filtered out
    expect(s.patentHits[0].exactMatch).toBe(true);
    expect(s.patentHits[0].mismatchCount).toBe(0);
    expect(s.domain).toEqual({ chain: 'H', species: 'homo_sapiens', numberedRegions: {} });
  });

  it('does not BLAST or number a sub-50-residue CDR', async () => {
    const rec = await reconcilePatent(
      extracted({ sequences: [{ seqId: 2, residues: 'GFTFSSYA' }], associations: [{ regionLabel: 'CDR-H1', seqId: 2 }] }),
      deps(),
    );
    const s = rec.sequences[0];
    expect(s.blasted).toBe(false);
    expect(s.nrTopHit).toBeUndefined();
    expect(s.patentHits).toEqual([]);
    expect(s.domain).toBeUndefined();
  });

  it('aggregates region labels per seqId', async () => {
    const rec = await reconcilePatent(
      extracted({ associations: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'heavy-chain', seqId: 1 }] }),
      deps(),
    );
    expect(rec.sequences[0].regionLabels).toEqual(['VH', 'heavy-chain']);
  });

  it('does not call EPO and reports found:false when there is no patent number', async () => {
    const spy = { epoCalls: [] as string[] };
    const rec = await reconcilePatent(extracted({ patentNumber: null }), deps(spy));
    expect(spy.epoCalls).toEqual([]);
    expect(rec.patent.found).toBe(false);
    expect(rec.patent.error).toMatch(/EPO_NO_NUMBER/);
  });

  it('assembles soft tool failures without throwing', async () => {
    const rec = await reconcilePatent(extracted(), {
      blast: async () => [],
      anarci: async () => ({ overallStatus: 'anarci_unavailable', domains: [], regionChecks: [], speciesSummary: [] }),
      epo: async () => ({ input: 'US10123456', found: false, applicants: [], inventors: [], ipc: [], family: [], error: 'EPO_NETWORK_ERROR: down' }),
    });
    const s = rec.sequences[0];
    expect(rec.patent.found).toBe(false);
    expect(s.nrTopHit).toBeUndefined();
    expect(s.patentHits).toEqual([]);
    expect(s.domain).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- patentReconcile`
Expected: FAIL - `patentReconcile.js` does not exist yet.

- [ ] **Step 3: Implement `reconcilePatent`**

Create `packages/core/src/patentReconcile.ts`:

```ts
import type { Evidence } from '@sonny/shared';
import { blastVerifyTool, confirmRegions, lookupPatent } from '@sonny/mcp-gateway';
import type { PatentRecord, RegionLabel, NumberedRegion, ConfirmInput, RegionConfirmation } from '@sonny/mcp-gateway';
import type { ExtractedPatent } from './patentData.js';

const MIN_BLAST_LEN = 50;
const COMPETITOR_MIN_IDENTITY = 98;

export interface BlastHit {
  database: string;
  accession: string;
  title: string;
  percentIdentity: number;
  queryCoverage: number;
  mismatchCount: number;
  exactMatch: boolean;
  organism: string;
}

export interface VerifiedSequence {
  seqId: number;
  residues: string;
  regionLabels: RegionLabel[];
  length: number;
  blasted: boolean;
  nrTopHit?: BlastHit;
  patentHits: BlastHit[];
  domain?: { chain: 'H' | 'K' | 'L'; species: string; numberedRegions: Partial<Record<RegionLabel, NumberedRegion>> };
}

export interface PatentReconciliation {
  patent: PatentRecord;
  sequences: VerifiedSequence[];
}

export interface ReconcileDeps {
  blast?: (sequence: string, database: string) => Promise<Evidence[]>;
  anarci?: (input: ConfirmInput) => Promise<RegionConfirmation>;
  epo?: (input: string) => Promise<PatentRecord>;
}

function toBlastHit(e: Evidence | undefined, database: string): BlastHit | undefined {
  if (!e) return undefined;
  const raw = e.raw as {
    accession?: string; percentIdentity?: number; queryCoverage?: number; organism?: string; identity?: number; alignLen?: number;
  };
  const percentIdentity = Number(raw.percentIdentity ?? 0);
  const queryCoverage = Number(raw.queryCoverage ?? 0);
  const alignLen = Number(raw.alignLen ?? 0);
  const identity = Number(raw.identity ?? 0);
  return {
    database,
    accession: String(raw.accession ?? ''),
    title: e.title,
    percentIdentity,
    queryCoverage,
    mismatchCount: Math.max(0, alignLen - identity),
    exactMatch: percentIdentity === 100 && queryCoverage === 100,
    organism: String(raw.organism ?? ''),
  };
}

function emptyPatent(input: string, error: string): PatentRecord {
  return { input, found: false, applicants: [], inventors: [], ipc: [], family: [], error };
}

export async function reconcilePatent(
  extracted: ExtractedPatent,
  deps: ReconcileDeps = {},
): Promise<PatentReconciliation> {
  const blast = deps.blast ?? ((sequence: string, database: string) => blastVerifyTool.call({ sequence, database }));
  const anarci = deps.anarci ?? ((input: ConfirmInput) => confirmRegions(input));
  const epo = deps.epo ?? ((input: string) => lookupPatent(input));

  const patent = extracted.patentNumber
    ? await epo(extracted.patentNumber)
    : emptyPatent('', 'EPO_NO_NUMBER: no patent number was extracted');

  const labelsBySeq = new Map<number, RegionLabel[]>();
  for (const a of extracted.associations) {
    const arr = labelsBySeq.get(a.seqId) ?? [];
    if (!arr.includes(a.regionLabel)) arr.push(a.regionLabel);
    labelsBySeq.set(a.seqId, arr);
  }

  const sequences = await Promise.all(
    extracted.sequences.map(async (s): Promise<VerifiedSequence> => {
      const regionLabels = labelsBySeq.get(s.seqId) ?? [];
      const length = s.residues.length;
      const blasted = length >= MIN_BLAST_LEN;

      let nrTopHit: BlastHit | undefined;
      let patentHits: BlastHit[] = [];
      if (blasted) {
        const [nrHits, patHits] = await Promise.all([blast(s.residues, 'nr'), blast(s.residues, 'pataa')]);
        nrTopHit = toBlastHit(nrHits[0], 'nr');
        patentHits = patHits
          .map((h) => toBlastHit(h, 'pataa'))
          .filter((h): h is BlastHit => h !== undefined && h.percentIdentity >= COMPETITOR_MIN_IDENTITY);
      }

      let domain: VerifiedSequence['domain'];
      const isHeavy = regionLabels.includes('VH');
      const isLight = regionLabels.includes('VL');
      if (isHeavy || isLight) {
        const conf = await anarci(isHeavy ? { vh: s.residues, claimedRegions: [] } : { vl: s.residues, claimedRegions: [] });
        const d = conf.domains[0];
        if (d) domain = { chain: d.chain, species: d.species, numberedRegions: d.numberedRegions };
      }

      return { seqId: s.seqId, residues: s.residues, regionLabels, length, blasted, nrTopHit, patentHits, domain };
    }),
  );

  return { patent, sequences };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- patentReconcile`
Expected: PASS - all five tests pass.

- [ ] **Step 5: Export from the core index**

In `packages/core/src/index.ts`, add below the existing exports:

```ts
export { reconcilePatent, type PatentReconciliation, type VerifiedSequence, type BlastHit, type ReconcileDeps } from './patentReconcile.js';
```

- [ ] **Step 6: Run the full core suite**

Run: `pnpm --filter @sonny/core test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/patentReconcile.ts packages/core/src/patentReconcile.test.ts packages/core/src/index.ts
git commit -m "feat(core): add reconcilePatent engine over BLAST, ANARCI, and EPO"
```

---

## Notes for the controller

- Manual smoke (not a unit test), after tool prerequisites: run `reconcilePatent` on a real `ExtractedPatent`; confirm the facts assemble and near-matches surface a non-zero `mismatchCount`. BLAST is slow and this fans out concurrent NCBI submissions - tune concurrency against NCBI etiquette if it trips rate limits.
- Out of scope (slice 5b): grouping, CDR-confirmation pairing, human/humanized/chimeric classification, narrative, graph-ready relationships, `patent-workup` CLI.
