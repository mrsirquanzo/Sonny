# Patent Ingest and Region-Extraction Design (Patent Specialist - Slice 4)

**Status:** Approved, ready for implementation plan.
**Parent:** [Competitive IP & Patent Specialist - Overview Design](./2026-06-29-competitive-ip-patent-specialist-design.md).
**Slice:** 4 of 6.
**Date:** 2026-07-01.

## Purpose

Turn an uploaded patent file (PDF, PPTX, DOCX, and other formats) into a flat, faithful structured extraction: the patent number, the SEQ ID NO -> residues table, and the region-label -> SEQ ID NO associations the patent declares.

This is the piece that feeds the other tools: BLAST (slice 1) verifies the extracted sequences, ANARCI (slice 2) confirms the VH/VL regions, EPO (slice 3) resolves the patent number.
Grouping the flat associations into distinct antibody constructs is deferred to slice 5.

## Ingest via MarkItDown

Any uploaded file is first converted to markdown by Microsoft MarkItDown (already installed, `markitdown` 0.1.6), shelled out as a subprocess.
This gives one clean text format regardless of the source format (PDF / PPTX / DOCX / ...), so the downstream extraction is uniform.
Consistent with the ANARCI bridge: injectable `exec` runner, soft degradation when the tool is absent.

## Extraction stance: hybrid, faithful, LLM never transcribes residues

- **Sequence listing (regex, deterministic):** the `SEQ ID NO: N` -> residues mapping is regular, so a regex owns it. An LLM must never transcribe residues; a single wrong residue is fatal, and downstream BLAST (slice 1) is the ultimate correctness check on whatever is extracted.
- **Region associations (LLM):** which region designation (CDR-H1/2/3, CDR-L1/2/3, VH, VL, Fab, Fc, heavy/light chain) maps to which SEQ ID NO lives in the claims/description prose. This is genuine language understanding, so the LLM (via `StructuredModel` + a Zod schema, the `extractClaims` pattern) does exactly this and nothing else.
- **Join:** each association's residues are resolved from the regex-extracted listing by `seqId`.

## Package layering

- `packages/mcp-gateway`: `ingestToMarkdown` (subprocess), `extractPatentNumber` and `extractSequenceListing` (pure regex). External-capability and pure-text, consistent with the ANARCI / EPO / BLAST tools.
- `packages/core`: `extractAssociations` (LLM, needs `StructuredModel`) and `extractPatentData` (assembly). Consumes the gateway helpers.
- `apps/cli`: a `extract-patent <file>` command wiring ingest -> `extractPatentData` -> prints `ExtractedPatent` as JSON.

## Components

### `ingestToMarkdown` (mcp-gateway)

```ts
type MarkitdownExec = (filePath: string) => Promise<{ stdout: string; stderr: string; code: number }>;
interface IngestResult { markdown: string; status: 'ok' | 'markitdown_unavailable'; error?: string }
ingestToMarkdown(filePath: string, deps?: { exec?: MarkitdownExec }): Promise<IngestResult>
```

- Default `exec` spawns `markitdown <filePath>` (binary from `SONNY_MARKITDOWN`, default `markitdown`), captures stdout.
- `code === 0` -> `{ markdown: stdout, status: 'ok' }`.
- Spawn error (for example `ENOENT`, tool not installed) or a non-zero exit -> `{ markdown: '', status: 'markitdown_unavailable', error }`. Never throws.
- stdout carries the markdown; stderr is ignored except as diagnostic in `error`.

### `extractPatentNumber` (mcp-gateway)

```ts
extractPatentNumber(markdown: string): string | null
```

- Scans for patent-number candidates (a 2-letter country code followed by digits and an optional kind code, allowing interior spaces/commas), validates each with slice 3's `normalizePatentNumber`, and returns the first candidate that validates (as its cleaned string), else `null`.

### `extractSequenceListing` (mcp-gateway)

```ts
interface ExtractedSequence { seqId: number; residues: string }
extractSequenceListing(markdown: string): ExtractedSequence[]
```

- Matches each `SEQ ID NO[.:]? N` occurrence and captures the residue block that follows, up to the next `SEQ ID` marker or a non-residue boundary.
- Normalizes residues (strip whitespace, digits, and markdown punctuation; uppercase).
- De-duplicates by `seqId` (first occurrence wins); ignores a match with an empty residue block.
- Best-effort and smoke-validated against real converted patents; BLAST is the correctness backstop.

