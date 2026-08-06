import { z } from 'zod';
import type {
  CanonicalModality, Claim, Section, SpecialistExecutionContext, TraceEvent,
} from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { groundNarrative } from './narrativeGrounding.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag, createSourceIdentityResolver } from './rag.js';
import { runResearcher, type ThreadBrief, type ResearchBudget, type ResearchContext } from './researcher.js';
import { deriveStructuredClaims } from './structuredClaims.js';
import { draftSpecialistConclusion } from './conclusions/draft.js';
import { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';

/**
 * The context this thread runs under.
 *
 * `composeRoster` attaches one only when it resolved a `TherapeuticStrategy`,
 * and `ResearchContext` (indication + modality strings) cannot carry a
 * strategy, so on the current `runDeepResearch` path every brief arrives
 * without it.
 *
 * The fallback is `shared`, which is what such a run actually is: scoped to the
 * query, not to one strategy among several. Fabricating a strategy would be
 * worse than leaving it absent - a made-up fingerprint keys section identity
 * and retrieval-audit coverage to a strategy nobody proposed, and every
 * downstream consumer would read it as a real one. The cost of `shared` is that
 * `modalityOf` finds no modality, which is exactly why the modality is threaded
 * to `draftSpecialistConclusion` explicitly.
 */
function executionContextFor(brief: ThreadBrief, target: string): SpecialistExecutionContext {
  if (brief.context) return brief.context;
  return {
    kind: 'shared',
    queryScope: {
      subjectTargets: [{ kind: 'gene_or_protein', symbol: target }],
      rawPrompt: target,
    },
  };
}

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
  /**
   * Resolved modality for the run. Threaded rather than re-derived: without it
   * the critical-domain rule fails closed and a `low` Q6 degrades for want of a
   * modality rather than for want of evidence.
   */
  modality?: CanonicalModality;
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

  // The deterministic cards this axis owns (spec 7.3 routing). `runDeepResearch`
  // merges the same set into `section.claims` later, but the conclusion is
  // drafted here, so it must derive them itself or the drafter would be told the
  // curated cards do not exist while the shipped section shows them.
  const deterministicClaims = deriveStructuredClaims(store).get(brief.id) ?? [];

  const conclusion = await draftConclusion({
    brief, target, supported, deterministicClaims, store,
    auditStore: auditStore ?? new RetrievalAuditStore(),
    model: specialistModel, emit, modality: opts.modality,
  });

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
    // No `schemaVersion: 2`. `parseStoredSection` dispatches on the PRESENCE of
    // that field and gives a versioned section exactly one chance to parse, and
    // `ResearchSectionV2Schema` requires a `scope` obeying REQUIRED_SCOPE_KINDS.
    // `composeRoster` assigns no scope without a resolved strategy, so stamping
    // V2 now would make every section written by this path unreadable - a hard
    // parse failure, not a graceful one. `LegacyResearchSectionSchema` already
    // declares `conclusion` optional, so the legacy shape carries it with no
    // migration. V2 becomes emittable when every section has a legal scope.
    ...(conclusion ? { conclusion } : {}),
  };
  emit({ type: 'section_complete', section });
  return section;
}

/**
 * A conclusion is an addition to a section, not a precondition for one.
 *
 * The drafter makes a model call, so it can fail on its own. Letting that
 * failure propagate would discard a fully researched, verified section and
 * either burn a retry re-running every search or ship a placeholder reading
 * "research could not complete", which would be false.
 */
async function draftConclusion(opts: {
  brief: ThreadBrief; target: string;
  supported: readonly Claim[]; deterministicClaims: readonly Claim[];
  store: EvidenceStore; auditStore: RetrievalAuditStore;
  model: StructuredModel; emit: (e: TraceEvent) => void;
  modality?: CanonicalModality;
}) {
  const { brief, target, supported, deterministicClaims, store, auditStore, model, emit, modality } = opts;
  try {
    return await draftSpecialistConclusion({
      brief,
      context: executionContextFor(brief, target),
      // The SAME set that becomes `section.claims`. Drafting from `shippable`
      // would let a conclusion rest on a claim the verifier rejected and the
      // section does not ship.
      verifiedClaims: supported,
      deterministicClaims,
      store, auditStore, model, emit,
      // `runResearcher` registers its audits under the bare axis id, so the
      // coverage gate must look there. Deriving a scoped key here would point
      // it at an empty bucket and degrade every absence the run earned.
      sectionKey: brief.id,
      ...(modality ? { modality } : {}),
    });
  } catch (err) {
    emit({ type: 'error', message: `conclusion ${brief.id} draft failed: ${String((err as { message?: string })?.message ?? err)}` });
    return undefined;
  }
}
