Below is a spec-derived suite organized under `packages/core/src/slice5/`. It does not depend on any slice-5 implementation details beyond the proposed exports.

One deliberate choice: assertions about tracing inspect serialized events instead of assuming a new `TraceEvent` variant, because the current shared union has no conclusion-support-drop event. That mismatch is documented in `AMBIGUITIES.md`.

### `packages/core/src/slice5/conclusionSchemas.invariants.test.ts`

```ts
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

  it('does not retain an assessed-only mechanisticBottleneck on the insufficient branch', () => {
    const parsed = Q2ConclusionSchema.parse({
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

    expect(parsed).not.toHaveProperty('mechanisticBottleneck');
    expect(parsed).not.toHaveProperty('mostDecisiveNextExperiment');
    expect(parsed).not.toHaveProperty('weakestLink');
    expect(parsed).toHaveProperty(
      'evidenceGap',
      'No target-engagement data are available.',
    );
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

  it('does not retain assessed-only mitigation fields on the insufficient branch', () => {
    const parsed = Q6ConclusionSchema.parse({
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

    expect(parsed).not.toHaveProperty(
      'highestPriorityRiskMitigationOrMonitoringStep',
    );
    expect(parsed).not.toHaveProperty('earliestDecisiveDeRiskingStudy');
    expect(parsed).not.toHaveProperty('topProgrammeKillingRiskIds');
    expect(parsed).toHaveProperty(
      'evidenceGap',
      'No modality-specific safety package is available.',
    );
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
```

### `packages/core/src/slice5/conclusionValidation.invariants.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type {
  Claim,
  Evidence,
  RetrievalAudit,
  SpecialistConclusion,
  TraceEvent,
} from '@mrsirquanzo/sonny-shared';
import { SpecialistConclusionSchema } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import { RetrievalAuditStore } from '../retrievalAuditStore.js';
import {
  deriveEvidenceIds,
  validateAndDegrade,
} from '../conclusions/validate.js';

const claim = (
  id: string,
  citations: string[],
  provenance?: 'deterministic',
): Claim => ({
  id,
  text: `Claim ${id}`,
  citations,
  confidence: 0.9,
  ...(provenance ? { provenance } : {}),
});

const evidence = (id: string): Evidence => ({
  id,
  kind: 'publication',
  source: 'Europe PMC',
  title: `Evidence ${id}`,
  snippet: `Evidence passage for ${id}.`,
  url: `https://example.test/${encodeURIComponent(id)}`,
  raw: {},
  retrievedAt: '2026-07-28T12:00:00.000Z',
});

const audit = (
  id: string,
  sourceId: RetrievalAudit['sourceId'],
  queryClass: RetrievalAudit['queryClass'],
  overrides: Partial<RetrievalAudit> = {},
): RetrievalAudit => ({
  id,
  axis: 'clinical_landscape',
  sectionKey: 'clinical_landscape',
  sourceId,
  queryClass,
  queryFingerprint: `fingerprint-${id}`,
  normalizedQueryTerms: ['KRAS', 'NSCLC'],
  status: 'completed',
  executedAt: '2026-07-28T12:00:00.000Z',
  rawResultCount: 0,
  relevantResultCount: 0,
  ...overrides,
});

function registerAdequateQ4Coverage(store: RetrievalAuditStore): string[] {
  const audits: RetrievalAudit[] = [];
  const sources = [
    'clinicaltrials',
    'europepmc',
    'opentargets',
  ] as const;
  const queryClasses = [
    'target_modality',
    'target_class_precedent',
  ] as const;

  for (const sourceId of sources) {
    for (const queryClass of queryClasses) {
      audits.push(audit(`${sourceId}-${queryClass}`, sourceId, queryClass));
    }
  }

  for (const record of audits) {
    store.register(record);
  }

  return audits.map((record) => record.id);
}

const assessedQ2 = (
  supportingClaimIds: string[],
): SpecialistConclusion => ({
  axis: 'moa_pathway',
  assessment: {
    modalityFit: 'conditional',
    weakestLink: {
      mechanisticStatus: 'conditional',
      mitigability: 'engineerable',
    },
    confidence: 'moderate',
    mechanisticBottleneck: 'Sustained intracellular target engagement.',
    mostDecisiveNextExperiment:
      'Measure target engagement and pathway suppression.',
    support: {
      supportingClaimIds,
      evidenceIds: ['model-authored-evidence-id'],
    },
  },
});

const absentQ4 = (
  retrievalAuditIds?: string[],
): SpecialistConclusion => ({
  axis: 'clinical_landscape',
  assessment: {
    precedent: 'absent',
    confidence: 'moderate',
    support: {
      supportingClaimIds: [],
      evidenceIds: [],
      ...(retrievalAuditIds ? { retrievalAuditIds } : {}),
    },
  },
});

describe('support validation and degradation', () => {
  it('degrades when every referenced supporting claim failed verification', () => {
    const result = validateAndDegrade({
      conclusion: assessedQ2(['rejected-claim-1', 'rejected-claim-2']),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore: new RetrievalAuditStore(),
      emit: () => {},
    });

    expect(result.axis).toBe('moa_pathway');
    if (result.axis !== 'moa_pathway') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment).toMatchObject({
      modalityFit: 'insufficient_evidence',
      confidence: 'low',
    });
    expect(result.assessment).toHaveProperty('evidenceGap');
    expect(result.assessment).not.toHaveProperty('mechanisticBottleneck');
    expect(result.assessment).not.toHaveProperty('mostDecisiveNextExperiment');
    expect(
      SpecialistConclusionSchema.safeParse(result).success,
    ).toBe(true);
  });

  it('retains deterministic claims as valid conclusion support', () => {
    const store = new EvidenceStore();
    store.register(evidence('uniprot:KRAS#localization'));

    const result = validateAndDegrade({
      conclusion: assessedQ2(['deterministic-claim']),
      verifiedClaims: [
        claim(
          'deterministic-claim',
          ['uniprot:KRAS#localization'],
          'deterministic',
        ),
      ],
      store,
      auditStore: new RetrievalAuditStore(),
      emit: () => {},
    });

    expect(result.axis).toBe('moa_pathway');
    if (result.axis !== 'moa_pathway') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.modalityFit).toBe('conditional');
    expect(result.assessment.support).toEqual({
      supportingClaimIds: ['deterministic-claim'],
      evidenceIds: ['uniprot:KRAS#localization'],
    });
  });
});

