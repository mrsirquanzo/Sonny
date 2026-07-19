import { describe, it, expect } from 'vitest';
import { RESEARCH_ROSTER } from './researchRoster.js';

describe('RESEARCH_ROSTER', () => {
  it('defines six distinct ADC evaluation briefs with unique ids and prompts', () => {
    expect(RESEARCH_ROSTER.map((b) => b.id)).toEqual([
      'target_biology', 'moa_pathway', 'disease_indications', 'clinical_landscape', 'competitive_ip', 'modality_developability',
    ]);
    for (const b of RESEARCH_ROSTER) {
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.objective.length).toBeGreaterThan(0);
      expect(b.promptHint.length).toBeGreaterThan(0);
    }
    expect(new Set(RESEARCH_ROSTER.map((b) => b.id)).size).toBe(6);
    expect(new Set(RESEARCH_ROSTER.map((b) => b.objective)).size).toBe(6);
  });
});
