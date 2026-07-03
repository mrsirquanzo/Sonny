# Deterministic Correctness Closers Design (H5 + H2-completeness)

**Status:** Approved (from the hardening roadmap). Ready for implementation plan.
**Parent:** [Patent Specialist Hardening Roadmap](./2026-07-02-patent-specialist-hardening-roadmap.md).
**Date:** 2026-07-02.

## Purpose

Close four silent-error surfaces with deterministic, no-LLM, no-external-dependency checks, so a confident-looking dossier surfaces its own gaps instead of hiding them:

1. **Extraction completeness** - a referenced SEQ-ID with no extracted sequence becomes a visible finding, not a silent omission.
2. **Residue alphabet validation** - a sequence the regex mangled into non-residue garbage is flagged.
3. **Construct-pairing sanity gate** - a construct without complementary heavy/light chains is flagged, not silently grouped into a wrong antibody.
4. **Non-antibody classification** - a disclosure with no numbered variable domain degrades to "not a standard antibody construct" instead of being forced into the VH/VL mold.

## Scope note

The `exactMatch` full-length guard and ST.26 XML parsing (from roadmap H2) are deferred to a later H2-design slice: both need per-sequence *declared length* parsed from the ST.25/ST.26 listing format, which is design work. This slice does the mechanical checks that need only the data already in hand.

## 1 + 2. Extraction completeness + alphabet (extraction)

`ExtractedPatent` gains a field:

```ts
interface ExtractionCompleteness {
  foundCount: number;              // extracted sequences
  referencedMax: number;           // highest SEQ-ID referenced anywhere (listing + associations)
  missingSeqIds: number[];         // referenced (1..referencedMax) with no extracted sequence
  alphabetWarnings: Array<{ seqId: number; invalidChars: string }>;  // residues with non-residue characters
}
interface ExtractedPatent { /* existing */ ; completeness: ExtractionCompleteness }
```

Computed in `extractPatentData` (it has both the extracted sequences and the associations):
- `referencedMax` = max SEQ-ID across the extracted sequences and the association `seqId`s (0 if none).
- `missingSeqIds` = every id in `1..referencedMax` with no extracted sequence. A non-empty list means the patent references sequences the pipeline never parsed (the ST.26 / image-only silent-drop case).
- `alphabetWarnings` = for each extracted sequence, the distinct characters not in the valid protein (`ACDEFGHIKLMNPQRSTVWY`) or nucleotide (`ACGTUN`) alphabets (residues are already uppercase, non-letters stripped). A warning means the regex likely captured non-residue text.

This is additive: `reconcilePatent` and `buildWorkup` ignore the new field; downstream consumers and the eval can read it.

## 3. Construct-pairing sanity gate (buildWorkup)

`WorkedConstruct` gains `pairingWarning?: string`.

In `buildWorkup`, after resolving a construct's members, inspect the ANARCI chain types of its VH/VL domains (already on each `VerifiedSequence.domain.chain` from slice 5a: `H` | `K` | `L`):
- A well-formed construct has exactly one heavy (`H`) and one light (`K` or `L`) variable domain.
- Two heavies, two lights, or a lone chain -> set `pairingWarning` describing the anomaly (for example "two heavy chains grouped", "heavy chain with no paired light chain"). The construct is still emitted (we do not drop data), but the anomaly is visible so a mis-paired antibody is not presented as clean.
- A construct with no numbered variable domain at all gets no pairing verdict (it is handled by the non-antibody check below).

## 4. Non-antibody classification (buildWorkup)

`PatentWorkup` gains `disclosureShape: 'antibody' | 'not-standard-antibody'`.

In `buildWorkup`, after building the constructs: if no construct has any numbered variable domain (no `VerifiedSequence.domain` among any construct's members), set `disclosureShape = 'not-standard-antibody'`; otherwise `'antibody'`. This lets a CAR / antigen / fusion / bispecific disclosure be reported honestly rather than framed as VH/VL constructs. The narrative and graph still run (they degrade naturally on empty constructs).

## Error handling

All four are deterministic and total; they read already-assembled data and never throw. They add findings; they never drop data.

## Testing

- Completeness: associations reference SEQ-ID 5 but only 1-3 are extracted -> `missingSeqIds` contains 4 and 5; `referencedMax` is 5.
- Alphabet: a sequence containing `X` / `1` residues (post-normalization letters that are not valid residues, e.g. `B`, `J`, `O`, `X`, `Z`) -> `alphabetWarnings` names the offending characters; a clean sequence -> no warning.
- Pairing: a construct with VH(H) + VL(K) -> no `pairingWarning`; VH(H) + a second H-domain -> `pairingWarning` set; VH(H) alone -> `pairingWarning` (no paired light).
- Non-antibody: a workup whose constructs have no numbered domain -> `disclosureShape === 'not-standard-antibody'`; a normal antibody workup -> `'antibody'`.

## Out of scope

- `exactMatch` full-length guard and ST.26 XML parsing (later H2-design slice; need declared per-sequence length).
- Fixing mis-pairings (we flag, not repair).
- Classifying the specific non-antibody format (CAR vs fusion vs antigen).
