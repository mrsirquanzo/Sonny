import { z } from 'zod';
import { VerdictStatusSchema } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel, Backend } from './model.js';
import { currentBackend, routerFor, AnthropicModel, OllamaModel } from './model.js';
import type { CompetitiveIP, IpPoint, PatentWorkup, ClaimVerdict } from './patentWorkup.js';

export interface Verifier { model: StructuredModel; modelId: string; decorrelated: boolean }

const VerifySchema = z.object({ status: VerdictStatusSchema, rationale: z.string() });

const SYSTEM =
  'You are an adversarial reviewer. Decide whether the EVIDENCE supports the CLAIM. "supported": the evidence directly backs the claim. "unsupported": the evidence does not back it. "overreach": the claim asserts more than the evidence shows (materiality, market claims, "same family"). Judge ONLY from the provided evidence. Be strict.';

export function makeDecorrelatedVerifier(
  primary: Backend = currentBackend(),
  opts: { anthropicKeyPresent?: boolean; anthropic?: () => StructuredModel; ollama?: () => StructuredModel } = {},
): Verifier {
  const opposite: Backend = primary === 'anthropic' ? 'ollama' : 'anthropic';
  const anthropicKeyPresent = opts.anthropicKeyPresent ?? Boolean(process.env.ANTHROPIC_API_KEY);
  // Factories are injectable so tests never construct a real AnthropicModel (which throws without a key).
  const anthropic = opts.anthropic ?? (() => new AnthropicModel());
  const ollama = opts.ollama ?? (() => new OllamaModel());
  const oppositeAvailable = opposite === 'anthropic' ? anthropicKeyPresent : true; // ollama is local
  if (oppositeAvailable) {
    return {
      model: opposite === 'ollama' ? ollama() : anthropic(),
      modelId: routerFor(opposite).verifier,
      decorrelated: true,
    };
  }
  return {
    model: primary === 'ollama' ? ollama() : anthropic(),
    modelId: routerFor(primary).verifier,
    decorrelated: false,
  };
}

function factIndex(workup: PatentWorkup): Map<string, string> {
  const idx = new Map<string, string>();
  for (const c of workup.constructs) {
    for (const r of c.regions) {
      const bits = [`${r.regionLabel} SEQ:${r.seqId} in ${c.name} (species ${c.species.classification})`];
      if (r.cdrConfirmation) bits.push(`CDR ${r.cdrConfirmation}`);
      if (r.blast) bits.push(`nr top hit ${r.blast.accession} ${r.blast.percentIdentity}% mismatches=${r.blast.mismatchCount}`);
      idx.set(`SEQ:${r.seqId}`, bits.join('; '));
      if (r.blast) idx.set(r.blast.accession, `nr top hit ${r.blast.accession} ${r.blast.percentIdentity}% mismatches=${r.blast.mismatchCount}`);
      for (const h of r.patentMatches ?? []) {
        idx.set(h.accession, `competitor patent ${h.accession} ${h.percentIdentity}% mismatches=${h.mismatchCount}`);
      }
    }
  }
  idx.set('patent', `patent ${workup.patentNumber ?? 'unknown'}; applicants ${workup.patent.applicants.join(', ') || 'unknown'}`);
  return idx;
}

export async function verifyNarrative(
  ip: CompetitiveIP,
  workup: PatentWorkup,
  verifier: Verifier,
): Promise<CompetitiveIP> {
  const idx = factIndex(workup);
  const points: IpPoint[] = [];
  let anyVerified = false;
  for (const p of ip.points) {
    const evidence = p.citations.map((c) => idx.get(c) ?? c).join('\n') || '(no cited evidence)';
    let verdict: ClaimVerdict = 'unverified';
    let verdictRationale: string | undefined;
    try {
      const r = await verifier.model.generateStructured({
        system: SYSTEM,
        prompt: `CLAIM:\n${p.point}\n\nEVIDENCE:\n${evidence}`,
        schema: VerifySchema,
        model: verifier.modelId,
      });
      verdict = r.status;
      verdictRationale = r.rationale;
      anyVerified = true;
    } catch {
      verdict = 'unverified';
    }
    points.push({ ...p, verdict, ...(verdictRationale !== undefined && { verdictRationale }) });
  }
  return { ...ip, points, decorrelated: verifier.decorrelated, verified: points.length === 0 ? true : anyVerified };
}
