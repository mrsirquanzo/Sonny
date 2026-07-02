import { z } from 'zod';
import { ClaimsSchema, type Claim, type Section, type TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';

const WeighSchema = z.object({ takeaway: z.string(), claims: ClaimsSchema.shape.claims });

export async function weighAcrossThreads(opts: {
  sections: Section[]; store: EvidenceStore;
  leadModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<{ takeaway: string; claims: Claim[] }> {
  const { sections, store, leadModel, verifierModel, emit } = opts;
  const digest = sections.map((s) =>
    `## ${s.title} [${s.rag}]\n${s.takeaway}\n${s.claims.map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n')}`,
  ).join('\n\n');

  const draft = await leadModel.generateStructured({
    system: `You are the lead scientist weighing the findings across every thread of a target assessment. Identify the tensions between threads - for example a weak genetic association against strong mechanistic evidence, or a promising mechanism against a thin clinical pipeline. For each tension write a reconciliation claim that names it, states which way the evidence leans, and why. Cite ONLY evidence ids that already appear in the section claims, copied verbatim. Write a one-line cross-thread takeaway.`,
    prompt: `THREAD FINDINGS:\n${digest}\n\nReturn a takeaway and reconciliation claims c1, c2, ... each citing existing evidence ids.`,
    schema: WeighSchema,
    model: MODEL_ROUTER.specialist,
  });

  for (const c of draft.claims) emit({ type: 'claim_drafted', claim: c });
  const { shippable } = groundClaims(draft.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });
  const claims = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  return { takeaway: draft.takeaway, claims };
}
