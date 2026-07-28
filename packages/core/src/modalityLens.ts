import type { CanonicalModality } from '@mrsirquanzo/sonny-shared';

/**
 * Modality lens table. A static knowledge asset, NOT model-generated.
 *
 * Only Q2 (moa_pathway) and Q6 (modality_developability) read it. The other
 * four axes are conditioned by strategy context, never by lens content.
 *
 * Generated from the spec's section 6 table so the wording cannot drift from
 * the reviewed source.
 */
export const MODALITY_LENS_VERSION = '1.0.0';

export interface ResolvedLens {
  modalityLensKey: CanonicalModality;
  modalityLensVersion: string;
  resolvedQ2Lens: string[];
  resolvedQ6Lens: string[];
}

const LENS: Record<CanonicalModality, { q2: readonly string[]; q6: readonly string[] }> = {
  adc: {
    q2: [
      "tumour-cell surface accessibility",
      "antigen density and expression homogeneity",
      "antibody binding and epitope suitability",
      "internalization rate and capacity",
      "endosomal and lysosomal trafficking",
      "receptor recycling and turnover",
      "antigen shedding",
      "linker stability and cleavage mechanism",
      "payload sensitivity",
      "bystander-effect requirements",
      "relationship between target density and cytotoxic response",
    ],
    q6: [
      "on-target, off-tumour toxicity",
      "normal-tissue antigen expression",
      "circulating or shed antigen sink",
      "target-mediated drug disposition",
      "payload-class toxicity",
      "linker instability and premature payload release",
      "heterogeneous or low target expression",
      "antigen loss and resistance",
      "poor tumour penetration",
      "aggregation, conjugation, DAR and CMC liabilities",
      "species cross-reactivity and toxicology-model limitations",
    ],
  },
  aso: {
    q2: [
      "transcript sequence and structural accessibility",
      "RNase H, splice modulation or steric-blocking mechanism",
      "cellular and nuclear uptake",
      "tissue distribution",
      "knockdown or splice-correction depth",
      "duration of pharmacologic activity",
      "allele and isoform selectivity",
      "protein turnover following transcript modulation",
      "relationship between RNA modulation and disease phenotype",
    ],
    q6: [
      "hybridization-dependent off-target effects",
      "sequence-independent class toxicities",
      "thrombocytopenia",
      "liver and kidney toxicity",
      "innate immune activation",
      "poor delivery to the relevant tissue",
      "high or frequent dosing requirements",
      "tissue accumulation",
      "injection-site reactions",
      "limited reversibility after prolonged exposure",
    ],
  },
  bispecific_antibody: {
    q2: [
      "simultaneous accessibility of both targets",
      "target co-expression in the relevant biological context",
      "binding geometry and valency",
      "formation of the intended molecular or cellular synapse",
      "potency at physiologic target densities",
      "contribution of each binding arm",
      "avidity and conditional activation",
      "tissue penetration and half-life",
      "resistance to single-antigen loss",
    ],
    q6: [
      "cytokine-release syndrome",
      "neurotoxicity",
      "systemic immune-cell activation",
      "target sink",
      "antigen escape",
      "insufficient dual-target co-expression",
      "immunogenicity",
      "complex PK and target-mediated clearance",
      "chain mispairing and aggregation",
      "manufacturing yield and stability",
      "inconvenient step-up or continuous dosing",
    ],
  },
  car_t: {
    q2: [
      "antigen surface density",
      "antigen homogeneity",
      "CAR binding and synapse formation",
      "activation threshold",
      "tumour trafficking and infiltration",
      "expansion and persistence",
      "resistance to exhaustion",
      "activity within the tumour microenvironment",
      "memory-cell formation",
      "ability to overcome antigen heterogeneity",
    ],
    q6: [
      "cytokine-release syndrome",
      "ICANS or neurotoxicity",
      "on-target, off-tumour toxicity",
      "antigen escape",
      "poor persistence",
      "T-cell exhaustion",
      "immunosuppressive tumour microenvironment",
      "fratricide",
      "prolonged cytopenias",
      "manufacturing failure or variability",
      "vein-to-vein time",
      "cost and scalability",
    ],
  },
  gene_editing: {
    q2: [
      "genetic edit required for therapeutic benefit",
      "delivery to the relevant cell or tissue",
      "editing efficiency",
      "edit precision",
      "functional correction or target disruption",
      "persistence of the edited cell population",
      "cell turnover and need for stem-cell editing",
      "ex vivo versus in vivo feasibility",
      "relationship between editing fraction and clinical effect",
    ],
    q6: [
      "off-target editing",
      "large deletions or chromosomal rearrangements",
      "insertional or genotoxic risk",
      "immune responses to editor or delivery vehicle",
      "mosaic or incomplete editing",
      "irreversible adverse effects",
      "poor tissue delivery",
      "pre-existing immunity",
      "long-term monitoring requirements",
      "manufacturing complexity",
      "scalability and cost",
    ],
  },
  gene_replacement: {
    q2: [
      "disease suitability for gene restoration",
      "vector tropism",
      "delivery to the relevant cell population",
      "expression level",
      "expression durability",
      "protein processing and localization",
      "therapeutic threshold",
      "transgene size",
      "need for cell-type-specific expression",
    ],
    q6: [
      "pre-existing or treatment-induced immunity",
      "inability to redose",
      "excessive or ectopic expression",
      "liver or other vector-associated toxicity",
      "insertional risk where relevant",
      "limited vector capacity",
      "loss of expression in dividing cells",
      "manufacturing yield and batch variability",
      "high treatment cost",
      "long-term follow-up requirements",
    ],
  },
  molecular_glue: {
    q2: [
      "ability to induce or stabilize a productive protein interaction",
      "relevant E3 ligase availability",
      "target neomorphic interface formation",
      "degradation potency and selectivity",
      "degradation depth and durability",
      "functional dependence on target depletion",
      "structural evidence for induced proximity",
    ],
    q6: [
      "unintended neosubstrate degradation",
      "narrow structural optimization space",
      "unpredictable species differences",
      "resistance through interface mutations",
      "tissue variation in E3 expression",
      "off-target proteome effects",
      "limited mechanistic biomarkers",
    ],
  },
  monoclonal_antibody: {
    q2: [
      "extracellular or cell-surface target accessibility",
      "epitope suitability",
      "binding affinity and avidity",
      "target occupancy requirements",
      "receptor blockade, agonism or depletion mechanism",
      "Fc-effector function requirements",
      "target turnover and recycling",
      "tissue penetration",
      "soluble target competition",
      "relationship between receptor occupancy and response",
    ],
    q6: [
      "on-target, off-tissue effects",
      "excessive agonism or immune activation",
      "target-mediated drug disposition",
      "soluble antigen sink",
      "limited tissue penetration",
      "immunogenicity and anti-drug antibodies",
      "Fc-mediated toxicity",
      "infusion reactions",
      "high dose or frequent dosing requirements",
      "aggregation and formulation",
      "expression yield and CMC complexity",
    ],
  },
  mrna: {
    q2: [
      "tissue and cell delivery",
      "cellular uptake and endosomal escape",
      "translation efficiency",
      "protein processing and localization",
      "expression magnitude",
      "expression duration",
      "required dosing frequency",
      "relationship between transient expression and therapeutic effect",
    ],
    q6: [
      "innate immune activation",
      "reactogenicity",
      "lipid nanoparticle toxicity",
      "liver-biased biodistribution",
      "insufficient expression duration",
      "repeat-dosing limitations",
      "RNA instability",
      "cold-chain or formulation requirements",
      "variability in protein expression",
      "manufacturing scale and consistency",
    ],
  },
  protac: {
    q2: [
      "availability of a high-quality target-binding ligand",
      "E3 ligase expression in the relevant tissue",
      "target and E3 subcellular colocalization",
      "productive ternary-complex formation",
      "ternary-complex cooperativity",
      "ubiquitination competence",
      "degradation depth and kinetics",
      "duration of degradation and protein recovery",
      "relationship between degradation and functional response",
      "catalytic activity at clinically achievable exposure",
      "potential to degrade previously undruggable protein states",
    ],
    q6: [
      "high molecular weight and poor permeability",
      "weak oral exposure",
      "hook effect at high concentrations",
      "E3 ligase variability across patients or tissues",
      "off-target or neosubstrate degradation",
      "resistance through target or E3 pathway alteration",
      "incomplete degradation",
      "dependence on protein resynthesis rate",
      "transporter-mediated efflux",
      "poor solubility and formulation",
      "complex synthesis and manufacturing scalability",
    ],
  },
  radioligand: {
    q2: [
      "target accessibility",
      "tumour-to-normal-tissue uptake",
      "ligand affinity and selectivity",
      "internalization and intracellular retention",
      "radionuclide half-life",
      "particle range and energy",
      "chelator stability",
      "tumour dosimetry",
      "relationship between absorbed dose and tumour control",
      "feasibility of patient imaging and selection",
    ],
    q6: [
      "bone-marrow toxicity",
      "kidney toxicity",
      "salivary-gland or organ-specific uptake",
      "radioactive metabolite distribution",
      "chelator or complex instability",
      "insufficient tumour retention",
      "heterogeneous uptake",
      "cumulative radiation exposure",
      "isotope availability",
      "manufacturing and distribution logistics",
      "radiation-safety infrastructure",
    ],
  },
  sirna: {
    q2: [
      "target transcript abundance and turnover",
      "sequence accessibility",
      "tissue-specific delivery",
      "cellular uptake",
      "endosomal escape",
      "RISC loading",
      "knockdown depth",
      "knockdown durability",
      "allele or isoform selectivity",
      "relationship between transcript reduction and phenotype",
      "feasibility of repeat dosing",
    ],
    q6: [
      "delivery outside the liver or other accessible tissues",
      "insufficient endosomal escape",
      "incomplete or transient knockdown",
      "seed-sequence off-target effects",
      "innate immune activation",
      "complement or infusion reactions",
      "liver, kidney or platelet toxicity",
      "accumulation with repeat dosing",
      "chemical-stability liabilities",
      "high dosing burden",
      "manufacturing and formulation complexity",
    ],
  },
  small_molecule: {
    q2: [
      "presence and quality of a druggable binding pocket",
      "structural and conformational accessibility",
      "orthosteric, allosteric or covalent binding opportunity",
      "biochemical and cellular potency",
      "cell and tissue permeability",
      "intracellular target engagement",
      "selectivity across paralogues",
      "required degree and duration of inhibition",
      "PK and exposure needed for pathway suppression",
      "pharmacodynamic biomarker availability",
    ],
    q6: [
      "insufficient selectivity",
      "off-target pharmacology",
      "inadequate cell or tissue exposure",
      "poor oral bioavailability",
      "metabolic instability or reactive metabolites",
      "drug-drug interaction risk",
      "dose-limiting toxicity",
      "rapid adaptive signalling or pathway reactivation",
      "binding-site mutations and acquired resistance",
      "narrow therapeutic window",
      "formulation and solid-state liabilities",
    ],
  },
  tcr_t: {
    q2: [
      "intracellular antigen processing",
      "peptide presentation on the relevant HLA",
      "peptide-HLA density",
      "HLA prevalence in the target population",
      "TCR affinity and specificity",
      "tumour-cell recognition",
      "T-cell trafficking and persistence",
      "response under low-antigen conditions",
      "tumour immune-evasion mechanisms",
    ],
    q6: [
      "cross-reactivity with unrelated peptides",
      "on-target recognition of normal tissue",
      "HLA restriction",
      "HLA loss or downregulation",
      "antigen-processing defects",
      "cytokine-release syndrome",
      "T-cell exhaustion",
      "limited addressable patient population",
      "complex patient-screening requirements",
      "manufacturing time, variability and cost",
    ],
  },
  therapeutic_vaccine: {
    q2: [
      "antigen specificity",
      "antigen processing and presentation",
      "HLA coverage",
      "pre-existing immune repertoire",
      "ability to break tolerance",
      "T-cell priming and expansion",
      "memory formation",
      "adjuvant suitability",
      "tumour immune-evasion mechanisms",
      "combination requirements",
    ],
    q6: [
      "weak or inconsistent immunogenicity",
      "immune tolerance",
      "HLA restriction",
      "antigen loss",
      "tumour-mediated immune suppression",
      "autoimmune cross-reactivity",
      "slow onset of activity",
      "patient-specific manufacturing burden",
      "complex potency assays",
      "dependence on combination therapy",
    ],
  },
  unknown: {
    q2: [
      "target access",
      "target engagement",
      "intended direction of modulation",
      "depth of modulation",
      "duration of effect",
      "exposure-response relationship",
      "disease-relevant functional consequence",
      "pharmacodynamic measurability",
    ],
    q6: [
      "on-target safety",
      "off-target safety",
      "delivery and biodistribution",
      "PK and exposure limitations",
      "resistance and adaptation",
      "immunogenicity where relevant",
      "manufacturability",
      "scalability",
      "translational-model limitations",
    ],
  },
};

