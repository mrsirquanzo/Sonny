import { describe, it, expect } from 'vitest';
import { extractPatentNumber, extractSequenceListing } from './patentExtract.js';

describe('extractPatentNumber', () => {
  it('finds and normalizes a patent number embedded in text', () => {
    expect(extractPatentNumber('Filed as Patent No. US 10,123,456 B2 on ...')).toBe('US10123456');
  });
  it('returns null when no valid patent number is present', () => {
    expect(extractPatentNumber('This document has no patent number.')).toBeNull();
  });
});

describe('extractSequenceListing', () => {
  it('parses SEQ ID NO blocks into normalized residues, de-dupes ids, and skips inline references without a residue block', () => {
    const md = [
      'SEQ ID NO: 1',
      'EVQLVESGGG',
      '',
      'SEQ ID NO: 2',
      'DIQ MTQ SPSS',   // whitespace inside residues is stripped
      '',
      'SEQ ID NO: 1',   // duplicate id ignored
      'ZZZZZZ',
      '',
      'the CDR-H1 comprises SEQ ID NO: 3 and other text',  // inline ref, no residue block
    ].join('\n');
    const out = extractSequenceListing(md);
    expect(out).toEqual([
      { seqId: 1, residues: 'EVQLVESGGG' },
      { seqId: 2, residues: 'DIQMTQSPSS' },
    ]);
  });

  it('skips residue blocks with fewer than 4 characters after normalization', () => {
    const md = 'SEQ ID NO: 5\nMET\n';
    const out = extractSequenceListing(md);
    const ids = out.map((s) => s.seqId);
    expect(ids).not.toContain(5);
  });
});

describe('extractSequenceListing declared length', () => {
  it('captures ST.25 <211> length paired with <210> seq id', () => {
    const md = '<210> 1\n<211> 12\n<212> PRT\n<213> Homo sapiens\nSEQ ID NO: 1\nARDYYGSSYFDY\n\n';
    const out = extractSequenceListing(md);
    const s1 = out.find((s) => s.seqId === 1);
    expect(s1?.residues).toBe('ARDYYGSSYFDY');
    expect(s1?.declaredLength).toBe(12);
  });

  it('leaves declaredLength undefined when no length is declared', () => {
    const md = 'SEQ ID NO: 2\nEVQLVESGG\n\n';
    const out = extractSequenceListing(md);
    expect(out.find((s) => s.seqId === 2)?.declaredLength).toBeUndefined();
  });
});
