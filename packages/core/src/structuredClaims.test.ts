import { describe, it, expect } from 'vitest';
import { deriveStructuredClaims, mergeStructuredClaims } from './structuredClaims.js';
import { EvidenceStore } from './evidenceStore.js';
import type { Section } from '@mrsirquanzo/sonny-shared';

function storeWith(cards: Array<{ id: string; source: string; snippet: string }>): EvidenceStore {
  const s = new EvidenceStore();
  for (const c of cards) {
    s.register({ id: c.id, kind: 'target', source: c.source, title: c.id, snippet: c.snippet, retrievedAt: '2020-01-01' } as never);
  }
  return s;
}

describe('deriveStructuredClaims', () => {
  it('routes curated cards to their owning sections and cites the card id', () => {
    const store = storeWith([
      { id: 'ENSG1#localization', source: 'Open Targets', snippet: 'Cell membrane; extracellular.' },
      { id: 'ENSG1#expression', source: 'Open Targets', snippet: 'Highest normal expression in pancreas.' },
      { id: 'ENSG1#tractability', source: 'Open Targets', snippet: 'No antibody/ADC bucket achieved.' },
      { id: 'ENSG1#safety', source: 'Open Targets', snippet: 'Known safety liabilities: none curated.' },
      { id: 'UNIPROT:Q1#localization', source: 'UniProt', snippet: 'One transmembrane region with extracellular domain.' },
      { id: 'PMID:123', source: 'Europe PMC', snippet: 'Some literature claim.' },
    ]);
    const bySection = deriveStructuredClaims(store);
    expect(bySection.get('target_biology')!.length).toBe(2); // OT + UniProt localisation
    expect(bySection.get('disease_indications')!.length).toBe(1); // expression
    expect(bySection.get('modality_developability')!.length).toBe(2); // tractability + safety
    // every derived claim cites the curated card id, never the literature PMID
    for (const claims of bySection.values()) {
      for (const c of claims) expect(c.citations[0]).not.toBe('PMID:123');
    }
    expect(bySection.get('disease_indications')![0].citations).toEqual(['ENSG1#expression']);
  });

  it('merges structured claims to the front of the matching section, de-duped', () => {
    const store = storeWith([{ id: 'ENSG1#expression', source: 'Open Targets', snippet: 'Highest normal expression in pancreas.' }]);
    const sections: Section[] = [{
      kind: 'research', id: 'disease_indications', title: 'Disease & Indications', takeaway: 't',
      claims: [{ id: 'c1', text: 'existing', citations: ['PMID:9'], confidence: 0.8 }], sources: [], rag: 'green',
    } as never];
    const merged = mergeStructuredClaims(sections, store);
    expect(merged[0].claims[0].citations).toEqual(['ENSG1#expression']);
    expect(merged[0].claims).toHaveLength(2);
  });

  it('is a no-op when no curated evidence is present', () => {
    const store = storeWith([{ id: 'PMID:1', source: 'Europe PMC', snippet: 'lit' }]);
    const sections: Section[] = [{ kind: 'research', id: 'target_biology', title: 'T', takeaway: 't', claims: [], sources: [], rag: 'green' } as never];
    expect(mergeStructuredClaims(sections, store)).toEqual(sections);
  });
});
