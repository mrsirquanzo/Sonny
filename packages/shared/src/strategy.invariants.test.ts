import { describe, expect, it } from 'vitest';
import {
  ACTION_TO_INTENT,
  BiologicalIntentSchema,
  Q1HypothesisSchema,
  ResolvedQueryScopeSchema,
  TargetEngagementSchema,
  TargetIdentitySchema,
  TargetRoleSchema,
  TherapeuticActionSchema,
  TherapeuticStrategySchema,
  resolveTargetEngagement,
  retrievalSymbols,
} from './index.js';

const gene = (symbol = 'KRAS') => ({ kind: 'gene_or_protein' as const, symbol });

describe('strategy contract invariants', () => {
  it('derives retrieval symbols for all four target identity kinds', () => {
    expect(retrievalSymbols(gene('KRAS'))).toEqual(['KRAS']);
    expect(retrievalSymbols({
      kind: 'peptide_hla', sourceGene: 'KRAS', variant: 'G12D', hlaAllele: 'HLA-A*11:01',
    })).toEqual(['KRAS']);
    expect(retrievalSymbols({ kind: 'fusion', partners: ['BCR', 'ABL1'] })).toEqual(['BCR', 'ABL1']);
    expect(retrievalSymbols({ kind: 'other', canonicalName: 'ganglioside GD2' })).toEqual([]);
  });

  it('rejects malformed target identities instead of accepting a bare symbol', () => {
    expect(() => TargetIdentitySchema.parse('KRAS')).toThrow();
    expect(() => TargetIdentitySchema.parse({ kind: 'gene_or_protein', symbol: '' })).toThrow();
    expect(() => TargetIdentitySchema.parse({ kind: 'peptide_hla', sourceGene: 'KRAS' })).toThrow();
    expect(() => TargetIdentitySchema.parse({ kind: 'fusion', partners: ['BCR'] })).toThrow();
    expect(() => TargetIdentitySchema.parse({ kind: 'other', canonicalName: '' })).toThrow();
  });

  it('does not admit patient_selection_biomarker as a TargetRole', () => {
    expect(TargetRoleSchema.safeParse('patient_selection_biomarker').success).toBe(false);
  });

  it('defines the complete action-to-intent map, with only edit unresolved', () => {
    const expected = {
      inhibit: 'suppress_function',
      antagonize: 'suppress_function',
      activate: 'activate_function',
      agonize: 'activate_function',
      degrade: 'suppress_function',
      silence: 'suppress_function',
      replace: 'restore_function',
      correct: 'restore_function',
      edit: null,
      deplete: 'remove_target_bearing_cell',
      redirect_immunity: 'exploit_for_immune_recognition',
      deliver_payload: 'exploit_as_delivery_address',
      unknown: 'unknown',
    } as const;

    expect(Object.keys(ACTION_TO_INTENT).sort()).toEqual([...TherapeuticActionSchema.options].sort());
    expect(ACTION_TO_INTENT).toEqual(expected);
    for (const action of TherapeuticActionSchema.options) {
      if (action !== 'edit') expect(ACTION_TO_INTENT[action]).not.toBeNull();
    }
  });

  it('rejects action-to-intent contradictions', () => {
    expect(() => resolveTargetEngagement({
      target: gene(),
      targetRole: 'disease_driver',
      primaryAction: 'inhibit',
      biologicalIntents: ['activate_function'],
    })).toThrow();
  });

  it('rejects edit without an explicit intent and never defaults it', () => {
    expect(() => resolveTargetEngagement({
      target: gene(),
      targetRole: 'disease_driver',
      primaryAction: 'edit',
    })).toThrow();
  });

  it('deduplicates and sorts intents resolved from primary and secondary actions', () => {
    const resolved = resolveTargetEngagement({
      target: gene(),
      targetRole: 'disease_driver',
      primaryAction: 'deplete',
      secondaryActions: ['activate', 'inhibit', 'antagonize', 'activate'],
      biologicalIntents: ['suppress_function', 'remove_target_bearing_cell', 'activate_function'],
    });
    expect(resolved.biologicalIntents).toEqual([
      'activate_function', 'remove_target_bearing_cell', 'suppress_function',
    ]);
  });

  it('requires intents on raw engagements', () => {
    expect(() => TargetEngagementSchema.parse({
      target: gene(), targetRole: 'disease_driver', primaryAction: 'inhibit',
    })).toThrow();
    expect(() => TargetEngagementSchema.parse({
      target: gene(), targetRole: 'disease_driver', primaryAction: 'inhibit', biologicalIntents: [],
    })).toThrow();
  });

  it('requires exactly one intervention and at least one engagement in v1', () => {
    const intervention = {
      engagements: [{
        target: gene(), targetRole: 'disease_driver', primaryAction: 'inhibit',
        biologicalIntents: ['suppress_function'],
      }],
      modality: 'small_molecule',
    };
    const base = { strategySource: 'user_specified', strategyConfidence: 'high' };
    expect(() => TherapeuticStrategySchema.parse({ ...base, interventions: [] })).toThrow();
    expect(() => TherapeuticStrategySchema.parse({ ...base, interventions: [intervention, intervention] })).toThrow();
    expect(() => TherapeuticStrategySchema.parse({
      ...base, interventions: [{ ...intervention, engagements: [] }],
    })).toThrow();
    expect(TherapeuticStrategySchema.parse({ ...base, interventions: [intervention] }).interventions).toHaveLength(1);
  });

  it('keeps selection biomarkers on the strategy', () => {
    const parsed = TherapeuticStrategySchema.parse({
      interventions: [{
        engagements: [{
          target: gene(), targetRole: 'disease_driver', primaryAction: 'inhibit',
          biologicalIntents: ['suppress_function'],
        }],
        modality: 'small_molecule',
      }],
      selectionBiomarkers: [{ name: 'KRAS G12C', kind: 'mutation', gene: 'KRAS', variant: 'G12C' }],
      strategySource: 'user_specified',
      strategyConfidence: 'high',
    });
    expect(parsed.selectionBiomarkers?.[0].assayFeasibility).toBe('unknown');
  });

  it('validates Q1 hypotheses and resolved query scopes', () => {
    expect(Q1HypothesisSchema.safeParse({
      key: '', target: gene(), targetRole: 'disease_driver', biologicalIntent: 'suppress_function',
    }).success).toBe(false);
    expect(ResolvedQueryScopeSchema.safeParse({ target: gene(), rawPrompt: '' }).success).toBe(false);
    expect(BiologicalIntentSchema.safeParse('destroy_everything').success).toBe(false);
  });
});
