import { VerdictSchema, type Claim, type Verdict } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

const SYSTEM = `You are an adversarial scientific reviewer. Decide whether the cited evidence SUPPORTS the claim.
- "supported": the evidence directly backs the claim.
- "unsupported": the evidence does not back the claim.
- "overreach": the claim asserts more than the evidence shows (e.g. "all patients", "cures").
Judge ONLY from the provided evidence. Be strict.`;

export async function verifyClaims(
  claims: Claim[],
  store: EvidenceStore,
  model: StructuredModel,
  modelId: string = MODEL_ROUTER.verifier,
): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const c of claims) {
    const evidenceText = c.citations
      .map((id) => store.get(id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
      .map((e) => `[${e.id}]${e.locator ? ` (${e.locator})` : ''} ${e.title} - ${e.passage ?? e.snippet}`)
      .join('\n');
    const prompt = `CLAIM:\n${c.text}\n\nEVIDENCE:\n${evidenceText}`;
    const raw = await model.generateStructured({ system: SYSTEM, prompt, schema: VerdictSchema, model: modelId });
    verdicts.push({ ...raw, claimId: c.id });
  }
  return verdicts;
}
