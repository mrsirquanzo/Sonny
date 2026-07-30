import { describe, expect, it } from 'vitest';
import {
  Q2ConclusionSchema,
  Q6ConclusionSchema,
  SpecialistConclusionSchema,
  type ConclusionSupport,
  type DiseaseContextKey,
  type SpecialistConclusion,
} from '@mrsirquanzo/sonny-shared';
import { normalizeDiseaseContext } from '../diseaseContext.js';
import { ontologyFixture } from '../slice4/ontologyFixture.js';

const support = (
  supportingClaimIds: string[] = ['claim-1'],
  evidenceIds: string[] = ['evidence-1'],
): ConclusionSupport => ({
  supportingClaimIds,
  evidenceIds,
});

const context: DiseaseContextKey = normalizeDiseaseContext(
  { indication: 'NSCLC' },
  ontologyFixture,
);

const lowRiskQ6 = {
  overallDevelopmentRisk: 'low',
  liabilities: [],
  domainAssessments: [
    {
      domain: 'safety',
      status: 'no_material_liability',
      confidence: 'moderate',
      support: support(),
    },
  ],
  topProgrammeKillingRiskIds: [],
  highestPriorityRiskMitigationOrMonitoringStep:
    'Continue routine safety monitoring.',
  earliestDecisiveDeRiskingStudy:
    'Run a modality-relevant repeat-dose toxicology study.',
  confidence: 'moderate',
  support: support(),
} as const;

describe('Q2 discriminated conclusion branches', () => {
  it('requires evidenceGap and low confidence under insufficient evidence', () => {
    expect(Q2ConclusionSchema.safeParse({
      modalityFit: 'insufficient_evidence',
      confidence: 'low',
      evidenceGap: 'No target-engagement data are available.',
      support: support([], []),
    }).success).toBe(true);

    expect(Q2ConclusionSchema.safeParse({
      modalityFit: 'insufficient_evidence',
      confidence: 'low',
      support: support([], []),
    }).success).toBe(false);

    expect(Q2ConclusionSchema.safeParse({
      modalityFit: 'insufficient_evidence',
      confidence: 'moderate',
      evidenceGap: 'No target-engagement data are available.',
      support: support([], []),
    }).success).toBe(false);
  });

  it('REJECTS an assessed-only mechanisticBottleneck on the insufficient branch', () => {
    // Strict branches now reject rather than strip. A model asserting a
    // confident bottleneck while declaring insufficient evidence is a
    // contradiction that should surface, not be silently tidied away.
    const parsed = Q2ConclusionSchema.safeParse({
      modalityFit: 'insufficient_evidence',
      confidence: 'low',
      evidenceGap: 'No target-engagement data are available.',
      mechanisticBottleneck: 'A model-fabricated bottleneck.',
      mostDecisiveNextExperiment: 'A model-fabricated experiment.',
      weakestLink: {
        mechanisticStatus: 'unsupported',
        mitigability: 'unknown',
      },
      support: support([], []),
    });

    expect(parsed.success).toBe(false);
  });
});

describe('Q6 discriminated conclusion branches', () => {
  it('requires evidenceGap and low confidence under insufficient evidence', () => {
    expect(Q6ConclusionSchema.safeParse({
      overallDevelopmentRisk: 'insufficient_evidence',
      liabilities: [],
      domainAssessments: [],
      evidenceGap: 'No modality-specific safety package is available.',
      confidence: 'low',
      support: support([], []),
    }).success).toBe(true);

    expect(Q6ConclusionSchema.safeParse({
      overallDevelopmentRisk: 'insufficient_evidence',
      liabilities: [],
      domainAssessments: [],
      confidence: 'low',
      support: support([], []),
    }).success).toBe(false);

    expect(Q6ConclusionSchema.safeParse({
      overallDevelopmentRisk: 'insufficient_evidence',
      liabilities: [],
      domainAssessments: [],
      evidenceGap: 'No modality-specific safety package is available.',
      confidence: 'moderate',
      support: support([], []),
    }).success).toBe(false);
  });

  it('REJECTS assessed-only mitigation fields on the insufficient branch', () => {
    // Strict branches reject rather than strip - same reasoning as Q2 above.
    const parsed = Q6ConclusionSchema.safeParse({
      overallDevelopmentRisk: 'insufficient_evidence',
      liabilities: [],
      domainAssessments: [],
      evidenceGap: 'No modality-specific safety package is available.',
      confidence: 'low',
      highestPriorityRiskMitigationOrMonitoringStep:
        'A model-fabricated mitigation.',
      earliestDecisiveDeRiskingStudy:
        'A model-fabricated de-risking study.',
      topProgrammeKillingRiskIds: ['fabricated-risk'],
      support: support([], []),
    });

    expect(parsed.success).toBe(false);
  });
});

