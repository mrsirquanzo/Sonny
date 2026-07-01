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
