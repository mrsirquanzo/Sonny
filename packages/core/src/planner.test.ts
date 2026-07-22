import { describe, expect, it } from 'vitest';
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

  it('falls back to antibody when the model throws', async () => {
    const model: StructuredModel = {
      async generateStructured() { throw new Error('model unavailable'); },
    };

    await expect(inferModality('KRAS', model)).resolves.toEqual({
      modality: 'antibody',
      rationale: 'inference failed; defaulted to antibody',
    });
  });
});

describe('composeRoster', () => {
  it('returns the composed briefs and emits an auditable plan', async () => {
    const events: TraceEvent[] = [];
    const result = await composeRoster({
      target: 'KRAS',
      context: { indication: 'NSCLC', modality: 'small molecule' },
      model: fixedModel({
        specialists: Array.from({ length: 5 }, (_, index) => specialist(index + 1)),
        rationale: 'Five areas cover the small-molecule decision.',
      }),
      emit: (event) => events.push(event),
    });

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({
      id: 'specialist_1',
      title: 'Specialist 1',
      objective: 'Assess area 1.',
      promptHint: 'Assess area 1. BOUNDARY: Do not cover the other specialist areas.',
    });
    const event = events.find((candidate) => candidate.type === 'plan_composed');
    expect(event).toMatchObject({
      type: 'plan_composed',
      modality: 'small molecule',
      rationale: 'Five areas cover the small-molecule decision.',
    });
    expect(event?.type === 'plan_composed' && event.specialists).toHaveLength(5);
    expect(event?.type === 'plan_composed' && event.specialists[0]).toEqual({
      id: 'specialist_1', title: 'Specialist 1', weight: 0.5,
    });
  });

  it('clamps an oversized plan to seven specialists', async () => {
    const result = await composeRoster({
      target: 'KRAS',
      context: { modality: 'small molecule' },
      model: fixedModel({
        specialists: Array.from({ length: 9 }, (_, index) => specialist(index + 1)),
        rationale: 'Oversized model response.',
      }),
      emit: () => {},
    });

    expect(result).toHaveLength(7);
  });

  it('falls back to the canonical roster and emits an error when the model throws', async () => {
    const events: TraceEvent[] = [];
    const model: StructuredModel = {
      async generateStructured() { throw new Error('model unavailable'); },
    };

    const result = await composeRoster({
      target: 'KRAS',
      context: { modality: 'PROTAC' },
      model,
      emit: (event) => events.push(event),
    });

    expect(result).toBe(RESEARCH_ROSTER);
    expect(result.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});