### `extractAssociations` (core)

```ts
interface RegionAssociation { regionLabel: RegionLabel; seqId: number; residues?: string }
extractAssociations(markdown: string, model: StructuredModel): Promise<Array<{ regionLabel: RegionLabel; seqId: number }>>
```

- `RegionLabel` is ANARCI's vocabulary (imported from mcp-gateway).
- Zod schema: `{ associations: Array<{ regionLabel: enum(RegionLabel values); seqId: number }> }`.
- **Input bounding (context-length mitigation):** patents can exceed 100k tokens. Pass the markdown truncated to a configurable cap (default 50000 characters); if a claims marker (`CLAIMS` / `## Claims`, case-insensitive) is present, take the window starting there. Smoke-tuned.
- Uses `MODEL_ROUTER.specialist`.
- Best-effort: on a model or validation error, returns `[]` (the pipeline still ships the sequence listing and patent number).

### `extractPatentData` (core)

```ts
interface ExtractedPatent {
  patentNumber: string | null;
  sequences: ExtractedSequence[];
  associations: RegionAssociation[];
}
extractPatentData(markdown: string, model: StructuredModel): Promise<ExtractedPatent>
```

- Calls `extractPatentNumber` + `extractSequenceListing` (gateway) and `extractAssociations` (LLM).
- Joins: for each association, resolve `residues` from the listing by `seqId` (undefined if the SEQ ID has no listing entry).
- Returns the flat `ExtractedPatent`.

### CLI command (apps/cli)

- `extract-patent <file>`: `ingestToMarkdown(file)` -> if `markitdown_unavailable`, print the error and exit non-zero; else `extractPatentData(markdown, model)` -> print `ExtractedPatent` as JSON.
- Model selection follows the existing CLI backend pattern (`SONNY_BACKEND`).

## Data flow

```
file -> ingestToMarkdown (markitdown subprocess) -> markdown
markdown -> extractPatentNumber (regex)          -> patentNumber
markdown -> extractSequenceListing (regex)       -> sequences[]
markdown -> extractAssociations (LLM, bounded)   -> associations[] (label, seqId)
join sequences into associations by seqId        -> ExtractedPatent
```

## Error handling

- `ingestToMarkdown` never throws; a missing/failed markitdown yields `markitdown_unavailable`.
- `extractAssociations` never throws; a model/validation failure yields `[]`.
- `extractPatentData` returns a partial record (empty associations, `patentNumber: null`, or empty sequences) rather than failing, so the pipeline degrades gracefully.
- The CLI is the only place that surfaces a hard failure (unreadable file / markitdown unavailable) to the user with a clear message and non-zero exit.

## Testing

Pure and injected; no live markitdown or model in unit tests.

- `ingestToMarkdown`: mock `exec` returning markdown on `code 0` -> `status 'ok'`; a spawn error / non-zero exit -> `markitdown_unavailable`, no throw.
- `extractPatentNumber`: finds and validates a number in sample markdown (including one with interior spaces/commas); returns `null` when none validates.
- `extractSequenceListing`: parses multiple `SEQ ID NO: N` blocks into `{ seqId, residues }` with normalized residues; de-dupes repeated ids; skips empty blocks.
- `extractAssociations`: a mock `StructuredModel` returns associations validated against the schema; a throwing model yields `[]`; the input is truncated to the cap and prefers the claims window.
- `extractPatentData`: joins residues into associations by `seqId`; leaves `residues` undefined when the listing lacks the id; assembles the flat record.
- CLI: an injected ingest+extract path prints the expected JSON; `markitdown_unavailable` exits non-zero with a message.

## Setup

MarkItDown is already installed (`markitdown` 0.1.6). Optional `SONNY_MARKITDOWN` overrides the binary path.
A manual smoke (not a unit test) runs a real antibody patent PDF end to end: confirm markitdown conversion, the sequence-listing regex against the real converted text, the claims-window bounding, and the LLM associations. Tune the regex and the input cap against real output; the TypeScript contracts stay fixed.

## Out of scope

- Grouping SEQ IDs into distinct antibody constructs (slice 5).
- The web upload surface (later; CLI file path only in this slice).
- Reconciliation of extracted sequences against EPO full text and BLAST (slice 5).
- OCR of image-only PDFs beyond what MarkItDown provides.
