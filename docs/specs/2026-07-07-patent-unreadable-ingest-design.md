# Surface Unreadable Patent Ingest - Design

**Status:** Approved, ready for implementation plan.
**Branch:** `fix/patent-unreadable-ingest` off `main`.
**Date:** 2026-07-07.

## Purpose

Stop `extractPatentSequences` from silently returning a clean empty result when the uploaded document produced no extractable text.

Discovered by an end-to-end run: a real scanned patent PDF (`WO2016087651A1`, image-only, no text layer) passed through `markitdown` 0.1.6, which extracted 1 character.
`extractPatentSequences` saw ingest `status: 'ok'`, ran extraction over the near-empty text, and returned `{ ok: true, foundCount: 0 }` with no error.
For a due-diligence tool that result is dangerous: "we could not read this document" is indistinguishable from "this patent discloses no sequences."

## The fix

After `ingest` returns `status: 'ok'`, check the returned markdown for extractable content.
If it is empty or near-empty, treat it as a failure using the same vocabulary as the existing ingest-failure path: emit `{ type: 'error', message }` then `{ type: 'patent_ingest', status: 'failed' }`, and return `{ ok: false, error }`.
Only genuinely readable text proceeds to `patent_ingest(ok)` and `extractPatentData`.

```
ingest(filePath)
  status !== 'ok'          -> error + patent_ingest(failed) -> { ok: false }   (existing)
  status 'ok' but unreadable -> error + patent_ingest(failed) -> { ok: false } (NEW)
  status 'ok', readable    -> patent_ingest(ok) -> extractPatentData            (existing)
```

The error message names the likely cause so an operator understands it:
`ingested document has no extractable text (likely a scanned or image-only PDF requiring OCR)`.

## The readability predicate

A pure helper in `packages/core/src/extractPatentSequences.ts`:

```ts
const MIN_READABLE_CHARS = 50;
export function isReadableMarkdown(markdown: string): boolean {
  return markdown.replace(/\s/g, '').length >= MIN_READABLE_CHARS;
}
```

Rationale for the threshold:
The check is on ingest-output length, NOT on whether sequences were found.
Any real patent text (even a one-paragraph abstract) is hundreds to thousands of non-whitespace characters; the scanned-PDF case produced 1.
Fifty non-whitespace characters is a conservative floor that catches empty and near-empty ingest with effectively zero false-positive risk on real text.
This cleanly separates "could not read the document" from "read the document, found no sequences" - a readable patent with no sequences still has thousands of characters of claims and description, so it passes the predicate and returns an honest empty `ExtractedPatent`.

The threshold is a single fixed value (`MIN_READABLE_CHARS = 50`), not a tunable knob or an environment variable.

## Data flow in extractPatentSequences

```
const res = await ingest(filePath);
if (res.status !== 'ok') { emit error; emit patent_ingest(failed); return { ok: false, error }; }   // unchanged
if (!isReadableMarkdown(res.markdown)) {
  const error = 'ingested document has no extractable text (likely a scanned or image-only PDF requiring OCR)';
  emit({ type: 'error', message: error });
  emit({ type: 'patent_ingest', status: 'failed' });
  return { ok: false, error };
}
emit({ type: 'patent_ingest', status: 'ok' });   // unchanged from here down
const data = await extractPatentData(res.markdown, model, emit);
return { ok: true, data };
```

## Error handling

- The predicate is total and pure; it never throws.
- The unreadable path returns before any model call or stage event, so no `patent_extracted`/`patent_associations`/`patent_complete` can fire for an unreadable document.
- The existing catch-all (downstream throw) is unchanged.

## Testing (TDD, no network)

- **Unreadable ingest:** injected `ingest` returning `{ markdown: '\n \n', status: 'ok' }` (or a 1-char markdown) yields `{ ok: false }`, the event sequence `['error', 'patent_ingest']` with `status: 'failed'`, and an error message containing `OCR`. The stubbed model is called zero times.
- **False-positive guard (readable, no sequences):** injected `ingest` returning a long paragraph of patent prose with no `SEQ ID NO` lines yields `{ ok: true }`, `foundCount: 0`, and is NOT flagged - the events start with `patent_ingest(ok)`.
- **Readable with sequences:** the existing happy-path test still passes unchanged (`patent_ingest(ok) -> patent_extracted -> patent_associations -> patent_complete`).
- **Predicate unit test:** `isReadableMarkdown` returns false for `''`, `'   '`, and a 1-char string; true for a 60-character string and a whitespace-padded 60-character string.

## Out of scope

- OCR of scanned PDFs (the real capability gap, scoped separately as follow-up #2).
- The same latent gap in `runPatentWorkup` (the full workup calls `ingestToMarkdown` directly and does not route through `extractPatentSequences`) - logged as a follow-up, not fixed here.
- Any change to `ingestToMarkdown` itself or to the `IngestResult` contract.
