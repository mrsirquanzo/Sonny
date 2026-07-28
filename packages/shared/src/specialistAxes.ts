import { z } from 'zod';

/**
 * The six fixed specialist axes. This enum lives in `shared` because both the
 * section schemas here and the roster/planner in `core` key off it, and `core`
 * depends on `shared`, never the reverse.
 */
export const SpecialistAxisIdSchema = z.enum([
  'target_biology',
  'moa_pathway',
  'disease_indications',
  'clinical_landscape',
  'competitive_ip',
  'modality_developability',
]);
export type SpecialistAxisId = z.infer<typeof SpecialistAxisIdSchema>;
