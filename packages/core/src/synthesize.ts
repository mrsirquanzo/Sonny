import { RecommendationSchema, type Recommendation, type Section, type Claim, type Evidence } from '@sonny/shared';
import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

const SynthesisSchema = RecommendationSchema.extend({ executiveRead: z.string().min(1) });

function claimLines(claims: Claim[]): string {
  return claims.map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
}

export async function synthesizeRecommendation(opts: {
  sections: Section[]; weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[]; model: StructuredModel;
}): Promise<{ recommendation: Recommendation; executiveRead: string }> {
  const { sections, weighing, evidence, model } = opts;

  const digest = sections.map((s) => `## ${s.title} [${s.rag}]\n${s.takeaway}\n${claimLines(s.claims)}`).join('\n\n')
    + `\n\n## Cross-thread weighing\n${weighing.takeaway}\n${claimLines(weighing.claims)}`;

  const draft = await model.generateStructured({
    system: `You are the lead scientist writing the recommendation for a target-assessment briefing. Base your judgment ONLY on the verified findings provided - do not introduce facts that are not in them. Decide a verdict: "go" (pursue), "watch" (monitor, not yet), or "no-go" (do not pursue). Write a one-line thesis, a bull case and a bear case (each a list of points, every point citing the evidence id(s) it rests on, copied verbatim from the findings), the conditions that would change the verdict, and a 3-4 sentence executive read (what the target is, why it matters, the core bull, the core bear, the call). The verdict is your conditioned judgment, not a fact.`,
    prompt: `TARGET FINDINGS (verified):\n${digest}\n\nReturn the verdict, thesis, bull, bear, conditions, and executiveRead.`,
    schema: SynthesisSchema,
    model: MODEL_ROUTER.writer,
  });

  const validIds = new Set(evidence.map((e) => e.id));
  const clean = (points: { point: string; citations: string[] }[]) =>
    points.map((p) => ({ point: p.point, citations: p.citations.filter((id) => validIds.has(id)) }));

  const recommendation: Recommendation = {
    verdict: draft.verdict, thesis: draft.thesis,
    bull: clean(draft.bull), bear: clean(draft.bear), conditions: draft.conditions,
  };
  return { recommendation, executiveRead: draft.executiveRead };
}
