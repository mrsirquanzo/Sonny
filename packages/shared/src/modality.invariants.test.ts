import { describe, expect, it } from 'vitest';
import { CanonicalModalitySchema } from './index.js';

describe('canonical modality', () => {
  it('matches the 16 lens keys exactly, including unknown', () => {
    expect(CanonicalModalitySchema.options).toEqual([
      'adc', 'small_molecule', 'protac', 'molecular_glue',
      'sirna', 'aso', 'monoclonal_antibody', 'bispecific_antibody',
      'car_t', 'tcr_t', 'gene_editing', 'gene_replacement',
      'mrna', 'radioligand', 'therapeutic_vaccine', 'unknown',
    ]);
  });

  it('rejects aliases, family labels and the generic lens display name', () => {
    for (const invalid of ['antibody', 'oligonucleotide', 'cell_therapy', 'generic', 'ADC']) {
      expect(CanonicalModalitySchema.safeParse(invalid).success).toBe(false);
    }
  });
});
