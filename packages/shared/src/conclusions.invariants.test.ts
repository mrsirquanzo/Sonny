import { describe, expect, it } from 'vitest';
import {
  ConclusionSupportSchema,
  Q2ConclusionSchema,
  Q3ComparativeConclusionSchema,
  Q3ConclusionSchema,
  Q3StrategyOverlaySchema,
  Q4ConclusionSchema,
  Q5ConclusionSchema,
  Q6ConclusionSchema,
} from './index.js';

const support = { supportingClaimIds: ['c1'], evidenceIds: ['e1'] };
const context = {
  canonicalContextId: 'ctx-1',
  ontologySource: 'MONDO',
  ontologyVersion: '2026-01',
  indication: { raw: 'NSCLC', canonicalName: 'non-small cell lung carcinoma', ontologyId: 'MONDO:0005233' },
  mappingConfidence: 'exact',
};
const ranked = (strategyFingerprint: string, rank: number) => ({
  strategyFingerprint,
  opportunity: 'strong',
  rank,
  confidence: 'high',
  evidenceAvailability: 'rich',
  support,
});
const comparative = (rankedStrategies: ReturnType<typeof ranked>[], winner?: string) => ({
  mode: 'comparative',
  assessments: [{
    context,
    rankedStrategies,
    ...(winner === undefined ? {} : { winningStrategyFingerprint: winner }),
  }],
});
const liability = (id: string, severity = 'high') => ({
  id,
  description: 'A material safety liability.',
  category: { domain: 'safety', code: 'common.off_target_activity' },
  likelihood: 'moderate',
  severity,
  mitigability: 'design_manageable',
  confidence: 'moderate',
  support,
});
const q6 = (overrides: Record<string, unknown> = {}) => ({
  overallDevelopmentRisk: 'high',
  liabilities: [liability('r1')],
  domainAssessments: [],
  topProgrammeKillingRiskIds: ['r1'],
  highestPriorityRiskMitigationOrMonitoringStep: 'Improve selectivity.',
  earliestDecisiveDeRiskingStudy: 'Run a broad selectivity panel.',
  confidence: 'moderate',
  support,
  ...overrides,
});

describe('conclusion support', () => {
  it('keeps claim ids, derived evidence ids, and retrieval audit ids in separate fields', () => {
    expect(ConclusionSupportSchema.parse({
      supportingClaimIds: ['claim-1'],
      evidenceIds: ['PMID:1'],
      retrievalAuditIds: ['audit-1'],
    })).toEqual({
      supportingClaimIds: ['claim-1'],
      evidenceIds: ['PMID:1'],
      retrievalAuditIds: ['audit-1'],
    });
  });

  it('does not invent defaults for any support namespace', () => {
    expect(ConclusionSupportSchema.safeParse({ evidenceIds: [] }).success).toBe(false);
    expect(ConclusionSupportSchema.safeParse({ supportingClaimIds: [] }).success).toBe(false);
  });
});

describe('insufficient conclusion branches', () => {
  it('pins Q2 insufficient confidence to low and does not carry assessed-only fields', () => {
    const base = { modalityFit: 'insufficient_evidence', confidence: 'low', evidenceGap: 'No exposure data.', support };
    expect(Q2ConclusionSchema.safeParse(base).success).toBe(true);
    expect(Q2ConclusionSchema.safeParse({ ...base, confidence: 'moderate' }).success).toBe(false);
    // Rejected, not stripped. Silent repair was the wrong failure mode: the
    // model asserted a confident bottleneck while declaring insufficient
    // evidence, and that contradiction should surface rather than be tidied.
    expect(Q2ConclusionSchema.safeParse({
      ...base, mechanisticBottleneck: 'Fabricated bottleneck',
    }).success).toBe(false);
  });

  it('pins Q6 insufficient confidence to low and does not carry fabricated mitigation fields', () => {
    const base = {
      overallDevelopmentRisk: 'insufficient_evidence',
      liabilities: [],
      domainAssessments: [],
      evidenceGap: 'No modality-specific safety evidence.',
      confidence: 'low',
      support,
    };
    expect(Q6ConclusionSchema.safeParse(base).success).toBe(true);
    expect(Q6ConclusionSchema.safeParse({ ...base, confidence: 'moderate' }).success).toBe(false);
    // Rejected, not stripped - same reasoning as the Q2 case above.
    expect(Q6ConclusionSchema.safeParse({
      ...base, highestPriorityRiskMitigationOrMonitoringStep: 'Invent a mitigation.',
    }).success).toBe(false);
  });
});

