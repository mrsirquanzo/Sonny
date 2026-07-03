import { describe, it, expect } from 'vitest';
import {
  groundingIntegrity, retrievalRecall, verdictInBand, verdictStability,
  makeJudge, type RunArtifacts, type StructuredModelLike,
} from './metrics.js';
import { GoldenTarget } from './goldenSet.js';

const target = GoldenTarget.parse({
  target: 'CDCP1', label: 'watch', allowedVerdicts: ['watch', 'go'], rationale: 'r',
  seminalPmids: ['23208492'], curator: 'c', curatedAt: '2026-07-02',
});

function artifacts(over: Partial<RunArtifacts> = {}): RunArtifacts {
  return {
    briefing: {
      verdict: 'watch',
      sections: [{ id: 's', claims: [{ id: 'c1', text: 'x', citations: ['PMID:23208492'] }] }],
    },
    evidenceById: new Map([['PMID:23208492', { id: 'PMID:23208492', passage: 'CDCP1 is cleaved.' }]]),
    elapsedMs: 100,
    ...over,
  } as RunArtifacts;
}

describe('deterministic metrics', () => {
  it('groundingIntegrity is 1.0 when every claim citation resolves', () => {
    expect(groundingIntegrity(artifacts()).score).toBe(1);
  });

  it('groundingIntegrity flags an unresolvable citation', () => {
    const a = artifacts({
      briefing: { verdict: 'watch', sections: [{ id: 's', claims: [{ id: 'c1', text: 'x', citations: ['PMID:999'] }] }] } as any,
    });
    const m = groundingIntegrity(a);
    expect(m.score).toBe(0);
    expect(m.pass).toBe(false);
  });

  it('retrievalRecall measures gold PMIDs pulled into the store', () => {
    expect(retrievalRecall(artifacts(), target).score).toBe(1);
    const empty = artifacts({ evidenceById: new Map() });
    expect(retrievalRecall(empty, target).score).toBe(0);
  });

  it('verdictInBand passes inside the band and fails outside', () => {
    expect(verdictInBand(artifacts(), target).pass).toBe(true);
    expect(verdictInBand(artifacts({ briefing: { verdict: 'no-go', sections: [] } as any }), target).pass).toBe(false);
  });

  it('verdictStability reports flip rate across repeats', () => {
    expect(verdictStability(['watch', 'watch', 'watch']).score).toBe(1);
    expect(verdictStability(['watch', 'go', 'watch']).pass).toBe(false);
  });
});

describe('judge metrics (decorrelated stub)', () => {
  const stub: StructuredModelLike = {
    async generateStructured() { return { verdict: 'supported', rationale: 'ok' } as any; },
  };
  it('faithfulness scores supported claims from the judge', async () => {
    const judge = makeJudge(stub);
    const m = await judge.faithfulness(artifacts());
    expect(m.score).toBe(1);
    expect(m.pass).toBe(true);
  });
});