describe('Q6 assessed invariants', () => {
  it('accepts a genuinely low-risk conclusion with zero liabilities', () => {
    expect(Q6ConclusionSchema.safeParse(lowRiskQ6).success).toBe(true);
  });

  it.each(['moderate', 'high', 'prohibitive'] as const)(
    'rejects %s overall risk with no liability',
    (overallDevelopmentRisk) => {
      expect(Q6ConclusionSchema.safeParse({
        ...lowRiskQ6,
        overallDevelopmentRisk,
        liabilities: [],
        topProgrammeKillingRiskIds: [],
      }).success).toBe(false);
    },
  );

  it('rejects dangling programme-killing risk ids', () => {
    expect(Q6ConclusionSchema.safeParse({
      ...lowRiskQ6,
      overallDevelopmentRisk: 'high',
      liabilities: [{
        id: 'risk-1',
        description: 'A serious off-target liability.',
        category: {
          domain: 'safety',
          code: 'common.off_target_activity',
        },
        likelihood: 'moderate',
        severity: 'high',
        mitigability: 'design_manageable',
        confidence: 'moderate',
        support: support(),
      }],
      topProgrammeKillingRiskIds: ['missing-risk'],
    }).success).toBe(false);
  });

  it.each(['low', 'moderate'] as const)(
    'rejects a programme-killing id pointing to a %s-severity liability',
    (severity) => {
      expect(Q6ConclusionSchema.safeParse({
        ...lowRiskQ6,
        overallDevelopmentRisk: 'high',
        liabilities: [{
          id: 'risk-1',
          description: 'A liability that is not programme-killing.',
          category: {
            domain: 'safety',
            code: 'common.off_target_activity',
          },
          likelihood: 'moderate',
          severity,
          mitigability: 'design_manageable',
          confidence: 'moderate',
          support: support(),
        }],
        topProgrammeKillingRiskIds: ['risk-1'],
      }).success).toBe(false);
    },
  );

  it('rejects programme-killing risk ids on a low-risk conclusion', () => {
    expect(Q6ConclusionSchema.safeParse({
      ...lowRiskQ6,
      topProgrammeKillingRiskIds: ['risk-1'],
      liabilities: [{
        id: 'risk-1',
        description: 'A programme-ending liability.',
        category: {
          domain: 'safety',
          code: 'common.off_target_activity',
        },
        likelihood: 'high',
        severity: 'programme_ending',
        mitigability: 'not_manageable',
        confidence: 'high',
        support: support(),
      }],
    }).success).toBe(false);
  });
});

