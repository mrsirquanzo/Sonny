import { describe, expect, it, vi } from 'vitest';
import {
  contextsAreEquivalent,
  diseaseContextRelation,
  normalizeDiseaseContext,
} from '../index.js';
import { ontologyFixture } from './ontologyFixture.js';

describe('directional ontology relationships', () => {
  it('reports child-to-parent and parent-to-child independently, never as equivalence', () => {
    const adenocarcinoma = normalizeDiseaseContext({ indication: 'lung adenocarcinoma' }, ontologyFixture);
    const nsclc = normalizeDiseaseContext({ indication: 'NSCLC' }, ontologyFixture);

    expect(diseaseContextRelation(adenocarcinoma, nsclc, ontologyFixture)).toBe('narrower');
    expect(diseaseContextRelation(nsclc, adenocarcinoma, ontologyFixture)).toBe('broader');
    expect(contextsAreEquivalent(adenocarcinoma, nsclc)).toBe(false);
    expect(contextsAreEquivalent(nsclc, adenocarcinoma)).toBe(false);
  });

  it('uses the index ancestor graph rather than label containment or fuzzy strings', () => {
    const ancestorsOf = vi.fn(ontologyFixture.ancestorsOf.bind(ontologyFixture));
    const index = { ...ontologyFixture, ancestorsOf };
    const child = normalizeDiseaseContext({ indication: 'adenocarcinoma of lung' }, index);
    const parent = normalizeDiseaseContext({ indication: 'non-small-cell lung cancer' }, index);

    expect(diseaseContextRelation(child, parent, index)).toBe('narrower');
    expect(ancestorsOf).toHaveBeenCalledWith('MONDO:0005061');

    const unrelated = normalizeDiseaseContext({ indication: 'pancreatic ductal adenocarcinoma' }, index);
    expect(diseaseContextRelation(child, unrelated, index)).toBe('unrelated');
  });
});

