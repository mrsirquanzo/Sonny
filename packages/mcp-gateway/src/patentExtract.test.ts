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

import { isST26, extractSequenceListingST26, extractSequences } from './patentExtract.js';

const ST26 = `<?xml version="1.0"?>
<ST26SequenceListing>
  <SequenceData sequenceIDNumber="1">
    <INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_moltype>AA</INSDSeq_moltype><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence></INSDSeq>
  </SequenceData>
  <SequenceData sequenceIDNumber="2">
    <INSDSeq><INSDSeq_length>9</INSDSeq_length><INSDSeq_moltype>AA</INSDSeq_moltype><INSDSeq_sequence>EVQLVESGG</INSDSeq_sequence></INSDSeq>
  </SequenceData>
</ST26SequenceListing>`;

describe('ST.26 parsing', () => {
  it('isST26 detects XML listing vs text', () => {
    expect(isST26(ST26)).toBe(true);
    expect(isST26('SEQ ID NO: 1\nEVQLVESGG\n')).toBe(false);
  });

  it('extractSequenceListingST26 yields seqId, residues, declaredLength', () => {
    const out = extractSequenceListingST26(ST26);
    expect(out).toEqual([
      { seqId: 1, residues: 'ARDYYGSSYFDY', declaredLength: 12 },
      { seqId: 2, residues: 'EVQLVESGG', declaredLength: 9 },
    ]);
  });

  it('returns [] on malformed xml and skips <4-residue entries', () => {
    expect(extractSequenceListingST26('<ST26SequenceListing><SequenceData')).toEqual([]);
    const short = ST26.replace('ARDYYGSSYFDY', 'AR');
    expect(extractSequenceListingST26(short).map((s) => s.seqId)).toEqual([2]);
  });

  it('extractSequences routes ST.26 to the xml path and text to the regex path', () => {
    expect(extractSequences(ST26).map((s) => s.seqId)).toEqual([1, 2]);
    expect(extractSequences('SEQ ID NO: 5\nEVQLVESGG\n\n').map((s) => s.seqId)).toEqual([5]);
  });
});
