import { z } from 'zod';
import { CanonicalModalitySchema } from './modality.js';

/**
 * Target identity. A bare gene symbol cannot express a TCR-T peptide-HLA
 * target, a bispecific's two targets, or a fusion, and the spec ships lenses
 * for all three.
 */
export const TargetIdentitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gene_or_protein'),
    symbol: z.string().min(1),
    targetForm: z.string().optional(),
  }),
  z.object({
    kind: z.literal('peptide_hla'),
    sourceGene: z.string().min(1),
    variant: z.string().optional(),
    peptide: z.string().optional(),
    hlaAllele: z.string().min(1),
  }),
  z.object({
    kind: z.literal('fusion'),
    partners: z.tuple([z.string().min(1), z.string().min(1)]),
  }),
  z.object({
    kind: z.literal('other'),
    canonicalName: z.string().min(1),
  }),
]);
export type TargetIdentity = z.infer<typeof TargetIdentitySchema>;

/**
 * Symbols usable against symbol-keyed tools (Open Targets, HPA, GTEx,
 * ClinicalTrials). `other` yields none, and structured retrieval is skipped
 * with a trace flag rather than sending a free-text name as a gene symbol.
 */
export function retrievalSymbols(target: TargetIdentity): string[] {
  switch (target.kind) {
    case 'gene_or_protein': return [target.symbol];
    case 'peptide_hla':     return [target.sourceGene];
    case 'fusion':          return [target.partners[0], target.partners[1]];
    case 'other':           return [];
  }
}

export const TargetRoleSchema = z.enum([
  'disease_driver',
  'functional_dependency',
  'pathway_regulator',
  'resistance_mechanism',
  'synthetic_lethal_partner',
  'delivery_address',
  'immune_recognition_antigen',
  'deficient_or_dysfunctional_gene',
  'unknown',
  // NOTE: `patient_selection_biomarker` is deliberately absent. A selection
  // biomarker is usually not the intervention target (BRCA selects for a PARP
  // inhibitor but is not what the drug acts on), and modelling it as a role
  // would send Q1 to validate a selection marker as a therapeutic target.
]);
export type TargetRole = z.infer<typeof TargetRoleSchema>;

export const TherapeuticActionSchema = z.enum([
  'inhibit', 'antagonize', 'activate', 'agonize',
  'degrade', 'silence', 'replace', 'correct', 'edit',
  'deplete', 'redirect_immunity', 'deliver_payload', 'unknown',
]);
export type TherapeuticAction = z.infer<typeof TherapeuticActionSchema>;

export const BiologicalIntentSchema = z.enum([
  'suppress_function',
  'activate_function',
  'restore_function',
  'remove_target_bearing_cell',
  'exploit_as_delivery_address',
  'exploit_for_immune_recognition',
  'unknown',
]);
export type BiologicalIntent = z.infer<typeof BiologicalIntentSchema>;

/**
 * Total action-to-intent map.
 *
 * `edit` maps to null on purpose: editing can correct an allele
 * (restore_function) or disrupt a sequence (suppress_function), and the action
 * does not disclose which. It MUST be supplied explicitly, never defaulted.
 */
export const ACTION_TO_INTENT: Record<TherapeuticAction, BiologicalIntent | null> = {
  inhibit: 'suppress_function',
  antagonize: 'suppress_function',
  degrade: 'suppress_function',
  silence: 'suppress_function',
  activate: 'activate_function',
  agonize: 'activate_function',
  replace: 'restore_function',
  correct: 'restore_function',
  deplete: 'remove_target_bearing_cell',
  redirect_immunity: 'exploit_for_immune_recognition',
  deliver_payload: 'exploit_as_delivery_address',
  edit: null,
  unknown: 'unknown',
};

export const TargetEngagementSchema = z.object({
  target: TargetIdentitySchema,
  targetRole: TargetRoleSchema,
  primaryAction: TherapeuticActionSchema,
  secondaryActions: z.array(TherapeuticActionSchema).optional(),
  biologicalIntents: z.array(BiologicalIntentSchema).min(1),
});
export type TargetEngagement = z.infer<typeof TargetEngagementSchema>;

/**
 * The only intents `edit` can resolve to. Editing either restores function
 * (correction) or suppresses it (disruption); it cannot, for example, turn an
 * inhibitor into an activator.
 */
export const EDIT_RESOLVABLE_INTENTS: readonly BiologicalIntent[] = [
  'restore_function',
  'suppress_function',
];

/** Intents implied by an engagement's actions. `edit` contributes nothing. */
export function derivedIntents(engagement: {
  primaryAction: TherapeuticAction;
  secondaryActions?: TherapeuticAction[];
}): BiologicalIntent[] {
  const actions = [engagement.primaryAction, ...(engagement.secondaryActions ?? [])];
  const intents = actions.map((a) => ACTION_TO_INTENT[a]).filter((i): i is BiologicalIntent => i !== null);
  return [...new Set(intents)].sort();
}

