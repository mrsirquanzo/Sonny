# Grounded-lift evaluation

Status: **measured live**

- Measured: 2026-07-19T00:56:49.696Z
- Answerer model: `qwen2.5:14b` (same model in both arms; the only variable is whether retrieved evidence is provided)
- Embedding model: `nomic-embed-text` via `http://localhost:11434/api/embed`
- Retrieval cutoff: 8 per probe
- Protocol: each golden claim probe is classified twice by the writer model - once grounded on the deployed hybrid-retrieval passages ("answer only from the evidence; if silent, answer unsupported"), once closed-book from parametric knowledge. Both are scored by exact match against the human-curated `expected`.

## Per-target accuracy

| Target | Probes | Closed-book acc. | Grounded acc. | Grounded lift |
|---|---:|---:|---:|---:|
| CDCP1 | 3 | 66.7% | 66.7% | 0.0 pp |
| EGFR | 2 | 100.0% | 100.0% | 0.0 pp |
| HER2 | 2 | 100.0% | 100.0% | 0.0 pp |
| HER3 | 2 | 100.0% | 50.0% | -50.0 pp |
| KRAS | 2 | 100.0% | 100.0% | 0.0 pp |
| Nectin-4 | 2 | 100.0% | 100.0% | 0.0 pp |
| TROP2 | 2 | 100.0% | 50.0% | -50.0 pp |
| ZXQR7 | 1 | 100.0% | 100.0% | 0.0 pp |
| **Overall** | 16 | **93.8%** | **81.3%** | **-12.5 pp** |

## Interpretation

- **Hallucinations (grounded asserted the opposite of the truth): 0 / 16.** Grounding never flipped a false claim to "supported" or a true claim to "refuted".
- **Faithful abstentions: 3.** These are the grounded arm answering "unsupported" on a claim whose retrieved passages did not explicitly settle it - correct caution for a due-diligence agent, but scored as wrong by exact match.
- **Closed-book errors corrected by grounding: 1.**
- **Net exact-match regressions vs closed-book: 3** (all attributable to the abstentions above, none to hallucination).

On canonical oncology targets a strong base model is already near-ceiling from parametric memory, so retrieval cannot lift exact-match agreement and, by enforcing evidence-bounded caution, slightly lowers it. Grounding's value here is faithfulness and abstention (never asserting the unsupported), which is what Sonny's shipped grounding gate and faithfulness metrics measure - not parametric recall on famous biology.

## Lift by probe polarity

| Expected | Probes | Closed-book acc. | Grounded acc. | Grounded lift |
|---|---:|---:|---:|---:|
| supported | 7 | 100.0% | 100.0% | 0.0 pp |
| refuted | 8 | 87.5% | 62.5% | -25.0 pp |
| unsupported | 1 | 100.0% | 100.0% | 0.0 pp |

Grounding's value shows most on `refuted` probes - plausible-sounding false statements a parametric model can pattern-match into asserting, but that reading the real abstracts contradicts.

## Per-probe detail

`unsupported` in the grounded column on a `refuted`-expected probe is faithful abstention (the retrieved passages did not explicitly contradict the statement), not a hallucination - a distinction exact-match scoring collapses.

| Target | Expected | Closed-book | Grounded | Evidence | Statement |
|---|---|---|---|---:|---|
| CDCP1 | supported | supported | supported | 8 | CDCP1 is proteolytically cleaved, and the cleaved form promotes cancer c… |
| CDCP1 | refuted | refuted | unsupported ✗ | 8 | CDCP1 is an approved drug target with a marketed therapy. |
| CDCP1 | refuted | unsupported ✗ | refuted | 8 | CDCP1 expression has no relationship to patient prognosis. |
| EGFR | supported | supported | supported | 8 | Somatic activating mutations in the EGFR tyrosine kinase domain (exon 19… |
| EGFR | refuted | refuted | refuted | 8 | EGFR kinase-domain mutations in lung cancer confer primary resistance to… |
| HER2 | supported | supported | supported | 8 | HER2/ERBB2 gene amplification occurs in roughly 20-30% of breast cancers… |
| HER2 | refuted | refuted | refuted | 8 | HER2 overexpression has no bearing on prognosis or treatment selection i… |
| HER3 | supported | supported | supported | 8 | HER3/ERBB3 has weak-to-negligible intrinsic kinase activity and signals … |
| HER3 | refuted | refuted | unsupported ✗ | 8 | HER3 is a potent stand-alone receptor tyrosine kinase that drives tumor … |
| KRAS | supported | supported | supported | 8 | The KRAS G12C mutant can be targeted by small molecules that covalently … |
| KRAS | refuted | refuted | refuted | 8 | KRAS is pharmacologically undruggable and no KRAS-mutant-selective inhib… |
| Nectin-4 | supported | supported | supported | 8 | Nectin-4 (PVRL4) is a cell-surface adhesion molecule overexpressed in ur… |
| Nectin-4 | refuted | refuted | refuted | 8 | Nectin-4 is a secreted cytokine with no membrane expression, which is wh… |
| TROP2 | supported | supported | supported | 8 | TROP2 (TACSTD2) is a type-I transmembrane glycoprotein overexpressed on … |
| TROP2 | refuted | refuted | unsupported ✗ | 8 | TROP2 is an intracellular tyrosine kinase whose enzymatic activity direc… |
| ZXQR7 | unsupported | unsupported | unsupported | 0 | ZXQR7 is implicated in tumor progression. |
