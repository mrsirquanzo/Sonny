import { z } from 'zod';
import { RiskCodeSchema, RiskDomainSchema, RISK_CODE_METADATA, isOtherCode } from './riskTaxonomy.js';
import { SpecialistAxisIdSchema } from './specialistAxes.js';
import { TargetIdentitySchema, TargetRoleSchema, BiologicalIntentSchema } from './strategy.js';

const Confidence = z.enum(['high', 'moderate', 'low']);
const EvidenceAvailability = z.enum(['rich', 'sparse', 'absent']);

/**
 * Claim ids and evidence ids are different namespaces.
 * `evidenceIds` is DERIVED from the citations of supporting claims, never
 * emitted freely by a model; letting a model author them would reintroduce the
 * phantom-citation problem one layer above the grounding gate.
 * `retrievalAuditIds` supports absence conclusions, which no positive claim can.
 */
export const ConclusionSupportSchema = z.object({
  supportingClaimIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  retrievalAuditIds: z.array(z.string()).optional(),
});
export type ConclusionSupport = z.infer<typeof ConclusionSupportSchema>;

// ---------------------------------------------------------------- disease context

export const DiseaseContextKeySchema = z.object({
  canonicalContextId: z.string().min(1),
  ontologySource: z.string().min(1),
  ontologyVersion: z.string().min(1),
  indication: z.object({
    raw: z.string(), canonicalName: z.string(), ontologyId: z.string().optional(),
  }),
  biomarker: z.object({
    raw: z.string(), canonicalName: z.string(),
    geneId: z.string().optional(), variantId: z.string().optional(),
  }).optional(),
  diseaseSubtype: z.string().optional(),
  treatmentSetting: z.string().optional(),
  mappingConfidence: z.enum(['exact', 'inferred', 'unresolved']),
  /**
   * How the identity was reached. `broad` / `narrow` / `related` are recorded
   * as such and can NEVER be read back as equivalence - that is what makes the
   * "never convert a broad mapping into equivalence" rule auditable rather than
   * merely stated.
   */
  mappingRelation: z.enum(['exact', 'narrow', 'broad', 'related', 'unresolved']).optional(),
  matchedVia: z.object({
    source: z.enum(['MONDO', 'EFO', 'DOID', 'NCIT', 'ORPHANET', 'MESH']),
    sourceId: z.string().optional(),
    labelOrSynonym: z.string().min(1),
  }).optional(),
  possibleMatches: z.array(z.object({
    canonicalContextId: z.string().min(1), reason: z.string().min(1),
  })).optional(),
}).superRefine((c, ctx) => {
  if (c.mappingConfidence === 'unresolved' && !c.possibleMatches?.length) {
    ctx.addIssue({ code: 'custom', message: 'unresolved contexts must carry possibleMatches with reasons' });
  }
});
export type DiseaseContextKey = z.infer<typeof DiseaseContextKeySchema>;

// ---------------------------------------------------------------- Q1 / Q3 per-context

export const Q1ContextAssessmentSchema = z.object({
  context: DiseaseContextKeySchema,
  q1HypothesisKey: z.string().min(1),
  target: TargetIdentitySchema,
  targetRole: TargetRoleSchema,
  biologicalIntent: BiologicalIntentSchema,
  validity: z.enum(['strong', 'conditional', 'weak', 'unsupported', 'insufficient_evidence']),
  confidence: Confidence,
  evidenceAvailability: EvidenceAvailability,
  support: ConclusionSupportSchema,
});
export type Q1ContextAssessment = z.infer<typeof Q1ContextAssessmentSchema>;

export const Q3ContextAssessmentSchema = z.object({
  context: DiseaseContextKeySchema,
  opportunity: z.enum(['strong', 'moderate', 'weak', 'unsupported', 'insufficient_evidence']),
  rank: z.number().int().positive().optional(),
  confidence: Confidence,
  evidenceAvailability: EvidenceAvailability,
  support: ConclusionSupportSchema,
});
export type Q3ContextAssessment = z.infer<typeof Q3ContextAssessmentSchema>;

// ---------------------------------------------------------------- Q3 outputs

/**
 * Q3a is an INTERNAL artifact, never a Section. It carries its own claims so
 * the synthesizer can resolve the comparative conclusion's support without a
 * run-level claim store.
 */
export const Q3aResultSchema = z.object({
  claims: z.array(z.object({
    id: z.string().min(1), text: z.string().min(1),
    citations: z.array(z.string()), confidence: z.number(),
  })),
  assessments: z.array(Q3ContextAssessmentSchema),
  sources: z.array(z.string()),
  rag: z.enum(['green', 'amber', 'red']),
});
export type Q3aResult = z.infer<typeof Q3aResultSchema>;

export const Q3StrategyOverlaySchema = z.object({
  mode: z.literal('strategy_overlay'),
  assessments: z.array(Q3ContextAssessmentSchema),
});