describe('Q3 conclusion modes and comparative rankings', () => {
  it('accepts each structurally valid mode', () => {
    expect(Q3StrategyOverlaySchema.safeParse({
      mode: 'strategy_overlay', assessments: [],
    }).success).toBe(true);
    expect(Q3ComparativeConclusionSchema.safeParse(comparative([ranked('fp-1', 1)], 'fp-1')).success).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(Q3ConclusionSchema.safeParse({ mode: 'shared_overlay', assessments: [] }).success).toBe(false);
  });

  it('rejects duplicate strategy fingerprints within a context', () => {
    expect(Q3ComparativeConclusionSchema.safeParse(
      comparative([ranked('fp-1', 1), ranked('fp-1', 2)], 'fp-1'),
    ).success).toBe(false);
  });

  it('rejects non-contiguous, duplicate, zero, negative and fractional ranks', () => {
    for (const ranks of [[1, 3], [1, 1], [0, 1], [-1, 1], [1, 1.5]]) {
      expect(Q3ComparativeConclusionSchema.safeParse(
        comparative(ranks.map((rank, index) => ranked(`fp-${index}`, rank)), 'fp-0'),
      ).success).toBe(false);
    }
  });

  it('requires a named winner to exist and rank first', () => {
    const rows = [ranked('fp-1', 1), ranked('fp-2', 2)];
    expect(Q3ComparativeConclusionSchema.safeParse(comparative(rows, 'missing')).success).toBe(false);
    expect(Q3ComparativeConclusionSchema.safeParse(comparative(rows, 'fp-2')).success).toBe(false);
    expect(Q3ComparativeConclusionSchema.safeParse(comparative(rows, 'fp-1')).success).toBe(true);
  });
});

describe('Q6 assessed conclusions', () => {
  it('allows a genuinely low-risk conclusion with no liabilities or programme-killing ids', () => {
    expect(Q6ConclusionSchema.safeParse(q6({
      overallDevelopmentRisk: 'low',
      liabilities: [],
      topProgrammeKillingRiskIds: [],
    })).success).toBe(true);
  });

  it('requires a liability for every non-low assessed risk', () => {
    for (const overallDevelopmentRisk of ['moderate', 'high', 'prohibitive']) {
      expect(Q6ConclusionSchema.safeParse(q6({
        overallDevelopmentRisk, liabilities: [], topProgrammeKillingRiskIds: [],
      })).success).toBe(false);
    }
  });

  it('requires high and prohibitive assessments to name a programme-killing risk', () => {
    for (const overallDevelopmentRisk of ['high', 'prohibitive']) {
      expect(Q6ConclusionSchema.safeParse(q6({
        overallDevelopmentRisk, topProgrammeKillingRiskIds: [],
      })).success).toBe(false);
    }
  });

  it('resolves programme-killing ids within liabilities', () => {
    expect(Q6ConclusionSchema.safeParse(q6({ topProgrammeKillingRiskIds: ['missing'] })).success).toBe(false);
  });

  it('permits only high or programme_ending severity in programme-killing ids', () => {
    for (const severity of ['low', 'moderate']) {
      expect(Q6ConclusionSchema.safeParse(q6({
        liabilities: [liability('r1', severity)],
      })).success).toBe(false);
    }
    expect(Q6ConclusionSchema.safeParse(q6({
      liabilities: [liability('r1', 'programme_ending')],
    })).success).toBe(true);
  });

  it('forbids programme-killing ids on a low overall assessment', () => {
    expect(Q6ConclusionSchema.safeParse(q6({
      overallDevelopmentRisk: 'low',
    })).success).toBe(false);
  });
});

describe('absence conclusion shapes', () => {
  it('accepts Q4 absent with empty positive support and retrieval audits', () => {
    expect(Q4ConclusionSchema.safeParse({
      precedent: 'absent',
      confidence: 'moderate',
      support: { supportingClaimIds: [], evidenceIds: [], retrievalAuditIds: ['a1'] },
    }).success).toBe(true);
  });

  it('accepts Q5 open only with positive support and retrieval audits', () => {
    expect(Q5ConclusionSchema.safeParse({
      landscapeDensity: 'open',
      differentiationPotential: 'clear',
      ipSignal: 'low',
      confidence: 'moderate',
      support: { supportingClaimIds: ['c1'], evidenceIds: ['e1'], retrievalAuditIds: ['a1'] },
    }).success).toBe(true);
  });

  it('accepts Q6 low only with positive support and retrieval audits', () => {
    expect(Q6ConclusionSchema.safeParse(q6({
      overallDevelopmentRisk: 'low',
      liabilities: [],
      topProgrammeKillingRiskIds: [],
      support: { supportingClaimIds: ['c1'], evidenceIds: ['e1'], retrievalAuditIds: ['a1'] },
    }))).toMatchObject({ success: true });
  });
});
