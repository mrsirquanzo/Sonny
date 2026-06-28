import { describe, it, expect } from 'vitest';
import type { Claim, Verdict } from '@sonny/shared';
import { computeRag } from './rag.js';

const claim = (id: string, cites: string[]): Claim => ({ id, text: 'x', citations: cites, confidence: 0.9 });
const v = (id: string, status: Verdict['status']): Verdict => ({ claimId: id, status, rationale: '' });

describe('computeRag', () => {
  it('red when nothing shipped', () => { expect(computeRag([], [])).toBe('red'); });
  it('red when no supported verdicts', () => {
    expect(computeRag([claim('c1', ['A'])], [v('c1', 'overreach')])).toBe('red');
  });
  it('green when all supported with >=2 sources', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['B'])], [v('c1', 'supported'), v('c2', 'supported')])).toBe('green');
  });
  it('amber when supported but only one source', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['A'])], [v('c1', 'supported'), v('c2', 'supported')])).toBe('amber');
  });
  it('amber when mixed verdicts', () => {
    expect(computeRag([claim('c1', ['A']), claim('c2', ['B'])], [v('c1', 'supported'), v('c2', 'overreach')])).toBe('amber');
  });
});