const RankedStrategySchema = z.object({
  strategyFingerprint: z.string().min(1),
  strategyVariantLabel: z.string().optional(),
  opportunity: z.enum(['strong', 'moderate', 'weak', 'unsupported', 'insufficient_evidence']),
  rank: z.number().int().positive(),
  confidence: Confidence,
  evidenceAvailability: EvidenceAvailability,
  support: ConclusionSupportSchema,
});

export const Q3ComparativeContextAssessmentSchema = z.object({
  context: DiseaseContextKeySchema,
  rankedStrategies: z.array(RankedStrategySchema).min(1),
  winningStrategyFingerprint: z.string().optional(),
}).superRefine((a, ctx) => {
  const fps = a.rankedStrategies.map((r) => r.strategyFingerprint);
  if (new Set(fps).size !== fps.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate strategyFingerprint in rankedStrategies' });
  }
  const ranks = a.rankedStrategies.map((r) => r.rank).sort((x, y) => x - y);
  // Ranks must start at 1 and be contiguous, allowing ties (1,1,3 style).
  if (ranks[0] !== 1) {
    ctx.addIssue({ code: 'custom', message: 'ranking must begin at rank 1' });
  }
  for (let i = 1; i < ranks.length; i++) {
    const gap = ranks[i] - ranks[i - 1];
    if (gap !== 0 && ranks[i] !== i + 1 && gap !== 0) {
      const tiedBefore = ranks.slice(0, i).filter((r) => r === ranks[i - 1]).length;
      if (ranks[i] !== ranks[i - 1] + tiedBefore) {
        ctx.addIssue({ code: 'custom', message: `non-contiguous ranking at ${ranks[i]}` });
      }
    }
  }
  if (a.winningStrategyFingerprint !== undefined) {
    const winner = a.rankedStrategies.find((r) => r.strategyFingerprint === a.winningStrategyFingerprint);
    if (!winner) {
      ctx.addIssue({ code: 'custom', message: 'winningStrategyFingerprint is not present in rankedStrategies' });
    } else if (winner.rank !== 1) {
      ctx.addIssue({ code: 'custom', message: 'winningStrategyFingerprint must rank first' });
    } else if (ranks.filter((r) => r === 1).length > 1) {
      ctx.addIssue({ code: 'custom', message: 'a tie at rank 1 must omit winningStrategyFingerprint' });
    }
  }
});

export const Q3ComparativeConclusionSchema = z.object({
  mode: z.literal('comparative'),
  assessments: z.array(Q3ComparativeContextAssessmentSchema),
});

export const Q3ConclusionSchema = z.discriminatedUnion('mode', [
  Q3StrategyOverlaySchema,
  Q3ComparativeConclusionSchema,
]);
export type Q3Conclusion = z.infer<typeof Q3ConclusionSchema>;

// ---------------------------------------------------------------- Q2

const Q2Assessed = z.object({
  modalityFit: z.enum(['strong', 'conditional', 'weak', 'unsupported']),
  weakestLink: z.object({
    mechanisticStatus: z.enum(['supported', 'conditional', 'unsupported']),
    mitigability: z.enum(['engineerable', 'fundamental', 'unknown']),
  }),
  confidence: Confidence,
  mechanisticBottleneck: z.string().min(1),
  mostDecisiveNextExperiment: z.string().min(1),
  support: ConclusionSupportSchema,
});
const Q2Insufficient = z.object({
  modalityFit: z.literal('insufficient_evidence'),
  confidence: z.literal('low'),
  evidenceGap: z.string().min(1),
  support: ConclusionSupportSchema,
});
export const Q2ConclusionSchema = z.union([Q2Assessed, Q2Insufficient]);
export type Q2Conclusion = z.infer<typeof Q2ConclusionSchema>;

// ---------------------------------------------------------------- Q4 / Q5

export const Q4ConclusionSchema = z.object({
  precedent: z.enum(['supportive', 'mixed', 'negative', 'absent', 'insufficient_evidence']),
  evidenceMaturity: z.enum(['clinical', 'human_translational', 'preclinical_only']).optional(),
  confidence: Confidence,
  support: ConclusionSupportSchema,
});
export type Q4Conclusion = z.infer<typeof Q4ConclusionSchema>;

export const Q5ConclusionSchema = z.object({
  landscapeDensity: z.enum(['open', 'emerging', 'crowded', 'insufficient_evidence']),
  differentiationPotential: z.enum(['clear', 'plausible', 'weak', 'insufficient_evidence']),
  ipSignal: z.enum(['low', 'moderate', 'high', 'unknown']),
  confidence: Confidence,
  support: ConclusionSupportSchema,
});
export type Q5Conclusion = z.infer<typeof Q5ConclusionSchema>;

// ---------------------------------------------------------------- Q6

