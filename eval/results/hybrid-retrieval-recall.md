# Hybrid retrieval recall evaluation

Status: **measured live**

- Measured: 2026-07-18T07:22:58.909Z
- Embedding model: `nomic-embed-text` via `http://localhost:11434/api/embed`
- Recall cutoff: 8 per golden question
- Protocol: each golden claim probe is a question; baseline uses the target-only Europe PMC query; hybrid adds LLM variants, unions candidates, embeds title+abstract with Ollama, and applies RRF.

| Target | Gold PMIDs | Baseline recall@8 | Hybrid recall@8 | Lift | Baseline found | Hybrid found |
|---|---:|---:|---:|---:|---|---|
| CDCP1 | 1 | 0.0% | 100.0% | 100.0 pp | — | 23208492 |
| ZXQR7 | 0 | 100.0% | 100.0% | 0.0 pp | — | — |
| **Mean (all targets)** |  | **50.0%** | **100.0%** | **50.0 pp** |  |  |
| **Mean (targets with gold PMIDs)** |  | **0.0%** | **100.0%** | **100.0 pp** |  |  |

Targets with no seminal PMIDs score 100% by the existing `retrievalRecall` definition, so the gold-bearing-target mean is also shown.
