# Patent Reconciliation Engine Design (Patent Specialist - Slice 5a)

**Status:** Approved, ready for implementation plan.
**Parent:** [Competitive IP & Patent Specialist - Overview Design](./2026-06-29-competitive-ip-patent-specialist-design.md).
**Slice:** 5a of 6 (5a reconciliation; 5b synthesis + output follows).
**Date:** 2026-07-01.

## Purpose

Take an `ExtractedPatent` (slice 4) and run the three verification tools over it to produce a `PatentReconciliation`: per-sequence verification facts plus the authoritative EPO record.

This is pure orchestration over the existing tools. No LLM, no grouping, no species classification, no narrative - those are slice 5b. The reconciliation engine surfaces facts and deltas; it never decides.

## The trust rule: 98% retrieves, 100% trusts

BLAST retrieves hits at >= 98% identity: this catches OCR transcription errors from the PDF seed AND fast-follower competitor patents that made a single point mutation to circumvent claims.
But the engine flags anything that is not a 100% exact match and surfaces the delta.
A 99% match is ambiguous - a harmless OCR slip (I for L) or a deliberate patent-busting mutation - and only the human or the slice-5b synthesis prompt adjudicates it.
So every BLAST hit carries `exactMatch` (100% identity and 100% query coverage) and `mismatchCount`; the engine NEVER collapses a 99% match to "verified."

## BLAST scope: substantial sequences only

BLAST runs only on sequences of length >= 50 residues (VH, VL, scFv, full chains, Fc/Fab, constant fragments).
A local alignment of a 7-residue CDR is statistically meaningless (astronomical E-values, thousands of random short-motif hits, zero IP signal).
Short CDRs are instead verified by ANARCI IMGT region-matching against their anchored VH/VL domain (slice 2 logic, applied in slice 5b); that IS their verification.
The 50-residue cutoff safely excludes the longest CDR-H3 loops while capturing full variable domains (~110-120 residues).

## Dual database

Each substantial sequence is BLASTed against both:
- **`nr`** (non-redundant): the biological sanity check - confirms the sequence is a real molecule, identifies species origin, flags a naturally occurring sequence. The top hit is reported regardless of identity (a low-identity top hit signals novelty).
- **`pataa`** (patent proteins): the competitive-intelligence sweep - "who else filed on this construct." Hits are filtered to >= 98% identity (the competitor-disclosure threshold).

## Prerequisite: expose exact delta from `blast_verify`

`blast_verify` (slice 1) already computes the identity and aligned-length counts to derive `percentIdentity`, but does not expose them.
Slice 5a first adds `identity` and `alignLen` to the tool's `raw` output (a factual, non-breaking addition), so the reconciliation engine can report an exact `mismatchCount = alignLen - identity` ("1 mismatch over 118 aligned residues") instead of a vague percentage.

## Component

`reconcilePatent(extracted, deps) => Promise<PatentReconciliation>` in `packages/core/src/patentReconcile.ts`.
No LLM. Injectable tool functions so unit tests mock them with no live network or subprocess.

```ts
interface ReconcileDeps {
  blast?: (sequence: string, database: string) => Promise<Evidence[]>;   // default: blastVerifyTool.call
  anarci?: (input: ConfirmInput) => Promise<RegionConfirmation>;         // default: confirmRegions
  epo?: (input: string) => Promise<PatentRecord>;                        // default: lookupPatent
}
```

## Flow

1. **EPO identity/ownership.** If `extracted.patentNumber` is present, `epo(patentNumber)`; else an empty `PatentRecord` with `found: false` and an explanatory `error`.
2. **Region labels per seqId.** Build a `Map<seqId, RegionLabel[]>` from `extracted.associations`.
3. **Per sequence (concurrent):**
   - `length = residues.length`; `blasted = length >= 50`.
   - If `blasted`: `blast(residues, 'nr')` and `blast(residues, 'pataa')` concurrently. `nrTopHit` = the top nr hit (any identity). `patentHits` = pataa hits filtered to `percentIdentity >= 98`, mapped to `BlastHit`.
   - If the sequence's labels include `VH` or `VL`: `anarci({ vh|vl: residues, claimedRegions: [] })`; if a domain was numbered, attach `{ chain, species, numberedRegions }`.
   - Sequences under 50 residues are carried through with `blasted: false` and no BLAST or domain (their CDR verification happens in 5b).
