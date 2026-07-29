import {
  SpecialistConclusionSchema,
  sectionKey,
  type Claim,
  type RetrievalAuditStore,
  type SpecialistConclusion,
  type SpecialistExecutionContext,
  type SectionScope,
  type SpecialistAxisId,
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
    sectionKey: sectionKey(brief.id as SpecialistAxisId, toScope(context)),
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
