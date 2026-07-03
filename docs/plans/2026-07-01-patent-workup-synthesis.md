# Patent Workup Synthesis and Output Implementation Plan (Patent Specialist - Slice 5b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn reconciliation facts into the final `PatentWorkup` - grouped antibody constructs (LLM), confirmed regions + species (deterministic), a grounded competitive-IP narrative (LLM), provenance-tagged graph relationships, and a standalone `patent-workup <file>` CLI command.

**Architecture:** All synthesis lives in `packages/core/src/patentWorkup.ts` (grouping, assembly, narrative, graph), consuming slice-4 extraction and slice-5a reconciliation. The CLI command lives in `apps/cli`. LLM steps are best-effort and never throw; assembly and graph are deterministic and total.

**Tech Stack:** TypeScript ESM, Vitest, Zod, `StructuredModel`. Test runner: `pnpm --filter @sonny/<pkg> test`.

**Spec:** [docs/specs/2026-07-01-patent-workup-synthesis-design.md](../specs/2026-07-01-patent-workup-synthesis-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension; all imports at the top.
- LLM steps (`groupConstructs`, `synthesizeCompetitiveIP`) NEVER throw; they return empty results on failure. The grouping LLM may only PAIR existing SEQ-IDs (filter out unknown ones); it never invents sequences.
- Species classification returns `human-like` / `chimeric` / `murine` / `unknown` (human vs humanized is not split).
- The graph is emitted, not persisted; no `CLAIMED_TO_BIND -> Target` edge (no reliable target extraction).
- Touch only the files named in each task.

## File Structure

- Modify: `packages/core/src/patentData.ts` - export `REGION_LABELS` and `boundForClaims` for reuse.
- Create: `packages/core/src/patentWorkup.ts` + test - all 5b types, `groupConstructs`, `buildWorkup`, `synthesizeCompetitiveIP`, `graphRelationships`.
- Modify: `packages/core/src/index.ts` - export the workup API.
- Create: `apps/cli/src/patentWorkup.ts` + test - `runPatentWorkup`.
- Modify: `apps/cli/src/run.ts` - route `patent-workup <file>`.

---

### Task 1: Types + `groupConstructs` (LLM grouping)

**Files:**
- Modify: `packages/core/src/patentData.ts` (add two `export` keywords)
- Create: `packages/core/src/patentWorkup.ts`
- Test: `packages/core/src/patentWorkup.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `StructuredModel`, `MODEL_ROUTER` from `./model.js`; `REGION_LABELS`, `boundForClaims`, `RegionAssociation`, `ExtractedPatent` from `./patentData.js`; `RegionLabel`, `PatentRecord` from `@sonny/mcp-gateway`; `BlastHit`, `VerifiedSequence`, `PatentReconciliation` from `./patentReconcile.js`.
- Produces (types): `ConstructMember`, `AntibodyConstruct`, `CdrConfirmation`, `WorkedRegion`, `SpeciesClass`, `SpeciesCall`, `WorkedConstruct`, `IpPoint`, `CompetitiveIP`, `EdgePredicate`, `Relationship`, `PatentWorkup`.
- Produces (function): `groupConstructs(markdown: string, associations: RegionAssociation[], model: StructuredModel): Promise<AntibodyConstruct[]>`.

- [ ] **Step 1: Export the two helpers from patentData**

In `packages/core/src/patentData.ts`, add `export` to the two existing declarations:

```ts
export const REGION_LABELS = [
```
```ts
export function boundForClaims(markdown: string): string {
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/patentWorkup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { groupConstructs } from './patentWorkup.js';
import type { StructuredModel } from './model.js';
import type { RegionAssociation } from './patentData.js';

function model(constructs: unknown): StructuredModel {
  return { async generateStructured() { return { constructs } as never; } };
}

const associations: RegionAssociation[] = [
  { regionLabel: 'VH', seqId: 1 },
  { regionLabel: 'VL', seqId: 2 },
  { regionLabel: 'CDR-H1', seqId: 3 },
];

describe('groupConstructs', () => {
  it('groups members and drops members with unknown SEQ-IDs (grounding)', async () => {
    const out = await groupConstructs('Claims\n...', associations, model([
      { name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }, { regionLabel: 'CDR-H1', seqId: 99 }] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Ab1');
    expect(out[0].members.map((m) => m.seqId)).toEqual([1, 2]); // seqId 99 not in associations -> dropped
  });

  it('drops a construct left with no known members', async () => {
    const out = await groupConstructs('c', associations, model([{ name: 'Ghost', members: [{ regionLabel: 'VH', seqId: 42 }] }]));
    expect(out).toEqual([]);
  });

  it('returns [] when the model throws', async () => {
    const throwing: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    expect(await groupConstructs('c', associations, throwing)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: FAIL - `patentWorkup.js` does not exist yet.

- [ ] **Step 4: Implement types + `groupConstructs`**

Create `packages/core/src/patentWorkup.ts`:

```ts
import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { REGION_LABELS, boundForClaims } from './patentData.js';
import type { RegionAssociation, ExtractedPatent } from './patentData.js';
import type { RegionLabel, PatentRecord } from '@sonny/mcp-gateway';
import type { BlastHit, VerifiedSequence, PatentReconciliation } from './patentReconcile.js';

export interface ConstructMember { regionLabel: RegionLabel; seqId: number }
export interface AntibodyConstruct { name: string; members: ConstructMember[] }

export type CdrConfirmation = 'confirmed' | 'mismatch' | 'no_anchor';
export interface WorkedRegion {
  regionLabel: RegionLabel;
  seqId: number;
  residues: string;
  cdrConfirmation?: CdrConfirmation;
  blast?: BlastHit;
}

export type SpeciesClass = 'human-like' | 'chimeric' | 'murine' | 'unknown';
export interface SpeciesCall {
  classification: SpeciesClass;
  variableSpecies?: string;
  constantSpecies?: string;
  evidence: string;
}

export interface WorkedConstruct { name: string; regions: WorkedRegion[]; species: SpeciesCall }

export interface IpPoint { point: string; citations: string[] }
export interface CompetitiveIP { summary: string; points: IpPoint[] }

export type EdgePredicate = 'OWNED_BY' | 'DISCLOSES' | 'HAS_REGION' | 'MATCHES';
export interface Relationship {
  subject: string;
  predicate: EdgePredicate;
  object: string;
  provenance: string;
  confidence: 'verified' | 'claimed' | 'inferred';
}

export interface PatentWorkup {
  patentNumber: string | null;
  patent: PatentRecord;
  constructs: WorkedConstruct[];
  ungrouped: VerifiedSequence[];
  narrative: CompetitiveIP;
  graph: Relationship[];
}

const ConstructsSchema = z.object({
  constructs: z.array(z.object({
    name: z.string(),
    members: z.array(z.object({ regionLabel: z.enum(REGION_LABELS), seqId: z.number().int().positive() })),
  })),
});

const GROUP_SYSTEM =
  'You group a patent\'s disclosed antibody regions into distinct antibody constructs. Read the claims and the region-to-SEQ-ID associations. For each antibody the patent defines, output its name (or a label like "Antibody 1") and the members (regionLabel + seqId) that belong to it. Only use SEQ-IDs present in the associations. Never invent sequences or SEQ-IDs.';

export async function groupConstructs(
  markdown: string,
  associations: RegionAssociation[],
  model: StructuredModel,
): Promise<AntibodyConstruct[]> {
  const knownIds = new Set(associations.map((a) => a.seqId));
  try {
    const out = await model.generateStructured({
      system: GROUP_SYSTEM,
      prompt: `ASSOCIATIONS:\n${associations.map((a) => `${a.regionLabel} = SEQ ID NO: ${a.seqId}`).join('\n')}\n\nCLAIMS:\n${boundForClaims(markdown)}`,
      schema: ConstructsSchema,
      model: MODEL_ROUTER.specialist,
    });
    return out.constructs
      .map((c) => ({ name: c.name, members: c.members.filter((m) => knownIds.has(m.seqId)) }))
      .filter((c) => c.members.length > 0);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: PASS.

- [ ] **Step 6: Export from the core index**

In `packages/core/src/index.ts`, add:

```ts
export {
  groupConstructs,
  type AntibodyConstruct, type ConstructMember, type WorkedConstruct, type WorkedRegion,
  type SpeciesCall, type SpeciesClass, type CdrConfirmation, type CompetitiveIP, type IpPoint,
  type Relationship, type EdgePredicate, type PatentWorkup,
} from './patentWorkup.js';
```

- [ ] **Step 7: Run the full core suite and commit**

Run: `pnpm --filter @sonny/core test`
Expected: PASS.

```bash
git add packages/core/src/patentData.ts packages/core/src/patentWorkup.ts packages/core/src/patentWorkup.test.ts packages/core/src/index.ts
git commit -m "feat(core): add patent workup types and grounded LLM construct grouping"
```

---

### Task 2: `buildWorkup` (deterministic assembly, CDR confirmation, species)

**Files:**
- Modify: `packages/core/src/patentWorkup.ts` (append)
- Test: `packages/core/src/patentWorkup.test.ts` (append)
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task-1 types; `NumberedRegion` from `@sonny/mcp-gateway`.
- Produces: `buildWorkup(extracted: ExtractedPatent, reconciliation: PatentReconciliation, constructs: AntibodyConstruct[]): PatentWorkup` (with `narrative` and `graph` as empty placeholders, filled by later steps).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/patentWorkup.test.ts`:

```ts
import { buildWorkup } from './patentWorkup.js';
import type { PatentReconciliation, VerifiedSequence } from './patentReconcile.js';
import type { ExtractedPatent } from './patentData.js';

function vseq(over: Partial<VerifiedSequence> & { seqId: number; residues: string }): VerifiedSequence {
  return { regionLabels: [], length: over.residues.length, blasted: false, patentHits: [], ...over };
}

const extractedP: ExtractedPatent = { patentNumber: 'US10123456', sequences: [], associations: [] };

function recon(sequences: VerifiedSequence[]): PatentReconciliation {
  return { patent: { input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }, sequences };
}

describe('buildWorkup', () => {
  it('confirms a CDR that matches the VH derived region and flags a mismatch', () => {
    const vh = vseq({
      seqId: 1, residues: 'EVQLVES', regionLabels: ['VH'],
      domain: { chain: 'H', species: 'homo_sapiens', numberedRegions: { 'CDR-H1': { seq: 'GFS', imgtStart: 27, imgtEnd: 38, residues: [] } } },
    });
    const cdrOk = vseq({ seqId: 3, residues: 'GFS', regionLabels: ['CDR-H1'] });
    const cdrBad = vseq({ seqId: 4, residues: 'GFT', regionLabels: ['CDR-H1'] });
    const wk = buildWorkup(extractedP, recon([vh, cdrOk, cdrBad]), [
      { name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'CDR-H1', seqId: 3 }] },
      { name: 'Ab2', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'CDR-H1', seqId: 4 }] },
    ]);
    expect(wk.constructs[0].regions.find((r) => r.seqId === 3)?.cdrConfirmation).toBe('confirmed');
    expect(wk.constructs[1].regions.find((r) => r.seqId === 4)?.cdrConfirmation).toBe('mismatch');
  });

  it('reports no_anchor for a CDR whose construct has no VH domain', () => {
    const cdr = vseq({ seqId: 5, residues: 'GFS', regionLabels: ['CDR-H1'] });
    const wk = buildWorkup(extractedP, recon([cdr]), [{ name: 'Ab', members: [{ regionLabel: 'CDR-H1', seqId: 5 }] }]);
    expect(wk.constructs[0].regions[0].cdrConfirmation).toBe('no_anchor');
  });

  it('classifies species: human variable + human constant -> human-like; murine variable + human constant -> chimeric', () => {
    const humanVh = vseq({ seqId: 1, residues: 'E'.repeat(60), regionLabels: ['VH'], domain: { chain: 'H', species: 'homo_sapiens', numberedRegions: {} } });
    const humanFc = vseq({ seqId: 2, residues: 'F'.repeat(60), regionLabels: ['Fc'], nrTopHit: { database: 'nr', accession: 'x', title: 't', percentIdentity: 100, queryCoverage: 100, mismatchCount: 0, exactMatch: true, organism: 'Homo sapiens' } });
    const wkHuman = buildWorkup(extractedP, recon([humanVh, humanFc]), [{ name: 'H', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'Fc', seqId: 2 }] }]);
    expect(wkHuman.constructs[0].species.classification).toBe('human-like');

    const mouseVh = vseq({ seqId: 3, residues: 'E'.repeat(60), regionLabels: ['VH'], domain: { chain: 'H', species: 'mus_musculus', numberedRegions: {} } });
    const wkChimeric = buildWorkup(extractedP, recon([mouseVh, humanFc]), [{ name: 'C', members: [{ regionLabel: 'VH', seqId: 3 }, { regionLabel: 'Fc', seqId: 2 }] }]);
    expect(wkChimeric.constructs[0].species.classification).toBe('chimeric');
  });

  it('puts sequences assigned to no construct into ungrouped', () => {
    const a = vseq({ seqId: 1, residues: 'AAAA', regionLabels: ['VH'] });
    const orphan = vseq({ seqId: 9, residues: 'BBBB' });
    const wk = buildWorkup(extractedP, recon([a, orphan]), [{ name: 'Ab', members: [{ regionLabel: 'VH', seqId: 1 }] }]);
    expect(wk.ungrouped.map((s) => s.seqId)).toEqual([9]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: FAIL - `buildWorkup` is not exported yet.

- [ ] **Step 3: Implement `buildWorkup`**

Append to `packages/core/src/patentWorkup.ts`:

```ts
function normalizeResidues(s: string): string {
  return s.replace(/[^A-Za-z]/g, '').toUpperCase();
}

function isCdr(label: RegionLabel): boolean {
  return /^CDR-[HL][1-3]$/.test(label);
}

const CONSTANT_LABELS: RegionLabel[] = ['Fc', 'CH1', 'CL', 'hinge', 'heavy-chain', 'light-chain', 'Fab'];

function classifySpecies(variableSpecies?: string, constantSpecies?: string): SpeciesClass {
  const human = (s?: string) => !!s && /homo|human/i.test(s);
  const nonHuman = (s?: string) => !!s && /mus|mouse|rat|rabbit|rhesus|macaca/i.test(s);
  if (human(variableSpecies) && (human(constantSpecies) || !constantSpecies)) return 'human-like';
  if (nonHuman(variableSpecies) && human(constantSpecies)) return 'chimeric';
  if (nonHuman(variableSpecies) && (nonHuman(constantSpecies) || !constantSpecies)) return 'murine';
  return 'unknown';
}

export function buildWorkup(
  extracted: ExtractedPatent,
  reconciliation: PatentReconciliation,
  constructs: AntibodyConstruct[],
): PatentWorkup {
  const bySeq = new Map<number, VerifiedSequence>(reconciliation.sequences.map((s) => [s.seqId, s]));
  const assigned = new Set<number>();

  const workedConstructs: WorkedConstruct[] = constructs.map((c) => {
    const vhSeq = c.members.filter((m) => m.regionLabel === 'VH').map((m) => bySeq.get(m.seqId)).find(Boolean);
    const vlSeq = c.members.filter((m) => m.regionLabel === 'VL').map((m) => bySeq.get(m.seqId)).find(Boolean);
    const derived = vhSeq?.domain?.numberedRegions;

    const regions: WorkedRegion[] = c.members.map((m) => {
      assigned.add(m.seqId);
      const vs = bySeq.get(m.seqId);
      const residues = vs?.residues ?? '';
      const region: WorkedRegion = { regionLabel: m.regionLabel, seqId: m.seqId, residues, blast: vs?.nrTopHit };
      if (isCdr(m.regionLabel)) {
        const d = derived?.[m.regionLabel];
        region.cdrConfirmation = !d ? 'no_anchor' : normalizeResidues(residues) === normalizeResidues(d.seq) ? 'confirmed' : 'mismatch';
      }
      return region;
    });

    const variableSpecies = (vhSeq ?? vlSeq)?.domain?.species;
    const constantMember = c.members.find((m) => CONSTANT_LABELS.includes(m.regionLabel));
    const constantSpecies = constantMember ? bySeq.get(constantMember.seqId)?.nrTopHit?.organism || undefined : undefined;
    const classification = classifySpecies(variableSpecies, constantSpecies);
    const species: SpeciesCall = {
      classification,
      variableSpecies,
      constantSpecies,
      evidence: `variable domain species ${variableSpecies ?? 'unknown'}; constant region species ${constantSpecies ?? 'unknown'}`,
    };

    return { name: c.name, regions, species };
  });

  const ungrouped = reconciliation.sequences.filter((s) => !assigned.has(s.seqId));

  return {
    patentNumber: extracted.patentNumber,
    patent: reconciliation.patent,
    constructs: workedConstructs,
    ungrouped,
    narrative: { summary: '', points: [] },
    graph: [],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: PASS.

- [ ] **Step 5: Export and commit**

In `packages/core/src/index.ts`, add `buildWorkup` to the `patentWorkup.js` export list.

Run: `pnpm --filter @sonny/core test`
Expected: PASS.

```bash
git add packages/core/src/patentWorkup.ts packages/core/src/patentWorkup.test.ts packages/core/src/index.ts
git commit -m "feat(core): add buildWorkup assembly with CDR confirmation and species classification"
```

---

### Task 3: `synthesizeCompetitiveIP` (grounded narrative)

**Files:**
- Modify: `packages/core/src/patentWorkup.ts` (append)
- Test: `packages/core/src/patentWorkup.test.ts` (append)
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `synthesizeCompetitiveIP(workup: PatentWorkup, model: StructuredModel): Promise<CompetitiveIP>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/patentWorkup.test.ts`:

```ts
import { synthesizeCompetitiveIP } from './patentWorkup.js';

const baseWorkup: PatentWorkup = {
  patentNumber: 'US10123456',
  patent: { input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] },
  constructs: [{ name: 'Ab1', regions: [{ regionLabel: 'VH', seqId: 1, residues: 'E' }], species: { classification: 'human-like', evidence: '' } }],
  ungrouped: [],
  narrative: { summary: '', points: [] },
  graph: [],
};

describe('synthesizeCompetitiveIP', () => {
  it('keeps only citations that reference known SEQ-IDs or accessions', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return { summary: 'ACME owns one human-like antibody.', points: [
          { point: 'VH is disclosed', citations: ['SEQ:1', 'SEQ:999'] },
        ] } as never;
      },
    };
    const ip = await synthesizeCompetitiveIP(baseWorkup, model);
    expect(ip.summary).toContain('ACME');
    expect(ip.points[0].citations).toEqual(['SEQ:1']); // SEQ:999 unknown -> dropped
  });

  it('returns an empty narrative when the model throws', async () => {
    const throwing: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    const ip = await synthesizeCompetitiveIP(baseWorkup, throwing);
    expect(ip.points).toEqual([]);
    expect(ip.summary).toMatch(/unavailable/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: FAIL.

- [ ] **Step 3: Implement `synthesizeCompetitiveIP`**

Append to `packages/core/src/patentWorkup.ts`:

```ts
const IpSchema = z.object({
  summary: z.string(),
  points: z.array(z.object({ point: z.string(), citations: z.array(z.string()) })),
});

const IP_SYSTEM =
  'You are a competitive-IP analyst writing a grounded summary of an antibody patent. Base every statement ONLY on the provided facts. Cover ownership and legal status, what the disclosed molecules are, their humanness, and any competitor patents that disclose the same or near-identical sequences. Explicitly flag any near-match (a mismatch count greater than zero) as a potential deliberate mutation or transcription error - never assert it is identical. Every point must cite the SEQ-ID (as "SEQ:<n>") or competitor accession it rests on, copied verbatim.';

export async function synthesizeCompetitiveIP(workup: PatentWorkup, model: StructuredModel): Promise<CompetitiveIP> {
  const knownCitations = new Set<string>();
  for (const c of workup.constructs) {
    for (const r of c.regions) {
      knownCitations.add(`SEQ:${r.seqId}`);
      for (const h of [r.blast].filter(Boolean) as BlastHit[]) knownCitations.add(h.accession);
    }
  }
  for (const s of workup.ungrouped) knownCitations.add(`SEQ:${s.seqId}`);

  const facts = [
    `Patent: ${workup.patentNumber ?? 'unknown'} (found: ${workup.patent.found}); applicants: ${workup.patent.applicants.join(', ') || 'unknown'}.`,
    ...workup.constructs.map((c) =>
      `Construct ${c.name} [${c.species.classification}]: ` +
      c.regions.map((r) => `${r.regionLabel}=SEQ:${r.seqId}${r.cdrConfirmation ? `(${r.cdrConfirmation})` : ''}${r.blast ? `, top hit ${r.blast.accession} ${r.blast.percentIdentity}% mismatches=${r.blast.mismatchCount}` : ''}`).join('; ')),
  ].join('\n');

  try {
    const draft = await model.generateStructured({ system: IP_SYSTEM, prompt: `FACTS:\n${facts}\n\nWrite the summary and cited points.`, schema: IpSchema, model: MODEL_ROUTER.writer });
    return {
      summary: draft.summary,
      points: draft.points.map((p) => ({ point: p.point, citations: p.citations.filter((c) => knownCitations.has(c)) })),
    };
  } catch {
    return { summary: 'Competitive-IP narrative unavailable (synthesis failed).', points: [] };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: PASS.

- [ ] **Step 5: Export and commit**

In `packages/core/src/index.ts`, add `synthesizeCompetitiveIP` to the `patentWorkup.js` export list.

Run: `pnpm --filter @sonny/core test`
Expected: PASS.

```bash
git add packages/core/src/patentWorkup.ts packages/core/src/patentWorkup.test.ts packages/core/src/index.ts
git commit -m "feat(core): add grounded competitive-IP narrative synthesis"
```

---

### Task 4: `graphRelationships` + `patent-workup` CLI

**Files:**
- Modify: `packages/core/src/patentWorkup.ts` (append `graphRelationships`)
- Test: `packages/core/src/patentWorkup.test.ts` (append)
- Modify: `packages/core/src/index.ts`
- Create: `apps/cli/src/patentWorkup.ts`
- Test: `apps/cli/src/patentWorkup.test.ts`
- Modify: `apps/cli/src/run.ts`

**Interfaces:**
- Produces: `graphRelationships(workup: PatentWorkup): Relationship[]`; `runPatentWorkup(filePath, deps?): Promise<{ ok: true; workup: PatentWorkup } | { ok: false; error: string }>`.

- [ ] **Step 1: Write the failing tests (core)**

Append to `packages/core/src/patentWorkup.test.ts`:

```ts
import { graphRelationships } from './patentWorkup.js';

describe('graphRelationships', () => {
  it('emits OWNED_BY, DISCLOSES, HAS_REGION, and MATCHES edges with provenance and confidence', () => {
    const wk: PatentWorkup = {
      patentNumber: 'US10123456',
      patent: { input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] },
      constructs: [{
        name: 'Ab1',
        regions: [{
          regionLabel: 'VH', seqId: 1, residues: 'E',
          blast: { database: 'pataa', accession: 'PAT_A', title: 't', percentIdentity: 100, queryCoverage: 100, mismatchCount: 0, exactMatch: true, organism: '' },
        }],
        species: { classification: 'human-like', evidence: '' },
      }],
      ungrouped: [],
      narrative: { summary: '', points: [] },
      graph: [],
    };
    const g = graphRelationships(wk);
    expect(g).toContainEqual({ subject: 'US10123456', predicate: 'OWNED_BY', object: 'ACME', provenance: 'epo-assignee', confidence: 'verified' });
    expect(g).toContainEqual({ subject: 'US10123456', predicate: 'DISCLOSES', object: 'SEQ:1', provenance: 'patent-listing', confidence: 'claimed' });
    expect(g).toContainEqual({ subject: 'Ab1', predicate: 'HAS_REGION', object: 'SEQ:1', provenance: 'claims-grouping', confidence: 'claimed' });
    expect(g).toContainEqual({ subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_A', provenance: 'blast-pataa', confidence: 'verified' });
  });
});
```

- [ ] **Step 2: Run to verify fail, then implement `graphRelationships`**

Run: `pnpm --filter @sonny/core test -- patentWorkup` (Expected: FAIL)

Append to `packages/core/src/patentWorkup.ts`:

```ts
export function graphRelationships(workup: PatentWorkup): Relationship[] {
  const edges: Relationship[] = [];
  const subject = workup.patentNumber ?? workup.patent.input ?? 'unknown-patent';

  if (workup.patent.found) {
    for (const company of workup.patent.applicants) {
      edges.push({ subject, predicate: 'OWNED_BY', object: company, provenance: 'epo-assignee', confidence: 'verified' });
    }
  }

  const seen = new Set<number>();
  const addDisclose = (seqId: number) => {
    if (seen.has(seqId)) return;
    seen.add(seqId);
    edges.push({ subject, predicate: 'DISCLOSES', object: `SEQ:${seqId}`, provenance: 'patent-listing', confidence: 'claimed' });
  };

  for (const c of workup.constructs) {
    for (const r of c.regions) {
      addDisclose(r.seqId);
      edges.push({ subject: c.name, predicate: 'HAS_REGION', object: `SEQ:${r.seqId}`, provenance: 'claims-grouping', confidence: 'claimed' });
      if (r.blast && r.blast.database === 'pataa') {
        edges.push({ subject: `SEQ:${r.seqId}`, predicate: 'MATCHES', object: r.blast.accession, provenance: 'blast-pataa', confidence: r.blast.exactMatch ? 'verified' : 'claimed' });
      }
    }
  }
  for (const s of workup.ungrouped) addDisclose(s.seqId);

  return edges;
}
```

Run: `pnpm --filter @sonny/core test -- patentWorkup` (Expected: PASS)

Add `graphRelationships` to the `patentWorkup.js` export in `packages/core/src/index.ts`, then:

```bash
git add packages/core/src/patentWorkup.ts packages/core/src/patentWorkup.test.ts packages/core/src/index.ts
git commit -m "feat(core): add provenance-tagged graph-ready relationships"
```

- [ ] **Step 3: Write the failing CLI test**

Create `apps/cli/src/patentWorkup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runPatentWorkup } from './patentWorkup.js';
import type { StructuredModel } from '@sonny/core';

// The pipeline calls the model three times, each with a distinct system prompt:
// extractAssociations ("...extract..."), groupConstructs ("...group..."), synthesizeCompetitiveIP (neither).
const model: StructuredModel = {
  async generateStructured(opts: { system: string }) {
    if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never;
    if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }] }] } as never;
    return { summary: 'ACME antibody.', points: [] } as never;
  },
};

describe('runPatentWorkup', () => {
  it('runs the full pipeline and returns a PatentWorkup', async () => {
    const out = await runPatentWorkup('/x.pdf', {
      ingest: async () => ({ markdown: 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\nEVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVS\n', status: 'ok' as const }),
      model,
      reconcileDeps: {
        blast: async () => [],
        anarci: async () => ({ overallStatus: 'confirmed', domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: {} }], regionChecks: [], speciesSummary: [] }),
        epo: async () => ({ input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }),
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.workup.patent.applicants).toEqual(['ACME']);
      expect(out.workup.constructs[0]?.name).toBe('Ab1');
      expect(out.workup.graph.some((e) => e.predicate === 'OWNED_BY')).toBe(true);
    }
  });

  it('returns ok:false when markitdown is unavailable', async () => {
    const out = await runPatentWorkup('/x.pdf', { ingest: async () => ({ markdown: '', status: 'markitdown_unavailable' as const, error: 'not installed' }) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('not installed');
  });
});
```

- [ ] **Step 4: Run to verify fail, then implement `runPatentWorkup`**

Run: `pnpm --filter @sonny/cli test -- patentWorkup` (Expected: FAIL)

Create `apps/cli/src/patentWorkup.ts`:

```ts
import { ingestToMarkdown } from '@sonny/mcp-gateway';
import type { IngestResult } from '@sonny/mcp-gateway';
import {
  extractPatentData, reconcilePatent, groupConstructs, buildWorkup, synthesizeCompetitiveIP, graphRelationships, makeModel,
} from '@sonny/core';
import type { StructuredModel, ReconcileDeps, PatentWorkup } from '@sonny/core';

export interface WorkupDeps {
  ingest?: (filePath: string) => Promise<IngestResult>;
  model?: StructuredModel;
  reconcileDeps?: ReconcileDeps;
}

export async function runPatentWorkup(
  filePath: string,
  deps: WorkupDeps = {},
): Promise<{ ok: true; workup: PatentWorkup } | { ok: false; error: string }> {
  const ingest = deps.ingest ?? ingestToMarkdown;
  const res = await ingest(filePath);
  if (res.status !== 'ok') return { ok: false, error: res.error ?? 'markitdown unavailable' };

  const model = deps.model ?? makeModel();
  const extracted = await extractPatentData(res.markdown, model);
  const reconciliation = await reconcilePatent(extracted, deps.reconcileDeps);
  const constructs = await groupConstructs(res.markdown, extracted.associations, model);
  const workup = buildWorkup(extracted, reconciliation, constructs);
  workup.narrative = await synthesizeCompetitiveIP(workup, model);
  workup.graph = graphRelationships(workup);
  return { ok: true, workup };
}
```

Run: `pnpm --filter @sonny/cli test -- patentWorkup` (Expected: PASS)

- [ ] **Step 5: Wire the command into `run.ts`**

In `apps/cli/src/run.ts`, add the import at the top with the others:

```ts
import { runPatentWorkup } from './patentWorkup.js';
```

Then add this branch immediately after the existing `extract-patent` branch inside `main()`:

```ts
  if (argv[2] === 'patent-workup') {
    const file = argv[3];
    if (!file) { console.error('usage: patent-workup <file>'); process.exit(1); return; }
    const out = await runPatentWorkup(file);
    if (!out.ok) { console.error(out.error); process.exit(1); return; }
    console.log(JSON.stringify(out.workup, null, 2));
    return;
  }
```

- [ ] **Step 6: Run the full CLI suite and commit**

Run: `pnpm --filter @sonny/cli test`
Expected: PASS.

```bash
git add apps/cli/src/patentWorkup.ts apps/cli/src/patentWorkup.test.ts apps/cli/src/run.ts
git commit -m "feat(cli): add patent-workup command running the full verification pipeline"
```

---

## Notes for the controller

- Manual smoke (not a unit test): `patent-workup <real-antibody-patent.pdf>` end to end (needs EPO creds + ANARCI install). Confirm constructs group sensibly, CDR confirmations and species calls are reasonable, the narrative is grounded, and graph edges carry provenance.
- The `main()` wiring in `run.ts` is a thin, non-unit-tested shell (side effects); `runPatentWorkup` carries the tested logic.
- Out of scope: graph persistence, `CLAIMED_TO_BIND` edges, human-vs-humanized split, the alignment viewer (slice 6), the web upload surface.
