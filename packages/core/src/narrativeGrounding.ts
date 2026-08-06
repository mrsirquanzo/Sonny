import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

/**
 * The grounding gate for FREE PROSE.
 *
 * `groundClaims` + `verifyClaims` protect anything shaped like a claim, but the
 * dossier also ships sentences that carry no citation field at all: section
 * takeaways, the cross-thread takeaway, the memo framing, bottom line, and
 * executive read. Those went out unchecked, which is how assertions that failed
 * verification still reached the reader in narrative form.
 *
 * The rule here is entailment, not citation: a narrative sentence may not
 * assert anything the verified findings do not already state. It is deliberately
 * weaker than the claim gate (prose is allowed to summarize several findings at
 * once) and deliberately strict about NEW facts.
 */

const EntailmentSchema = z.object({
  entailed: z.boolean(),
  rationale: z.string().default(''),
});

const ASSERTION_SYSTEM =
  'You are an adversarial reviewer of a scientific memo. Decide whether a SENTENCE is entailed by the VERIFIED FINDINGS. '
  + 'entailed=true only when every factual assertion the sentence makes is already stated by, or follows directly from, the findings. '
  + 'A sentence that introduces a fact, number, population, mechanism, comparator, or clinical outcome the findings do not state is NOT entailed. '
  + 'Summarizing or hedging several findings at once IS entailed. Naming an absence the findings show ("no clinical data was retrieved") IS entailed. '
  + 'Judge ONLY from the findings. Be strict.';

const PROPOSAL_SYSTEM =
  'You are an adversarial reviewer of a scientific memo. The SENTENCE proposes future work (an experiment, a dataset, a readout). '
  + 'entailed=true when the sentence asserts no fact about the target, or when every factual premise it does assert is stated by the VERIFIED FINDINGS. '
  + 'A proposal is not a factual claim: do NOT mark it unentailed merely because the findings do not report that the work was done. '
  + 'Mark it unentailed when it smuggles in an unsupported fact (a specific effect size, an established liability, a claimed precedent). '
  + 'Judge ONLY from the findings. Be strict.';

export type NarrativeMode = 'assertion' | 'proposal';

export interface GroundedNarrative {
  /** The entailed sentences, in order, rejoined. Empty when none survived. */
  text: string;
  /** Sentences removed because the findings do not support them. */
  dropped: string[];
}

/**
 * Sentence split mirroring the eval harness's `unsupported_sentence_ratio`
 * splitter, so the unit this gate accepts is the unit that metric scores.
 */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Drop every sentence the verified findings do not support.
 *
 * Sentence-level rather than block-level so a memo keeps its supported prose
 * instead of collapsing whole sections on one bad clause, and one call per
 * sentence rather than one batched call so a malformed response costs one
 * sentence rather than the whole passage.
 *
 * Fails CLOSED: a judge error or a response without an explicit `entailed:true`
 * drops the sentence. An outage must cost readability, never the guarantee.
 */
export async function groundNarrative(opts: {
  text: string;
  /** Verified findings this prose may rest on: claim texts plus any other
   *  evidence-bound fact the writer was shown (developability risks, contradictions). */
  facts: readonly string[];
  model: StructuredModel;
  modelId?: string;
  mode?: NarrativeMode;
}): Promise<GroundedNarrative> {
  const sentences = splitSentences(opts.text ?? '');
  if (sentences.length === 0) return { text: '', dropped: [] };
  // With nothing verified, no sentence can be entailed. Short-circuit rather
  // than spend judge calls proving it.
  if (opts.facts.length === 0) return { text: '', dropped: sentences };

  const findings = opts.facts.map((f) => `- ${f}`).join('\n');
  const system = opts.mode === 'proposal' ? PROPOSAL_SYSTEM : ASSERTION_SYSTEM;
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const sentence of sentences) {
    let entailed = false;
    try {
      const r = await opts.model.generateStructured({
        system,
        prompt: `SENTENCE:\n${sentence}\n\nVERIFIED FINDINGS:\n${findings}`,
        schema: EntailmentSchema,
        model: opts.modelId ?? MODEL_ROUTER.verifier,
      });
      entailed = r.entailed === true;
    } catch {
      entailed = false;
    }
    (entailed ? kept : dropped).push(sentence);
  }
  return { text: kept.join(' '), dropped };
}

/**
 * Grounded prose, or a stated degradation.
 *
 * Never returns unverified text: when nothing survives it returns `degraded`,
 * which must say plainly that the narrative could not be grounded rather than
 * quietly shipping a thinner version of the same unsupported read.
 */
export async function groundNarrativeOrDegrade(opts: {
  text: string;
  facts: readonly string[];
  model: StructuredModel;
  modelId?: string;
  mode?: NarrativeMode;
  degraded: string;
}): Promise<string> {
  const { text } = await groundNarrative(opts);
  return text || opts.degraded;
}
