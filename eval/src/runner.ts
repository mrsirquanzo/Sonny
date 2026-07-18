import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GoldenTarget,
  SubsetConfig,
  type EvalSubset,
} from "./goldenSet.js";
import {
  makeJudge,
  groundingIntegrity,
  retrievalRecall,
  kolPrecisionAtK,
  developabilityCatchRate,
  verdictInBand,
  verdictStability,
  costLatency,
  figureGrounding,
  computationGrounding,
  type RunArtifacts,
  type StructuredModelLike,
  type MetricResult,
} from "./metrics.js";
import {
  aggregate,
  writeScorecard,
  checkRegression,
  type Scorecard,
  type TargetScore,
} from "./scorecard.js";

/**
 * Wiring points to @mrsirquanzo/sonny-core. These are the ONLY couplings to the engine.
 * runDeepResearch drives an emit(TraceEvent) sink and returns the store; the
 * service contract in section 12.1 requires produceBriefing to make the result
 * verdict-complete, which is exactly what the eval needs too.
 */
// import { runDeepResearch, produceBriefing } from "@mrsirquanzo/sonny-core";
// import { createRouter } from "@mrsirquanzo/sonny-core/model";
type EngineDeps = {
  runOnce: (target: string) => Promise<RunArtifacts>; // wraps runDeepResearch + produceBriefing + trace capture
  judgeModel: StructuredModelLike; // decorrelated verifier-role model
  judgeModelId?: string;
};

const REPEATS = Number(process.env.SONNY_EVAL_REPEATS ?? 3);
// Verdict-eval goldens live in golden/verdict/, namespaced apart from the
// patent-eval goldens (golden/synthetic-antibody.json) that share this package.
const GOLDEN_DIR = process.env.SONNY_GOLDEN_DIR ?? "golden/verdict";
const OUT_DIR = process.env.SONNY_EVAL_OUT ?? ".eval-out";
const BASELINE = process.env.SONNY_EVAL_BASELINE ?? "golden/verdict/_baseline.json";

export async function loadGolden(subset: EvalSubset): Promise<GoldenTarget[]> {
  const files = (await fs.readdir(GOLDEN_DIR)).filter(
    (f) => f.endsWith(".json") && !f.startsWith("_"),
  );
  const all: GoldenTarget[] = [];
  for (const f of files) {
    const raw = JSON.parse(await fs.readFile(path.join(GOLDEN_DIR, f), "utf8"));
    all.push(GoldenTarget.parse(raw)); // validate on load
  }
  if (subset === "full") return all;
  const cfg = SubsetConfig.parse(
    JSON.parse(await fs.readFile(path.join(GOLDEN_DIR, "_subset.json"), "utf8")),
  );
  return all.filter((t) => cfg.fast.includes(t.target));
}

async function scoreTarget(g: GoldenTarget, deps: EngineDeps): Promise<TargetScore> {
  // Run N times to measure stability; keep the last artifacts for the rest.
  const verdicts: string[] = [];
  let last: RunArtifacts | null = null;
  for (let i = 0; i < REPEATS; i++) {
    const art = await deps.runOnce(g.target);
    verdicts.push(art.briefing.verdict);
    last = art;
  }
  const a = last!;
  const judge = makeJudge(deps.judgeModel, deps.judgeModelId);

  const metrics: MetricResult[] = [
    groundingIntegrity(a),
    computationGrounding(a),
    retrievalRecall(a, g),
    kolPrecisionAtK(a, g),
    developabilityCatchRate(a, g),
    verdictInBand(a, g),
    verdictStability(verdicts),
    costLatency(a),
    figureGrounding(a),
    await judge.faithfulness(a),
    await judge.unsupportedSentenceRatio(a),
    await judge.claimProbes(a, g),
  ];

  return {
    target: g.target,
    label: g.label,
    verdict: mode(verdicts),
    trap: !!g.trap,
    metrics,
  };
}

function mode(xs: string[]): string {
  const d: Record<string, number> = {};
  for (const x of xs) d[x] = (d[x] ?? 0) + 1;
  return Object.entries(d).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

export async function runEval(
  deps: EngineDeps,
  subset: EvalSubset = "fast",
  backend = process.env.SONNY_BACKEND ?? "ollama",
): Promise<number> {
  const golden = await loadGolden(subset);
  const targets: TargetScore[] = [];
  for (const g of golden) {
    // eslint-disable-next-line no-console
    console.log(`[eval] ${g.target} x${REPEATS}`);
    targets.push(await scoreTarget(g, deps));
  }

  const sc: Scorecard = {
    runAt: new Date().toISOString(),
    backend,
    subset,
    targets,
    aggregates: aggregate(targets),
  };
  await writeScorecard(sc, OUT_DIR);

  const reg = await checkRegression(sc, BASELINE);
  const failed = reg.hardFailures.length > 0 || reg.regressed.length > 0 || reg.belowFloor.length > 0;
  if (failed) {
    console.error("[eval] FAIL");
    if (reg.hardFailures.length) console.error("  grounding failures:", reg.hardFailures);
    for (const r of reg.regressed)
      console.error(`  regression ${r.metric}: ${r.current.toFixed(3)} < ${r.baseline.toFixed(3)} (tol ${r.tolerance})`);
    if (reg.belowFloor.length) console.error("  below floor:", reg.belowFloor);
    return 1;
  }
  console.log("[eval] PASS", sc.aggregates);
  return 0;
}

// CLI entry: `pnpm --filter @sonny/eval exec tsx src/runner.ts -- --subset fast`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { makeRunOnce, currentBackend } = await import('./engine.js');
  const { makeModel, MODEL_ROUTER } = await import('@mrsirquanzo/sonny-core');
  const subset = (process.argv.includes('--subset')
    ? process.argv[process.argv.indexOf('--subset') + 1]
    : 'fast') as EvalSubset;
  const code = await runEval(
    { runOnce: makeRunOnce(), judgeModel: makeModel(), judgeModelId: MODEL_ROUTER.verifier },
    subset,
    currentBackend(),
  );
  process.exit(code);
}
