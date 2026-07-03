import { describe, it, expect } from 'vitest';
import { gradeEvidence } from './grade.js';

const base = { sampleSize: null as number | null, redFlags: [] as { category: 'unblinded'; biasRisk: 'low' | 'moderate' | 'high'; explanation: string }[] };

describe('gradeEvidence', () => {
  it('maps base tiers by study design', () => {
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled' })).toBe('high');
    expect(gradeEvidence({ ...base, studyDesign: 'single_arm' })).toBe('moderate');
    expect(gradeEvidence({ ...base, studyDesign: 'observational' })).toBe('low');
    expect(gradeEvidence({ ...base, studyDesign: 'post_hoc' })).toBe('low');
    expect(gradeEvidence({ ...base, studyDesign: 'preclinical_nhp' })).toBe('very_low');
    expect(gradeEvidence({ ...base, studyDesign: 'in_vitro' })).toBe('very_low');
  });

  it('downgrades one level for a high-biasRisk flag', () => {
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled',
      redFlags: [{ category: 'unblinded', biasRisk: 'high', explanation: 'x' }] })).toBe('moderate');
  });

  it('downgrades for two moderate flags but not one', () => {
    const one = [{ category: 'unblinded' as const, biasRisk: 'moderate' as const, explanation: 'x' }];
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', redFlags: one })).toBe('high');
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', redFlags: [...one, ...one] })).toBe('moderate');
  });

  it('downgrades for a small known sample only', () => {
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', sampleSize: 40 })).toBe('moderate');
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', sampleSize: 60 })).toBe('high');
    expect(gradeEvidence({ ...base, studyDesign: 'randomized_controlled', sampleSize: null })).toBe('high');
  });

  it('stacks downgrades and floors at very_low', () => {
    expect(gradeEvidence({ studyDesign: 'randomized_controlled', sampleSize: 10,
      redFlags: [
        { category: 'unblinded', biasRisk: 'high', explanation: 'x' },
        { category: 'p_hacking', biasRisk: 'moderate', explanation: 'y' },
        { category: 'high_dropout', biasRisk: 'moderate', explanation: 'z' },
      ] })).toBe('very_low');
  });
});
