import { CanonicalModalitySchema, type CanonicalModality } from '@mrsirquanzo/sonny-shared';

/**
 * Map free text to a canonical modality key.
 *
 * `inferModality` and user input both return prose ("antibody-drug conjugate",
 * "immunoconjugate", "ADC"). Anything unrecognised resolves to `unknown`, which
 * routes to the generic fallback lens - never to an antibody default.
 */
const PATTERNS: Array<[RegExp, CanonicalModality]> = [
  [/\b(?:adc|antibody[- ]drug conjugates?|immunoconjugates?)\b/i, 'adc'],
  [/\bbispecific/i, 'bispecific_antibody'],
  [/\b(?:car[- ]?t)\b/i, 'car_t'],
  [/\b(?:tcr[- ]?t)\b/i, 'tcr_t'],
  [/\b(?:monoclonal|antibod(?:y|ies)|mab)\b/i, 'monoclonal_antibody'],
  [/\bprotac|degrader\b/i, 'protac'],
  [/\bmolecular glue\b/i, 'molecular_glue'],
  [/\bsirna|rnai\b/i, 'sirna'],
  [/\b(?:aso|antisense)\b/i, 'aso'],
  [/\bgene editing|crispr\b/i, 'gene_editing'],
  [/\bgene (?:replacement|therapy)|aav\b/i, 'gene_replacement'],
  [/\bmrna\b/i, 'mrna'],
  [/\bradioligand|radiopharmaceutical\b/i, 'radioligand'],
  [/\bvaccine\b/i, 'therapeutic_vaccine'],
  [/\bsmall[- ]molecule\b/i, 'small_molecule'],
];

export function canonicalModalityOf(raw?: string): CanonicalModality {
  const text = raw?.trim();
  if (!text) return 'unknown';
  const exact = CanonicalModalitySchema.safeParse(text.toLowerCase().replace(/[ -]/g, '_'));
  if (exact.success) return exact.data;
  for (const [re, key] of PATTERNS) if (re.test(text)) return key;
  return 'unknown';
}
