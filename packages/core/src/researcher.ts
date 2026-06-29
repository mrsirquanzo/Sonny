import { z } from 'zod';
import { ClaimsSchema, type Claim } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

export interface ThreadBrief { id: string; title: string; objective: string; promptHint: string }

const QuestionsSchema = z.object({ questions: z.array(z.string().min(1)).min(1).max(5) });

export async function planResearchQuestions(
  brief: ThreadBrief, target: string, model: StructuredModel,
): Promise<string[]> {
  const { questions } = await model.generateStructured({
    system: `You are the ${brief.title} research specialist. ${brief.promptHint}\nPlan the specific, answerable research questions you must investigate to assess this target at expert depth. Each question must be precise enough to drive a literature search.`,
    prompt: `BRIEF: ${brief.title}\nTARGET: ${target}\nOBJECTIVE: ${brief.objective}\nList up to 5 research questions, most important first.`,
    schema: QuestionsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return questions;
}

export async function extractClaims(
  question: string, evidenceList: string, model: StructuredModel,
): Promise<Claim[]> {
  const { claims } = await model.generateStructured({
    system: `You are a rigorous biomedical research specialist. Answer the research question using ONLY the provided evidence passages. Every claim MUST cite the evidence id(s) it rests on, copied verbatim. If the evidence conflicts, write a reconciliation claim that names the tension and states which way it leans and why. Do not state anything the evidence does not support.`,
    prompt: `RESEARCH QUESTION: ${question}\n\nEVIDENCE:\n${evidenceList}\n\nReturn claims c1, c2, ... each with citations and a confidence in [0,1].`,
    schema: ClaimsSchema,
    model: MODEL_ROUTER.specialist,
  });
  return claims;
}
