# Phase 3: KOL & Specialty Lab Mapping - Design

**Status:** Approved, ready for implementation plan.
**Slice:** 14 (retrieve like a scientist, part 3 / VP judgment layer - the human terrain).
**Date:** 2026-06-30.

## Goal

Complete the scientist's funnel (review -> seminal papers -> the people behind them) by extracting the human terrain: the principal investigators and specialty labs driving the target's literature.
A VP does not just know the biology - they know whose lab to call.

## Key property

KOL mapping is a **pure deterministic aggregation over the evidence store** - no model call.
It is grounded by construction (every lab maps to the evidence ids it was derived from), cheap, and decorrelation is not a concern.

## Design

### 1. `Evidence.metadata` (`@sonny/shared`)

```ts
Author           = { name: string, affiliation?: string, orcid?: string }
EvidenceMetadata = { authors?: Author[], institutions?: string[] }
```

- `Evidence` gains `metadata?: EvidenceMetadata`.
- Author order is preserved (the last author is the senior author / PI by biomedical convention).

### 2. `europePmc.ts` captures author metadata

Europe PMC `resultType=core` returns `authorList.author[]`, each with `fullName`, `authorAffiliationDetailsList.authorAffiliation[].affiliation`, and an occasional `authorId` (`{ type: 'ORCID', value }`).
The tool maps these into `metadata.authors` (name + first affiliation + ORCID when present) and `metadata.institutions` (the deduped affiliation strings).
Existing fields are unchanged.

### 3. `KOLCluster` (`@sonny/shared`)

```ts
SpecialtyLab = { investigator: string, institution?: string, paperCount: number (int >= 0), weight: number, evidenceIds: string[] }
KOLCluster   = { target: string, labs: SpecialtyLab[] }   // top 3 labs
```

- `TraceEvent` gains `{ type: 'kol_cluster', cluster: KOLCluster }`.
- `Briefing` gains `kolCluster?: KOLCluster`; `DeepResearchResult` gains `kolCluster: KOLCluster`.

### 4. `kolDetector.ts` - `mapSpecialtyLabs(store, target)`

A pure function:
1. Iterate `store.all()` for publication evidence that carries `metadata.authors`.
2. For each paper, the PI is the **last author** (`metadata.authors[last].name`).
3. Weight each paper: a paper Sonny deep-read (its `raw.pmcid` has full-text sections registered in the store) is a full-text seminal paper and weighs `3`; an abstract-only hit weighs `1` (down-weighted, not ignored).
4. Aggregate by PI: sum weights, count papers, collect the paper evidence ids (grounding), and take the PI's most common last-author affiliation as the institution.
5. Rank PIs by total weight (tie-break: paperCount, then name) and return the top 3 as `KOLCluster`.
6. Validate the result with `KOLClusterSchema.parse` before returning (structured output).

Full-text detection: the set of `raw.pmcid` values present on `PMCID:`-prefixed full-text evidence; a PMID paper is full-text if its `raw.pmcid` is in that set.

### 5. Wire-in (`runDeepResearch.ts`, `briefing.ts`, CLI)

- In `runDeepResearch`, after the specialist/developability phase, call `mapSpecialtyLabs(store, target)`, emit `kol_cluster`, and return it on `DeepResearchResult` (wrapped in try/catch so a failure degrades to an empty cluster).
- `produceBriefing` carries `result.kolCluster` onto the `Briefing`.
- The CLI renders a `KOL & INSTITUTIONAL TERRAIN` section listing the dominant labs (PI - institution - paper count), and `formatTrace` renders the `kol_cluster` event for the live stream / web UI.

## Out of scope

- Institution name normalization (affiliations are messy multi-department strings; v1 keeps the most common raw affiliation, lightly trimmed).
- Author disambiguation beyond name + ORCID (no cross-source identity resolution).
- Citation-count weighting beyond the full-text/abstract distinction (the deep-read set is already the seminality signal).

## Testing

- **Contracts:** `EvidenceMetadataSchema` and `KOLClusterSchema` validate; `Evidence.metadata` and `Briefing.kolCluster` are optional; invalid shapes reject.
- **europePmc tool:** a mock response with `authorList` (fullName, affiliation, ORCID authorId) yields `metadata.authors` and `metadata.institutions`; a hit with no authorList yields no metadata or an empty one.
- **kolDetector:** a store mocked with ~15 papers returns the top 3 PIs by weighted last-authorship; a PI whose papers were deep-read (full-text) outranks an abstract-only PI with the same paper count; each lab's `evidenceIds` are the papers it was derived from (grounding); abstract-only papers still contribute (down-weighted) but never outrank full-text seminal work.
- **Wire-in:** the CLI renders the KOL section; the `kol_cluster` trace event is emitted; existing briefing/runDeepResearch tests stay green.
- Full repo suite green.

## Success criteria

A local CDCP1 smoke shows a `KOL & INSTITUTIONAL TERRAIN` section naming the dominant CDCP1 labs (the recurring senior authors on the deep-read seminal papers), each grounded in the evidence ids it came from, and a `kol_cluster` trace event in the stream.
