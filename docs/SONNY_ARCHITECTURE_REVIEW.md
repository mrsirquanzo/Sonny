# Sonny - Architecture, Decisions, Features, and Output

A cohesive review of the grounded biomedical deep-research agent: what it is, how it is built, why it is built that way, what it does today, and what it produces.

Date of this review: 2026-06-29.
Repository: `~/code/Sonny` (git `mrsirquanzo/Sonny`).

---

## 1. What Sonny is

Sonny is a grounded biomedical deep-research agent.
Given a target (for example, `CDCP1`), it produces a PhD-level expert dossier that ends in a defensible GO / WATCH / NO-GO recommendation.

The bar it is built against: after reading the dossier, a reader should be able to hold a credible conversation with domain experts on that target.

Sonny is not a cited-database summarizer.
It is designed to behave like a scientist colleague: it scours the literature, reads primary material in full, weighs conflicting evidence into a position, teaches the reader the underlying biology, and recommends a course of action - while showing its work the entire way.

Every claim it ships is traceable to a specific piece of evidence.
Nothing reaches the dossier that is not grounded in a registered source and independently verified.

---

## 2. Guiding principles

These principles shaped nearly every decision in the codebase.

**Grounded, or it does not ship.**
A claim with no evidence token is dropped before it can reach the output.
This "no token, no ship" gate is the spine of the system.

**Decorrelated verification.**
The model that writes a claim is never the model that verifies it.
Verification runs on a different model family so a writer's blind spot is not rubber-stamped by a verifier that shares it.

**Structured output only.**
Every model call returns a schema-validated object (Zod), never free text parsed by regex.
Validation happens at the tool-call boundary, so a malformed response is retried, not silently accepted.

**Glass-box, not black-box.**
The system streams a trace of its own reasoning - every plan, search, read, claim, verdict, and reconciliation - so the work can be watched and audited as it happens.

**Retrieve like a scientist.**
A scientist starting on a new target reads a review first for the landscape, then dives into seminal and specialty papers, then compiles.
Sonny's retrieval strategy mirrors that funnel rather than guessing keywords.

**Resilience by construction.**
A single failed network call must never abort a dossier.
Transient failures retry; persistent ones are isolated into honest RED placeholders; the run always completes.

**Surgical, test-first changes.**
Every feature lands as a small, reviewed, test-driven slice.
The build is a sequence of independently shippable increments, each verified end-to-end before merge.

---

## 3. High-level architecture

Sonny is a TypeScript ESM monorepo (pnpm workspaces, Node 20+, Vitest, Zod).

| Package | Name | Responsibility |
| --- | --- | --- |
| `packages/shared` | `@sonny/shared` | Data contracts (Evidence, Claim, Verdict, Section, Recommendation, Briefing, TraceEvent). The shared vocabulary every other package speaks. |
| `packages/mcp-gateway` | `@sonny/mcp-gateway` | External data tools, each behind a uniform `Tool` interface: Open Targets, PubMed, ClinicalTrials.gov, Europe PMC search, PMC full text, Europe PMC citations. |
| `packages/core` | `@sonny/core` | The research engine: models, evidence store, research loop, lead orchestration, relevance/retrieval, synthesis, resilience. |
| `apps/cli` | `@sonny/cli` | Command-line entry. `deep <target>` runs the full pipeline and renders the conclusion-first dossier with a live trace. |
| `apps/web` | `@sonny/web` | A journal-style glass-box web front end: streams the trace over SSE, renders the cited dossier with an evidence drawer. |

### Data flow (the `deep` pipeline)

```
target
  -> seed structured evidence        (Open Targets associations/tractability, trials)
  -> orient with a review            (read a review article first; funnel step 1)
  -> dispatch 5 specialist threads   (in parallel, over one shared evidence store)
       each thread:  plan -> search -> read full text -> ground -> extract -> reflect -> loop
       each thread:  snowball forward citations from its first seminal paper (funnel step 2)
  -> completeness critic             (flag thin/red sections and unanswered questions as gaps)
  -> gap-fillers                     (targeted follow-up research per gap)
  -> cross-thread weighing           (grounded reconciliation across specialists)
  -> synthesize recommendation       (GO/WATCH/NO-GO, thesis, bull/bear, conditions)
  -> assemble references
  -> Briefing
```

Throughout, every step emits trace events to a single `emit` sink, which the CLI prints and the web app streams.

---

## 4. Core subsystems

### 4.1 Evidence store (`evidenceStore.ts`)

