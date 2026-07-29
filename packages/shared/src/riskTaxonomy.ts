import { z } from 'zod';
import type { CanonicalModality } from './modality.js';

export const RiskDomainSchema = z.enum([
  'target_biology', 'safety', 'delivery_biodistribution', 'pk_pd',
  'resistance', 'immunogenicity', 'cmc', 'manufacturing',
  'clinical_operations', 'translational_model',
]);
export type RiskDomain = z.infer<typeof RiskDomainSchema>;

/**
 * Canonical controlled risk registry. Lives in `shared` because both
 * `ModalityRisk` (here) and the eval package's `KnownDevelopabilityRisk`
 * validate against it; `core` owns only modality permissions and prose.
 *
 * A free-text code would let a model invent categories, defeating evaluation,
 * cross-run comparison, monitoring, and portfolio rollups.
 */
export const RISK_CODE_METADATA = {
  'common.on_target_off_tissue': { domain: 'safety' },
  'common.off_target_activity': { domain: 'safety' },
  'common.narrow_therapeutic_window': { domain: 'safety' },
  'common.acquired_resistance': { domain: 'resistance' },
  'common.target_heterogeneity': { domain: 'target_biology' },
  'common.poor_tissue_delivery': { domain: 'delivery_biodistribution' },
  'common.exposure_shortfall': { domain: 'pk_pd' },
  'common.immunogenicity': { domain: 'immunogenicity' },
  'common.manufacturing_scalability': { domain: 'manufacturing' },
  'common.translational_model_gap': { domain: 'translational_model' },
  'common.other_target_biology': { domain: 'target_biology' },
  'common.other_safety': { domain: 'safety' },
  'common.other_delivery': { domain: 'delivery_biodistribution' },
  'common.other_pk_pd': { domain: 'pk_pd' },
  'common.other_resistance': { domain: 'resistance' },
  'common.other_immunogenicity': { domain: 'immunogenicity' },
  'common.other_cmc': { domain: 'cmc' },
  'common.other_manufacturing': { domain: 'manufacturing' },
  'common.other_clinical_operations': { domain: 'clinical_operations' },
  'common.other_translational_model': { domain: 'translational_model' },
  'adc.premature_payload_release': { domain: 'safety' },
  'adc.payload_class_toxicity': { domain: 'safety' },
  'adc.antigen_sink': { domain: 'pk_pd' },
  'adc.low_antigen_density': { domain: 'target_biology' },
  'adc.antigen_shedding': { domain: 'target_biology' },
  'adc.poor_internalization': { domain: 'target_biology' },
  'adc.dar_cmc': { domain: 'cmc' },
  'small_molecule.reactive_metabolite': { domain: 'safety' },
  'small_molecule.off_target_pharmacology': { domain: 'safety' },
  'small_molecule.poor_oral_exposure': { domain: 'pk_pd' },
  'small_molecule.metabolic_instability': { domain: 'pk_pd' },
  'small_molecule.ddi': { domain: 'pk_pd' },
  'small_molecule.binding_site_mutation': { domain: 'resistance' },
  'small_molecule.solid_state_liability': { domain: 'cmc' },
  'protac.poor_permeability': { domain: 'pk_pd' },
  'protac.hook_effect': { domain: 'pk_pd' },
  'protac.neosubstrate_degradation': { domain: 'safety' },
  'protac.incomplete_degradation': { domain: 'target_biology' },
  'protac.synthesis_scalability': { domain: 'manufacturing' },
  'molecular_glue.neosubstrate_degradation': { domain: 'safety' },
  'molecular_glue.interface_resistance': { domain: 'resistance' },
  'molecular_glue.species_divergence': { domain: 'translational_model' },
  'oligo.endosomal_escape_shortfall': { domain: 'delivery_biodistribution' },
  'oligo.extrahepatic_delivery': { domain: 'delivery_biodistribution' },
  'oligo.seed_off_target': { domain: 'safety' },
  'oligo.innate_immune_activation': { domain: 'immunogenicity' },
  'oligo.thrombocytopenia': { domain: 'safety' },
  'oligo.hepatorenal_toxicity': { domain: 'safety' },
  'oligo.transient_knockdown': { domain: 'pk_pd' },
  'oligo.dosing_burden': { domain: 'clinical_operations' },
  'antibody.tmdd': { domain: 'pk_pd' },
  'antibody.soluble_antigen_sink': { domain: 'pk_pd' },
  'antibody.poor_tissue_penetration': { domain: 'delivery_biodistribution' },
  'antibody.ada': { domain: 'immunogenicity' },
  'antibody.fc_mediated_toxicity': { domain: 'safety' },
  'antibody.excessive_agonism': { domain: 'safety' },
  'antibody.aggregation': { domain: 'cmc' },
  'bispecific.crs': { domain: 'safety' },
  'bispecific.neurotoxicity': { domain: 'safety' },
  'bispecific.insufficient_coexpression': { domain: 'target_biology' },
  'bispecific.chain_mispairing': { domain: 'cmc' },
  'bispecific.step_up_dosing_burden': { domain: 'clinical_operations' },
  'cell_therapy.crs': { domain: 'safety' },
  'cell_therapy.icans': { domain: 'safety' },
  'cell_therapy.fratricide': { domain: 'target_biology' },
  'cell_therapy.antigen_escape': { domain: 'resistance' },
  'cell_therapy.poor_persistence': { domain: 'pk_pd' },
  'cell_therapy.exhaustion': { domain: 'target_biology' },
  'cell_therapy.immunosuppressive_tme': { domain: 'resistance' },
  'cell_therapy.prolonged_cytopenia': { domain: 'safety' },
  'cell_therapy.manufacturing_failure': { domain: 'manufacturing' },
  'cell_therapy.vein_to_vein_time': { domain: 'clinical_operations' },
  'tcr_t.peptide_cross_reactivity': { domain: 'safety' },
  'tcr_t.hla_restriction': { domain: 'clinical_operations' },
  'tcr_t.hla_loss': { domain: 'resistance' },
  'tcr_t.antigen_processing_defect': { domain: 'target_biology' },
  'gene.off_target_editing': { domain: 'safety' },
  'gene.chromosomal_rearrangement': { domain: 'safety' },
  'gene.insertional_genotoxicity': { domain: 'safety' },
  'gene.vector_immunity': { domain: 'immunogenicity' },
  'gene.redosing_impossible': { domain: 'clinical_operations' },
  'gene.expression_loss': { domain: 'pk_pd' },
  'gene.vector_capacity': { domain: 'cmc' },
  'gene.long_term_monitoring': { domain: 'clinical_operations' },
  'mrna.reactogenicity': { domain: 'immunogenicity' },
  'mrna.lnp_toxicity': { domain: 'safety' },
  'mrna.hepatic_bias': { domain: 'delivery_biodistribution' },
  'mrna.expression_duration': { domain: 'pk_pd' },
  'mrna.cold_chain': { domain: 'manufacturing' },
  'radioligand.marrow_toxicity': { domain: 'safety' },
  'radioligand.kidney_toxicity': { domain: 'safety' },
  'radioligand.organ_specific_uptake': { domain: 'safety' },
  'radioligand.chelator_instability': { domain: 'cmc' },
  'radioligand.insufficient_retention': { domain: 'pk_pd' },
  'radioligand.isotope_supply': { domain: 'manufacturing' },
  'radioligand.radiation_infrastructure': { domain: 'clinical_operations' },
  'vaccine.weak_immunogenicity': { domain: 'immunogenicity' },
  'vaccine.tolerance': { domain: 'immunogenicity' },
  'vaccine.hla_coverage': { domain: 'clinical_operations' },
  'vaccine.autoimmune_cross_reactivity': { domain: 'safety' },
  'vaccine.slow_onset': { domain: 'clinical_operations' },
  'vaccine.combination_dependence': { domain: 'clinical_operations' },
} as const satisfies Record<string, { domain: RiskDomain }>;

