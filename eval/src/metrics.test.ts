import { describe, it, expect } from 'vitest';
import {
  groundingIntegrity, retrievalRecall, verdictInBand, verdictStability,
  makeJudge, figureGrounding, type RunArtifacts, type StructuredModelLike,
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

function figArtifacts(claims: { text: string; citations: string[] }[], figureReadings: any[]): RunArtifacts {
  return {
    briefing: { verdict: 'watch', sections: [{ id: 's', claims: claims.map((c, i) => ({ id: `c${i}`, ...c })) }] },
    evidenceById: new Map(), elapsedMs: 0, figureReadings,
  } as unknown as RunArtifacts;
}

const lowReading = { evidenceId: 'PMCID:P#fig-0', reading: 'r', confidence: 0.8, extractedValues: [{ label: 'HR', value: '0.62', inCaption: true, readRisk: 'low' }] };
const highReading = { evidenceId: 'PMCID:P#fig-1', reading: 'r', confidence: 0.8, extractedValues: [{ label: 'HR', value: '0.41', inCaption: false, readRisk: 'high' }] };

describe('figureGrounding', () => {
  it('is not gated (pass) when n < 3, reporting the denominator', () => {
    const a = figArtifacts([{ text: 'HR 0.62', citations: ['PMCID:P#fig-0'] }], [lowReading]);
    const m = figureGrounding(a);
    expect((m.detail as any).n).toBe(1);
    expect(m.pass).toBe(true);
  });

  it('scores fraction caption-anchored and fails below the floor when gated (n>=3)', () => {
    const a = figArtifacts([
      { text: 'a', citations: ['PMCID:P#fig-1'] },
      { text: 'b', citations: ['PMCID:P#fig-1'] },
      { text: 'c', citations: ['PMCID:P#fig-1'] },
      { text: 'd', citations: ['PMCID:P#fig-0'] },
    ], [lowReading, highReading]);
    const m = figureGrounding(a);
    expect((m.detail as any).n).toBe(4);
    expect(m.score).toBeCloseTo(0.25, 5); // only the fig-0 claim is anchored
    expect(m.pass).toBe(false);           // 0.25 < 0.5 floor
  });

  it('ignores non-figure claims (returns 1.0 when no figure claims)', () => {
    const a = figArtifacts([{ text: 'x', citations: ['PMID:1'] }], []);
    expect(figureGrounding(a).score).toBe(1);
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
