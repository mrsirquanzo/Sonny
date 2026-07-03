# H2 Correctness Closers Design (exactMatch full-length guard + ST.26)

**Status:** Approved to build (extends the locked hardening roadmap; user said proceed).
**Parent:** [Patent Specialist Hardening Roadmap](./2026-07-02-patent-specialist-hardening-roadmap.md), H2.
**Date:** 2026-07-03.

## Purpose

Two silent-failure paths that make the specialist quietly wrong rather than slow:

1. **Fragment false-positive on `exactMatch`.** Today `exactMatch = mismatchCount === 0 && queryCoverage === 100`, where `queryCoverage` is measured against the extracted *query*. If OCR truncated the extracted sequence, a 100% match over the fragment reads as `exactMatch` even though only part of the disclosed sequence matched. The fix requires the extracted length to equal the *declared* length before trusting `exactMatch`.
2. **ST.26 sequences silently dropped.** Modern patents ship a WIPO ST.26 XML sequence listing, not `SEQ ID NO: N` text. The current text regex finds nothing in that XML, so every sequence is dropped with no flag. (Confirmed empirically: MarkItDown passes ST.26 XML through verbatim, so the ingested content is the raw XML and the text regex matches zero sequences.)

## Grounding facts

- `extractSequenceListing` (mcp-gateway) returns `{ seqId, residues }` from `SEQ ID NO:` text only; no length, no XML.
- Single consumer: `patentData.ts:88` `const sequences = extractSequenceListing(markdown)`.
- `VerifiedSequence` (patentReconcile) already carries `length` (extracted residue count). It needs `declaredLength` to make the guard.
- ST.26 XML carries `<INSDSeq_length>` (declared length), `<INSDSeq_sequence>` (residues), `sequenceIDNumber` attribute (SEQ-ID), and `<INSDFeature>` region annotations. `fast-xml-parser` is already a mcp-gateway dependency.

## 1. Declared length on the extracted sequence

`ExtractedSequence` gains `declaredLength?: number` (the length the listing declares for that SEQ-ID, when present).

**ST.25 text:** extend `extractSequenceListing` to capture a declared length when the listing includes it near the SEQ-ID marker - the ST.25 numeric identifier `<211>  N` or a human `LENGTH: N`. When neither is present, `declaredLength` stays undefined (many rendered listings omit it; absence is not an error).

## 2. ST.26 detection + parse path

Two new pure functions in `patentExtract.ts`:

- `isST26(content: string): boolean` - true when the content contains an ST.26 marker (`<ST26SequenceListing` or `<INSDSeq_sequence>`).
- `extractSequenceListingST26(content: string): ExtractedSequence[]` - parse with `fast-xml-parser`; for each `SequenceData`: `seqId` = `@_sequenceIDNumber`, `residues` = normalized `INSDSeq_sequence`, `declaredLength` = `INSDSeq_length`. Skip entries with fewer than 4 residues (same floor as the text path). Never throws: a malformed XML yields an empty list.

A router `extractSequences(content: string): ExtractedSequence[]` chooses the path: `isST26(content) ? extractSequenceListingST26(content) : extractSequenceListing(content)`. `patentData.ts` switches its single call site from `extractSequenceListing` to `extractSequences`.

Region annotations from ST.26 `INSDFeature` are OUT of scope for this slice (the grounded-LLM association path still owns region<->SEQ-ID); capturing them is a clean follow-up.

## 3. `exactMatch` full-length guard

`VerifiedSequence` gains `declaredLength?: number` and `fullLengthConfirmed?: boolean`. `declaredLength` flows from `ExtractedSequence` through `extractPatentData` into `reconcilePatent`.

In `reconcilePatent`, after computing a hit via `toBlastHit`, apply the guard using the sequence's extracted `length` and `declaredLength`. Three cases (honest degradation, never a silent claim):

| declaredLength | extracted length vs declared | `exactMatch` | `fullLengthConfirmed` |
|---|---|---|---|
| known | equal | keep blast-level value | true |
| known | different (positive truncation evidence) | forced **false** | false |
| unknown | n/a | keep blast-level value | false |

Rationale: a known mismatch is positive evidence the query was a fragment, so `exactMatch` must not stand. An unknown declared length is a metadata gap, not evidence of truncation, so we do not flip a blast-exact hit to false, but we never mark it `fullLengthConfirmed` - downstream can require `exactMatch && fullLengthConfirmed` for the strongest "identical molecule" claim and otherwise phrase it as "exact over the extracted region, full length unconfirmed". This keeps the "100% trusts, but only what we can confirm" discipline without over-flagging listings that merely omit a length.

`toBlastHit` stays pure (blast-level identity + query coverage). The full-length guard lives in `reconcilePatent`, the only layer that holds both the extracted length and the declared length.

## 4. Wiring

- `patentExtract.ts`: `ExtractedSequence.declaredLength?`, `isST26`, `extractSequenceListingST26`, `extractSequences`; export the new symbols from `mcp-gateway/index.ts`.
- `patentData.ts`: call `extractSequences` instead of `extractSequenceListing`; thread `declaredLength` onto the assembled sequences so it reaches reconcile.
- `patentReconcile.ts`: `VerifiedSequence.declaredLength?` + `fullLengthConfirmed?`; apply the guard; downgrade `exactMatch` per the table.

## 5. Error handling

- `extractSequenceListingST26` never throws (malformed XML -> empty list), matching the soft-extraction contract.
- `isST26` never throws.
- The guard is pure arithmetic; when `declaredLength` is absent it degrades to the current behavior plus a `fullLengthConfirmed: false` flag.

## 6. Testing

- ST.25 length capture: a listing with `<211> 12` (or `LENGTH: 12`) yields `declaredLength: 12`; a listing without it yields `undefined`.
- `isST26`: true on ST.26 XML, false on `SEQ ID NO:` text.
- `extractSequenceListingST26`: a two-sequence ST.26 XML yields both SEQ-IDs with residues + declaredLength; a malformed XML yields `[]`; a <4-residue entry is skipped.
- `extractSequences` router: ST.26 content -> XML path; text content -> regex path.
- exactMatch guard: (a) declared==extracted + blast-exact -> exactMatch true, fullLengthConfirmed true; (b) declared!=extracted + blast-exact -> exactMatch false, fullLengthConfirmed false (truncation surfaced); (c) declaredLength undefined + blast-exact -> exactMatch true, fullLengthConfirmed false.
- End-to-end: an ST.26 upload flows through `extractSequences` and reconciles (sequences no longer silently dropped).

## 7. Out of scope

- ST.26 `INSDFeature` region annotations feeding the association map (follow-up).
- Multi-HSP summed coverage in `blast_verify` (the guard here addresses the truncated-query axis; summed-coverage is a separate BLAST-layer concern).
- ST.25 full numeric-identifier parsing beyond length (organism/type already handled elsewhere or not needed).
