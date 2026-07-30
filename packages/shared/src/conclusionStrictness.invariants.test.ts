import { describe, expect, it } from 'vitest';
import {
  Q2ConclusionSchema,
  Q6ConclusionSchema,
  SpecialistConclusionSchema,
  type ConclusionSupport,
} from './index.js';

const support = (
  supportingClaimIds: string[] = ['claim-1'],
  evidenceIds: string[] = ['evidence-1'],
): ConclusionSupport => ({ supportingClaimIds, evidenceIds });

const assessedQ2 = {
  modalityFit: 'conditional',
  weakestLink: { mechanisticStatus: 'conditional', mitigability: 'engineerable' },
  confidence: 'moderate',
  mechanisticBottleneck: 'Sustained intracellular target engagement.',
  mostDecisiveNextExperiment: 'Measure target engagement and downstream pathway suppression.',
  support: support(),
} as const;

const insufficientQ2 = {
  modalityFit: 'insufficient_evidence',
  confidence: 'low',
  evidenceGap: 'No target-engagement evidence is available.',
  support: support([], []),
} as const;

const assessedQ6 = {
  overallDevelopmentRisk: 'low',
  liabilities: [],
  domainAssessments: [{
    domain: 'safety', status: 'no_material_liability', confidence: 'moderate', support: support(),
  }],
  topProgrammeKillingRiskIds: [],
  highestPriorityRiskMitigationOrMonitoringStep: 'Continue routine modality-relevant safety monitoring.',
  earliestDecisiveDeRiskingStudy: 'Run a modality-relevant repeat-dose toxicology study.',
  confidence: 'moderate',
  support: support(),
} as const;

const insufficientQ6 = {
  overallDevelopmentRisk: 'insufficient_evidence',
  liabilities: [],
  domainAssessments: [{
    domain: 'safety', status: 'insufficient_evidence', confidence: 'low', support: support([], []),
  }],
  evidenceGap: 'No modality-specific safety package is available.',
  confidence: 'low',
  support: support([], []),
} as const;

describe('strict Q2 conclusion branches', () => {
  it('accepts an assessed Q2 with its complete legitimate shape', () => {
    expect(Q2ConclusionSchema.parse(assessedQ2)).toEqual(assessedQ2);
  });

  it('accepts an insufficient-evidence Q2 with its complete legitimate shape', () => {
    expect(Q2ConclusionSchema.parse(insufficientQ2)).toEqual(insufficientQ2);
  });

  it('rejects assessed-only fields on the insufficient-evidence branch', () => {
    expect(Q2ConclusionSchema.safeParse({
      ...insufficientQ2, mechanisticBottleneck: 'This assertion must not survive abstention.',
    }).success).toBe(false);
    expect(Q2ConclusionSchema.safeParse({
      ...insufficientQ2,
      weakestLink: assessedQ2.weakestLink,
      mostDecisiveNextExperiment: assessedQ2.mostDecisiveNextExperiment,
    }).success).toBe(false);
  });

  it('rejects insufficient-only fields on the assessed branch', () => {
    expect(Q2ConclusionSchema.safeParse({
      ...assessedQ2, evidenceGap: 'A contradictory branch-specific field.',
    }).success).toBe(false);
  });

  it('rejects a hybrid instead of picking a branch and stripping the other', () => {
    expect(Q2ConclusionSchema.safeParse({
      ...assessedQ2,
      modalityFit: 'insufficient_evidence',
      confidence: 'low',
      evidenceGap: 'Evidence is insufficient.',
    }).success).toBe(false);
  });

  it('still permits the legitimate optional retrievalAuditIds inside support', () => {
    expect(Q2ConclusionSchema.safeParse({
      ...assessedQ2, support: { ...assessedQ2.support, retrievalAuditIds: ['audit-1'] },
    }).success).toBe(true);
  });
});

describe('strict Q6 conclusion branches', () => {
  it('accepts an assessed Q6 with its complete legitimate shape', () => {
    expect(Q6ConclusionSchema.parse(assessedQ6)).toEqual(assessedQ6);
  });

  it('accepts an insufficient-evidence Q6 with required domainAssessments', () => {
    expect(Q6ConclusionSchema.parse(insufficientQ6)).toEqual(insufficientQ6);
  });

  it('rejects assessed-only fields on the insufficient-evidence branch', () => {
    expect(Q6ConclusionSchema.safeParse({
      ...insufficientQ6,
      highestPriorityRiskMitigationOrMonitoringStep: 'This assertion must not survive abstention.',
    }).success).toBe(false);
    expect(Q6ConclusionSchema.safeParse({
      ...insufficientQ6,
      earliestDecisiveDeRiskingStudy: 'This assertion must not survive abstention.',
      topProgrammeKillingRiskIds: [],
    }).success).toBe(false);
  });

  it('rejects insufficient-only fields on the assessed branch', () => {
    expect(Q6ConclusionSchema.safeParse({
      ...assessedQ6, evidenceGap: 'A contradictory branch-specific field.',
    }).success).toBe(false);
  });

  it('still permits the legitimate optional retrievalAuditIds inside support', () => {
    expect(Q6ConclusionSchema.safeParse({
      ...assessedQ6, support: { ...assessedQ6.support, retrievalAuditIds: ['audit-1'] },
    }).success).toBe(true);
  });
});

describe('SpecialistConclusionSchema with strict nested unions', () => {
  it('continues to discriminate and accept valid Q2 and Q6 carriers', () => {
    expect(SpecialistConclusionSchema.safeParse({ axis: 'moa_pathway', assessment: assessedQ2 }).success).toBe(true);
    expect(SpecialistConclusionSchema.safeParse({ axis: 'modality_developability', assessment: assessedQ6 }).success).toBe(true);
  });

  it('rejects a carrier whose nested insufficient branch carries an assessed-only field', () => {
    expect(SpecialistConclusionSchema.safeParse({
      axis: 'moa_pathway',
      assessment: { ...insufficientQ2, mechanisticBottleneck: 'The carrier must not restore stripping.' },
    }).success).toBe(false);
  });

  it('does not let the carrier discriminator validate a conclusion from the wrong axis', () => {
    expect(SpecialistConclusionSchema.safeParse({ axis: 'moa_pathway', assessment: assessedQ6 }).success).toBe(false);
    expect(SpecialistConclusionSchema.safeParse({ axis: 'modality_developability', assessment: assessedQ2 }).success).toBe(false);
  });
});
