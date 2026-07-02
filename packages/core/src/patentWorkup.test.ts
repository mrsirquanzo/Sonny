import { describe, it, expect } from 'vitest';
import { groupConstructs, buildWorkup, synthesizeCompetitiveIP, graphRelationships } from './patentWorkup.js';
import type { StructuredModel } from './model.js';
import type { RegionAssociation, ExtractedPatent } from './patentData.js';
import type { PatentReconciliation, VerifiedSequence } from './patentReconcile.js';
import type { PatentWorkup } from './patentWorkup.js';

function model(constructs: unknown): StructuredModel {
  return { async generateStructured() { return { constructs } as never; } };
}

const associations: RegionAssociation[] = [
  { regionLabel: 'VH', seqId: 1 },
  { regionLabel: 'VL', seqId: 2 },
  { regionLabel: 'CDR-H1', seqId: 3 },
];

describe('groupConstructs', () => {
  it('groups members and drops members with unknown SEQ-IDs (grounding)', async () => {
    const out = await groupConstructs('Claims\n...', associations, model([
      { name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }, { regionLabel: 'CDR-H1', seqId: 99 }] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Ab1');
    expect(out[0].members.map((m) => m.seqId)).toEqual([1, 2]); // seqId 99 not in associations -> dropped
  });

  it('drops a construct left with no known members', async () => {
    const out = await groupConstructs('c', associations, model([{ name: 'Ghost', members: [{ regionLabel: 'VH', seqId: 42 }] }]));
    expect(out).toEqual([]);
  });

  it('returns [] when the model throws', async () => {
    const throwing: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    expect(await groupConstructs('c', associations, throwing)).toEqual([]);
  });
});

function vseq(over: Partial<VerifiedSequence> & { seqId: number; residues: string }): VerifiedSequence {
  return { regionLabels: [], length: over.residues.length, blasted: false, patentHits: [], ...over };
}

const extractedP: ExtractedPatent = { patentNumber: 'US10123456', sequences: [], associations: [] };

function recon(sequences: VerifiedSequence[]): PatentReconciliation {
  return { patent: { input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }, sequences };
}

describe('buildWorkup', () => {
  it('confirms a CDR that matches the VH derived region and flags a mismatch', () => {
    const vh = vseq({
      seqId: 1, residues: 'EVQLVES', regionLabels: ['VH'],
      domain: { chain: 'H', species: 'homo_sapiens', numberedRegions: { 'CDR-H1': { seq: 'GFS', imgtStart: 27, imgtEnd: 38, residues: [] } } },
    });
    const cdrOk = vseq({ seqId: 3, residues: 'GFS', regionLabels: ['CDR-H1'] });
    const cdrBad = vseq({ seqId: 4, residues: 'GFT', regionLabels: ['CDR-H1'] });
    const wk = buildWorkup(extractedP, recon([vh, cdrOk, cdrBad]), [
      { name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'CDR-H1', seqId: 3 }] },
      { name: 'Ab2', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'CDR-H1', seqId: 4 }] },
    ]);
    expect(wk.constructs[0].regions.find((r) => r.seqId === 3)?.cdrConfirmation).toBe('confirmed');
    expect(wk.constructs[1].regions.find((r) => r.seqId === 4)?.cdrConfirmation).toBe('mismatch');
  });

  it('reports no_anchor for a CDR whose construct has no VH domain', () => {
    const cdr = vseq({ seqId: 5, residues: 'GFS', regionLabels: ['CDR-H1'] });
    const wk = buildWorkup(extractedP, recon([cdr]), [{ name: 'Ab', members: [{ regionLabel: 'CDR-H1', seqId: 5 }] }]);
    expect(wk.constructs[0].regions[0].cdrConfirmation).toBe('no_anchor');
  });

  it('classifies species: human variable + human constant -> human-like; murine variable + human constant -> chimeric', () => {
    const humanVh = vseq({ seqId: 1, residues: 'E'.repeat(60), regionLabels: ['VH'], domain: { chain: 'H', species: 'homo_sapiens', numberedRegions: {} } });
    const humanFc = vseq({ seqId: 2, residues: 'F'.repeat(60), regionLabels: ['Fc'], nrTopHit: { database: 'nr', accession: 'x', title: 't', percentIdentity: 100, queryCoverage: 100, mismatchCount: 0, exactMatch: true, organism: 'Homo sapiens' } });
    const wkHuman = buildWorkup(extractedP, recon([humanVh, humanFc]), [{ name: 'H', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'Fc', seqId: 2 }] }]);
    expect(wkHuman.constructs[0].species.classification).toBe('human-like');

    const mouseVh = vseq({ seqId: 3, residues: 'E'.repeat(60), regionLabels: ['VH'], domain: { chain: 'H', species: 'mus_musculus', numberedRegions: {} } });
    const wkChimeric = buildWorkup(extractedP, recon([mouseVh, humanFc]), [{ name: 'C', members: [{ regionLabel: 'VH', seqId: 3 }, { regionLabel: 'Fc', seqId: 2 }] }]);
    expect(wkChimeric.constructs[0].species.classification).toBe('chimeric');
  });

  it('puts sequences assigned to no construct into ungrouped', () => {
    const a = vseq({ seqId: 1, residues: 'AAAA', regionLabels: ['VH'] });
    const orphan = vseq({ seqId: 9, residues: 'BBBB' });
    const wk = buildWorkup(extractedP, recon([a, orphan]), [{ name: 'Ab', members: [{ regionLabel: 'VH', seqId: 1 }] }]);
    expect(wk.ungrouped.map((s) => s.seqId)).toEqual([9]);
  });
});

