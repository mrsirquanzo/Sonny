# Hybrid retrieval recall evaluation

Status: **measured live**

- Measured: 2026-07-18T15:30:48.557Z
- Embedding model: `nomic-embed-text` via `http://localhost:11434/api/embed`
- Recall cutoff: 8 per golden question
- Protocol: each golden claim probe is a question; baseline uses the target-only Europe PMC query; hybrid adds LLM variants, unions candidates, embeds title+abstract with Ollama, and applies RRF.

| Target | Gold PMIDs | Baseline recall@8 | Hybrid recall@8 | Lift | Baseline found | Hybrid found |
|---|---:|---:|---:|---:|---|---|
| CDCP1 | 1 | 0.0% | 100.0% | 100.0 pp | — | 23208492 |
| EGFR | 2 | 100.0% | 100.0% | 0.0 pp | 15118073, 15118125 | 15118073, 15118125 |
| HER2 | 3 | 33.3% | 33.3% | 0.0 pp | 11248153 | 11248153 |
| HER3 | 2 | 0.0% | 50.0% | 50.0 pp | — | 18454306 |
| KRAS | 3 | 0.0% | 33.3% | 33.3 pp | — | 31666701 |
| Nectin-4 | 3 | 66.7% | 66.7% | 0.0 pp | 27013195, 31356140 | 27013195, 31356140 |
| TROP2 | 3 | 0.0% | 0.0% | 0.0 pp | — | — |
| ZXQR7 | 0 | 100.0% | 100.0% | 0.0 pp | — | — |
| **Mean (all targets)** |  | **37.5%** | **60.4%** | **22.9 pp** |  |  |
| **Mean (targets with gold PMIDs)** |  | **28.6%** | **54.8%** | **26.2 pp** |  |  |

Targets with no seminal PMIDs score 100% by the existing `retrievalRecall` definition, so the gold-bearing-target mean is also shown.
