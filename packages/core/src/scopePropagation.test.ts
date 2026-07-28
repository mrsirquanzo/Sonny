import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SCOPE_KINDS,
  isScopeLegalForAxis,
  sectionKey,
  strategyFingerprint,
  q1HypothesisKey,
  type SpecialistAxisId,
  type TherapeuticStrategy,
} from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { composeRoster } from './planner.js';
import { EvidenceStore } from './evidenceStore.js';
import { produceResearchSection } from './produceResearchSection.js';

const strategy: TherapeuticStrategy = {
  interventions: [{
    modality: 'small_molecule',
    engagements: [{
      target: { kind: 'gene_or_protein', symbol: 'KRAS', targetForm: 'G12C' },
      targetRole: 'disease_driver',
      primaryAction: 'inhibit',
      biologicalIntents: ['suppress_function'],
    }],
  }],
  indication: 'NSCLC',
  strategySource: 'user_specified',
  strategyConfidence: 'high',
};

const fp = strategyFingerprint(strategy.interventions[0]);
const hypothesisKey = q1HypothesisKey(
  strategy.interventions[0].engagements[0].target,
  strategy.interventions[0].engagements[0].targetRole,
  strategy.interventions[0].engagements[0].biologicalIntents[0],
);

const forbiddenModel = {
  async generateStructured() { throw new Error('unexpected model call'); },
} as StructuredModel;

describe('slice 3 single-strategy scope propagation', () => {
  it('builds every brief with a legal execution context and a matching scope', async () => {
    const roster = await composeRoster({
      target: 'KRAS G12C',
      context: { indication: 'NSCLC', modality: 'small_molecule', strategy } as never,
      model: forbiddenModel,
      emit: () => {},
    });

    expect(roster).toHaveLength(6);
    for (const brief of roster) {
      expect(brief).toHaveProperty('context');
      expect(brief).toHaveProperty('scope');
      expect(brief.context.kind).toBe(brief.scope.kind);
      expect(REQUIRED_SCOPE_KINDS[brief.id as SpecialistAxisId]).toContain(brief.scope.kind);
      expect(isScopeLegalForAxis(brief.id as SpecialistAxisId, brief.scope)).toBe(true);
    }

    const q1 = roster.find((brief) => brief.id === 'target_biology')!;
    expect(q1.context).toMatchObject({
      kind: 'q1_hypothesis',
      hypothesis: { key: hypothesisKey },
      relatedStrategyFingerprints: [fp],
    });
    expect(q1.scope).toEqual({
      kind: 'q1_hypothesis',
      q1HypothesisKey: hypothesisKey,
      relatedStrategyFingerprints: [fp],
    });

    for (const id of ['moa_pathway', 'clinical_landscape', 'competitive_ip', 'modality_developability']) {
      const brief = roster.find((candidate) => candidate.id === id)!;
      expect(brief.context).toMatchObject({ kind: 'strategy', strategyFingerprint: fp, strategy });
      expect(brief.scope).toEqual({ kind: 'strategy', strategyFingerprint: fp });
      expect(brief.scope).not.toHaveProperty('strategyVariantLabel');
    }
  });

  it('cannot emit target_biology::strategy or moa_pathway::shared end-to-end', async () => {
    const roster = await composeRoster({
      target: 'KRAS G12C',
      context: { indication: 'NSCLC', modality: 'small_molecule', strategy } as never,
      model: forbiddenModel,
      emit: () => {},
    });

    const specialistModel = {
      async generateStructured() { throw new Error('maxRounds=0 must not invoke specialist model'); },
    } as StructuredModel;
    const verifierModel = {
      async generateStructured() { throw new Error('no claims must not invoke verifier model'); },
    } as StructuredModel;

    const sections = await Promise.all(roster.map((brief) => produceResearchSection({
      brief,
      target: 'KRAS',
      tools: [],
      store: new EvidenceStore(),
      specialistModel,
      verifierModel,
      emit: () => {},
      budget: { maxRounds: 0 },
    })));

    for (const section of sections) {
      expect(section).toHaveProperty('scope');
      expect(REQUIRED_SCOPE_KINDS[section.id as SpecialistAxisId]).toContain(section.scope.kind);
    }
    expect(sections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'target_biology', scope: expect.objectContaining({ kind: 'strategy' }) }),
      expect.objectContaining({ id: 'moa_pathway', scope: expect.objectContaining({ kind: 'shared' }) }),
    ]));
  });

  it('preserves sectionKey distinctness through briefs and emitted sections', async () => {
    const roster = await composeRoster({
      target: 'KRAS G12C',
      context: { indication: 'NSCLC', modality: 'small_molecule', strategy } as never,
      model: forbiddenModel,
      emit: () => {},
    });
    const keys = roster.map((brief) => sectionKey(brief.id as SpecialistAxisId, brief.scope));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`target_biology::q1::${hypothesisKey}`);
    expect(keys).toContain(`moa_pathway::strategy::${fp}`);
  });
});
