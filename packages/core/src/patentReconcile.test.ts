import { describe, it, expect } from 'vitest';
import { reconcilePatent } from './patentReconcile.js';
import type { ReconcileDeps } from './patentReconcile.js';
import type { ExtractedPatent } from './patentData.js';
import type { Evidence } from '@sonny/shared';
import type { PatentRecord, ConfirmInput, RegionConfirmation } from '@sonny/mcp-gateway';

const VH = 'EVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVSAISGSGGSTYYADSVKGRFTISRDNS'; // 74 aa, >= 50

function ev(raw: Record<string, unknown>, kind: Evidence['kind'] = 'dataset'): Evidence {
  return { id: `BLAST:${raw.accession}`, kind, source: 'NCBI BLAST', title: `hit ${raw.accession}`, snippet: '', url: 'u', raw, retrievedAt: 'now' };
}

const patentRecord: PatentRecord = {
  input: 'US10123456', normalized: 'US10123456', found: true,
  applicants: ['ACME BIO INC'], inventors: [], ipc: [], family: [],
};

function deps(spy?: { epoCalls: string[] }): ReconcileDeps {
  return {
    blast: async (_seq, db) => {
      if (db === 'nr') return [ev({ accession: 'NP_1', percentIdentity: 99, queryCoverage: 100, identity: 73, alignLen: 74, organism: 'Homo sapiens' })];
      return [
        ev({ accession: 'PAT_A', percentIdentity: 100, queryCoverage: 100, identity: 74, alignLen: 74, organism: '' }, 'patent'),
        ev({ accession: 'PAT_B', percentIdentity: 97, queryCoverage: 100, identity: 72, alignLen: 74, organism: '' }, 'patent'),
      ];
    },
    anarci: async (input: ConfirmInput): Promise<RegionConfirmation> => ({
      overallStatus: 'confirmed',
      domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: 'IGHV3-23', j: 'IGHJ4' }, numberedRegions: {} }],
      regionChecks: [], speciesSummary: [{ chain: 'H', species: 'homo_sapiens' }],
    }),
    epo: async (input: string) => { spy?.epoCalls.push(input); return patentRecord; },
  };
}

const extracted = (over: Partial<ExtractedPatent> = {}): ExtractedPatent => ({
  patentNumber: 'US10123456',
  sequences: [{ seqId: 1, residues: VH }],
  associations: [{ regionLabel: 'VH', seqId: 1 }],
  ...over,
});

describe('reconcilePatent', () => {
  it('BLASTs a >=50-residue VH against nr+pataa, filters pataa to >=98%, and attaches the ANARCI domain', async () => {
    const rec = await reconcilePatent(extracted(), deps());
    expect(rec.patent.found).toBe(true);
    const s = rec.sequences[0];
    expect(s.blasted).toBe(true);
    expect(s.regionLabels).toEqual(['VH']);
    expect(s.nrTopHit?.percentIdentity).toBe(99);
    expect(s.nrTopHit?.mismatchCount).toBe(1);        // 74 - 73
    expect(s.nrTopHit?.exactMatch).toBe(false);       // 99% -> delta surfaced, not collapsed
    expect(s.patentHits.map((h) => h.accession)).toEqual(['PAT_A']); // PAT_B (97%) filtered out
    expect(s.patentHits[0].exactMatch).toBe(true);
    expect(s.patentHits[0].mismatchCount).toBe(0);
    expect(s.domain).toEqual({ chain: 'H', species: 'homo_sapiens', numberedRegions: {} });
  });

  it('does not BLAST or number a sub-50-residue CDR', async () => {
    const rec = await reconcilePatent(
      extracted({ sequences: [{ seqId: 2, residues: 'GFTFSSYA' }], associations: [{ regionLabel: 'CDR-H1', seqId: 2 }] }),
      deps(),
    );
    const s = rec.sequences[0];
    expect(s.blasted).toBe(false);
    expect(s.nrTopHit).toBeUndefined();
    expect(s.patentHits).toEqual([]);
    expect(s.domain).toBeUndefined();
  });

  it('aggregates region labels per seqId', async () => {
    const rec = await reconcilePatent(
      extracted({ associations: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'heavy-chain', seqId: 1 }] }),
      deps(),
    );
    expect(rec.sequences[0].regionLabels).toEqual(['VH', 'heavy-chain']);
  });

  it('does not call EPO and reports found:false when there is no patent number', async () => {
    const spy = { epoCalls: [] as string[] };
    const rec = await reconcilePatent(extracted({ patentNumber: null }), deps(spy));
    expect(spy.epoCalls).toEqual([]);
    expect(rec.patent.found).toBe(false);
    expect(rec.patent.error).toMatch(/EPO_NO_NUMBER/);
  });

  it('does not mark exactMatch when percentIdentity rounds to 100 but mismatchCount is 1', async () => {
    // A 2000-aa alignment with 1999 matches: percentIdentity = 99.95, which blast_verify rounds to 100.0
    // exactMatch must be derived from the exact counts, not the rounded percentage.
    const mismatchDeps: ReconcileDeps = {
      blast: async (_seq, db) => {
        if (db === 'nr') return [ev({ accession: 'NP_ROUND', percentIdentity: 100, queryCoverage: 100, identity: 1999, alignLen: 2000, organism: 'Homo sapiens' })];
        return [];
      },
      anarci: deps().anarci,
      epo: deps().epo,
    };
    const longSeq = 'A'.repeat(200); // >=50 so it gets BLASTed
    const rec = await reconcilePatent(
      extracted({ sequences: [{ seqId: 1, residues: longSeq }], associations: [{ regionLabel: 'VH', seqId: 1 }] }),
      mismatchDeps,
    );
    const hit = rec.sequences[0].nrTopHit;
    expect(hit?.mismatchCount).toBe(1);   // 2000 - 1999
    expect(hit?.exactMatch).toBe(false);  // delta surfaced, not collapsed
  });

  it('assembles soft tool failures without throwing', async () => {
    const rec = await reconcilePatent(extracted(), {
      blast: async () => [],
      anarci: async () => ({ overallStatus: 'anarci_unavailable', domains: [], regionChecks: [], speciesSummary: [] }),
      epo: async () => ({ input: 'US10123456', found: false, applicants: [], inventors: [], ipc: [], family: [], error: 'EPO_NETWORK_ERROR: down' }),
    });
    const s = rec.sequences[0];
    expect(rec.patent.found).toBe(false);
    expect(s.nrTopHit).toBeUndefined();
    expect(s.patentHits).toEqual([]);
    expect(s.domain).toBeUndefined();
  });
});
