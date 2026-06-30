import { describe, it, expect } from 'vitest';
import { normalizeSequence, detectProgram } from './blastVerify.js';

describe('normalizeSequence', () => {
  it('strips a FASTA header, whitespace, digits, and numbering and uppercases', () => {
    const input = '>seq1 anti-CDCP1 VH\n  1 evqlv esggg\n 11 lvqpg gslrl\n';
    expect(normalizeSequence(input)).toBe('EVQLVESGGGLVQPGGSLRL');
  });

  it('returns an empty string for header-only or blank input', () => {
    expect(normalizeSequence('>just a header')).toBe('');
    expect(normalizeSequence('   \n  ')).toBe('');
  });
});

describe('detectProgram', () => {
  it('returns blastn for a nucleotide-only sequence', () => {
    expect(detectProgram('ACGTACGTNNACGT')).toBe('blastn');
  });

  it('returns blastp for a sequence with non-nucleotide residues', () => {
    expect(detectProgram('EVQLVESGGGLVQPG')).toBe('blastp');
  });
});