describe('derived evidence ids', () => {
  it('derives stable, unique evidence ids from supporting claim citations', () => {
    const store = new EvidenceStore();
    store.register(evidence('evidence-1'));
    store.register(evidence('evidence-2'));

    expect(deriveEvidenceIds(
      [
        claim('claim-1', ['evidence-1', 'evidence-2']),
        claim('claim-2', ['evidence-2', 'evidence-1']),
      ],
      ['claim-1', 'claim-2'],
      store,
    )).toEqual({
      evidenceIds: ['evidence-1', 'evidence-2'],
      dropped: [],
    });
  });

  it('drops citations that do not resolve in the evidence store', () => {
    const store = new EvidenceStore();
    store.register(evidence('evidence-1'));

    expect(deriveEvidenceIds(
      [claim('claim-1', ['evidence-1', 'phantom-evidence'])],
      ['claim-1'],
      store,
    )).toEqual({
      evidenceIds: ['evidence-1'],
      dropped: ['phantom-evidence'],
    });
  });

  it('overwrites model-authored evidenceIds and traces unresolvable citations', () => {
    const store = new EvidenceStore();
    store.register(evidence('evidence-1'));

    const events: TraceEvent[] = [];
    const conclusion = assessedQ2(['claim-1']);

    if (conclusion.axis !== 'moa_pathway') {
      throw new Error('unexpected axis');
    }
    conclusion.assessment.support.evidenceIds = [
      'model-authored-evidence-id',
    ];

    const result = validateAndDegrade({
      conclusion,
      verifiedClaims: [
        claim('claim-1', ['evidence-1', 'phantom-evidence']),
      ],
      store,
      auditStore: new RetrievalAuditStore(),
      emit: (event) => events.push(event),
    });

    expect(result.axis).toBe('moa_pathway');
    if (result.axis !== 'moa_pathway') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.support.evidenceIds).toEqual(['evidence-1']);
    expect(result.assessment.support.evidenceIds).not.toContain(
      'model-authored-evidence-id',
    );

    const trace = JSON.stringify(events);
    expect(trace).toContain('phantom-evidence');
    expect(trace).toMatch(/drop|unresolv|missing/i);
  });
});