A registry keyed by canonical id (for example `PMID:23208492`, `ENSG00000163814`, `PMCID:PMC1#sec-0`).
Registration is idempotent by id, so the same paper found by two threads is stored once.
It is the single shared substrate: all specialists, gap-fillers, orientation, and snowball write into one store, and claim extraction reads from it.

### 4.2 Models (`model.ts`, `ollamaModel.ts`)

A single `StructuredModel` interface: `generateStructured<T>({ system, prompt, schema, model })`.

Two backends implement it:
- `OllamaModel` posts to Ollama's `/api/chat` with the Zod schema as the response `format`, parses, and re-validates.
- `AnthropicModel` uses tool-use forcing to guarantee a schema-shaped response.

A role router maps four roles to concrete models, per backend:

| Role | Ollama (default) | Anthropic (demo) |
| --- | --- | --- |
| planner | qwen2.5:14b | claude-opus-4-8 |
| specialist | qwen2.5:14b | claude-opus-4-8 |
| verifier | llama3.1:8b | claude-sonnet-4-6 |
| writer | qwen2.5:14b | claude-opus-4-8 |

The default backend is Ollama (free, local) for building and optimization; Anthropic is selected only when `SONNY_BACKEND=anthropic` for a high-fidelity demo.
The verifier is deliberately a different model family from the specialist on both backends (llama vs qwen; sonnet vs opus) to keep verification decorrelated.

### 4.3 Tools (`mcp-gateway`)

Every external source is a `Tool` with `call(args, fetchImpl = fetch) => Promise<Evidence[]>`, throwing on non-OK HTTP so callers can isolate failures.

| Tool | Source | Role |
| --- | --- | --- |
| `open_targets_target` | Open Targets GraphQL v4 | Target record, disease associations, tractability, clinical candidates, symbol/name synonyms. |
| `europepmc_search` | Europe PMC | Literature search, citation-ranked, abstract as passage, review flag, PMC id. |
| `pmc_fulltext` | NCBI PMC efetch | Full-text body sections (JATS) as grounded passages. |
| `europepmc_citations` | Europe PMC | Forward citations of a paper (who cites it), for snowball expansion. |
| `clinical_trials_search` | ClinicalTrials.gov v2 | Trials by target, canonical NCT ids. |
| `pubmed` | PubMed | Canonical PMID normalization (early-foundation tool). |

### 4.4 The research loop (`researcher.ts`)

Each specialist runs a bounded plan-act-read-ground-reflect loop:

1. **Plan** research questions, each with one short `concept` (1-2 words).
2. **Search** Europe PMC with a broad, target-pinned query.
3. **Deep-read** the top open-access paper whose title names the target (full text).
4. **Snowball** once per thread from that first seminal paper (forward citations).
5. **Extract** claims, each citing the evidence ids it rests on, from the shared store.
6. **Reflect** on gaps and either finish or queue up to three follow-ups.
7. Loop until done or the round budget is exhausted.

### 4.5 Lead orchestration (`runDeepResearch.ts`, `completeness.ts`, `weighing.ts`)

A lead orchestrator seeds structured evidence once, orients with a review, then dispatches five specialist threads in parallel over the shared store (orchestrator-worker pattern).
The five specialists are a fixed roster:

- Target Biology
- Mechanism of Action & Pathway
- Disease & Indications
- Clinical Landscape
- Competitive & IP Landscape

After the threads complete, a **completeness critic** flags thin or RED sections and obvious unanswered questions as gaps; **gap-fillers** run targeted follow-up research for each; and **cross-thread weighing** produces grounded reconciliation claims where specialists' findings interact (for example, mechanism strength reconciled with clinical prognosis).

### 4.6 Grounding and verification (`grounding.ts`, `verifier.ts`, `rag.ts`)

- **Grounding gate**: a drafted claim with no evidence token in the store is dropped ("no token, no ship").
- **Verifier**: each surviving claim is checked, one call per claim, against its cited evidence by the decorrelated verifier model; status is `supported`, `unsupported`, or `overreach`.
- **RAG rating**: each section gets a red/amber/green rating from the verdicts and the breadth of supporting evidence.

### 4.7 Synthesis and briefing (`synthesize.ts`, `briefing.ts`)

