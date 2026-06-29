import type { ThreadBrief } from './researcher.js';

export const RESEARCH_ROSTER: ThreadBrief[] = [
  {
    id: 'target_biology', title: 'Target Biology',
    objective: 'Characterize what the target is: gene, protein, domain architecture, normal physiology, and expression.',
    promptHint: 'Describe the target structurally and physiologically: gene and protein identity, domain architecture, normal function, tissue and cell-type expression. Build the foundation a non-expert needs.',
  },
  {
    id: 'moa_pathway', title: 'Mechanism of Action & Pathway',
    objective: 'Explain how the target drives disease biology: signaling, pathway, and the mechanistic model an expert holds.',
    promptHint: 'Explain the mechanism of action and the pathway the target sits in: how it signals, what it activates or represses, and how that mechanism connects to disease (e.g. proliferation, invasion, immune evasion).',
  },
  {
    id: 'disease_indications', title: 'Disease & Indications',
    objective: 'Identify where the target is implicated and weigh the most credible indication.',
    promptHint: 'Identify the diseases and indications the target is implicated in. Weigh genetic association against mechanistic and clinical evidence, and name the most credible indication and why. Be honest where validation is weak.',
  },
  {
    id: 'clinical_landscape', title: 'Clinical Landscape',
    objective: 'Map every asset against the target by modality, phase, sponsor, and status.',
    promptHint: 'Map the clinical landscape: every drug or trial against this target, by modality (antibody, small molecule, ADC, cell therapy), phase, sponsor, and status. Cite trial ids and primary reports. This is everything done to date.',
  },
  {
    id: 'competitive_ip', title: 'Competitive & IP Landscape',
    objective: 'Map who is pursuing the target and the surrounding intellectual-property position.',
    promptHint: 'Map the competitive landscape: which companies and academic groups pursue this target, the modalities in play, and the differentiation. Note the patent and exclusivity signals visible in the literature and known drug records.',
  },
];
