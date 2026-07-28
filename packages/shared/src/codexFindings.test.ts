import { describe, it, expect } from 'vitest';
import {
  evaluateRetrievalCoverage, ABSENCE_COVERAGE_REQUIREMENTS,
  resolveTargetEngagement, strategyFingerprint, migrateStoredSections,
  type RetrievalAudit,
} from './index.js';

/**
 * Regressions for defects found by an adversarial review of this module.
 * Each previously passed and produced a wrong-but-plausible result.
 */
const audit = (o: Partial<RetrievalAudit> & Pick<RetrievalAudit, 'id' | 'sourceId' | 'queryClass'>): RetrievalAudit => ({
  axis: 'clinical_landscape', sectionKey: 'clinical_landscape::strategy::fp1',
  queryFingerprint: 'qf', normalizedQueryTerms: ['KRAS'], status: 'completed',
  executedAt: '2026-01-01T00:00:00.000Z', rawResultCount: 0, relevantResultCount: 0,
  ...o,
} as RetrievalAudit);

describe('retrieval coverage is section-scoped and pair-aware', () => {
  const req = ABSENCE_COVERAGE_REQUIREMENTS.q4_precedent_absent;
  const here = { sectionKey: 'clinical_landscape::strategy::fp1', axis: 'clinical_landscape' as const };

  it('ignores audits belonging to another section or axis', () => {
    const r = evaluateRetrievalCoverage({ requirement: req, ...here, audits: [
      audit({ id: '1', axis: 'target_biology', sectionKey: 'other-a', sourceId: 'clinicaltrials', queryClass: 'target_modality' }),
      audit({ id: '2', axis: 'target_biology', sectionKey: 'other-b', sourceId: 'pubmed', queryClass: 'target_modality' }),
      audit({ id: '3', axis: 'competitive_ip', sectionKey: 'other-c', sourceId: 'opentargets', queryClass: 'target_class_precedent' }),
    ]});
    expect(r.adequate).toBe(false);
  });

  it('does not let an off-topic query satisfy a required source', () => {
    // Right sources, but ClinicalTrials was only searched for `mechanism`.
    const r = evaluateRetrievalCoverage({ requirement: req, ...here, audits: [
      audit({ id: '1', sourceId: 'clinicaltrials', queryClass: 'mechanism' }),
      audit({ id: '2', sourceId: 'pubmed', queryClass: 'target_modality' }),
      audit({ id: '3', sourceId: 'opentargets', queryClass: 'target_class_precedent' }),
    ]});
    expect(r.adequate).toBe(false);
    expect(r.missingSourceGroups).toContainEqual(['clinicaltrials']);
  });

  it('accepts genuinely adequate, correctly paired coverage', () => {
    const r = evaluateRetrievalCoverage({ requirement: req, ...here, audits: [
      audit({ id: '1', sourceId: 'clinicaltrials', queryClass: 'target_modality' }),
      audit({ id: '2', sourceId: 'pubmed', queryClass: 'target_class_precedent' }),
      audit({ id: '3', sourceId: 'opentargets', queryClass: 'target_modality' }),
    ]});
    expect(r.adequate).toBe(true);
  });
});

describe('edit does not disable contradiction checking', () => {
  const base = {
    target: { kind: 'gene_or_protein' as const, symbol: 'X' },
    targetRole: 'disease_driver' as const,
  };

  it('rejects an intent contradicting a non-edit action even when edit is present', () => {
    expect(() => resolveTargetEngagement({
      ...base, primaryAction: 'inhibit', secondaryActions: ['edit'],
      biologicalIntents: ['activate_function'],
    })).toThrow(/contradict/);
  });

  it('still permits an edit-resolvable intent alongside a compatible action', () => {
    const e = resolveTargetEngagement({
      ...base, primaryAction: 'inhibit', secondaryActions: ['edit'],
      biologicalIntents: ['restore_function'],
    });
    expect(e.biologicalIntents).toEqual(['restore_function', 'suppress_function']);
  });
});

describe('whitespace-only optional identity fields are omissions', () => {
  const mk = (targetForm?: string) => ({
    modality: 'small_molecule' as const,
    engagements: [{
      target: { kind: 'gene_or_protein' as const, symbol: 'KRAS', ...(targetForm !== undefined ? { targetForm } : {}) },
      targetRole: 'disease_driver' as const, primaryAction: 'inhibit' as const,
      biologicalIntents: ['suppress_function' as const],
    }],
  });
  it('does not fork the fingerprint on a blank targetForm', () => {
    expect(strategyFingerprint(mk(' '))).toBe(strategyFingerprint(mk()));
  });
  it('still distinguishes a real targetForm', () => {
    expect(strategyFingerprint(mk('G12C'))).not.toBe(strategyFingerprint(mk()));
  });
});

describe('legacy developability risks survive migration', () => {
  const risk = { evidenceId: 'ENSG1#safety', category: 'off_target_toxicity' as const, severity: 'significant' as const, explanation: 'x' };
  const legacy = {
    kind: 'research', id: 'modality_developability', title: 'M', takeaway: 't',
    claims: [], sources: [], rag: 'amber' as const, developabilityRisks: [risk],
  };
  it('surfaces them under legacyDevelopabilityRisks', () => {
    const [migrated] = migrateStoredSections([legacy]);
    expect((migrated as { legacyDevelopabilityRisks?: unknown[] }).legacyDevelopabilityRisks).toEqual([risk]);
  });
  it('keeps the original stored property too', () => {
    const [migrated] = migrateStoredSections([legacy]);
    expect((migrated as { developabilityRisks?: unknown[] }).developabilityRisks).toEqual([risk]);
  });
});

describe('liability ids are unique', () => {
  const risk = (id: string, severity: 'low' | 'high') => ({
    id, description: 'd',
    category: { domain: 'safety' as const, code: 'common.off_target_activity' as const },
    likelihood: 'moderate' as const, severity,
    mitigability: 'design_manageable' as const, confidence: 'moderate' as const,
    support: { supportingClaimIds: ['c1'], evidenceIds: ['e1'] },
  });
  const base = {
    overallDevelopmentRisk: 'high' as const,
    domainAssessments: [], topProgrammeKillingRiskIds: ['r1'],
    highestPriorityRiskMitigationOrMonitoringStep: 'x',
    earliestDecisiveDeRiskingStudy: 'y', confidence: 'moderate' as const,
    support: { supportingClaimIds: ['c1'], evidenceIds: ['e1'] },
  };

  it('rejects duplicate liability ids so resolution cannot depend on array order', async () => {
    const { Q6ConclusionSchema } = await import('./index.js');
    // Without the uniqueness check, whether `r1` resolves to the high- or the
    // low-severity entry depends purely on which comes last.
    expect(Q6ConclusionSchema.safeParse({
      ...base, liabilities: [risk('r1', 'high'), risk('r1', 'low')],
    }).success).toBe(false);
  });

  it('still accepts distinct ids', async () => {
    const { Q6ConclusionSchema } = await import('./index.js');
    expect(Q6ConclusionSchema.safeParse({
      ...base, liabilities: [risk('r1', 'high'), risk('r2', 'low')],
    }).success).toBe(true);
  });
});
