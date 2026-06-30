# `blast_verify` Tool Design (Patent Specialist - Slice 1)

**Status:** Approved, ready for implementation plan.
**Parent:** [Competitive IP & Patent Specialist - Overview Design](./2026-06-29-competitive-ip-patent-specialist-design.md).
**Slice:** 1 of 5.
**Date:** 2026-06-29.

## Purpose

Given a biological sequence, submit it to real NCBI BLAST and return the ranked top hits as `Evidence[]`.
This answers the load-bearing question for the patent specialist: is this a real, correctly-transcribed sequence, and what does it match?
When run against NCBI's patent protein database (`pataa`) it also surfaces which other patents disclose the same molecule, which is the raw material for competitive-IP analysis.

This is the linchpin of "validate the sequences through BLAST, make sure they are correct."

## Tool contract

Follows the existing `Tool` interface (`packages/mcp-gateway/src/tool.ts`): `call(args, fetchImpl?) => Promise<Evidence[]>`.

- **name:** `blast_verify`
- **description:** "Verify a protein or nucleotide sequence against NCBI BLAST. Returns ranked top hits with percent identity, E-value, organism, and source database (including patent deposits). Use to confirm a sequence is real and correctly transcribed and to find what it matches."
- **args:**
  - `sequence: string` (required) - raw residues; may arrive with a FASTA header, whitespace, or numbering.
  - `program?: 'auto' | 'blastp' | 'blastn'` (default `'auto'`).
  - `database?: string` (default `'nr'`; the specialist calls again with `'pataa'` for the patent sweep).
  - `expect?: number` (default `10`) - E-value threshold passed to BLAST.
  - `maxHits?: number` (default `10`) - number of top hits to return.

## Behavior

1. **Normalize the input.**
   Strip a leading FASTA header line (`>...`), whitespace, digits, and position numbering.
   Uppercase the residues.
   If the cleaned sequence is empty, return `[]`.
2. **Auto-detect molecule type** (when `program === 'auto'`).
   If the cleaned sequence contains only `ACGTUN` characters, treat it as nucleotide and use `blastn`; otherwise treat it as protein and use `blastp`.
   This matters because antibody patents disclose both amino-acid and DNA sequences.
3. **Submit (async lifecycle, the core of this slice).**
   `Put` request to `https://blast.ncbi.nlm.nih.gov/Blast.cgi` with `CMD=Put`, `PROGRAM`, `DATABASE`, `QUERY`, `EXPECT`, `HITLIST_SIZE`, and the courtesy params `tool=sonny` and `email=<SONNY_NCBI_EMAIL or a default>`.
   Parse the returned `RID` (request id) and `RTOE` (estimated seconds) from the response.
4. **Poll** `CMD=Get&RID=<rid>&FORMAT_OBJECT=SearchInfo` until `Status=READY`.
   Wait `RTOE` seconds before the first poll, then poll on a fixed interval, respecting NCBI's guidance not to poll a single RID too frequently.
   Stop with an error on `Status=UNKNOWN` (expired/failed) or when the timeout is exceeded.
5. **Fetch + parse** `CMD=Get&RID=<rid>&FORMAT_TYPE=JSON2_S`.
   Parse the hit list. The implementation may fall back to XML/Tabular if JSON parsing proves unreliable against the live API; unit tests pin the chosen format via fixtures.
6. **Map each hit -> `Evidence`.**
   - `kind`: `'patent'` when the hit's source database is the patent database, else `'dataset'`.
   - `title`: hit description/definition.
   - `snippet`: `"<percentIdentity>% id, E=<eValue>, <organism>"`.
   - `passage`: short alignment summary (query coverage, aligned length).
   - `url`: NCBI accession link.
   - `raw`: `{ accession, percentIdentity, eValue, bitScore, queryCoverage, organism, database, program }`.
   - `retrievedAt`: ISO timestamp.

## Configurable constants (defaults)

- `pollIntervalMs`: 15000.
- `timeoutMs`: 180000.
- `endpoint`: `https://blast.ncbi.nlm.nih.gov/Blast.cgi`.
- `email`: from `SONNY_NCBI_EMAIL`, falling back to a project default.

## Design decisions (locked)

- **Dumb single-DB tool.**
  One `DATABASE` per call (default `nr`).
  The specialist (slice 5) composes multiple calls, for example a second call against `pataa`, rather than the tool fanning out itself.
  Keeps the tool simple and composable.
- **Verdict lives in the specialist, not the tool.**
  The tool returns ranked hits and the per-hit `percentIdentity`.
  The "at least X% identity means confirmed correct" judgment is deferred to slice 5.
- **Output kinds** are `'patent'` and `'dataset'`, both already valid in `EvidenceKindSchema`.

## Error handling

- Non-OK HTTP responses throw (caught upstream by `safeToolCall`).
- `Status=UNKNOWN` or timeout throws with a clear message.
- Empty/whitespace sequence returns `[]` (not an error).
- A READY search with zero hits returns `[]`.

## Testing

All tests inject `fetchImpl` to mock the full Put -> poll -> Get sequence deterministically; no live network in unit tests.

- Protein sequence -> `program` resolves to `blastp`.
- Nucleotide-only sequence (`ACGTU...`) -> `program` resolves to `blastn`.
- FASTA header / whitespace / numbering is stripped before submission.
- Submission parses `RID` and `RTOE` correctly.
- Polling loops on `WAITING` then proceeds on `READY`.
- `Status=UNKNOWN` throws; timeout throws.
- JSON hit list maps to `Evidence[]` with all `raw` fields populated.
- A patent-database hit is mapped to `kind: 'patent'`; an `nr` hit to `kind: 'dataset'`.
- Zero hits and empty input both return `[]`.

## Out of scope

- The patent sweep loop (specialist concern, slice 5).
- ANARCI region/species confirmation (slice 2).
- Reconciliation against EPO OPS full text (slices 3-5).
- Live-network integration tests (a manual smoke against the real NCBI endpoint validates the format choice; not a unit test).
