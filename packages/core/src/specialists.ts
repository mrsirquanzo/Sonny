export interface Specialist { id: string; title: string; objective: string; toolNames: string[]; promptHint: string }

export const SPECIALISTS: Specialist[] = [
  { id: 'target_biology', title: 'Target Biology',
    objective: 'Characterize the target: function, tractability, expression.',
    toolNames: ['open_targets_target', 'pubmed_search'],
    promptHint: 'Describe the target\'s biology, druggability/tractability, and expression. Use the Open Targets target record and literature.' },
  { id: 'disease_indications', title: 'Disease & Indications',
    objective: 'Identify the diseases/indications most associated with the target.',
    toolNames: ['open_targets_target', 'pubmed_search'],
    promptHint: 'Summarize the top disease associations (cite the disease records and their scores) and the most credible indication(s).' },
  { id: 'clinical_translational', title: 'Clinical & Translational',
    objective: 'Summarize clinical trials and translational evidence.',
    toolNames: ['clinical_trials_search', 'pubmed_search'],
    promptHint: 'Summarize relevant clinical trials (phase/status) and translational evidence. Cite NCT ids and PMIDs.' },
  { id: 'safety_tox', title: 'Safety & Tox',
    objective: 'Surface known safety liabilities and toxicity signals.',
    toolNames: ['open_targets_target', 'pubmed_search'],
    promptHint: 'Report known safety liabilities (from the Open Targets target record) and toxicity signals from the literature. Be conservative.' },
  { id: 'competitive_landscape', title: 'Competitive Landscape',
    objective: 'Map known drugs / modalities against the target.',
    toolNames: ['open_targets_target', 'pubmed_search'],
    promptHint: 'Summarize known drugs and modalities targeting this gene (cite the drug records, mechanism, phase) and differentiation.' },
];
