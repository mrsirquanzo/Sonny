import { describe, expect, it } from 'vitest';
import {
  AnalysisSectionSchema,
  CurrentSectionSchema,
  LegacyResearchSectionSchema,
  ResearchSectionV2Schema,
  migrateStoredSections,
  parseStoredSection,
} from './index.js';

const support = { supportingClaimIds: ['c1'], evidenceIds: ['e1'] };
const q2Conclusion = {
  axis: 'moa_pathway',
  assessment: {
    modalityFit: 'strong',
    weakestLink: { mechanisticStatus: 'supported', mitigability: 'engineerable' },
    confidence: 'high',
    mechanisticBottleneck: 'Exposure at the target tissue.',
    mostDecisiveNextExperiment: 'Measure target engagement in vivo.',
    support,
  },
};
const base = {
  kind: 'research',
  title: 'Section title',
  takeaway: 'Takeaway',
  claims: [],
  sources: [],
  rag: 'green',
};
const v2 = {
  ...base,
  schemaVersion: 2,
  id: 'moa_pathway',
  scope: { kind: 'strategy', strategyFingerprint: 'fp-1' },
  conclusion: q2Conclusion,
};

describe('section version discrimination', () => {
  it('accepts a valid V2 research section', () => {
    expect(ResearchSectionV2Schema.safeParse(v2).success).toBe(true);
    expect(CurrentSectionSchema.safeParse(v2).success).toBe(true);
  });

  it('rejects a versioned section missing conclusion without legacy fallthrough', () => {
    const { conclusion: _conclusion, ...missingConclusion } = v2;
    expect(() => parseStoredSection(missingConclusion)).toThrow();
  });

  it('rejects any versioned input in the legacy schema', () => {
    expect(LegacyResearchSectionSchema.safeParse(v2).success).toBe(false);
    expect(LegacyResearchSectionSchema.safeParse({
      ...base, schemaVersion: 1, id: 'target_biology',
    }).success).toBe(false);
  });

  it('still parses a legacy research section with no schemaVersion', () => {
    expect(parseStoredSection({
      ...base, id: 'target_biology',
    })).toMatchObject({ kind: 'research', id: 'target_biology' });
  });

  it('does not materialize a visibility default while reading stored sections', () => {
    expect(parseStoredSection({ ...base, id: 'target_biology' })).not.toHaveProperty('visibility');
  });

  it('preserves a stored legacy developabilityRisks property on read', () => {
    const developabilityRisks = [{
      evidenceId: 'PMID:1',
      category: 'immunogenicity',
      severity: 'severe',
      explanation: 'High anti-drug-antibody incidence.',
    }];
    expect(parseStoredSection({
      ...base, id: 'modality_developability', developabilityRisks,
    })).toHaveProperty('developabilityRisks', developabilityRisks);
  });

  it('keeps the renamed migration entry point usable for stored sections', () => {
    expect(migrateStoredSections([{ ...base, id: 'target_biology' }])).toHaveLength(1);
  });
});

describe('analysis sections remain outside the specialist-axis enum', () => {
  const analysis = {
    kind: 'analysis',
    id: 'data_analysis',
    title: 'Data analysis',
    takeaway: 'Computed result',
    claims: [],
    sources: [],
    rag: 'green',
    computationIds: ['a'.repeat(64)],
    figurePaths: ['figures/expression.png'],
  };

  it('accepts data_analysis', () => {
    expect(AnalysisSectionSchema.safeParse(analysis).success).toBe(true);
    expect(CurrentSectionSchema.safeParse(analysis).success).toBe(true);
    expect(parseStoredSection(analysis)).toMatchObject({ id: 'data_analysis' });
  });

  it('rejects an empty analysis id', () => {
    expect(AnalysisSectionSchema.safeParse({ ...analysis, id: '' }).success).toBe(false);
  });
});

describe('axis, scope and conclusion consistency on V2 sections', () => {
  const scopeFor = {
    shared: { kind: 'shared' },
    strategy: { kind: 'strategy', strategyFingerprint: 'fp-1' },
    q1_hypothesis: {
      kind: 'q1_hypothesis', q1HypothesisKey: 'h-1', relatedStrategyFingerprints: ['fp-1'],
    },
  } as const;

  it.each([
    ['target_biology', 'shared'],
    ['target_biology', 'strategy'],
    ['moa_pathway', 'shared'],
    ['moa_pathway', 'q1_hypothesis'],
    ['disease_indications', 'q1_hypothesis'],
    ['clinical_landscape', 'shared'],
    ['clinical_landscape', 'q1_hypothesis'],
    ['competitive_ip', 'shared'],
    ['competitive_ip', 'q1_hypothesis'],
    ['modality_developability', 'shared'],
    ['modality_developability', 'q1_hypothesis'],
  ] as const)('rejects illegal axis/scope combination %s/%s', (id, kind) => {
    expect(ResearchSectionV2Schema.safeParse({
      ...v2, id, scope: scopeFor[kind],
    }).success).toBe(false);
  });

  it('rejects a conclusion whose axis differs from the section id', () => {
    expect(ResearchSectionV2Schema.safeParse({
      ...v2, id: 'clinical_landscape',
    }).success).toBe(false);
  });

  it('requires strategy-scoped Q3 to use strategy_overlay mode', () => {
    expect(ResearchSectionV2Schema.safeParse({
      ...v2,
      id: 'disease_indications',
      conclusion: {
        axis: 'disease_indications',
        conclusion: { mode: 'comparative', assessments: [] },
      },
    }).success).toBe(false);
  });

  it('requires shared Q3 to use comparative mode', () => {
    expect(ResearchSectionV2Schema.safeParse({
      ...v2,
      id: 'disease_indications',
      scope: scopeFor.shared,
      conclusion: {
        axis: 'disease_indications',
        conclusion: { mode: 'strategy_overlay', assessments: [] },
      },
    }).success).toBe(false);
  });
});
