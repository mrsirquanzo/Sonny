import { describe, it, expect } from 'vitest';
import type { Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { targetTerms, relevanceGate, mentionsAny, titleMentionsTarget } from './relevance.js';

function pub(id: string, title: string, passage: string): Evidence {
  return { id, kind: 'publication', source: 's', title, snippet: '', passage, url: 'u', raw: {}, retrievedAt: 'now' };
}

describe('targetTerms', () => {
  it('includes the fallback symbol plus the seeded target approvedSymbol and synonyms (>= 3 chars), deduped and lowercased', () => {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1 - CUB domain containing protein 1',
      snippet: '', url: 'u', retrievedAt: 'now',
      raw: { approvedSymbol: 'CDCP1', synonyms: ['CD318', 'TRASK', 'AB'] } }); // 'AB' too short -> dropped
    const terms = targetTerms(store, 'CDCP1');
    expect(terms).toContain('cdcp1');
    expect(terms).toContain('cd318');
    expect(terms).toContain('trask');
    expect(terms).not.toContain('ab');
    expect(new Set(terms).size).toBe(terms.length); // deduped
  });

  it('falls back to just the symbol when no target record is seeded', () => {
    expect(targetTerms(new EvidenceStore(), 'EGFR')).toEqual(['egfr']);
  });

  it('returns [] when there is neither a fallback nor a seeded target', () => {
    expect(targetTerms(new EvidenceStore())).toEqual([]);
  });
});

describe('relevanceGate', () => {
  it('keeps hits that mention any term and drops the rest (case-insensitive)', () => {
    const hits = [
      pub('PMID:1', 'CDCP1 drives EMT', 'the CDCP1 receptor...'),
      pub('PMID:2', 'CD318 in pancreatic cancer', 'CD318 is targeted...'),
      pub('PMID:3', 'm6A RNA methylation review', 'METTL3 and FTO regulate...'), // off-topic
    ];
    const kept = relevanceGate(hits, ['cdcp1', 'cd318', 'trask']);
    expect(kept.map((h) => h.id)).toEqual(['PMID:1', 'PMID:2']); // PMID:3 dropped
  });

  it('returns hits unchanged when there are no terms', () => {
    const hits = [pub('PMID:9', 'anything', 'anything')];
    expect(relevanceGate(hits, [])).toEqual(hits);
  });
});

describe('mentionsAny', () => {
  it('returns true for a case-insensitive substring hit', () => {
    expect(mentionsAny('The CDCP1 receptor', ['cdcp1'])).toBe(true);
  });

  it('returns false when no term is present', () => {
    expect(mentionsAny('m6A RNA methylation', ['cdcp1', 'cd318'])).toBe(false);
  });

  it('returns true (no-op) when there are no terms', () => {
    expect(mentionsAny('anything at all', [])).toBe(true);
  });
});

describe('titleMentionsTarget', () => {
  const ev = (title: string, passage: string): Evidence =>
    ({ id: 'x', kind: 'publication', source: 's', title, snippet: '', passage, url: 'u', raw: {}, retrievedAt: 'now' });

  it('matches on the title only, ignoring passage and snippet', () => {
    expect(titleMentionsTarget(ev('CDCP1 in cancer', 'no mention here'), ['cdcp1'])).toBe(true);
    expect(titleMentionsTarget(ev('Generic proteomics', 'CDCP1 was detected'), ['cdcp1'])).toBe(false);
  });

  it('matches an alias in the title', () => {
    expect(titleMentionsTarget(ev('TRASK drives EMT', ''), ['cdcp1', 'trask'])).toBe(true);
  });

  it('returns true (no-op) when there are no terms', () => {
    expect(titleMentionsTarget(ev('whatever', ''), [])).toBe(true);
  });
});
