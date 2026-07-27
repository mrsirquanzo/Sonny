# Slice 2 test-suite ambiguities

This report records judgments made from `/tmp/slice1/SLICE2.md`, draft 5.6, and
the pre-Slice-2 source. It does not infer a preferred design from a prospective
implementation.

## 1. No exact neutral snippet wording is normative

`SLICE2.md` §1 and SPEC §7.1 prescribe facts that must remain and conclusions
that must disappear, but provide no exact replacement strings. The neutrality
tests therefore assert semantic invariants: location/tissue/domain facts remain,
while the forbidden terminology is absent. They intentionally do not snapshot
punctuation, sentence order, spelling of “localisation,” or an exact phrase for
the presence/absence of a surface annotation.

The user additionally required “any modality name,” beyond the three examples
in the Slice 2 acceptance checklist. I treated every canonical modality in SPEC
§4.1 as forbidden editorial vocabulary, using common display spellings. I did
not forbid the ordinary word `protein`: it is part of target identity and source
facts as well as the phrase “protein therapeutic,” and banning it would destroy
valid factual snippets.

## 2. Whether tool metadata is in “snippet construction”

SPEC §7.1 and the Slice 2 checklist say no Open Targets or UniProt *snippet*
names a modality. The current UniProt `description` and source comments also
editorialize, but those strings do not become deterministic claims through
`structuredClaims.ts`. The tests inspect emitted card `title` and `snippet`, not
tool descriptions or source comments. A repository-wide lexical ban would be
stronger than the specified runtime behavior and would also reject historical
comments/tests.

## 3. What “exposes buckets” requires

SPEC §7.2 says to emit the “full tractability payload bucketed by modality” and
that the router selects buckets. It does not define a new evidence schema or the
exact `raw` shape. Current cards already retain `raw.tractability`; the present
bug is that user/model-visible text filters through `antibodyTractability`.
I therefore require both:

1. `raw.tractability` preserves every input record, including `value: false`;
2. the dedicated `#tractability` card text exposes each modality code and label.

This interpretation makes “nothing is silently dropped” observable. If the
intended contract is a newly named property such as `raw.buckets`, the spec must
name it and the test should be updated rather than guessing.

## 4. The tractability modality vocabulary is upstream-defined

Neither SPEC §7.2 nor the current Open Targets fixture defines canonical mapping
between Open Targets codes (`SM`, `AB`, `PR`, etc.) and Sonny’s
`CanonicalModality`. The test preserves and checks upstream buckets verbatim; it
does not invent a mapping. Selection for a resolved modality is separately
required by SPEC §7.2/§7.3 but its mapping contract is under-determined.

## 5. “Generic lens reached” precedes the lens slice

SPEC §10.5 and the Slice 2 checklist require an `inferModality` failure to reach
the generic lens, while Slice 3 explicitly introduces lens resolution and says
`unknown` reaches that lens. Slice 2 cannot end-to-end assert a lens module that
is scheduled for Slice 3. The test therefore asserts the Slice 2 routing
precondition: failure returns `unknown`, never throws, and `unknown` does not
enter the antibody-special-case branch. An end-to-end generic-lens assertion
belongs in Slice 3 once the normative resolver exists.

## 6. Failure rationale text is unspecified

SPEC §10.5 fixes only the fallback modality. It does not prescribe the
`rationale` string. The fallback test asserts `modality === 'unknown'` and does
not snapshot a rationale.

## 7. Claim-id encoding format and API are unspecified

SPEC §7.7 requires four components—run, `sectionKey`, round, index—but gives no
delimiter, escaping, zero/one-based convention, hash policy, run-id source, or
function signature. The test treats ids as opaque except that:

- all ids are unique across two rounds and two specialists;
- the supplied run and section identity are observably encoded;
- different rounds do not collide.

The test passes `runId` and `sectionKey` through `runResearcher`, the lifecycle
boundary that owns rounds and the specialist thread. This is a judgment call:
the spec says `ThreadBrief` eventually carries scope (SPEC §10.2), but does not
say whether Slice 2 adds these as top-level `runResearcher` options, embeds them
in `ThreadBrief`, or uses a run-scoped allocator. If the production API chooses
one of the latter designs, only the fixture wiring—not the assertions—should
change.

## 8. Gap-fill claim ids are not explicitly covered

`completeness.ts` independently calls `extractClaims`. SPEC §7.7 says “every
extraction call,” which appears to include gap fill, but the Slice 2 priority
asks specifically for extraction rounds and specialists. This suite covers the
requested collision cases and verdict attribution, not gap-fill ids. A
normative round/section identity for gap fill is needed to write that assertion
without inventing one.

