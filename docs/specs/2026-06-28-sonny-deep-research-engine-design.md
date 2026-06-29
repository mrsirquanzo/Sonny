# Sonny Deep-Research Assessment Engine - Design Spec

## Context

Sonny is a grounded biomedical research agent.
Its first three build phases proved a trust core: an evidence store keyed to canonical IDs, a "no token, no ship" grounding gate, a decorrelated verifier, and a glass-box trace.
Live testing of that build against a real target (CDCP1) exposed the gap that motivates this spec: the system retrieves a handful of abstracts, restates them with hedging, and stops.
A skeptical scientist reading the output learns nothing they could not get faster from Open Targets or a Google Scholar search.

This spec defines the next thing Sonny becomes: a deep-research assessment engine.
A scientist types one target and Sonny does the job a research scientist would do before briefing leadership.
It scours the literature, patents, clinical pipeline, and competitive landscape; reads the primary material in full; loops to fill its own gaps; weighs conflicting evidence into a defensible position; teaches the reader the biology and mechanism; and ends in a recommendation.

The success bar, stated by the product owner, is concrete and testable:

> After reading Sonny's deep-dive on a target, I should be comfortable conversing with experts on that target in the field.

## Where this fits in the larger system

The full Sonny vision is a "super smart colleague" for target assessment, decomposed into five subsystems with a strict dependency order:

1. The deep-research assessment engine (this spec).
2. Synthesis, teaching, and recommendation (folded into this spec so the engine is independently testable against the bar).
3. The traceable-reasoning glass-box (built into this spec from line one; not a separable phase).
4. The conversational colleague (push back, dive deeper) - its own later spec.
5. The learning loop (curated, provenance-preserved institutional memory that compounds over time, not model weight-training) - its own later spec.

Subsystems 4 and 5 sit on top of 1.
You cannot converse about, or remember, a deep-dive the engine has not produced yet.
So the engine is built first, to the expert bar, and the rest layer onto the same foundation.

The orchestration in this spec is deliberately an extensible specialist platform.
Adding a researcher is adding a registry entry.
This is what lets the BD/Valuation specialist (market analysis plus Gosset-style rNPV and probability-adjusted valuation) and, later, the combination-drug-screening capability plug into the identical rails without re-architecting.

## Goal

Given a named target, produce an expert-level briefing - a teaching deep-dive that brings the reader up to expert-conversational depth and ends in a defensible GO / WATCH / NO-GO recommendation - with every claim grounded in primary material the reader can audit, and the entire reasoning process visible live.

## Success criteria

1. **The expert bar.** A decorrelated model, scoring the briefing against a rubric ("could a reader hold a substantive conversation with a domain expert on this target after reading this?"), rates the output as expert-conversational on a fixed target panel (CDCP1, EGFR, KRAS, and one deliberately obscure target).
2. **Grounding.** Every shipped claim cites at least one registered evidence passage; the verifier (a different model than the synthesizer) confirms each claim against the cited passage text, not merely the citation ID.
3. **Judgment.** Where sources conflict, the briefing contains an explicit reconciliation that names the tension, states which way the evidence leans, and gives the reason - rather than hedging or averaging.
4. **Traceability.** Every conclusion is traceable, after the fact, to the reasoning step and the source passage that produced it.
5. **Teaching.** A reader unfamiliar with the target can, from the briefing alone, explain what it is, its mechanism, and why it matters.
6. **Speed within reason.** A full deep-dive completes in minutes, not seconds, and the wait is legible - the reader watches the work the entire time.

## Scope

**In this build:**
- The lead-plus-specialist research orchestration (extensible platform).
- The per-specialist plan-act-read-ground-reflect-loop on full-text primary material.
- Passage-level grounding and decorrelated verification.
- Explicit cross-source weighing.
- The expert briefing (teaching narrative, conclusion-first, collapsible sections, RAG confidence, references bibliography).
- The fixed evidence drawer (extracted passage plus source metadata plus link to primary source).
- The live reasoning glass-box (parallel researcher lanes, reflection narrative, auditable after completion).
- Sources: Open Targets, Europe PMC (search plus open-access full text), a patent API, ClinicalTrials.gov v2.

**Architected but not built to depth in this build:**
- The BD/Valuation specialist. The roster, the briefing structure, and the data contracts reserve a first-class place for it; it is built to Gosset depth as the immediate next specialist on these rails.

**Out of scope (separate specs):**
- The conversational colleague.
- The learning loop / institutional memory.
- Combination-drug-screening.

## Architecture

### The platform: lead researcher plus specialist researchers

An orchestrator-worker design.

**The Lead** owns the run:
1. Resolve the target to a canonical identity (Open Targets: Ensembl ID, approved symbol and name, aliases, basic tractability and association context).
2. Decompose the assessment into research threads, one per specialist in the active roster.
3. Dispatch specialist researchers in parallel.
4. Collect thread findings.
5. Run a completeness critic over the union of findings: what critical question is unresolved, what thread came back thin, what tension between threads needs reconciling.
6. Spawn targeted gap-filler researchers for anything the critic flags, within budget.
7. Weigh findings across threads into a cross-cutting position.
8. Hand the weighed, grounded findings to synthesis, which produces the briefing and the recommendation.

