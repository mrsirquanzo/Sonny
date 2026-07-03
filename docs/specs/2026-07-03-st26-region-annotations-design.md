# ST.26 Region-Annotation Associations Design

**Status:** Approved to build (user confirmed). Follow-up to H2.
**Parent:** [H2 Correctness Closers](./2026-07-03-h2-correctness-closers-design.md).
**Date:** 2026-07-03.

## Purpose

H2 added ST.26 XML sequence extraction, so modern patents now yield their sequences. But region-to-SEQ-ID associations still come only from `extractAssociations` (an LLM over the patent text). A pure ST.26 patent has no prose ("SEQ ID NO: 5 is the heavy chain") for the LLM to read - the ingested content is raw XML - so its associations come back empty or unreliable, and `groupConstructs` cannot assemble antibody constructs. The result: ST.26 patents get sequences but a degraded (construct-less) workup.

The ST.26 XML already carries authoritative region annotations as `INSDFeature` elements (a `REGION`/`V_region`/`mat_peptide` feature with a location and a `note` qualifier like `CDR-H3` or `heavy chain variable region`). This slice derives associations from those structured features, so ST.26 patents get grounded, non-LLM region labels - consistent with the system's rule that structured data owns facts and the LLM owns only fuzzy grouping.

## Grounding facts

- `RegionLabel` (mcp-gateway `anarci.ts`, exported) is the canonical 23-member union: VH, VL, CDR-H1/2/3, CDR-L1/2/3, FR-*, Fc, CH1, CL, hinge, heavy-chain, light-chain, Fab.
- `extractSequenceListingST26` already parses `SequenceData` (seqId, residues, `INSDSeq_length`) via `st26Parser` (`ignoreAttributes:false, attributeNamePrefix:'@_', parseTagValue:false`) and the local `asArray` helper.
- ST.26 feature shape (from a real listing): `INSDSeq.INSDSeq_feature-table.INSDFeature` = `{ INSDFeature_key, INSDFeature_location, INSDFeature_quals.INSDQualifier[] }` where a qualifier is `{ INSDQualifier_name, INSDQualifier_value }`. The region label lives in a `note` qualifier's value.
- `extractPatentData` (core) calls `extractAssociations` (LLM) unconditionally; associations flow as `{ regionLabel, seqId }` into `groupConstructs`/`buildWorkup`.

## 1. `normalizeRegionNote(note): RegionLabel | undefined` (mcp-gateway)

A pure function mapping a free-text feature note to a `RegionLabel`, ONLY on a confident match; `undefined` otherwise (never guess). Case-insensitive, tolerant of separators.

Confident mappings (representative, not exhaustive - implement with normalized matching):
- CDR-H1/2/3 <- `CDR-H3`, `CDRH3`, `HCDR3`, `heavy chain CDR 3`, `CDR 3 of the heavy chain` (the digit + H/heavy fixes the label).
- CDR-L1/2/3 <- the light-chain equivalents.
- VH <- `VH`, `VH domain`, `heavy chain variable region`, `variable heavy`, `variable region of the heavy chain`.
- VL <- the light-chain variable equivalents.
- heavy-chain <- `heavy chain` (a full chain, NOT containing "variable").
- light-chain <- `light chain` (NOT "variable").
- Fc <- `Fc`, `Fc region`. Fab <- `Fab`. CH1 <- `CH1`. CL <- `CL`, `constant light`. hinge <- `hinge`.

Precedence: a note that is both a CDR and mentions a number resolves to the CDR label; "variable" + chain resolves to VH/VL before the bare chain label. An unrecognized note returns `undefined`.

## 2. `extractST26Associations(content): Array<{regionLabel, seqId}>` (mcp-gateway)

Parse the ST.26 content (reuse `st26Parser`/`asArray`; never throw - malformed -> `[]`). For each `SequenceData`:
- Resolve `seqId` (`@_sequenceIDNumber`) and the declared length (`INSDSeq_length`).
- For each `INSDFeature` under `INSDSeq.INSDSeq_feature-table`:
  - Read the feature's `note` qualifier value; `normalizeRegionNote` it. Skip if `undefined`.
  - Apply the WHOLE-SEQUENCE rule: emit an association ONLY when the feature's `INSDFeature_location` spans the entire sequence (parsed `start..end` with `start <= 1` and `end >= declaredLength`, declaredLength known). This treats a 12-mer whose only feature is `CDR-H3 @ 1..12` as a CDR-H3 association, while a `CDR-H3 @ 45..57` sub-feature inside a 120-residue VH is NOT emitted as "this SEQ is CDR-H3" (it is a within-sequence annotation, which ANARCI/`buildWorkup` handle). When declaredLength is unknown, skip feature-based associations for that sequence (cannot disambiguate whole vs sub - honest).
- Dedupe by `(regionLabel, seqId)`.

A location like `1..12` parses to `{start:1, end:12}`; `join(1..12,45..57)` or `<1..>12` style locations: take the min start and max end from the numeric tokens; if unparseable, skip the feature.

Export `normalizeRegionNote` and `extractST26Associations` from `mcp-gateway/index.ts`.

## 3. Wiring in `extractPatentData` (core)

```ts
const associations = isST26(markdown)
  ? extractST26Associations(markdown)
  : await extractAssociations(markdown, model);
```

For ST.26 input, structured associations REPLACE the LLM path (the LLM has no valid prose and would only add noise/cost). Text patents are unchanged. `computeCompleteness` and the `byId` residue-join downstream are unaffected (they consume `{ regionLabel, seqId }` the same way). Import `isST26`, `extractST26Associations` from `@mrsirquanzo/sonny-mcp-gateway`.

## Error handling

- `normalizeRegionNote` and `extractST26Associations` never throw (malformed XML / missing fields -> `[]` / `undefined`).
- If an ST.26 listing has no recognizable feature notes, associations is `[]` - honest (better than an LLM guessing region labels from XML). The workup still ships with sequences; constructs are simply absent, which correctly reflects the disclosure.

## Testing

- `normalizeRegionNote`: the confident mappings above resolve correctly; an unknown note (`signal peptide`, `linker`, gibberish) -> `undefined`; precedence (CDR-with-number over bare chain; variable+chain over bare chain).
- `extractST26Associations`: a 2-sequence ST.26 where SEQ 1 is a full-length VH feature and SEQ 2 is a full-length light chain -> both associations; a sequence whose only CDR-H3 feature is a SUB-span of a longer sequence -> NO association; a feature with an unrecognized note -> skipped; malformed XML -> `[]`; a sequence with no declared length -> skipped (no whole/sub disambiguation).
- `extractPatentData` end-to-end: an ST.26 input yields structured associations (LLM NOT called - assert the injected model's `generateStructured` is not invoked); a text input still uses the LLM path (unchanged).

## Out of scope

- Sub-sequence CDR annotations feeding `buildWorkup`'s per-region confirmation (ANARCI still owns within-VH CDR derivation; this slice is whole-SEQ associations only).
- Non-ST.26 structured formats.
- Reconciling a disagreement between an ST.26 feature label and ANARCI's numbering (a later trust/verify concern).
