import type { ThreadBrief } from './researcher.js';

export const RESEARCH_ROSTER: ThreadBrief[] = [
  {
    id: 'target_biology', title: 'Target Biology',
    objective: 'Determine whether the target is antibody-bindable on tumour cells by establishing cell-surface localisation, accessible architecture, and expression abundance and prevalence in the scoped indication.',
    promptHint: 'Answer one question: is the target actually on the tumour cell surface, and how abundant and prevalent is it in the indication? Establish gene and protein identity, antibody-relevant domain architecture, cell-surface localisation, and tumour expression level and prevalence. Use and cite structured evidence when present. BOUNDARY: Do not cover internalisation, normal-tissue selectivity, clinical programmes, competition, or developability - the other specialists own those questions.',
  },
  {
    id: 'moa_pathway', title: 'Mechanism of Action & Pathway',
    objective: 'Determine whether target internalisation, trafficking, and payload-response biology support an ADC mechanism.',
    promptHint: 'Answer one question: does the biology support an ADC mechanism? Assess receptor internalisation or endocytosis after antibody binding, turnover and recycling, intracellular trafficking, and sensitivity or resistance mechanisms likely to shape payload response. Use and cite structured evidence when present. BOUNDARY: Do not re-describe tumour expression, indication prevalence, normal-tissue selectivity, clinical programmes, competition, or physical developability - those belong to other specialists.',
  },
  {
    id: 'disease_indications', title: 'Disease & Indications',
    objective: 'Determine whether the scoped indication is the strongest opportunity and whether tumour-versus-normal expression offers an ADC therapeutic window.',
    promptHint: 'Answer one question: is the scoped indication the most credible opportunity, and is expression tumour-selective versus normal tissue? Weigh prevalence and subtype relevance in the indication, then judge the ADC therapeutic window from normal-tissue RNA and protein expression. Cite Open Targets baseline tissue expression cards when present and state selectivity concerns plainly. BOUNDARY: Do not cover surface architecture, internalisation, clinical assets, competition, or drug-format engineering - other specialists own those questions.',
  },
  {
    id: 'clinical_landscape', title: 'Clinical Landscape',
    objective: 'Determine whether clinical or translational ADC or antibody precedent validates the target, including assets, sponsors, trials, stages, and outcomes.',
    promptHint: 'Answer one question: is there clinical or translational precedent for targeting this, especially with an ADC or antibody? Map relevant assets, sponsors, trial ids, phase or maximum clinical stage, status, and reported outcomes. Cite Open Targets clinical-candidate cards and primary trial records when present. If precedent is absent or thin, say so plainly - absence is a finding. BOUNDARY: Do not re-argue expression, mechanism, indication choice, competitive differentiation, patents, or physical developability - other specialists own those questions.',
  },
  {
    id: 'competitive_ip', title: 'Competitive & IP Landscape',
    objective: 'Determine who is pursuing the target with ADCs or antibodies and what differentiation, epitope, patent, and freedom-to-operate signals remain.',
    promptHint: 'Answer one question: who else is pursuing this target as an ADC or antibody, and what differentiation or freedom-to-operate signal remains? Compare competitor programmes and modalities, sponsors, epitopes or binding approaches, patents and exclusivity signals, and credible differentiation for the scoped modality. Use and cite structured clinical-candidate evidence when present. BOUNDARY: Do not reassess target expression, internalisation, indication validity, clinical outcomes except as programme facts, or safety and developability - other specialists own those questions.',
  },
  {
    id: 'modality_developability', title: 'Modality & Developability',
    objective: 'Determine whether safety, tractability, immunogenicity, format, linker, or payload liabilities make the target physically unsuitable for an ADC.',
    promptHint: 'Answer one question: what safety or developability liability could invalidate an ADC? Assess on-target/off-tumour toxicity implied by normal-tissue expression, known safety liabilities, antibody and ADC tractability, immunogenicity and ADA risk, and payload, linker, Fc, format, dosing, and manufacturability fit. Cite Open Targets safety-liability, baseline-expression, and tractability-by-modality cards when present. BOUNDARY: Assess physical drug-ability only - do not cover tumour expression and prevalence, internalisation biology, indication choice, clinical precedent, or competition and IP, which other specialists own.',
  },
];
