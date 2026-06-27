# Sonny v2 — Design Spec

**Date:** 2026-06-27
**Status:** Draft for review
**Supersedes/extends:** `SONNY_V2_DESIGN_WIP.md` (this is the formalized design)
**Companion notes:** `SONNY_PUBLIC_READINESS_AUDIT.md` (old-Sonny audit), vault `[[Kun Chen Agentic Workflow applied to Sonny]]`, `[[Sonny v2 output spec]]`
**Reference output target:** Gosset AI asset-valuation report (`~/Downloads/Tegoprubart Asset Valuation.pdf`)

---

## 1. Goal & scope

Build **Sonny v2**: a credible, production-grade, **grounded** multi-agent biomedical due-diligence agent that scientists and BD/investment teams trust. The differentiator is not the model — it's that **Sonny can't assert what it can't cite, and it proves each citation resolves and supports the claim.**

**Primary output:** a structured, multi-section **asset dossier** matching (or beating) the Gosset reference — rendered interactively on the web, delivered through Slack, and exportable to PDF.

**Demo centerpieces:** (1) the grounded multi-agent due-diligence dossier; (2) patent-sequence extraction.

**Positioning (decided 2026-06-27):** built the way a serious AI engineer would build a **production biomedical R&D agent** — comprehensive, deployable, and grounded — independent of any specific company or deployment target. The bar is "a system a real R&D organization could put into production," not a pretty-UI demo. **GraphRAG (§11) and the production-readiness scaffolding (§12) are core, not optional.** Senior-judgment rule: *"production-ready" = the production engineering concerns are first-class + ONE fully-working end-to-end vertical slice — not breadth of half-built features* (breadth reads as less serious).

**Phasing (decided):**
- **Phase 1 — Grounded vertical slice through the FULL stack:** gateway → evidence store → **graph ingestion** → grounding → verifier → **GraphRAG multi-hop query** → dossier → glass-box, on **one therapeutic area** (e.g. EGFR/NSCLC or CD40L/transplant). Evidence-dossier sections (Disease, MoA, Clinical Evidence, Endpoints, Nonclinical/Safety, Competitive Landscape, IP, POS) + core production scaffolding (evals, observability, governance, audit trail).
- **Phase 2 — Broaden** specialists/sections + financial/valuation modeling (rNPV/DCF/reverse-DCF/comps, computed-not-retrieved → transparent grounded assumptions); deepen the knowledge graph.
- **Phase 3 — Slack app**; patent-sequence killer feature broadened; multi-tenant hardening.

**Timeline:** date flexible — optimize for a correct, deployable v2.

**Build strategy:** greenfield monorepo, **vertical-slice first** — the slice goes through *every* layer (incl. the graph) on one therapeutic area before broadening. Breadth lives in the architecture (§2–§12) and the deployment narrative (§12), not in many half-built features.

---

## 2. Architecture

Greenfield **pnpm monorepo** (TypeScript, Node 20+, MIT):

```
sonny/
├─ packages/
│  ├─ mcp-gateway/    MCP *client* composing best-in-class external servers
│  │                  (official Open Targets MCP, a BLAST MCP, a PubMed/trials
│  │                  server) + a per-source normalizer to canonical records.
│  ├─ mcp-patentseq/  the one CUSTOM MCP server we build: the patent-sequence
│  │                  retrieval ladder (Lens PatSeq → USPTO PSIPS → OCR fallback).
│  ├─ core/           the trust engine (no UI/harness deps): evidence store ·
│  │                  grounding · verification · orchestrator (self-hosted loop) ·
│  │                  ModelRouter.
│  ├─ graph/          grounded knowledge graph (§11): ingestion of verified
│  │                  entities/edges by canonical ID + GraphRAG multi-hop query.
│  │                  Provenance-preserving, tenant-scoped.
│  ├─ skills/         workflow recipes (SKILL.md): target-dossier, due-diligence,
│  │                  patent-sequence — progressive disclosure.
│  └─ shared/         types, Zod schemas, prompt templates, design tokens.
├─ apps/
│  └─ web/            Next.js glass-box dossier (the UI).
│                     (apps/slack — Phase 3)
```

Two load-bearing properties: **`mcp-patentseq` (and the gateway) is independently installable** in Claude Desktop (credibility flex), and **`core` has no UI/harness dependency** (testable in isolation; Slack app reuses it untouched; harness-agnostic per Kun Chen Level 1).

