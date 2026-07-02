import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPatentPipeline, gotConstructs, gotCompetitorOverlaps } from './patentPipeline.js';
import { extractionRecall, residueFidelity, setRecall, speciesAccuracy, pairingAccuracy, competitorRecall } from './goldenPatent.js';
import type { GoldenPatent } from './goldenPatent.js';
import type { StructuredModel, ReconcileDeps } from '@sonny/core';
import type { Evidence } from '@sonny/shared';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../golden/synthetic-antibody.json', import.meta.url)), 'utf8')) as GoldenPatent;

// A >=50-residue VH and a >=50-residue VL, matching the golden known sequences.
const VH = 'EVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVSAISGSGGSTYYADSVKG';
const VL = 'DIQMTQSPSSLSASVGDRVTITCRASQSISSYLNWYQQKPGKAPKLLIYAASSLQSGVPSRFSGSG';

const markdown = [
  'Patent US 10,123,456 B2', 'Claims',
  '1. An antibody comprising VH of SEQ ID NO: 1 and VL of SEQ ID NO: 2.',
  '', 'SEQ ID NO: 1', VH, '', 'SEQ ID NO: 2', VL, '',
].join('\n');

const model: StructuredModel = {
  async generateStructured(opts: { system: string }) {
    if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }] } as never;
    if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }] }] } as never;
    return { summary: 'ACME BIO INC owns a human-like antibody.', points: [] } as never;
  },
};

function ev(raw: Record<string, unknown>, kind: Evidence['kind']): Evidence {
  return { id: `BLAST:${raw.accession}`, kind, source: 'blast', title: 'hit', snippet: '', url: '', raw, retrievedAt: '' };
}

const reconcileDeps: ReconcileDeps = {
  blast: async (_seq, db) => db === 'pataa'
    ? [ev({ accession: 'PAT_COMP', percentIdentity: 100, queryCoverage: 100, identity: 66, alignLen: 66, organism: '' }, 'patent')]
    : [ev({ accession: 'NP_1', percentIdentity: 99, queryCoverage: 100, identity: 65, alignLen: 66, organism: 'Homo sapiens' }, 'dataset')],
  anarci: async (input) => ({
    overallStatus: 'confirmed',
    domains: [{ chain: input.vh ? 'H' : 'K', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: {} }],
    regionChecks: [], speciesSummary: [],
  }),
  epo: async () => ({ input: 'US10123456', normalized: 'US10123456', found: true, applicants: ['ACME BIO INC'], inventors: [], ipc: [], family: [{ country: 'EP', number: '1234567', status: 'active', events: [] }] }),
};

import { gotCompetitorOverlaps } from './patentPipeline.js';
import type { PatentWorkup } from '@sonny/core';

describe('gotCompetitorOverlaps level', () => {
  it('derives cdr vs whole from edge provenance', () => {
    const wk = { graph: [
      { subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_W', provenance: 'blast-pataa', confidence: 'verified' },
      { subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_C', provenance: 'blast-cdr-h3', confidence: 'claimed' },
    ] } as unknown as PatentWorkup;
    const got = gotCompetitorOverlaps(wk);
    expect(got).toContainEqual({ seqId: 1, competitorAccession: 'PAT_W', level: 'whole' });
    expect(got).toContainEqual({ seqId: 1, competitorAccession: 'PAT_C', level: 'cdr' });
  });
});

describe('offline patent pipeline eval', () => {
  it('scores a synthetic golden patent above threshold, including the competitor MATCHES edge (5b regression insurance)', async () => {
    const workup = await runPatentPipeline(markdown, { model, reconcileDeps });

    const foundIds = workup.constructs.flatMap((c) => c.regions.map((r) => r.seqId)).concat(workup.ungrouped.map((s) => s.seqId));
    const extracted = [...workup.constructs.flatMap((c) => c.regions.map((r) => ({ seqId: r.seqId, residues: r.residues }))),
      ...workup.ungrouped.map((s) => ({ seqId: s.seqId, residues: s.residues }))];

    expect(extractionRecall(foundIds, golden.declaredSequenceCount)).toBe(1);
    expect(residueFidelity(extracted, golden.knownSequences)).toBe(1);
    expect(setRecall(workup.patent.applicants, golden.expectedAssignees)).toBe(1);
    expect(speciesAccuracy(gotConstructs(workup), golden.expectedConstructs)).toBe(1);
    expect(pairingAccuracy(gotConstructs(workup), golden.expectedConstructs)).toBe(1);
    // The 5b insurance: a real competitor pataa hit must surface as a MATCHES overlap end to end.
    expect(competitorRecall(gotCompetitorOverlaps(workup), golden.expectedCompetitorOverlaps, 'whole')).toBe(1);
  });
});
