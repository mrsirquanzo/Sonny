import { z } from "zod";
import type { GoldenTarget } from "./goldenSet.js";
import {
  AnalysisResultsSchema, resolveResultBinding, sha256CanonicalJson,
} from '@mrsirquanzo/sonny-shared';

/**
 * Metrics for scoring one Sonny run against one golden target.
 *
 * Two families:
 *  - Deterministic (grounding, retrieval recall, KOL precision, developability
 *    catch, verdict band, stability, cost/latency). No model calls.
 *  - Judge-based (faithfulness, unsupported-sentence-ratio, claim probes). One
 *    decorrelated model, following Sonny's own rule: the judge is never the
 *    writer's family. Calibrate it against a small human-labeled slice before
 *    trusting the numbers.
 *
 * The metrics consume `RunArtifacts`, not the engine directly, so they stay
 * decoupled from how a run is produced.
 */

// --- Structural mirrors of @mrsirquanzo/sonny-shared (structural typing accepts the real
// objects; kept local so eval has no deep coupling to core internals). ---
export interface EvidenceLike {
  id: string; // e.g. "PMID:23208492", "PMCID:PMC1#sec-0", "PMCID:PMC1#fig-3"
  passage?: string;
  snippet?: string;
  title?: string;
  kind?: string;
  computationId?: string;
  resultKeys?: string[];
  resultsJsonHash?: string;
  raw?: unknown;
  exitStatus?: { exitCode: number | null; timedOut: boolean; signal: string | null };
}
export interface ClaimLike {
  id?: string;
  text: string;
  citations: string[]; // evidence ids
  confidence?: number;
  computedBinding?: {
    computationId: string;
    resultKey: string;
    assertedValue: number;
    assertedUnit: string;
  };
  executionMode?: 'live' | 'cached';
  replayVerification?: 'verified' | 'not_run';
  originVerification?: 'verified' | 'none';
  llmVerdict?: 'supported' | 'unsupported' | 'overreach';
  verifierDecorrelated?: boolean;
}
export interface DevelopabilityRiskLike {
  category: string;
  severity: "manageable" | "significant" | "severe";
}
export interface KOLClusterLike {
  labs: { investigator: string; institution?: string }[];
}
export interface BriefingLike {
  verdict: GoldenTarget["label"];
  thesis?: string;
  executiveRead?: string;
  bull?: string[];
  bear?: string[];
  sections: {
    id: string;
    claims: ClaimLike[];
    developabilityRisks?: DevelopabilityRiskLike[];
  }[];
  kolCluster?: KOLClusterLike;
}

/** What the runner captures for one execution of `deep <target>`. */
export interface RunArtifacts {
  briefing: BriefingLike;
  evidenceById: Map<string, EvidenceLike>;
  elapsedMs: number;
  costUsd?: number;
  tokens?: number;
  figureReadings?: import('@mrsirquanzo/sonny-shared').FigureReading[];
}

