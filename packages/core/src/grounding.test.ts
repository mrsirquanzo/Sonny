import { describe, it, expect } from 'vitest';
import type { Claim, Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';

const ev = (id: string): Evidence => ({ id, kind: 'publication', source: 'PubMed', title: 't', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' });
const claim = (id: string, citations: string[]): Claim => ({ id, text: 'x', citations, confidence: 0.9 });

describe('groundClaims', () => {
  it('ships a claim whose citations all resolve', () => {
    const s = new EvidenceStore(); s.register(ev('PMID:1'));
    const r = groundClaims([claim('c1', ['PMID:1'])], s);
    expect(r.shippable).toHaveLength(1);
  });
  it('strips a claim with no citations', () => {
    const r = groundClaims([claim('c1', [])], new EvidenceStore());
    expect(r.shippable).toHaveLength(0);
    expect(r.stripped[0].reason).toMatch(/no citation/i);
  });
  it('strips a claim citing an unknown id', () => {
    const r = groundClaims([claim('c1', ['PMID:999'])], new EvidenceStore());
    expect(r.stripped[0].reason).toMatch(/does not resolve/i);
  });
});
