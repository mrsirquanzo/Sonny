# CDR-Level Competitor Matching Design (H4)

**Status:** Approved (design call confirmed). Ready for implementation plan.
**Parent:** [Patent Specialist Hardening Roadmap](./2026-07-02-patent-specialist-hardening-roadmap.md).
**Date:** 2026-07-02.

## Purpose

The competitor sweep only flags a rival patent when its sequence is >= 98% identical over the whole VH. That misses the highest-value freedom-to-operate threat: a competitor who took the same antibody and humanized or affinity-matured it - same CDRs (especially CDR-H3, the binding-determining loop), rewritten framework - landing around 85-90% whole-VH, below the filter. This slice adds a CDR-H3 match: BLAST each construct's CDR-H3 against the patent database, because a CDR-H3 hit inside a different framework is the strongest possible fast-follower signal.

Confirmed reasoning: loosening the whole-VH threshold to ~85% is a trap - it floods results with unrelated antibodies sharing the same human framework germline (e.g. VH3-23). CDR-H3 is the diverse, specificity-driving region, so matching there is high-signal and low-noise.

## 1. `blast_verify` short-query parameters (mcp-gateway)

CDR-H3 is typically 10-20 residues; standard BLAST discards hits that short. `blast_verify` gains optional args passed through to the NCBI Put request:

- `wordSize?: number` -> `WORD_SIZE` (use 2 for short queries).
- `matrix?: string` -> `MATRIX` (use `PAM30` for short queries).
- (`expect` already exists -> `EXPECT`; use a high value like `200000` for short queries, since short sequences occur by chance more often.)

When a param is provided it is added to the Put body; when omitted the request is unchanged (backward compatible). A caller BLASTing a CDR-H3 sets `{ wordSize: 2, matrix: 'PAM30', expect: 200000 }` (the blastp-short regime).

## 2. `matchCdrCompetitors` (core)

```ts
matchCdrCompetitors(
  workup: PatentWorkup,
  reconciliation: PatentReconciliation,
  blast: (sequence: string, database: string, opts?: { wordSize?: number; matrix?: string; expect?: number }) => Promise<Evidence[]>,
): Promise<void>   // mutates workup: attaches per-construct CDR competitor hits and cdr-level graph edges
```

For each construct:
- Find the construct's VH member; resolve its `VerifiedSequence` from `reconciliation`; read the ANARCI-derived CDR-H3 from `domain.numberedRegions['CDR-H3'].seq` (derived in slice 5a; present when the VH was numbered).
- If a CDR-H3 exists, BLAST it against `pataa` with the short-query params, filter hits to a CDR-H3 identity threshold (`CDRH3_MIN_IDENTITY = 90` - CDR-H3 is short and diverse, so require high identity), map to `BlastHit[]` (reusing the slice-5a `toBlastHit` shape via the same `raw` fields).
- Attach the result to the construct as `cdrCompetitors: BlastHit[]`.
- Skip constructs with no VH domain / no derived CDR-H3 (no data, no call).

`WorkedConstruct` gains `cdrCompetitors?: BlastHit[]`.

## 3. Graph + level distinction

`graphRelationships` emits a `MATCHES` edge for each CDR competitor with provenance `blast-cdr-h3` (vs `blast-pataa` for whole-sequence), so the two levels are distinguishable downstream. Confidence: `claimed` (a CDR match is a lineage signal, not proof the whole molecule is identical). Object = the competitor accession; subject = the construct name (the CDR match is a construct-level property, not a single SEQ-ID).

## 4. Eval level derivation (closes the H1a-deferred minor)

`gotCompetitorOverlaps` in `eval/src/patentPipeline.ts` derives `level` from the edge provenance: `blast-cdr-h3` -> `'cdr'`, else `'whole'` (no longer hardcoded `'whole'`). This lets `competitorRecall(...'cdr')` score CDR-level overlaps in the golden set.

## Wiring (`runPatentWorkup`)

After `buildWorkup` (and before or after narrative/graph), call `matchCdrCompetitors(workup, reconciliation, blastDep)`; then `graphRelationships` (which now also emits the cdr-level edges). The blast dep is injectable (reuse the reconcile blast dep). Because `graphRelationships` reads `cdrCompetitors`, run the CDR match BEFORE `graphRelationships`.

## Error handling

`matchCdrCompetitors` never throws: a BLAST failure for a construct's CDR-H3 leaves `cdrCompetitors` empty for that construct; the workup still ships.

## Testing

- `blast_verify`: with `{ wordSize: 2, matrix: 'PAM30' }`, the Put body contains `WORD_SIZE=2` and `MATRIX=PAM30`; without them the body omits both (backward compatible).
- `matchCdrCompetitors`: a construct whose VH domain has a derived CDR-H3 -> the injected blast is called with `database: 'pataa'` and the short-query opts; a returned pataa hit at >= 90% is attached to `cdrCompetitors`; an 85% hit is dropped (below the CDR threshold); a construct with no VH domain -> no blast call, empty `cdrCompetitors`; a throwing blast -> empty, no throw.
- `graphRelationships`: a construct with `cdrCompetitors` -> a `MATCHES` edge with provenance `blast-cdr-h3`.
- Eval: `gotCompetitorOverlaps` maps a `blast-cdr-h3` edge to level `'cdr'` and a `blast-pataa` edge to `'whole'`.

## Out of scope

- CDR-L3 / other-CDR matching (CDR-H3 is the crux; extendable later).
- Numbering the competitor hit to confirm it is antibody-derived (the accession + high CDR-H3 identity is the signal; deeper confirmation is future work).
- Lowering the whole-VH threshold (deliberately not done - it is the noise trap).