export interface MetricResult {
  name: string;
  score: number; // 0..1 where higher is better, or a raw ratio noted in detail
  pass: boolean;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allClaims(b: BriefingLike): ClaimLike[] {
  return b.sections.flatMap((s) => s.claims ?? []);
}

/** Bare PMIDs present anywhere in the evidence store ids. */
function pmidsInStore(evidenceById: Map<string, EvidenceLike>): Set<string> {
  const out = new Set<string>();
  for (const id of evidenceById.keys()) {
    const m = id.match(/PMID:(\d+)/);
    if (m) out.add(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic metrics
// ---------------------------------------------------------------------------

/**
 * Grounding integrity: fraction of shipped claims whose citations all resolve
 * to a real evidence id in the store. By Sonny's "no token, no ship" spine this
 * should be ~1.0; anything less is a regression in the grounding gate.
 */
export function groundingIntegrity(a: RunArtifacts): MetricResult {
  const claims = allClaims(a.briefing);
  const offenders: ClaimLike[] = [];
  for (const c of claims) {
    const ok =
      c.citations.length > 0 &&
      c.citations.every((id) => a.evidenceById.has(id));
    if (!ok) offenders.push(c);
  }
  const score = claims.length ? 1 - offenders.length / claims.length : 1;
  return {
    name: "grounding_integrity",
    score,
    pass: score >= 0.99,
    detail: { total: claims.length, offenders: offenders.map((c) => c.text) },
  };
}

/**
 * Mandatory computed-claim grounding: every shipped binding must resolve to a
 * successful computation evidence record, an untampered typed result, a value
 * and unit match, and an allowed live/cached verification state.
 */
export function computationGrounding(a: RunArtifacts): MetricResult {
  const computed = allClaims(a.briefing).filter((claim) =>
    claim.computedBinding
    || claim.citations.some((citation) => a.evidenceById.get(citation)?.kind === 'computation'));
  const offenders: { claim: string; reason: string }[] = [];
  for (const claim of computed) {
    const binding = claim.computedBinding;
    if (!binding) {
      offenders.push({ claim: claim.text, reason: 'computation citation lacks a structured binding' });
      continue;
    }
    const evidence = claim.citations
      .map((id) => a.evidenceById.get(id))
      .find((candidate) => candidate?.kind === 'computation' && candidate.computationId === binding.computationId);
    let reason: string | undefined;
    if (!evidence) reason = 'missing matching computation evidence';
    else if (evidence.exitStatus?.exitCode !== 0 || evidence.exitStatus.timedOut || evidence.exitStatus.signal !== null) {
      reason = 'computation exit was not successful';
    } else if (!evidence.resultKeys?.includes(binding.resultKey)) reason = 'result key absent from evidence';
    else {
      const results = AnalysisResultsSchema.safeParse(evidence.raw);
      if (!results.success || sha256CanonicalJson(results.data) !== evidence.resultsJsonHash) {
        reason = 'results schema or content hash mismatch';
      } else {
        const result = resolveResultBinding(results.data, binding.resultKey);
        if (!result || result.value === null) reason = 'bound typed result is missing or null';
        else if (result.unit !== binding.assertedUnit) reason = 'asserted unit mismatch';
        else if (Math.abs(result.value - binding.assertedValue) > result.tolerance) reason = 'asserted value mismatch';
      }
    }
    const trustedLive = claim.executionMode === 'live' && claim.replayVerification === 'verified'
      && claim.originVerification === 'none';
    const trustedCached = claim.executionMode === 'cached' && claim.replayVerification === 'not_run'
      && claim.originVerification === 'verified';
    if (!reason && !trustedLive && !trustedCached) reason = 'verification state is not trusted';
    if (!reason && (claim.llmVerdict !== 'supported' || claim.verifierDecorrelated !== true)) {
      reason = 'decorrelated LLM verification is absent or not supported';
    }
    if (reason) offenders.push({ claim: claim.text, reason });
  }
  const score = computed.length ? 1 - offenders.length / computed.length : 1;
  return {
    name: 'computation_grounding', score, pass: score === 1,
    detail: { total: computed.length, offenders },
  };
}

/** Retrieval recall: fraction of the golden seminal PMIDs pulled into the store. */
export function retrievalRecall(
  a: RunArtifacts,
  g: GoldenTarget,
): MetricResult {
  if (g.seminalPmids.length === 0) {
    return { name: "retrieval_recall", score: 1, pass: true, detail: "no gold PMIDs" };
  }
  const have = pmidsInStore(a.evidenceById);
  const found = g.seminalPmids.filter((p) => have.has(p));
  const missed = g.seminalPmids.filter((p) => !have.has(p));
  const score = found.length / g.seminalPmids.length;
  return {
    name: "retrieval_recall",
    score,
    pass: score >= 0.6,
    detail: { found, missed },
  };
}

/** KOL precision@k against the golden expected labs. `mustAppear` labs must land. */
export function kolPrecisionAtK(
  a: RunArtifacts,
  g: GoldenTarget,
  k = 3,
): MetricResult {
  const named = (a.briefing.kolCluster?.labs ?? [])
    .slice(0, k)
    .map((l) => l.investigator.toLowerCase());
  const norm = (s: string) => s.toLowerCase().trim();
  const matched = g.expectedKols.filter((e) =>
    named.some((n) => n.includes(norm(e.investigator)) || norm(e.investigator).includes(n)),
  );
  const missedMust = g.expectedKols
    .filter((e) => e.mustAppear)
    .filter((e) => !matched.includes(e));
  const denom = g.expectedKols.length || 1;
  const score = matched.length / denom;
  return {
    name: "kol_precision_at_k",
    score,
    pass: missedMust.length === 0,
    detail: { named, matched: matched.map((m) => m.investigator), missedMust: missedMust.map((m) => m.investigator) },
  };
}

/** Developability catch rate: known liabilities flagged at >= minSeverity. */
export function developabilityCatchRate(
  a: RunArtifacts,
  g: GoldenTarget,
): MetricResult {
  if (g.knownDevelopabilityRisks.length === 0) {
    return { name: "developability_catch", score: 1, pass: true, detail: "none expected" };
  }
  const rank = { manageable: 1, significant: 2, severe: 3 } as const;
  const flagged = a.briefing.sections.flatMap((s) => s.developabilityRisks ?? []);
  const caught = g.knownDevelopabilityRisks.filter((known) =>
    flagged.some(
      (f) => f.category === known.category && rank[f.severity] >= rank[known.minSeverity],
    ),
  );
  const score = caught.length / g.knownDevelopabilityRisks.length;
  return {
    name: "developability_catch",
    score,
    pass: score >= 0.5,
    detail: { caught: caught.map((c) => c.category) },
  };
}

/** Verdict lands inside the allowed band. */
export function verdictInBand(a: RunArtifacts, g: GoldenTarget): MetricResult {
  const pass = g.allowedVerdicts.includes(a.briefing.verdict);
  return {
    name: "verdict_in_band",
    score: pass ? 1 : 0,
    pass,
    detail: { got: a.briefing.verdict, allowed: g.allowedVerdicts },
  };
}

/** Verdict stability across N repeated runs of the same target. */
export function verdictStability(verdicts: string[]): MetricResult {
  const dist: Record<string, number> = {};
  for (const v of verdicts) dist[v] = (dist[v] ?? 0) + 1;
  const modeCount = Math.max(...Object.values(dist), 0);
  const flipRate = verdicts.length ? 1 - modeCount / verdicts.length : 0;
  return {
    name: "verdict_stability",
    score: 1 - flipRate,
    pass: flipRate <= 0.2,
    detail: { distribution: dist, flipRate },
  };
}

/** Cost and latency pulled straight from the run artifacts (regression + budget). */
export function costLatency(a: RunArtifacts): MetricResult {
  return {
    name: "cost_latency",
    score: 1, // informational; gate via baseline diff in the scorecard
    pass: true,
    detail: { elapsedMs: a.elapsedMs, costUsd: a.costUsd, tokens: a.tokens },
  };
}

const FLOOR_FIGURE_GROUNDING = 0.5;

/**
 * figure_grounding: of claims citing a figure evidence id, the fraction whose
 * cited figures are caption-anchored (have a low-risk value). Guards against a
 * dossier filling up with pixel-guessed numbers. A distribution, so it is a
 * band (scorecard REGRESSION_TOLERANCE) plus an absolute floor (ABSOLUTE_FLOORS),
 * gated only when n >= 3.
 */
export function figureGrounding(a: RunArtifacts): MetricResult {
  const isFig = (id: string) => id.includes('#fig-');
  const figClaims = allClaims(a.briefing).filter((c) => c.citations.some(isFig));
  const n = figClaims.length;
  const anchored = new Set<string>();
  for (const r of a.figureReadings ?? []) {
    if (r.extractedValues.some((v) => v.readRisk === 'low')) anchored.add(r.evidenceId);
  }
  const low = figClaims.filter((c) =>
    c.citations.filter(isFig).every((id) => anchored.has(id)),
  ).length;
  const score = n ? low / n : 1;
  const gated = n >= 3;
  return {
    name: 'figure_grounding',
    score,
    pass: gated ? score >= FLOOR_FIGURE_GROUNDING : true,
    detail: { n, low, gated, floor: FLOOR_FIGURE_GROUNDING },
  };
}

// ---------------------------------------------------------------------------
// Judge-based metrics (decorrelated model)
// ---------------------------------------------------------------------------

// Minimal structural mirror of @mrsirquanzo/sonny-core's StructuredModel.
export interface StructuredModelLike {
  generateStructured<T>(args: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    model?: string;
  }): Promise<T>;
}

const JudgeVerdict = z.object({
  verdict: z.enum(["supported", "unsupported", "overreach", "refuted"]),
  rationale: z.string(),
});

export interface Judge {
  faithfulness(a: RunArtifacts, sampleSize?: number): Promise<MetricResult>;
  unsupportedSentenceRatio(a: RunArtifacts): Promise<MetricResult>;
  claimProbes(a: RunArtifacts, g: GoldenTarget): Promise<MetricResult>;
}

/**
 * Build a judge on a model decorrelated from the writer. Pass the verifier-role
 * model (e.g. sonnet when the writer is opus, llama when the writer is qwen).
 */
export function makeJudge(model: StructuredModelLike, judgeModel?: string): Judge {
  const call = (system: string, prompt: string) =>
    model.generateStructured({ system, prompt, schema: JudgeVerdict, model: judgeModel });

  return {
    async faithfulness(a, sampleSize = 20) {
      const claims = allClaims(a.briefing).filter((c) => c.citations.length);
      const sample = claims.slice(0, sampleSize);
      let supported = 0;
      const failures: { text: string; verdict: string }[] = [];
      for (const c of sample) {
        const evidence = c.citations
          .map((id) => a.evidenceById.get(id))
          .filter(Boolean)
          .map((e) => `[${(e as EvidenceLike).id}] ${(e as EvidenceLike).passage ?? (e as EvidenceLike).snippet ?? (e as EvidenceLike).title ?? ""}`)
          .join("\n");
        const r = await call(
          "You are a strict biomedical fact-checker. Decide whether the cited evidence supports the claim. 'overreach' means the evidence is related but weaker than the claim states. Answer only from the evidence given.",
          `CLAIM:\n${c.text}\n\nCITED EVIDENCE:\n${evidence}`,
        );
        if (r.verdict === "supported") supported++;
        else failures.push({ text: c.text, verdict: r.verdict });
      }
      const score = sample.length ? supported / sample.length : 1;
      return {
        name: "faithfulness",
        score,
        pass: score >= 0.9,
        detail: { sampled: sample.length, failures },
      };
    },

    async unsupportedSentenceRatio(a) {
      // An abstention (insufficient-evidence) synthesizes no recommendation: bull/bear
      // are empty and thesis/executiveRead are structural refusal boilerplate with no
      // backing claims. This metric scores prose overreach beyond the evidence, which
      // is not applicable when nothing was synthesized. Exempt it (and skip judge calls),
      // the same way claimProbes early-returns on "no probes".
      if (a.briefing.verdict === 'insufficient-evidence') {
        return { name: 'unsupported_sentence_ratio', score: 1, pass: true, detail: { abstained: true } };
      }

      const prose = [
        a.briefing.thesis,
        a.briefing.executiveRead,
        ...(a.briefing.bull ?? []),
        ...(a.briefing.bear ?? []),
      ]
        .filter(Boolean)
        .join(" ");
      const sentences = prose.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 15);
      const verified = allClaims(a.briefing).map((c) => c.text).join("\n");
      let unsupported = 0;
      const offenders: string[] = [];
      for (const s of sentences) {
        const r = await call(
          "You check whether a sentence from a research summary is entailed by the set of verified claims. 'unsupported' means the sentence asserts something not backed by any verified claim.",
          `SENTENCE:\n${s}\n\nVERIFIED CLAIMS:\n${verified}`,
        );
        if (r.verdict === "unsupported" || r.verdict === "overreach") {
          unsupported++;
          offenders.push(s);
        }
      }
      const ratio = sentences.length ? unsupported / sentences.length : 0;
      return {
        name: "unsupported_sentence_ratio",
        score: 1 - ratio,
        pass: ratio <= 0.1,
        detail: { sentences: sentences.length, ratio, offenders },
      };
    },

    async claimProbes(a, g) {
      if (g.claimProbes.length === 0)
        return { name: "claim_probes", score: 1, pass: true, detail: "no probes" };
      const dossier = allClaims(a.briefing).map((c) => c.text).join("\n");
      let correct = 0;
      const failures: unknown[] = [];
      for (const probe of g.claimProbes) {
        const r = await call(
          "Given a dossier of grounded claims, decide the dossier's stance on a probe statement: 'supported' (asserts it), 'refuted' (contradicts it), or 'unsupported' (says nothing either way).",
          `PROBE:\n${probe.statement}\n\nDOSSIER CLAIMS:\n${dossier}`,
        );
        const got = r.verdict === "overreach" ? "supported" : r.verdict;
        if (got === probe.expected) correct++;
        else failures.push({ probe: probe.statement, expected: probe.expected, got });
      }
      const score = correct / g.claimProbes.length;
      return { name: "claim_probes", score, pass: score >= 0.8, detail: { failures } };
    },
  };
}
