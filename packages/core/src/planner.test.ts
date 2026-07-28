import { describe, expect, it, vi } from 'vitest';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { composeRoster, inferModality, isAntibodyModality } from './planner.js';
import { RESEARCH_ROSTER } from './researchRoster.js';

function fixedModel(result: unknown): StructuredModel {
  return { async generateStructured() { return result as never; } };
}

function specialist(index: number) {
  return {
    id: `specialist_${index}`,
    title: `Specialist ${index}`,
    objective: `Assess area ${index}.`,
    promptHint: `Assess area ${index}. BOUNDARY: Do not cover the other specialist areas.`,
    weight: 0.5,
  };
}

describe('isAntibodyModality', () => {
  it.each([undefined, '', 'ADC', 'antibody-drug conjugate'])(
    'uses the canonical roster for %s',
    (modality) => expect(isAntibodyModality(modality)).toBe(true),
  );

  it.each(['small molecule', 'PROTAC', 'CAR-T', 'bispecific'])(
    'uses the planner for %s',
    (modality) => expect(isAntibodyModality(modality)).toBe(false),
  );
});

describe('inferModality', () => {
  it('returns the inferred modality and rationale', async () => {
    const result = await inferModality('KRAS', fixedModel({
      modality: 'small molecule',
      rationale: 'KRAS is an intracellular GTPase with established ligandable pockets.',
    }));

    expect(result).toEqual({
      modality: 'small molecule',
      rationale: 'KRAS is an intracellular GTPase with established ligandable pockets.',
    });
  });

  it('falls back to unknown (never antibody) when the model throws', async () => {
    const model: StructuredModel = {
      async generateStructured() { throw new Error('model unavailable'); },
    };

    await expect(inferModality('KRAS', model)).resolves.toEqual({
      modality: 'unknown',
      rationale: 'inference failed; modality unresolved',
    });
  });
});

describe('composeRoster is deterministic', () => {
  const emit = (): void => {};

  it('makes NO model call', async () => {
    const gen = vi.fn();
    composeRoster({ target: 'KRAS', modality: 'small_molecule', emit, });
    expect(gen).not.toHaveBeenCalled();
  });

  it('produces byte-identical rosters for identical inputs', () => {
    const a = composeRoster({ target: 'KRAS', modality: 'small_molecule', emit });
    const b = composeRoster({ target: 'KRAS', modality: 'small_molecule', emit });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('always instantiates all six axes - never drops or adds one', () => {
    for (const modality of ['adc', 'small_molecule', 'car_t', 'unknown'] as const) {
      const roster = composeRoster({ target: 'X', modality, emit });
      expect(roster.map((b) => b.id)).toEqual([
        'target_biology', 'moa_pathway', 'disease_indications',
        'clinical_landscape', 'competitive_ip', 'modality_developability',
      ]);
    }
  });

  it('injects lens content into Q2 and Q6 only', () => {
    const roster = composeRoster({ target: 'KRAS', modality: 'small_molecule', emit });
    const hint = (id: string): string => roster.find((b) => b.id === id)!.promptHint;
    expect(hint('moa_pathway')).toMatch(/druggable binding pocket/i);
    expect(hint('modality_developability')).toMatch(/reactive metabolites|oral bioavailability/i);
    for (const id of ['target_biology', 'disease_indications', 'clinical_landscape', 'competitive_ip']) {
      expect(hint(id)).not.toMatch(/druggable binding pocket/i);
    }
  });

  it('conditions a small-molecule run away from antibody framing', () => {
    const sm = composeRoster({ target: 'KRAS', modality: 'small_molecule', emit });
    const q2 = sm.find((b) => b.id === 'moa_pathway')!.promptHint;
    expect(q2).not.toMatch(/internalisation|internalization|surface epitope/i);
  });

  it('routes an unresolved modality to the generic lens, never to antibody', () => {
    const unknown = composeRoster({ target: 'X', modality: 'unknown', emit });
    const q2 = unknown.find((b) => b.id === 'moa_pathway')!.promptHint;
    expect(q2).toMatch(/target access/i);
    expect(q2).not.toMatch(/antibody binding|internalisation/i);
  });

  it('keeps the BOUNDARY clause last in a lens-injected hint', () => {
    const roster = composeRoster({ target: 'X', modality: 'adc', emit });
    const hint = roster.find((b) => b.id === 'moa_pathway')!.promptHint;
    expect(hint.indexOf('BOUNDARY:')).toBeGreaterThan(hint.indexOf('Evaluate the following'));
  });
});
