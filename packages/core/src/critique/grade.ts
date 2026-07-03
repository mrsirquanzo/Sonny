import type { EvidenceLevel, MethodologicalCritique, StudyDesign } from '@mrsirquanzo/sonny-shared';

const ORDER: EvidenceLevel[] = ['very_low', 'low', 'moderate', 'high'];

const BASE: Record<StudyDesign, EvidenceLevel> = {
  randomized_controlled: 'high',
  single_arm: 'moderate',
  observational: 'low',
  post_hoc: 'low',
  preclinical_nhp: 'very_low',
  in_vitro: 'very_low',
};

// Deterministic GRADE: start from the study design, downgrade for risk-of-bias
// limitations (high-risk flag, >=2 moderate flags, small sample), floored at very_low.
export function gradeEvidence(
  critique: Pick<MethodologicalCritique, 'studyDesign' | 'sampleSize' | 'redFlags'>,
): EvidenceLevel {
  let idx = ORDER.indexOf(BASE[critique.studyDesign]);
  let downgrades = 0;
  if (critique.redFlags.some((f) => f.biasRisk === 'high')) downgrades += 1;
  if (critique.redFlags.filter((f) => f.biasRisk === 'moderate').length >= 2) downgrades += 1;
  if (typeof critique.sampleSize === 'number' && critique.sampleSize < 50) downgrades += 1;
  idx = Math.max(0, idx - downgrades);
  return ORDER[idx];
}
