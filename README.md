# Sonny

A grounded, multi-agent biomedical research and due-diligence agent.

Sonny cannot assert what it cannot cite.
Every factual claim traces to a real retrieved record - a PMID, an NCT number, an Ensembl gene, a patent number - and a decorrelated verification pass (a different model family than the writer) confirms each citation resolves and actually supports the claim.
When the evidence is too thin to support a two-sided case, Sonny abstains rather than manufacture a verdict.

Six specialists investigate a target along fixed axes - target biology, mechanism, indication, clinical precedent, competitive IP, and modality-specific risk.
Each plans its own research questions, pursues them until the evidence answers them or the sources run dry, and reports the ones it could not answer rather than dropping them.

## Principles

- **Grounded** - no citation, no claim ("no token, no ship").
- **Verified** - a decorrelated model re-checks every claim; the writer never grades its own work.
- **Modality-agnostic** - the rubric is fixed and deterministic; the resolved modality conditions it through a lens rather than rewriting it. Retrieval states facts and never names a modality, so a small-molecule run is not quietly told it is an antibody run.
- **Answerable about its gaps** - a dossier ships with the questions the specialists could not answer, and an absence claim ("no precedent exists") must be substantiated by retrieval audits showing the searches that actually ran.
- **Glass-box** - the full reasoning trace is streamed as it happens, observable and steerable.
- **Local-first** - runs end to end on local models over free public data sources; no paid API required.

## Quickstart (no API key)

Sonny defaults to a local [Ollama](https://ollama.com) backend and free public sources (Europe PMC, Open Targets, ClinicalTrials.gov), so a full deep-research run costs nothing.

```bash
# 1. models the default router uses
ollama pull qwen2.5:14b      # planner / specialist / writer
ollama pull llama3.1:8b      # decorrelated verifier
ollama pull nomic-embed-text # hybrid retrieval embeddings

# 2. install + build
pnpm install
pnpm -r build

# 3. run a deep-research dossier on a target, streaming the reasoning trace
pnpm --filter @sonny/cli start deep CDCP1
```

To run on Anthropic models instead, set `SONNY_BACKEND=anthropic` and `ANTHROPIC_API_KEY`.

Hybrid literature retrieval is enabled by default. It expands each research
question into cached query variants, unions Europe PMC candidates, fuses
lexical and Ollama dense ranks with RRF, then uses the configured cross-encoder
reranker. Set `SONNY_HYBRID_RETRIEVAL=off` for the lexical-only path. The
embedding defaults can be overridden with `SONNY_EMBED_MODEL` and
`SONNY_EMBED_URL`.

## Architecture

A TypeScript pnpm monorepo:

- `packages/shared` - data contracts (Evidence, Claim, Verdict, TraceEvent, structured per-axis conclusions, disease-context keys, the modality risk taxonomy, retrieval audits), Zod-validated.
- `packages/core` - the engine: evidence store, model router, grounding gate, decorrelated verifier, multi-specialist deep-research orchestrator, the question ledger, MONDO disease-context normalization, conclusion drafting with deterministic degradation, coverage-based abstention, evidence grading, contradiction detection, and the competitive-IP / patent specialist.
- `packages/mcp-gateway` - data sources exposed as tools returning normalized, canonical evidence (Open Targets, Europe PMC, ClinicalTrials, EPO patents, BLAST, ANARCI).
- `apps/cli` - run a query or a deep dossier and stream the trace.
- `eval/` - a golden-set harness with output-quality metrics (grounding, faithfulness, retrieval, verdict calibration), investigation metrics (question coverage, pursuit, retrieval yield), and a regression ratchet.

The engine is designed to be embedded as a library: a consumer drives `produceBriefing`/`extractPatentSequences` in-process and receives the `TraceEvent` stream to render.

## Status

An active research build.
The engine, evaluation harness, and patent specialist are implemented and tested.

The rubric has been rebuilt modality-agnostic: the ADC assumptions that were baked into retrieval and the specialist briefs are gone, and sixteen modalities resolve through a lens table that conditions the mechanism and risk axes.
Structured per-axis conclusions, deterministic degradation, and coverage-based abstention are in.

Current work is depth: specialists that ask sharper questions and keep pursuing them until the evidence answers.
See `docs/slices/STATUS.md` for what is merged, what is deferred, and the known gaps in the evaluation harness.

## License

MIT - see [LICENSE](./LICENSE).
