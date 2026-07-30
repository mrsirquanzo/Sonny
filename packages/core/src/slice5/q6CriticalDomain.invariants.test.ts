import { describe, expect, it } from 'vitest';
import type {
  CanonicalModality, Claim, ConclusionSupport, Evidence,
  RetrievalAudit, RiskDomain, RiskDomainAssessment, SpecialistConclusion,
} from '@mrsirquanzo/sonny-shared';
import {
  CRITICAL_RISK_DOMAINS_BY_MODALITY, RetrievalAuditStore, SpecialistConclusionSchema,
} from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import { validateAndDegrade } from '../conclusions/validate.js';

const SECTION_KEY = 'modality_developability';

const positiveClaim: Claim = {
  id: 'claim-positive-risk-assessment',
  text: 'The evidence supports a manageable development-risk profile.',
  citations: ['evidence-risk-assessment'],
  confidence: 0.9,
};

const positiveEvidence: Evidence = {
  id: 'evidence-risk-assessment', kind: 'publication', source: 'Europe PMC',
  title: 'Modality-specific risk assessment', snippet: 'Assessed the relevant domains.',
  url: 'https://example.test/risk', raw: {}, retrievedAt: '2026-07-28T12:00:00.000Z',
};

const domainSupport = (): ConclusionSupport => ({
  supportingClaimIds: [positiveClaim.id],
  evidenceIds: ['model-authored-evidence-id'],
});

const audit = (id: string, sourceId: RetrievalAudit['sourceId'], queryClass: RetrievalAudit['queryClass']): RetrievalAudit => ({
  id, axis: 'modality_developability', sectionKey: SECTION_KEY, sourceId, queryClass,
  queryFingerprint: `fp-${id}`, normalizedQueryTerms: ['KRAS', 'modality risk'],
  status: 'completed', executedAt: '2026-07-28T12:00:00.000Z',
  rawResultCount: 10, relevantResultCount: 2,
});

function adequateAuditStore(): RetrievalAuditStore {
  const store = new RetrievalAuditStore();
  store.register(audit('q6-europepmc-safety', 'europepmc', 'safety_class'));
  store.register(audit('q6-opentargets-target-modality', 'opentargets', 'target_modality'));
  return store;
}

function evidenceStore(): EvidenceStore {
  const store = new EvidenceStore();
  store.register(positiveEvidence);
  return store;
}

function assessment(domain: RiskDomain, status: RiskDomainAssessment['status'] = 'manageable'): RiskDomainAssessment {
  return { domain, status, confidence: status === 'insufficient_evidence' ? 'low' : 'moderate', support: domainSupport() };
}

const assessmentsFor = (m: CanonicalModality): RiskDomainAssessment[] =>
  CRITICAL_RISK_DOMAINS_BY_MODALITY[m].map((d) => assessment(d));

function lowQ6(domainAssessments: RiskDomainAssessment[], supportingClaimIds: string[] = [positiveClaim.id]): SpecialistConclusion {
  return {
    axis: 'modality_developability',
    assessment: {
      overallDevelopmentRisk: 'low', liabilities: [], domainAssessments,
      topProgrammeKillingRiskIds: [],
      highestPriorityRiskMitigationOrMonitoringStep: 'Continue routine safety monitoring.',
      earliestDecisiveDeRiskingStudy: 'Run a repeat-dose toxicology study.',
      confidence: 'moderate',
      support: {
        supportingClaimIds,
        evidenceIds: ['model-authored-evidence-id'],
        retrievalAuditIds: ['q6-europepmc-safety', 'q6-opentargets-target-modality'],
      },
    },
  };
}

const validate = (conclusion: SpecialistConclusion, modality?: CanonicalModality): SpecialistConclusion =>
  validateAndDegrade({
    conclusion, verifiedClaims: [positiveClaim], store: evidenceStore(),
    auditStore: adequateAuditStore(), sectionKey: SECTION_KEY,
    ...(modality === undefined ? {} : { modality }),
    emit: () => {},
  });

function expectRisk(c: SpecialistConclusion, expected: string): void {
  expect(c.axis).toBe('modality_developability');
  if (c.axis !== 'modality_developability') throw new Error('unexpected axis');
  expect(c.assessment.overallDevelopmentRisk).toBe(expected);
  expect(SpecialistConclusionSchema.safeParse(c).success).toBe(true);
}

