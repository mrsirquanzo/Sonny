import { describe, expect, it } from 'vitest';
import { contextsAreEquivalent, normalizeDiseaseContext } from '../index.js';
import { ontologyFixture } from './ontologyFixture.js';

describe('non-equivalence and ambiguity rejection rules', () => {
  it.each([
    ['EFO:BROAD_LUNG_CANCER', 'broad'],
    ['EFO:NARROW_LUNG_ADENO', 'narrow'],
  ] as const)('preserves a %s mapping as %s and refuses to turn it into exact equivalence', (indication, relation) => {
    const mapped = normalizeDiseaseContext({ indication }, ontologyFixture);
    const exact = normalizeDiseaseContext(
      { indication: relation === 'broad' ? 'NSCLC' : 'lung adenocarcinoma' },
      ontologyFixture,
    );

    expect(mapped.mappingRelation).toBe(relation);
    expect(mapped.mappingRelation).not.toBe('exact');
    expect(mapped.mappingConfidence).not.toBe('exact');
    expect(contextsAreEquivalent(mapped, exact)).toBe(false);
  });

  it('does not merge an unresolved near-neighbour and retains candidate reasons', () => {
    const unresolved = normalizeDiseaseContext(
      { indication: 'non small lung adenocarcinom' },
      ontologyFixture,
    );
    const neighbour = normalizeDiseaseContext({ indication: 'lung adenocarcinoma' }, ontologyFixture);

    expect(unresolved.mappingConfidence).toBe('unresolved');
    expect(unresolved.mappingRelation).toBe('unresolved');
    expect(unresolved.indication.ontologyId).toBeUndefined();
    expect(unresolved.possibleMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalContextId: expect.any(String),
        reason: expect.stringMatching(/\S/),
      }),
    ]));
    expect(contextsAreEquivalent(unresolved, neighbour)).toBe(false);
    expect(unresolved.canonicalContextId).not.toBe(neighbour.canonicalContextId);
  });

  it('does not allow possibleMatches to mutate the unresolved identity', () => {
    const first = normalizeDiseaseContext({ indication: 'melanomia' }, ontologyFixture);
    const second = normalizeDiseaseContext({ indication: 'melanomia' }, ontologyFixture);
    expect(first.canonicalContextId).toBe(second.canonicalContextId);
    expect(first.indication.ontologyId).toBeUndefined();
  });
});

