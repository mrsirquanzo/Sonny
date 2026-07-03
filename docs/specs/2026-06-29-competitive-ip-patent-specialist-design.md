# Competitive IP & Patent Specialist - Overview Design

**Status:** Approved decomposition. Parent design; each slice gets its own spec + plan.
**Date:** 2026-06-29.

## Purpose

Add a Competitive IP & Patent specialist to Sonny that takes an uploaded patent PDF as a seed and produces a verified, structured inventory of the antibody sequences it discloses, organized by the antibody regions the patent itself designates (CDR-H1/2/3, CDR-L1/2/3, VH, VL, Fab, Fc, heavy chain, light chain), with each sequence independently confirmed correct and each region label and species claim verified.

The patent PDF is the seed, not the source of truth.
Patent PDFs are OCR-noisy, and a single wrong residue in an antibody sequence is fatal, so every sequence and label is reconciled against authoritative external sources before it is trusted.

## End-to-end pipeline

1. **Ingest PDF.** Extract the patent number/identity and the patent's own SEQ ID NO -> region map (for example "SEQ ID NO:7 = CDR-H2", "SEQ ID NO:12 = VH") plus the disclosed sequences.
2. **Verify identity.** Resolve the patent number against a real patent API to confirm it is the correct patent and pull authoritative bibliographic data, claims, and full text.
3. **Reconcile.** Compare PDF-extracted sequences against the authoritative full text and flag any residue-level disagreement.
4. **BLAST.** Submit each sequence to real NCBI BLAST (against `nr` and the patent database `pataa`) to confirm it is a real, correctly-transcribed sequence and to report what it matches, including which other patents disclose it.
5. **Confirm regions + species.** Run ANARCI locally to check the patent's region labels against IMGT numbering and to report the closest-germline species, capturing whether the antibody is human, humanized, chimeric, or murine.
6. **Emit.** Produce a per-region sequence table with a verification status on each entry, plus the competitive-IP narrative.

## Approved external stack (all real, no paid tokens)

- **Patent identity / bibliographic authority -> EPO Open Patent Services (OPS).**
  Free with self-serve OAuth2 registration, stable documented REST contract.
  Provides authoritative bibliographic data, claims, full text, and family/legal status.
- **Sequence correctness authority -> NCBI BLAST against `nr` + `pataa` (patent) databases.**
  Rather than depending on always retrieving a clean ST.26 sequence-listing file (not every uploaded patent has one cleanly downloadable), the BLAST step is the authoritative confirmation: it proves the sequence is real and correctly transcribed and surfaces matching patent deposits.
- **Region + species confirmation -> ANARCI locally**, shelled as a subprocess (Python + HMMER), self-contained and deterministic.
  Confirms the patent's region labels against IMGT numbering and reports closest-germline species.

## Slice decomposition

Each slice is independently shippable and gets its own spec, plan, and implementation cycle.
The three pure `sequence -> X` tools come first because each is fully self-contained and testable in isolation; PDF ingest and the orchestrating specialist come last.

1. **`blast_verify` tool** (DONE). Given a sequence, submit to real NCBI BLAST and return ranked top hits as `Evidence[]`. The linchpin of "make sure it's correct."
2. **ANARCI confirm/species tool.** Given a sequence and the patent's claimed region label, confirm the label against IMGT and report closest-germline species. Its output MUST carry per-residue region annotations, IMGT alignment coordinates, and the closest-germline reference, so the later viewer (slice 6) is a pure consumer.
3. **EPO OPS patent-lookup tool (expanded).** Given a patent number, return authoritative bibliographic data, claims, and full text, PLUS the applicant/assignee, the INPADOC patent family across jurisdictions (US, EP, JP, ...), and per-member legal status. Legal status requires interpreting raw INPADOC event codes into human status (granted / lapsed / fee-not-paid / withdrawn / expired) via a maintained code-mapping table plus expiry computation (filing + 20y + adjustments). This turns a sequence match into a freedom-to-operate / ownership signal.
4. **PDF ingest + SEQ-ID -> region extraction.** Adds the file-upload surface; extracts the patent number, the region map, and the disclosed sequences.
5. **Competitive IP specialist.** Orchestrates slices 1-4, reconciles sources, and emits the per-region verified sequence table plus the narrative. Also emits a clean, provenance-tagged, GRAPH-READY relationship structure (see Enhancement decisions) - but does NOT persist it; no graph/triple store is built now.
6. **Sequence alignment viewer (presentation, later).** Front-end component rendering verified sequences against germline / primary claim with CDR-H1/2/3 and CDR-L1/2/3 highlighted. Pure consumer of slice 2 + slice 5 outputs. Use a mature library (EBI Nightingale / react-msa-viewer), not hand-rolled rendering. Build only once the pipeline produces real verified data.

## Enhancement decisions (2026-06-30)

Three enhancements were reviewed; decisions:

- **Assignee + legal status: ACCEPTED, folded into slice 3** (above). Highest value-per-effort: turns molecular confirmation into a commercial / lifecycle signal. Assignee is a trivial biblio read; robust legal status (family walk + code interpretation + expiry computation) is the meaty sub-task.
- **Sequence alignment viewer: ACCEPTED as slice 6 (deferred build).** Design the slice 2 + slice 5 data contracts now to carry region annotations + germline reference + alignment coordinates; build the component later when there is real data to render. No rich front-end exists yet (Sonny's surface is CLI + a thin SSE web app).
- **Persistent knowledge graph publishing: DEFERRED (not built now).** Sonny has NO persistent store today - `EvidenceStore` is a per-run in-memory `Map` and there is zero graph/DB infrastructure. Standing up a persistent graph is a foundational project of its own and is out of scope here. INSTEAD, slice 5 emits verified relationships as a clean, strictly-schema'd, provenance-tagged, graph-ready structure (e.g. `[Patent]-DISCLOSES->[Sequence]`, `[Sequence]-CLAIMED_TO_BIND->[Target]` with provenance = patent claim, `[Patent]-OWNED_BY->[Company]`, legal status as edge/node properties) so a future GraphRAG core can ingest it with no rework. Governance requirement: every edge carries provenance + confidence; verified facts (BLAST sequence identity) are distinguished from patent claims (`CLAIMED_TO_BIND`, not asserted `BINDS`).

## Out of scope (for now)

- De novo antibody annotation. The specialist confirms the patent's own region designations; it does not invent annotations.
- Lens.org PatSeq (requires a paid/institutional token).
- Freedom-to-operate legal opinions.

## Architecture fit

Tools follow the existing `Tool` contract (`packages/mcp-gateway/src/tool.ts`): `{ name, description, call(args, fetchImpl?) => Evidence[] }`, registered in `packages/mcp-gateway/src/index.ts`.
The specialist follows the existing `Specialist` shape (`packages/core/src/specialists.ts`) but, because its flow is a deterministic verification pipeline rather than a single prompt-driven search, slice 5 will define how that orchestration plugs into `produceSection` / the dossier.
`'patent'` is already a valid `EvidenceKind` in `packages/shared/src/contracts.ts`.
