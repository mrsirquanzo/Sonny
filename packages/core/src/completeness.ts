import { z } from 'zod';
import type { Section } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

export interface ResearchGap { specialistId: string; question: string; searchQuery: string; reason: string }

const CompletenessSchema = z.object({
  complete: z.boolean(),
  gaps: z.array(z.object({
    specialistId: z.string().min(1),
    question: z.string().min(1),
    searchQuery: z.string().min(1),
    reason: z.string().min(1),
  })).max(5),
});

export async function assessCompleteness(
  sections: Section[], model: StructuredModel,
): Promise<{ complete: boolean; gaps: ResearchGap[] }> {
  const summary = sections.map((s) =>
    `- [${s.rag}] ${s.id} (${s.title}): ${s.takeaway} (${s.claims.length} claims, ${s.sources.length} sources)`,
  ).join('\n');
  return model.generateStructured({
    system: `You are the lead reviewer of a target-assessment dossier. Judge whether the assessment is complete enough for an expert reader. A red or thin section, or an obvious unanswered question (e.g. resistance mechanisms, safety, a missing modality), is a gap. For each gap, name the existing section id it belongs to, a precise follow-up question, a 3-8 keyword searchQuery (no sentences, no punctuation), and the reason. If the dossier is sufficient, set complete=true with no gaps.`,
    prompt: `SECTIONS:\n${summary}\n\nReturn complete and up to 5 gaps, each tagged to one of the section ids above.`,
    schema: CompletenessSchema,
    model: MODEL_ROUTER.specialist,
  });
}