describe('Q4 absence support', () => {
  it('degrades absent precedent without retrievalAuditIds', () => {
    const result = validateAndDegrade({
      conclusion: absentQ4(),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore: new RetrievalAuditStore(),
      emit: () => {},
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment).toMatchObject({
      precedent: 'insufficient_evidence',
      confidence: 'low',
    });
  });

  it('survives with adequate audits and empty supportingClaimIds', () => {
    const auditStore = new RetrievalAuditStore();
    const auditIds = registerAdequateQ4Coverage(auditStore);

    const result = validateAndDegrade({
      conclusion: absentQ4(auditIds),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore,
      emit: () => {},
    });

    expect(result).toEqual(absentQ4(auditIds));
    expect(result.axis).toBe('clinical_landscape');

    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.precedent).toBe('absent');
    expect(result.assessment.support.supportingClaimIds).toEqual([]);
    expect(result.assessment.support.retrievalAuditIds).toEqual(auditIds);
  });

  it('drops every unresolved retrievalAuditId and traces the drop', () => {
    const auditStore = new RetrievalAuditStore();
    const auditIds = registerAdequateQ4Coverage(auditStore);
    const events: TraceEvent[] = [];

    const result = validateAndDegrade({
      conclusion: absentQ4([...auditIds, 'missing-audit']),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore,
      emit: (event) => events.push(event),
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.precedent).toBe('absent');
    expect(result.assessment.support.retrievalAuditIds).toEqual(auditIds);
    expect(result.assessment.support.retrievalAuditIds).not.toContain(
      'missing-audit',
    );

    const trace = JSON.stringify(events);
    expect(trace).toContain('missing-audit');
    expect(trace).toMatch(/drop|unresolv|missing/i);
  });

  it('degrades when unresolved audit ids leave inadequate coverage', () => {
    const auditStore = new RetrievalAuditStore();
    auditStore.register(audit(
      'clinicaltrials-target-modality',
      'clinicaltrials',
      'target_modality',
    ));

    const result = validateAndDegrade({
      conclusion: absentQ4([
        'clinicaltrials-target-modality',
        'missing-europepmc-audit',
        'missing-opentargets-audit',
      ]),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore,
      emit: () => {},
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment).toMatchObject({
      precedent: 'insufficient_evidence',
      confidence: 'low',
    });
    expect(
      result.assessment.support.retrievalAuditIds,
    ).toEqual(['clinicaltrials-target-modality']);
  });

  it('does not count failed audit records toward absence coverage', () => {
    const auditStore = new RetrievalAuditStore();
    const auditIds = registerAdequateQ4Coverage(auditStore);

    const failedId = 'opentargets-target-class-precedent';
    const replacementStore = new RetrievalAuditStore();

    for (const id of auditIds) {
      const record = auditStore.get(id);
      if (!record) throw new Error(`missing fixture audit ${id}`);

      replacementStore.register(
        id === failedId
          ? { ...record, status: 'failed' }
          : record,
      );
    }

    const result = validateAndDegrade({
      conclusion: absentQ4(auditIds),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore: replacementStore,
      emit: () => {},
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.precedent).toBe(
      'insufficient_evidence',
    );
    expect(result.assessment.confidence).toBe('low');
  });
});
```

### `packages/core/src/slice5/draftConclusion.invariants.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type {
  Claim,
  DiseaseContextKey,
  Evidence,
  SpecialistExecutionContext,
  TraceEvent,
} from '@mrsirquanzo/sonny-shared';
import { SpecialistConclusionSchema } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import type { ThreadBrief } from '../researcher.js';
import { RetrievalAuditStore } from '../retrievalAuditStore.js';
import { draftSpecialistConclusion } from '../conclusions/draft.js';
import { normalizeDiseaseContext } from '../diseaseContext.js';
import { ontologyFixture } from '../slice4/ontologyFixture.js';

const contextKey: DiseaseContextKey = normalizeDiseaseContext(
  { indication: 'NSCLC' },
  ontologyFixture,
);

const brief: ThreadBrief = {
  id: 'disease_indications',
  title: 'Indication and biomarker prioritization',
  objective: 'Rank relevant disease contexts.',
  promptHint: 'Compare contexts without assuming target validity.',
  scope: { kind: 'shared' },
  context: {
    kind: 'shared',
    queryScope: {
      subjectTargets: [{
        kind: 'gene_or_protein',
        symbol: 'KRAS',
      }],
      indication: 'NSCLC',
      rawPrompt: 'Evaluate KRAS in NSCLC.',
    },
  },
};

const executionContext: SpecialistExecutionContext = {
  kind: 'shared',
  queryScope: {
    subjectTargets: [{
      kind: 'gene_or_protein',
      symbol: 'KRAS',
    }],
    indication: 'NSCLC',
    rawPrompt: 'Evaluate KRAS in NSCLC.',
  },
};

const verifiedClaim: Claim = {
  id: 'disease_indications::shared#r1c1',
  text: 'KRAS G12C is recurrent in a biomarker-defined NSCLC population.',
  citations: ['PMID:verified'],
  confidence: 0.9,
};

const deterministicClaim: Claim = {
  id: 'struct-1-disease_indications',
  text: 'Open Targets records KRAS associations with lung carcinoma.',
  citations: ['opentargets:KRAS#expression'],
  confidence: 0.9,
  provenance: 'deterministic',
};

const evidence = (id: string): Evidence => ({
  id,
  kind: 'publication',
  source: 'Europe PMC',
  title: id,
  snippet: `Evidence for ${id}.`,
  url: `https://example.test/${encodeURIComponent(id)}`,
  raw: {},
  retrievedAt: '2026-07-28T12:00:00.000Z',
});

describe('draftSpecialistConclusion', () => {
  it('runs one model call and exposes only supplied surviving and deterministic claims', async () => {
    const calls: Array<{
      system: string;
      prompt: string;
      model: string;
    }> = [];

    const model: StructuredModel = {
      async generateStructured(opts) {
        calls.push({
          system: opts.system,
          prompt: opts.prompt,
          model: opts.model,
        });

        return {
          axis: 'disease_indications',
          conclusion: {
            mode: 'comparative',
            assessments: [{
              context: contextKey,
              rankedStrategies: [{
                strategyFingerprint: 'strategy-1',
                opportunity: 'strong',
                rank: 1,
                confidence: 'moderate',
                evidenceAvailability: 'rich',
                support: {
                  supportingClaimIds: [
                    verifiedClaim.id,
                    deterministicClaim.id,
                  ],
                  evidenceIds: [
                    'MODEL_MUST_NOT_CONTROL_THIS_NAMESPACE',
                  ],
                },
              }],
              winningStrategyFingerprint: 'strategy-1',
            }],
          },
        } as never;
      },
    };

    const store = new EvidenceStore();
    store.register(evidence('PMID:verified'));
    store.register({
      ...evidence('opentargets:KRAS#expression'),
      kind: 'target',
      source: 'Open Targets',
    });

    const events: TraceEvent[] = [];
    const result = await draftSpecialistConclusion({
      brief,
      context: executionContext,
      verifiedClaims: [verifiedClaim],
      deterministicClaims: [deterministicClaim],
      store,
      auditStore: new RetrievalAuditStore(),
      model,
      emit: (event) => events.push(event),
    });

    expect(calls).toHaveLength(1);

    const modelInput = `${calls[0].system}\n${calls[0].prompt}`;
    expect(modelInput).toContain(verifiedClaim.id);
    expect(modelInput).toContain(verifiedClaim.text);
    expect(modelInput).toContain(deterministicClaim.id);
    expect(modelInput).toContain(deterministicClaim.text);
    expect(modelInput).not.toContain('rejected-claim');
    expect(modelInput).not.toContain('rejected evidence');

    expect(
      SpecialistConclusionSchema.safeParse(result).success,
    ).toBe(true);

    expect(result.axis).toBe('disease_indications');
    if (result.axis !== 'disease_indications') {
      throw new Error('unexpected axis');
    }

    const ranked = result.conclusion.assessments[0].rankedStrategies[0];

    expect(ranked.support.supportingClaimIds).toEqual([
      verifiedClaim.id,
      deterministicClaim.id,
    ]);
    expect(ranked.support.evidenceIds).toEqual([
      'PMID:verified',
      'opentargets:KRAS#expression',
    ]);
    expect(ranked.support.evidenceIds).not.toContain(
      'MODEL_MUST_NOT_CONTROL_THIS_NAMESPACE',
    );
  });

  it('does not allow a model to cite a claim outside the supplied claim set', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return {
          axis: 'disease_indications',
          conclusion: {
            mode: 'comparative',
            assessments: [{
              context: contextKey,
              rankedStrategies: [{
                strategyFingerprint: 'strategy-1',
                opportunity: 'strong',
                rank: 1,
                confidence: 'high',
                evidenceAvailability: 'rich',
                support: {
                  supportingClaimIds: ['rejected-claim'],
                  evidenceIds: ['phantom-evidence'],
                },
              }],
              winningStrategyFingerprint: 'strategy-1',
            }],
          },
        } as never;
      },
    };

    const result = await draftSpecialistConclusion({
      brief,
      context: executionContext,
      verifiedClaims: [verifiedClaim],
      deterministicClaims: [deterministicClaim],
      store: new EvidenceStore(),
      auditStore: new RetrievalAuditStore(),
      model,
      emit: () => {},
    });

    expect(result.axis).toBe('disease_indications');
    if (result.axis !== 'disease_indications') {
      throw new Error('unexpected axis');
    }

    const ranked = result.conclusion.assessments[0].rankedStrategies[0];

    expect(ranked.opportunity).toBe('insufficient_evidence');
    expect(ranked.confidence).toBe('low');
    expect(ranked.support.supportingClaimIds).not.toContain(
      'rejected-claim',
    );
    expect(ranked.support.evidenceIds).not.toContain('phantom-evidence');
  });
});
```

### `packages/core/src/slice5/coverageAndOrdering.invariants.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type {
  Claim,
  Evidence,
  SpecialistConclusion,
} from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import { evaluateAbstention } from '../conclusions/coverage.js';
import { deriveStructuredClaims } from '../structuredClaims.js';

const verifiedClaim = (id: string): Claim => ({
  id,
  text: `Verified claim ${id}`,
  citations: [`evidence-${id}`],
  confidence: 0.9,
});

const deterministicClaim: Claim = {
  id: 'struct-1',
  text: 'A curated deterministic claim.',
  citations: ['uniprot:KRAS#localization'],
  confidence: 0.9,
  provenance: 'deterministic',
};

const q1 = (
  validity: 'strong' | 'insufficient_evidence',
): SpecialistConclusion => ({
  axis: 'target_biology',
  assessments: [{
    context: {
      canonicalContextId: 'context-1',
      ontologySource: 'MONDO',
      ontologyVersion: '2026-06-02',
      indication: {
        raw: 'NSCLC',
        canonicalName: 'non-small cell lung carcinoma',
        ontologyId: 'MONDO:0005233',
      },
      mappingConfidence: 'exact',
      mappingRelation: 'exact',
    },
    q1HypothesisKey: 'KRAS|disease_driver|suppress_function',
    target: {
      kind: 'gene_or_protein',
      symbol: 'KRAS',
      targetForm: 'G12C',
    },
    targetRole: 'disease_driver',
    biologicalIntent: 'suppress_function',
    validity,
    confidence: validity === 'insufficient_evidence' ? 'low' : 'moderate',
    evidenceAvailability:
      validity === 'insufficient_evidence' ? 'absent' : 'rich',
    support: {
      supportingClaimIds:
        validity === 'insufficient_evidence' ? [] : ['claim-1'],
      evidenceIds:
        validity === 'insufficient_evidence' ? [] : ['evidence-claim-1'],
    },
  }],
});

