import { describe, it, expect } from 'vitest';
import {
  extractionRecall, residueFidelity, setRecall, speciesAccuracy, pairingAccuracy, competitorRecall, competitorPrecision,
} from './goldenPatent.js';

describe('patent metrics', () => {
  it('extractionRecall = unique in-range seqIds found / declared', () => {
    expect(extractionRecall([1, 2, 2, 5], 4)).toBe(0.5); // 1,2 in range; 5 out of range; 2 of 4
    expect(extractionRecall([], 0)).toBe(1);
  });

  it('residueFidelity = exact-match rate on known sequences (case-insensitive)', () => {
    expect(residueFidelity([{ seqId: 1, residues: 'evql' }], [{ seqId: 1, residues: 'EVQL' }])).toBe(1);
    expect(residueFidelity([{ seqId: 1, residues: 'EVQK' }], [{ seqId: 1, residues: 'EVQL' }])).toBe(0);
    expect(residueFidelity([], [{ seqId: 1, residues: 'EVQL' }])).toBe(0);
  });

  it('setRecall = fraction of expected present (case-insensitive, collapses internal whitespace)', () => {
    expect(setRecall(['acme bio'], ['ACME BIO'])).toBe(1);
    expect(setRecall([], ['ACME BIO'])).toBe(0);
    expect(setRecall(['acme  bio'], ['ACME BIO'])).toBe(1);
  });

  it('speciesAccuracy matches constructs by vhSeqId and compares species', () => {
    const got = [{ vhSeqId: 1, species: 'human-like' as const }];
    expect(speciesAccuracy(got, [{ vhSeqId: 1, species: 'human-like' }])).toBe(1);
    expect(speciesAccuracy(got, [{ vhSeqId: 1, species: 'chimeric' }])).toBe(0);
    expect(speciesAccuracy([], [{ vhSeqId: 1, species: 'human-like' }])).toBe(0);
  });

  it('pairingAccuracy checks the VL paired to each expected VH', () => {
    const got = [{ vhSeqId: 1, vlSeqId: 2, species: 'human-like' as const }];
    expect(pairingAccuracy(got, [{ vhSeqId: 1, vlSeqId: 2, species: 'human-like' }])).toBe(1);
    expect(pairingAccuracy(got, [{ vhSeqId: 1, vlSeqId: 9, species: 'human-like' }])).toBe(0);
    expect(pairingAccuracy([], [{ vhSeqId: 1, vlSeqId: 2, species: 'human-like' }])).toBe(0);
    expect(pairingAccuracy([], [{ vhSeqId: 1, species: 'human-like' }])).toBe(0);   // vlSeqId undefined + no match must still be a miss (was the bug)
  });

  it('competitorRecall/precision score overlaps at a given level', () => {
    const got = [{ seqId: 1, competitorAccession: 'PAT_A', level: 'whole' as const }];
    const expected = [{ seqId: 1, competitorAccession: 'PAT_A', level: 'whole' as const }, { seqId: 1, competitorAccession: 'PAT_B', level: 'cdr' as const }];
    expect(competitorRecall(got, expected, 'whole')).toBe(1);
    expect(competitorRecall(got, expected, 'cdr')).toBe(0);   // cdr-level not produced until H4
    expect(competitorPrecision(got, expected, 'whole')).toBe(1);
  });
});
