# H1a - Golden Patent Eval Harness (offline tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the patent eval harness - a `GoldenPatent` ground-truth type, deterministic patent metrics, and an offline full-pipeline integration tier that scores the whole workup against ground truth (the insurance that catches a 5b-Critical-shaped bug).

**Architecture:** Everything lives in `@sonny/eval`. Task 1 adds the `GoldenPatent` type and pure metric functions. Task 2 adds a `runPatentPipeline` harness (composes the core pipeline functions with injected tool deps, no live network) plus a synthetic golden fixture and an integration test that runs the pipeline and asserts the deterministic metrics - including that a known competitor produces a `MATCHES` edge end to end.

**Tech Stack:** TypeScript ESM, Vitest. Test runner: `pnpm --filter @sonny/eval test`.

**Design reference:** [docs/specs/2026-07-02-patent-specialist-hardening-roadmap.md](../specs/2026-07-02-patent-specialist-hardening-roadmap.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension; all imports at the top.
- Metrics are pure and deterministic; the offline harness injects all tool/model deps (no live network, subprocess, or model).
- Touch only files under `eval/`.

## File Structure

- Create: `eval/src/goldenPatent.ts` + test - the `GoldenPatent` type and metric functions.
- Create: `eval/src/patentPipeline.ts` + test - the offline pipeline harness + integration scoring test.
- Create: `eval/golden/synthetic-antibody.json` - a synthetic golden fixture for the offline tier.

---

### Task 1: `GoldenPatent` type + deterministic metrics

**Files:**
- Create: `eval/src/goldenPatent.ts`
- Test: `eval/src/goldenPatent.test.ts`

**Interfaces:**
- Produces (types): `SpeciesClass`, `GoldenConstruct`, `GoldenCompetitor`, `GoldenPatent`.
- Produces (functions): `extractionRecall(foundSeqIds, declaredCount)`, `residueFidelity(extracted, known)`, `setRecall(got, expected)`, `speciesAccuracy(gotConstructs, expected)`, `pairingAccuracy(gotConstructs, expected)`, `competitorRecall(gotOverlaps, expected, level)`, `competitorPrecision(gotOverlaps, expected, level)`.

- [ ] **Step 1: Write the failing tests**

Create `eval/src/goldenPatent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  extractionRecall, residueFidelity, setRecall, speciesAccuracy, pairingAccuracy, competitorRecall, competitorPrecision,
} from './goldenPatent.js';

describe('patent metrics', () => {
  it('extractionRecall = unique in-range seqIds found / declared', () => {
    expect(extractionRecall([1, 2, 2, 5], 4)).toBe(0.5); // 1,2 in range; 5 out of range; 2 of 4
    expect(extractionRecall([], 0)).toBe(1);
  });

  it('residueFidelity = exact-match rate on known sequences (case-insensitive)', () => {
    expect(residueFidelity([{ seqId: 1, residues: 'evql' }], [{ seqId: 1, residues: 'EVQL' }])).toBe(1);
    expect(residueFidelity([{ seqId: 1, residues: 'EVQK' }], [{ seqId: 1, residues: 'EVQL' }])).toBe(0);
  });

  it('setRecall = fraction of expected present (case-insensitive)', () => {
    expect(setRecall(['acme bio'], ['ACME BIO'])).toBe(1);
    expect(setRecall([], ['ACME BIO'])).toBe(0);
  });

  it('speciesAccuracy matches constructs by vhSeqId and compares species', () => {
    const got = [{ vhSeqId: 1, species: 'human-like' as const }];
    expect(speciesAccuracy(got, [{ vhSeqId: 1, species: 'human-like' }])).toBe(1);
    expect(speciesAccuracy(got, [{ vhSeqId: 1, species: 'chimeric' }])).toBe(0);
  });

  it('pairingAccuracy checks the VL paired to each expected VH', () => {
    const got = [{ vhSeqId: 1, vlSeqId: 2, species: 'human-like' as const }];
    expect(pairingAccuracy(got, [{ vhSeqId: 1, vlSeqId: 2, species: 'human-like' }])).toBe(1);
    expect(pairingAccuracy(got, [{ vhSeqId: 1, vlSeqId: 9, species: 'human-like' }])).toBe(0);
  });

  it('competitorRecall/precision score overlaps at a given level', () => {
    const got = [{ seqId: 1, competitorAccession: 'PAT_A', level: 'whole' as const }];
    const expected = [{ seqId: 1, competitorAccession: 'PAT_A', level: 'whole' as const }, { seqId: 1, competitorAccession: 'PAT_B', level: 'cdr' as const }];
    expect(competitorRecall(got, expected, 'whole')).toBe(1);
    expect(competitorRecall(got, expected, 'cdr')).toBe(0);   // cdr-level not produced until H4
    expect(competitorPrecision(got, expected, 'whole')).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/eval test -- goldenPatent`
Expected: FAIL - `goldenPatent.js` does not exist yet.

- [ ] **Step 3: Implement the type and metrics**

Create `eval/src/goldenPatent.ts`:

```ts
export type SpeciesClass = 'human-like' | 'chimeric' | 'murine' | 'unknown';

export interface GoldenConstruct { name?: string; vhSeqId?: number; vlSeqId?: number; species: SpeciesClass }
export interface GoldenCompetitor { seqId: number; competitorAccession: string; level: 'whole' | 'cdr' }

export interface GoldenPatent {
  name: string;
  patentNumber: string;
  expectedAssignees: string[];
  expectedFamilyMembers: string[];
  expectedLegalDirection?: 'active' | 'inactive' | 'mixed';
  declaredSequenceCount: number;
  knownSequences: Array<{ seqId: number; residues: string }>;
  expectedConstructs: GoldenConstruct[];
  expectedCompetitorOverlaps: GoldenCompetitor[];
  mustNotAssert: string[];
  traps?: Array<'single-residue' | 'non-antibody' | 'image-or-st26'>;
}

export function extractionRecall(foundSeqIds: number[], declaredCount: number): number {
  if (declaredCount <= 0) return 1;
  const inRange = new Set(foundSeqIds.filter((n) => Number.isInteger(n) && n >= 1 && n <= declaredCount));
  return inRange.size / declaredCount;
}

export function residueFidelity(
  extracted: Array<{ seqId: number; residues: string }>,
  known: Array<{ seqId: number; residues: string }>,
): number {
  if (known.length === 0) return 1;
  const byId = new Map(extracted.map((s) => [s.seqId, s.residues.toUpperCase()]));
  const ok = known.filter((k) => byId.get(k.seqId) === k.residues.toUpperCase()).length;
  return ok / known.length;
}

export function setRecall(got: string[], expected: string[]): number {
  if (expected.length === 0) return 1;
  const g = new Set(got.map((x) => x.trim().toUpperCase()));
  return expected.filter((e) => g.has(e.trim().toUpperCase())).length / expected.length;
}

type GotConstruct = { vhSeqId?: number; vlSeqId?: number; species: SpeciesClass };

export function speciesAccuracy(got: GotConstruct[], expected: GoldenConstruct[]): number {
  if (expected.length === 0) return 1;
  const byVh = new Map(got.filter((c) => c.vhSeqId !== undefined).map((c) => [c.vhSeqId, c]));
  const ok = expected.filter((e) => e.vhSeqId !== undefined && byVh.get(e.vhSeqId)?.species === e.species).length;
  return ok / expected.length;
}

export function pairingAccuracy(got: GotConstruct[], expected: GoldenConstruct[]): number {
  if (expected.length === 0) return 1;
  const byVh = new Map(got.filter((c) => c.vhSeqId !== undefined).map((c) => [c.vhSeqId, c]));
  const ok = expected.filter((e) => e.vhSeqId !== undefined && byVh.get(e.vhSeqId)?.vlSeqId === e.vlSeqId).length;
  return ok / expected.length;
}

const key = (o: GoldenCompetitor) => `${o.seqId}|${o.competitorAccession}|${o.level}`;

export function competitorRecall(got: GoldenCompetitor[], expected: GoldenCompetitor[], level: 'whole' | 'cdr'): number {
  const exp = expected.filter((e) => e.level === level);
  if (exp.length === 0) return 1;
  const g = new Set(got.map(key));
  return exp.filter((e) => g.has(key(e))).length / exp.length;
}

export function competitorPrecision(got: GoldenCompetitor[], expected: GoldenCompetitor[], level: 'whole' | 'cdr'): number {
  const g = got.filter((o) => o.level === level);
  if (g.length === 0) return 1;
  const e = new Set(expected.map(key));
  return g.filter((o) => e.has(key(o))).length / g.length;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/eval test -- goldenPatent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval/src/goldenPatent.ts eval/src/goldenPatent.test.ts
git commit -m "feat(eval): add GoldenPatent type and deterministic patent metrics"
```

---

### Task 2: Offline pipeline harness + integration scoring test

**Files:**
- Create: `eval/src/patentPipeline.ts`
- Test: `eval/src/patentPipeline.test.ts`
- Create: `eval/golden/synthetic-antibody.json`

**Interfaces:**
- Consumes: `extractPatentData`, `reconcilePatent`, `groupConstructs`, `buildWorkup`, `synthesizeCompetitiveIP`, `graphRelationships`, and types `StructuredModel`, `ReconcileDeps`, `PatentWorkup` from `@sonny/core`.
- Produces: `runPatentPipeline(markdown, deps): Promise<PatentWorkup>`; `gotConstructs(workup)`; `gotCompetitorOverlaps(workup)`.

- [ ] **Step 1: Write the failing integration test**

Create `eval/src/patentPipeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPatentPipeline, gotConstructs, gotCompetitorOverlaps } from './patentPipeline.js';
import { extractionRecall, residueFidelity, setRecall, speciesAccuracy, pairingAccuracy, competitorRecall } from './goldenPatent.js';
import type { GoldenPatent } from './goldenPatent.js';
import type { StructuredModel, ReconcileDeps } from '@sonny/core';
import type { Evidence } from '@sonny/shared';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../golden/synthetic-antibody.json', import.meta.url)), 'utf8')) as GoldenPatent;

// A >=50-residue VH and a >=50-residue VL, matching the golden known sequences.
const VH = 'EVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVSAISGSGGSTYYADSVKG';
const VL = 'DIQMTQSPSSLSASVGDRVTITCRASQSISSYLNWYQQKPGKAPKLLIYAASSLQSGVPSRFSGSG';

const markdown = [
  'Patent US 10,123,456 B2', 'Claims',
  '1. An antibody comprising VH of SEQ ID NO: 1 and VL of SEQ ID NO: 2.',
  '', 'SEQ ID NO: 1', VH, '', 'SEQ ID NO: 2', VL, '',
].join('\n');

const model: StructuredModel = {
  async generateStructured(opts: { system: string }) {
    if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }] } as never;
    if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }] }] } as never;
    return { summary: 'ACME BIO INC owns a human-like antibody.', points: [] } as never;
  },
};

function ev(raw: Record<string, unknown>, kind: Evidence['kind']): Evidence {
  return { id: `BLAST:${raw.accession}`, kind, source: 'blast', title: 'hit', snippet: '', url: '', raw, retrievedAt: '' };
}

const reconcileDeps: ReconcileDeps = {
  blast: async (_seq, db) => db === 'pataa'
    ? [ev({ accession: 'PAT_COMP', percentIdentity: 100, queryCoverage: 100, identity: 66, alignLen: 66, organism: '' }, 'patent')]
    : [ev({ accession: 'NP_1', percentIdentity: 99, queryCoverage: 100, identity: 65, alignLen: 66, organism: 'Homo sapiens' }, 'dataset')],
  anarci: async (input) => ({
    overallStatus: 'confirmed',
    domains: [{ chain: input.vh ? 'H' : 'K', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: {} }],
    regionChecks: [], speciesSummary: [],
  }),
  epo: async () => ({ input: 'US10123456', normalized: 'US10123456', found: true, applicants: ['ACME BIO INC'], inventors: [], ipc: [], family: [{ country: 'EP', number: '1234567', status: 'active', events: [] }] }),
};

describe('offline patent pipeline eval', () => {
  it('scores a synthetic golden patent above threshold, including the competitor MATCHES edge (5b regression insurance)', async () => {
    const workup = await runPatentPipeline(markdown, { model, reconcileDeps });

    const foundIds = workup.constructs.flatMap((c) => c.regions.map((r) => r.seqId)).concat(workup.ungrouped.map((s) => s.seqId));
    const extracted = [...workup.constructs.flatMap((c) => c.regions.map((r) => ({ seqId: r.seqId, residues: r.residues }))),
      ...workup.ungrouped.map((s) => ({ seqId: s.seqId, residues: s.residues }))];

    expect(extractionRecall(foundIds, golden.declaredSequenceCount)).toBe(1);
    expect(residueFidelity(extracted, golden.knownSequences)).toBe(1);
    expect(setRecall(workup.patent.applicants, golden.expectedAssignees)).toBe(1);
    expect(speciesAccuracy(gotConstructs(workup), golden.expectedConstructs)).toBe(1);
    expect(pairingAccuracy(gotConstructs(workup), golden.expectedConstructs)).toBe(1);
    // The 5b insurance: a real competitor pataa hit must surface as a MATCHES overlap end to end.
    expect(competitorRecall(gotCompetitorOverlaps(workup), golden.expectedCompetitorOverlaps, 'whole')).toBe(1);
  });
});
```

- [ ] **Step 2: Create the golden fixture**

Create `eval/golden/synthetic-antibody.json`:

```json
{
  "name": "synthetic-antibody",
  "patentNumber": "US10123456",
  "expectedAssignees": ["ACME BIO INC"],
  "expectedFamilyMembers": ["EP1234567"],
  "expectedLegalDirection": "active",
  "declaredSequenceCount": 2,
  "knownSequences": [
    { "seqId": 1, "residues": "EVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVSAISGSGGSTYYADSVKG" },
    { "seqId": 2, "residues": "DIQMTQSPSSLSASVGDRVTITCRASQSISSYLNWYQQKPGKAPKLLIYAASSLQSGVPSRFSGSG" }
  ],
  "expectedConstructs": [{ "name": "Ab1", "vhSeqId": 1, "vlSeqId": 2, "species": "human-like" }],
  "expectedCompetitorOverlaps": [{ "seqId": 1, "competitorAccession": "PAT_COMP", "level": "whole" }],
  "mustNotAssert": ["identical to a prior molecule"],
  "traps": []
}
```

- [ ] **Step 3: Run to verify the test fails**

Run: `pnpm --filter @sonny/eval test -- patentPipeline`
Expected: FAIL - `patentPipeline.js` does not exist yet.

- [ ] **Step 4: Implement the harness**

Create `eval/src/patentPipeline.ts`:

```ts
import {
  extractPatentData, reconcilePatent, groupConstructs, buildWorkup, synthesizeCompetitiveIP, graphRelationships,
} from '@sonny/core';
import type { StructuredModel, ReconcileDeps, PatentWorkup } from '@sonny/core';
import type { GoldenCompetitor, SpeciesClass } from './goldenPatent.js';

// Compose the core pipeline offline (no ingest/CLI); all tool + model calls are injected.
export async function runPatentPipeline(
  markdown: string,
  deps: { model: StructuredModel; reconcileDeps?: ReconcileDeps },
): Promise<PatentWorkup> {
  const extracted = await extractPatentData(markdown, deps.model);
  const reconciliation = await reconcilePatent(extracted, deps.reconcileDeps);
  const constructs = await groupConstructs(markdown, extracted.associations, deps.model);
  const workup = buildWorkup(extracted, reconciliation, constructs);
  workup.narrative = await synthesizeCompetitiveIP(workup, deps.model);
  workup.graph = graphRelationships(workup);
  return workup;
}

export function gotConstructs(workup: PatentWorkup): Array<{ vhSeqId?: number; vlSeqId?: number; species: SpeciesClass }> {
  return workup.constructs.map((c) => ({
    vhSeqId: c.regions.find((r) => r.regionLabel === 'VH')?.seqId,
    vlSeqId: c.regions.find((r) => r.regionLabel === 'VL')?.seqId,
    species: c.species.classification,
  }));
}

// MATCHES edges are whole-sequence competitor overlaps (CDR-level arrives with H4).
export function gotCompetitorOverlaps(workup: PatentWorkup): GoldenCompetitor[] {
  return workup.graph
    .filter((e) => e.predicate === 'MATCHES')
    .map((e) => ({ seqId: Number(e.subject.replace('SEQ:', '')), competitorAccession: e.object, level: 'whole' as const }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/eval test -- patentPipeline`
Expected: PASS - the synthetic golden patent scores 1.0 on every deterministic metric, including the competitor `MATCHES` overlap.

- [ ] **Step 6: Run the full eval suite and commit**

Run: `pnpm --filter @sonny/eval test`
Expected: PASS.

```bash
git add eval/src/patentPipeline.ts eval/src/patentPipeline.test.ts eval/golden/synthetic-antibody.json
git commit -m "feat(eval): add offline patent pipeline harness and integration scoring test"
```

---

## Notes for the controller

- This is the offline tier only. H1b adds real curated patents and the live tier (real EPO/BLAST/ANARCI, cached).
- The `synthetic-antibody.json` is a scaffold fixture, not a real patent; H1b replaces/augments it with human-verified goldens.
- The integration test is the 5b-Critical insurance: if the competitor `MATCHES` wiring regresses, `competitorRecall(...'whole')` drops below 1 and the test fails.