**Decision — compose, don't reinvent:** Sonny is a real MCP *client/orchestrator* that composes existing real MCP servers and builds custom servers only for genuine gaps (patent-sequence). All originality lives in the trust layer.

**Orchestration substrate (decided):** self-hosted loop — our own TS orchestrator using the Anthropic SDK tool runner, with grounding + verification as visible custom code, streaming a glass-box trace over SSE, supporting interrupt/steer. (Isolated behind an interface so Managed Agents remains a future swap for Slack multi-tenancy.)

### Query lifecycle
1. Scientist asks (web glass-box / Slack / Claude Desktop).
2. **Planner (Lead Investigator)** selects which specialists/tools the query needs and emits a visible plan (dynamic selection; shows skipped + why).
3. **Specialist(s)** run: reason → call gateway tools → tools return canonical records → records register in the **evidence store** by ID.
4. **Grounding gate:** every factual claim must carry ≥1 citation to an evidence-store ID ("no token, no ship").
5. **Verification pass:** a decorrelated model checks each claim resolves + is supported → verdict supported/unsupported/overreach.
6. **Synthesis:** assembles only verified, cited claims into the dossier sections.
7. The glass-box renders the live trace; scientist can interrupt to steer.

---

## 3. Trust core (`packages/core`)

**1. Orchestrator (self-hosted loop).** Plans, drives tool calls via the SDK tool runner against `mcp-gateway`, streams the trace, supports steer. Owns control flow, not truth.

**2. Evidence store — single source of truth for what was retrieved.** Every tool result → an `Evidence` record keyed by canonical ID:
```ts
Evidence = { id: "PMID:..." | "NCT..." | "ENSG..." | "US...B2",
             kind, source, title, snippet, url, raw, retrievedAt }
```
Append-only per session. **A citation is a key into this store.** Empty results register nothing (never fabricated).

**3. Grounding gate — "no token, no ship."** Specialists return a Zod-validated structured contract (SDK structured-output mode, not regex):
```ts
Claim = { id, text, citations: EvidenceId[], confidence }
```
Every factual claim needs ≥1 resolving citation; uncited claims are stripped/flagged. Schema → validate → one retry.

**4. Verification pass — the novel capability.** A **decorrelated model** (deliberately different from the synthesizer) checks each claim against its cited records: does the ID *resolve*, and does the record *support* the claim? →
```ts
Verdict = { claimId, status: "supported" | "unsupported" | "overreach", rationale, evidenceId }
```
This is "adversarial review in a fresh context window" (Kun Chen) operationalized as the runtime faithfulness check. **Risk-based attention:** single-pass verify on low-risk claims; **N-sample self-consistency (majority vote) only on high-risk claims** (headline determinations, figures) — a cost lever.

**5. Synthesis.** Assembles verified, cited claims into dossier sections, carrying verdicts forward for the UI's "agent edits" view.

**Cross-cutting:** indirect-prompt-injection defense (external tool/PDF text delimited + labeled data-not-instructions); everything streams as a single `TraceEvent` discriminated union (`plan | tool_call | tool_result | evidence_registered | claim_drafted | verdict | synthesis | error | awaiting_steer`) — the trace is the contract between core and UI.

---

## 4. Retrieval & model routing

### Two paths, one evidence store
- **Path 1 — API-grounding (primary).** Gateway composes external MCP servers; a **normalizer** maps each server's records to canonical `Evidence` + extracts canonical IDs. No vector DB — the APIs are the retriever, the ID is the citation.
- **Path 2 — doc-RAG (uploads + patent OCR only).** Structure-aware chunking (split on sections/claims), **hybrid search (BM25 + vector + RRF)** for exact identifiers, **cross-encoder rerank** (top-50→5), MMR for diversity, metadata filtering. Chunks become `Evidence` (`DOC:<hash>#chunk-N`) → citations uniform across sources.
- **Reranking also applies to Path 1** (e.g., 50 PubMed hits → 5) to keep context tight.

### Tool ergonomics (Kun Chen — sharpening)
MCP is **not** automatically efficient: a GitHub MCP server ≈ 3× tokens / >2× latency vs the `gh` CLI; lean output formats save ~40% over JSON. Therefore:
- The gateway **normalizes every tool result to a token-lean canonical record** (never passes through verbose MCP JSON).
- **Benchmark each composed server's efficiency** (token cost, latency, canonical-ID fidelity); replace any token-heavy MCP with a thin REST/CLI wrapper where it wins.
- **Vet composed servers on our own benchmark, not GitHub stars** (also a security posture — external servers can exfiltrate keys).

