import { describe, it, expect } from 'vitest';
import { clinicalTrialsTool } from './clinicalTrials.js';

const fakeFetch = (async () => new Response(JSON.stringify({ studies: [
  { protocolSection: { identificationModule: { nctId: 'NCT05983770', briefTitle: 'BESTOW' },
    statusModule: { overallStatus: 'COMPLETED' }, designModule: { phases: ['PHASE2'] } } },
] }), { status: 200 })) as unknown as typeof fetch;

describe('clinicalTrialsTool', () => {
  it('normalizes a study to canonical NCT evidence', async () => {
    const out = await clinicalTrialsTool.call({ query: 'CDCP1 cancer' }, fakeFetch);
    expect(out[0].id).toBe('NCT05983770');
    expect(out[0].kind).toBe('trial');
    expect(out[0].title).toBe('BESTOW');
    expect(out[0].snippet).toContain('PHASE2');
    expect(out[0].snippet).toContain('COMPLETED');
  });
});
