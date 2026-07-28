import { describe, expect, it } from 'vitest';
import {
  q1HypothesisKey,
  strategyFingerprint,
} from './index.js';

const engagement = (
  symbol: string,
  intents: string[] = ['suppress_function'],
  secondaryActions: string[] = ['deplete', 'antagonize'],
) => ({
  target: { kind: 'gene_or_protein' as const, symbol },
  targetRole: 'disease_driver' as const,
  primaryAction: 'inhibit' as const,
  secondaryActions,
  biologicalIntents: intents,
});

describe('canonical identity hashing', () => {
  it('is invariant to engagement, intent, secondary-action order and gene-symbol case', () => {
    const a = {
      modality: 'bispecific_antibody' as const,
      engagements: [
        engagement(' kras ', ['suppress_function', 'remove_target_bearing_cell'], ['deplete', 'antagonize']),
        engagement('EGFR', ['remove_target_bearing_cell', 'suppress_function'], ['antagonize', 'deplete']),
      ],
    };
    const b = {
      modality: 'bispecific_antibody' as const,
      engagements: [
        engagement('egfr', ['suppress_function', 'remove_target_bearing_cell'], ['deplete', 'antagonize']),
        engagement('KRAS', ['remove_target_bearing_cell', 'suppress_function'], ['antagonize', 'deplete']),
      ],
    };
    expect(strategyFingerprint(a as Parameters<typeof strategyFingerprint>[0]))
      .toBe(strategyFingerprint(b as Parameters<typeof strategyFingerprint>[0]));
  });

  it('deduplicates intents and secondary actions for identity', () => {
    const once = { modality: 'small_molecule' as const, engagements: [engagement('KRAS')] };
    const duplicated = {
      modality: 'small_molecule' as const,
      engagements: [engagement(
        'KRAS',
        ['suppress_function', 'suppress_function'],
        ['antagonize', 'deplete', 'antagonize', 'deplete'],
      )],
    };
    expect(strategyFingerprint(once as Parameters<typeof strategyFingerprint>[0]))
      .toBe(strategyFingerprint(duplicated as Parameters<typeof strategyFingerprint>[0]));
  });

  it('preserves fusion partner order', () => {
    const make = (partners: [string, string]) => ({
      modality: 'small_molecule' as const,
      engagements: [{
        target: { kind: 'fusion' as const, partners },
        targetRole: 'disease_driver' as const,
        primaryAction: 'inhibit' as const,
        biologicalIntents: ['suppress_function' as const],
      }],
    });
    expect(strategyFingerprint(make(['BCR', 'ABL1']))).not.toBe(strategyFingerprint(make(['ABL1', 'BCR'])));
  });

  it('includes targetForm in strategy and Q1 identity', () => {
    const make = (targetForm?: string) => ({
      modality: 'small_molecule' as const,
      engagements: [{
        target: { kind: 'gene_or_protein' as const, symbol: 'KRAS', ...(targetForm ? { targetForm } : {}) },
        targetRole: 'disease_driver' as const,
        primaryAction: 'inhibit' as const,
        biologicalIntents: ['suppress_function' as const],
      }],
    });
    expect(strategyFingerprint(make())).not.toBe(strategyFingerprint(make('G12C')));
    expect(q1HypothesisKey(make().engagements[0].target, 'disease_driver', 'suppress_function'))
      .not.toBe(q1HypothesisKey(make('G12C').engagements[0].target, 'disease_driver', 'suppress_function'));
  });

  it('includes biological intent in Q1 hypothesis identity', () => {
    const target = { kind: 'gene_or_protein' as const, symbol: 'PDCD1' };
    expect(q1HypothesisKey(target, 'pathway_regulator', 'suppress_function'))
      .not.toBe(q1HypothesisKey(target, 'pathway_regulator', 'activate_function'));
  });
});