const q2 = (
  modalityFit: 'strong' | 'insufficient_evidence',
): SpecialistConclusion => modalityFit === 'insufficient_evidence'
  ? {
      axis: 'moa_pathway',
      assessment: {
        modalityFit: 'insufficient_evidence',
        confidence: 'low',
        evidenceGap: 'No modality-feasibility evidence.',
        support: {
          supportingClaimIds: [],
          evidenceIds: [],
        },
      },
    }
  : {
      axis: 'moa_pathway',
      assessment: {
        modalityFit: 'strong',
        weakestLink: {
          mechanisticStatus: 'supported',
          mitigability: 'engineerable',
        },
        confidence: 'moderate',
        mechanisticBottleneck: 'Sustained target engagement.',
        mostDecisiveNextExperiment: 'Measure target engagement.',
        support: {
          supportingClaimIds: ['claim-2'],
          evidenceIds: ['evidence-claim-2'],
        },
      },
    };

const q4Supportive: SpecialistConclusion = {
  axis: 'clinical_landscape',
  assessment: {
    precedent: 'supportive',
    evidenceMaturity: 'clinical',
    confidence: 'moderate',
    support: {
      supportingClaimIds: ['claim-3'],
      evidenceIds: ['evidence-claim-3'],
    },
  },
};

