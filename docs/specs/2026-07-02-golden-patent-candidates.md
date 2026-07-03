# Golden Patent Candidate Set (H1b - draft for human verification)

**Status:** Draft for human curation. NOT ground truth until every value is verified against an authoritative source.
**Date:** 2026-07-02.
**Parent:** [Patent Specialist Hardening Roadmap](./2026-07-02-patent-specialist-hardening-roadmap.md).

## The rule this document obeys

A golden set is only as trustworthy as its ground truth. Fabricating any value - a patent number, a SEQ ID residue, a family member, a legal status - would poison the exact discipline this specialist exists to enforce ("verify, do not believe").

So this draft separates two things strictly:
- **Proposed (drug-level facts, reasonably confident):** the antibody, its originator, and its format (human / humanized / chimeric / murine). These are widely documented and stable.
- **MUST VERIFY (patent-specific, do NOT trust from memory):** the exact primary patent number, declared sequence count, individual SEQ ID residues, INPADOC family members, and legal status. Every one of these is pulled from EPO OPS / Google Patents and confirmed by a human before it enters a golden file.

I have deliberately NOT written any patent number, residue string, or family/legal value below. Those are the fields to populate in the verification pass.

## Candidate patents (spanning the species spectrum and competitor cases)

| # | Antibody (drug) | Originator/assignee (proposed) | Format (proposed) | What it tests | Must-verify fields |
|---|---|---|---|---|---|
| 1 | Adalimumab (Humira) | AbbVie (orig. BASF/Knoll) | fully human | clean human-like species; large multi-jurisdiction family; whole-sequence competitor overlap (biosimilars) | patent no., family, legal, seq count, VH/VL residues |
| 2 | Rituximab (Rituxan) | Biogen/Genentech (orig. IDEC) | chimeric (murine V + human C) | the chimeric species call (murine variable + human constant) | as above |
| 3 | Trastuzumab (Herceptin) | Genentech | humanized (from murine 4D5) | humanized -> "human-like" (we do not split human vs humanized); its murine parent shares CDRs -> CDR-level overlap candidate | as above + parent 4D5 CDRs |
| 4 | Pembrolizumab (Keytruda) | Merck (orig. Organon) | humanized | anti-PD-1; competitor to nivolumab on the SAME TARGET but a DIFFERENT antibody -> negative probe: must NOT assert CDR/sequence overlap with nivolumab | as above |
| 5 | Nivolumab (Opdivo) | BMS/Ono | fully human | anti-PD-1 human case; pairs with #4 as the "same target, distinct molecule" control | as above |
| 6 | Cetuximab (Erbitux) | ImClone/Lilly/Merck KGaA | chimeric | anti-EGFR chimeric; ties to the existing `egfr` golden target | as above |
| 7 | Muromonab-CD3 (OKT3) | Ortho/Johnson & Johnson | murine | the murine species case; an older patent, strong candidate for the image-only-listing trap (T3) | as above + listing format |
| 8 | A humanized variant of a known murine/originator antibody by a DIFFERENT assignee | to source | humanized | the CDR-level FTO case: shares CDR-H3 with an originator, differs across framework (~85-90% whole-VH) - the overlap the whole-VH >=98% filter MISSES (validates H4) | patent no., the shared-CDR originator, residues |

Notes:
- #4 + #5 are a deliberate pair: same antigen (PD-1), distinct antibodies. The dossier must report both as anti-PD-1 without ever claiming their sequences/CDRs overlap. This is a precision (false-positive) probe.
- #3's murine parent (4D5) and #8 are the two CDR-level cases the whole-VH filter would miss; at least one is required per the roadmap.
- Species coverage: human (#1, #5), humanized (#3, #4), chimeric (#2, #6), murine (#7). All four classes exercised.

## The three required traps

- **T1 - single-residue difference.** A patent whose disclosed sequence differs from a known reference by exactly one residue (an affinity-matured or point-mutant variant). Correct behavior: surface the delta (`mismatchCount === 1`), NEVER `exactMatch`. Sourcing: needs a documented point-variant pair (for example an affinity-matured version of an originator antibody, different SEQ ID one residue off). To source in the verification pass.
- **T2 - non-antibody disclosure.** A patent disclosing a non-antibody format - a CAR construct (e.g. a CD19 CAR-T), a fusion protein, a cytokine, or a bare antigen. Correct behavior: `disclosureShape === 'not-standard-antibody'`, no forced VH/VL framing. Candidate: a well-documented CAR-T construct patent.
- **T3 - image-only or ST.26 listing.** Either an older patent whose sequence listing is a scanned image (OCR drops it) OR a post-mid-2022 patent shipping a WIPO ST.26 XML listing (our `SEQ ID NO: N` text regex does not target it). Correct behavior: the extraction-completeness check flags a gap (`missingSeqIds` non-empty / `foundCount` below declared); sequences are NOT silently dropped. Candidate: OKT3 (#7, old) for the image case, plus one recent (post-2022) antibody grant for the ST.26 case.

## Ground-truth capture template (per patent)

Each confirmed candidate becomes a `GoldenPatent` JSON (the type built in H1a). Fields, with how each is scored:

```
name, patentNumber                          -> identity
expectedAssignees[]                         -> assigneeAccuracy (setRecall)
expectedFamilyMembers[]                     -> familyRecall (setRecall)      [jurisdiction-dependent; capture the key members]
expectedLegalDirection                      -> legalStatusAccuracy           [ESTIMATE, not legal advice - loud in output]
declaredSequenceCount                       -> extractionRecall
knownSequences[] (a few, EXACT residues)    -> residueFidelity, exactMatch soundness
expectedConstructs[] (VH/VL pairings, species) -> speciesAccuracy, pairingAccuracy
expectedCompetitorOverlaps[] (whole + >=1 cdr) -> competitorRecall/precision (per level)
mustNotAssert[] (negative probes)           -> narrative faithfulness / precision
traps[]                                      -> trap-specific assertions
```

## How the ground truth gets populated (verification pass)

For each candidate the user confirms:
1. Pull bibliographic + assignee + INPADOC family + legal status from **EPO OPS** (via the built `lookupPatent`, once `SONNY_EPO_KEY`/`SECRET` are set) or Google Patents, and record the DB/date accessed.
2. Pull the declared sequence count and a few exact SEQ ID residues from the patent's sequence listing (Google Patents / PatentScope), transcribed carefully and double-checked (a wrong golden residue is worse than none).
3. Record the correct VH/VL pairings and species from the patent claims + literature.
4. For competitor overlaps, identify at least one documented CDR-level (humanized-variant) pair.
5. A human reviews and signs off before the JSON lands in `eval/golden/`.

I can drive steps 1-4 (fetching + drafting the values with sources cited) and hand you each field for confirmation; I will flag any field I cannot verify rather than guess.

## Next step

Confirm, swap, or add to this candidate list (8 patents + 3 traps = enough to span clean cases and traps per the roadmap). Then, when the EPO key is available (or via Google Patents), I start the verification pass one patent at a time, citing sources, and you sign off each `GoldenPatent` file.
