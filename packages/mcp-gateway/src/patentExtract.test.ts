import { describe, it, expect } from 'vitest';
import {
  extractPatentNumber,
  extractSequenceListing,
  normalizeRegionNote,
  isST26,
  extractSequenceListingST26,
  extractSequences,
  extractST26Associations,
} from './patentExtract.js';

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

  it('SEQ ID 1 with no <211> does not inherit the next entry\'s <211>', () => {
    // SEQ ID 1 has <210> 1 but no <211>. SEQ ID 2 has both <210> 2 and <211> 9.
    // The length-pairing regex must not let SEQ ID 1 cross into SEQ ID 2's <211>.
    const md = [
      '<210> 1',
      '<210> 2',
      '<211> 9',
      'SEQ ID NO: 1',
      'EVQLVESGG',
      '',
      'SEQ ID NO: 2',
      'ARDYYGSS',
      '',
    ].join('\n');
    const out = extractSequenceListing(md);
    const s1 = out.find((s) => s.seqId === 1);
    const s2 = out.find((s) => s.seqId === 2);
    expect(s1?.declaredLength).toBeUndefined();
    expect(s2?.declaredLength).toBe(9);
  });
});

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

  it('single-element ST.26 listing returns exactly one sequence (asArray non-array branch)', () => {
    // fast-xml-parser returns a plain object (not an array) when there is only one <SequenceData>.
    // asArray() must handle this case and still return one ExtractedSequence.
    const singleST26 = [
      '<?xml version="1.0"?>',
      '<ST26SequenceListing>',
      '  <SequenceData sequenceIDNumber="3">',
      '    <INSDSeq><INSDSeq_length>9</INSDSeq_length><INSDSeq_moltype>AA</INSDSeq_moltype><INSDSeq_sequence>EVQLVESGG</INSDSeq_sequence></INSDSeq>',
      '  </SequenceData>',
      '</ST26SequenceListing>',
    ].join('\n');
    const out = extractSequenceListingST26(singleST26);
    expect(out).toHaveLength(1);
    expect(out[0].seqId).toBe(3);
    expect(out[0].residues).toBe('EVQLVESGG');
    expect(out[0].declaredLength).toBe(9);
  });
});

describe('normalizeRegionNote', () => {
  it('maps confident CDR notes with chain + number', () => {
    expect(normalizeRegionNote('CDR-H3')).toBe('CDR-H3');
    expect(normalizeRegionNote('HCDR3')).toBe('CDR-H3');
    expect(normalizeRegionNote('heavy chain CDR 1')).toBe('CDR-H1');
    expect(normalizeRegionNote('CDR-L2')).toBe('CDR-L2');
  });
  it('maps variable domains and full chains', () => {
    expect(normalizeRegionNote('VH')).toBe('VH');
    expect(normalizeRegionNote('heavy chain variable region')).toBe('VH');
    expect(normalizeRegionNote('variable light')).toBe('VL');
    expect(normalizeRegionNote('heavy chain')).toBe('heavy-chain');
    expect(normalizeRegionNote('light chain')).toBe('light-chain');
    expect(normalizeRegionNote('Fc region')).toBe('Fc');
    expect(normalizeRegionNote('hinge')).toBe('hinge');
  });
  it('returns undefined for unknown or chain-ambiguous notes', () => {
    expect(normalizeRegionNote('signal peptide')).toBeUndefined();
    expect(normalizeRegionNote('linker')).toBeUndefined();
    expect(normalizeRegionNote('CDR 3')).toBeUndefined(); // no chain -> ambiguous
    expect(normalizeRegionNote('')).toBeUndefined();
  });
});