describe('coverage-based abstention', () => {
  it('proceeds with two verified non-deterministic claims and materially covered Q1 and Q2', () => {
    expect(evaluateAbstention({
      conclusions: [q1('strong'), q2('strong')],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        verifiedClaim('claim-2'),
      ],
    })).toEqual({
      proceed: true,
      reasons: [],
    });
  });

  it('does not let deterministic claims satisfy the two-claim threshold', () => {
    const result = evaluateAbstention({
      conclusions: [q1('strong'), q2('strong')],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        deterministicClaim,
      ],
    });

    expect(result.proceed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('requires two distinct materially covered axes', () => {
    const result = evaluateAbstention({
      conclusions: [q1('strong')],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        verifiedClaim('claim-2'),
      ],
    });

    expect(result.proceed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('abstains when critical Q1 is insufficient even if two other axes are covered', () => {
    const result = evaluateAbstention({
      conclusions: [
        q1('insufficient_evidence'),
        q2('strong'),
        q4Supportive,
      ],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        verifiedClaim('claim-2'),
      ],
    });

    expect(result.proceed).toBe(false);
    expect(JSON.stringify(result.reasons)).toMatch(
      /Q1|target_biology|critical/i,
    );
  });

  it('abstains when critical Q2 is insufficient even if two other axes are covered', () => {
    const result = evaluateAbstention({
      conclusions: [
        q1('strong'),
        q2('insufficient_evidence'),
        q4Supportive,
      ],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        verifiedClaim('claim-2'),
      ],
    });

    expect(result.proceed).toBe(false);
    expect(JSON.stringify(result.reasons)).toMatch(
      /Q2|moa_pathway|critical/i,
    );
  });
});

const curatedEvidence = (
  id: string,
  source: 'Open Targets' | 'UniProt',
  snippet: string,
): Evidence => ({
  id,
  kind: 'target',
  source,
  title: id,
  snippet,
  url: `https://example.test/${encodeURIComponent(id)}`,
  raw: {},
  retrievedAt: '2026-07-28T12:00:00.000Z',
});

describe('deterministic claim derivation before drafting', () => {
  it('routes one localization card independently to Q1 and Q2', () => {
    const store = new EvidenceStore();
    store.register(curatedEvidence(
      'uniprot:KRAS#localization',
      'UniProt',
      'KRAS is annotated at the plasma membrane.',
    ));

    const derived = deriveStructuredClaims(store);
    const q1Claims = derived.get('target_biology') ?? [];
    const q2Claims = derived.get('moa_pathway') ?? [];

    expect(q1Claims).toHaveLength(1);
    expect(q2Claims).toHaveLength(1);

    expect(q1Claims[0]).toMatchObject({
      citations: ['uniprot:KRAS#localization'],
      provenance: 'deterministic',
    });
    expect(q2Claims[0]).toMatchObject({
      citations: ['uniprot:KRAS#localization'],
      provenance: 'deterministic',
    });

    expect(q1Claims[0].id).not.toBe(q2Claims[0].id);
  });

  it('routes expression to Q3 and Q6 but not to Q2', () => {
    const store = new EvidenceStore();
    store.register(curatedEvidence(
      'opentargets:KRAS#expression',
      'Open Targets',
      'KRAS expression is observed across multiple normal tissues.',
    ));

    const derived = deriveStructuredClaims(store);

    expect(derived.get('disease_indications')).toHaveLength(1);
    expect(derived.get('modality_developability')).toHaveLength(1);
    expect(derived.get('moa_pathway')).toBeUndefined();
  });

  it('does not derive model-style claims from non-curated sources', () => {
    const store = new EvidenceStore();
    store.register({
      ...curatedEvidence(
        'PMID:123#localization',
        'UniProt',
        'A publication-derived localization assertion.',
      ),
      kind: 'publication',
      source: 'Europe PMC',
    });

    expect(deriveStructuredClaims(store).size).toBe(0);
  });
});
```

### `packages/core/src/slice5/retrievalAuditStore.invariants.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { RetrievalAudit } from '@mrsirquanzo/sonny-shared';
import { RetrievalAuditStore } from '../retrievalAuditStore.js';

const audit = (
  id: string,
  overrides: Partial<RetrievalAudit> = {},
): RetrievalAudit => ({
  id,
  axis: 'clinical_landscape',
  sectionKey: 'clinical_landscape',
  sourceId: 'clinicaltrials',
  queryClass: 'target_modality',
  queryFingerprint: `fingerprint-${id}`,
  normalizedQueryTerms: ['KRAS', 'NSCLC'],
  status: 'completed',
  executedAt: '2026-07-28T12:00:00.000Z',
  rawResultCount: 0,
  relevantResultCount: 0,
  ...overrides,
});

describe('RetrievalAuditStore', () => {
  it('is run-local and resolves registered audits by id', () => {
    const firstRun = new RetrievalAuditStore();
    const secondRun = new RetrievalAuditStore();
    const record = audit('audit-1');

    firstRun.register(record);

    expect(firstRun.has('audit-1')).toBe(true);
    expect(firstRun.get('audit-1')).toEqual(record);
    expect(firstRun.all()).toEqual([record]);

    expect(secondRun.has('audit-1')).toBe(false);
    expect(secondRun.get('audit-1')).toBeUndefined();
    expect(secondRun.all()).toEqual([]);
  });

  it('does not expose a mutable Map as its public result', () => {
    const store = new RetrievalAuditStore();
    store.register(audit('audit-1'));

    const snapshot = store.all();
    snapshot.length = 0;

    expect(store.all()).toHaveLength(1);
    expect(store.has('audit-1')).toBe(true);
  });
});
```

## `AMBIGUITIES.md`

```md
# Slice 5 invariant-suite ambiguities

This suite was derived from Sonny modality-agnostic spec draft 5.6 and the
already-shipped shared schemas. It intentionally does not inspect a slice-5
implementation.

## 1. The proposed validation surface cannot identify the conclusion's sectionKey

Retrieval coverage is normatively scoped by both:

- `axis`
- the conclusion's own `sectionKey`

The proposed function is:

```ts
validateAndDegrade(opts: {
  conclusion: SpecialistConclusion;
  verifiedClaims: Claim[];
  store: EvidenceStore;
  auditStore: RetrievalAuditStore;
  emit: (e: TraceEvent) => void;
}): SpecialistConclusion;
```

`SpecialistConclusion` contains an axis but no `sectionKey` or `SectionScope`.
Consequently, `validateAndDegrade` cannot distinguish two strategy-scoped Q4
threads having the same axis but different section keys.

The tests use `sectionKey === axis` for the simple single-strategy fixtures.
That is only a test convention, not a sufficient production rule.

Recommended correction:

```ts
validateAndDegrade(opts: {
  conclusion: SpecialistConclusion;
  sectionKey: string;
  // or scope plus the canonical section-key derivation
  ...
})
```

The same issue applies to `draftSpecialistConclusion`, although it can
potentially obtain the section key from `brief.scope` if the brief actually
carries the fully resolved scope.

## 2. `ThreadBrief.scope` is optional in the current contract

The spec says `SpecialistExecutionContext` is threaded through `ThreadBrief` and
its kind must agree with `SectionScope.kind`. The current `ThreadBrief` declares
both `scope` and `context` optional.

That permits a caller to invoke conclusion drafting without the scope needed to:

- enforce axis/scope compatibility;
- derive a variant-aware section key;
- select section-scoped audits;
- distinguish shared, strategy, and Q1-hypothesis threads.

The test supplies both fields, but the type does not require them.

## 3. No exported schema validates `SpecialistExecutionContext`

The shared package exports `SpecialistExecutionContext` as a TypeScript union,
but not a runtime `SpecialistExecutionContextSchema`.

A model boundary or deserialized job can therefore supply a malformed context
without a canonical runtime parser. The conclusion stage can check `kind`
manually, but cannot reuse a shared schema.

## 4. “Runs once per completed thread” cannot be proven through the proposed export

Calling `draftSpecialistConclusion` once and asserting one model call proves
only that one invocation makes one model call.

It cannot prove that the research pipeline:

- invokes the function for every completed thread;
- invokes it after verification;
- does not invoke it per research question;
- does not invoke it per research round;
- does not invoke it twice during section construction.

A true acceptance test needs an orchestration boundary such as
`produceResearchSection` with injectable conclusion drafting, or an exported
pipeline hook. The supplied test therefore verifies the strongest invariant
available at the proposed function boundary: one invocation produces exactly
one model call and receives only the explicitly supplied claim sets.

## 5. “After verification” is represented only by parameter naming

`draftSpecialistConclusion` receives `verifiedClaims`, but `Claim` itself has no
required “verified” marker. A model-generated claim can be passed in with no
`llmVerdict`, and deterministic claims are intentionally not verifier-reviewed.

The function cannot independently prove that a claim survived verification. It
can only trust that the caller supplied the correct array.

The tests treat the `verifiedClaims` argument as the trust boundary and check
that an out-of-set claim id is rejected during validation.

## 6. Deterministic claims and verified claims can be mixed accidentally

The spec gives deterministic claims a separate input and says they do not count
toward abstention. The `Claim` type nevertheless permits a deterministic claim
inside `verifiedClaims`.

The abstention test explicitly includes a deterministic claim in its input and
requires it not to count. This is defensive: even if the caller combines the
arrays, provenance remains sufficient to enforce the gate.

For drafting, the implementation should either:

- reject deterministic provenance in `verifiedClaims`; or
- normalize the two inputs by provenance before prompting.

The spec does not choose between these policies.

## 7. Ordering between verified and deterministic claims is not specified

The spec requires deterministic derivation before drafting so the model can see
the cards. It does not specify whether the prompt orders:

1. deterministic claims first;
2. verified model claims first;
3. both arrays sorted by global id;
4. both arrays kept in caller order.

The tests assert presence, not prompt order.

For derived `evidenceIds`, the suite chooses first-seen citation order while
deduplicating. That follows the pseudocode:

```ts
unique(supportingClaims.flatMap((c) => c.citations))
```

but the precise definition of `unique` is not stated.

## 8. `deriveEvidenceIds` cannot trace drops

The spec requires every unresolvable evidence id to be dropped and traced.

The proposed signature is:

```ts
deriveEvidenceIds(
  claims: Claim[],
  supportingClaimIds: string[],
  store: EvidenceStore,
): { evidenceIds: string[]; dropped: string[] };
```

It has no `emit` parameter. Therefore it can report drops but cannot itself
trace them.

The suite tests:

- the helper returns `dropped`;
- `validateAndDegrade`, which does receive `emit`, emits a trace containing the
  unresolved id.

This assigns tracing responsibility to the caller. That choice should be made
explicit in the API documentation.

## 9. `TraceEvent` has no conclusion-validation event

The current shared `TraceEvent` union has no event for:

- a dropped supporting claim id;
- a dropped evidence id;
- a dropped retrieval audit id;
- conclusion degradation;
- failed absence coverage.

Using `{ type: "error" }` would typecheck but is semantically questionable:
removing a model-authored phantom id is expected validation behavior, not
necessarily a runtime error.

The tests therefore inspect serialized trace content and require the dropped id
plus language matching `drop`, `missing`, or `unresolvable`, without fixing an
event variant.

Recommended additions include:

```ts
type ConclusionSupportDropTrace = {
  type: 'conclusion_support_drop';
  axis: SpecialistAxisId;
  sectionKey: string;
  namespace: 'claim' | 'evidence' | 'retrieval_audit';
  id: string;
  reason: 'unresolvable' | 'not_verified' | 'not_in_support_set';
};

type ConclusionDegradedTrace = {
  type: 'conclusion_degraded';
  axis: SpecialistAxisId;
  sectionKey: string;
  reason: string;
};
```

These events should also carry `SectionScope` once scope propagation lands.

## 10. Whether an unresolved audit always degrades is not fully explicit

The spec says:

> An unresolvable id is dropped and traced; if coverage then fails, the
> conclusion degrades.

The suite interprets this literally:

- a dangling audit id is dropped;
- the conclusion may survive if the remaining resolved audit records still
  provide adequate coverage;
- it degrades only when the remaining set is inadequate.

A stricter interpretation—any dangling referenced id invalidates the whole
conclusion—would conflict with “if coverage then fails”.

## 11. “With valid audit ids” means adequate coverage, not mere existence

One acceptance-box shorthand says Q4 absent “with valid retrievalAuditIds”
survives. Earlier normative text says one audit only proves one search ran and
adequacy must be evaluated over a set.

The suite uses the full Cartesian coverage fixture:

- ClinicalTrials × target_modality
- ClinicalTrials × target_class_precedent
- Europe PMC × target_modality
- Europe PMC × target_class_precedent
- Open Targets × target_modality
- Open Targets × target_class_precedent

This is deliberately stronger than the current `evaluateRetrievalCoverage`
implementation strictly requires. It avoids making the test depend on whether
“pair-aware” means:

- each source group must have at least one required query class; or
- every required source group must be searched with every required query class.

The prose does not unambiguously select one.

## 12. Partial-audit semantics conflict inside the spec

The prose says:

> A partial audit counts only if the required set is otherwise complete, and is
> reported.

The existing shared implementation says partial audits do not satisfy coverage:

```ts
const usable = mine.filter((a) => a.status === 'completed');
```

Its comment explicitly calls the earlier wording ambiguous and chooses the
safer policy.

Because the user identified the shipped shared file as the contract, the suite
does not assert that partial audits count. A dedicated slice-5 test should only
be added after the normative prose and shipped implementation are reconciled.

## 13. The proposed core `RetrievalAuditStore` duplicates a shipped shared class

`packages/shared/src/retrievalAudit.ts` already exports
`RetrievalAuditStore`. The proposed surface adds:

```ts
packages/core/src/retrievalAuditStore.ts
```

with the same API.

This creates two runtime classes representing the same run-local store. Even
though they are structurally compatible in simple TypeScript usage, duplicate
ownership can produce:

- inconsistent duplicate-id behavior;
- separate `instanceof` identities;
- different serialization or validation policies;
- confusion over which package retrieval code should import.

The spec's files-touched table also names `retrievalAudit.ts` without remaining
fully consistent about package ownership. Prefer one canonical class, likely
the already-shipped shared export unless core-specific behavior is required.

## 14. Duplicate audit-id behavior is unspecified

A `Map<string, RetrievalAudit>` normally suggests later `set` calls overwrite
earlier values. The already-shipped shared class uses first-write-wins:

```ts
if (!this.byId.has(a.id)) this.byId.set(a.id, a);
```

The proposed API does not state whether duplicate registration:

- overwrites;
- ignores;
- throws;
- compares records and throws only on a conflict.

The suite intentionally does not encode duplicate behavior. For audit
integrity, throwing on a conflicting duplicate would be safer than silently
retaining either record.

## 15. `all()` ordering is unspecified

JavaScript `Map` preserves insertion order, and the tests expect insertion order
for a single record. The spec does not state whether `all()` must be:

- insertion ordered;
- id sorted;
- otherwise deterministic.

Coverage evaluation should not depend on this order. Trace and snapshot tests
may, so the contract should state it.

## 16. Degradation output is not fully specified for each axis

The spec says an affected status degrades to `insufficient_evidence` and
confidence becomes `low`, but does not completely define how to reconstruct
every carrier.

Questions include:

- What exact `evidenceGap` text is used for Q2 and Q6?
- Are assessed-only fields removed or merely stripped by schema parsing?
- Are Q6 liabilities retained on an insufficient result?
- Are Q6 domain assessments retained?
- For Q5, if only `landscapeDensity` lacks support, does
  `differentiationPotential` also degrade?
- For Q1, is degradation per assessment or for every assessment in the carrier?
- For Q3 comparative output, is degradation per ranked strategy, per context,
  or for the entire conclusion?
- Is `evidenceAvailability` changed to `absent` when a Q1/Q3 assessment
  degrades, or can it remain `rich` despite the evaluative status becoming
  insufficient?

The tests require the normative minimum and schema validity, without pinning
unspecified prose.

## 17. Q2 and Q6 unions are not strict schemas

The shared schemas use ordinary `z.object`, which strips unknown keys. Thus an
insufficient Q2 input carrying `mechanisticBottleneck` is accepted and the field
is removed; it is not rejected at parse time.

Likewise, an insufficient Q6 carrying
`highestPriorityRiskMitigationOrMonitoringStep` is accepted and stripped.

The acceptance wording says an insufficient conclusion “cannot carry” those
fields. The suite interprets that as “the parsed value cannot retain them” to
match the shipped contract.

If the intended invariant is adversarial rejection of malformed model output,
the insufficient and assessed branches should be `.strict()`. The current
schema permits malformed wire input and silently repairs it.

This is a recurring schema-permissiveness risk and should be an explicit
decision.

## 18. `ConclusionSupportSchema` permits empty strings and duplicates

All support namespaces use `z.array(z.string())`. The schema accepts:

```ts
{
  supportingClaimIds: ['', 'claim-1', 'claim-1'],
  evidenceIds: ['', 'evidence-1', 'evidence-1'],
  retrievalAuditIds: ['', 'audit-1', 'audit-1']
}
```

Validation can drop unresolved empty ids and deduplicate derived evidence ids,
but the schema itself permits malformed identifiers and duplicate audit
references.

Safer contracts would use:

```ts
z.array(z.string().min(1))
```

and refinements for uniqueness where ordering or multiplicity has no meaning.

## 19. Model-authored `evidenceIds` remain present in the model schema

The spec says evidence ids are never model-emitted, but
`SpecialistConclusionSchema` requires `support.evidenceIds`. If that full schema
is passed to `generateStructured`, the model must emit the forbidden field to
satisfy the schema.

Post-processing can overwrite it, and the tests require that overwrite, but the
prompt/schema contract remains contradictory.

A cleaner design is a separate draft-wire schema in core:

```ts
support: {
  supportingClaimIds: string[];
  retrievalAuditIds?: string[];
}
```

Then core derives `evidenceIds` before parsing into
`SpecialistConclusionSchema`.

This is analogous to the existing researcher design, where the model wire
schema deliberately omits generated claim ids.

## 20. The model can still author retrieval audit ids

The spec correctly says audit adequacy is deterministic, but the conclusion
support schema allows the model to emit arbitrary `retrievalAuditIds`.

Validation can resolve and filter them, yet it is safer for core to provide the
model with the eligible audit ids or attach audit support deterministically
after classifying an absence conclusion.

Otherwise the model is being asked to select operational provenance records it
did not create and may not understand.

## 21. Q1/Q3 validation cannot prove a context came from this run

The shared `DiseaseContextKeySchema` validates shape and unresolved-candidate
rules. It cannot prove `canonicalContextId` belongs to the current run.

The spec explicitly lists degradation for:

> canonicalContextId values not present in the run's resolved contexts

Neither `draftSpecialistConclusion` nor `validateAndDegrade` receives the run's
resolved-context set. Passing `verifiedClaims`, evidence, and audits is
insufficient to enforce this rule.

The tests can prove that real normalized contexts parse, but cannot test
run-membership validation through the proposed surface.

Recommended addition:

```ts
resolvedContexts: readonly DiseaseContextKey[]
```

or a run-local context registry.

## 22. Q1/Q3 context identity is not recomputed by the schema

A caller can provide a structurally valid `DiseaseContextKey` whose
`canonicalContextId` does not match its normalized contents. The schema has no
access to the ontology resolver or canonical hash input, so it accepts the
mismatch.

Using `normalizeDiseaseContext` creates a genuine key, as the tests do, but
schema parsing alone is not proof of canonical identity.

## 23. Q1 material coverage is ambiguous for multiple assessments

Q1 is one carrier containing an array of context assessments. Section 12.4 says
an axis is materially covered when its “top-level status” is not insufficient,
but Q1 has no single top-level status.

Possible policies:

- covered if every Q1 assessment is non-insufficient;
- covered if at least one is non-insufficient;
- covered only for the primary context;
- covered using the exact Q1 hypothesis relevant to synthesis.

The suite uses a single Q1 assessment, avoiding an accidental policy choice.

This must be resolved before bake-off or multi-context runs.

## 24. Q3 material coverage is ambiguous

Q3 comparative conclusions contain multiple contexts and ranked strategies,
each with its own `opportunity`. There is no single top-level status.

Possible material-coverage policies mirror Q1 and become more complicated with
ties and multiple strategies. The suite does not use Q3 to satisfy the
two-covered-axis gate.

## 25. Duplicate conclusion carriers could inflate axis coverage

`evaluateAbstention` receives `SpecialistConclusion[]` with no schema enforcing
one carrier per axis. Counting non-insufficient conclusion objects would let two
Q4 objects count as two materially covered axes.

The implementation must count distinct `axis` values, not array entries. The
suite tests only one-carrier input for the undercoverage case; an additional
duplicate-axis test should be added once the policy for multiple scoped threads
of the same axis is defined.

This is particularly important because strategy variants legitimately produce
multiple threads with the same axis.

## 26. Critical-axis identity in variant runs is under-specified

Q1 can run once per hypothesis and Q2 once per strategy variant. “No critical
axis at insufficient evidence” could mean:

- no Q1 or Q2 conclusion anywhere may be insufficient;
- each strategy must have its own satisfactory Q1 and Q2;
- at least one candidate strategy must have satisfactory critical axes;
- the selected strategy alone must pass.

The simple suite assumes one Q1 and one Q2.

## 27. Reasons returned by `evaluateAbstention` have no stable contract

The proposed result exposes `reasons: string[]`, but the spec does not define:

- reason codes;
- exact wording;
- ordering;
- whether all failures or only the first failure are reported.

The tests assert exact `[]` only on success. On failure they assert non-empty
reasons and, for critical-axis failures, relevant semantic text.

A structured reason enum would make this API testable and usable by UI code.

## 28. “Verified non-deterministic claims” is not fully represented

The abstention function receives `verifiedClaims`, so the suite assumes all
non-deterministic elements in that array survived verification.

If callers may pass broader claim sets, the function needs verdicts or a
required verification marker. Optional fields such as `llmVerdict` are not a
safe discriminator because older supported claims may omit them.

## 29. Low-risk Q6 critical-domain coverage cannot be enforced by the proposed surface

The spec requires a low Q6 to have:

- positive supporting claims;
- adequate retrieval coverage;
- an assessment for every critical risk domain for the modality.

`validateAndDegrade` receives no modality or resolved modality lens. It cannot
know which domains are critical.

Neither `SpecialistConclusion` nor `ModalityRisk` carries modality, correctly,
but that means validation needs contextual input such as:

```ts
modality: CanonicalModality
```

or:

```ts
requiredCriticalRiskDomains: readonly RiskDomain[]
```

Without it, the implementation can only require a non-empty
`domainAssessments` array, which is weaker than the normative rule.

This is the most substantial mismatch in the proposed export surface.

## 30. Low-risk Q6 audit coverage has the same missing-sectionKey problem

Even if modality were supplied, Q6 low-risk coverage must be scoped to the
specific strategy thread. Axis-only lookup can let audits from one strategy
license a low-risk conclusion for another.

## 31. Q5 open support policy needs multi-status degradation semantics

The spec says Q5 `landscapeDensity: open` requires adequate audits and positive
claims. Q5 also carries `differentiationPotential` and `ipSignal`.

If open-landscape support fails, it is unclear whether validation should:

- degrade only `landscapeDensity`;
- also degrade `differentiationPotential`;
- retain `ipSignal`;
- lower one shared confidence for all fields.

The shared schema has a single confidence value, so partial degradation is not
cleanly representable.

## 32. Q4 absent with adequate searches but positive relevant results is not prohibited

The audit schema records `relevantResultCount`, but coverage only checks that
searches ran. An audit set with positive relevant results can still technically
support `precedent: absent`.

Whether that is logically invalid depends on what “relevant” means, but the
contract currently provides no deterministic rule. Validation should not infer
absence merely from coverage; the model conclusion and observed claims must
remain consistent.

## 33. Retrieval audit time windows are not required

An “absent” precedent conclusion may depend on temporal coverage, but
`timeWindowStart` and `timeWindowEnd` are optional and no freshness policy is
defined.

The suite does not require them.

## 34. Audit-store records are not schema-parsed on registration

The proposed `register(audit: RetrievalAudit)` accepts a statically typed value,
but runtime callers can still provide unparsed data. The API does not state
whether `register` must call `RetrievalAuditSchema.parse`.

The suite supplies valid typed fixtures and does not assume runtime parsing.

## 35. Deterministic derivation is not exposed by the new slice-5 API

Sections 7.3, 7.4, and 7.6 are relevant to slice 5, but the proposed new export
surface contains no function for:

- per-section deterministic derivation;
- pre-draft structured merging;
- post-merge presentation consolidation.

The suite can test the existing `deriveStructuredClaims` routing and that
drafting accepts deterministic claims. It cannot prove orchestration order.

An integration test at `produceResearchSection` or `runDeepResearch` is needed
to prove:

1. verification finishes;
2. per-section deterministic claims are derived;
3. drafting sees both sets;
4. the section is constructed;
5. structured merge is complete;
6. consolidation runs afterward and affects presentation only.

## 36. Existing `mergeStructuredClaims` semantics conflict with the new ordering

The current helper performs derivation and merge as an array-level pass over
already-built sections. Draft 5.6 moves derivation into per-section production
before conclusion drafting.

Keeping the existing helper unchanged risks:

- deriving the same cards twice;
- adding a second set of deterministic claim ids;
- changing sources or RAG after support validation;
- letting shipped claims differ from the claims visible during drafting.

The implementation should separate:

- deterministic derivation;
- per-section scientific-input merge;
- array-level presentation consolidation.

## 37. The deterministic routing key is axis-only, not sectionKey-aware

`deriveStructuredClaims` currently returns `Map<string, Claim[]>` keyed by axis
ids such as `moa_pathway`.

In variant-aware runs, multiple sections share an axis. Section 7.3 says cards
routed to multiple axes are independently derived in each owning section. The
current map does not distinguish multiple sections of one axis.

This is another reason slice-5 derivation needs the full execution context and
section key.

## 38. No explicit invariant connects the drafted axis to `brief.id`

`SpecialistConclusionSchema` validates the carrier internally, but
`draftSpecialistConclusion` must also reject a model returning a valid Q4
carrier for a Q2 brief.

The proposed function has enough information to enforce
`conclusion.axis === brief.id`, but the spec does not state whether mismatch:

- throws;
- retries;
- degrades;
- returns a synthetic insufficient conclusion for the expected axis.

A dedicated test needs the chosen failure policy.

## 39. Model failure behavior is unspecified

No rule states what happens when structured generation throws or returns an
unparseable result.

Likely safe behavior is an axis-appropriate insufficient-evidence conclusion,
but the exact `evidenceGap`, trace, and retry policy are undefined.

## 40. Empty assessment arrays are schema-valid

The shared schemas allow:

- Q1 `assessments: []`;
- Q3 strategy overlay `assessments: []`;
- Q3 comparative `assessments: []`.

Such carriers contain no top-level evaluative status, complicating both the
“every specialist emits a conclusion” requirement and material-axis coverage.

If an empty result means insufficient evidence, the schemas should encode that
or validation should degrade it deterministically.

## 41. Q6 domain assessments allow duplicate domains

`domainAssessments` is an unconstrained array. A low-risk conclusion can carry
two assessments for safety and omit every other critical domain.

Even after modality context is added, validation must enforce uniqueness and
required-domain coverage. A schema refinement could at least reject duplicates
independent of modality.

## 42. Q6 liabilities and domain assessments can contradict each other

The schema permits:

- a high safety liability;
- a safety domain assessment of `no_material_liability`.

No reconciliation rule is stated. A low-risk conclusion with zero liabilities
is valid, but a conclusion with liabilities should have consistent domain
rollups.

## 43. Q6 low-risk schema validity is weaker than scientific validity

The shared schema deliberately accepts a low-risk Q6 with:

- zero liabilities;
- zero domain assessments;
- empty positive support;
- no audit ids.

That is acceptable only because validation is a second layer. Consumers must
not treat `Q6ConclusionSchema.parse` as proof that a low-risk assessment is
scientifically admissible.

This distinction should be prominent in API naming and documentation.

## 44. Evidence-store identity does not guarantee citation suitability

`deriveEvidenceIds` can prove only that an id resolves. It does not prove:

- the cited evidence supports the claim;
- the evidence belongs to the same run or scope;
- the citation survived grounding;
- the evidence is allowed for the conclusion's axis.

Those guarantees must come from the verified-claim input boundary.

## 45. Claim-id uniqueness is trusted, not validated

The validation API receives `Claim[]` and resolves by id, but does not state how
duplicate claim ids are handled. A `Map` conversion could silently select the
first or last claim and derive different evidence.

Given Section 7.7, duplicate ids should cause a hard invariant failure rather
than silent degradation.

## 46. Degradation after dropping one of several supporting claims

The spec says unresolvable claim references are caught and affected statuses
degrade where support is inadequate. It does not say whether a conclusion with
three cited claims, one missing and two valid, should:

- survive with the two valid claims;
- always degrade because the model referenced a nonexistent claim.

The suite chooses the support-adequacy interpretation: filter invalid ids and
degrade only if the remaining support no longer satisfies the relevant rule.
That matches the explicit audit behavior.

## 47. Exact evidence-id derivation for nested Q6 support is unspecified

Q6 has support at three levels:

- overall conclusion support;
- each liability support;
- each domain assessment support.

Validation must derive and replace evidence ids independently for every support
object. It must not union all Q6 evidence into every nested record.

The proposed helper operates on one support selection at a time, so recursive
application is required but not described.

## 48. Exact evidence-id derivation for Q1 and Q3 arrays is likewise recursive

Each Q1 context assessment and each Q3 ranked strategy carries separate support.
Validation must preserve those boundaries.

A single carrier-level evidence union would falsely imply that evidence for one
disease context supports every other context.

## 49. “Every specialist emits its conclusion” is partly a section-schema invariant

`SpecialistConclusionSchema` only validates a conclusion object. The stronger
acceptance criterion is that every newly written research section has a
conclusion.

That is already represented by `ResearchSectionV2Schema`, not by any proposed
slice-5 function. A pipeline test should assert all completed section writers
emit V2 sections and no new write can fall through the legacy reader.

## 50. Strictness remains the recurring schema-level risk

Most shared conclusion schemas are not `.strict()`. Unknown model fields are
silently stripped throughout the conclusion tree.

That behavior can conceal:

- deprecated field names;
- typos in support namespaces;
- assessed-only fields on insufficient branches;
- a model inventing unsupported classifications;
- future schema drift between prompt and parser.

For persisted data, stripping may aid compatibility. For model wire responses,
strict schemas are safer. Separate wire and storage schemas would avoid forcing
one policy onto both boundaries.
```