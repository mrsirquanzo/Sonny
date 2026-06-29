import { describe, it, expect } from 'vitest';
import type { Evidence, Section } from '@sonny/shared';
import { assembleReferences } from './briefing.js';
import type { DeepResearchResult } from './runDeepResearch.js';

describe('assembleReferences', () => {
  it('returns the cited evidence as references, deduped and sorted, ignoring uncited evidence', () => {
    const sections: Section[] = [
      { id: 's1', title: 'S1', takeaway: 't', claims: [
        { id: 'c1', text: 'a', citations: ['PMID:2', 'ENSG1'], confidence: 0.8 },
      ], sources: ['PMID:2', 'ENSG1'], rag: 'green' },
    ];
    const evidence: Evidence[] = [
      { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'T', snippet: '', url: 'u1', raw: {}, retrievedAt: 'now' },
      { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'P', snippet: '', url: 'u2', raw: {}, retrievedAt: 'now' },
      { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'Uncited', snippet: '', url: 'u9', raw: {}, retrievedAt: 'now' },
    ];
    const result: DeepResearchResult = {
      target: 'X', sections, weighing: { takeaway: '', claims: [] }, evidence,
    };
    const refs = assembleReferences(result);
    expect(refs.map((r) => r.id)).toEqual(['ENSG1', 'PMID:2']); // sorted, PMID:9 excluded (uncited)
    expect(refs[0].title).toBe('T');
  });
});
