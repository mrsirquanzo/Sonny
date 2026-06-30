import { describe, it, expect } from 'vitest';
import type { Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { mapSpecialtyLabs } from './kolDetector.js';

function paper(id: string, pi: string, pmcid: string, affiliation?: string): Evidence {
  return { id, kind: 'publication', source: 'Europe PMC', title: id, snippet: '', passage: 'a', url: 'u',
    raw: { pmcid }, retrievedAt: 'now',
    metadata: { authors: [{ name: 'First A' }, { name: pi, ...(affiliation ? { affiliation } : {}) }] } };
}
function fullTextSection(pmcid: string): Evidence {
  return { id: `PMCID:${pmcid}#sec-0`, kind: 'publication', source: 'PMC full text', title: 's', snippet: '', passage: 'x', url: 'u',
    raw: { pmcid }, retrievedAt: 'now' };
}

describe('mapSpecialtyLabs', () => {
  it('ranks the top 3 PIs by weighted last-authorship, weighting full-text over abstract-only', () => {
    const store = new EvidenceStore();
    // Senior B: 3 full-text papers -> weight 9
    for (let i = 0; i < 3; i++) { store.register(paper(`PMID:b${i}`, 'Senior B', `PMCb${i}`, 'Karolinska Institute')); store.register(fullTextSection(`PMCb${i}`)); }
    // Senior A: 2 full-text + 2 abstract -> weight 8
    for (let i = 0; i < 2; i++) { store.register(paper(`PMID:a${i}`, 'Senior A', `PMCa${i}`)); store.register(fullTextSection(`PMCa${i}`)); }
    for (let i = 2; i < 4; i++) store.register(paper(`PMID:a${i}`, 'Senior A', ''));
    // Senior C: 5 abstract-only -> weight 5 (more papers than B, but lower weight)
    for (let i = 0; i < 5; i++) store.register(paper(`PMID:c${i}`, 'Senior C', ''));
    // Senior D: 1 abstract -> weight 1 (outside top 3)
    store.register(paper('PMID:d0', 'Senior D', ''));

    const cluster = mapSpecialtyLabs(store, 'CDCP1');
    expect(cluster.target).toBe('CDCP1');
    expect(cluster.labs.map((l) => l.investigator)).toEqual(['Senior B', 'Senior A', 'Senior C']);
    expect(cluster.labs[0].weight).toBe(9);
    expect(cluster.labs[0].paperCount).toBe(3);
    expect(cluster.labs[0].institution).toBe('Karolinska Institute');
    expect(cluster.labs[0].evidenceIds).toEqual(['PMID:b0', 'PMID:b1', 'PMID:b2']); // grounded
    // full-text seminal (B, 3 papers) outranks abstract-only (C, 5 papers)
    expect(cluster.labs[0].weight).toBeGreaterThan(cluster.labs[2].weight);
  });

  it('returns an empty lab list when no evidence carries author metadata', () => {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' });
    expect(mapSpecialtyLabs(store, 'CDCP1')).toEqual({ target: 'CDCP1', labs: [] });
  });
});