const baseWorkup: PatentWorkup = {
  patentNumber: 'US10123456',
  patent: { input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] },
  constructs: [{ name: 'Ab1', regions: [{ regionLabel: 'VH', seqId: 1, residues: 'E' }], species: { classification: 'human-like', evidence: '' } }],
  ungrouped: [],
  narrative: { summary: '', points: [] },
  graph: [],
};

describe('synthesizeCompetitiveIP', () => {
  it('keeps only citations that reference known SEQ-IDs or accessions', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return { summary: 'ACME owns one human-like antibody.', points: [
          { point: 'VH is disclosed', citations: ['SEQ:1', 'SEQ:999'] },
        ] } as never;
      },
    };
    const ip = await synthesizeCompetitiveIP(baseWorkup, model);
    expect(ip.summary).toContain('ACME');
    expect(ip.points[0].citations).toEqual(['SEQ:1']); // SEQ:999 unknown -> dropped
  });

  it('returns an empty narrative when the model throws', async () => {
    const throwing: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    const ip = await synthesizeCompetitiveIP(baseWorkup, throwing);
    expect(ip.points).toEqual([]);
    expect(ip.summary).toMatch(/unavailable/i);
  });
});

describe('graphRelationships', () => {
  it('emits OWNED_BY, DISCLOSES, HAS_REGION, and MATCHES edges with provenance and confidence', () => {
    const wk: PatentWorkup = {
      patentNumber: 'US10123456',
      patent: { input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] },
      constructs: [{
        name: 'Ab1',
        regions: [{
          regionLabel: 'VH', seqId: 1, residues: 'E',
          patentMatches: [{ database: 'pataa', accession: 'PAT_A', title: 't', percentIdentity: 100, queryCoverage: 100, mismatchCount: 0, exactMatch: true, organism: '' }],
        }],
        species: { classification: 'human-like', evidence: '' },
      }],
      ungrouped: [],
      narrative: { summary: '', points: [] },
      graph: [],
    };
    const g = graphRelationships(wk);
    expect(g).toContainEqual({ subject: 'US10123456', predicate: 'OWNED_BY', object: 'ACME', provenance: 'epo-assignee', confidence: 'verified' });
    expect(g).toContainEqual({ subject: 'US10123456', predicate: 'DISCLOSES', object: 'SEQ:1', provenance: 'patent-listing', confidence: 'claimed' });
    expect(g).toContainEqual({ subject: 'Ab1', predicate: 'HAS_REGION', object: 'SEQ:1', provenance: 'claims-grouping', confidence: 'claimed' });
    expect(g).toContainEqual({ subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_A', provenance: 'blast-pataa', confidence: 'verified' });
  });
});

describe('pairing gate and non-antibody classification', () => {
  function vh(seqId: number, chain: 'H' | 'K' | 'L') {
    return vseq({ seqId, residues: 'E'.repeat(60), regionLabels: [chain === 'H' ? 'VH' : 'VL'], domain: { chain, species: 'homo_sapiens', numberedRegions: {} } });
  }

  it('sets no pairingWarning for a complementary heavy+light construct and disclosureShape antibody', () => {
    const wk = buildWorkup(extractedP, recon([vh(1, 'H'), vh(2, 'K')]),
      [{ name: 'Ab', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }] }]);
    expect(wk.constructs[0].pairingWarning).toBeUndefined();
    expect(wk.disclosureShape).toBe('antibody');
  });

  it('flags two heavy chains and a lone heavy chain', () => {
    const twoH = buildWorkup(extractedP, recon([vh(1, 'H'), vh(2, 'H')]),
      [{ name: 'AbHH', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VH', seqId: 2 }] }]);
    expect(twoH.constructs[0].pairingWarning).toBeTruthy();

    const lone = buildWorkup(extractedP, recon([vh(1, 'H')]), [{ name: 'AbH', members: [{ regionLabel: 'VH', seqId: 1 }] }]);
    expect(lone.constructs[0].pairingWarning).toBeTruthy();
  });

  it('classifies a disclosure with no numbered variable domain as not-standard-antibody', () => {
    const noDomain = vseq({ seqId: 1, residues: 'AAAA', regionLabels: ['Fc'] });
    const wk = buildWorkup(extractedP, recon([noDomain]), [{ name: 'X', members: [{ regionLabel: 'Fc', seqId: 1 }] }]);
    expect(wk.disclosureShape).toBe('not-standard-antibody');
  });

  it('classifies empty constructs list as not-standard-antibody', () => {
    expect(buildWorkup(extractedP, recon([]), []).disclosureShape).toBe('not-standard-antibody');
  });

  it('does not double-count chains when CDR members share the parent VH/VL seqId', () => {
    // CDR-H1 and CDR-H2 point at seqId 1 (same as VH); CDR-L1 points at seqId 2 (same as VL).
    // Without dedup this yields heavy=3, light=2 and falsely flags the construct.
    const wk = buildWorkup(
      extractedP,
      recon([vh(1, 'H'), vh(2, 'K')]),
      [{
        name: 'Ab',
        members: [
          { regionLabel: 'VH', seqId: 1 },
          { regionLabel: 'CDR-H1', seqId: 1 },
          { regionLabel: 'CDR-H2', seqId: 1 },
          { regionLabel: 'VL', seqId: 2 },
          { regionLabel: 'CDR-L1', seqId: 2 },
        ],
      }],
    );
    expect(wk.constructs[0].pairingWarning).toBeUndefined();
  });
});

import { matchCdrCompetitors } from './patentWorkup.js';
import type { PatentReconciliation, VerifiedSequence } from './patentReconcile.js';
import type { Evidence } from '@sonny/shared';

function evH(raw: Record<string, unknown>): Evidence {
  return { id: `BLAST:${raw.accession}`, kind: 'patent', source: 'blast', title: 'hit', snippet: '', url: '', raw, retrievedAt: '' };
}

function reconWithVh(cdrh3: string): PatentReconciliation {
  const vh: VerifiedSequence = {
    seqId: 1, residues: 'E'.repeat(60), regionLabels: ['VH'], length: 60, blasted: true, patentHits: [],
    domain: { chain: 'H', species: 'homo_sapiens', numberedRegions: { 'CDR-H3': { seq: cdrh3, imgtStart: 105, imgtEnd: 117, residues: [] } } },
  };
  return { patent: { input: 'US1', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }, sequences: [vh] };
}

describe('matchCdrCompetitors', () => {
  const workupWith = () => ({
    patentNumber: 'US1', patent: { input: 'US1', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] },
    constructs: [{ name: 'Ab1', regions: [{ regionLabel: 'VH' as const, seqId: 1, residues: 'E'.repeat(60) }], species: { classification: 'human-like' as const, evidence: '' } }],
    ungrouped: [], narrative: { summary: '', points: [] }, graph: [],
  });

  it('BLASTs the derived CDR-H3 against pataa with short-query opts and keeps >=90% hits', async () => {
    const calls: Array<{ seq: string; db: string; opts: unknown }> = [];
    const blast = async (seq: string, db: string, opts?: unknown) => {
      calls.push({ seq, db, opts });
      return [evH({ accession: 'PAT_CDR', percentIdentity: 100, queryCoverage: 100, identity: 12, alignLen: 12, organism: '' }),
        evH({ accession: 'PAT_LOW', percentIdentity: 85, queryCoverage: 100, identity: 10, alignLen: 12, organism: '' })];
    };
    const wk = workupWith();
    await matchCdrCompetitors(wk, reconWithVh('ARDYYGSSYFDY'), blast);
    expect(calls[0].seq).toBe('ARDYYGSSYFDY');
    expect(calls[0].db).toBe('pataa');
    expect(calls[0].opts).toMatchObject({ wordSize: 2, matrix: 'PAM30' });
    expect(wk.constructs[0].cdrCompetitors?.map((h) => h.accession)).toEqual(['PAT_CDR']); // PAT_LOW 85% dropped
  });

  it('does not BLAST when the VH has no derived CDR-H3, and never throws on a blast failure', async () => {
    const wk = workupWith();
    await matchCdrCompetitors(wk, { patent: reconWithVh('X').patent, sequences: [{ seqId: 1, residues: 'E'.repeat(60), regionLabels: ['VH'], length: 60, blasted: true, patentHits: [] }] }, async () => { throw new Error('x'); });
    expect(wk.constructs[0].cdrCompetitors ?? []).toEqual([]);
  });

  it('graphRelationships emits a cdr-level MATCHES edge keyed on the VH SEQ with provenance blast-cdr-h3', () => {
    const wk = workupWith();
    wk.constructs[0].cdrCompetitors = [{ database: 'pataa', accession: 'PAT_CDR', title: 't', percentIdentity: 100, queryCoverage: 100, mismatchCount: 0, exactMatch: true, organism: '' }];
    const g = graphRelationships(wk as never);
    expect(g).toContainEqual({ subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_CDR', provenance: 'blast-cdr-h3', confidence: 'claimed' });
  });

  it('never throws and leaves cdrCompetitors empty when the blast call itself fails', async () => {
    const wk = workupWith();
    await expect(matchCdrCompetitors(wk, reconWithVh('ARDYYGSSYFDY'), async () => { throw new Error('blast down'); })).resolves.toBeUndefined();
    expect(wk.constructs[0].cdrCompetitors ?? []).toEqual([]);
  });
});
