import { RecommendationSchema, type Recommendation, type Section, type Claim, type Evidence, type ContradictionFlag } from '@mrsirquanzo/sonny-shared';
import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { evaluateAbstention, type AbstentionVerdict } from './conclusions/coverage.js';

// The model produces a balanced, non-directive memo. `verdict` is kept as an
// internal evidence-posture (for eval/abstention), never surfaced as advice.
const SynthesisSchema = z.object({
  verdict: RecommendationSchema.shape.verdict,
  framing: z.string().min(1),
  bull: RecommendationSchema.shape.bull,
  bear: RecommendationSchema.shape.bear,
  bottomLine: z.string().min(1),
  conditions: z.array(z.string()),
  executiveRead: z.string().min(1),
});

function claimLines(claims: Claim[]): string {
  return claims.map((c) => {
    const cites = c.citations.map((id) => `[${id}]`).join(' ');
    const flags = (c.redFlags ?? []).filter((f) => f.biasRisk === 'moderate' || f.biasRisk === 'high');
    const note = flags.length
      ? ` (AUDIT: ${flags.map((f) => `${f.biasRisk} ${f.category} - ${f.explanation}`).join('; ')})`
      : '';
    return `- ${c.text} ${cites}${note}`;
  }).join('\n');
}

function devLines(sections: Section[]): string {
  const risks = sections.flatMap((s) => (s.developabilityRisks ?? []).filter((r) => r.severity !== 'manageable'));
  if (!risks.length) return '';
  return `\n\n## Developability risks\n`
    + risks.map((r) => `- ${r.severity} ${r.category} [${r.evidenceId}] - ${r.explanation}`).join('\n');
}

function contradictionLines(flags: { endpoint: string; explanation: string; evidenceIdA: string; evidenceIdB: string }[]): string {
  if (!flags.length) return '';
  return `\n\n## Contradictions\n`
    + flags.map((f) => `- ${f.endpoint}: ${f.explanation} [${f.evidenceIdA}] vs [${f.evidenceIdB}]`).join('\n');
}

export async function synthesizeRecommendation(opts: {
  target: string; sections: Section[]; weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[]; model: StructuredModel; contradictions?: ContradictionFlag[];
  /**
   * The run's abstention verdict, from `runDeepResearch`. Supplied by callers
   * that ran the research; derived from the sections otherwise, so a caller
   * that forgets to forward it still gets the coverage criterion rather than
   * silently falling back to a claim count.
   */
  abstention?: AbstentionVerdict;
}): Promise<{ recommendation: Recommendation; executiveRead: string }> {
  const { target, sections, weighing, evidence, model } = opts;
  const contradictions = opts.contradictions ?? [];

  // Abstention gate (deterministic, no model call).
  //
  // The criterion is COVERAGE, not a claim count: two verified claims on one
  // axis is not a dossier, and the count could not tell the difference. A run
  // abstains unless at least two axes reached a real conclusion AND both
  // critical axes (target validity, modality feasibility) did - without those
  // there is no thesis to argue either way. `evaluateAbstention` still requires
  // two verified non-deterministic claims, so curated database cards cannot
  // clear the gate on their own; that guarantee is unchanged, it just no longer
  // stands alone.
  const abstention = opts.abstention ?? evaluateAbstention({
    conclusions: sections.flatMap((s) => (s.kind === 'research' && s.conclusion ? [s.conclusion] : [])),
    verifiedClaims: sections.flatMap((s) => s.claims),
  });
  if (!abstention.proceed) {
    const recommendation: Recommendation = {
      verdict: 'insufficient-evidence',
      thesis: `Insufficient verified evidence to assess ${target}.`,
      framing: `The retrieved evidence is too thin to characterize ${target} on the questions that matter; this memo abstains rather than argue a case in either direction.`,
      bull: [], bear: [], conditions: [],
      // The reasons are named, not summarized away. "Not enough evidence" and
      // "Q2 reached no conclusion" call for different follow-up work.
      bottomLine: `Not enough verified evidence to support an assessment (${abstention.reasons.join('; ')}). Treat any read on ${target} as premature until the gaps below are filled.`,
    };
    return {
      recommendation,
      executiveRead: `The research did not establish enough to assess ${target} (${abstention.reasons.join('; ')}); the dossier abstains rather than synthesize an unsupported read.`,
    };
  }

  const digest = sections.map((s) => `## ${s.title} [${s.rag}]\n${s.takeaway}\n${claimLines(s.claims)}`).join('\n\n')
    + `\n\n## Cross-thread weighing\n${weighing.takeaway}\n${claimLines(weighing.claims)}`
    + devLines(sections)
    + contradictionLines(contradictions);

  const draft = await model.generateStructured({
    system: `You are a senior scientist writing a target-assessment memo that SUPPORTS a drug-discovery team's decision - it does not make the decision. NEVER tell the team to pursue, advance, drop, or deprioritize the target; a model's verdict on the same evidence is unstable and it is not your call. Present the evidence both ways and let the scientists judge. Base everything ONLY on the verified findings provided; introduce no outside facts.

Produce:
- framing: 2-3 sentences stating what the target is and holding the central tension honestly (e.g. strong biology but clinically unproven, or compelling with a specific liability). Balanced, never a recommendation.
- bull (the case FOR): the strongest evidence-backed points supporting the target for the scoped indication/modality; every point cites its evidence id(s) verbatim.
- bear (the case AGAINST): the strongest risks, gaps, and liabilities; every point cites evidence id(s). Include any severe developability liability and any listed contradiction (named as an evidence conflict).
- bottomLine: 2-4 sentences giving the most compelling POSITIONING (the specific context/segment/sequencing where the target is strongest, if the evidence supports one), the biggest open risks, and the data or levers that would change the read. Frame the decision as the team's to make; do NOT issue a verdict.
- conditions: the specific experiments or data that would change the assessment.
- executiveRead: a 3-4 sentence balanced synthesis (what it is, the core case for, the core case against, the key uncertainty) - no directive.
- verdict: an INTERNAL evidence-posture label only, never shown to the team: "go" = evidence is strong and consistent, "watch" = mixed or promising-but-unproven, "no-go" = evidence weighs clearly against, "insufficient-evidence" = too thin to say. Choose conservatively; this is a characterization of the evidence, not advice.

Some findings carry an AUDIT note (a methodological bias risk). When you cite such a finding, state the finding AND its caveat in the same sentence; never drop a finding for a flag. Report uncertainty plainly - if clinical evidence is absent, say so.`,
    prompt: `TARGET FINDINGS (verified):\n${digest}\n\nReturn framing, bull, bear, bottomLine, conditions, executiveRead, and the internal verdict.`,
    schema: SynthesisSchema,
    model: MODEL_ROUTER.writer,
  });

  const validIds = new Set(evidence.map((e) => e.id));
  const clean = (points: { point: string; citations: string[] }[]) =>
    points.map((p) => ({ point: p.point, citations: p.citations.filter((id) => validIds.has(id)) }));

  const severe = sections.some((s) => (s.developabilityRisks ?? []).some((r) => r.severity === 'severe'));
  const recommendation: Recommendation = {
    verdict: severe ? 'no-go' : draft.verdict,
    // thesis retained for schema/back-compat; the framing is the user-facing lead.
    thesis: draft.framing,
    framing: draft.framing,
    bull: clean(draft.bull), bear: clean(draft.bear),
    bottomLine: draft.bottomLine,
    conditions: draft.conditions,
  };
  return { recommendation, executiveRead: draft.executiveRead };
}