export type RiskCode = keyof typeof RISK_CODE_METADATA;
export const RiskCodeSchema = z.enum(
  Object.keys(RISK_CODE_METADATA) as [RiskCode, ...RiskCode[]],
);

/** Domain-specific fallbacks. A single `common.other` pinned to one domain
 *  would misfile an uncatalogued safety or CMC risk and corrupt domain rollups. */
export const COMMON_RISK_CODES = [
  'common.on_target_off_tissue',
  'common.off_target_activity',
  'common.narrow_therapeutic_window',
  'common.acquired_resistance',
  'common.target_heterogeneity',
  'common.poor_tissue_delivery',
  'common.exposure_shortfall',
  'common.immunogenicity',
  'common.manufacturing_scalability',
  'common.translational_model_gap',
  'common.other_target_biology',
  'common.other_safety',
  'common.other_delivery',
  'common.other_pk_pd',
  'common.other_resistance',
  'common.other_immunogenicity',
  'common.other_cmc',
  'common.other_manufacturing',
  'common.other_clinical_operations',
  'common.other_translational_model',
] as const satisfies readonly RiskCode[];

export function isOtherCode(code: RiskCode): boolean {
  return code.startsWith('common.other_');
}

/**
 * Critical risk domains per modality (spec 5.8, normative).
 *
 * A `low` Q6 requires EVERY critical domain here to carry a
 * `RiskDomainAssessment` of `no_material_liability` or `manageable`.
 * Enumerated, never inferred: "found no liability" is not evidence of low
 * development risk, and that inference fails hardest on novel modalities where
 * absent published liability reflects absent study rather than absent risk.
 *
 * Transcribed from the spec table so the two cannot drift.
 */
export const CRITICAL_RISK_DOMAINS_BY_MODALITY = {
  adc:                 ['safety', 'target_biology', 'pk_pd', 'cmc'],
  monoclonal_antibody: ['safety', 'pk_pd', 'immunogenicity'],
  bispecific_antibody: ['safety', 'pk_pd', 'immunogenicity', 'cmc'],
  small_molecule:      ['safety', 'pk_pd'],
  protac:              ['safety', 'pk_pd', 'target_biology'],
  molecular_glue:      ['safety', 'target_biology'],
  sirna:               ['safety', 'delivery_biodistribution', 'pk_pd'],
  aso:                 ['safety', 'delivery_biodistribution', 'pk_pd'],
  car_t:               ['safety', 'target_biology', 'manufacturing'],
  tcr_t:               ['safety', 'target_biology', 'manufacturing', 'clinical_operations'],
  gene_editing:        ['safety', 'delivery_biodistribution', 'manufacturing'],
  gene_replacement:    ['safety', 'immunogenicity', 'delivery_biodistribution', 'manufacturing'],
  mrna:                ['safety', 'immunogenicity', 'delivery_biodistribution', 'manufacturing'],
  radioligand:         ['safety', 'delivery_biodistribution', 'manufacturing'],
  therapeutic_vaccine: ['immunogenicity', 'safety', 'clinical_operations'],
  unknown:             ['safety'],
} as const satisfies Record<CanonicalModality, readonly RiskDomain[]>;

/** A critical domain is covered only by a status that asserts it was resolved. */
export const ACCEPTABLE_CRITICAL_DOMAIN_STATUSES = ['no_material_liability', 'manageable'] as const;
