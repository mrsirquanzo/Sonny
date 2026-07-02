import { describe, it, expect } from 'vitest';
import type { Briefing, Evidence } from '@mrsirquanzo/sonny-shared';
import { toRunArtifacts } from './adapter.js';

const evidence: Evidence[] = [{
  id: 'PMID:1', kind: 'publication', source: 's', title: 'T', snippet: 'snip',
  passage: 'full passage', url: 'u', raw: {}, retrievedAt: 'now',
}];

const briefing: Briefing = {
  target: 'CDCP1',
  recommendation: {
    verdict: 'watch', thesis: 'th',
    bull: [{ point: 'good', citations: ['PMID:1'] }],
    bear: [{ point: 'bad', citations: [] }],
    conditions: ['c'],
  },
  executiveRead: 'exec',
  sections: [{ id: 'sec', title: 'Sec', takeaway: 't', claims: [{ id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 0.9 }], sources: ['PMID:1'], rag: 'amber' }],
  weighing: { takeaway: 'w', claims: [] },
  references: [],
  kolCluster: { target: 'CDCP1', labs: [{ investigator: 'Hooper JD', institution: 'UQ', paperCount: 3, weight: 1, evidenceIds: ['PMID:1'] }] },
};

describe('toRunArtifacts', () => {
  it('flattens recommendation.verdict and CasePoint bull/bear to the metrics shape', () => {
    const a = toRunArtifacts(briefing, evidence, [], 1234);
    expect(a.briefing.verdict).toBe('watch');
    expect(a.briefing.bull).toEqual(['good']);
    expect(a.briefing.bear).toEqual(['bad']);
    expect(a.briefing.executiveRead).toBe('exec');
    expect(a.elapsedMs).toBe(1234);
  });

  it('builds evidenceById with passages from the full evidence list', () => {
    const a = toRunArtifacts(briefing, evidence, [], 0);
    expect(a.evidenceById.get('PMID:1')?.passage).toBe('full passage');
  });

  it('maps kolCluster labs to investigator/institution', () => {
    const a = toRunArtifacts(briefing, evidence, [], 0);
    expect(a.briefing.kolCluster?.labs[0].investigator).toBe('Hooper JD');
  });
});
