# Slice 3 ambiguities and test judgments

This report distinguishes requirements that are normative from interface or
orchestration details that Draft 5.6 leaves open. The tests intentionally do
not redefine any shared contract.

## 1. The modality-lens module has no specified public API

SPEC §6 requires `packages/core/src/modalityLens.ts`, layered resolution, exact
content, and provenance fields, but does not name exports, prescribe a resolver
signature, or prescribe its returned object. `SLICE3.md` is likewise silent.

Judgment: `modalityLens.test.ts` accepts either `resolveModalityLens` or
`resolveLens`, and normalizes the obvious field spellings before asserting the
normative result. This avoids turning an incidental function name into a
requirement. An implementation with a different API will need a trivial adapter
or a deliberate test edit; its scientific behavior should remain identical.

## 2. “Common lens” content is only implicit

SPEC §6 says composition is “common lens + modality lens + subtype overlay +
therapeutic-action overlay,” but only labels the `unknown` table as
“generic (fallback).” It does not separately enumerate a common layer, say
whether generic *is* the common layer, or define which generic entries are
common to every modality.

Judgment: tests use the least speculative examples: `target engagement` for Q2
and `on-target safety` for Q6 must survive in a resolved monoclonal-antibody
lens, alongside antibody-specific entries. These express common + modality
composition without requiring all generic fallback items to appear for every
modality.

This is still a normative gap. The spec should publish `COMMON_Q2_LENS` and
`COMMON_Q6_LENS` verbatim, or explicitly state that all generic fallback items
are the common layer.

## 3. Subtype and therapeutic-action overlay vocabulary is not defined

SPEC §6 lists future-worthy subtype examples but says not every subtype is
required initially. It provides neither subtype/action keys nor overlay text.
Consequently it is impossible to assert the scientific content of a particular
overlay from the spec alone.

Judgment: the test passes `subtype: "antagonist"` and asserts only the invariant
that an overlay is additive/narrowing and cannot erase or duplicate the common
and modality layers. If the implementation deliberately ships no initial
overlay, returning the unchanged base satisfies that invariant. No invented
overlay wording is asserted.

“Narrow rather than replaces” in the user request could also mean an overlay
may remove inapplicable base items. That conflicts with a literal additive
layer model. The suite interprets it as retaining the base while adding more
specific guidance. The spec should define merge semantics, ordering, and
deduplication.

## 4. Canonicalization from free-form modality is unspecified here

SPEC §4.1 fixes 16 canonical keys, and §6 keys the table by them, but slice 3
does not define how strings such as `small molecule`, `ADC`, `CAR-T`, or an
unknown phrase map to `CanonicalModality`. Current `ResearchContext.modality`
is a free-form string and `inferModality` also returns a string.

Judgment: direct lens tests pass canonical keys. Pipeline tests pass canonical
keys as well. They do not invent a synonym map. A production implementation
still needs a deterministic boundary that maps free text to a canonical key;
otherwise lens selection is not reproducible.

## 5. Strategy creation/resolution before `composeRoster` is not assigned

SPEC §3 says `composeRoster` injects resolved strategy context. `SLICE3.md` says
to propagate one strategy. Current `composeRoster` accepts only
`ResearchContext { indication?, modality? }`; `runDeepResearch` accepts no
strategy or nomination. The slice says model calls remain for “strategy
inference” and “strategy nomination,” but gives no slice-3 function, schema,
fallback, or caller precedence rule.

Judgment: scope tests place one `TherapeuticStrategy` in the existing context
object (with a narrow test-only cast), expecting `composeRoster` to consume it.
This is an orchestration seam, not a claim that `ResearchContext.strategy` is
the required final API. An equally valid implementation could add a top-level
`strategy` argument; the fixture should then be moved there without changing
any invariant assertion.

This is especially important for `unknown`: a strategy scope requires a real
fingerprint even when modality inference fails. The spec does not define the
single-strategy fallback from which that fingerprint is derived.

## 6. How `SpecialistExecutionContext` reaches retrieval is under-specified

SPEC §5.1 says the context is the *single* object threaded through
`ThreadBrief`, retrieval, conclusion drafting, and section construction.
`SLICE3.md` repeats “through ThreadBrief, retrieval, and section construction.”
Current retrieval APIs receive only `specialist`, target/question/concept,
terms, and model; `buildSearchQuery` receives target and concept. No normative
signature says whether retrieval receives:

- the entire `SpecialistExecutionContext`;
- a derived retrieval scope;
- strategy engagements and modality only;
- or merely prompts already conditioned upstream.

