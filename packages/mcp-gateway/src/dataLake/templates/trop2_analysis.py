#!/usr/bin/env python3
"""Reviewed, network-free TACSTD2 analysis template.

This Phase-1 template is intentionally not generic. The target, thresholds, tissue
set, exclusions, summaries, and absence of inferential tests are locked below.
Only the mounted allowlisted CSVs are read, and only results.json plus one PNG are
written to /output.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


SCHEMA_VERSION = "1.0.0"
TEMPLATE_ID = "trop2_analysis"
TEMPLATE_VERSION = "1.0.0"
TARGET_SYMBOL = "TACSTD2"
TARGET_NAME = "TROP2"
ENTREZ_GENE_ID = 4070
GENCODE_ID = "ENSG00000184292.7"

# Reviewed, preregistered analysis choices. These are not model parameters.
DEPENDENCY_CUTOFF = -0.5
DEPENDENCY_COMPARATOR = "lte"
LINEAGE_MINIMUM_OBSERVED_N = 5
TUMOR_SAMPLE_CLASSES = ("tumor", "normal")
STATISTICAL_TESTS = "none; preregistered descriptive analysis only"
EXCLUSION_RULES = (
    "Duplicate model_id, sample_id, or tissue_id values are fatal input errors.",
    "Non-numeric non-empty measurement values are fatal input errors.",
    "Missing measurements are retained in denominators and reported as missingness.",
    "Missing DepMap lineage is labeled Unknown; lineage series require at least 5 observed gene-effect values.",
    "Unrecognized cBioPortal sample types remain unknown and are excluded from tumor and normal summaries.",
    "No inferential statistical test and no cross-source tumor-versus-normal comparison is performed.",
)

DATA_ROOT = Path("/data")
OUTPUT_ROOT = Path("/output")
DATASET_PATHS = {
    "depmap": DATA_ROOT / "depmap.crispr_gene_effect.csv",
    "gtex": DATA_ROOT / "gtex.median_tpm.csv",
    "tumor": DATA_ROOT / "expr.tumor.csv",
}
RESULTS_PATH = OUTPUT_ROOT / "results.json"
FIGURE_NAME = "trop2_analysis.png"
FIGURE_PATH = OUTPUT_ROOT / FIGURE_NAME


def require_exact_columns(frame: pd.DataFrame, expected: set[str], label: str) -> None:
    actual = set(frame.columns)
    if actual != expected:
        raise ValueError(
            f"{label} columns differ from reviewed contract; "
            f"expected={sorted(expected)}, actual={sorted(actual)}"
        )


def require_unique(frame: pd.DataFrame, column: str, label: str) -> None:
    if frame[column].isna().any() or (frame[column].astype(str).str.strip() == "").any():
        raise ValueError(f"{label}.{column} contains a missing identifier")
    duplicated = frame[column].duplicated(keep=False)
    if duplicated.any():
        values = sorted(frame.loc[duplicated, column].astype(str).unique().tolist())
        raise ValueError(f"{label}.{column} contains duplicates: {values[:10]}")


def numeric_with_missing(series: pd.Series, label: str) -> pd.Series:
    stripped = series.astype("string").str.strip()
    missing = series.isna() | stripped.isna() | stripped.eq("")
    numeric = pd.to_numeric(series.where(~missing), errors="coerce")
    invalid = ~missing & numeric.isna()
    if invalid.any():
        examples = series.loc[invalid].astype(str).head(5).tolist()
        raise ValueError(f"{label} contains non-numeric values: {examples}")
    finite = numeric.dropna().map(math.isfinite)
    if not bool(finite.all()):
        raise ValueError(f"{label} contains a non-finite value")
    return numeric.astype(float)


def allowlisted_input(path: Path) -> Path:
    resolved_root = DATA_ROOT.resolve(strict=True)
    resolved = path.resolve(strict=True)
    if resolved.parent != resolved_root or resolved not in {
        candidate.resolve(strict=True) for candidate in DATASET_PATHS.values()
    }:
        raise ValueError(f"input is not an exact allowlisted dataset mount: {path}")
    if not resolved.is_file():
        raise ValueError(f"allowlisted input is not a regular file: {path}")
    return resolved


def missingness(values: pd.Series) -> dict[str, int | float]:
    total_n = int(len(values))
    observed_n = int(values.notna().sum())
    missing_n = total_n - observed_n
    fraction = 0.0 if total_n == 0 else round(missing_n / total_n, 8)
    return {
        "missingN": missing_n,
        "observedN": observed_n,
        "totalN": total_n,
        "fraction": fraction,
    }


def rounded(value: float | np.floating[Any], precision: int) -> float:
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ValueError("analysis attempted to emit a non-finite result")
    return round(numeric, precision)


def scalar(
    value: float | np.floating[Any] | None,
    *,
    unit: str,
    comparator: str = "none",
    threshold: float | None = None,
    direction: str = "not_applicable",
    precision: int,
    tolerance: float,
    values_for_missingness: pd.Series,
    nullable: bool,
    note: str | None,
) -> dict[str, Any]:
    sample_n = int(values_for_missingness.notna().sum())
    if value is None and (not nullable or sample_n != 0):
        raise ValueError("null scalar requires nullable=true and sampleN=0")
    return {
        "type": "scalar",
        "value": None if value is None else rounded(value, precision),
        "unit": unit,
        "comparator": comparator,
        "threshold": threshold,
        "direction": direction,
        "precision": precision,
        "tolerance": tolerance,
        "missingness": missingness(values_for_missingness),
        "sampleN": sample_n,
        "nullable": nullable,
        "note": note,
    }


def group_point(
    key: str,
    label: str,
    value: float | np.floating[Any] | None,
    *,
    unit: str,
    values_for_missingness: pd.Series,
    precision: int,
    tolerance: float,
    comparator: str = "none",
    threshold: float | None = None,
    direction: str = "not_applicable",
    nullable: bool = False,
    note: str | None = None,
) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        **scalar(
            value,
            unit=unit,
            comparator=comparator,
            threshold=threshold,
            direction=direction,
            precision=precision,
            tolerance=tolerance,
            values_for_missingness=values_for_missingness,
            nullable=nullable,
            note=note,
        ),
    }


def grouped_series(
    groups: list[dict[str, Any]],
    *,
    unit: str,
    all_values: pd.Series,
    precision: int,
    tolerance: float,
    comparator: str = "none",
    threshold: float | None = None,
    direction: str = "not_applicable",
    note: str | None = None,
) -> dict[str, Any]:
    if not groups:
        raise ValueError("grouped-series result must contain at least one group")
    return {
        "type": "grouped-series",
        "value": None,
        "unit": unit,
        "comparator": comparator,
        "threshold": threshold,
        "direction": direction,
        "precision": precision,
        "tolerance": tolerance,
        "missingness": missingness(all_values),
        "sampleN": int(all_values.notna().sum()),
        "nullable": False,
        "note": note,
        "groups": groups,
    }


def load_depmap() -> pd.DataFrame:
    frame = pd.read_csv(allowlisted_input(DATASET_PATHS["depmap"]), dtype="string")
    require_exact_columns(
        frame,
        {"model_id", "cell_line_name", "lineage", "primary_disease", "gene_effect"},
        "depmap",
    )
    require_unique(frame, "model_id", "depmap")
    frame["gene_effect"] = numeric_with_missing(frame["gene_effect"], "depmap.gene_effect")
    frame["lineage"] = frame["lineage"].fillna("").str.strip().replace("", "Unknown")
    return frame.sort_values("model_id", kind="stable").reset_index(drop=True)


def load_gtex() -> pd.DataFrame:
    frame = pd.read_csv(allowlisted_input(DATASET_PATHS["gtex"]), dtype="string")
    require_exact_columns(frame, {"tissue_id", "tissue_name", "median_tpm"}, "gtex")
    require_unique(frame, "tissue_id", "gtex")
    frame["median_tpm"] = numeric_with_missing(frame["median_tpm"], "gtex.median_tpm")
    if (frame["median_tpm"].dropna() < 0).any():
        raise ValueError("gtex.median_tpm contains a negative value")
    return frame.sort_values("tissue_id", kind="stable").reset_index(drop=True)


def load_tumor() -> pd.DataFrame:
    frame = pd.read_csv(allowlisted_input(DATASET_PATHS["tumor"]), dtype="string")
    require_exact_columns(
        frame,
        {
            "study_id",
            "molecular_profile_id",
            "sample_id",
            "sample_type",
            "sample_class",
            "expression_value",
        },
        "tumor",
    )
    require_unique(frame, "sample_id", "tumor")
    expected_study = "brca_tcga_pan_can_atlas_2018"
    expected_profile = "brca_tcga_pan_can_atlas_2018_rna_seq_v2_mrna"
    if set(frame["study_id"].dropna().unique()) != {expected_study}:
        raise ValueError("tumor study_id differs from the reviewed cohort")
    if set(frame["molecular_profile_id"].dropna().unique()) != {expected_profile}:
        raise ValueError("tumor molecular_profile_id differs from the reviewed profile")
    allowed_classes = {"tumor", "normal", "unknown"}
    actual_classes = set(frame["sample_class"].fillna("unknown").str.lower().unique())
    if not actual_classes.issubset(allowed_classes):
        raise ValueError(f"tumor.sample_class contains unreviewed values: {actual_classes}")
    frame["sample_class"] = frame["sample_class"].fillna("unknown").str.lower()
    frame["expression_value"] = numeric_with_missing(
        frame["expression_value"], "tumor.expression_value"
    )
    if (frame["expression_value"].dropna() < 0).any():
        raise ValueError("tumor.expression_value contains a negative RSEM value")
    return frame.sort_values("sample_id", kind="stable").reset_index(drop=True)


def dependency_results(frame: pd.DataFrame) -> dict[str, dict[str, Any]]:
    values = frame["gene_effect"]
    observed = values.dropna()
    if observed.empty:
        raise ValueError("DepMap contains no observed TACSTD2 gene-effect values")

    selected = observed <= DEPENDENCY_CUTOFF
    lineage_groups: list[dict[str, Any]] = []
    for lineage, group in frame.groupby("lineage", sort=True, dropna=False):
        lineage_values = group["gene_effect"]
        lineage_observed = lineage_values.dropna()
        if len(lineage_observed) < LINEAGE_MINIMUM_OBSERVED_N:
            continue
        lineage_groups.append(
            group_point(
                str(lineage),
                str(lineage),
                lineage_observed.median(),
                unit="Chronos gene effect",
                values_for_missingness=lineage_values,
                precision=4,
                tolerance=1e-6,
                direction="lower",
                note="Descriptive lineage median; not an ADC suitability criterion.",
            )
        )

    return {
        "dependency.median_gene_effect": scalar(
            observed.median(),
            unit="Chronos gene effect",
            direction="lower",
            precision=4,
            tolerance=1e-6,
            values_for_missingness=values,
            nullable=False,
            note="Orthogonal tumor-biology context; dependency alone does not establish ADC suitability.",
        ),
        "dependency.models_at_or_below_locked_cutoff_n": scalar(
            float(selected.sum()),
            unit="models",
            comparator=DEPENDENCY_COMPARATOR,
            threshold=DEPENDENCY_CUTOFF,
            direction="lower",
            precision=0,
            tolerance=0.0,
            values_for_missingness=values,
            nullable=False,
            note="Count uses the reviewed cutoff and includes no model-selected threshold.",
        ),
        "dependency.fraction_at_or_below_locked_cutoff": scalar(
            selected.mean(),
            unit="fraction of observed models",
            comparator=DEPENDENCY_COMPARATOR,
            threshold=DEPENDENCY_CUTOFF,
            direction="lower",
            precision=6,
            tolerance=1e-8,
            values_for_missingness=values,
            nullable=False,
            note="Descriptive selectivity readout only; not evidence that an essential target should be drugged.",
        ),
        "dependency.median_by_lineage": grouped_series(
            lineage_groups,
            unit="Chronos gene effect",
            all_values=values,
            precision=4,
            tolerance=1e-6,
            direction="lower",
            note=f"Lineages shown only when observed N >= {LINEAGE_MINIMUM_OBSERVED_N}.",
        ),
    }


def tumor_results(frame: pd.DataFrame) -> tuple[dict[str, dict[str, Any]], list[str]]:
    summarized_values = frame.loc[
        frame["sample_class"].isin(TUMOR_SAMPLE_CLASSES), "expression_value"
    ]
    median_groups: list[dict[str, Any]] = []
    q1_groups: list[dict[str, Any]] = []
    q3_groups: list[dict[str, Any]] = []
    warnings: list[str] = []

    for sample_class in TUMOR_SAMPLE_CLASSES:
        class_values = frame.loc[frame["sample_class"] == sample_class, "expression_value"]
        observed = class_values.dropna()
        absent = observed.empty
        note = None
        if absent:
            note = f"No observed {sample_class} expression values were present in this cBioPortal slice."
            warnings.append(note)
        median_groups.append(
            group_point(
                sample_class,
                sample_class.title(),
                None if absent else observed.median(),
                unit="RSEM",
                values_for_missingness=class_values,
                precision=3,
                tolerance=1e-6,
                nullable=absent,
                note=note,
            )
        )
        q1_groups.append(
            group_point(
                sample_class,
                sample_class.title(),
                None if absent else observed.quantile(0.25, interpolation="linear"),
                unit="RSEM",
                values_for_missingness=class_values,
                precision=3,
                tolerance=1e-6,
                nullable=absent,
                note=note,
            )
        )
        q3_groups.append(
            group_point(
                sample_class,
                sample_class.title(),
                None if absent else observed.quantile(0.75, interpolation="linear"),
                unit="RSEM",
                values_for_missingness=class_values,
                precision=3,
                tolerance=1e-6,
                nullable=absent,
                note=note,
            )
        )

    unknown_n = int((frame["sample_class"] == "unknown").sum())
    if unknown_n:
        warnings.append(
            f"{unknown_n} cBioPortal samples had unknown/unreviewed sample type and were excluded from tumor/normal summaries."
        )

    series_note = (
        "Tumor and normal are same-study, same-profile summaries. No quantitative comparison "
        "to GTEx is made. Null normal values mean the selected cBioPortal slice contains no normal observations."
    )
    results = {
        "tumor_expression.median_by_sample_class": grouped_series(
            median_groups,
            unit="RSEM",
            all_values=summarized_values,
            precision=3,
            tolerance=1e-6,
            note=series_note,
        ),
        "tumor_expression.q1_by_sample_class": grouped_series(
            q1_groups,
            unit="RSEM",
            all_values=summarized_values,
            precision=3,
            tolerance=1e-6,
            note=series_note,
        ),
        "tumor_expression.q3_by_sample_class": grouped_series(
            q3_groups,
            unit="RSEM",
            all_values=summarized_values,
            precision=3,
            tolerance=1e-6,
            note=series_note,
        ),
    }
    return results, warnings


def gtex_results(frame: pd.DataFrame) -> dict[str, dict[str, Any]]:
    values = frame["median_tpm"]
    observed = values.dropna()
    if observed.empty:
        raise ValueError("GTEx contains no observed TACSTD2 median TPM values")

    groups: list[dict[str, Any]] = []
    for row in frame.itertuples(index=False):
        value = None if pd.isna(row.median_tpm) else float(row.median_tpm)
        groups.append(
            group_point(
                str(row.tissue_id),
                str(row.tissue_name),
                value,
                unit="TPM",
                values_for_missingness=pd.Series([value], dtype=float),
                precision=3,
                tolerance=1e-6,
                nullable=value is None,
                note=(
                    "Bulk normal-tissue RNA screening value; does not establish epithelial localization, "
                    "surface protein abundance, or toxicity."
                ),
            )
        )

    return {
        "normal_tissue.median_tpm_by_tissue": grouped_series(
            groups,
            unit="TPM",
            all_values=values,
            precision=3,
            tolerance=1e-6,
            note=(
                "Flags potential normal-tissue exposure risk requiring protein-level and clinical confirmation. "
                "This result is not quantitatively compared with the cBioPortal cohort."
            ),
        ),
        "normal_tissue.maximum_tissue_median_tpm": scalar(
            observed.max(),
            unit="TPM",
            direction="higher",
            precision=3,
            tolerance=1e-6,
            values_for_missingness=values,
            nullable=False,
            note=(
                "Descriptive screening maximum only; flags potential normal-tissue exposure risk requiring "
                "protein-level and clinical confirmation."
            ),
        ),
    }


def write_figure(depmap: pd.DataFrame, tumor: pd.DataFrame, gtex: pd.DataFrame) -> None:
    figure, axes = plt.subplots(1, 3, figsize=(16, 6), constrained_layout=True)

    dependency_values = depmap["gene_effect"].dropna().to_numpy(dtype=float)
    bins = min(40, max(10, int(math.sqrt(len(dependency_values)))))
    axes[0].hist(dependency_values, bins=bins, color="#355C7D", alpha=0.9)
    axes[0].axvline(DEPENDENCY_CUTOFF, color="#C44E52", linestyle="--", linewidth=2)
    axes[0].set_title("DepMap TACSTD2 dependency")
    axes[0].set_xlabel("Chronos gene effect")
    axes[0].set_ylabel("Model count")

    box_values: list[np.ndarray[Any, np.dtype[np.float64]]] = []
    box_labels: list[str] = []
    for sample_class in TUMOR_SAMPLE_CLASSES:
        values = tumor.loc[
            tumor["sample_class"] == sample_class, "expression_value"
        ].dropna().to_numpy(dtype=float)
        if len(values):
            box_values.append(values)
            box_labels.append(sample_class.title())
    if box_values:
        axes[1].boxplot(box_values, tick_labels=box_labels, showfliers=False)
    else:
        axes[1].text(0.5, 0.5, "No tumor/normal observations", ha="center", va="center")
    axes[1].set_title("cBioPortal TACSTD2 expression")
    axes[1].set_ylabel("RSEM")

    gtex_plot = gtex.dropna(subset=["median_tpm"]).sort_values("median_tpm", ascending=True)
    axes[2].barh(gtex_plot["tissue_name"], gtex_plot["median_tpm"], color="#4C956C")
    axes[2].set_title("GTEx normal-tissue TACSTD2")
    axes[2].set_xlabel("Median TPM (screening only)")
    axes[2].tick_params(axis="y", labelsize=7)

    figure.suptitle(
        "TROP2 / TACSTD2: bounded, descriptive signals (no cross-source comparison)",
        fontsize=13,
    )
    figure.savefig(FIGURE_PATH, dpi=160, format="png", metadata={"Software": "Sonny"})
    plt.close(figure)


def main() -> None:
    output_root = OUTPUT_ROOT.resolve(strict=True)
    if output_root != OUTPUT_ROOT:
        raise ValueError("/output must resolve to the exact reviewed output mount")

    depmap = load_depmap()
    gtex = load_gtex()
    tumor = load_tumor()

    results = dependency_results(depmap)
    tumor_output, warnings = tumor_results(tumor)
    results.update(tumor_output)
    results.update(gtex_results(gtex))

    write_figure(depmap, tumor, gtex)

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "templateId": TEMPLATE_ID,
        "templateVersion": TEMPLATE_VERSION,
        "target": {
            "symbol": TARGET_SYMBOL,
            "name": TARGET_NAME,
            "entrezGeneId": ENTREZ_GENE_ID,
            "gencodeId": GENCODE_ID,
        },
        "lockedAnalysis": {
            "dependencyCutoff": DEPENDENCY_CUTOFF,
            "dependencyCutoffComparator": DEPENDENCY_COMPARATOR,
            "lineageMinimumN": LINEAGE_MINIMUM_OBSERVED_N,
            "tumorStatistic": "median and interquartile range, tumor and normal separately",
            "normalTissueStatistic": "GTEx V8 tissue median TPM; descriptive screening flag only",
            "exclusionRules": list(EXCLUSION_RULES),
            "statisticalTests": STATISTICAL_TESTS,
        },
        "results": results,
        "artifacts": [
            {
                "kind": "figure",
                "path": FIGURE_NAME,
                "mediaType": "image/png",
                "description": (
                    "Three-panel descriptive view of DepMap dependency, same-source cBioPortal "
                    "tumor/normal expression, and GTEx normal-tissue median TPM."
                ),
            }
        ],
        "warnings": sorted(set(warnings)),
    }

    with RESULTS_PATH.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")


if __name__ == "__main__":
    main()
