import type { ThreadBrief } from './researcher.js';

/**
 * The fixed six-axis spine, modality-NEUTRAL.
 *
 * These previously encoded ADC assumptions directly ("is the target
 * antibody-bindable", "does the biology support an ADC mechanism"), so every
 * non-antibody run inherited antibody framing before any lens was consulted.
 * Modality conditioning now happens ONLY through the lens injected into Q2 and
 * Q6 by composeRoster; the rubric itself asks modality-independent questions.
 *
 * Wording follows the specialist definitions in the spec (Q1-Q6).
 */
export const RESEARCH_ROSTER: ThreadBrief[] = [
  {
    id: 'target_biology', title: 'Target Validation & Therapeutic Relevance',
    objective: 'Determine whether the target is biologically linked to the disease in a way that supports its intended therapeutic role, and whether exploiting that role can produce a disease-relevant effect.',
    promptHint: 'Answer one question: is the target valid for its intended therapeutic role? Weigh human genetic evidence, disease-associated alterations, functional dependency, pathway position, causal versus correlative association, redundancy and compensatory biology. Where the role is functional, assess whether perturbation produces the intended phenotype; where it is non-functional (delivery address, recognition antigen), assess the accessibility or specificity that role requires. Use and cite structured evidence when present. BOUNDARY: Do not assess whether a specific modality can execute the role, do not rank indications by clinical attractiveness, and do not assess normal-tissue toxicity, competition, or developability - other specialists own those.',
  },
  {
    id: 'moa_pathway', title: 'Modality Feasibility & Mechanistic Execution',
    objective: 'Determine whether the proposed modality can reach the target, produce the intended molecular intervention, sustain it at achievable exposure, and generate a disease-relevant effect.',
    promptHint: 'Answer one question: can this modality execute the intended mechanism against this target? For every major step in the mechanistic chain state what must be true, summarize supporting and contradictory evidence, distinguish direct evidence from inference, and identify the weakest link. Use and cite structured evidence when present. BOUNDARY: Do not re-argue target validity, rank indications, assess competition, or perform the definitive safety assessment - Q6 owns risk, and other specialists own the rest.',
  },
  {
    id: 'disease_indications', title: 'Indication & Biomarker Prioritization',
    objective: 'Determine which indication and biomarker-defined population offer the strongest clinical-development opportunity for a therapy directed at this target.',
    promptHint: 'Answer one question: which indication and biomarker-defined population is the strongest development opportunity? Weigh alteration or expression prevalence by indication, biomarker-defined patient frequency, dependency within subgroups, disease stage and line of therapy, unmet need, standard of care, biomarker detectability, patient-selection feasibility, and trial practicality. Cite structured expression and association evidence when present. BOUNDARY: Do not rebuild the general causal case for the target, do not assess modality-specific mechanistic requirements, and do not cover competition, IP, or product engineering.',
  },
  {
    id: 'clinical_landscape', title: 'Translational & Clinical Evidence',
    objective: 'Determine what human, translational, and clinical evidence supports or challenges translation of the proposed therapeutic strategy.',
    promptHint: 'Answer one question: has this strategy, or a relevant analogue, translated in humans? Interpret efficacy, safety, biomarker, pharmacodynamic, and failure evidence, separating same-modality precedent from cross-modality read-across. Cite clinical-candidate and trial evidence when present. Absence of precedent is itself a finding - state it plainly rather than implying it was not searched. BOUNDARY: Do not produce an exhaustive competitor map (Q5 owns that), and do not reassess target validity, mechanism, or indication choice.',
  },
  {
    id: 'competitive_ip', title: 'Competitive Positioning & IP',
    objective: 'Determine who else is pursuing this target or mechanism, how a new programme could differentiate, and what public evidence suggests IP or freedom-to-operate constraints.',
    promptHint: 'Answer one question: who else is pursuing this, and what differentiation or freedom-to-operate signal remains? Compare programmes, sponsors, binding or design approaches, patents and exclusivity signals, and credible differentiation for the proposed strategy. Cite clinical-candidate and patent evidence when present. Public patent analysis identifies possible constraints and areas needing counsel review; it is not a freedom-to-operate opinion. BOUNDARY: Do not reassess target validity, mechanism, or indication validity, and reference clinical outcomes only as attributes of competitor programmes.',
  },
  {
    id: 'modality_developability', title: 'Modality-Specific Risk & Development Feasibility',
    objective: 'Determine what biological, pharmacologic, safety, delivery, resistance, manufacturing, or scalability liabilities could prevent a clinically viable product.',
    promptHint: 'Answer one question: what could prevent a viable product? For each material liability describe the failure mechanism, estimate likelihood and impact separately, cite target-, modality-, or class-level evidence, and identify an experiment, biomarker, or development strategy that would reduce uncertainty. Cite structured safety and expression evidence when present. BOUNDARY: Assess development risk only - do not cover target validity, indication choice, clinical precedent, or competition and IP.',
  },
];