Nor does the spec define a trace/audit observation by which a test can prove
the context reached the tool boundary.

Judgment: the suite strongly asserts that each `ThreadBrief` carries the
context and matching scope, and that section construction preserves it. It
does not claim that prompt text alone proves retrieval propagation. A rigorous
retrieval test needs a specified observable contract, preferably
`retrieveResearchHits({ context })` plus a query/audit assertion. Merely putting
lens terms in the question-generation prompt is insufficient: query rewriting,
reranking, and tool calls could still lose strategy identity.

## 7. Q3 scope in a single-strategy run is not uniquely determined

SPEC §2 permits both `shared` and `strategy` for `disease_indications`.
SPEC §10.2 says Q3b is strategy-scoped and the synthesized comparative Q3 output
is shared; §5.1 says Q3a is shared. `SLICE3.md` says “Q3 -> shared or strategy”
and multi-variant fan-out is out of scope.

Judgment: tests accept either legal Q3 scope and do not force one. They do
require execution-context kind and emitted-section scope kind to agree. A later
pipeline contract should decide whether slice-3's one emitted Q3 is Q3a, Q3b,
or an interim combined artifact.

## 8. “Per run” versus “per strategy variant” provenance wording conflicts

`SLICE3.md` says record provenance “per-run.” SPEC §6 normatively says
provenance is “per strategy variant, not per run” and defines
`resolvedStrategyLenses: Array<...>`. For a single-strategy run these collapse
to one array element, but the ownership distinction matters for the API.

Judgment: tests follow the authoritative SPEC shape: one
`resolvedStrategyLenses` entry for the single strategy, with no variant label.

## 9. The trace-event contract has not yet been updated

SPEC §3 retains `plan_composed` as the deterministic axes-and-lens audit record,
but the merged shared `TraceEvent` currently permits only modality,
specialists, and rationale. SPEC §6 defines run provenance but does not
explicitly say whether it is stored on `plan_composed`, `DeepResearchResult`,
run metadata, or all three.

Judgment: `lensProvenance.test.ts` expects `resolvedStrategyLenses` on
`plan_composed`, because that is the only slice-3 record explicitly retained
for axes and lens. If provenance instead belongs on `DeepResearchResult`, the
same assertions should move there. The spec should fix the storage location
and update the trace schema.

## 10. “Only Q2 and Q6 read the lens” versus modality-aware Q3/Q4/Q5

SPEC §2's influence table says Q3 has a lightweight modality overlay and Q4/Q5
receive strategy context, while SPEC §6 says only Q2 and Q6 read the lens.

Judgment: tests forbid verbatim Q2/Q6 lens items in Q1/Q3/Q4/Q5; they do not
forbid ordinary modality/strategy context there. This preserves both rules.

## 11. Byte-identical scope

SPEC §3 says two runs produce byte-identical rubrics. It does not define
serialization/canonicalization or whether trace timestamps and strategy
provenance are part of “rubric.”

Judgment: tests compare `JSON.stringify` of the returned roster and the
`plan_composed` event for identical inputs. JavaScript insertion order is
deterministic for code-authored objects and catches reordered arrays/fields in
practice. This does not claim canonical JSON equivalence for arbitrary objects.

## 12. Section construction and the conclusion lifecycle

Slice 1's `ResearchSectionV2Schema` requires a conclusion, while slice 3 only
scopes “section construction”; conclusion drafting is described elsewhere and
may be scheduled for a later slice. Current `produceResearchSection` emits a
legacy-shaped section.

Judgment: end-to-end scope tests use `maxRounds: 0` to isolate construction and
assert scope legality, not conclusion behavior. If the implementation already
emits V2 sections, it may need a deterministic insufficient-evidence conclusion
on this zero-evidence path. The test deliberately does not assert its content.

## 13. Exact-copy versus semantic lens wording

SPEC §6 says the lens table is a knowledge asset to carry over verbatim. The
suite therefore asserts exact representative items and requires all resolved
items to appear in Q2/Q6 prompt material. This is intentionally stricter than
keyword matching. Capitalization in surrounding prompt text is ignored, but
the lens item wording itself must survive.

The KRAS regression request says “ADME,” while the table does not contain that
acronym; it enumerates oral bioavailability, metabolic instability, exposure,
DDI, formulation, and related liabilities. The test asserts those normative
items rather than requiring the literal token `ADME`.

## 14. American/British spelling in the requested negative control

The table uses American `internalization` for ADC and the request uses
`internalization`; existing roster copy sometimes uses British
`internalisation`.

Judgment: negative and positive regression checks cover both spellings so a
spelling choice cannot evade the behavioral guard.
