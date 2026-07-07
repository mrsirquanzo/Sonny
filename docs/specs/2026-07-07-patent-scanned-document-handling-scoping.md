# Scanned / Unreadable Patent Handling - Scoping Decision

**Status:** Scoped, DEFERRED (fast-follow; folds into Phase 2 patent discovery). Not on the LUMINA showcase critical path.
**Date:** 2026-07-07.
**Context:** Follow-up #2 to the unreadable-ingest fix (PR #35). An E2E run on `WO2016087651A1` (image-only PDF) produced no text; #1 now fails such documents honestly. #2 is the question of how to actually read them.

## Decision

**Strategy B (fetch the authoritative ST.26 sequence listing by patent number) is the path. Strategy A (OCR the sequences) is rejected.**

OCR is permitted for exactly one thing: the **error-tolerant read of the patent number** (cover page), which keys the authoritative fetch. Sequences are never OCR'd.

## Rationale

The specialist's core thesis is residue exactness: "structured/regex owns residues, one wrong residue is fatal, 98% retrieves / 100% trusts."
In antibody engineering a single OCR misread - a Leucine read as an Isoleucine - can destroy a patent claim.
Building an OCR pipeline that injects ~95%-confidence residue data into a 100%-confidence verification engine corrupts the tool at its foundation.
Fetching the machine-readable ST.26 XML that patents file separately from the PDF guarantees residue exactness and reuses the existing ST.26 parser.

## Architecture (when built)

```
scanned / image-only PDF
  -> OCR the cover page ONLY -> patent number        (OCR is error-tolerant here; a number is easy to correct/validate)
  -> fetch authoritative ST.26 listing by patent number (WIPO Patentscope / EPO OPS / USPTO)
  -> existing ST.26 parser (extractSequenceListingST26 + extractST26Associations) -> exact sequences
  (optional) OCR the PDF body for narrative/association context ONLY, flagged low-trust, never residues
```

- Sequences come exclusively from the fetched ST.26 XML - the exact, machine-readable source.
- Any OCR-derived field (patent number, narrative context) is marked as OCR-derived / verification-required and never asserted as fact.

## Coverage limit (must be surfaced honestly)

Patents that never filed an ST.26 listing (older / pre-2022, or non-antibody disclosures) have no authoritative listing to fetch.
For those, the honest answer is the #1 unreadable-ingest signal: "no extractable text; no ST.26 listing available" - not a fabricated or OCR-guessed sequence.
This is a deliberate coverage boundary, not a silent gap.

## Overlap with Phase 2 (why it folds in)

Phase 2 (target-driven `competitive_ip` specialist) already needs a **patent-fetch/search tool** to discover patents for a target.
The ST.26-by-patent-number retrieval this strategy needs is the same class of machinery.
Build them together: one patent-source gateway (fetch by number + search by target), the ST.26 listing retrieval riding on top.

## Why it is deferred (not now)

The LUMINA showcase controls its input documents.
Born-digital PDFs, DOCX/PPTX, ST.26 XML, and pasted text all work today (proven E2E), and #1 makes the scanned-PDF case fail gracefully.
So #2 is a real-world hardening investment to schedule when actual case studies bring scanned documents - at which point it is built as part of the Phase 2 patent-source gateway.

## Explicitly rejected

- **OCR of sequence residues** (Tesseract, Azure Document Intelligence, or vision models) as a source of extracted residues - violates the exactness thesis.
- A standalone OCR pipeline decoupled from ST.26 fetch - it would be a liability with no upside over Strategy B.
