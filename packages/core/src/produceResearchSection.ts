import { z } from 'zod';
import type { Claim, Section, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { groundNarrative } from './narrativeGrounding.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag, createSourceIdentityResolver } from './rag.js';
import { runResearcher, type ThreadBrief, type ResearchBudget, type ResearchContext } from './researcher.js';
import type { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';

const TakeawaySchema = z.object({ takeaway: z.string() });

const NO_SUPPORTED_CLAIMS = 'No claim in this section survived verification.';

/**
 * The section's one-line read, written AFTER verification from the supported
 * claims only.
 *
 * The takeaway used to be `reflectOnGaps`'s mid-research note, which was
 * written over drafted claims - including the ones grounding and the verifier
 * then rejected - and shipped unchanged into the section, `assessCompleteness`,
 * `weighAcrossThreads` and the memo. It was the widest hole in "no citation, no
 * claim": a rejected assertion reappearing as narrative.
 *
 * Written, then entailment-checked against the same supported claims by the
 * verifier model. If nothing survives, degrade to the strongest supported claim
 * VERBATIM - grounded by construction, since it is itself a verified claim.
 */
async function writeSectionTakeaway(opts: {
  title: string; supported: Claim[]; model: StructuredModel; verifierModel: StructuredModel;
}): Promise<string> {
  const { title, supported, model, verifierModel } = opts;
  if (supported.length === 0) return NO_SUPPORTED_CLAIMS;

  const facts = supported.map((c) => c.text);
  const { takeaway } = await model.generateStructured({
    system: `You are writing the one-line takeaway for the "${title}" section of a target-assessment dossier. `
      + `Use ONLY the verified findings given. State nothing they do not state - no new mechanism, number, population, or clinical read. `
      + `One sentence. If the findings only support a narrow reading, say the narrow thing.`,
    prompt: `VERIFIED FINDINGS:\n${facts.map((f) => `- ${f}`).join('\n')}\n\nReturn a one-sentence takeaway.`,
    schema: TakeawaySchema,
    model: MODEL_ROUTER.specialist,
  });

  const grounded = await groundNarrative({ text: takeaway, facts, model: verifierModel });
  if (grounded.text) return grounded.text;
  // Strongest supported claim, verbatim. Less elegant than a synthesis, but it
  // is a verified claim rather than a paraphrase nothing checked.
  return [...supported].sort((a, b) => b.confidence - a.confidence)[0].text;
}

export async function produceResearchSection(opts: {
  brief: ThreadBrief; target: string; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
  context?: ResearchContext;
  auditStore?: RetrievalAuditStore;
}): Promise<Section> {
  const { brief, target, tools, store, specialistModel, verifierModel, emit, budget, context, auditStore } = opts;
  const findings = await runResearcher({ brief, target, tools, store, model: specialistModel, verifierModel, emit, budget, context, auditStore });

  const { shippable } = groundClaims(findings.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported: Claim[] = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  // Reconcile the ledger BEFORE attaching it. The ledger marked questions
  // answered on grounding, which is all `runResearcher` can test; a question
  // whose answering claims the verifier then rejected must not ship as
  // answered. The supported set is the SAME predicate as `section.claims`, so
  // ledger status and shipped claims cannot disagree.
  findings.ledger.applyVerification(new Set(supported.map((c) => c.id)));
  const takeaway = await writeSectionTakeaway({ title: brief.title, supported, model: specialistModel, verifierModel });
  const sources = [...new Set(supported.flatMap((c) => c.citations))];
  const section: Section = {
    kind: 'research', id: brief.id, title: brief.title, takeaway,
    // Section identity comes from the brief that produced it, so an axis can
    // never acquire a scope its rubric was not built under.
    ...(brief.scope ? { scope: brief.scope } : {}),
    claims: supported, sources, rag: computeRag(shippable, verdicts, createSourceIdentityResolver(store.all())),
    critiques: findings.critiques,
    // Named on the artifact, not dropped. A silently truncated investigation
    // reads as a complete one.
    questionLedger: findings.ledger.all(),
  };
  emit({ type: 'section_complete', section });
  return section;
}
