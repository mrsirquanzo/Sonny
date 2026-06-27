# Sonny

A grounded, multi-agent biomedical research & due-diligence agent. Sonny can't assert what it can't cite — every factual claim traces to a real retrieved record (PMID, NCT, ENSG, patent no.), and a decorrelated verification pass confirms each citation resolves and supports the claim.

> Status: early build. The implementation follows a vertical-slice-first plan — start with the grounded core (evidence store → grounding → verification → orchestrator) over real public biomedical sources, then broaden.

## Architecture (overview)

A TypeScript pnpm monorepo:

- `packages/shared` — data contracts (Evidence, Claim, Verdict, TraceEvent), Zod-validated.
- `packages/core` — the trust engine: evidence store, ModelRouter + structured LLM client, grounding gate, decorrelated verifier, orchestrator.
- `packages/mcp-gateway` — data sources exposed as tools returning normalized canonical evidence (Open Targets, PubMed, …).
- `apps/cli` — run a query and stream the reasoning trace.
- `eval/` — faithfulness + recall@k metrics.

## Principles

- **Grounded:** no citation, no claim ("no token, no ship").
- **Verified:** a decorrelated model checks each claim resolves and is supported.
- **Glass-box:** the reasoning trace is observable and steerable.
- **Production-minded:** governance, provenance, evals, and observability are first-class.

## Getting started

```bash
pnpm install
pnpm -r test
# live run (requires an Anthropic API key — bring your own):
ANTHROPIC_API_KEY=sk-... pnpm --filter @sonny/cli start "Is EGFR a druggable target in NSCLC?"
```

## License

MIT — see [LICENSE](./LICENSE).
