import { describe, it, expect } from 'vitest';
import type { Claim, Evidence, Verdict } from '@mrsirquanzo/sonny-shared';
import { computeRag, createSourceIdentityResolver } from './rag.js';

const claim = (id: string, cites: string[]): Claim => ({ id, text: 'x', citations: cites, confidence: 0.9 });
const v = (id: string, status: Verdict['status']): Verdict => ({ claimId: id, status, rationale: '' });
const identity = (id: string) => id;

describe('computeRag', () => {
  it('red when nothing shipped', () => { expect(computeRag([], [], identity)).toBe('red'); });
  it('red when no supported verdicts', () => {
    expect(computeRag([claim('c1', ['A'])], [v('c1', 'overreach')], identity)).toBe('red');
  });
  it('green when all supported with >=2 sources', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['B'])], [v('c1', 'supported'), v('c2', 'supported')], identity)).toBe('green');
  });
  it('amber when supported but only one source', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['A'])], [v('c1', 'supported'), v('c2', 'supported')], identity)).toBe('amber');
  });
  it('amber when mixed verdicts', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['B'])], [v('c1', 'supported'), v('c2', 'overreach')], identity)).toBe('amber');
  });

  it('maps multiple passages and figures back to one parent publication', () => {
    const evidence: Evidence[] = [
      { id: 'PMID:1', kind: 'publication', source: 'PMC', title: 'P', snippet: '', url: '', raw: { pmcid: 'PMC1' }, retrievedAt: 'now' },
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC', title: 'S', snippet: '', url: '', raw: { pmcid: 'PMC1' }, retrievedAt: 'now' },
      { id: 'PMCID:PMC1#fig-0', kind: 'figure', source: 'PMC', title: 'F', snippet: '', url: '', raw: {}, retrievedAt: 'now' },
    ];
    const resolver = createSourceIdentityResolver(evidence);
    expect(resolver('PMCID:PMC1#sec-0')).toBe('PMID:1');
    expect(resolver('PMCID:PMC1#fig-0')).toBe('PMID:1');
    expect(computeRag(
      [claim('c1', ['PMCID:PMC1#sec-0']), claim('c2', ['PMCID:PMC1#fig-0'])],
      [v('c1', 'supported'), v('c2', 'supported')], resolver,
    )).toBe('amber');
  });

  it('does not inflate GREEN for outputs sharing one logical dataset release', () => {
    const computations = [
      { id: 'COMP:1', kind: 'computation', datasetInputs: [{ logicalSourceId: 'depmap:24q4' }] },
      { id: 'COMP:2', kind: 'computation', datasetInputs: [{ logicalSourceId: 'depmap:24q4' }] },
    ] as unknown as Evidence[];
    const resolver = createSourceIdentityResolver(computations);
    expect(computeRag(
      [claim('c1', ['COMP:1']), claim('c2', ['COMP:2'])],
      [v('c1', 'supported'), v('c2', 'supported')], resolver,
    )).toBe('amber');
  });
});