The writer model reads only verified claims and produces a `Recommendation`: a GO/WATCH/NO-GO verdict, a one-line thesis, an executive read, a bull case, a bear case, and conditions.
Phantom citations (any id not in the run's evidence) are dropped.
References are assembled from the cited evidence, and the whole is packaged into a conclusion-first `Briefing`.

### 4.8 Resilience (`safeToolCall.ts`)

`safeToolCall` retries transient failures (HTTP 5xx/429, network resets) with backoff, isolates persistent failures, emits an error trace, and returns `[]` rather than throwing.
Specialist failures become RED placeholder sections via `Promise.allSettled`.
Completeness, gap-fill, and weighing are each wrapped so any one can fail without aborting the dossier.
The run always completes and never silently truncates.

### 4.9 Relevance and retrieval (`relevance.ts`, `searchQuery.ts`, `orientation.ts`, `snowball.ts`)

This is where most recent investment went, because retrieval quality is what separates a thin summary from an expert dossier.

- **Target terms** (`targetTerms`): the lowercased target symbol plus its Open Targets synonyms (for CDCP1: CD318, TRASK, SIMA135).
- **Relevance gate** (`relevanceGate`): drop any hit that does not mention the target in title/abstract/snippet.
- **Title gate** (`titleMentionsTarget`): a paper is only deep-read when its title names the target - the strict precision lever.
- **Broad query builder** (`buildSearchQuery`): `TITLE_ABS:<target> AND <concept>` - two terms, target pinned to the title/abstract field.
- **Review query** (`buildReviewQuery`): `TITLE_ABS:<target> AND PUB_TYPE:"review"` - finds actual review articles for orientation.
- **Orientation** (`orientWithReview`): read a review first, seed its landscape into the shared store before specialists run.
- **Snowball** (`snowballCitations`): follow a seed paper's forward citations one hop, title-gate them, hydrate the top three to full records, register.

---

## 5. Data contracts (`@sonny/shared`)

The shared vocabulary, all Zod-validated.

- **Evidence**: `{ id, kind, source, title, snippet, passage?, locator?, url, raw, retrievedAt }`.
  `kind` is one of `target | publication | trial | patent | dataset | disease | drug`.
- **Claim**: a statement with `citations` (evidence ids) and a confidence in [0,1].
- **Verdict**: `{ claimId, status: supported | unsupported | overreach, rationale }`.
- **Section**: `{ id, title, takeaway, claims, sources, rag: green | amber | red }`.
- **Recommendation**: `{ verdict: go | watch | no-go, thesis, executiveRead, bull[], bear[], conditions[] }`.
- **Reference**: `{ id, kind, title, url }`.
- **Briefing**: the assembled conclusion-first output (recommendation + sections + weighing + references).
- **TraceEvent**: a discriminated union covering the full glass-box stream - `plan`, `tool_call`, `tool_result`, `evidence_registered`, `claim_drafted`, `verdict`, `section_complete`, `research_plan`, `research_read`, `research_reflect`, `lead_decompose`, `completeness_verdict`, `gap_filler`, `recommendation`, `error`, and more.

---

## 6. Key design decisions and the reasoning

**Why grounded with a hard gate, not prompt-instructed grounding.**
Instructing a model to "only state what the evidence supports" is unreliable.
A structural gate that drops ungrounded claims before output is verifiable and cannot be talked around.

**Why a decorrelated, different-family verifier.**
A verifier that shares the writer's training and biases will confirm the writer's mistakes.
Using a different model family (llama checking qwen; sonnet checking opus) gives genuine independent judgment.

**Why local Ollama by default.**
Iterating on retrieval and orchestration is high-volume.
Running the default loop on free local models avoids racking up API cost during the build, reserving the paid high-fidelity models for demos.
A compromised, out-of-credits Anthropic key early in the project reinforced this separation.

**Why the orchestrator-worker (lead + specialists) shape.**
A single agent cannot hold an expert dossier's breadth in one context.
Decomposing into five well-bounded specialist threads over a shared store gives depth per angle while keeping each thread's context focused.

**Why structural retrieval fixes, not prompt tuning.**
When off-topic papers flooded the dossier, the durable fix was a relevance gate and field-pinned queries, not coaxing the planner with better wording.
This was an explicit, repeated preference: structural fixes over prompt-only tuning.

**Why broad two-term queries plus TITLE_ABS pinning.**
Multi-keyword queries AND-chain to zero results in Europe PMC.
Broad `target AND concept` fixes that, but Europe PMC matches full text and ranks by citations, so famous reviews that merely cite the target flooded the top results and were then correctly dropped by the gate - leaving zero.
Pinning the target to the title/abstract field (`TITLE_ABS:`) aligns the API with the gate, so the search returns papers actually about the target.
This two-part fix was found by reproducing the failure end-to-end against the live API, not by reasoning in the abstract.

**Why retrieve like a scientist (review-first, then snowball).**
A review gives the landscape before depth is spent on specifics; snowballing along citations reaches related work and specialty labs that keyword search misses.
Encoding the scientist's actual funnel produces broader, better-grounded dossiers than keyword threads alone.

**Why bounded snowball (one hop, top-3, once per thread).**
Unbounded citation following explodes combinatorially.
One hop from each thread's first seminal paper, capped at three hydrated neighbors, gives breadth without runaway API cost or recursion.

---

## 7. The build journey (slice by slice)

Sonny was built as a sequence of small, test-driven, independently reviewed slices.
Each is brainstormed into a spec, written into a plan, executed by fresh subagents with a review gate per task, and validated end-to-end before merge.

**Foundation.**
Shared contracts; canonical-id evidence store; the StructuredModel interface and Anthropic backend; the first tools (Open Targets, PubMed) with canonical id normalization; the grounding gate; the decorrelated verifier; an orchestrator with fan-out; a CLI with trace output; an eval harness (recall@k, faithfulness); and a web glass-box scaffold with SSE streaming.

**Multi-specialist dossier.**
Section/RAG contracts; a rich Open Targets tool (associations, tractability, drugs, safety); ClinicalTrials.gov; RAG rating from verdicts and breadth; a specialist registry with dynamic selection; per-section production; and a multi-specialist orchestrator over a shared store, rendered in both CLI and web.

**Deep research loop.**
Passage-level evidence (the verifier reads full-text passages, not just abstracts); Europe PMC search and PMC full-text tools; research-loop trace events; and the bounded plan-read-extract-reflect researcher.

**Lead orchestration.**
The five-specialist research roster; structured seeding into the shared store; parallel dispatch; a completeness critic; gap-fillers; and cross-thread weighing.

**Synthesis and recommendation.**
Briefing contracts; surfacing run evidence; synthesizing a GO/WATCH/NO-GO recommendation with bull/bear and an executive read from verified claims only; reference assembly; and a conclusion-first CLI render.

**Local backend.**
An Ollama structured-output model; a backend-aware router with Ollama as default and a cross-family verifier (llama3.1:8b); CLI wiring.

**Resilience.**
`safeToolCall` with retry/isolate; the research loop, gap-filler, and lead all made failure-tolerant; failing specialists isolated into RED placeholders so the run always completes.

**Retrieval relevance.**
Open Targets synonyms on the target record; `targetTerms` + `relevanceGate`; gating the research loop and the gap-filler; anchoring planner and critic prompts to the named target.

**Passage-level relevance.**
`mentionsAny` + `titleMentionsTarget`; title-gated deep-read selection (only deep-read a paper whose title names the target); and passage-gating of full-text sections.

**Broad-query recall.**
`buildSearchQuery`; the planner emitting a single concept; searching `target AND concept`; the gap-filler doing the same; and pinning the target to `TITLE_ABS` so the broad search returns on-target papers.

**fillGap gating.**
Closing the last ungated deep-read path - the gap-filler now title-gates and passage-gates exactly like the main loop.

**Review-first orientation.**
`buildReviewQuery` and `orientWithReview` - read a review on the target first and seed its landscape into the shared store before any specialist runs.

**Citation snowball.**
The `europepmc_citations` tool and `snowballCitations` - each thread follows its first seminal paper's forward citations one hop, title-gating and hydrating the top three neighbors.

---

## 8. Current feature set

- One-command deep research: `deep <target>` produces a full cited dossier.
- Structured seeding from Open Targets (associations, tractability, clinical candidates, synonyms) and ClinicalTrials.gov.
- Review-first orientation: reads an actual review article before specializing.
- Five parallel specialist threads over one shared, deduplicated evidence store.
- Bounded per-thread plan-read-extract-reflect loops with full-text deep reads.
- Citation snowball expansion from each thread's first seminal paper.
- A relevance regime that keeps retrieval on-target at three levels: search-hit gate, title-gated deep-read, and passage-level gate.
- Broad, target-pinned `TITLE_ABS` queries that actually return on-target literature.
- Completeness critique and targeted gap-filling.
- Cross-thread weighing into grounded reconciliation claims.
- Grounding gate plus a decorrelated, different-family verifier on every claim.
- RAG (red/amber/green) ratings per section.
- A conclusion-first recommendation: GO/WATCH/NO-GO, thesis, executive read, bull/bear, conditions, references.
- Full glass-box trace, streamed to CLI and to a journal-style web UI with an evidence drawer.
- Resilience throughout: the run always completes, with honest RED placeholders for failures and no silent truncation.
- Local-first (free Ollama) by default; high-fidelity Anthropic backend on demand.

---

## 9. Output - the dossier

`deep CDCP1` (local Ollama backend) currently produces a conclusion-first dossier of this shape:

```
=== GO: CDCP1 is a promising therapeutic target for various cancers due to its
        critical role in cell adhesion, anoikis resistance, and metastasis. ===

<executive read - one paragraph, cited>

[GREEN] Target Biology
  <one-line takeaway>
  - <claim> [PMID:...] [PMID:...]
  ...
[GREEN] Mechanism of Action & Pathway
[GREEN] Disease & Indications
[AMBER] Clinical Landscape
[GREEN] Competitive & IP Landscape

CROSS-THREAD WEIGHING
  <reconciliation takeaway>
  - <reconciliation claim> [PMID:...]

BULL CASE
  + <point> [PMID:...]
BEAR CASE
  - <point> [PMCID:...#sec-...]
CONDITIONS
  * <what would change the call>

REFERENCES (15)
  PMID:11466621  Identification of a novel gene, CDCP1, overexpressed in human colorectal cancer  <url>
  ...
```

A representative recent run on CDCP1 returned a GO verdict with four GREEN sections and one AMBER, grounded in the canonical CDCP1 literature - the original gene-identification paper (PMID:11466621), the SIMA135/CDCP1 discovery (PMID:12660814), cleaved-CDCP1 dissemination via FAK/PI3K/Akt (PMID:23208492), anoikis resistance (PMID:17785447), Src activation (PMID:25728678), and TNBC fatty-acid-oxidation metastasis (PMID:28739932), with 15 verified references.

Before the retrieval work, the same target produced an all-RED, zero-reference dossier.
The difference is entirely in retrieval quality: broad target-pinned queries, review-first orientation, citation snowball, and the three-level relevance regime.

The web front end renders the same content as a journal-style document: a streamed reasoning trace, the cited dossier with RAG dots and a contents rail, and an evidence drawer that opens the underlying source behind any citation.

---

## 10. Known limitations and next work

- **Snowball seed diversity.** Threads sometimes converge on the same open-access seed; if that seed is tangential to the target's core (for example, an m6A-axis paper), its citers are title-gated out and the snowball yields little. A small tuning pass would diversify seeds across threads.
- **Specialty-lab / modality-expert detection.** Funnel step 3 - detecting recurring authors/labs and modality experts - is designed but not yet built.
- **Confidence clamp.** The cross-thread weighing step can receive a local-model confidence above 1.0 and throw a schema error (caught, but the weighing is lost that run); a small clamp at the claim boundary is pending.
- **Concept-quality recall gaps.** When the planner emits an awkward concept (for example, an underscored `clinical_trials`), that one query returns zero; broad coverage from neighboring concepts compensates, but concept hygiene could be tightened.
- **Backward references and multi-hop snowball.** Only forward citations, one hop, are implemented.
- **Patent / IP and BD valuation specialists.** A separate patent/IP specialist workstream (PDF to BLAST to ANARCI sequence analysis) is planned in a sibling worktree; a BD/valuation angle remains on the roadmap.
- **Shared-repo hazard.** A parallel worktree sharing this git repository has twice disturbed in-flight branches (once leaking a commit, once resetting main and dropping the orientation slice, since recovered). The workflow needs isolation so concurrent agents do not operate on shared branches.

---

## 11. Engineering practices

- **Test-driven, every slice.** Failing test first, minimal implementation, passing test, commit. The suite currently stands at 133 tests across six packages.
- **Subagent-driven development.** Each task is executed by a fresh subagent with curated context, gated by a per-task spec-and-quality review, with a broad whole-branch review before merge.
- **Brainstorm to spec to plan to execute.** Every feature is designed (spec), planned in bite-sized tasks (plan), then built - all three artifacts are committed under `docs/specs` and `docs/plans`.
- **Branch, review, merge.** Work happens on feature branches; merges to main go through a reviewed PR.
- **Reproduce end-to-end first.** Retrieval and behavior bugs are reproduced against the real APIs and a live local smoke before they are fixed, which is how the TITLE_ABS and orientation issues were correctly diagnosed.

---

*This document reflects the state of `~/code/Sonny` as of 2026-06-29, after the citation-snowball slice and the orientation recovery.*