**A Specialist Researcher** owns one thread.
The roster for this build:
- Target Overview & Biology
- Mechanism of Action & Pathway
- Disease Associations & Indications
- Clinical Landscape
- Competitive & IP Landscape

Reserved in the roster, built next:
- BD / Market & Valuation

The roster is a registry: each entry is a thread brief, the tools the specialist may use, and a prompt persona.
Adding a specialist is a config change, not a code change to the orchestrator.

### The specialist research loop

This is the agentic core and the reason the output reaches expert depth.
Each specialist runs a bounded loop:

1. **Plan.** From its thread brief and the resolved target, generate specific, answerable research questions (structured output).
2. **Act.** For each open question, query the specialist's sources for candidate material, composing real queries from the question - not a bare symbol restatement.
3. **Read.** Fetch the full text of the most relevant and most-cited sources, not just abstracts. Extract claims, each with a precise locator: which source, which passage.
4. **Ground.** Register each evidence passage in the shared store under its canonical ID. A claim ships only if every citation resolves to a registered passage.
5. **Reflect.** Assess what is still unknown, and whether a source just raised a new high-value question (for example, a paper that mentions an acquired-resistance mechanism the specialist should now chase). Generate follow-up questions.
6. **Loop.** Repeat Act-Read-Ground-Reflect until no high-value question remains or the specialist's research budget is spent.
7. **Emit.** Thread findings: a thread-level takeaway, the weighed claims with confidences and their evidence, and the open questions that remain.

The loop is where "Sonny is given time to do its research" becomes literal, and where the trace becomes worth watching - the reader sees a researcher hit a tension and go dig.

### The judgment layer

Weighing is explicit, not implied.
When evidence conflicts - for example, Open Targets reports a 0.11 genetic association for cancer while the mechanistic literature strongly supports an oncogenic role - the responsible researcher (or the Lead, for cross-thread tensions) must emit a reconciliation claim.
A reconciliation claim names the tension, states which way the evidence leans, and gives the reason.
This single discipline is the line between "here are some facts with confidence scores" and "here is my read."
It is what a search engine cannot do and what makes the output worth more than Google.

## Trust core

Carried forward from the existing build and upgraded for full text.

- **Evidence store.** Keyed to canonical IDs (PMID, PMCID, patent number, NCT number, Ensembl ID, disease ontology ID). Deduplicated first-write-wins. Shared across all researchers in a run, so the Lead and every specialist see one consistent evidence set with full provenance.
- **Passage-level evidence.** The evidence unit upgrades from an abstract to a passage: a source ID, a locator (section or quoted span), and the extracted text. This is what makes full-text grounding real.
- **Grounding gate.** A claim with any unresolved citation does not ship. Stripped claims are recorded, not silently dropped.
- **Decorrelated verifier.** A different model than the synthesizer checks each shipped claim against the text of its cited passage, returning supported / unsupported / overreach with a rationale. Overreach and unsupported claims are downgraded or cut.
- **RAG rating.** Each section carries a red/amber/green confidence derived from verifier outcomes and evidence breadth.

## Sources and tools

| Source | Role | Notes |
|---|---|---|
| Open Targets (v4 GraphQL) | Identity, associations, tractability, known drugs, safety liabilities | Already integrated and fixed (`drugAndClinicalCandidates`). |
| Europe PMC | Literature search and open-access full text | Provides full-text XML for the open-access subset, plus citation counts and review-article flags so researchers read the canonical papers experts cite. Replaces naive recency-ranked abstract pulls. |
| Patent API | IP landscape: claims, assignees, dates | Used by the Competitive & IP researcher for the patent read and white-space signal. |
| ClinicalTrials.gov v2 | Clinical and competitive landscape | Every asset against the target, by modality, phase, sponsor, status. |

Each researcher composes queries from its research questions.
The recency-noise failure (the naive `"CDCP1 CDCP1"` query that surfaced off-topic proteomic-panel papers) is designed out: queries are question-driven, ranked by relevance and citation signal, and oriented by review articles before drilling into primary sources.

## The briefing

The output artifact.
Conclusion-first, teaching narrative, progressive disclosure.

**Top of the page:**
- **The verdict.** GO / WATCH / NO-GO with a one-line thesis. This is the largest text on the page. The loudest thing Sonny says is its recommendation - never a trivial fact.
- **The executive read.** Three to four sentences: what the target is, why it matters, the core bull, the core bear, the call. The reader is up to speed before reading the body.

