import { z } from 'zod';

/**
 * Canonical modality keys. These MUST match the modality lens table one-to-one,
 * including `unknown`, which routes to the generic fallback lens rather than
 * defaulting to an antibody rubric.
 */
export const CanonicalModalitySchema = z.enum([
  'adc',
  'small_molecule',
  'protac',
  'molecular_glue',
  'sirna',
  'aso',
  'monoclonal_antibody',
  'bispecific_antibody',
  'car_t',
  'tcr_t',
  'gene_editing',
  'gene_replacement',
  'mrna',
  'radioligand',
  'therapeutic_vaccine',
  'unknown',
]);
export type CanonicalModality = z.infer<typeof CanonicalModalitySchema>;
