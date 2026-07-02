# Patent Workup Synthesis and Output Design (Patent Specialist - Slice 5b)

**Status:** Approved, ready for implementation plan.
**Parent:** [Competitive IP & Patent Specialist - Overview Design](./2026-06-29-competitive-ip-patent-specialist-design.md).
**Slice:** 5b of 6 (final orchestration slice; 5a reconciliation is done).
**Date:** 2026-07-01.

## Purpose

Turn the reconciliation facts into the deliverable: antibody constructs grouped from the patent's claims, each with confirmed regions and a species classification, a grounded competitive-IP narrative, provenance-tagged graph-ready relationships, and a standalone `patent-workup <file>` CLI command.

This completes the specialist. It consumes the extraction (slice 4) and reconciliation (slice 5a) and produces the `PatentWorkup`.

## Pipeline

```
file -> ingestToMarkdown -> extractPatentData -> reconcilePatent
        -> groupConstructs (LLM)  -> buildWorkup (deterministic) -> synthesizeCompetitiveIP (LLM) -> graphRelationships (deterministic)
        -> PatentWorkup
```

## Components (core)

### `groupConstructs(markdown, associations, model) => Promise<AntibodyConstruct[]>`

One grounded `StructuredModel` pass. Reads the claims window of the markdown (reuse the slice-4 `boundForClaims` bounding) plus the region -> SEQ-ID associations, and emits antibody constructs.

- Zod schema: `{ constructs: [{ name: string, members: [{ regionLabel: enum(RegionLabel), seqId: number }] }] }`.
- **Grounding:** after the model returns, filter each construct's `members` to SEQ-IDs that actually exist in the extracted sequences; drop members referencing unknown SEQ-IDs, and drop constructs left with no members. The LLM can only PAIR real SEQ-IDs, never invent sequences.
- Never throws; a model or validation error yields `[]`.

### `buildWorkup(extracted, reconciliation, constructs) => PatentWorkup` (partial: no narrative/graph yet)

Deterministic assembly. No LLM, no new tool calls - it reads only slice-5a facts.

