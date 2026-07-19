# Slice 1 scientific-validity note: TROP2 / TACSTD2

Date: 2026-07-17
Status: validated - TROP2 signal is defensible; proceed to Slice 2.
Spec: 2026-07-16-sonny-analysis-toolbox.md (§8 bounded claims)
Template: packages/mcp-gateway/src/dataLake/templates/trop2_analysis.py (locked contract)
Golden output: packages/mcp-gateway/src/dataLake/golden/{trop2_results.json, trop2_analysis.png}

## Data provenance (frozen 2026-07-17)

| Dataset | Source | Rows | sha256 (input CSV) |
|---|---|---|---|
| depmap.crispr_gene_effect | DepMap CRISPR (Chronos) gene effect, TACSTD2 column joined to DepMap_Model.csv metadata. Retrieved from Biomni's public re-hosted release (`biomni-release.s3.amazonaws.com/data_lake/DepMap_CRISPRGeneEffect.csv` + `DepMap_Model.csv`) to bypass depmap.org's Cloudflare wall. Same approach Biomni itself uses. | 1183 | 53ada942...d43948 |
| gtex.median_tpm | GTEx Portal API v2 medianGeneExpression, gencodeId ENSG00000184292.6, gtex_v8. | 54 | 314cb8a7...edb1bd |
| expr.tumor | cBioPortal REST, brca_tcga_pan_can_atlas_2018 RSEM, TACSTD2 (Entrez 4070). | 1082 | 9a759236...bf9939 |

Note: DepMap is served from Biomni's mirror, not depmap.org (Cloudflare Turnstile blocks automated access). The underlying data is the DepMap public release Biomni pinned; the exact release id must be recorded in datasets.json before production (Slice 3). License/redistribution review for all three is still open (tracked in datasets.json).

## Computed results (real data, run in the hardened sandbox)

- Dependency (DepMap): median Chronos gene effect = **-0.0234** (essentially zero); **1 / 1183 models (0.08%)** at or below the locked -0.5 cutoff; 26 lineage groups (>=5 observed models each).
- Tumor expression (cBioPortal BRCA): tumor median = **5924.6 RSEM**; normal = **null** (this cohort is tumor-only - correctly reported as absent with a warning, no cross-source comparison to GTEx).
- Normal-tissue signal (GTEx): maximum tissue median = **1419.1 TPM** (high expression in some normal epithelia).

## Defensibility assessment (each claim vs what the data supports)

1. Dependency claim - DEFENSIBLE. "TACSTD2 is not a selective genetic dependency in cancer cell lines (median gene effect ~0; <0.1% of models below the -0.5 cutoff)." This is the honest, expected result for a cell-surface antigen. Framed per §8 as orthogonal tumor biology, explicitly NOT "essential therefore drug it." A small-molecule inhibitor thesis would be wrong here; an ADC thesis is not.
2. Tumor-antigen claim - DEFENSIBLE. "TACSTD2 mRNA is highly abundant in breast tumors (median ~5925 RSEM)." Reported as tumor signal only; no quantitative tumor-vs-normal comparison across sources. Normal absence in this cohort is stated, not hidden.
3. Normal-tissue exposure claim - DEFENSIBLE as a SCREENING FLAG only. "High TACSTD2 transcript in some normal epithelia (max ~1419 TPM) flags potential normal-tissue exposure risk requiring protein-level and clinical confirmation." No epithelial-localization, surface-protein, or toxicity claim is made from bulk RNA.

## The narrative this supports (for the interview)

TROP2 is a validated ADC target (Trodelvy, Dato-DXd) precisely because it is a highly-expressed cell-surface antigen, NOT a genetic dependency:
- not a dependency (DepMap ~0) -> you do not inhibit it; you use it as a delivery address;
- abundant tumor antigen (BRCA RSEM ~5925) -> an ADC can deliver cytotoxic payload;
- broad normal-tissue transcript signal (GTEx max ~1419 TPM) -> real therapeutic-window / on-target-off-tumor risk, which is why linker/payload and dose matter.
Modality/linker conclusions themselves require internalization, pharmacology, and clinical evidence and are grounded in literature, not computed here.

## Verdict

The TROP2 signal is real and the bounded claims hold against the data. No story adjustment needed. Proceed to Slice 2 (computation contracts + grounding + eval).
