import { describe, it, expect } from 'vitest';
import type { Evidence, Section } from '@mrsirquanzo/sonny-shared';
import { assembleReferences } from './briefing.js';
import type { DeepResearchResult } from './runDeepResearch.js';

describe('assembleReferences', () => {
  it('returns the cited evidence as references, deduped and sorted, ignoring uncited evidence', () => {
    const sections: Section[] = [
      { kind: 'research', id: 's1', title: 'S1', takeaway: 't', claims: [
        { id: 'c1', text: 'a', citations: ['PMID:2', 'ENSG1'], confidence: 0.8 },
      ], sources: ['PMID:2', 'ENSG1'], rag: 'green' },
    ];
    const evidence: Evidence[] = [
      { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'T', snippet: 'x'.repeat(601), url: 'u1', raw: { tissue: 'liver' }, retrievedAt: 'now' },
      { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'P', snippet: 'Paper finding', url: 'u2', raw: { fullText: 'large' }, retrievedAt: 'now' },
      { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'Uncited', snippet: '', url: 'u9', raw: {}, retrievedAt: 'now' },
    ];
    const result: DeepResearchResult = {
      target: 'X', sections, weighing: { takeaway: '', claims: [] }, evidence, kolCluster: { target: 'X', labs: [] },
    };
    const refs = assembleReferences(result);
    expect(refs.map((r) => r.id)).toEqual(['ENSG1', 'PMID:2']); // sorted, PMID:9 excluded (uncited)
    expect(refs[0].title).toBe('Open Targets - target record'); // DB card relabelled, not its facet title
    expect(refs[1].title).toBe('P'); // a real paper title is preserved
    expect(refs[0]).toMatchObject({ snippet: 'x'.repeat(600), raw: { tissue: 'liver' } });
    expect(refs[1]).toMatchObject({ snippet: 'Paper finding' });
    expect(refs[1]).not.toHaveProperty('raw');
  });

  it('collapses cited PMC sections and DB-card facets to one reference per source', () => {
    const sections: Section[] = [
      { kind: 'research', id: 's1', title: 'S1', takeaway: 't', claims: [
        { id: 'c1', text: 'a', citations: ['PMCID:PMC7#sec-4', 'PMCID:PMC7#sec-5', 'ENSG1#expression', 'ENSG1#tractability'], confidence: 0.8 },
      ], sources: [], rag: 'green' },
    ];
    const evidence: Evidence[] = [
      { id: 'PMCID:PMC7#sec-4', kind: 'publication', source: 'PMC full text', title: 'Introduction', snippet: '', url: 'https://x/PMC7#sec-4', raw: {}, retrievedAt: 'now' },
      { id: 'PMCID:PMC7#sec-5', kind: 'publication', source: 'PMC full text', title: 'Discussion', snippet: '', url: 'https://x/PMC7#sec-5', raw: {}, retrievedAt: 'now' },
      { id: 'ENSG1#expression', kind: 'target', source: 'Open Targets', title: 'expression', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
      { id: 'ENSG1#tractability', kind: 'target', source: 'Open Targets', title: 'tractability', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ];
    const result: DeepResearchResult = {
      target: 'X', sections, weighing: { takeaway: '', claims: [] }, evidence, kolCluster: { target: 'X', labs: [] },
    };
    const refs = assembleReferences(result);
    expect(refs.map((r) => r.id)).toEqual(['ENSG1', 'PMCID:PMC7']); // 4 cited locators -> 2 sources
    expect(refs.find((r) => r.id === 'PMCID:PMC7')!.title).toBe('PubMed Central full text');
    expect(refs.find((r) => r.id === 'PMCID:PMC7')!.url).toBe('https://x/PMC7'); // anchor stripped
  });

  it('preserves computation provenance through analysis-section references', () => {
    const computationId = 'a'.repeat(64);
    const section: Section = {
      kind: 'analysis', id: 'analysis', title: 'Data analysis', takeaway: 'Typed result.',
      claims: [{
        id: 'c', text: 'Computed.', citations: ['COMP:1'], confidence: 1,
        computedBinding: { computationId, resultKey: 'x', assertedValue: 1, assertedUnit: 'TPM' },
      }],
      sources: ['COMP:1'], rag: 'amber', computationIds: [computationId], figurePaths: ['x.png'],
    };
    const computation = {
      id: 'COMP:1', kind: 'computation', source: 'Sonny', title: 'Analysis', snippet: '', url: '', raw: {},
      retrievedAt: 'now', computationId, templateId: 't', templateVersion: '1.0.0',
      datasetInputs: [{ datasetId: 'd', logicalSourceId: 'd:r', contentSha256: 'b'.repeat(64), acquisitionQuery: {}, retrievedAt: 'now', lineageManifestHash: 'c'.repeat(64), lineageManifest: {} }],
      imageDigest: `sha256:${'d'.repeat(64)}`, codeBytes: 'x', codeHash: 'e'.repeat(64), params: {}, seed: 1,
      exitStatus: { exitCode: 0, timedOut: false, signal: null }, resultKeys: ['x'], resultsJsonHash: 'f'.repeat(64),
    } as unknown as Evidence;
    const result: DeepResearchResult = {
      target: 'X', sections: [section], weighing: { takeaway: '', claims: [] }, evidence: [computation],
      kolCluster: { target: 'X', labs: [] }, contradictions: [],
    };
    expect(assembleReferences(result)[0]).toMatchObject({
      kind: 'computation', computationId, resultKeys: ['x'], resultsJsonHash: 'f'.repeat(64),
    });
  });
});
