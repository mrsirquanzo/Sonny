import {
  SpecialistConclusionSchema,
  sectionKey,
  type Claim,
  type RetrievalAuditStore,
  type SpecialistConclusion,
  type SpecialistExecutionContext,
  type SectionScope,
  type SpecialistAxisId,
  type CanonicalModality,
  type TraceEvent,
} from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import type { ThreadBrief } from '../researcher.js';
import { MODEL_ROUTER } from '../model.js';
import { rewriteAllSupport } from './rewriteSupport.js';
import { validateAndDegrade } from './validate.js';

/**
 * Draft one specialist's structured conclusion.
 *
 * Runs ONCE per completed thread, after verification, and sees only claims that
 * survived it plus the deterministic cards routed to this axis. It therefore
 * cannot rest a conclusion on evidence the verifier rejected: the rejected
 * claims are not in the prompt at all, which is a stronger guarantee than
 * asking the model not to use them.
 *
 * Deterministic claims are included because section 7.4 permits a conclusion to
 * cite curated cards. They are derived per section before drafting, so the
 * permission is not empty.
 */
export async function draftSpecialistConclusion(opts: {
  brief: ThreadBrief;
  context: SpecialistExecutionContext;
  verifiedClaims: readonly Claim[];
  deterministicClaims: readonly Claim[];
  store: EvidenceStore;
  auditStore: RetrievalAuditStore;
  model: StructuredModel;
  emit: (e: TraceEvent) => void;
  /**
   * Which section's retrieval audits may substantiate an absence here.
   *
   * Derived from the scope by default. A caller MUST override when retrieval
   * recorded its audits under a different key, or the coverage gate looks in an
   * empty bucket and degrades every absence conclusion the run legitimately
   * earned.
   */
  sectionKey?: string;
  /**
   * Resolved modality, when the caller knows it and the execution context does
   * not carry one. Only a strategy-scoped context can derive it, so a run that
   * never resolved a therapeutic strategy has to supply it here or a low Q6
   * fails closed for want of a modality rather than for want of evidence.
   */
  modality?: CanonicalModality;
}): Promise<SpecialistConclusion> {
  const { brief, context, verifiedClaims, deterministicClaims, store, auditStore, model, emit } = opts;
  const usable = [...verifiedClaims, ...deterministicClaims];

  const claimBlock = usable.length
    ? usable.map((c) => `- [${c.id}] ${c.text} (cites ${c.citations.join(', ')})`).join('\n')
    : '(no claims survived verification)';

  const raw = await model.generateStructured({
    system: `You are the ${brief.title} specialist writing a structured conclusion for the ${brief.id} axis. ${brief.objective}\n`
      + `Base the conclusion ONLY on the claims listed. Reference a claim by its bracketed id in supportingClaimIds. `
      + `Do NOT author evidenceIds - they are derived from the claims you cite and anything you put there is discarded. `
      + `If the claims do not support a conclusion, say so with the insufficient_evidence shape rather than reaching.`,
    prompt: `SCOPE: ${describeScope(context)}\n\nCLAIMS:\n${claimBlock}\n\nReturn the ${brief.id} conclusion.`,
    schema: SpecialistConclusionSchema,
    model: MODEL_ROUTER.specialist,
  });

  // Trace only. `validateAndDegrade` owns the rewrite: doing it here as well
  // would prune the support before the validator could see that it HAD been
  // pruned, and a conclusion whose every cited claim was invented would then
  // look like one that simply cited nothing.
  const usableIds = new Set(usable.map((c) => c.id));
  const droppedClaimIds: string[] = [];
  rewriteAllSupport(raw as SpecialistConclusion, usable, store, (b) => {
    droppedClaimIds.push(...b.supportingClaimIds.filter((id) => !usableIds.has(id)));
  });
  if (droppedClaimIds.length) {
    emit({ type: 'error', message: `conclusion ${brief.id}: dropped supportingClaimIds outside the supplied set: ${[...new Set(droppedClaimIds)].join(', ')}` });
  }

  return validateAndDegrade({
    conclusion: raw as SpecialistConclusion,
    verifiedClaims,
    deterministicClaims,
    store,
    auditStore,
    sectionKey: opts.sectionKey ?? sectionKey(brief.id as SpecialistAxisId, toScope(context)),
    // Context first: a strategy-scoped thread's own modality is the authority,
    // and the override exists for the case where there is no strategy at all.
    modality: modalityOf(context) ?? opts.modality,
    emit,
  });
}

function describeScope(context: SpecialistExecutionContext): string {
  switch (context.kind) {
    case 'shared':
      return `shared across strategies; ${context.queryScope.rawPrompt}`;
    case 'q1_hypothesis':
      return `target hypothesis ${context.hypothesis.key}`;
    case 'strategy':
      return `strategy ${context.strategyFingerprint}${context.strategyVariantLabel ? ` (${context.strategyVariantLabel})` : ''}`;
  }
}



/**
 * The execution context carries the scope plus the payload a specialist needs;
 * `sectionKey` wants only the scope discriminant. Narrowing here keeps one
 * canonical key derivation (`shared/src/scope.ts`) rather than a second copy
 * that could drift from it.
 */
function toScope(context: SpecialistExecutionContext): SectionScope {
  switch (context.kind) {
    case 'shared': return { kind: 'shared' };
    case 'strategy': return {
      kind: 'strategy',
      strategyFingerprint: context.strategyFingerprint,
      ...(context.strategyVariantLabel ? { strategyVariantLabel: context.strategyVariantLabel } : {}),
    };
    case 'q1_hypothesis': return {
      kind: 'q1_hypothesis',
      q1HypothesisKey: context.hypothesis.key,
      relatedStrategyFingerprints: context.relatedStrategyFingerprints,
    };
  }
}

/**
 * Resolved modality for this thread, or undefined when the scope has none.
 *
 * Only a strategy-scoped thread carries a modality; Q1 hypotheses and the
 * shared Q3a scope deliberately do not, because they are reused across
 * strategies with different modalities. Q6 is always strategy-scoped, so the
 * one axis whose validation NEEDS a modality always has one - and a Q6 that
 * somehow arrives without one fails closed rather than skipping the check.
 */
function modalityOf(context: SpecialistExecutionContext): CanonicalModality | undefined {
  return context.kind === 'strategy'
    ? context.strategy.interventions[0]?.modality
    : undefined;
}
