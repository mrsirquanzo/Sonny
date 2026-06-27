import { describe, it, expect } from 'vitest';
import type { Claim, Verdict } from '@sonny/shared';
import { recallAtK, faithfulness } from './score.js';

describe('eval metrics', () => {
  it('recallAtK = fraction of expected ids retrieved', () => {
    expect(recallAtK(['ENSG00000146648', 'PMID:1'], ['ENSG00000146648'])).toBe(1);
    expect(recallAtK(['PMID:1'], ['ENSG00000146648'])).toBe(0);
  });

  it('faithfulness = fraction of shipped claims verified supported', () => {
    const shipped: Claim[] = [
      { id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 1 },
      { id: 'c2', text: 'y', citations: ['PMID:2'], confidence: 1 }
    ];
    const verdicts: Verdict[] = [
      { claimId: 'c1', status: 'supported', rationale: '' },
      { claimId: 'c2', status: 'overreach', rationale: '' }
    ];
    expect(faithfulness(shipped, verdicts)).toBe(0.5);
  });

  it('faithfulness is 1 when there are no shipped claims (vacuous)', () => {
    expect(faithfulness([], [])).toBe(1);
  });
});
