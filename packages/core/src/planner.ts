import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { SPECIALISTS } from './specialists.js';

const SelectionSchema = z.object({
  selected: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});

const SYSTEM = `You are the Lead Investigator planning a scientific target dossier.
Given the user's question, choose which specialists are relevant. For any specialist you do NOT select, give a one-line reason.
Valid specialist ids: ${SPECIALISTS.map((s) => s.id).join(', ')}.`;

export async function selectSpecialists(
  query: string,
  model: StructuredModel,
): Promise<{ selected: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const valid = new Set(SPECIALISTS.map((s) => s.id));
  const raw = await model.generateStructured({
    system: SYSTEM, prompt: `Question: ${query}`, schema: SelectionSchema, model: MODEL_ROUTER.planner,
  });
  let selected = raw.selected.filter((id) => valid.has(id));
  if (selected.length === 0) selected = SPECIALISTS.map((s) => s.id); // fallback: run all
  // Derive skipped for any valid specialist not selected (merge model-provided reasons).
  const skipped = SPECIALISTS.filter((s) => !selected.includes(s.id)).map((s) => ({
    id: s.id, reason: raw.skipped.find((k) => k.id === s.id)?.reason ?? 'not relevant to this question',
  }));
  return { selected, skipped };
}