For each construct:
- **Regions:** resolve each member to its `VerifiedSequence` (residues, blast). Build `WorkedRegion[]`.
- **CDR confirmation:** for each CDR member, find the construct's VH `VerifiedSequence` and its slice-5a `domain.numberedRegions` (ANARCI-derived regions). Compare the CDR member's residues (normalized) against the derived region's `seq`: `confirmed` (equal), `mismatch` (differ), or `no_anchor` (no VH domain available). Reuses the derived regions from 5a; no ANARCI re-run.
- **Species classification** (`SpeciesCall`):
  - `variableSpecies` = the VH (or VL) member's `domain.species` (ANARCI germline).
  - `constantSpecies` = the organism of the construct's constant-region member's `nrTopHit` (Fc / CH1 / CL / heavy-chain / light-chain, which were BLASTed in 5a).
  - `classification`: `human-like` when the variable domain is human (and constant human or absent); `chimeric` when the variable domain is non-human and the constant is human; `murine` when both are non-human (or variable non-human, constant absent); `unknown` otherwise. "Human" is detected by `/homo|human/i` on the species string, non-human by a known non-human marker (`/mus|mouse|rat|rabbit|rhesus|macaca/i`).
  - Human vs humanized is NOT split (that needs CDR-origin analysis beyond ANARCI's germline call); `human-like` is the honest structured label and the narrative may note "human or humanized."

Sequences not assigned to any construct go into `ungrouped: VerifiedSequence[]`.

### `synthesizeCompetitiveIP(workup, model) => Promise<CompetitiveIP>`

Grounded narrative, following the `synthesizeRecommendation` pattern (StructuredModel, judgment grounded ONLY in the provided facts, every point citing the SEQ-ID or accession it rests on; citations filtered to known ids).

Covers: ownership (EPO assignee) and legal status, what the disclosed molecules are, humanness, notable competitor overlaps (from `pataa` hits), and it explicitly surfaces any non-exact-match deltas (a `mismatchCount > 0` hit is called out, never asserted as identical). Never throws; on failure returns an empty `CompetitiveIP` with a note.

### `graphRelationships(workup) => Relationship[]`

Deterministic, provenance-tagged, emitted (not persisted - no graph store is built; see the parent enhancement decision). Edge types, each grounded:
- `[Patent] OWNED_BY [Company]` - provenance `epo-assignee`, confidence `verified` when `patent.found`.
- `[Patent] DISCLOSES [Sequence]` - provenance `patent-listing`, confidence `claimed`.
- `[Construct] HAS_REGION [Sequence]` - provenance `claims-grouping`, confidence `claimed`.
- `[Sequence] MATCHES [competitor patent]` - provenance `blast-pataa`, confidence `verified` (exact) or `claimed` (near-match, with the delta noted).

`[Sequence] CLAIMED_TO_BIND [Target]` is deliberately omitted: the antigen/target is not reliably extracted anywhere in the pipeline, so no binding edge is asserted. It slots in later when target extraction exists.

### `runPatentWorkup(filePath, deps) => Promise<{ ok: true; workup: PatentWorkup } | { ok: false; error: string }>` (apps/cli)

Wires the full pipeline: `ingestToMarkdown` -> (soft fail -> `{ ok: false }`) -> `extractPatentData` -> `reconcilePatent` -> `groupConstructs` -> `buildWorkup` -> `synthesizeCompetitiveIP` -> `graphRelationships`. Injectable deps (ingest, model, and the reconcile deps) for tests. The `patent-workup <file>` command prints the `PatentWorkup` as JSON; a bad file / markitdown-unavailable exits non-zero.

## Types

```ts
interface ConstructMember { regionLabel: RegionLabel; seqId: number }
interface AntibodyConstruct { name: string; members: ConstructMember[] }

type CdrConfirmation = 'confirmed' | 'mismatch' | 'no_anchor';
interface WorkedRegion {
  regionLabel: RegionLabel;
  seqId: number;
  residues: string;
  cdrConfirmation?: CdrConfirmation;   // present only for CDR labels
  blast?: BlastHit;                     // top hit summary if the sequence was BLASTed
}

type SpeciesClass = 'human-like' | 'chimeric' | 'murine' | 'unknown';
interface SpeciesCall {
  classification: SpeciesClass;
  variableSpecies?: string;
  constantSpecies?: string;
  evidence: string;
}

interface WorkedConstruct { name: string; regions: WorkedRegion[]; species: SpeciesCall }

interface IpPoint { point: string; citations: string[] }
interface CompetitiveIP { summary: string; points: IpPoint[] }

type EdgePredicate = 'OWNED_BY' | 'DISCLOSES' | 'HAS_REGION' | 'MATCHES';
interface Relationship {
  subject: string;
  predicate: EdgePredicate;
  object: string;
  provenance: string;
  confidence: 'verified' | 'claimed' | 'inferred';
}

interface PatentWorkup {
  patentNumber: string | null;
  patent: PatentRecord;
  constructs: WorkedConstruct[];
  ungrouped: VerifiedSequence[];
  narrative: CompetitiveIP;
  graph: Relationship[];
}
```

Types live in `packages/core/src/patentWorkup.ts`, reusing `RegionLabel`, `PatentRecord` from `@sonny/mcp-gateway`, `BlastHit`, `VerifiedSequence`, `PatentReconciliation` from `./patentReconcile.js`, and `ExtractedPatent` from `./patentData.js`.

## Error handling

Every LLM step (`groupConstructs`, `synthesizeCompetitiveIP`) is best-effort and never throws (empty result on failure). `buildWorkup` and `graphRelationships` are deterministic and total (they read already-assembled facts). `runPatentWorkup` surfaces only a hard ingest failure to the CLI user; everything else degrades to a partial workup.

## Testing

Unit tests inject a mock `StructuredModel` and mock reconcile deps; no live network/subprocess/model.

- `groupConstructs`: a mock model returns constructs; a member with an unknown SEQ-ID is dropped (grounding); a construct left empty is dropped; a throwing model yields `[]`.
- `buildWorkup`: CDR member matching the VH's derived region -> `confirmed`; differing -> `mismatch`; no VH domain -> `no_anchor`; species classification for human/human -> `human-like`, murine-variable/human-constant -> `chimeric`, murine/murine -> `murine`; unassigned sequences land in `ungrouped`.
- `synthesizeCompetitiveIP`: a mock model's points keep only citations that reference known SEQ-IDs/accessions; a throwing model yields an empty narrative.
- `graphRelationships`: emits OWNED_BY (when `patent.found`), DISCLOSES per sequence, HAS_REGION per construct member, MATCHES per pataa hit; each carries provenance and confidence; a near-match MATCHES edge is `claimed`, an exact one `verified`.
- `runPatentWorkup`: an injected ingest+model path assembles a `PatentWorkup`; a `markitdown_unavailable` ingest yields `{ ok: false }`.

## Setup

Manual smoke (not a unit test): `patent-workup <real-antibody-patent.pdf>` end to end (needs the tool prerequisites - EPO creds, ANARCI install). Confirm constructs group sensibly, CDR confirmations and species calls are reasonable, the narrative is grounded, and the graph edges carry provenance.

## Out of scope

- Persisting the graph (no graph store; relationships are emitted for a future GraphRAG core).
- `CLAIMED_TO_BIND -> Target` edges (no reliable target extraction yet).
- Human vs humanized discrimination (needs CDR-origin analysis).
- The alignment viewer (slice 6).
- The web upload surface.
