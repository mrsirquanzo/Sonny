import { describe, it, expect } from 'vitest';
import { scorePatent } from './patentScore.js';
import type { GoldenPatent } from './goldenPatent.js';
import type { PatentWorkup } from '@mrsirquanzo/sonny-core';

const golden: GoldenPatent = {
  name: 'g', patentNumber: 'US1', expectedAssignees: ['ACME'], expectedFamilyMembers: ['EP1'],
  declaredSequenceCount: 2, knownSequences: [{ seqId: 1, residues: 'EVQL' }],
  expectedConstructs: [{ vhSeqId: 1, vlSeqId: 2, species: 'human-like' }],
  expectedCompetitorOverlaps: [{ seqId: 1, competitorAccession: 'PAT_W', level: 'whole' }],
  mustNotAssert: [],
};

const workup = {
  patentNumber: 'US1',
  patent: { input: 'US1', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: ['EP1'] },
  constructs: [{ name: 'Ab1', regions: [
    { regionLabel: 'VH', seqId: 1, residues: 'EVQL' }, { regionLabel: 'VL', seqId: 2, residues: 'DIQM' },
  ], species: { classification: 'human-like', evidence: '' } }],
  ungrouped: [], narrative: { summary: '', points: [] },
  graph: [{ subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_W', provenance: 'blast-pataa', confidence: 'verified' }],
} as unknown as PatentWorkup;

describe('scorePatent', () => {
  it('computes every metric from a workup + golden', () => {
    const m = scorePatent(workup, golden);
    expect(m.extractionRecall).toBeCloseTo(0.5);      // seq 1 found of 2 declared
    expect(m.residueFidelity).toBe(1);                 // seq 1 residues match
    expect(m.assigneeRecall).toBe(1);
    expect(m.familyRecall).toBe(1);
    expect(m.speciesAccuracy).toBe(1);
    expect(m.pairingAccuracy).toBe(1);
    expect(m.competitorRecallWhole).toBe(1);
    expect(m.competitorRecallCdr).toBe(1);             // none expected -> 1
    expect(m.competitorPrecisionWhole).toBe(1);
  });
});