### ModelRouter (per-role heterogeneity, config-driven)
| Role | Model |
|---|---|
| Planner / Lead Investigator | Opus 4.8 (Fable 5 for max) |
| Query agents (per source) | Haiku 4.5 / local Qwen |
| Extraction & normalization | cheapest/local (Qwen-7B, Llama-3.1-8B via Ollama) |
| Domain specialists | Sonnet 4.6 / Opus 4.8 |
| **Verifier** | a **different** model than the synthesizer (pluggable alt-vendor slot) |
| Writer / assembler | Sonnet 4.6 / Haiku |

**Cost levers:** right-size per role, rerank to shrink k, prompt-cache system prompt + tool defs, semantic-cache repeated queries, real per-call usage accounting → real cost shown by role.

---

## 5. Output: the dossier

The structured artifact `core` emits, rendered to all surfaces.

**Section template (each section):** title + **one-line takeaway** + content (narrative + tables) + **RAG assessment** (No major issues / Potential risks / Major issues) + **per-section sources**.

**Section set:** Snapshot · Disease & Positioning · Mechanism of Action · Clinical Evidence · Endpoints · Nonclinical & Safety · Competitive Landscape · Probability of Success · *(Phase 2:* Commercial Model · Pricing · Financial Model · Implied Expectations · Comparable Transactions · Valuation*)* · Indication Expansion · Summary · Value Inflections · References · Glossary · Disclaimer.

**Sections → specialists:** Target Biology (Disease/MoA/Positioning) · Clinical (Clinical Evidence/Endpoints/Safety/POS) · Competitive-Market (Landscape/Commercial/Indication Expansion) · Patent (IP) · Regulatory (POS reg path) · Financial (Pricing/Financial/Implied/Comps/Valuation).

**Dynamic specialist selection:** the planner engages only the relevant specialists per query and **shows which it skipped, with a one-line reason** (e.g., "Financial — not relevant to a druggability question"). Header shows "N of 6 specialists engaged." Judgment made visible — and it permanently resolves the old "6 agents" credibility gap.

**Objective + stop-condition loops:** a deep-dive mode loops a specialist until **evidence saturation** (no new canonical records), not a fixed call count.

---

## 6. Rendering surfaces

The report is a structured object rendered to three surfaces:

| Surface | What it is | Role |
|---|---|---|
| **Web glass-box** | The full interactive dossier (drawer, hover, redline toggle) | The version shown live |
| **Slack** (Phase 3) | Conversational entry + threaded trace + summary card + dossier attachment/link | Where scientists invoke it |
| **PDF / HTML export** | The same dossier, portable | The Gosset-equivalent deliverable for data rooms |

- **PDF = the web dossier printed by headless Chromium** → pixel-identical, no second layout.
- **Export triggerable from either surface.**
- Slack can't render the rich dossier inline (Block Kit limits) → it gives conversation + summary + a "Full report" PDF/link; the full experience lives on the web.

### Web glass-box UX
Single-column **document/dossier** (paper-on-desk), 720–760px reading column, **quiet grouped contents rail** (Overview / Risk / Business) with RAG dots. Verdict is the hero (not the question). Progressive disclosure: outcomes by default, process on demand (Supporting Evidence + Research Process collapsibles). **Inline citation superscripts → evidence drawer** (record + supporting quote + link). **"View agent edits"** reveals track-changes redline for overreach. Research Process expands to a Methods view (per specialist: objective · tools · queries · sources reviewed→selected) + the considered-but-skipped list.

---

## 7. Design system & principles

