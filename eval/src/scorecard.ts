import { promises as fs } from "node:fs";
import path from "node:path";
import type { MetricResult } from "./metrics.js";

/**
 * A scorecard aggregates metrics per target and across the set, writes JSON +
 * markdown, and diffs against a stored baseline so CI can fail on regression.
 */

export interface TargetScore {
  target: string;
  label: string;
  verdict: string; // Sonny's actual (modal) verdict
  trap: boolean;
  metrics: MetricResult[];
}

export interface Scorecard {
  runAt: string;
  backend: string; // e.g. "anthropic" | "ollama"
  subset: string;
  targets: TargetScore[];
  aggregates: Record<string, number>; // mean score per metric name
}

/** Regression thresholds: how far a metric may drop below baseline before CI fails. */
export const REGRESSION_TOLERANCE: Record<string, number> = {
  grounding_integrity: 0.0, // must never drop
  computation_grounding: 0.0,
  faithfulness: 0.03,
  retrieval_recall: 0.05,
  unsupported_sentence_ratio: 0.05,
  verdict_stability: 0.1,
  kol_precision_at_k: 0.1,
  developability_catch: 0.1,
  claim_probes: 0.1,
  figure_grounding: 0.1,
};

/** Absolute floors that must hold regardless of baseline (checked independently of REGRESSION_TOLERANCE). */
export const ABSOLUTE_FLOORS: Record<string, number> = {
  figure_grounding: 0.5, // calibrate after the first real figure runs
  computation_grounding: 1.0,
};

export function aggregate(targets: TargetScore[]): Record<string, number> {
  const sums: Record<string, { total: number; n: number }> = {};
  for (const t of targets) {
    for (const m of t.metrics) {
      sums[m.name] ??= { total: 0, n: 0 };
      sums[m.name].total += m.score;
      sums[m.name].n += 1;
    }
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(sums)) out[k] = v.n ? v.total / v.n : 0;
  return out;
}

export function toMarkdown(sc: Scorecard): string {
  const lines: string[] = [];
  lines.push(`# Sonny eval scorecard`);
  lines.push(`Run: ${sc.runAt}  |  backend: ${sc.backend}  |  subset: ${sc.subset}`);
  lines.push("");
  lines.push(`## Aggregates`);
  lines.push(`| metric | mean |`);
  lines.push(`| --- | --- |`);
  for (const [k, v] of Object.entries(sc.aggregates)) lines.push(`| ${k} | ${v.toFixed(3)} |`);
  lines.push("");
  lines.push(`## Per target`);
  for (const t of sc.targets) {
    const fails = t.metrics.filter((m) => !m.pass).map((m) => m.name);
    const flag = t.trap ? " (trap)" : "";
    lines.push(`### ${t.target}${flag} -> verdict: ${t.verdict} (expected ${t.label})`);
    lines.push(fails.length ? `FAIL: ${fails.join(", ")}` : `all pass`);
    lines.push(`| metric | score | pass |`);
    lines.push(`| --- | --- | --- |`);
    for (const m of t.metrics) lines.push(`| ${m.name} | ${m.score.toFixed(3)} | ${m.pass ? "y" : "n"} |`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeScorecard(sc: Scorecard, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "scorecard.json"), JSON.stringify(sc, null, 2));
  await fs.writeFile(path.join(dir, "scorecard.md"), toMarkdown(sc));
}

export interface RegressionResult {
  regressed: { metric: string; baseline: number; current: number; tolerance: number }[];
  hardFailures: string[]; // targets with a failing must-pass metric (e.g. grounding)
  belowFloor: { metric: string; floor: number; current: number }[];
}

/** Compare current aggregates to a baseline; return regressions that should fail CI. */
export async function checkRegression(
  sc: Scorecard,
  baselinePath: string,
): Promise<RegressionResult> {
  let baseline: Scorecard | null = null;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  } catch {
    baseline = null; // first run: no baseline yet
  }
  const regressed: RegressionResult["regressed"] = [];
  if (baseline) {
    for (const [metric, tol] of Object.entries(REGRESSION_TOLERANCE)) {
      const cur = sc.aggregates[metric];
      const base = baseline.aggregates[metric];
      if (cur === undefined || base === undefined) continue;
      if (base - cur > tol) regressed.push({ metric, baseline: base, current: cur, tolerance: tol });
    }
  }
  // Grounding integrity failing on ANY target is a hard failure regardless of baseline.
  const hardFailures = sc.targets
    .filter((t) => t.metrics.some((m) =>
      (m.name === "grounding_integrity" || m.name === 'computation_grounding') && !m.pass))
    .map((t) => t.target);
  // Absolute floors are checked baseline-independently, same discipline as hardFailures.
  const belowFloor: RegressionResult["belowFloor"] = [];
  for (const [metric, floor] of Object.entries(ABSOLUTE_FLOORS)) {
    const cur = sc.aggregates[metric];
    if (cur !== undefined && cur < floor) belowFloor.push({ metric, floor, current: cur });
  }
  return { regressed, hardFailures, belowFloor };
}
