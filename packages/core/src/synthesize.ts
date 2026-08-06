import { RecommendationSchema, type Recommendation, type Section, type Claim, type Evidence, type ContradictionFlag } from '@mrsirquanzo/sonny-shared';
import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { groundNarrative } from './narrativeGrounding.js';

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

/**
 * Every fact the writer was shown, as plain text.
 *
 * This is the entailment set for the memo's free prose. It is exactly what the
 * digest carries: verified section claims, verified cross-thread claims, the
 * developability risks and the contradiction flags - each of which is bound to
 * an evidence id elsewhere in the pipeline. The section takeaways are NOT here:
 * they are summaries of these same claims, not independent facts.
 */
function groundingFacts(
  sections: Section[], weighing: { claims: Claim[] }, contradictions: ContradictionFlag[],
): string[] {
  return [
    ...sections.flatMap((s) => s.claims.map((c) => c.text)),
    ...weighing.claims.map((c) => c.text),
    ...sections.flatMap((s) => (s.developabilityRisks ?? [])
      .filter((r) => r.severity !== 'manageable')
      .map((r) => `${r.severity} ${r.category} developability risk: ${r.explanation}`)),
    ...contradictions.map((f) => `Evidence conflict on ${f.endpoint}: ${f.explanation}`),
  ];
}

export async function synthesizeRecommendation(opts: {
  target: string; sections: Section[]; weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[]; model: StructuredModel; contradictions?: ContradictionFlag[];
  /**
   * Judge for the memo's free prose. Defaults to the writer, which checks the
   * output but is NOT decorrelated; callers should pass a different family.
   */
  verifierModel?: StructuredModel;
}): Promise<{ recommendation: Recommendation; executiveRead: string }> {
  const { target, sections, weighing, evidence, model } = opts;
  const contradictions = opts.contradictions ?? [];
  const verifierModel = opts.verifierModel ?? model;

  // Abstention gate (deterministic, no model call). Counts verified research
  // findings: claims a specialist asserted and `verifyClaims` supported.
  //
  // Curated database cards are merged into Section.claims AFTER verification
  // (`mergeStructuredClaims`), carrying an assigned 0.9 confidence rather than
  // a verifier verdict, so they are excluded here. Otherwise two Open Targets
  // cards would clear the gate on a target whose every model-generated claim
  // failed verification, and the memo would argue a case it cannot support.
  //
  // Fewer than two means there is nothing to weigh into a two-sided bull-and-bear.
  const supportedCount = sections.reduce(
    (n, s) => n + s.claims.filter((c) => c.provenance !== 'deterministic').length,
    0,
  );
  if (supportedCount < 2) {
    const recommendation: Recommendation = {
      verdict: 'insufficient-evidence',
      thesis: `Insufficient verified evidence to assess ${target}.`,
      framing: `The retrieved evidence is too thin to characterize ${target} on the questions that matter; this memo abstains rather than argue a case in either direction.`,
      bull: [], bear: [], conditions: [],
      bottomLine: `Not enough verified evidence to support an assessment. Treat any read on ${target} as premature until the gaps below are filled.`,
    };
    return {
      recommendation,
      executiveRead: `Fewer than two verified findings support an assessment of ${target}; the dossier abstains rather than synthesize an unsupported read.`,
    };
  }

  // Claims only, no takeaways. A takeaway is a one-line summary of the claims
  // beneath it and carries no citation; presenting it next to them let the
  // writer lift an uncited sentence and treat it as an independent finding.
  const digest = sections.map((s) => `## ${s.title} [${s.rag}]\n${claimLines(s.claims)}`).join('\n\n')
    + `\n\n## Cross-thread weighing\n${claimLines(weighing.claims)}`
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

  // A case point may cite only what the writer was actually shown: the evidence
  // behind a verified claim, a developability risk, or a contradiction. The old
  // gate accepted any id in the whole store, so a point resting on evidence that
  // supported nothing kept a citation that looked like backing and was not.
  const existingIds = new Set(evidence.map((e) => e.id));
  const citableIds = new Set([
    ...sections.flatMap((s) => s.claims.flatMap((c) => c.citations)),
    ...weighing.claims.flatMap((c) => c.citations),
    ...sections.flatMap((s) => (s.developabilityRisks ?? []).map((r) => r.evidenceId)),
    ...contradictions.flatMap((f) => [f.evidenceIdA, f.evidenceIdB]),
  ].filter((id) => existingIds.has(id)));
  // Uncited points are DROPPED, not shipped bare. Filtering the id list without
  // filtering the point is what let an entirely uncited bull/bear point into the
  // memo - the exact thing "no citation, no claim" forbids.
  const clean = (points: { point: string; citations: string[] }[]) =>
    points
      .map((p) => ({ point: p.point, citations: p.citations.filter((id) => citableIds.has(id)) }))
      .filter((p) => p.citations.length > 0);

  // Free prose carries no citations at all, so it is held to entailment against
  // the same verified findings instead. Sentences that assert more are dropped;
  // if a whole passage goes, the memo says so rather than quietly narrowing.
  const facts = groundingFacts(sections, weighing, contradictions);
  const ground = (text: string, mode?: 'assertion' | 'proposal') =>
    groundNarrative({ text, facts, model: verifierModel, ...(mode ? { mode } : {}) });
  const [framing, bottomLine, executiveRead, conditions] = await Promise.all([
    ground(draft.framing),
    ground(draft.bottomLine),
    ground(draft.executiveRead),
    // Conditions are proposals, not assertions: "run a Phase 1 in PDAC" cannot
    // be entailed by findings about today. Only the facts a condition asserts
    // along the way are checked, or every condition would strip and the memo
    // would lose the section that tells the team what to do next.
    Promise.all(draft.conditions.map((c) => ground(c, 'proposal'))),
  ]);

  const severe = sections.some((s) => (s.developabilityRisks ?? []).some((r) => r.severity === 'severe'));
  const framingText = framing.text
    || `Only the verified findings below can be stated about ${target}; a broader framing was not supported by them.`;
  const recommendation: Recommendation = {
    verdict: severe ? 'no-go' : draft.verdict,
    // thesis retained for schema/back-compat; the framing is the user-facing lead.
    thesis: framingText,
    framing: framingText,
    bull: clean(draft.bull), bear: clean(draft.bear),
    bottomLine: bottomLine.text
      || `The verified findings do not support a bottom-line read on ${target} beyond the individual findings themselves.`,
    conditions: conditions.map((c) => c.text).filter(Boolean),
  };
  return {
    recommendation,
    executiveRead: executiveRead.text
      || `The verified findings do not support an executive read on ${target} beyond the individual findings themselves.`,
  };
}
