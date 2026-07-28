import { describe, expect, it } from 'vitest';
import { SpecialistAxisIdSchema } from './index.js';

describe('specialist axis ids', () => {
  it('exposes exactly the fixed six-axis spine', () => {
    expect(SpecialistAxisIdSchema.options).toEqual([
      'target_biology',
      'moa_pathway',
      'disease_indications',
      'clinical_landscape',
      'competitive_ip',
      'modality_developability',
    ]);
  });

  it('rejects analysis ids and arbitrary specialist categories', () => {
    expect(SpecialistAxisIdSchema.safeParse('data_analysis').success).toBe(false);
    expect(SpecialistAxisIdSchema.safeParse('commercial_opportunity').success).toBe(false);
  });
});
