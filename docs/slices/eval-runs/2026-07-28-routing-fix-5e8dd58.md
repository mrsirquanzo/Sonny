# Sonny eval scorecard
Run: 2026-07-29T00:40:43.386Z  |  backend: openai  |  subset: fast

## Aggregates
| metric | mean |
| --- | --- |
| grounding_integrity | 1.000 |
| computation_grounding | 1.000 |
| retrieval_recall | 1.000 |
| kol_precision_at_k | 0.333 |
| developability_catch | 0.500 |
| verdict_in_band | 1.000 |
| verdict_stability | 1.000 |
| cost_latency | 1.000 |
| figure_grounding | 1.000 |
| faithfulness | 0.975 |
| unsupported_sentence_ratio | 0.861 |
| claim_probes | 0.167 |

## Per target
### CDCP1 -> verdict: watch (expected watch)
FAIL: developability_catch, unsupported_sentence_ratio, claim_probes
| metric | score | pass |
| --- | --- | --- |
| grounding_integrity | 1.000 | y |
| computation_grounding | 1.000 | y |
| retrieval_recall | 1.000 | y |
| kol_precision_at_k | 0.667 | y |
| developability_catch | 0.000 | n |
| verdict_in_band | 1.000 | y |
| verdict_stability | 1.000 | y |
| cost_latency | 1.000 | y |
| figure_grounding | 1.000 | y |
| faithfulness | 0.950 | y |
| unsupported_sentence_ratio | 0.722 | n |
| claim_probes | 0.333 | n |

### ZXQR7 (trap) -> verdict: insufficient-evidence (expected insufficient-evidence)
FAIL: claim_probes
| metric | score | pass |
| --- | --- | --- |
| grounding_integrity | 1.000 | y |
| computation_grounding | 1.000 | y |
| retrieval_recall | 1.000 | y |
| kol_precision_at_k | 0.000 | y |
| developability_catch | 1.000 | y |
| verdict_in_band | 1.000 | y |
| verdict_stability | 1.000 | y |
| cost_latency | 1.000 | y |
| figure_grounding | 1.000 | y |
| faithfulness | 1.000 | y |
| unsupported_sentence_ratio | 1.000 | y |
| claim_probes | 0.000 | n |
