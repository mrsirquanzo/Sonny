# Patent Specialist Hardening Roadmap

**Status:** Approved roadmap. Parent for the hardening slices; each gets its own spec + plan.
**Date:** 2026-07-02.
**Context:** The specialist (slices 1-5b) is built and 203-test green, but everything is fixture-validated. The 5b Critical - the competitor `MATCHES` capability wired to the wrong BLAST field and dead on real data - was caught by an Opus review, not by any green test. Fixtures gave false confidence on the single most important output. This roadmap moves ground truth from a reviewer's head into the test suite.

## Core move

Ground truth lives in the suite, split into two tiers:
- **Offline tier** - fixtures + full-pipeline integration cases with injected tool outputs. Fast, in CI. Must include end-to-end cases (a known competitor with a `MATCHES` assertion), which is what actually catches a 5b-Critical-shaped bug; unit fixtures alone do not.
- **Live tier** - the golden patents against real EPO / BLAST / ANARCI. Nightly, cached, provenance recorded. This is the deferred "live smoke", now with assertions.

## The six hardening slices

### H1 - Golden set + eval harness (offline + live tiers)
Highest value; would have caught the 5b Critical automatically.
- `eval/src`: add a `GoldenPatent` type beside the existing loose `GoldenTarget`; `patentScore.ts` with deterministic metrics (below) plus narrative faithfulness via the decorrelated judge (reuse `faithfulness` + `verifyClaims`).
- `eval/golden/`: 8-12 curated real patents + 3 traps.
- Split H1a (harness scaffold + offline integration tier, no external deps) from H1b (curate golden patents + wire the live tier; needs human-verified ground truth + EPO key + ANARCI install).
- Depends on H6 for a non-flaky live tier.

### H2 - Extraction completeness + full-sequence coverage fix
Closes the most dangerous silent error (truncated-fragment false positive).
- `patentExtract.ts`: capture each SEQ-ID's declared length (ST.25 `LENGTH:` / ST.26) and the declared SEQ-ID range; validate residue alphabet.
- `ExtractedPatent`: add `extractionCompleteness { declaredCount, foundCount, missingSeqIds, format, alphabetWarnings }` so a missed sequence is a visible finding.
- `patentReconcile.ts`: `exactMatch` requires extracted length == declared length (coverage against the full disclosed sequence, not against a possibly-truncated query).
- Design tail: ST.26 XML handling (modern patents are not `SEQ ID NO: N` text; check MarkItDown's rendering, possibly a dedicated parse path). Alphabet/count/length checks are mechanical.

### H3 - Decorrelated narrative verifier
Applies Sonny's verifier spine to the one currently-unverified LLM step.
- After `synthesizeCompetitiveIP`, decompose each narrative point into atomic claims and verify them on a DIFFERENT model family (Ollama when synthesis ran on Anthropic); drop/flag `unsupported`/`overreach`. Stops inference leaps that structural citation-filtering cannot.
- Reuse `packages/core/src/verifier.ts` (`verifyClaims`), adapted to read workup facts.
- Decision: which second model family.

### H4 - CDR-level competitor matching
Recovers the FTO signal the whole-VH >=98% filter drops (humanized / affinity-matured variants share CDRs, differ across framework, ~85-90% whole-VH).
- `blastVerify.ts`: add short-query params (`WORD_SIZE`, `MATRIX=PAM30`).
- BLAST each construct's CDR-H3 (from ANARCI-derived regions) against `pataa`; report CDR-level hits distinctly. Optionally lower the whole-VH `pataa` threshold to ~80% and label those "variant" matches.
- Most design-heavy (short-BLAST validity, thresholds).

### H5 - Construct-pairing sanity gate + non-antibody classification
Cheap, deterministic, high correctness payoff.
- `buildWorkup`: within a construct, require complementary ANARCI chain types (one heavy + one light, already available from 5a `domain.chain`); two heavies / orphan -> `pairingWarning`.
- Non-antibody gate: no numbered variable domain in any construct -> "not a standard antibody construct" rather than forced VH/VL framing.

### H6 - BLAST caching + DB-version provenance
Reproducibility, cost, NCBI etiquette; prerequisite for a non-flaky live tier.
- Content-addressed cache around `blast_verify` keyed by `sha256(sequence + db + program + params)`, recording the `nr`/`pataa` DB version (BLAST returns it) in provenance.

## Golden set (H1b)

8-12 real antibody patents with human-verified ground truth spanning clean cases and traps. Per patent capture: expected assignee, INPADOC family members, legal-status direction; declared sequence count + a few known sequences with exact residues; expected constructs (correct VH/VL pairings) and species calls; known competitor overlaps including >= 1 CDR-level (humanized-variant) case; negative probes (things the dossier must not assert).

Three required traps:
- A deliberate single-residue difference from a known sequence -> must surface the delta, never `exactMatch`.
- A non-antibody disclosure -> must not force antibody framing.
- An image-only or ST.26 listing -> must flag the extraction gap, not silently drop sequences.

## Metrics (mostly deterministic against hard ground truth)

- Extraction recall (SEQ-IDs found / declared) and residue fidelity (exact-match rate on known sequences).
- `exactMatch` soundness: zero fragment false-positives on the golden set.
- Assignee accuracy, family recall, legal-status accuracy.
- Species accuracy and construct-pairing accuracy.
- Competitor-overlap recall and precision, scored separately for whole-sequence and CDR-level.
- Narrative faithfulness via the decorrelated judge.
- Soft-degrade visibility: with ANARCI or EPO forced off, the gap must appear in the output, not resolve to a quiet "unknown."

## Sequence

1. H1a - harness scaffold + offline integration tier (no external deps).
2. H5 + H2-mechanical - pairing gate, non-antibody gate, alphabet/count/length reconciliation, `exactMatch` full-length guard.
3. H6 - BLAST caching + DB provenance.
4. H1b - curate golden patents + ground truth + wire the live tier (needs human-verified data + keys).
5. H3 - decorrelated narrative verifier.
6. H4 - CDR-level competitor matching + H2's ST.26 path.

## What needs the human

- Golden-set curation: the real patents + human-verified ground truth.
- Access: EPO `SONNY_EPO_KEY`/`SECRET`; `conda install -c bioconda anarci hmmer`.
- Two design calls: the decorrelated verifier's second model family (H3); the CDR-level BLAST/threshold approach (H4).