**Type:** **Figtree** (self-hosted, OFL — matches Gosset's geometric-sans character, works offline) for verdict/headings/body/UI; **IBM Plex Mono** for identifiers only (PMID/NCT/ENSG/patent no.). Weights 400/500/600.

**Color:** ink `#0F172A` · accent `#1D4ED8` · good `#0F766E` · attention `#B45309` · bg `#F9FAFB` · surface `#FFFFFF` · border `#E5E7EB`.

**Aesthetic:** "Benchling + Nature article + restrained Bloomberg" — quiet, editorial, evidence-first. NOT an AI/dev dashboard. No glows/gradients/neon.

**Principles (the calm checklist):**
- ≤ 3 colored tokens visible per view (count dots + chips + tags).
- One accent · one "good" · one "attention" color; no fourth hue on the surface.
- The conclusion is the largest text on any view; outcomes big / process small.
- Status = thin dot + text label, never a filled pill.
- Tables default to ≤ 3 columns; detail on hover or in the drawer.
- Substantive section subheadings (no lay explainers, no "optional/skippable" language).
- SVG icons only (no emoji glyphs in production).

**Accessibility/quality gates:** visible focus rings; semantic HTML before ARIA; `onKeyDown`+`tabIndex` on custom-interactive; `cursor-pointer`; transitions 150–300ms; contrast ≥ 4.5:1; `prefers-reduced-motion`; z-index scale (10/20/30/50); virtualize any list > 50 (the evidence ledger).

**Portfolio thumbnail:** the knowledge-graph fly-through still/loop (assets in `~/Downloads/sonny-thumbnails/`).

---

## 8. Quality engineering

- **Faithfulness eval + golden set.** Build a biomedical golden set (30–100 Q→records→answer). Track **Recall@k per specialist** (retrieval ceiling) and **Faithfulness on synthesis** (anti-hallucination headline). Run in CI so a chunk-size/model change that tanks recall is caught.
- **The verification pass IS runtime faithfulness** — eval measures it offline; verification enforces it live.
- **LLM-as-judge** (calibrated against expert-labeled examples) for open-ended grading.
- **Per-role eval harness** (recommended) — fixed role-specific test sets scoring quality + cost + latency, so the ModelRouter map is a *measured* result; can run as a long-running improve-the-metric loop.
- **Evaluate dependencies** (composed MCP servers) on our own benchmark.
- **Observability:** trace every query (retrieved records + scores, tokens, cost, latency, verdicts) — foundation for debugging and the citability guarantee.
- **Robustness:** `Promise.allSettled` + per-call timeouts/retries/AbortController on fan-out; one provider failure never discards the batch.
- **Testing:** unit tests for pure functions (parsing, cost, ID extraction); contract tests for each normalizer; E2E test that records evidence (per the build pipeline).

---

## 9. Build process (operational, per Kun Chen)

- **Validation pipeline** (`no-mistakes`-style) per change: isolated worktree → infer intent → rebase/resolve → adversarial review in fresh context → E2E test recording evidence → docs → lint → PR → babysit. (Use the `Workflow` tool + subagents + worktree isolation.)
- **Parallel build** via worktrees (`treehouse`) + a meta-orchestrator (`firstmate` / `Workflow`).
- **Harness-agnostic, portable artifacts** (skills/CLI/MCP/memory).
- **Memory-by-correction** + a standing **"don't weight development cost"** rule (counter the model's bias toward cheap, unmaintainable designs).
- **`lavish`-style planning** = the visual-companion workflow already in use.

---

## 10. Open items / next

- Scaffold the monorepo; build the **full-stack vertical slice** on one therapeutic area (gateway→Open Targets, evidence store, **graph ingestion + GraphRAG query**, grounding, verifier, glass-box) first.
- Spike: vet 2–3 candidate MCP servers (Open Targets official, a BLAST server, a PubMed/trials server) on **our own benchmark** — token efficiency + canonical-ID fidelity + licensing.
- Choose the graph substrate (§11) and confirm the BYO-key/VPC/Bedrock data-governance posture (§12).
- Decide where the v2 repo lives (new public repo, MIT).
- Build `combination-drug-screening` (§13) as the first analysis capability, on a public dataset, after the public-evidence slice.
- Phase 2 financial-modeling design (deferred).

---

## 11. Memory & knowledge architecture (GraphRAG)

Sonny does **not** require an Obsidian-style vault to function — it works statelessly per run, which is itself a trust feature (every answer re-derived from live sources). "Memory" spans three layers, each with its proper substrate (none is Obsidian):

1. **Evidence store — per-run, session-scoped** (§3). In-memory; no persistence. Makes Sonny *function*.
2. **Operational learning — "memory by correction"** (Kun Chen). Lessons about doing the job better, in a **markdown project-memory file** in the repo. Makes Sonny *better at its craft*. No DB.
3. **Knowledge accumulation — the grounded biomedical knowledge graph (CORE).** Lets Sonny reuse prior findings, cross-link assets/targets, and reason multi-hop. Substrate: a **graph store** (e.g. Neo4j / Postgres+pgvector hybrid, or a managed graph), **not a vault**.

**The graph is a graph *of evidence*, not of opinions.** Nodes = canonical entities (target · drug · trial · patent · disease · asset, keyed by ENSG/NCT/PMID/patent-no.). Edges = relationships, **each carrying its source record(s)** from the evidence store. GraphRAG retrieval traverses entities/relationships for multi-hop questions flat RAG can't answer ("how does this target connect to this resistance mechanism via this pathway, and which trials/patents cover it?") — the exact structure the KG fly-through visual depicts.

**Trust guardrails (non-negotiable):**
- **Provenance preserved** — every node/edge traces to a real record; nothing enters the graph un-sourced.
- **Memory of evidence, not conclusions** — cached past dossiers carry their citations + verdicts; on reuse Sonny **re-verifies against current sources** or stamps "as of <date>, re-verify." Memory must never become a hallucination-laundering path.
- **Tenant-scoped** — graph + history partitioned per scientist/workspace; no cross-user bleed (privacy + IP).

**How it learns over time:** each run upserts newly retrieved, verified entities/edges into the (tenant-scoped) graph by canonical ID; the graph compounds; future runs start from a richer, still-grounded substrate and re-verify on read.

**Obsidian's only legitimate roles:** (a) a *human-facing export* — Sonny can write finished dossiers into a scientist's own vault; (b) it's *your build's* second brain (`sirquanzo_OS`), not Sonny's runtime.

## 12. Production & enterprise readiness

What makes this deployable in a real (regulated) R&D organization — the engineering concerns a production agent must address regardless of customer:

- **Data governance & security (top pharma concern):** caller **brings their own key**; runs in the customer's **VPC / on Amazon Bedrock** so data never leaves their boundary; no training on customer data; secrets handling; the indirect-prompt-injection defenses from §3.
- **Multi-tenancy + identity:** per-scientist/workspace isolation; **SSO + RBAC**; tenant-scoped evidence/graph/history.
- **Audit trail / traceability:** every claim → record → verdict logged and exportable; a **21 CFR Part 11 / GxP-adjacent** mindset (regulated-industry traceability of how each conclusion was reached).
- **Evals + monitoring (agent-ops):** the faithfulness/golden-set harness (§8) in CI; runtime observability (traces, cost, latency, drift), alerting.
- **Integration surfaces:** Benchling/ELN, internal data lakes, internal literature corpora (slot in via the doc-RAG path §4); internal databases as additional MCP/gateway sources.
- **Model governance + cost controls:** the ModelRouter (which models, where they run — incl. customer-hosted/Bedrock); per-run usage/cost accounting; budget caps.
- **CI/CD + IaC:** reproducible, infrastructure-as-code deployment.

**Public-data demo, enterprise-ready architecture.** The reference build runs entirely on **public** biomedical sources (no proprietary data required), while the architecture cleanly accommodates an enterprise deployment: run in the customer's **VPC / managed cloud** (e.g. Bedrock), against their **internal data lake and ELN/Benchling**, behind **SSO**, with a **Part-11-style audit trail** — internal corpora slot in via the doc-RAG path (§4) and additional gateway sources. The grounding, governance, and audit design are what let it cross from "public-data demo" to "deployed in production" without re-architecting.

## 13. Extensible capabilities & the drug portfolio

**Living agent.** Sonny's capabilities grow over time: each new analysis is a **skill** in a capability registry (progressive disclosure — load the one-line description, read the full recipe only when selected). The planner engages capabilities like it engages specialists; new skills (tox, PK/PD, biomarker, expression…) plug in without touching the core.

**The drug portfolio.** Each drug/asset is a first-class node in the knowledge graph (§11) that **compounds**: public evidence (literature/trials/patents) + **internal experimental evidence** contributed by many functions, each contribution attributed, versioned, access-scoped, audit-trailed (§12). A drug's dossier becomes a *live, compounding* document — different functions upload data to enrich the profile, and future experiments/dossiers reference it.

**Computed-evidence discipline.** Analysis skills emit a distinct evidence kind — `AnalysisResult` (§11): provenance = dataset + method + parameters, reproducible, flagged "computed from dataset X," never laundered into fact.

### 13.1 Capability — `combination-drug-screening`

Implements the FIMM/SynergyFinder methodology (**He et al., *Methods Mol Biol* 2018;1711:351–398, doi:10.1007/978-1-4939-7493-1_17**; SynergyFinder, CRAN/Bioconductor) — the skill's methodology is itself a cited reference.

**Registry description:** "Analyze a combination drug-screening dose-response matrix — fit dose-response curves, score HSA/Loewe/Bliss/ZIP synergy, assess efficacy across cell lines/cancer types, summarize findings, and log them to the drug portfolio."

**Input contract — SynergyFinder list-format CSV:** `BlockID, Row, Col, DrugRow, DrugCol, ConcRow, ConcCol, ConcUnit, Response` (+ optional `CellLine, CancerType, Replicate, Readout`). `Response` = %inhibition; %viability is converted `100 − viability`. Validate schema; handle replicates, missing/extreme values.

**Canonicalization:** drugs → canonical IDs; cell lines → **Cellosaurus**; cancer type → **OncoTree/NCIt** — so results attach to the correct graph nodes.

**Pipeline (per `BlockID` × cell line):**
1. **Reshape** to a dose-response matrix.
2. **Single-drug dose-response:** 4-parameter log-logistic (**4PL**) fit → **IC50/EC50, Emax, Hill slope**, with R² + confidence intervals.
3. **Combination efficacy:** raw response matrix; max combination inhibition + response at biologically relevant doses.
4. **Synergy scoring** per dose pair, all four reference models — synergy = observed `yc` − expected `ye`:
   - **HSA:** `ye = max(y1, y2)`
   - **Loewe:** `ye` = effect of a drug combined with itself
   - **Bliss:** `ye = y1 + y2 − y1·y2`
   - **ZIP:** Loewe ∧ Bliss (zero-interaction-potency); δ-score over the landscape
   - normalized %inhibition → score = proportion of response from interaction; optional **baseline correction** (avg of the two single-drug minimum responses).
5. **Summarized synergy score** (mean over matrix) per model + **2D/3D interaction landscape**; locate the **maximal-synergy dose region**.
6. **Stratify** across cell lines / cancer types; compare synergy + efficacy.

**Interpretation rules (baked in — paper Notes 9–10):**
- **Apply all four models;** report combinations synergistic *across* models; flag model-dependent calls.
- **Synergy ≠ efficacy:** always pair the synergy score with overall response — never call a combination promising on synergy alone if overall inhibition is low (e.g. "ZIP +18 but max inhibition 30% → limited benefit").
- Synergy bands (>10 synergistic / −10..10 additive / <−10 antagonistic) stated as conventions, not law.

**Outputs:**
- Per drug: 4PL curve + IC50/EC50/Emax/Hill + fit quality.
- Per combination × cell line: four synergy matrices, summarized scores, interaction landscape, max-synergy region, efficacy.
- **Grounded findings summary** (a dossier section): top synergistic-*and*-efficacious combinations, cell-line/cancer-type patterns, caveats — every number cites its `AnalysisResult` (dataset + model + params), reproducible.
- Charts (dose-response curves, synergy heatmaps/landscapes) in the dossier design system.

**Compute:** sandboxed Python (resource-capped, seeded) using a vetted synergy library (e.g. Wooten `synergy` — implements HSA/Bliss/Loewe/ZIP/MuSyC — or R SynergyFinder via a service).

**Portfolio logging:** verified findings upsert into the drug's portfolio node (drug ↔ cell-line ↔ cancer-type edges carrying synergy + efficacy + dataset provenance), tenant-scoped, versioned, audited.

**Demonstrable on public data:** NCI-ALMANAC, GDSC, or the paper's DLBCL example (ibrutinib + ispinesib / canertinib, TMD8) — the full upload→analyze→summarize→log loop without proprietary data.

---

*Design Principles in §7 incorporate the "calm/anti-intimidation" review and the UI/UX-Pro-Max pass. Build/operational patterns in §9 and several §3–§5 sharpenings derive from [[Kun Chen Agentic Workflow applied to Sonny]]. §11–§12 (GraphRAG core + production readiness) reflect a first-principles "production agent for R&D" bar — vendor- and customer-neutral. §13.1 implements the SynergyFinder methodology (He et al., Methods Mol Biol 2018).*
