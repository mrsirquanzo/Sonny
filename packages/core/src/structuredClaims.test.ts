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
    // Assert by citation, not by count. Counting let a routing swap through
    // silently once already: moving #tractability off this axis and #expression
    // onto it left the length at 2 while the contents changed completely.
    const cited = (section: string): string[] =>
      (bySection.get(section) ?? []).flatMap((c) => c.citations).sort();

    expect(cited('target_biology')).toEqual(['ENSG1#localization', 'UNIPROT:Q1#localization']);
    expect(cited('disease_indications')).toEqual(['ENSG1#expression']);
    expect(cited('modality_developability')).toEqual(['ENSG1#expression', 'ENSG1#safety']);
    // every derived claim cites the curated card id, never the literature PMID
    for (const claims of bySection.values()) {
      for (const c of claims) expect(c.citations[0]).not.toBe('PMID:123');
    }
  });

  // Spec 7.3 is normative and multi-destination. `ROUTES.find` returned the
  // first match, so a card reached exactly one axis - which is how the fact
  // grounding on-target/off-tumour liability never reached the developability
  // reviewer.
  it('routes each curated card to every axis spec 7.3 assigns it', () => {
    const store = storeWith([
      { id: 'ENSG1#domains', source: 'Open Targets', snippet: 'Extracellular CUB domains.' },
      { id: 'ENSG1#localization', source: 'Open Targets', snippet: 'A plasma-membrane annotation is present.' },
      { id: 'ENSG1#expression', source: 'Open Targets', snippet: 'Protein expression in normal lung.' },
      { id: 'ENSG1#tractability', source: 'Open Targets', snippet: 'Tractability buckets by modality.' },
      { id: 'ENSG1#safety', source: 'Open Targets', snippet: 'A curated safety liability.' },
    ]);
    const bySection = deriveStructuredClaims(store);
    const cited = (section: string): string[] =>
      (bySection.get(section) ?? []).flatMap((c) => c.citations).sort();

    expect(cited('target_biology')).toEqual(['ENSG1#domains', 'ENSG1#localization']);
    expect(cited('moa_pathway')).toEqual(['ENSG1#localization', 'ENSG1#tractability']);
    expect(cited('disease_indications')).toEqual(['ENSG1#expression']);
    // The one that regressed developability_catch to zero.
    expect(cited('modality_developability')).toEqual(['ENSG1#expression', 'ENSG1#safety']);
    // Tractability is mechanistic feasibility; Q6 owns liability, not feasibility.
    expect(cited('modality_developability')).not.toContain('ENSG1#tractability');
  });

  it('gives a multi-routed card a distinct claim id per destination', () => {
    const store = storeWith([
      { id: 'ENSG1#expression', source: 'Open Targets', snippet: 'Protein expression in normal lung.' },
    ]);
    const bySection = deriveStructuredClaims(store);
    const q3 = bySection.get('disease_indications')![0];
    const q6 = bySection.get('modality_developability')![0];
    // Same evidence, same text, different claim id: a shared id collides
    // wherever claims are keyed by id, and consolidation would drop the second
    // copy as a duplicate of the first.
    expect(q3.citations).toEqual(q6.citations);
    expect(q3.text).toBe(q6.text);
    expect(q3.id).not.toBe(q6.id);
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

  it('marks derived claims as deterministic provenance', () => {
    const store = storeWith([{ id: 'ENSG1#expression', source: 'Open Targets', snippet: 'Highest normal expression in pancreas.' }]);
    const claims = deriveStructuredClaims(store).get('disease_indications')!;
    expect(claims[0].provenance).toBe('deterministic');
  });

  it('adds the merged card ids to section.sources', () => {
    const store = storeWith([{ id: 'ENSG1#expression', source: 'Open Targets', snippet: 'Highest normal expression in pancreas.' }]);
    const sections: Section[] = [{
      kind: 'research', id: 'disease_indications', title: 'D', takeaway: 't',
      claims: [{ id: 'c1', text: 'existing', citations: ['PMID:9'], confidence: 0.8 }], sources: ['PMID:9'], rag: 'amber',
    } as never];
    const merged = mergeStructuredClaims(sections, store);
    // The curated card is now a shipped source, not an invisible claim citation.
    expect(merged[0].sources).toContain('ENSG1#expression');
    expect(merged[0].sources).toContain('PMID:9');
  });

  it('recomputes rag over the shipped claim set, not the pre-merge one', () => {
    // One literature claim (PMID:9) and one curated card (ENSG1#expression) =
    // two independent sources, so the shipped set is green. Pre-merge rag was
    // amber because it never saw the card.
    const store = storeWith([{ id: 'ENSG1#expression', source: 'Open Targets', snippet: 'Highest normal expression in pancreas.' }]);
    const sections: Section[] = [{
      kind: 'research', id: 'disease_indications', title: 'D', takeaway: 't',
      claims: [{ id: 'c1', text: 'existing', citations: ['PMID:9'], confidence: 0.8 }], sources: ['PMID:9'], rag: 'amber',
    } as never];
    const merged = mergeStructuredClaims(sections, store);
    expect(merged[0].rag).toBe('green');
  });
});