/**
 * The `unknown` entry doubles as the COMMON layer.
 *
 * The spec describes composition as "common + modality + subtype + action" but
 * never separately enumerates a common layer; the generic fallback is the only
 * modality-independent list it publishes, so that is the common layer. Stated
 * here rather than left implicit.
 */
const COMMON = LENS.unknown;

/**
 * Layered resolution: common + modality (+ subtype/action overlays later).
 *
 * Overlays may NARROW a resolved lens but never widen it, so a non-T-cell-
 * engaging bispecific can drop CRS-related items without inheriting anything
 * a different modality owns.
 */
export function resolveModalityLens(opts: {
  modality: CanonicalModality;
  modalitySubtype?: string;
  narrow?: (item: string) => boolean;
}): ResolvedLens {
  const entry = LENS[opts.modality] ?? COMMON;
  const compose = (common: readonly string[], specific: readonly string[]): string[] => {
    const merged = opts.modality === 'unknown' ? [...common] : [...common, ...specific];
    const deduped = [...new Set(merged)];
    return opts.narrow ? deduped.filter(opts.narrow) : deduped;
  };
  return {
    modalityLensKey: opts.modality,
    modalityLensVersion: MODALITY_LENS_VERSION,
    resolvedQ2Lens: compose(COMMON.q2, entry.q2),
    resolvedQ6Lens: compose(COMMON.q6, entry.q6),
  };
}

/** Axes that receive lens content. Nothing else may. */
export const LENS_AXES = ['moa_pathway', 'modality_developability'] as const;