/**
 * Canonical engagement resolver.
 *
 * Zod alone accepts `{ primaryAction: 'inhibit', biologicalIntents: ['activate_function'] }`,
 * which is a contradiction that would corrupt Q1 hypothesis keys, strategy
 * fingerprints, prompt conditioning, and bake-off reuse. Intents are therefore
 * derived from actions and any supplied intents are checked against them.
 */
export function resolveTargetEngagement(input: unknown): TargetEngagement {
  const parsed = TargetEngagementSchema.partial({ biologicalIntents: true }).parse(input);
  const actions = [parsed.primaryAction, ...(parsed.secondaryActions ?? [])];
  const derived = derivedIntents(parsed);
  const needsExplicit = actions.includes('edit');
  const supplied = parsed.biologicalIntents ? [...new Set(parsed.biologicalIntents)].sort() : undefined;

  if (needsExplicit && (!supplied || supplied.length === 0)) {
    throw new Error(
      "action 'edit' does not determine a biological intent (correction restores function, disruption suppresses it); supply biologicalIntents explicitly",
    );
  }
  if (supplied) {
    // The presence of `edit` exempts ONLY the intents `edit` can plausibly
    // carry. It must not disable contradiction checking for the other actions:
    // `primaryAction:'inhibit'` with `secondaryActions:['edit']` previously
    // accepted `activate_function`, which contradicts `inhibit` outright.
    const allowed = new Set<BiologicalIntent>([
      ...derived,
      ...(needsExplicit ? EDIT_RESOLVABLE_INTENTS : []),
    ]);
    const conflicting = supplied.filter((i) => !allowed.has(i));
    if (conflicting.length > 0) {
      throw new Error(
        `biologicalIntents [${conflicting.join(', ')}] contradict the actions [${actions.join(', ')}] (implied: [${derived.join(', ')}]${needsExplicit ? `; 'edit' may add [${EDIT_RESOLVABLE_INTENTS.join(', ')}]` : ''})`,
      );
    }
  }
  const resolved = [...new Set([...(supplied ?? []), ...derived])].sort();
  if (resolved.length === 0) {
    throw new Error(`engagement actions [${actions.join(', ')}] yield no biological intent`);
  }
  return TargetEngagementSchema.parse({ ...parsed, biologicalIntents: resolved });
}

export const TherapeuticInterventionSchema = z.object({
  engagements: z.array(TargetEngagementSchema).min(1),
  modality: CanonicalModalitySchema,
  modalitySubtype: z.string().optional(),
  /** Presentation/nomination summary only. MUST NOT be used as a Q1 reuse key. */
  primaryProductIntent: BiologicalIntentSchema.optional(),
  designHypothesis: z.string().optional(),
  /**
   * Which engagements define the disease question. For an EGFR x CD3 bispecific
   * the subject is EGFR, not CD3. Never inferred from array order.
   */
  subjectEngagementIndexes: z.array(z.number().int().nonnegative()).min(1).optional(),
});
export type TherapeuticIntervention = z.infer<typeof TherapeuticInterventionSchema>;

export const BiomarkerDefinitionSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['expression', 'mutation', 'fusion', 'hla_type', 'protein_level', 'signature', 'other']),
  gene: z.string().optional(),
  variant: z.string().optional(),
  hlaAllele: z.string().optional(),
  assayFeasibility: z.enum(['routine', 'specialized', 'research_only', 'unknown']).default('unknown'),
});
export type BiomarkerDefinition = z.infer<typeof BiomarkerDefinitionSchema>;

export const TherapeuticStrategySchema = z.object({
  /** v1 permits exactly one. The array exists so combinations later relax a
   *  constraint rather than redesigning the contract. */
  interventions: z.array(TherapeuticInterventionSchema).length(1),
  indication: z.string().optional(),
  /** Patient eligibility, a Q3 question. Never enters the strategy fingerprint. */
  selectionBiomarkers: z.array(BiomarkerDefinitionSchema).optional(),
  strategySource: z.enum(['user_specified', 'inferred', 'partially_inferred']),
  strategyConfidence: z.enum(['high', 'moderate', 'low']),
  assumptions: z.array(z.string()).optional(),
});
export type TherapeuticStrategy = z.infer<typeof TherapeuticStrategySchema>;

export const Q1HypothesisSchema = z.object({
  key: z.string().min(1),
  target: TargetIdentitySchema,
  targetRole: TargetRoleSchema,
  biologicalIntent: BiologicalIntentSchema,
});
export type Q1Hypothesis = z.infer<typeof Q1HypothesisSchema>;

export const ResolvedQueryScopeSchema = z.object({
  subjectTargets: z.array(TargetIdentitySchema).min(1),
  indication: z.string().optional(),
  rawPrompt: z.string().min(1),
});
export type ResolvedQueryScope = z.infer<typeof ResolvedQueryScopeSchema>;