describe('every specialist conclusion carries support', () => {
  const conclusions: SpecialistConclusion[] = [
    {
      axis: 'target_biology',
      assessments: [{
        context,
        q1HypothesisKey: 'KRAS|disease_driver|suppress_function',
        target: {
          kind: 'gene_or_protein',
          symbol: 'KRAS',
          targetForm: 'G12C',
        },
        targetRole: 'disease_driver',
        biologicalIntent: 'suppress_function',
        validity: 'strong',
        confidence: 'moderate',
        evidenceAvailability: 'rich',
        support: support(),
      }],
    },
    {
      axis: 'moa_pathway',
      assessment: {
        modalityFit: 'strong',
        weakestLink: {
          mechanisticStatus: 'supported',
          mitigability: 'engineerable',
        },
        confidence: 'moderate',
        mechanisticBottleneck: 'Sustained target engagement.',
        mostDecisiveNextExperiment: 'Measure cellular target engagement.',
        support: support(),
      },
    },
    {
      axis: 'disease_indications',
      conclusion: {
        mode: 'comparative',
        assessments: [{
          context,
          rankedStrategies: [{
            strategyFingerprint: 'strategy-1',
            opportunity: 'strong',
            rank: 1,
            confidence: 'moderate',
            evidenceAvailability: 'rich',
            support: support(),
          }],
          winningStrategyFingerprint: 'strategy-1',
        }],
      },
    },
    {
      axis: 'clinical_landscape',
      assessment: {
        precedent: 'supportive',
        evidenceMaturity: 'clinical',
        confidence: 'moderate',
        support: support(),
      },
    },
    {
      axis: 'competitive_ip',
      assessment: {
        landscapeDensity: 'emerging',
        differentiationPotential: 'plausible',
        ipSignal: 'moderate',
        confidence: 'moderate',
        support: support(),
      },
    },
    {
      axis: 'modality_developability',
      assessment: {
        overallDevelopmentRisk: 'insufficient_evidence',
        liabilities: [],
        domainAssessments: [],
        evidenceGap: 'No modality-specific development package is available.',
        confidence: 'low',
        support: support([], []),
      },
    },
  ];

  it('accepts all six carriers with their required support objects', () => {
    expect(conclusions).toHaveLength(6);

    for (const conclusion of conclusions) {
      expect(
        SpecialistConclusionSchema.safeParse(conclusion).success,
        conclusion.axis,
      ).toBe(true);

      expect(JSON.stringify(conclusion)).toContain('"support"');
    }
  });

  it('rejects a carrier whose nested conclusion omits support', () => {
    expect(SpecialistConclusionSchema.safeParse({
      axis: 'clinical_landscape',
      assessment: {
        precedent: 'supportive',
        evidenceMaturity: 'clinical',
        confidence: 'moderate',
      },
    }).success).toBe(false);
  });
});

describe('Q1 and Q3 use normalized DiseaseContextKey values', () => {
  it('accepts a Q1 assessment carrying a real normalized context', () => {
    const normalized = normalizeDiseaseContext(
      { indication: 'NSCLC' },
      ontologyFixture,
    );

    expect(SpecialistConclusionSchema.safeParse({
      axis: 'target_biology',
      assessments: [{
        context: normalized,
        q1HypothesisKey: 'KRAS|disease_driver|suppress_function',
        target: {
          kind: 'gene_or_protein',
          symbol: 'KRAS',
          targetForm: 'G12C',
        },
        targetRole: 'disease_driver',
        biologicalIntent: 'suppress_function',
        validity: 'strong',
        confidence: 'moderate',
        evidenceAvailability: 'rich',
        support: support(),
      }],
    }).success).toBe(true);
  });

  it('accepts a Q3 assessment carrying the same normalized context identity', () => {
    const normalized = normalizeDiseaseContext(
      { indication: 'NSCLC' },
      ontologyFixture,
    );

    const parsed = SpecialistConclusionSchema.parse({
      axis: 'disease_indications',
      conclusion: {
        mode: 'comparative',
        assessments: [{
          context: normalized,
          rankedStrategies: [{
            strategyFingerprint: 'strategy-1',
            opportunity: 'strong',
            rank: 1,
            confidence: 'moderate',
            evidenceAvailability: 'rich',
            support: support(),
          }],
          winningStrategyFingerprint: 'strategy-1',
        }],
      },
    });

    if (parsed.axis !== 'disease_indications') {
      throw new Error('unexpected axis');
    }

    expect(
      parsed.conclusion.assessments[0].context.canonicalContextId,
    ).toBe(normalized.canonicalContextId);
  });

  it('rejects an unresolved context with no possible matches', () => {
    expect(SpecialistConclusionSchema.safeParse({
      axis: 'target_biology',
      assessments: [{
        context: {
          canonicalContextId: 'invented-context',
          ontologySource: 'MONDO',
          ontologyVersion: '2026-06-02',
          indication: {
            raw: 'ambiguous disease',
            canonicalName: 'ambiguous disease',
          },
          mappingConfidence: 'unresolved',
          mappingRelation: 'unresolved',
        },
        q1HypothesisKey: 'KRAS|disease_driver|suppress_function',
        target: { kind: 'gene_or_protein', symbol: 'KRAS' },
        targetRole: 'disease_driver',
        biologicalIntent: 'suppress_function',
        validity: 'insufficient_evidence',
        confidence: 'low',
        evidenceAvailability: 'absent',
        support: support([], []),
      }],
    }).success).toBe(false);
  });
});
