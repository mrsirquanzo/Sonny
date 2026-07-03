import { describe, it, expect } from 'vitest';
import { extractPatentData, extractAssociations } from './patentData.js';
import type { StructuredModel } from './model.js';

const MD = [
  'Patent US 10,123,456 B2',
  'Claims',
  '1. An antibody comprising CDR-H1 of SEQ ID NO: 1.',
  '',
  'SEQ ID NO: 1',
  'EVQLVESGGG',
  '',
  'SEQ ID NO: 2',
  'DIQMTQSPSS',
  '',
].join('\n');

function mockModel(assoc: Array<{ regionLabel: string; seqId: number }>): StructuredModel {
  return { async generateStructured() { return { associations: assoc } as never; } };
}

describe('extractPatentData', () => {
  it('assembles patent number, sequences, and associations with residues joined by seqId', async () => {
    const data = await extractPatentData(MD, mockModel([{ regionLabel: 'CDR-H1', seqId: 1 }]));
    expect(data.patentNumber).toBe('US10123456');
    expect(data.sequences).toEqual([{ seqId: 1, residues: 'EVQLVESGGG' }, { seqId: 2, residues: 'DIQMTQSPSS' }]);
    expect(data.associations).toEqual([{ regionLabel: 'CDR-H1', seqId: 1, residues: 'EVQLVESGGG' }]);
  });

  it('leaves residues undefined when the listing lacks the seqId', async () => {
    const data = await extractPatentData(MD, mockModel([{ regionLabel: 'CDR-H3', seqId: 99 }]));
    expect(data.associations[0].residues).toBeUndefined();
  });
});

describe('extractAssociations', () => {
  it('returns [] when the model throws', async () => {
    const throwing: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    expect(await extractAssociations(MD, throwing)).toEqual([]);
  });
});

describe('extraction completeness', () => {
  it('flags referenced-but-unextracted SEQ-IDs and residue-alphabet garbage', async () => {
    const md = [
      'Patent US 10,123,456 B2', 'Claims',
      '1. antibody comprising CDR-H1 of SEQ ID NO: 5.',   // references seq 5, never listed
      '', 'SEQ ID NO: 1', 'EVQLVES', '', 'SEQ ID NO: 2', 'DIQBZOX', '',   // seq 2 has non-residue letters
    ].join('\n');
    // model returns an association referencing SEQ-ID 5 (which has no listed sequence)
    const model = { async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 5 }] } as never; } };
    const data = await extractPatentData(md, model);
    const c = data.completeness!;   // extractPatentData always populates it
    expect(c.foundCount).toBe(2);
    expect(c.referencedMax).toBe(5);
    expect(c.missingSeqIds).toEqual([3, 4, 5]);
    const warn = c.alphabetWarnings.find((w) => w.seqId === 2);
    expect(warn?.invalidChars).toContain('B');
    expect(c.alphabetWarnings.find((w) => w.seqId === 1)).toBeUndefined(); // clean
  });
});
