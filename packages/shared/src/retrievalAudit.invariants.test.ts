import { describe, expect, it } from 'vitest';
import {
  RetrievalAuditSchema,
  RetrievalQueryClassSchema,
  RetrievalSourceIdSchema,
} from './index.js';

const valid = {
  id: 'audit-1',
  axis: 'clinical_landscape',
  sectionKey: 'clinical_landscape::strategy::fp',
  sourceId: 'clinicaltrials',
  queryClass: 'target_modality',
  queryFingerprint: 'qf-1',
  normalizedQueryTerms: ['KRAS','small molecule'],
  status: 'completed',
  executedAt: '2026-07-27T12:00:00.000Z',
  rawResultCount: 4,
  relevantResultCount: 2,
};

describe('retrieval audit invariants', () => {
  it('exposes exactly the controlled source and query-class vocabularies', () => {
    expect(RetrievalSourceIdSchema.options).toEqual([
      'europepmc', 'pubmed', 'clinicaltrials', 'opentargets', 'espacenet',
      'crossref', 'hpa', 'gtex', 'uniprot',
    ]);
    expect(RetrievalQueryClassSchema.options).toEqual([
      'target', 'target_indication', 'target_modality', 'target_class_precedent',
      'mechanism', 'competitor_landscape', 'patent_landscape', 'safety_class',
    ]);
  });

  it('accepts one valid source/query execution record', () => {
    expect(RetrievalAuditSchema.parse(valid)).toEqual(valid);
  });

  it('rejects free-form sources, query classes, statuses and axis ids', () => {
    for (const mutation of [
      { sourceId: 'google' },
      { queryClass: 'whatever_the_model_searched' },
      { status: 'successful' },
      { axis: 'data_analysis' },
    ]) {
      expect(RetrievalAuditSchema.safeParse({ ...valid, ...mutation }).success).toBe(false);
    }
  });

  it('rejects invalid timestamps and negative or fractional counts', () => {
    expect(RetrievalAuditSchema.safeParse({ ...valid, executedAt: 'yesterday' }).success).toBe(false);
    expect(RetrievalAuditSchema.safeParse({ ...valid, rawResultCount: -1 }).success).toBe(false);
    expect(RetrievalAuditSchema.safeParse({ ...valid, relevantResultCount: 1.5 }).success).toBe(false);
  });
});