export const ModalityRiskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  category: z.object({ domain: RiskDomainSchema, code: RiskCodeSchema }),
  likelihood: z.enum(['low', 'moderate', 'high', 'unknown']),
  severity: z.enum(['low', 'moderate', 'high', 'programme_ending']),
  mitigability: z.enum(['design_manageable', 'clinically_manageable', 'not_manageable', 'unknown']),
  confidence: Confidence,
  taxonomyNote: z.string().optional(),
  support: ConclusionSupportSchema,
}).superRefine((r, ctx) => {
  if (RISK_CODE_METADATA[r.category.code].domain !== r.category.domain) {
    ctx.addIssue({ code: 'custom', message: `code ${r.category.code} does not belong to domain ${r.category.domain}` });
  }
  if (isOtherCode(r.category.code) && !r.taxonomyNote?.trim()) {
    ctx.addIssue({ code: 'custom', message: 'common.other_* requires taxonomyNote explaining why no controlled code fit' });
  }
});
export type ModalityRisk = z.infer<typeof ModalityRiskSchema>;

/**
 * Structured record that a risk domain was evaluated. Without this a low-risk
 * conclusion has no inspectable evidence of analysis: zero material liabilities
 * and zero risk analysis look identical.
 */
export const RiskDomainAssessmentSchema = z.object({
  domain: RiskDomainSchema,
  status: z.enum(['no_material_liability', 'manageable', 'material_liability_identified', 'insufficient_evidence']),
  confidence: Confidence,
  support: ConclusionSupportSchema,
});
export type RiskDomainAssessment = z.infer<typeof RiskDomainAssessmentSchema>;

const Q6Assessed = z.object({
  overallDevelopmentRisk: z.enum(['low', 'moderate', 'high', 'prohibitive']),
  liabilities: z.array(ModalityRiskSchema),
  domainAssessments: z.array(RiskDomainAssessmentSchema),
  topProgrammeKillingRiskIds: z.array(z.string()).max(3),
  highestPriorityRiskMitigationOrMonitoringStep: z.string().min(1),
  earliestDecisiveDeRiskingStudy: z.string().min(1),
  confidence: Confidence,
  support: ConclusionSupportSchema,
}).superRefine((q6, ctx) => {
  if (q6.overallDevelopmentRisk !== 'low' && q6.liabilities.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'moderate, high, or prohibitive risk requires at least one liability' });
  }
  if (['high', 'prohibitive'].includes(q6.overallDevelopmentRisk) && q6.topProgrammeKillingRiskIds.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'high or prohibitive risk requires at least one programme-killing risk' });
  }
  if (q6.overallDevelopmentRisk === 'low' && q6.topProgrammeKillingRiskIds.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'a low overall risk cannot name programme-killing risks' });
  }
  // Liability ids must be unique. With duplicates, `byId` keeps the LAST entry,
  // so whether a programme-killing reference resolves to a high-severity or a
  // low-severity liability depends on array order - a silent, order-dependent
  // change of meaning in the field that names what could kill the programme.
  const ids = q6.liabilities.map((l) => l.id);
  const duplicated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicated.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['liabilities'], message: `duplicate liability id(s): ${duplicated.join(', ')}` });
  }
  const byId = new Map(q6.liabilities.map((l) => [l.id, l]));
  for (const id of q6.topProgrammeKillingRiskIds) {
    const l = byId.get(id);
    if (!l) {
      ctx.addIssue({ code: 'custom', message: `topProgrammeKillingRiskIds references unknown liability ${id}` });
    } else if (!['high', 'programme_ending'].includes(l.severity)) {
      ctx.addIssue({ code: 'custom', message: `programme-killing risk ${id} has severity ${l.severity}` });
    }
  }
});
const Q6Insufficient = z.object({
  overallDevelopmentRisk: z.literal('insufficient_evidence'),
  liabilities: z.array(ModalityRiskSchema),
  domainAssessments: z.array(RiskDomainAssessmentSchema),
  evidenceGap: z.string().min(1),
  confidence: z.literal('low'),
  support: ConclusionSupportSchema,
}).superRefine((q6, ctx) => {
  const ids = q6.liabilities.map((l) => l.id);
  const duplicated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicated.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['liabilities'], message: `duplicate liability id(s): ${duplicated.join(', ')}` });
  }
});
export const Q6ConclusionSchema = z.union([Q6Assessed, Q6Insufficient]);
export type Q6Conclusion = z.infer<typeof Q6ConclusionSchema>;

// ---------------------------------------------------------------- carrier

export const SpecialistConclusionSchema = z.discriminatedUnion('axis', [
  z.object({ axis: z.literal('target_biology'),          assessments: z.array(Q1ContextAssessmentSchema) }),
  z.object({ axis: z.literal('moa_pathway'),             assessment: Q2ConclusionSchema }),
  z.object({ axis: z.literal('disease_indications'),     conclusion: Q3ConclusionSchema }),
  z.object({ axis: z.literal('clinical_landscape'),      assessment: Q4ConclusionSchema }),
  z.object({ axis: z.literal('competitive_ip'),          assessment: Q5ConclusionSchema }),
  z.object({ axis: z.literal('modality_developability'), assessment: Q6ConclusionSchema }),
]);
export type SpecialistConclusion = z.infer<typeof SpecialistConclusionSchema>;

export { SpecialistAxisIdSchema };