**The body** - every section collapsible, prose that builds intuition rather than bullet fragments, inline citations, a RAG confidence dot, per-section sources:
1. **Target Overview & Biology** - what the target is: gene, protein, domain architecture, normal physiology, expression. The "teach me what this is" foundation.
2. **Mechanism of Action & Pathway** - how it drives disease biology; the mechanistic model an expert holds.
3. **Disease Associations & Indications** - where it is implicated, weighed across genetics, mechanism, and clinic; the credible indication and why; honest about weak validation.
4. **Clinical Landscape** - every asset against the target, modality by modality, with phase, sponsor, status. Everything done up until now.
5. **Competitive & IP Landscape** - who is pursuing it, the patent claims and assignees, the white space.
6. **Open Questions & Controversies** - what is unresolved, what experts argue about, the resistance and safety unknowns. This is the section that makes the reader able to converse: they arrive knowing the live debates, not only the settled facts.
7. **Risk & Recommendation** - structured bull case and bear case, the factors that move probability of success, and the defensible call with its conditions. The BD Market & Valuation section slots in here next.

**References.** A real bibliography of everything read - papers, patents, trials - so the reader can jump to the primary material.

## The evidence drawer

Fixed from the failure observed in testing, where clicking a citation showed only the ID and title the reader had already seen.
The drawer now shows the actual extracted passage, the source metadata, and a link to the primary source (paper, patent, or trial).
It becomes a reason to click, not a dead end.

## The glass-box

The live reasoning surface, and a first-class requirement: traceable reasoning is the product as much as the briefing is.

**While the run is in progress**, the reader sees a reasoning stream organized by researcher in parallel lanes that converge - not a flat tool-call log and not a static "Researching…" label:
- The Lead's plan: the threads it is spinning up.
- Each researcher live: its current research question, the sources it is pulling, what it is reading, and its reflection narrative - the sentence where it notices a tension and decides to dig (for example, "the genetic association is low but the mechanistic literature is strong; I am checking whether the genetic signal is confounded by the skeletal association before I weigh it").
- Tensions surfaced and chased; the completeness critic's verdict; gap-fillers dispatched; verifier rulings.

**After the run completes**, the trace remains, collapsed but auditable: "show the research behind this section."
Every conclusion can be traced back to the reasoning step and the passage that produced it.

## Data contracts (shape, not final signatures)

- **Evidence**: `{ id, kind, source, title, locator, passage, url, retrievedAt, raw }` where `kind` covers target, publication, patent, trial, disease, drug, dataset, and `locator` plus `passage` carry the full-text provenance.
- **Claim**: `{ id, text, citations[], confidence, kind }` where `kind` distinguishes a plain claim from a reconciliation claim.
- **ThreadFindings**: `{ specialistId, takeaway, claims[], openQuestions[] }`.
- **Section**: `{ id, title, takeaway, body, claims[], sources[], rag }`.
- **Recommendation**: `{ verdict: 'go' | 'watch' | 'no-go', thesis, bull[], bear[], conditions[] }`.
- **Briefing**: `{ target, recommendation, executiveRead, sections[], references[] }`.
- **TraceEvent**: a union extended with lead-plan, researcher-question, researcher-read, researcher-reflection, tension-found, gap-filler-dispatched, completeness-verdict, plus the existing tool, evidence, claim, verdict, and section events.

## Budgets and stopping

- Each specialist has a research budget: a maximum number of reflect loops and a token ceiling.
- The Lead has a global budget across the run.
- The completeness critic may grant a specialist additional rounds when a critical gap remains, within the global budget.
- Budgets and stopping decisions are surfaced in the trace, so the reader can see why Sonny stopped where it did.
- No silent truncation: if a thread is cut short by budget, the briefing says so.

## Testing and evals

- **The expert-bar eval.** A decorrelated model scores each briefing on the fixed target panel against the expert-conversation rubric.
- **Faithfulness and recall.** The existing eval harness (citation recall, faithfulness against cited passages) runs on every briefing.
- **Grounding invariants** are unit-tested: a claim with an unresolved citation never ships; a verifier-rejected claim never appears in the briefing.
- **Tool contracts** are tested against recorded real responses (the Open Targets HTTP 400 regression, where a unit test passed while the live query failed, is the cautionary case: tool tests pin the real response shape).
- **The research loop** is tested for termination (it always halts on budget) and for gap-chasing (a reflection that raises a follow-up question results in another retrieval round).

## Build phasing within this sub-project

The implementation plan will sequence the engine so each phase is independently testable:
1. Passage-level evidence and full-text reading (Europe PMC full text; upgrade the evidence unit and grounding to passages).
2. The single specialist research loop (plan-act-read-ground-reflect-loop) proven on one thread.
3. The Lead orchestration: parallel dispatch, completeness critic, gap-fillers, cross-thread weighing.
4. The patent source and the Competitive & IP researcher.
5. Synthesis: the recommendation, the executive read, the teaching narrative.
6. The glass-box reasoning stream and the fixed evidence drawer.
7. The expert-bar eval and the fixed target panel.

The BD/Valuation specialist and the conversational and learning-loop subsystems follow as their own specs.