## 9. Run identity source is absent

No run id exists in the current `runDeepResearch` signature, and SPEC §7.7 does
not say who creates it or whether it must be deterministic. The fixture supplies
an explicit stable run id. It does not assert UUID shape, reproducibility across
runs, or privacy properties.

## 10. Target-resolution return shape is not explicitly assigned

SPEC §4.2 requires deterministic `TargetIdentity` resolution before tool calls,
and Slice 1 already ships `ResolvedQueryScope.subjectTargets`. The current
`parseQuery.ts` instead returns `ParsedResearchQuery.target: string`. Slice 2
does not explicitly state whether that existing return property becomes a
`TargetIdentity`, whether the whole function changes to `ResolvedQueryScope`, or
whether a parallel identity property is added.

The test uses the smallest behavioral evolution of the current public seam:
`resolved.target` becomes a `TargetIdentity`. If implementation adopts
`subjectTargets[0]` to align immediately with the Slice 1 shared contract, the
access path should change but the expected identity must remain exactly
`{ kind: 'gene_or_protein', symbol: 'KRAS', targetForm: 'G12C' }`.

## 11. Deterministic parsing grammar is only exemplified once

SPEC §4.2 mandates the exact `KRAS G12C` example and a bare-symbol fast path, but
does not define grammar for lowercase symbols, multi-token protein names,
isoforms, fusions, peptide-HLA strings, or malformed variants. Tests cover only
the normative example and the requested CDCP1 regression. They deliberately do
not extrapolate a grammar.

I interpreted “deterministically” to mean the model is not called for
`KRAS G12C`, just as it is not called for bare `CDCP1`. If the intended design
allows a model call followed by deterministic normalization, SPEC §4.2 should
clarify that; “MUST happen before any tool call” alone does not strictly forbid
a model call, but “Identity resolution is deterministic” in SPEC §8.1 strongly
supports the no-model interpretation.

## 12. Which tools are symbol-keyed

SPEC §4.2 names Open Targets, HPA, GTEx, and ClinicalTrials as symbol-keyed and
says fusions yield each partner. Current `leadSeed.ts` only distinguishes Open
Targets (`symbol`) from everything else (`query`). The test proves the highest
priority case against Open Targets. It does not prescribe fan-out/deduplication
for fusions or the argument keys of HPA/GTEx tools, which are not in Slice 2’s
explicit example.

## 13. Per-field merge precedence

`SLICE2.md` §6 and the Slice 2 checklist define only one mixed case: caller
supplies modality, parsed scope supplies indication. They do not state behavior
when both sources supply the same field. Current prose in
`runDeepResearch.ts` says explicit context “always wins,” so the test preserves
that implied precedence while asserting fallback per missing field. It does not
assert how empty strings should be treated.

## 14. Roster removal: lexical value references versus type names

`SLICE2.md` §2 requires deleting the `SPECIALISTS` array, moving the `Specialist`
interface, dropping the export, and recording the API removal. The requested
test says “nothing imports the SPECIALISTS value.” The static test checks named
value imports and namespace imports from the removed module across production
TypeScript under `packages/`, `apps/`, and `eval/`. It separately checks module
deletion and the core index export. It does not ban the token in prose/comments
or unrelated identifiers, because that would exceed the requested import
invariant.

The suite does not assert changelog filename or wording because neither the
scope nor repository establishes which changelog is authoritative. That remains
a review/checklist item unless a path and expected entry are specified.

## 15. Routing-table acceptance is broader than the user’s priority list

SPEC §7.3 requires multi-target routing (`#localization` to Q1+Q2,
`#expression` to Q3a+Q6, and so on), while the suggested file list and detailed
priorities focus on neutrality, payload completeness, fallback, ids, identity,
merge, and roster removal. No `structuredClaimsRouting.test.ts` was requested.
I did not hide a routing assertion inside an unrelated file. A complete Slice 2
gate should add a dedicated routing test once the single-strategy
`sectionKey`/scope representation used by Slice 2 is made explicit; current
`structuredClaims.ts` keys only by legacy section id, while SPEC §10.2 schedules
scope propagation for Slice 3.

## 16. External suite import roots

The requested tests live outside the repository, so normal sibling imports such
as `./planner.js` are impossible. The files use absolute source imports rooted
at the explicitly supplied repository path and otherwise follow existing house
style. A harness that copies these tests into package `src/` directories should
rewrite those import paths; the assertions themselves do not depend on build
artifacts.
