import { z } from 'zod';
import { SpecialistAxisIdSchema, type SpecialistAxisId } from './specialistAxes.js';

/**
 * Section identity.
 *
 * A two-state key (`strategyVariantKey ?? 'shared'`) cannot express Q1: a Q1
 * assessment is reused across several strategy variants, so it belongs to none
 * of them and falls back to `shared`, collapsing every distinct Q1 hypothesis
 * in a bake-off into one `target_biology::shared` key.
 *
 * Strategy sections key off `strategyFingerprint`, which is always present.
 * `strategyVariantLabel` is presentation only and never carries identity.
 */
export const SectionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shared') }),
  z.object({
    kind: z.literal('strategy'),
    strategyFingerprint: z.string().min(1),
    strategyVariantLabel: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('q1_hypothesis'),
    q1HypothesisKey: z.string().min(1),
    relatedStrategyFingerprints: z.array(z.string().min(1)).min(1),
  }),
]);
export type SectionScope = z.infer<typeof SectionScopeSchema>;

/**
 * Which scopes each axis may legally occupy. Stating this in prose alone let
 * `target_biology::strategy` validate.
 *
 * `disease_indications` permits both: Q3b overlays are strategy-scoped, and
 * the single synthesized comparative output is shared. Q3a is an internal
 * artifact and never becomes a Section, so it needs no scope here.
 */
export const REQUIRED_SCOPE_KINDS: Record<SpecialistAxisId, readonly SectionScope['kind'][]> = {
  target_biology: ['q1_hypothesis'],
  moa_pathway: ['strategy'],
  disease_indications: ['shared', 'strategy'],
  clinical_landscape: ['strategy'],
  competitive_ip: ['strategy'],
  modality_developability: ['strategy'],
};

export function sectionKey(id: SpecialistAxisId, scope: SectionScope): string {
  switch (scope.kind) {
    case 'shared':        return `${id}::shared`;
    case 'strategy':      return `${id}::strategy::${scope.strategyFingerprint}`;
    case 'q1_hypothesis': return `${id}::q1::${scope.q1HypothesisKey}`;
  }
}

export function isScopeLegalForAxis(id: SpecialistAxisId, scope: SectionScope): boolean {
  return REQUIRED_SCOPE_KINDS[id].includes(scope.kind);
}

export { SpecialistAxisIdSchema };
