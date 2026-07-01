import { RecommendationSchema, type Recommendation, type Section, type Claim, type Evidence } from '@mrsirquanzo/sonny-shared';
import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

const SynthesisSchema = RecommendationSchema.extend({ executiveRead: z.string().min(1) });

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

export async function synthesizeRecommendation(opts: {
  sections: Section[]; weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[]; model: StructuredModel;
}): Promise<{ recommendation: Recommendation; executiveRead: string }> {
  const { sections, weighing, evidence, model } = opts;

  const digest = sections.map((s) => `## ${s.title} [${s.rag}]\n${s.takeaway}\n${claimLines(s.claims)}`).join('\n\n')
    + `\n\n## Cross-thread weighing\n${weighing.takeaway}\n${claimLines(weighing.claims)}`
    + devLines(sections);

  const draft = await model.generateStructured({
    system: `You are the lead scientist writing the recommendation for a target-assessment briefing. Base your judgment ONLY on the verified findings provided - do not introduce facts that are not in them. Decide a verdict: "go" (pursue), "watch" (monitor, not yet), or "no-go" (do not pursue). Write a one-line thesis, a bull case and a bear case (each a list of points, every point citing the evidence id(s) it rests on, copied verbatim from the findings), the conditions that would change the verdict, and a 3-4 sentence executive read (what the target is, why it matters, the core bull, the core bear, the call). The verdict is your conditioned judgment, not a fact. Some findings carry an AUDIT note (a methodological bias risk and explanation). When you cite such a finding, state the finding AND its audit caveat in the same sentence - report what was found, then note the limitation. Never drop a finding because of a methodological flag; surface the context. A severe developability liability is a dealbreaker - if one is present the verdict cannot be "go". Weigh significant developability risks in the bear case.`,
    prompt: `TARGET FINDINGS (verified):\n${digest}\n\nReturn the verdict, thesis, bull, bear, conditions, and executiveRead.`,
    schema: SynthesisSchema,
    model: MODEL_ROUTER.writer,
  });

  const validIds = new Set(evidence.map((e) => e.id));
  const clean = (points: { point: string; citations: string[] }[]) =>
    points.map((p) => ({ point: p.point, citations: p.citations.filter((id) => validIds.has(id)) }));

  const severe = sections.some((s) => (s.developabilityRisks ?? []).some((r) => r.severity === 'severe'));
  const recommendation: Recommendation = {
    verdict: severe ? 'no-go' : draft.verdict, thesis: draft.thesis,
    bull: clean(draft.bull), bear: clean(draft.bear), conditions: draft.conditions,
  };
  return { recommendation, executiveRead: draft.executiveRead };
}
