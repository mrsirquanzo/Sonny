import { describe, expect, it } from 'vitest';
import { normalizeDiseaseContext } from '../index.js';
import { sha256CanonicalJson } from '@mrsirquanzo/sonny-shared';
import { ontologyFixture } from './ontologyFixture.js';

const base = {
  indication: 'NSCLC',
  biomarker: { raw: 'KRAS G12C', geneSymbol: 'KRAS', variant: 'G12C' },
  treatmentSetting: 'metastatic',
  lineOfTherapy: 'second line',
  diseaseSubtype: 'adenocarcinoma',
};

describe('canonicalContextId invariants', () => {
  it('is deterministic, SHA-256 shaped, and uses the shared canonical hash convention', () => {
    const first = normalizeDiseaseContext(base, ontologyFixture);
    const second = normalizeDiseaseContext(structuredClone(base), ontologyFixture);
    expect(first.canonicalContextId).toBe(second.canonicalContextId);
    expect(first.canonicalContextId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.canonicalContextId).toBe(sha256CanonicalJson(first.normalizedIdentity));
  });

  it('collapses semantically irrelevant case and whitespace differences', () => {
    const left = normalizeDiseaseContext(base, ontologyFixture);
    const right = normalizeDiseaseContext({
      indication: '  nsclc ',
      biomarker: { raw: ' kras   g12c ', geneSymbol: ' kras ', variant: ' g12c ' },
      treatmentSetting: '  METASTATIC ',
      lineOfTherapy: ' SECOND   LINE ',
      diseaseSubtype: ' ADENOCARCINOMA ',
    }, ontologyFixture);
    expect(right.canonicalContextId).toBe(left.canonicalContextId);
  });

  it.each([
    ['treatment setting', { treatmentSetting: 'adjuvant' }],
    ['line of therapy', { lineOfTherapy: 'first line' }],
    ['biomarker gene', { biomarker: { raw: 'EGFR L858R', geneSymbol: 'EGFR', variant: 'L858R' } }],
    ['biomarker variant', { biomarker: { raw: 'KRAS G12D', geneSymbol: 'KRAS', variant: 'G12D' } }],
  ])('changes identity when %s changes', (_label, change) => {
    const left = normalizeDiseaseContext(base, ontologyFixture);
    const right = normalizeDiseaseContext({ ...base, ...change }, ontologyFixture);
    expect(right.canonicalContextId).not.toBe(left.canonicalContextId);
  });

  it('gives unresolved raw input a stable but non-colliding identity', () => {
    const a = normalizeDiseaseContext({ indication: 'unknown syndrome alpha' }, ontologyFixture);
    const repeat = normalizeDiseaseContext({ indication: ' UNKNOWN   SYNDROME ALPHA ' }, ontologyFixture);
    const b = normalizeDiseaseContext({ indication: 'unknown syndrome beta' }, ontologyFixture);
    expect(a.mappingConfidence).toBe('unresolved');
    expect(a.canonicalContextId).toBe(repeat.canonicalContextId);
    expect(a.canonicalContextId).not.toBe(b.canonicalContextId);
  });
});

