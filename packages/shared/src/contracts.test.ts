import { describe, it, expect } from 'vitest';
import { ClaimSchema, ClaimsSchema, EvidenceSchema, VerdictSchema } from './contracts.js';

describe('contracts', () => {
  it('accepts a valid evidence record', () => {
    const e = { id: 'ENSG00000146648', kind: 'target', source: 'Open Targets',
      title: 'EGFR', snippet: 'receptor tyrosine kinase', url: 'https://x', raw: {}, retrievedAt: '2026-06-27T00:00:00Z' };
    expect(EvidenceSchema.parse(e).id).toBe('ENSG00000146648');
  });

  it('rejects a claim with no citations array', () => {
    expect(() => ClaimSchema.parse({ id: 'c1', text: 'x', confidence: 0.5 })).toThrow();
  });

  it('parses a claims envelope', () => {
    const parsed = ClaimsSchema.parse({ claims: [{ id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 0.9 }] });
    expect(parsed.claims).toHaveLength(1);
  });

  it('constrains verdict status', () => {
    expect(() => VerdictSchema.parse({ claimId: 'c1', status: 'maybe', rationale: 'r' })).toThrow();
  });
});
