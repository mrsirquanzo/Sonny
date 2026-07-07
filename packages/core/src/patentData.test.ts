import { describe, it, expect } from 'vitest';
import { extractPatentData, extractAssociations } from './patentData.js';
import type { ExtractionCompleteness } from './patentData.js';
import { reconcilePatent } from './patentReconcile.js';
import type { ReconcileDeps } from './patentReconcile.js';
import type { StructuredModel } from './model.js';
import type { TraceEvent, ExtractionCompletenessLike } from '@mrsirquanzo/sonny-shared';

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

describe('extractPatentData ST.26 + declaredLength', () => {
  it('extracts sequences from an ST.26 listing and carries declaredLength', async () => {
    const st26 = '<ST26SequenceListing><SequenceData sequenceIDNumber="1"><INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence></INSDSeq></SequenceData></ST26SequenceListing>';
    const model = { async generateStructured() { return { associations: [] } as never; } };
    const out = await extractPatentData(st26, model);
    const s1 = out.sequences.find((s) => s.seqId === 1);
    expect(s1?.residues).toBe('ARDYYGSSYFDY');
    expect(s1?.declaredLength).toBe(12);
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
    expect(c.associationCount).toBe(1); // one association returned by the model
  });

  it('surfaces the construct-less case: sequences found but zero associations', async () => {
    const md = ['SEQ ID NO: 1', 'EVQLVESGG', '', 'SEQ ID NO: 2', 'DIQMTQSPS', ''].join('\n');
    const model = { async generateStructured() { return { associations: [] } as never; } };
    const c = (await extractPatentData(md, model)).completeness!;
    expect(c.foundCount).toBe(2);
    expect(c.associationCount).toBe(0); // foundCount > 0 && associationCount === 0 -> construct-less workup signal
  });
});

describe('extractPatentData ST.26 structured associations', () => {
  const ST26 = '<ST26SequenceListing><SequenceData sequenceIDNumber="1"><INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence><INSDSeq_feature-table><INSDFeature><INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..12</INSDFeature_location><INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier></INSDFeature_quals></INSDFeature></INSDSeq_feature-table></INSDSeq></SequenceData></ST26SequenceListing>';

  it('uses ST.26 features and does NOT call the LLM', async () => {
    let llmCalls = 0;
    const model = { async generateStructured() { llmCalls++; return { associations: [] } as never; } };
    const out = await extractPatentData(ST26, model);
    expect(out.associations).toContainEqual(expect.objectContaining({ regionLabel: 'CDR-H3', seqId: 1 }));
    expect(llmCalls).toBe(0);
  });

  it('still uses the LLM for text patents', async () => {
    let llmCalls = 0;
    const model = { async generateStructured() { llmCalls++; return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never; } };
    const out = await extractPatentData('SEQ ID NO: 1\nEVQLVESGG\n\nThe heavy chain variable region is SEQ ID NO: 1.', model);
    expect(llmCalls).toBe(1);
    expect(out.associations).toContainEqual(expect.objectContaining({ regionLabel: 'VH', seqId: 1 }));
  });
});

describe('ST.26 + reconcilePatent end-to-end', () => {
  it('ST.26 sequence survives reconcile and carries declaredLength through to VerifiedSequence', async () => {
    // Use a 12-residue sequence (below the 50-aa BLAST gate) so we can inject empty blast deps.
    // Goal: verify the ST.26 path through extractPatentData populates declaredLength and that
    // reconcilePatent does not drop the sequence.
    const st26 = [
      '<ST26SequenceListing>',
      '  <SequenceData sequenceIDNumber="1">',
      '    <INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence></INSDSeq>',
      '  </SequenceData>',
      '</ST26SequenceListing>',
    ].join('\n');
    const model = { async generateStructured() { return { associations: [] } as never; } };
    const extracted = await extractPatentData(st26, model);

    const reconcileDeps: ReconcileDeps = {
      blast: async () => [],
      anarci: async () => ({ overallStatus: 'anarci_unavailable', domains: [], regionChecks: [], speciesSummary: [] }),
      epo: async () => ({ input: '', found: false, applicants: [], inventors: [], ipc: [], family: [] }),
    };
    const reconciliation = await reconcilePatent(extracted, reconcileDeps);

    const s = reconciliation.sequences.find((seq) => seq.seqId === 1);
    expect(s).toBeDefined();
    expect(s?.residues).toBe('ARDYYGSSYFDY');
    expect(s?.declaredLength).toBe(12);
  });
});

describe('extractPatentData emit', () => {
  // Reuse the ST26 fixture from the ST.26 structured associations describe block
  const ST26 = '<ST26SequenceListing><SequenceData sequenceIDNumber="1"><INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence><INSDSeq_feature-table><INSDFeature><INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..12</INSDFeature_location><INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier></INSDFeature_quals></INSDFeature></INSDSeq_feature-table></INSDSeq></SequenceData></ST26SequenceListing>';

  it('emits stage events in order for a text patent', async () => {
    const events: TraceEvent[] = [];
    const md = 'US 10,123,456 B2\nSEQ ID NO: 1\nEVQLVESGGG\n';
    const model = { async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 1 }] } as never; } };
    await extractPatentData(md, model, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(['patent_extracted', 'patent_associations', 'patent_complete']);
    const extracted = events[0] as Extract<TraceEvent, { type: 'patent_extracted' }>;
    expect(extracted.sequenceCount).toBe(1);
    expect(extracted.patentNumber).toBe('US10123456');
    const assoc = events[1] as Extract<TraceEvent, { type: 'patent_associations' }>;
    expect(assoc.source).toBe('llm');
  });

  it('reports source=st26 and calls no model for an ST.26 listing', async () => {
    const events: TraceEvent[] = [];
    let llmCalls = 0;
    const model = { async generateStructured() { llmCalls++; return { associations: [] } as never; } };
    await extractPatentData(ST26, model, (e) => events.push(e));
    const assoc = events.find((e) => e.type === 'patent_associations') as Extract<TraceEvent, { type: 'patent_associations' }>;
    expect(assoc.source).toBe('st26');
    expect(llmCalls).toBe(0);
  });

  it('defaults emit to a no-op when omitted', async () => {
    const md = 'SEQ ID NO: 1\nEVQLVESGGG\n';
    const model = { async generateStructured() { return { associations: [] } as never; } };
    await expect(extractPatentData(md, model)).resolves.toBeDefined();
  });

  it('ExtractionCompleteness stays structurally compatible with the shared ExtractionCompletenessLike', () => {
    const core: ExtractionCompleteness = { foundCount: 1, referencedMax: 1, missingSeqIds: [], alphabetWarnings: [], associationCount: 0 };
    const shared: ExtractionCompletenessLike = core; // fails to compile if core drops/renames a field
    const back: ExtractionCompleteness = shared;     // fails to compile if shared drops/renames a field
    expect(back.foundCount).toBe(1);
  });
});
