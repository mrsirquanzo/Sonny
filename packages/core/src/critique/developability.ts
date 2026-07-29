import { z } from 'zod';
import { DevelopabilityRiskSchema, type DevelopabilityRisk, type Section, type TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import { MODEL_ROUTER } from '../model.js';

const AssessSchema = z.object({ risks: z.array(DevelopabilityRiskSchema) });

// Assess the asset's own developability dealbreakers (distinct from methodological bias).
// Decorrelated (verifier model); grounded - a risk citing an unknown evidence id is dropped.
export async function assessDevelopability(opts: {
  section: Section; store: EvidenceStore; model: StructuredModel; emit: (e: TraceEvent) => void;
  /**
   * The resolved Q6 lens for the modality in play.
   *
   * This axis IS Q6, so it must read the lens. Curated cards used to editorialize
   * risk into their own text ("an ADC on-target/off-tumour consideration", "a
   * developability risk for an antibody-based modality"), and this reviewer
   * scored well by copying that framing back out. Slice 2 correctly removed it -
   * a card naming a modality reaches every dossier regardless of the modality
   * actually resolved - but nothing took over the interpreting, so the reviewer
   * was left reading bare facts with no idea which ones constituted a risk.
   * The lens is where modality judgment is supposed to live.
   */
  q6Lens?: readonly string[];
}): Promise<DevelopabilityRisk[]> {
  const { section, store, model, emit, q6Lens } = opts;
  const claimsText = section.claims
    .map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
  if (!claimsText) { emit({ type: 'developability_assessment', risks: [] }); return []; }

  const lensClause = q6Lens?.length
    ? ` Assess each of these modality-specific liability factors in turn: ${q6Lens.join('; ')}. For each one, decide whether the findings contain facts bearing on it.`
    : '';

  const { risks } = await model.generateStructured({
    system: `You are an independent developability reviewer assessing whether this target can be drugged. From the modality findings, identify concrete developability risks: immunogenicity and anti-drug antibodies, half-life, dosing route, off-target or on-target/off-tumor toxicity, Fc-engineering and format risk, and manufacturability.${lensClause} The findings state facts without interpreting them; drawing the developability implication is YOUR job, not theirs. A fact that implies a liability is enough to raise one - do not wait for the findings to use the word "risk". For each risk cite the evidenceId it rests on (copied verbatim from the findings), classify the category, and rate severity: manageable, significant, or severe. Severe means a developability dealbreaker. Every risk must rest on a stated fact; return an empty list if the findings support none.`,
    prompt: `MODALITY FINDINGS:\n${claimsText}\n\nReturn the developability risks, each with evidenceId, category, severity, and explanation.`,
    schema: AssessSchema,
    model: MODEL_ROUTER.verifier,
  });

  const validIds = new Set(store.all().map((e) => e.id));
  const grounded = risks.filter((r) => validIds.has(r.evidenceId)); // no token, no ship
  emit({ type: 'developability_assessment', risks: grounded });
  return grounded;
}
