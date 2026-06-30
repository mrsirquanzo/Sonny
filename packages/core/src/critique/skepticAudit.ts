import { z } from 'zod';
import { StudyDesignSchema, RedFlagSchema, type MethodologicalCritique, type Evidence } from '@sonny/shared';
import type { StructuredModel } from '../model.js';
import { MODEL_ROUTER } from '../model.js';

// The model returns the audit body; evidenceId is attached in code so it is always
// the audited paper's real store id (no token, no ship).
const AuditSchema = z.object({
  studyDesign: StudyDesignSchema,
  sampleSize: z.number().int().positive().nullable(),
  redFlags: z.array(RedFlagSchema),
});

export async function runSkepticAudit(paper: Evidence, model: StructuredModel): Promise<MethodologicalCritique> {
  const audit = await model.generateStructured({
    system: `You are an independent methodological reviewer auditing a biomedical study for design and reporting risk. You did NOT run this study. Classify the study design and identify objective methodological risks - do not invalidate or dismiss the work, categorize risk objectively. Consider: surrogate versus hard endpoints, dropout and attrition, post-hoc or subgroup analyses (p-hacking), active-control mismatch, and blinding. Only raise a red flag the passage actually supports. For preclinical or in-vitro work, clinical-trial flags usually do not apply - return an empty list when nothing applies. For each red flag assign biasRisk: low, moderate, or high.`,
    prompt: `STUDY:\n${paper.title}\n${paper.passage ?? paper.snippet}\n\nClassify studyDesign, report sampleSize (or null if not stated), and list any methodological redFlags, each with category, biasRisk, and a one-line explanation.`,
    schema: AuditSchema,
    model: MODEL_ROUTER.verifier,
  });
  return { evidenceId: paper.id, ...audit };
}
