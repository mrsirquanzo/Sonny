import { z } from 'zod';
import { DevelopabilityRiskSchema, type DevelopabilityRisk, type Section, type TraceEvent } from '@sonny/shared';
import type { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import { MODEL_ROUTER } from '../model.js';

const AssessSchema = z.object({ risks: z.array(DevelopabilityRiskSchema) });

// Assess the asset's own developability dealbreakers (distinct from methodological bias).
// Decorrelated (verifier model); grounded - a risk citing an unknown evidence id is dropped.
export async function assessDevelopability(opts: {
  section: Section; store: EvidenceStore; model: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<DevelopabilityRisk[]> {
  const { section, store, model, emit } = opts;
  const claimsText = section.claims
    .map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
  if (!claimsText) { emit({ type: 'developability_assessment', risks: [] }); return []; }

  const { risks } = await model.generateStructured({
    system: `You are an independent developability reviewer assessing whether this target can be drugged. From the modality findings, identify concrete developability risks: immunogenicity and anti-drug antibodies, half-life, dosing route, off-target or on-target/off-tumor toxicity, Fc-engineering and format risk, and manufacturability. For each risk cite the evidenceId it rests on (copied verbatim from the findings), classify the category, and rate severity: manageable, significant, or severe. Severe means a developability dealbreaker. Only raise a risk the findings support; return an empty list if none.`,
    prompt: `MODALITY FINDINGS:\n${claimsText}\n\nReturn the developability risks, each with evidenceId, category, severity, and explanation.`,
    schema: AssessSchema,
    model: MODEL_ROUTER.verifier,
  });

  const validIds = new Set(store.all().map((e) => e.id));
  const grounded = risks.filter((r) => validIds.has(r.evidenceId)); // no token, no ship
  emit({ type: 'developability_assessment', risks: grounded });
  return grounded;
}
