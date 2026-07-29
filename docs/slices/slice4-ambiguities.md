# Slice 4 ambiguities and test-suite judgments

This report derives only from `SLICE4.md` and `SPEC.md` §§8.1, 8.2, 8.3, and
12.3. The items below are places where an executable contract required a
choice that the normative text does not fully determine.

## Biomarker participation in context identity

`SPEC.md` §8.1 says to normalize gene symbols and variants and generate a
composite `canonicalContextId`; `SLICE4.md` §4 says to hash the normalized
context. It does not explicitly say whether the biomarker's free-text `raw`
value participates once structured gene/variant values exist, nor whether a
biomarker distinguishes disease identity or is merely metadata.

**Test judgment:** normalized gene symbol and variant are identity-bearing.
Changing either changes the id. Case and whitespace do not. The raw rendering
does not independently distinguish otherwise identical structured biomarkers.
This favors avoiding wrong merges between molecularly distinct populations.

## Treatment setting and line of therapy

`SPEC.md` §8.1 requires normalization of treatment setting and line of therapy,
but `DiseaseContextKeySchema` contains only `treatmentSetting`; it has no
`lineOfTherapy`, `stage`, or `histology` fields. Neither document supplies a
controlled vocabulary or synonym table (for example, whether "2L" equals
"second line").

**Test judgment:** the normalization input exposes `treatmentSetting` and
`lineOfTherapy` separately, and both participate in identity. They receive
only conservative free-text normalization (trim, whitespace collapse, case
folding). The suite does not assert uncontrolled semantic synonym expansion.
The implementation must decide whether to preserve line/stage/histology as new
top-level fields, fold them into `treatmentSetting`, or expose them only in a
normalized identity payload.

## Unresolved-context hash material

`SLICE4.md` §4 says an unresolved id is derived from "raw inputs", while the
same section says the hash is over the normalized context. Literal raw hashing
would make case/whitespace variants split; normalized-raw hashing satisfies
the explicit same-id normalization invariant but is not spelled out.

**Test judgment:** hash normalized raw disease text plus normalized optional
context fields, with no candidate MONDO id in identity. Candidate ordering or
later changes to `possibleMatches` must not rewrite identity.

## Public API names and hash observability

The scope names the module and `OntologyIndex`, but not exported function names
or reconciliation/directionality return types.

**Test judgment:** the module exports `normalizeDiseaseContext`,
`contextsAreEquivalent`, `diseaseContextRelation`, and
`reconcileContextAssessments` from the core package. Normalization exposes the
exact `normalizedIdentity` passed to the already-existing
`sha256CanonicalJson`, allowing the suite to reject a second hashing
convention. Directional relation values are `narrower`, `broader`, and
`unrelated`.

## `mappingRelation` placement

`SPEC.md` §8.1 shows `mappingRelation` and `matchedVia` in a disease-resolution
record, but the already-existing `DiseaseContextKeySchema` does not include
either. The slice nevertheless makes `mappingRelation` normative.

**Test judgment:** both are top-level fields on the normalization result,
alongside the schema-compatible disease context. Structural schema parsing may
strip them, so callers requiring provenance need either a passthrough schema
or a separately typed enriched result.

## Broad/narrow mapping confidence

The allowed `mappingConfidence` values are `exact`, `inferred`, and
`unresolved`, while `mappingRelation` distinguishes broad/narrow/related.
The spec forbids reading broad/narrow as equivalence but does not assign their
confidence.

**Test judgment:** a broad/narrow mapping may be `inferred` or `unresolved`,
but never `exact`; it is never accepted by `contextsAreEquivalent`.

## Cross-reference source-id parsing

Rule 3 requires explicit EFO/DOID/NCIt/Orphanet/MeSH mappings but does not say
whether callers pass `{source, sourceId}` or a prefixed string, and NCIt ids
are commonly written both `NCIT:C3512` and `C3512`.

**Test judgment:** normalization recognizes prefixed strings and calls the
injected cross-reference lookup. The fixture stores NCIt's source id as
`C3512`. Orphanet and MeSH are contractually supported but not separately
asserted because §12.3 calls specifically for EFO/DOID coverage and the user
requested EFO/DOID/NCIt rejection tests.

## Candidate generation

Layer 2 requires candidates and reasons for unresolved inputs, but
`OntologyIndex` provides only exact/synonym/crossref lookups—no fuzzy search or
term enumeration. Therefore a generic resolver cannot populate near-neighbour
candidates using only the declared interface.

**Test judgment:** the misspelling cases must produce at least one reasoned
candidate. This implies the bundled fixture may provide deterministic candidate
data or the interface needs a deterministic candidate-search extension. No
network or model is permitted.

## Directionality versus satisfaction

`SPEC.md` §8.1 says neither lung-adenocarcinoma-to-NSCLC nor the reverse is an
automatic finding match, while also requiring ancestor-aware directional
semantics. It does not define a policy that ever permits directional
aggregation.

**Test judgment:** equivalence is false in both directions; a separate relation
helper reports child-to-parent as `narrower` and parent-to-child as `broader`.
No `satisfies` helper silently promotes either relation to a join.

## Reconciliation statuses and conflict projection

`SLICE4.md` §5 lists evaluated-by-both, only-Q1, only-Q3, conflicting, and
ambiguous. `SPEC.md` §8.3 supplies a 3×3 favorable/uncertain/unfavorable
interpretation but does not map each five-value Q1/Q3 enum into those buckets,
nor clarify whether `conflicting` is a flag in addition to
`evaluated-by-both`.

**Test judgment:** each joined row has one `status`; a favorable Q1
(`strong`) plus unfavorable Q3 (`unsupported`) is `conflicting`. A
non-conflicting pair is `evaluated-by-both`. An unresolved singleton is
`ambiguous`, taking precedence over only-Q1/only-Q3. The original assessment
objects are carried intact so confidence and evidence availability cannot be
folded into status.

## Duplicate assessments

Neither §8.2 nor §8.3 states whether multiple Q1 assessments with the same
context but different `q1HypothesisKey`, target, role, or intent are legal, or
whether Q3 may contain strategy-specific duplicates.

**Test judgment:** this suite exercises at most one Q1 and one Q3 assessment
per context. A production join should either return arrays per side or include
the additional hypothesis/strategy identity in its grouping contract; silently
overwriting duplicates would be unsafe.

