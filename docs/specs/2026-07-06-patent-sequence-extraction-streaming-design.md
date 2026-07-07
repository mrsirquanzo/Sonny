# Streamable Patent Sequence Extraction - Design

**Status:** Approved, ready for implementation plan.
**Branch:** `feat/patent-sequence-extraction-streaming` off `main`.
**Date:** 2026-07-06.

## Purpose

Let a LUMINA user upload any patent document and see the disclosed sequences extracted from it, streamed into a right-side pop-out panel.

Sonny already extracts patent sequences end-to-end (`ingestToMarkdown -> extractSequences -> associations -> completeness`), but only as a batch CLI call (`runExtractPatent`, stranded in `apps/cli`) that returns a final object with no streaming.
LUMINA drives Sonny in-process (worker thread, `produceBriefing -> emit(TraceEvent) -> its own SSE`), so this slice exposes the extraction as a first-class, importable, `emit`-streaming capability shaped for that seam.

This is the extraction-only MVP.
Sequence verification (BLAST identity, ANARCI region confirmation) and the full competitive-IP workup are explicitly a later layer, not in scope here.

## Scope boundary

- **In:** ingest -> extract disclosed sequences -> region associations -> completeness, streamed via `emit`, returned as the existing `ExtractedPatent`.
- **Out:** BLAST/ANARCI/EPO verification, the competitive-IP narrative, the graph, target-driven patent discovery (the doc's Phase 2), the LUMINA pop-out UI itself (LUMINA-side), file-upload/temp-file handling (LUMINA-side).

## The entrypoint

New file `packages/core/src/extractPatentSequences.ts`:

```ts
export async function extractPatentSequences(opts: {
  filePath: string;
  emit: (e: TraceEvent) => void;
  deps?: ExtractPatentDeps;   // { ingest?, model? } - injection for tests and backend choice
}): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }>;
```

`ExtractPatentDeps` (already defined for the CLI runner) is `{ ingest?, model? }`.
`ExtractedPatent` (already defined in `packages/core/src/patentData.ts`) is the whole authoritative result LUMINA renders:
`{ patentNumber: string | null; sequences: ExtractedSequence[]; associations: RegionAssociation[]; completeness?: ExtractionCompleteness }`, where `ExtractedSequence = { seqId, residues, declaredLength? }`.

The result is its own type with its own renderer (the pop-out).
It is NOT mapped into `Briefing` - a patent extraction is not a gene dossier.

## Streaming vocabulary

Four new members added to the `TraceEvent` union in `packages/shared/src/contracts.ts` (a plain TS discriminated union; no Zod schema to update):

```ts
| { type: 'patent_ingest'; status: 'ok' | 'failed'; format?: string }
| { type: 'patent_extracted'; patentNumber: string | null; sequenceCount: number }
| { type: 'patent_associations'; associationCount: number; source: 'st26' | 'llm' }
| { type: 'patent_complete'; completeness: ExtractionCompleteness }
```

`ExtractionCompleteness` is already exported from `packages/core`; the event references its structural shape.
To keep `sonny-shared` free of a dependency on `sonny-core`, the `patent_complete` event carries the completeness fields inline via a small shared type (`ExtractionCompletenessLike`) declared in `contracts.ts`, mirroring how other cross-package event payloads are structurally typed in the union.
Failures reuse the existing `{ type: 'error'; message: string }`.

Design rationale for milestone (not per-sequence) events: the events narrate progress for the glass-box; the returned `ExtractedPatent` is the authoritative data, so residues travel in the result, never in an event.
`patent_extracted` fires the instant sequences are parsed - before the slower region-association step - so the panel can show "N sequences found, mapping regions..." while the one model call (text patents only) runs.
Per-sequence streaming is a trivial later addition and is deliberately out of the MVP.

## How the stages emit

Thread an **optional** `emit?: (e: TraceEvent) => void` parameter through `extractPatentData(markdown, model, emit?)` in `packages/core/src/patentData.ts`, defaulting to a no-op.
Because it is optional, `runPatentWorkup` (which also calls `extractPatentData`) and every existing test are unaffected.

`extractPatentData` emits at its natural stage boundaries:
1. After `extractSequences` + `extractPatentNumber`: `patent_extracted { patentNumber, sequenceCount }`.
2. After associations resolve (knowing whether the ST.26 structural path or the LLM path ran): `patent_associations { associationCount, source }`.
3. After `computeCompleteness`: `patent_complete { completeness }`.

`extractPatentSequences` wraps this with ingest and the ingest event:
1. `ingest(filePath)`; on non-ok status, `emit({ type: 'error', message })`, `emit({ type: 'patent_ingest', status: 'failed' })`, return `{ ok: false, error }`.
2. On success, `emit({ type: 'patent_ingest', status: 'ok' })`, then `extractPatentData(res.markdown, model, emit)`, return `{ ok: true, data }`.

## Boundaries with LUMINA

- Sonny takes a `filePath`; LUMINA owns the HTTP upload, temp-file write, and cleanup (consistent with `runExtractPatent`/`runPatentWorkup`).
- The pop-out UI is LUMINA-side; Sonny hands over the streaming capability plus the `ExtractedPatent` contract.
- Backend: the only model call is the text-patent association step, via `makeModel()` -> ollama by default.
  ST.26 patents skip the model entirely.
  No paid API and no external services are required for extraction.

## Surgical cleanup included

The CLI's `runExtractPatent` (`apps/cli/src/extractPatent.ts`) is repointed to delegate to `extractPatentSequences` with a no-op `emit`, removing the duplicate ingest+extract orchestration so there is one implementation.
The `extract-patent` CLI command keeps working unchanged.

## Exports

`packages/core/src/index.ts` exports `extractPatentSequences` and its result types (`ExtractedPatent`, `RegionAssociation`, `ExtractionCompleteness`) if not already exported, so LUMINA can import both the function and the types it renders.

## Error handling

- `extractPatentSequences` never throws: an ingest failure returns `{ ok: false, error }` with the two failure events above; a downstream throw is caught and returned as `{ ok: false, error }`.
- The association step already degrades to `[]` on model failure (existing behavior); `source` is still reported and `associationCount` is `0`, which the completeness `associationCount` signal already surfaces.

## Testing (TDD, no network)

- **Happy path (text patent):** injected `ingest` returning fixture markdown, stubbed `model` returning canned associations.
  Assert the emit order is exactly `patent_ingest(ok)` -> `patent_extracted(count=N)` -> `patent_associations(source='llm')` -> `patent_complete`, and the returned `ExtractedPatent` matches.
- **ST.26 path:** injected ST.26 markdown -> associations come from the structural parser, `source='st26'`, and the stubbed model is called **zero** times.
- **Ingest failure:** injected `ingest` returning a non-ok status -> `{ ok: false, error }`, exactly one `error` event and a `patent_ingest(failed)` event, and no stage events after.
- **Regression:** existing `extractPatentData` and `runExtractPatent` tests remain green (the new `emit` parameter is optional and defaults to no-op).

## Out of scope

- Sequence verification (BLAST/ANARCI/EPO), competitive-IP narrative, relationship graph.
- Target-driven patent discovery (a `competitive_ip` roster specialist + a patent-search tool - the doc's Phase 2).
- The LUMINA pop-out UI, upload handling, and temp-file lifecycle.
- Per-sequence streaming events and a sequence-alignment viewer.
