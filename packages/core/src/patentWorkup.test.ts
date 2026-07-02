import { describe, it, expect } from 'vitest';
import { groupConstructs, buildWorkup, synthesizeCompetitiveIP } from './patentWorkup.js';
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