const ST26_FEAT = `<?xml version="1.0"?>
<ST26SequenceListing>
  <SequenceData sequenceIDNumber="1">
    <INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence>
      <INSDSeq_feature-table><INSDFeature>
        <INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..12</INSDFeature_location>
        <INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier></INSDFeature_quals>
      </INSDFeature></INSDSeq_feature-table>
    </INSDSeq>
  </SequenceData>
  <SequenceData sequenceIDNumber="2">
    <INSDSeq><INSDSeq_length>120</INSDSeq_length><INSDSeq_sequence>${'E'.repeat(120)}</INSDSeq_sequence>
      <INSDSeq_feature-table>
        <INSDFeature><INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..120</INSDFeature_location>
          <INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>heavy chain variable region</INSDQualifier_value></INSDQualifier></INSDFeature_quals></INSDFeature>
        <INSDFeature><INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>99..111</INSDFeature_location>
          <INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier></INSDFeature_quals></INSDFeature>
      </INSDSeq_feature-table>
    </INSDSeq>
  </SequenceData>
</ST26SequenceListing>`;

describe('extractST26Associations', () => {
  it('emits whole-sequence associations, skips sub-span features', () => {
    const out = extractST26Associations(ST26_FEAT);
    // SEQ 1: CDR-H3 spans full 12; SEQ 2: VH spans full 120; SEQ 2 sub-span CDR-H3 @ 99..111 skipped
    expect(out).toContainEqual({ regionLabel: 'CDR-H3', seqId: 1 });
    expect(out).toContainEqual({ regionLabel: 'VH', seqId: 2 });
    expect(out).not.toContainEqual({ regionLabel: 'CDR-H3', seqId: 2 });
  });
  it('returns [] on malformed xml and skips unrecognized notes', () => {
    expect(extractST26Associations('<ST26SequenceListing><SequenceData')).toEqual([]);
  });

  it('reads product qualifier and yields normalized association', () => {
    const xml = `<?xml version="1.0"?>
<ST26SequenceListing>
  <SequenceData sequenceIDNumber="1">
    <INSDSeq><INSDSeq_length>10</INSDSeq_length><INSDSeq_sequence>EVQLVESGGX</INSDSeq_sequence>
      <INSDSeq_feature-table><INSDFeature>
        <INSDFeature_key>mat_peptide</INSDFeature_key><INSDFeature_location>1..10</INSDFeature_location>
        <INSDFeature_quals><INSDQualifier><INSDQualifier_name>product</INSDQualifier_name><INSDQualifier_value>heavy chain</INSDQualifier_value></INSDQualifier></INSDFeature_quals>
      </INSDFeature></INSDSeq_feature-table>
    </INSDSeq>
  </SequenceData>
</ST26SequenceListing>`;
    const out = extractST26Associations(xml);
    expect(out).toContainEqual({ regionLabel: 'heavy-chain', seqId: 1 });
  });

  it('note qualifier wins over product qualifier when both are present', () => {
    const xml = `<?xml version="1.0"?>
<ST26SequenceListing>
  <SequenceData sequenceIDNumber="1">
    <INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence>
      <INSDSeq_feature-table><INSDFeature>
        <INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..12</INSDFeature_location>
        <INSDFeature_quals>
          <INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier>
          <INSDQualifier><INSDQualifier_name>product</INSDQualifier_name><INSDQualifier_value>heavy chain</INSDQualifier_value></INSDQualifier>
        </INSDFeature_quals>
      </INSDFeature></INSDSeq_feature-table>
    </INSDSeq>
  </SequenceData>
</ST26SequenceListing>`;
    const out = extractST26Associations(xml);
    expect(out).toContainEqual({ regionLabel: 'CDR-H3', seqId: 1 });
    expect(out).not.toContainEqual({ regionLabel: 'heavy-chain', seqId: 1 });
  });

  it('skips SequenceData with sequenceIDNumber="0"', () => {
    const xml = `<?xml version="1.0"?>
<ST26SequenceListing>
  <SequenceData sequenceIDNumber="0">
    <INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence>
      <INSDSeq_feature-table><INSDFeature>
        <INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..12</INSDFeature_location>
        <INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier></INSDFeature_quals>
      </INSDFeature></INSDSeq_feature-table>
    </INSDSeq>
  </SequenceData>
</ST26SequenceListing>`;
    expect(extractST26Associations(xml)).toEqual([]);
  });
});
