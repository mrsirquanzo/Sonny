import { describe, expect, it, vi } from 'vitest';
import { normalizeDiseaseContext } from '../index.js';
import { ontologyFixture } from './ontologyFixture.js';

describe('pinned, deterministic MONDO resolution', () => {
  it.each([
    ['non-small cell lung carcinoma', 'MONDO:0005233'],
    ['NSCLC', 'MONDO:0005233'],
    ['PDAC', 'MONDO:0006047'],
    ['malignant melanoma', 'MONDO:0005105'],
    ['mucoviscidosis', 'MONDO:0009061'],
    ['TNBC', 'MONDO:0006256'],
  ])('resolves exact label or exact synonym %s before any weaker mapping', (indication, ontologyId) => {
    const result = normalizeDiseaseContext({ indication }, ontologyFixture);
    expect(result).toMatchObject({
      ontologySource: 'MONDO',
      ontologyVersion: '2026-06-02',
      indication: { raw: indication, ontologyId },
      mappingConfidence: 'exact',
      mappingRelation: 'exact',
    });
    expect(result.matchedVia).toMatchObject({
      source: 'MONDO',
      labelOrSynonym: expect.any(String),
    });
  });

  it.each([
    ['EFO' as const, 'EFO:0003060', 'MONDO:0005233'],
    ['DOID' as const, 'DOID:3498', 'MONDO:0006047'],
    ['NCIT' as const, 'C3512', 'MONDO:0005061'],
  ])('resolves %s identifiers only through explicit index cross-references', (source, sourceId, ontologyId) => {
    const result = normalizeDiseaseContext({ indication: sourceId }, ontologyFixture);
    expect(result).toMatchObject({
      indication: { raw: sourceId, ontologyId },
      mappingConfidence: 'exact',
      mappingRelation: 'exact',
      matchedVia: {
        source,
        sourceId,
        labelOrSynonym: expect.any(String),
      },
    });
  });

  it.each(['EFO:9999999', 'DOID:9999999', 'NCIT:C999999'])(
    'never accepts an ontology identifier absent from the injected index: %s',
    (indication) => {
      const result = normalizeDiseaseContext({ indication }, ontologyFixture);
      expect(result.indication.ontologyId).toBeUndefined();
      expect(result.mappingConfidence).toBe('unresolved');
      expect(result.mappingRelation).toBe('unresolved');
    },
  );

  it('performs resolution entirely through the injected index, without network I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const result = normalizeDiseaseContext({ indication: 'TNBC' }, ontologyFixture);
    expect(result.indication.ontologyId).toBe('MONDO:0006256');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
