import { z } from 'zod';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import { MODEL_ROUTER, type StructuredModel } from './model.js';
import type { ResearchContext, ThreadBrief } from './researcher.js';
import { RESEARCH_ROSTER } from './researchRoster.js';

export const CANONICAL_CATEGORIES = [
  { id: 'target_biology', role: 'Establish the target biology and target-level evidence relevant to the modality.' },
  { id: 'moa_pathway', role: 'Assess whether the mechanism and pathway biology support the modality.' },
  { id: 'disease_indications', role: 'Evaluate indication fit, patient selection, and the therapeutic window.' },
  { id: 'clinical_landscape', role: 'Map clinical and translational precedent for the target and modality.' },
  { id: 'competitive_ip', role: 'Assess competition, differentiation, intellectual property, and freedom to operate.' },
  { id: 'modality_developability', role: 'Evaluate modality-specific safety, tractability, and developability risks.' },
] as const;

const SpecialistSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  title: z.string().min(1),
  objective: z.string().min(1),
  promptHint: z.string().min(1).refine(
    (value) => /(?:^|\s)BOUNDARY:\s*\S[\s\S]*$/.test(value.trim()),
    'promptHint must end with a BOUNDARY: clause',
  ),
  weight: z.number().min(0).max(1),
}).strict();

const PlanSchema = z.object({
  specialists: z.array(SpecialistSchema).min(3),
  rationale: z.string().min(1),
}).strict();

export function isAntibodyModality(modality?: string): boolean {
  const normalized = modality?.trim().toLowerCase();
  if (!normalized) return true;
  return /\b(?:adc|antibod(?:y|ies)|antibody[ -]drug conjugates?|immunoconjugates?)\b/.test(normalized);
}

export async function composeRoster(opts: {
  target: string;
  context?: ResearchContext;
  model: StructuredModel;
  emit: (e: TraceEvent) => void;
}): Promise<ThreadBrief[]> {
  const safeEmit = (event: TraceEvent): void => {
    try {
      opts.emit(event);
    } catch {
      // Trace sinks must not make roster composition fail.
    }
  };

  try {
    const modality = opts.context?.modality?.trim() || 'not specified';
    const indication = opts.context?.indication?.trim() || 'not specified';
    const categories = CANONICAL_CATEGORIES
      .map(({ id, role }) => `- ${id}: ${role}`)
      .join('\n');
    const system = `You compose a bounded specialist rubric to assess whether TARGET ${opts.target} is a viable ${modality} target in ${indication}.

Anchor the rubric to these six canonical categories:
${categories}

Rules:
- Return between 3 and 7 specialists.
- Keep categories that apply and drop only categories that are genuinely not applicable to this modality.
- Rewrite every kept title, objective, and promptHint for the modality, target, and indication.
- Every promptHint must end with a BOUNDARY: clause that names what the specialist does not cover.
- You may add at most one modality-specific specialist when a critical area has no canonical owner.
- Reuse the canonical snake_case id whenever its category is kept. Any added id must be new and snake_case.
- Set weight from 0 to 1 to express importance for this modality.
- Compose the rubric only. Do not add claims, relax citation requirements, change evidence handling, change verification, change abstention, select tools, or change the final verdict.`;

    const generated = await opts.model.generateStructured({
      system,
      prompt: `TARGET: ${opts.target}\nINDICATION: ${indication}\nMODALITY: ${modality}\n\nReturn the specialist rubric and a concise rationale.`,
      schema: PlanSchema,
      model: MODEL_ROUTER.planner,
    });
    const plan = PlanSchema.parse(generated);
    const specialists = plan.specialists.slice(0, 7);
    const roster = specialists.map(({ id, title, objective, promptHint }) => ({
      id, title, objective, promptHint,
    }));

    safeEmit({
      type: 'plan_composed',
      modality,
      specialists: specialists.map(({ id, title, weight }) => ({ id, title, weight })),
      rationale: plan.rationale,
    });
    return roster;
  } catch (err) {
    safeEmit({ type: 'error', message: `planner failed: ${String(err)}` });
    return RESEARCH_ROSTER;
  }
}