4. Return `{ patent, sequences }`.

## Output

```ts
interface BlastHit {
  database: 'nr' | 'pataa' | string;
  accession: string;
  title: string;
  percentIdentity: number;
  queryCoverage: number;
  mismatchCount: number;    // alignLen - identity (exact, within the aligned region)
  exactMatch: boolean;      // percentIdentity === 100 && queryCoverage === 100
  organism: string;
}

interface VerifiedSequence {
  seqId: number;
  residues: string;
  regionLabels: RegionLabel[];
  length: number;
  blasted: boolean;
  nrTopHit?: BlastHit;      // biological identity (top nr hit, any identity)
  patentHits: BlastHit[];   // pataa competitor disclosures (>= 98% identity)
  domain?: { chain: 'H' | 'K' | 'L'; species: string; numberedRegions: Partial<Record<RegionLabel, NumberedRegion>> };
}

interface PatentReconciliation {
  patent: PatentRecord;         // EPO record (found: false soft on failure or no number)
  sequences: VerifiedSequence[];
}
```

`BlastHit`, `VerifiedSequence`, `PatentReconciliation` live in `packages/core/src/patentReconcile.ts`, reusing `PatentRecord`, `RegionLabel`, `NumberedRegion`, `ConfirmInput`, `RegionConfirmation` from `@sonny/mcp-gateway` and `Evidence` from `@sonny/shared`.

## Error handling

The three tools already soft-degrade (BLAST returns `[]`, ANARCI returns `anarci_unavailable`, EPO returns `found: false`).
`reconcilePatent` therefore assembles whatever facts are available and never throws: a failed EPO lookup yields `patent.found === false`; a BLAST that returns `[]` yields no `nrTopHit`/`patentHits`; an ANARCI that could not number yields no `domain`.

## Testing

All tests inject `deps` (mock blast/anarci/epo); no live network or subprocess.

- A >= 50-residue VH: BLASTed against nr and pataa; `nrTopHit` set; `patentHits` filtered to >= 98%; `domain` attached from the mock ANARCI (chain, species); `mismatchCount` and `exactMatch` computed from the mock hit's identity/alignLen.
- A pataa hit at 97% is excluded from `patentHits`; a 100%/100% hit has `exactMatch === true` and `mismatchCount === 0`; a 99% hit has `exactMatch === false` and `mismatchCount > 0` (delta surfaced, not collapsed).
- A < 50-residue CDR: `blasted === false`, no `nrTopHit`/`patentHits`, no `domain`.
- Region labels are aggregated per seqId from associations.
- No `patentNumber`: `patent.found === false` with an error; EPO is not called.
- A soft tool failure (BLAST `[]`, EPO `found:false`, ANARCI no domain) is assembled without throwing.

## Setup

Manual smoke (not a unit test), after the tool prerequisites are met (`SONNY_EPO_KEY`/`SECRET`, `conda install -c bioconda anarci hmmer`): run `reconcilePatent` on a real `ExtractedPatent` and confirm the BLAST/ANARCI/EPO facts assemble, and that near-matches surface a non-zero `mismatchCount`.
Note for the smoke: BLAST is slow (minutes per query, async); many substantial sequences means many concurrent NCBI submissions - tune concurrency/throttling against NCBI etiquette if needed.

## Out of scope (slice 5b)

- Grouping sequences into antibody constructs.
- Confirming the patent's claimed CDRs against the derived VH/VL regions (pairing).
- human / humanized / chimeric classification.
- The competitive-IP narrative and the provenance-tagged graph-ready relationships.
- The `patent-workup` CLI command.
