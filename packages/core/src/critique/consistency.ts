import { z } from 'zod';
import { ContradictionFlagSchema, type ContradictionFlag, type Claim, type TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import { MODEL_ROUTER } from '../model.js';

const FlagsSchema = z.object({ contradictions: z.array(ContradictionFlagSchema) });

export async function detectContradictions(opts: {
  claims: Claim[]; store: EvidenceStore; model: StructuredModel; emit: (e: TraceEvent) => void;
}): Promise<ContradictionFlag[]> {
  const { claims, store, model, emit } = opts;
  if (claims.length < 2) return [];

  const list = claims.map((c) => `- ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
  let flags: ContradictionFlag[] = [];
  try {
    const out = await model.generateStructured({
      system: `You are an independent consistency auditor. Given a set of verified findings, identify PAIRS that make directly OPPOSING assertions about the SAME endpoint (for example one says a marker predicts poor prognosis and another says it has no prognostic value). For each genuine contradiction return evidenceIdA and evidenceIdB (the evidence ids the two findings cite, copied verbatim), the endpoint in tension, and a one-line explanation. Flag only real opposition on the same endpoint - not differences in scope, population, or emphasis. Return an empty list if there are none.`,
      prompt: `VERIFIED FINDINGS:\n${list}\n\nReturn contradictions, each with evidenceIdA, evidenceIdB, endpoint, explanation.`,
      schema: FlagsSchema,
      model: MODEL_ROUTER.verifier,
    });
    flags = out.contradictions;
  } catch (err) {
    emit({ type: 'error', message: `contradiction detection failed: ${String(err)}` });
    return [];
  }

  const ids = new Set(store.all().map((e) => e.id));
  const valid = flags.filter((f) => f.evidenceIdA !== f.evidenceIdB && ids.has(f.evidenceIdA) && ids.has(f.evidenceIdB));
  for (const f of valid) emit({ type: 'contradiction', flag: f });
  return valid;
}