describe('low Q6 critical-domain coverage', () => {
  it('degrades when one critical domain for the modality is absent', () => {
    const domains = assessmentsFor('adc').filter(({ domain }) => domain !== 'cmc');
    const result = validate(lowQ6(domains), 'adc');
    expectRisk(result, 'insufficient_evidence');
    if (result.axis !== 'modality_developability') throw new Error('axis');
    expect(result.assessment).toHaveProperty('evidenceGap');
    expect(result.assessment).not.toHaveProperty('highestPriorityRiskMitigationOrMonitoringStep');
    expect(result.assessment.domainAssessments).toHaveLength(domains.length);
  });

  it('preserves low when every critical domain has an acceptable status', () => {
    const domains = assessmentsFor('adc').map((e, i) => ({
      ...e, status: (i % 2 === 0 ? 'no_material_liability' : 'manageable') as RiskDomainAssessment['status'],
    }));
    expectRisk(validate(lowQ6(domains), 'adc'), 'low');
  });

  it.each(['material_liability_identified', 'insufficient_evidence'] as const)(
    'degrades when a present critical domain has status %s', (status) => {
      const domains = assessmentsFor('small_molecule')
        .map((e) => (e.domain === 'safety' ? assessment('safety', status) : e));
      expectRisk(validate(lowQ6(domains), 'small_molecule'), 'insufficient_evidence');
    });

  it('requires CMC for adc but not for small_molecule', () => {
    expectRisk(validate(lowQ6([assessment('safety'), assessment('pk_pd'), assessment('target_biology')]), 'adc'), 'insufficient_evidence');
    expectRisk(validate(lowQ6([assessment('safety'), assessment('pk_pd')]), 'small_molecule'), 'low');
  });

  it('does not let an acceptable non-critical domain compensate for a missing critical one', () => {
    expectRisk(validate(lowQ6([
      assessment('safety'), assessment('target_biology'), assessment('pk_pd'), assessment('manufacturing'),
    ]), 'adc'), 'insufficient_evidence');
  });

  it('applies the explicit unknown-modality fallback and requires safety', () => {
    expectRisk(validate(lowQ6([assessment('pk_pd')]), 'unknown'), 'insufficient_evidence');
    expectRisk(validate(lowQ6([assessment('safety')]), 'unknown'), 'low');
  });

  it('fails closed when modality is absent, even with every domain assessed', () => {
    const everyDomain: RiskDomain[] = [
      'safety', 'target_biology', 'delivery_biodistribution', 'pk_pd', 'resistance',
      'immunogenicity', 'cmc', 'manufacturing', 'clinical_operations', 'translational_model',
    ];
    expectRisk(validate(lowQ6(everyDomain.map((d) => assessment(d)))), 'insufficient_evidence');
  });

  it('does not apply the critical-domain rule to a non-low Q6', () => {
    const moderate: SpecialistConclusion = {
      axis: 'modality_developability',
      assessment: {
        overallDevelopmentRisk: 'moderate',
        liabilities: [{
          id: 'risk-1', description: 'A material liability.',
          category: { domain: 'safety', code: 'common.other_safety' },
          likelihood: 'moderate', severity: 'moderate', mitigability: 'clinically_manageable',
          confidence: 'moderate', taxonomyNote: 'No controlled code fit.', support: domainSupport(),
        }],
        domainAssessments: [], topProgrammeKillingRiskIds: [],
        highestPriorityRiskMitigationOrMonitoringStep: 'Monitor.',
        earliestDecisiveDeRiskingStudy: 'Toxicology study.',
        confidence: 'moderate', support: domainSupport(),
      },
    };
    // No modality supplied, no domain assessments at all - and it still stands,
    // because the critical-domain rule is a prerequisite for `low` only.
    expectRisk(validate(moderate), 'moderate');
  });

  it('degrades a low Q6 with no surviving positive claims', () => {
    expectRisk(validate(lowQ6(assessmentsFor('small_molecule'), []), 'small_molecule'), 'insufficient_evidence');
  });

  it('does not let a duplicate acceptable assessment mask an unacceptable one', () => {
    const domains = [
      ...assessmentsFor('small_molecule'),
      assessment('safety', 'material_liability_identified'),
    ];
    expectRisk(validate(lowQ6(domains), 'small_molecule'), 'insufficient_evidence');
  });
});
