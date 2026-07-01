import { describe, it, expect } from 'vitest';
import type { Evidence } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from './evidenceStore.js';

const ev = (id: string): Evidence => ({
  id, kind: 'publication', source: 'PubMed', title: 't', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now',
});

describe('EvidenceStore', () => {
  it('registers and retrieves by id', () => {
    const s = new EvidenceStore();
    s.register(ev('PMID:1'));
    expect(s.has('PMID:1')).toBe(true);
    expect(s.get('PMID:1')?.id).toBe('PMID:1');
  });

  it('dedupes by id (first write wins)', () => {
    const s = new EvidenceStore();
    s.register({ ...ev('PMID:1'), title: 'first' });
    s.register({ ...ev('PMID:1'), title: 'second' });
    expect(s.all()).toHaveLength(1);
    expect(s.get('PMID:1')?.title).toBe('first');
  });
});
